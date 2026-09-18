/**
 * Weekly consolidation pass over everything in memory.
 *
 * The per-conversation distiller (distiller.ts) decides what is worth writing
 * down, right after it happened, on a cheap model. This is the slower,
 * judgement-heavy counterpart: once a week, on a stronger model, it rereads
 * the whole fact table and proposes repairs — merging duplicates, resolving
 * contradictions, dropping what has clearly gone stale, and promoting or
 * demoting what belongs in the core set.
 *
 * It is deliberately conservative. Losing a fact the owner told the assistant is
 * worse than leaving a slightly redundant or slightly stale one in place, so
 * every proposed operation is validated against the facts that actually
 * exist before anything is applied, and when the model is unsure the right
 * answer is to say nothing about that fact at all.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

import { loadConfig, ownerName } from "../config.js";
import type { Fact, MemoryStore } from "./store.js";
import { recordUsage } from "./usage.js";

const instructions = (owner: string) => `Je bent JARVIS' geheugenbeheerder. Je krijgt alles wat hij nu onthoudt over
het huishouden van ${owner} en je stelt voorzichtig verbeteringen voor.

Zoek naar:
- duplicaten: twee feiten die hetzelfde zeggen in andere woorden -> laat het beste staan, verwijder de rest
- tegenspraken: twee feiten die elkaar tegenspreken -> verwijder het oudste/vervallen feit, behoud het nieuwere
- verlopen zaken: een "lopende" kwestie van maanden geleden die nooit meer terugkwam en duidelijk niet meer speelt
- kandidaten voor core: iets dat zonder twijfel in vrijwel elk gesprek relevant is (bv. wie er wonen)
  of dat aantoonbaar vaak opgezocht wordt
- kandidaten om uit core te halen: iets dat in core staat maar dat niet (meer) verdient
- vage of te lange formulering: herschrijf korter en concreter, zonder de betekenis te veranderen

Achter elk feit staat hoe vaak het is opgezocht en wanneer voor het laatst. Gebruik dat
als signaal, nooit als bewijs: veel opgezocht is een argument voor core, nooit opgezocht is
een argument om iets nog eens kritisch te lezen — maar een feit dat zelden ter sprake komt
en gewoon waar is (een verjaardag, een allergie) blijft staan.

Wees terughoudend. Bij twijfel doe je NIETS met dat feit. Verwijderen van iets
dat ${owner} verteld heeft is erger dan een beetje redundantie laten staan. Stel
alleen operaties voor waar je vrij zeker van bent.

Antwoord met JSON en niets anders: een array van operatie-objecten. Toegestane vormen:
- {"op":"delete","id":<nummer>,"why":"duplicate"|"contradiction"|"expired","reason":"<kort waarom>"}
- {"op":"rewrite","id":<nummer>,"body":"<nieuwe body>","reason":"<kort waarom>"}
- {"op":"core","id":<nummer>,"core":true|false,"reason":"<kort waarom>"}

Bij "delete" is "why" verplicht: "duplicate" als er een ander feit is dat
hetzelfde al zegt, "contradiction" als dit feit een nieuwer feit tegenspreekt,
"expired" als het gewoon niet meer speelt.

Gebruik alleen id's die je in de lijst hieronder ziet. Is er niets te verbeteren,
antwoord dan met [].`;

export interface ConsolidateSummary {
  merged: number;
  dropped: number;
  rewritten: number;
  promoted: number;
  demoted: number;
}

type DeleteReason = "duplicate" | "contradiction" | "expired";

interface DeleteOp {
  op: "delete";
  id: number;
  why: DeleteReason;
  reason?: string;
}

interface RewriteOp {
  op: "rewrite";
  id: number;
  body: string;
  reason?: string;
}

interface CoreOp {
  op: "core";
  id: number;
  core: boolean;
  reason?: string;
}

type Op = DeleteOp | RewriteOp | CoreOp;

function parseOps(text: string): Op[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    const ops: Op[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const value = item as Record<string, unknown>;
      const id = value["id"];
      if (typeof id !== "number" || !Number.isInteger(id)) continue;

      if (value["op"] === "delete") {
        const why = value["why"];
        const validWhy: DeleteReason[] = ["duplicate", "contradiction", "expired"];
        ops.push({
          op: "delete",
          id,
          why: typeof why === "string" && validWhy.includes(why as DeleteReason) ? (why as DeleteReason) : "expired",
        });
      } else if (value["op"] === "rewrite") {
        const body = value["body"];
        if (typeof body === "string" && body.trim().length > 2) {
          ops.push({ op: "rewrite", id, body: body.trim() });
        }
      } else if (value["op"] === "core") {
        const core = value["core"];
        if (typeof core === "boolean") {
          ops.push({ op: "core", id, core });
        }
      }
    }
    return ops;
  } catch {
    return [];
  }
}

/** One fact as consolidation reads it: the text, plus how it has been used. */
function describe(fact: Fact): string {
  const used =
    fact.hits === 0 || fact.lastUsedAt === null
      ? "nooit opgezocht"
      : `${fact.hits}x opgezocht, laatst ${fact.lastUsedAt.slice(0, 10)}`;
  return (
    `#${fact.id} [${fact.kind}${fact.core ? ", core" : ""}] ${fact.subject}: ${fact.body} ` +
    `(bijgewerkt ${fact.updatedAt.slice(0, 10)}, ${used})`
  );
}

