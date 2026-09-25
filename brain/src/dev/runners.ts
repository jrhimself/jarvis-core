/**
 * Watching over a job that was handed to a runner elsewhere.
 *
 * Delegation used to be one-way: the job left, and the slot it went into stayed
 * open until somebody noticed. Two slots and a machine that stays up for weeks
 * means the second job has nowhere to go, and the reason is a window nobody
 * closed a fortnight ago.
 *
 * Closing it automatically is the wrong fix. A runner is handed the work JARVIS
 * judged too big to do here, which is exactly the work that stops halfway to ask
 * something only the owner can answer -- a design choice, a name, whether the
 * awkward case is worth the code. A pane that has gone quiet is that question
 * just as often as it is a finished job, and the two look identical from the
 * outside.
 *
 * So the far side reports, and the judgement happens here: the instruction that
 * was given is on this side, and only something holding both can tell an ending
 * from a question. A question is relayed, and the slot stays open for the answer.
 *
 * An ending closes the slot by itself, but only when two things agree: the model
 * reads the screen as finished, and the runner wrote its own `KLAAR:` line, which
 * its brief asks it to end every turn with. Slots are opened on demand, so one
 * left standing is not a window somebody might still be looking at -- it is the
 * next job's place. An ending the runner did not declare itself ("definitively
 * stuck", in the model's words) is still offered with a button, because that is
 * the case where a person may want to look before the pane is gone.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

import type { Closed } from "@jarvis/shared";

import { escapeHtml } from "./notify.js";
import { loadConfig, ownerName } from "../config.js";
import { recordUsage } from "../memory/usage.js";
import type { MemoryStore } from "../memory/store.js";
import type { Sender } from "../proactive/suggest.js";
import type { Press } from "../telegram.js";

/** What the far side sends when a delegated runner falls quiet. */
export interface RunnerReport {
  slot: number;
  /** The brief the runner was started with. */
  task: string;
  /** The last screen of its pane. */
  tail: string;
}

/** What the last screen of a runner turned out to mean. */
export type Verdict =
  | { state: "done"; summary: string }
  | { state: "asking"; question: string }
  | { state: "working" };

/** The prefix that marks a press as belonging to this feature. */
const TAG = "runner";

/** Longest a judgement may take before the report is dropped. */
const JUDGE_TIMEOUT_MS = 90_000;

/** Cut off the pane before it reaches the model; the ending is what matters. */
const TAIL_CHARS = 6000;

const instructions = (owner: string) =>
  `Je bewaakt een Claude-runner die namens JARVIS een klus doet op een andere machine.
Je krijgt de opdracht die hij meekreeg en het laatste scherm van zijn terminal.

Antwoord met precies één regel, in één van deze drie vormen:

KLAAR: <in één zin wat er nu ligt>
VRAAG: <in één zin wat hij van ${owner} nodig heeft>
BEZIG

Kies KLAAR alleen als het werk af is of definitief gestrand. Kies VRAAG als hij
wacht op een keuze, een goedkeuring of informatie die alleen ${owner} heeft.
Kies BEZIG bij alles daartussen, ook als je het niet zeker weet -- een runner
die nog draait mag niet gesloten worden.`;

/**
 * Reads the model's one line back.
 *
 * Anything unrecognised is "working", deliberately. The cost of misreading an
 * ending is a slot that stays open a while longer; the cost of misreading a
 * question is a runner closed with the answer to it still unspoken.
 */
export function readVerdict(answer: string): Verdict {
  const line = answer
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return { state: "working" };

  const done = /^KLAAR\s*:\s*(.+)$/i.exec(line);
  if (done?.[1] !== undefined) return { state: "done", summary: done[1].trim() };

  const asking = /^VRAAG\s*:\s*(.+)$/i.exec(line);
  if (asking?.[1] !== undefined) return { state: "asking", question: asking[1].trim() };

  return { state: "working" };
}

/** The last of a pane, short enough to send. */
function excerpt(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= TAIL_CHARS ? trimmed : `…${trimmed.slice(-TAIL_CHARS)}`;
}

/** Asks the model what it is looking at. */
export async function judge(store: MemoryStore, report: RunnerReport): Promise<Verdict> {
  const prompt = [
    `Opdracht die runner ${report.slot} meekreeg:`,
    report.task.trim(),
    "",
    "Laatste scherm van zijn terminal:",
    excerpt(report.tail),
  ].join("\n");

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
    recordUsage(store, message, "supervise");
    const value = message as { type?: string; message?: { content?: unknown } };
    if (value.type !== "assistant") continue;
    const content = value.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") answer += b.text;
    }
  }

  return readVerdict(answer);
}

/** The message that offers to close a slot. */
export function doneMessage(report: RunnerReport, summary: string): string {
  return [
    `<b>Runner ${report.slot} is klaar</b>`,
    "",
    escapeHtml(summary),
    "",
    `<i>${escapeHtml(firstLine(report.task))}</i>`,
  ].join("\n");
}

/** The message that passes on what the runner wants to know. */
export function questionMessage(report: RunnerReport, question: string): string {
  return [
    `<b>Runner ${report.slot} wacht op jou</b>`,
    "",
    escapeHtml(question),
    "",
    `<i>${escapeHtml(firstLine(report.task))}</i>`,
  ].join("\n");
}

/** The opening line of a brief, as a reminder of which job this was. */
function firstLine(task: string): string {
  return (
    task
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? ""
  );
}

