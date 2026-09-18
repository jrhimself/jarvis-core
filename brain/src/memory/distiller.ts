/**
 * Distils conversations into facts worth keeping, and into what they were about.
 *
 * Asking JARVIS to decide mid-answer what deserves remembering makes him slower
 * and more long-winded, so it happens afterwards on a cheaper model. It reads the
 * exchanges nobody has looked at yet and proposes facts; anything it returns is
 * written straight in, and the panel in the HUD is where wrong entries get
 * corrected.
 *
 * It runs per conversation, when that conversation ends. The earlier version ran
 * every three exchanges, which cut straight through a conversation: the pass that
 * had to judge what mattered saw the first half of a question and none of the
 * answer it led to. A conversation is the smallest unit that makes sense of
 * itself, and it is bounded anyway by the turn cap.
 *
 * The same call also writes down what the conversation was about. That costs
 * nothing extra — the transcript is already in the prompt — and it is what makes
 * "waar hadden we het gisteren over" answerable at all.
 *
 * The prompt is deliberately strict about what not to keep. A household produces
 * an enormous amount of chatter that is true for ten minutes.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

import { relatedFacts, writeFact } from "./tools.js";
import { recordUsage } from "./usage.js";
import { loadConfig, ownerName } from "../config.js";
import type { Correction, Fact, FactKind, MemoryStore } from "./store.js";

const KINDS: FactKind[] = ["voorkeur", "feit", "persoon", "gewoonte", "conclusie", "lopend"];

const instructions = (owner: string) => `Je leest één gesprek tussen ${owner} en de spraakassistent. Je doet twee dingen:
je vat het gesprek kort samen, en je haalt eruit wat later nog van pas komt.

De samenvatting is één of twee zinnen in het Nederlands, in de verleden tijd, over waar het gesprek
over ging — genoeg om het gesprek later terug te vinden ("${owner} vroeg naar de wasdroger en of de
zolderdeur al gemaakt was"). Geen opsomming van beleefdheden.

Bewaar als feit alleen dingen die duurzaam zijn en nergens anders staan:
- voorkeuren ("ik wil 's avonds geen fel licht")
- mensen en hun gewoontes ("de jongste zit donderdag bij oma")
- lopende zaken ("de droger stopt soms halverwege, sinds vorige week")
- feiten over het huis die geen sensor meet ("de zolderdeur klemt")
- conclusies die de assistent zelf trok en die stand houden

Bewaar NOOIT als feit:
- meetwaardes, standen of tijdstippen die Home Assistant zelf al weet
- iets dat over een uur niet meer waar is
- het gesprek zelf, of dat er iets gevraagd is
- beleefdheden, testzinnen, of dingen die ${owner} duidelijk als voorbeeld noemde

Antwoord met JSON en niets anders:
{"samenvatting": "<één of twee zinnen>", "feiten": [{"kind": "<een van: ${KINDS.join(", ")}>",
"subject": "<kort label, max 60 tekens>", "body": "<één of twee zinnen, Nederlands>",
"core": <true alleen voor iets dat in vrijwel elk gesprek relevant is, zoals wie er in huis wonen>}]}

Is er niets bewaarwaardigs, dan is "feiten" een lege array. De samenvatting vul je altijd.`;

interface Proposal {
  kind: string;
  subject: string;
  body: string;
  core?: boolean;
}

interface Distillation {
  summary: string;
  facts: Proposal[];
}

function isProposal(item: unknown): item is Proposal {
  if (typeof item !== "object" || item === null) return false;
  const value = item as Record<string, unknown>;
  return (
    typeof value["kind"] === "string" &&
    KINDS.includes(value["kind"] as FactKind) &&
    typeof value["subject"] === "string" &&
    value["subject"].trim().length > 1 &&
    typeof value["body"] === "string" &&
    value["body"].trim().length > 2
  );
}

/**
 * Reads the model's answer.
 *
 * Both shapes are accepted: the object with a summary, and a bare array of
 * facts, which is what a model reaching for the old format returns. A missing
 * summary is not worth a retry — the facts are the expensive half.
 */
function parseDistillation(text: string): Distillation {
  const empty: Distillation = { summary: "", facts: [] };

  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const asObject = objectStart !== -1 && (arrayStart === -1 || objectStart < arrayStart);

  const start = asObject ? objectStart : arrayStart;
  const end = asObject ? text.lastIndexOf("}") : text.lastIndexOf("]");
  if (start === -1 || end <= start) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return empty;
  }

  if (Array.isArray(parsed)) return { summary: "", facts: parsed.filter(isProposal) };

  if (typeof parsed !== "object" || parsed === null) return empty;
  const value = parsed as Record<string, unknown>;
  const facts = Array.isArray(value["feiten"]) ? value["feiten"].filter(isProposal) : [];
  const summary = typeof value["samenvatting"] === "string" ? value["samenvatting"].trim() : "";
  return { summary, facts };
}

