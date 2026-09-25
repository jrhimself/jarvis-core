/**
 * The memory JARVIS can reach into during a conversation.
 *
 * He carries a short core in his head and looks up the rest. That is the whole
 * point of the design: a household accumulates hundreds of small facts, and
 * sending all of them every turn would cost more than it is worth.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { formatLocal, type DisplayPayload, type PackDisplay } from "@jarvis/shared";

import { embed, fromBlob, similarity, toBlob } from "./embedding.js";
import type { CorpusRun, Fact, FactKind, MemoryStore, RevisionReason, Session } from "./store.js";

/** Below this a vector match is noise rather than a memory. */
const SIMILARITY_FLOOR = 0.25;

/**
 * Higher bar for facts nobody asked for.
 *
 * Measured against the real fact table: questions that genuinely touch a fact
 * score 0,48 to 0,59 against it, while a question about nothing in particular
 * ("zeg alleen: test") still pulls its best match up to 0,46. The separation
 * this model offers is that narrow, so priming is framed as a hint the
 * assistant may ignore rather than as an answer, and `recall` stays for the
 * questions this misses.
 */
const PRIMING_FLOOR = 0.45;
/** At most this many primed facts; more than a few is a prompt, not a hint. */
const PRIMING_LIMIT = 3;

/**
 * Recall by words and by meaning, merged.
 *
 * Full-text catches the exact phrasing, the vector sweep catches the rest — "wat
 * was er mis met de wasdroger" against a fact that says "droger". Word matches
 * rank first because when they hit they are usually the better answer.
 */
export async function recallFacts(store: MemoryStore, query: string, limit: number): Promise<Fact[]> {
  const found = store.search(query, limit);
  const seen = new Set(found.map((fact) => fact.id));

  if (found.length < limit) {
    const vector = await embed(query);
    if (vector !== null) {
      const scored = store
        .vectors()
        .map((row) => ({ id: row.id, score: similarity(vector, fromBlob(row.vec)) }))
        .filter((row) => row.score >= SIMILARITY_FLOOR && !seen.has(row.id))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit - found.length);

      const byId = new Map(store.byIds(scored.map((row) => row.id)).map((fact) => [fact.id, fact]));
      for (const row of scored) {
        const fact = byId.get(row.id);
        if (fact !== undefined) found.push(fact);
      }
    }
  }

  // Both paths count. Only the word path used to, which made the hit counter
  // describe the half of recall that happens to match on spelling, and left the
  // facts found by meaning looking like dead weight to anything reading it.
  store.markUsed(found.map((fact) => fact.id));
  return found;
}

/**
 * Facts worth putting in front of the assistant before it asks for them.
 *
 * Recall through the tool costs a full round trip — a second or two of silence
 * on a question whose answer was already in the database. Embedding the question
 * locally takes about seven milliseconds, so the obvious hits can ride along
 * with the question itself, and the tool is left for what this does not catch.
 */
export async function primeFacts(store: MemoryStore, question: string): Promise<Fact[]> {
  const vector = await embed(question);
  if (vector === null) return [];

  const scored = store
    .vectors()
    .map((row) => ({ id: row.id, score: similarity(vector, fromBlob(row.vec)) }))
    .filter((row) => row.score >= PRIMING_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, PRIMING_LIMIT);
  if (scored.length === 0) return [];

  const byId = new Map(store.byIds(scored.map((row) => row.id)).map((fact) => [fact.id, fact]));
  const facts = scored.map((row) => byId.get(row.id)).filter((fact): fact is Fact => fact !== undefined);
  // Primed, not used: whether the assistant does anything with a hint is never
  // known, so this must not count towards the hit signal consolidation reads.
  store.markPrimed(facts.map((fact) => fact.id));
  return facts;
}

/**
 * Facts closest in meaning to a piece of text, for a pass that has to know what
 * is already written down.
 *
 * Distillation used to be shown the sixty most recently touched facts, which at
 * a hundred-odd facts is half the table and none of it chosen for relevance: it
 * could propose something already known and never see the entry it duplicated.
 * The floor is low on purpose — being shown a near-miss costs a few tokens,
 * missing the duplicate costs a duplicate.
 */