/** The two answers to "it is finished", in the order they are shown. */
export function buttonsFor(slot: number): { text: string; data: string }[] {
  return [
    { text: "Sluiten", data: `${TAG}:close:${slot}` },
    { text: "Laat open", data: `${TAG}:keep:${slot}` },
  ];
}

/** A press on one of those buttons, or null when it belongs to something else. */
export function pressed(data: string): { action: "close" | "keep"; slot: number } | null {
  const [tag, action, rawSlot] = data.split(":");
  if (tag !== TAG || rawSlot === undefined) return null;
  if (action !== "close" && action !== "keep") return null;
  // Digits rather than Number(): an empty tail parses as zero, which is a slot
  // number, and a button that closes "slot 0" would eventually find one.
  if (!/^\d+$/.test(rawSlot)) return null;
  return { action, slot: Number(rawSlot) };
}

/** What a message becomes once it has been answered. */
export function settled(body: string, closed: boolean, detail = ""): string {
  const note = closed ? "Slot gesloten." : "Blijft open.";
  return `${body}\n\n<i>${escapeHtml(detail === "" ? note : `${note} ${detail}`)}</i>`;
}

/**
 * Whether the runner declared itself finished, in its own words.
 *
 * The last `KLAAR:` or `VRAAG:` line on the screen decides. The brief itself
 * mentions both words, quoted and with a placeholder after them, and can still
 * be on screen for a short job; a line has to start with the word, after the
 * bullet the terminal draws, to count as the runner speaking.
 */
export function declaredDone(tail: string): boolean {
  let last: "done" | "asking" | null = null;
  for (const raw of tail.split("\n")) {
    const line = raw.replace(/^[\s●⏺•*>-]+/u, "");
    if (line.includes("<")) continue;
    if (/^KLAAR\s*:\s*\S/i.test(line)) last = "done";
    else if (/^VRAAG\s*:\s*\S/i.test(line)) last = "asking";
  }
  return last === "done";
}

/** Closes a slot over the delegate seam. */
export type CloseSlot = (slot: number) => Promise<Closed>;

/**
 * Says what a verdict means, and closes the slot when the job is over.
 *
 * Split from `supervise` so what happens after a judgement can be exercised
 * without a model: a runner that declared itself done is closed and the message
 * says so; anything less certain gets the buttons it always had.
 */
export async function actOn(
  bot: Sender,
  chatId: string,
  report: RunnerReport,
  verdict: Verdict,
  close?: CloseSlot,
): Promise<void> {
  if (verdict.state === "asking") {
    await bot.send(chatId, questionMessage(report, verdict.question));
    return;
  }
  if (verdict.state !== "done") return;

  const body = doneMessage(report, verdict.summary);
  if (close !== undefined && declaredDone(report.tail)) {
    const result = await close(report.slot);
    if (result.ok) {
      offered.delete(report.slot);
      await bot.send(chatId, settled(body, true));
      return;
    }
    console.error(`runners: could not close slot ${report.slot}: ${result.error}`);
  }
  const messageId = await bot.send(chatId, body, buttonsFor(report.slot));
  if (messageId !== null) offered.set(report.slot, { chatId, messageId, body });
}

/** Slots with a judgement already in flight, so a burst is judged once. */
const judging = new Set<number>();

/** What a delivered offer needs remembered until the button is pressed. */
interface Offer {
  chatId: string;
  messageId: number;
  body: string;
}

const offered = new Map<number, Offer>();

/**
 * Judges one report and says something about it, or nothing.
 *
 * Nothing is the ordinary case: most turns of a long job end with the runner
 * still working, and a message per turn would make the whole feature something
 * to be muted.
 */
export async function supervise(
  store: MemoryStore,
  bot: Sender,
  chatId: string,
  report: RunnerReport,
  close?: CloseSlot,
): Promise<Verdict> {
  if (chatId === "") return { state: "working" };
  if (judging.has(report.slot)) return { state: "working" };
  judging.add(report.slot);

  try {
    const verdict = await Promise.race([
      judge(store, report),
      new Promise<Verdict>((resolve) =>
        setTimeout(() => resolve({ state: "working" }), JUDGE_TIMEOUT_MS).unref(),
      ),
    ]);

    await actOn(bot, chatId, report, verdict, close);
    return verdict;
  } catch (error) {
    console.error(`runners: could not judge slot ${report.slot}:`, error);
    return { state: "working" };
  } finally {
    judging.delete(report.slot);
  }
}

/**
 * Takes a press and closes the slot, or leaves it alone.
 *
 * The slot travels in the button rather than in a table: there are two of them,
 * the answer is worth nothing an hour later, and a restart in between should
 * leave a stale button that closes nothing rather than one that closes whatever
 * is running in that slot now.
 */
export async function handleRunnerPress(
  bot: Sender,
  close: (slot: number) => Promise<Closed>,
  press: Press,
): Promise<boolean> {
  const answer = pressed(press.data);
  if (answer === null) return false;

  const offer = offered.get(answer.slot);
  const body = offer?.body ?? `<b>Runner ${answer.slot}</b>`;

  if (answer.action === "keep") {
    offered.delete(answer.slot);
    await bot.acknowledge(press.queryId, "Blijft open.");
    await bot.settle(press.chatId, press.messageId, settled(body, false));
    return true;
  }

  const result = await close(answer.slot);
  offered.delete(answer.slot);
  await bot.acknowledge(press.queryId, result.ok ? "Slot gesloten." : "Dat lukte niet.");
  await bot.settle(
    press.chatId,
    press.messageId,
    settled(body, result.ok, result.ok ? "" : result.error),
  );
  return true;
}