let running = false;

/**
 * Runs one consolidation pass over the whole fact table. Safe to call by
 * hand or from a timer: it returns a no-op summary if a pass is already in
 * flight or there is nothing in memory to look at.
 */
export async function consolidate(
  store: MemoryStore,
  options: { limit?: number } = {},
): Promise<ConsolidateSummary> {
  const summary: ConsolidateSummary = { merged: 0, dropped: 0, rewritten: 0, promoted: 0, demoted: 0 };

  if (running) return summary;

  const facts = store.all(options.limit ?? 500);
  if (facts.length === 0) return summary;

  running = true;
  try {
    const byId = new Map<number, Fact>(facts.map((f) => [f.id, f]));

    const listing = facts
      .map(
        (f) =>
          `#${f.id} [${f.kind}${f.core ? ", core" : ""}] ${f.subject}: ${f.body} (bijgewerkt ${f.updatedAt})`,
      )
      .join("\n");

    const prompt = `Dit staat er nu in het geheugen:\n${listing}\n\nWelke operaties stel je voor?`;

    let answer = "";
    for await (const message of query({
      prompt,
      options: {
        model: "sonnet",
        systemPrompt: instructions(ownerName(loadConfig())),
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
      },
    })) {
      recordUsage(store, message, "consolidate");
      const value = message as { type?: string; message?: { content?: unknown } };
      if (value.type !== "assistant") continue;
      const content = value.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") answer += b.text;
      }
    }

    const ops = parseOps(answer);

    for (const op of ops) {
      const fact = byId.get(op.id);
      if (fact === undefined) continue; // hallucinated or already-gone id, skip

      if (op.op === "delete") {
        if (!store.forget(op.id, "consolidated")) continue;
        if (op.why === "duplicate") {
          summary.merged += 1;
        } else {
          summary.dropped += 1;
        }
        console.log(
          `memory: consolidate ${op.why === "duplicate" ? "merged" : "dropped"} #${op.id} (${fact.subject}, ${op.why})${op.reason ? ` — ${op.reason}` : ""}`,
        );
      } else if (op.op === "rewrite") {
        store.setBody(op.id, op.body, "consolidated");
        summary.rewritten += 1;
        console.log(`memory: consolidate rewrote #${op.id} (${fact.subject})${op.reason ? ` — ${op.reason}` : ""}`);
      } else if (op.op === "core") {
        if (fact.core === op.core) continue; // already in the requested state

        store.setCore(op.id, op.core);
        if (op.core) summary.promoted += 1;
        else summary.demoted += 1;
        console.log(
          `memory: consolidate ${op.core ? "promoted" : "demoted"} #${op.id} (${fact.subject})${op.reason ? ` — ${op.reason}` : ""}`,
        );
      }
    }

    return summary;
  } catch (error) {
    console.error("memory: consolidation failed:", error);
    return summary;
  } finally {
    running = false;
  }
}