export async function relatedFacts(
  store: MemoryStore,
  text: string,
  limit = 25,
  floor = 0.2,
): Promise<Fact[]> {
  const vector = await embed(text);
  if (vector === null) return store.all(limit);

  const scored = store
    .vectors()
    .map((row) => ({ id: row.id, score: similarity(vector, fromBlob(row.vec)) }))
    .filter((row) => row.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const byId = new Map(store.byIds(scored.map((row) => row.id)).map((fact) => [fact.id, fact]));
  return scored.map((row) => byId.get(row.id)).filter((fact): fact is Fact => fact !== undefined);
}

/** The hint block that rides along with a question, or "" when there is nothing. */
export function primingBlock(facts: Fact[]): string {
  if (facts.length === 0) return "";
  return [
    "[Uit je geheugen, mogelijk relevant. Negeer wat niet past, en zoek zelf verder met recall",
    "als je iets anders nodig hebt:",
    ...facts.map((f) => `- ${render(f)}`),
    "]",
  ].join("\n");
}

/**
 * How close two facts have to read before they are treated as the same one.
 *
 * Measured over the whole fact table: the closest pair of genuinely different
 * facts sits at 0,70 (a household as a whole against one person in it), so 0,80 leaves room without
 * ever merging two things the owner would want kept apart. It costs a wrong subject
 * occasionally; the alternative is "droger" living next to "wasdroger" until
 * Sunday's consolidation notices.
 */
const DUPLICATE_FLOOR = 0.8;

/**
 * Bodies this close are the same statement reworded — an update, so the new
 * text replaces the old. Below it the two say different things about the same
 * subject, and replacing would erase the half nobody repeated.
 */
const RESTATEMENT_FLOOR = 0.8;

/** Longest a fact body may grow; matches the `remember` tool's schema. */
const BODY_MAX = 400;

/**
 * What a folded fact should say afterwards.
 *
 * Folding used to replace the body outright, which lost information: "de
 * droger piept bij het starten" arriving next to "de droger stopt soms
 * halverwege" erased the stopping. A restatement or an update —
 * bodies close in meaning — still replaces; genuinely new information is
 * appended while it fits, and the weekly consolidation is the pass that
 * rewrites a body grown baggy. The old text lands in fact_revisions either
 * way, but revisions are never recalled — only the body is, so the body is
 * what has to stay complete.
 *
 * `bodySimilarity` is null when embeddings are unavailable; that falls back to
 * replacing, which is the pre-merge behaviour.
 */
export function foldedBody(
  existing: string,
  incoming: string,
  bodySimilarity: number | null,
): string {
  const had = existing.trim();
  const got = incoming.trim();
  if (had.toLowerCase().includes(got.toLowerCase())) return had;
  if (bodySimilarity === null || bodySimilarity >= RESTATEMENT_FLOOR) return got;
  const joined = `${/[.!?]$/.test(had) ? had : `${had}.`} ${got}`;
  return joined.length <= BODY_MAX ? joined : got;
}

/**
 * Writes a fact, folding it into an existing one that already says it.
 *
 * `remember` in the store keys on subject and kind exactly, which is right for
 * an update and wrong for a household: the same dryer gets called "droger" one
 * week and "wasdroger" the next, and the table quietly grows two of everything.
 * When nothing matches by name, the closest fact by meaning gets the update —
 * merged by `foldedBody` rather than blindly replaced.
 */
export async function writeFact(
  store: MemoryStore,
  input: {
    kind: FactKind;
    subject: string;
    body: string;
    core?: boolean;
    source?: "owner" | "jarvis";
    reason?: RevisionReason;
  },
): Promise<Fact> {
  if (store.bySubject(input.subject, input.kind) === null) {
    const vector = await embed(`${input.subject}: ${input.body}`);
    if (vector !== null) {
      const best = store
        .vectors()
        .map((row) => ({ id: row.id, score: similarity(vector, fromBlob(row.vec)) }))
        .filter((row) => row.score >= DUPLICATE_FLOOR)
        .sort((a, b) => b.score - a.score)[0];

      const existing = best === undefined ? null : store.byId(best.id);
      if (existing !== null && existing.kind === input.kind) {
        const [was, is] = await Promise.all([embed(existing.body), embed(input.body)]);
        const bodySim = was !== null && is !== null ? similarity(was, is) : null;
        const body = foldedBody(existing.body, input.body, bodySim);

        if (body === existing.body.trim()) {
          // The fact already says this; nothing to write, nothing to re-index.
          console.log(
            `memory: "${input.subject}" already said by #${existing.id} (${existing.subject})`,
          );
          return existing;
        }

        const updated = store.setBody(existing.id, body, "folded");
        if (updated !== null) {
          console.log(
            `memory: folded "${input.subject}" into #${existing.id} (${existing.subject})`,
          );
          index(store, updated);
          return updated;
        }
      }
    }
  }

  const fact = store.remember(input);
  index(store, fact);
  return fact;
}

/** Computes and stores the embedding for a fact. Safe to call and forget. */
export function index(store: MemoryStore, fact: Fact): void {
  void embed(`${fact.subject}: ${fact.body}`).then((vector) => {
    if (vector !== null) store.setVector(fact.id, toBlob(vector));
  });
}

/** Gives facts written before embeddings existed a vector of their own. */
export async function backfill(store: MemoryStore): Promise<number> {
  const missing = store.withoutVectors();
  for (const fact of missing) {
    const vector = await embed(`${fact.subject}: ${fact.body}`);
    if (vector !== null) store.setVector(fact.id, toBlob(vector));
  }
  if (missing.length > 0) console.log(`memory: indexed ${missing.length} facts`);
  return missing.length;
}

const KINDS = ["voorkeur", "feit", "persoon", "gewoonte", "conclusie", "lopend"] as const;

export const MEMORY_SERVER_NAME = "memory";
export const MEMORY_TOOLS = [`mcp__${MEMORY_SERVER_NAME}__*`];

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function render(fact: Fact): string {
  return `#${fact.id} [${fact.kind}] ${fact.subject}: ${fact.body}`;
}

/**
 * How many characters of core facts still read as a system prompt rather than a
 * filing cabinet. Passing it drops nothing -- it warns, once, because the fix is
 * for someone to decide what stops being core, and a program cannot make that
 * call by looking at timestamps.
 */
const CORE_BUDGET = 6000;

/** Past this many, `remember` starts saying so instead of quietly adding another. */
const CORE_SOFT_MAX = 30;

let budgetWarned = false;

/** The block of core facts that goes into the system prompt. */
export function coreBlock(store: MemoryStore): string {
  const facts = store.core();
  if (facts.length === 0) return "";

  const lines = facts.map((f) => `- ${f.subject}: ${f.body}`);
  const size = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (size > CORE_BUDGET && !budgetWarned) {
    budgetWarned = true;
    console.warn(
      `memory: ${facts.length} core facts take ${size} characters, past the ${CORE_BUDGET} ` +
        "a prompt should spend on them. Nothing was dropped; demote what no longer belongs.",
    );
  }

  return [
    "Dit weet je al over dit huishouden. Gebruik het zonder ernaar te vragen:",
    ...lines,
  ].join("\n");
}

/** A conversation, dated the way someone would say it out loud. */
function renderSession(session: Session): string {
  const when = formatLocal(new Date(session.endedAt), {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${when} (${session.turns} beurten): ${session.summary}`;
}

/** A nightly pass, dated the way someone would say it out loud. */
export function renderRun(run: CorpusRun): string {
  const when = formatLocal(new Date(run.at), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const failed = run.failed > 0 ? `, ${run.failed} mislukt` : "";
  if (run.written === 0 && run.retired === 0 && run.gone === 0) {
    return `${when} — ${run.scanned} notities, niets veranderd${failed} (${run.factsAfter} feiten)`;
  }
  const parts = [`${run.read} gelezen`, `${run.written} feiten bij`];
  if (run.retired > 0) parts.push(`${run.retired} vervallen`);
  if (run.skipped > 0) parts.push(`${run.skipped} overgeslagen`);
  if (run.gone > 0) parts.push(`${run.gone} notities weg`);
  return (
    `${when} — ${run.scanned} notities, ${parts.join(", ")}${failed}; ` +
    `${run.factsBefore} → ${run.factsAfter} feiten`
  );
}

/** A night that neither added nor dropped anything. */
function quietRun(run: CorpusRun): boolean {
  return run.written === 0 && run.retired === 0 && run.gone === 0;
}

/**
 * The window over the nightly passes: one row per night, what it added and
 * what it removed.
 *
 * Built here rather than left to the model. Asked to put the history on
 * screen, it wrote its own shorthand per row -- "+28, -16 (824)" -- which
 * nobody reads as facts added and removed. The title is what the desk panel
 * is called, and it has to keep mapping to the `notes` topic (see
 * WINDOW_TOPICS), or the window stops opening on its section marker.
 */
export function factsPanel(runs: readonly CorpusRun[]): DisplayPayload | null {
  const newest = runs[0];
  if (newest === undefined || quietRun(newest)) return null;
  return {
    type: "panel",
    title: "Facts",
    figure: { value: newest.written, label: `${newest.retired} removed` },
    rows: runs.map((run) => ({
      label: formatLocal(new Date(run.at), { weekday: "short", day: "numeric", month: "short" }),
      value: quietRun(run)
        ? "no change"
        : `${run.written > 0 ? "+" : ""}${run.written} added · ` +
          `${run.retired > 0 ? "−" : ""}${run.retired} removed`,
      hint: `${run.factsAfter} facts`,
    })),
  };
}

/** A pass is nightly, so this much silence means one did not happen. */
const RUN_OVERDUE_MS = 30 * 3_600_000;

/**
 * `display`, when there is a screen, is where `note_ingest` puts its own
 * window; without one (the prompt-size tool) it only answers.
 */
export function createMemoryServer(store: MemoryStore, display?: PackDisplay) {
  const recall = tool(
    "recall",
    "Look something up in your memory of this household — preferences, people, " +
      "habits, running concerns, earlier conclusions. Use it whenever a question " +
      "touches something you were told before rather than something Home Assistant " +
      "measures. Search with the words the user used.",
    {
      query: z.string().min(2).describe("What to look for, in Dutch"),
      limit: z.number().int().min(1).max(15).default(6).describe("How many results"),
    },
    async (args) => {
      const hits = await recallFacts(store, args.query, args.limit);
      if (hits.length === 0) return ok(`Nothing in memory about "${args.query}".`);
      return ok(hits.map(render).join("\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const remember = tool(
    "remember",
    "Store something worth knowing next time. Use it when the user tells you a " +
      "preference, a fact about the household, or something that is going on — and " +
      "when you conclude something durable yourself. Do not store what Home Assistant " +
      "already measures, and do not store the conversation itself.",
    {
      kind: z.enum(KINDS).describe("What sort of thing this is"),
      subject: z
        .string()
        .min(2)
        .max(60)
        .describe("Short label, e.g. 'droger' or 'donderdag zwemles'"),
      body: z.string().min(3).max(400).describe("The fact itself, one or two sentences, in Dutch"),
      core: z
        .boolean()
        .default(false)
        .describe(
          "True only for things that matter in almost every conversation — people in " +
            "the house, standing preferences. Everything else is found by searching.",
        ),
      mine: z
        .boolean()
        .default(false)
        .describe("True when this is your own conclusion rather than something you were told"),
    },
    async (args) => {
      const fact = await writeFact(store, {
        kind: args.kind as FactKind,
        subject: args.subject,
        body: args.body,
        core: args.core,
        source: args.mine ? "jarvis" : "owner",
      });
      if (!args.core) return ok(`Stored as #${fact.id}.`);

      // A full core is not an error and not something to solve silently: the
      // assistant is the one in the conversation, so it is the one that can ask.
      const count = store.core().length;
      if (count <= CORE_SOFT_MAX) return ok(`Stored as #${fact.id}.`);
      return ok(
        `Stored as #${fact.id}. There are now ${count} core facts, which is more than a ` +
          "prompt should carry. Say so, and ask which one can stop being core.",
      );
    },
    { annotations: { readOnlyHint: false, idempotentHint: true } },
  );

  const forget = tool(
    "forget",
    "Remove something from memory, by its number. Use it when the user says you have " +
      "it wrong or that it no longer applies. Look it up first if you do not have the " +
      "number.",
    {
      id: z.number().int().positive().describe("The number shown next to the fact"),
    },
    async (args) => {
      const fact = store.byId(args.id);
      if (fact === null) return ok(`No memory with number ${args.id}.`);
      store.forget(args.id);
      // Asking for something to be forgotten is a correction, not tidying.
      store.recordCorrection({ action: "deleted", fact });
      return ok(`Forgotten: ${fact.subject}.`);
    },
    { annotations: { readOnlyHint: false } },
  );

  const conversations = tool(
    "conversations",
    "Look up what earlier conversations were about — use it for questions like " +
      "'waar hadden we het gisteren over', 'wat vroeg ik je vanochtend', or when you " +
      "need to know whether something already came up. Leave the query out to get the " +
      "most recent conversations. This is the log of what was discussed; `recall` is " +
      "for what is actually true about the household.",
    {
      query: z
        .string()
        .default("")
        .describe("What the conversation was about, in Dutch. Empty for the most recent ones."),
      limit: z.number().int().min(1).max(10).default(5).describe("How many conversations"),
    },
    async (args) => {
      const trimmed = args.query.trim();
      const found =
        trimmed === "" ? store.recentSessions(args.limit) : store.searchSessions(trimmed, args.limit);
      if (found.length === 0) {
        return ok(
          trimmed === ""
            ? "No earlier conversations recorded yet."
            : `No earlier conversation about "${trimmed}".`,
        );
      }
      return ok(found.map(renderSession).join("\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const ingest = tool(
    "note_ingest",
    "What the nightly pass over the owner's own notes did — the notes they leave behind " +
      "while working with a coding agent, which become facts in your memory. Use it as " +
      "the last item of the morning briefing, and whenever he asks what you picked up " +
      "from his notes or whether the ingest still runs. When a night changed something, " +
      "say it in one sentence; the tool puts the history on screen by itself, so never " +
      "call show_panel for it. A night that changed nothing is worth no sentence.",
    {
      limit: z.number().int().min(1).max(14).default(7).describe("How many nights"),
    },
    async (args) => {
      const runs = store.corpusRuns(args.limit);
      if (runs.length === 0) {
        return ok("Nog geen enkele nachtelijke pass vastgelegd.");
      }

      const newest = runs[0]!;
      const silent = Date.now() - Date.parse(newest.at);
      const header =
        Number.isNaN(silent) || silent <= RUN_OVERDUE_MS
          ? null
          : `Let op: de laatste pass is ${Math.floor(silent / 3_600_000)} uur geleden; ` +
            "hij hoort elke nacht te draaien.";

      const quiet = quietRun(newest);
      const panel = factsPanel(runs);
      if (panel !== null && display !== undefined) {
        display(panel, undefined, "notes|notities|facts|feiten", "facts");
      }
      const note = quiet
        ? "Laatste nacht veranderde er niets — in de briefing niets zeggen en niets tonen."
        : "Geen show_panel hiervoor, en zeg niets over het scherm.";

      // Which notes the newest pass read, so the briefing can say what it was
      // about rather than only how many facts it was. Measured from the run
      // before it; without one, the pass itself is the whole history.
      const previous = runs[1];
      const read = quiet
        ? []
        : store
            .corpusFilesSince(previous?.at ?? "")
            .filter((file) => file.ingestedAt <= newest.at)
            .map((file) => file.path.replace(/\.md$/, ""));
      const about = read.length === 0 ? null : `Gelezen die nacht: ${read.join(", ")}.`;

      return ok(
        [header, note, about, ...runs.map(renderRun)].filter((line) => line !== null).join("\n"),
      );
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: MEMORY_SERVER_NAME,
    version: "1.0.0",
    tools: [recall, remember, forget, conversations, ingest],
  });
}