/** What the owner threw out or rewrote, phrased as a lesson rather than a list. */
function correctionsBlock(corrections: Correction[]): string {
  if (corrections.length === 0) return "";
  const lines = corrections.map((c) =>
    c.action === "deleted"
      ? `- weggegooid [${c.kind}] ${c.subject}: ${c.before}`
      : `- herschreven [${c.kind}] ${c.subject}: "${c.before}" werd "${c.after ?? ""}"`,
  );
  return [
    "",
    "Dit is eerder weggegooid of herschreven nadat jij het had opgeschreven.",
    "Schrijf zulke dingen niet nog een keer op, en volg de herschreven formulering:",
    ...lines,
  ].join("\n");
}

/** Conversations being distilled right now, so a second trigger does not double up. */
const running = new Set<string>();

/**
 * Distils one finished conversation.
 *
 * Called when the conversation ends, and by the sweep for conversations whose
 * ending nobody saw — a restart, a crash, a socket that simply went away.
 */
export async function distilSession(store: MemoryStore, sessionId: string | null): Promise<number> {
  const key = sessionId ?? "";
  if (running.has(key)) return 0;

  const pending = store.pendingTurnsFor(sessionId);
  if (pending.length === 0) return 0;

  running.add(key);
  try {
    const transcript = pending
      .map((t) => `[${t.at}]\nGevraagd: ${t.asked}\nJARVIS: ${t.answered}`)
      .join("\n\n");

    // What is already known about *this* conversation, rather than whatever was
    // touched most recently. Core facts ride along regardless: they are what the
    // assistant is supposed to know without looking anything up.
    const asked = pending.map((t) => t.asked).join(" ");
    const related = await relatedFacts(store, asked);
    const merged = new Map<number, Fact>();
    for (const fact of [...store.core(), ...related]) merged.set(fact.id, fact);
    const known = [...merged.values()].map((f) => `${f.subject}: ${f.body}`).join("\n");

    const prompt = [
      known === "" ? "Je weet nog niets over dit huishouden." : `Dit weet je al:\n${known}`,
      correctionsBlock(store.recentCorrections()),
      "",
      "Het gesprek:",
      transcript,
      "",
      "Vat het gesprek samen en bewaar wat het bewaren waard is. Laat weg wat al bekend is, tenzij het veranderd is.",
    ].join("\n");

    let answer = "";
    for await (const message of query({
      prompt,
      options: {
        model: "haiku",
        systemPrompt: instructions(ownerName(loadConfig())),
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
      },
    })) {
      recordUsage(store, message, "distil");
      const value = message as { type?: string; message?: { content?: unknown } };
      if (value.type !== "assistant") continue;
      const content = value.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") answer += b.text;
      }
    }

    const { summary, facts } = parseDistillation(answer);
    for (const proposal of facts) {
      await writeFact(store, {
        kind: proposal.kind as FactKind,
        subject: proposal.subject.slice(0, 60),
        body: proposal.body.slice(0, 400),
        core: proposal.core === true,
        source: "jarvis",
        reason: "distilled",
      });
    }

    // Only a real conversation gets an entry of its own; the null bucket is the
    // pile of turns from before sessions were recorded and belongs to no one.
    if (sessionId !== null && summary !== "") {
      store.recordSession({
        id: sessionId,
        startedAt: pending[0]!.at,
        endedAt: pending[pending.length - 1]!.at,
        turns: pending.length,
        summary: summary.slice(0, 600),
      });
    }

    store.markDistilled(pending.map((t) => t.id));
    console.log(
      `memory: distilled a conversation of ${pending.length} exchanges into ${facts.length} facts` +
        `${summary === "" ? " (no summary)" : ""}`,
    );
    return facts.length;
  } catch (error) {
    console.error("memory: distillation failed:", error);
    return 0;
  } finally {
    running.delete(key);
  }
}

/**
 * Distils every conversation still waiting for it.
 *
 * Runs at start-up: anything undistilled at that point belongs to a conversation
 * that will never end politely, because the process that held it is gone.
 */
export async function distilPending(store: MemoryStore): Promise<number> {
  let facts = 0;
  for (const session of store.pendingSessions()) {
    facts += await distilSession(store, session.sessionId);
  }
  return facts;
}
