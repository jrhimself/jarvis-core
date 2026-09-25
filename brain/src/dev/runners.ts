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
 * from a question.
 *
 * A question is JARVIS' first. He knows what was asked, what the owner told him
 * over the months, and what any careful developer would decide without asking;
 * most of what a runner stops on is one of those. What he answers is typed into
 * the pane, and the owner is told afterwards. What is the owner's to decide --
 * taste, money, access, anything that cannot be undone -- or what JARVIS is not
 * sure of goes to the owner, and a reply to that message goes back into the
 * pane. A runner that keeps asking is not answered forever: after a handful of
 * answers, or the same question twice, the owner hears of it instead.
 *
 * A runner that goes quiet without reporting -- stuck on a prompt, or gone --
 * is looked in on from this side, so a job cannot disappear unnoticed.
 *
 * An ending closes the slot by itself, but only when two things agree: the model
 * reads the screen as finished, and the runner wrote its own `DONE:` line, which
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
import { coreBlock, recallFacts } from "../memory/tools.js";
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
  `You supervise a Claude runner doing a job for JARVIS on another machine.
You get the brief it was started with and the last screen of its terminal.

Answer with exactly one line, in one of these three forms:

DONE: <in one sentence, what is there now>
QUESTION: <in one sentence, what it needs from ${owner}>
WORKING

Choose DONE only when the work is finished or definitively stuck. Choose QUESTION
when it is waiting for a choice, an approval or information only ${owner} has.
Choose WORKING for everything in between, including when you are not sure -- a
runner that is still going must not be closed.`;

/** The line that ends a runner's turn, in the words its brief asks for or the older ones. */
const DONE_LINE = /^(?:DONE|KLAAR)\s*:\s*(.+)$/i;
const QUESTION_LINE = /^(?:QUESTION|VRAAG)\s*:\s*(.+)$/i;

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

  const done = DONE_LINE.exec(line);
  if (done?.[1] !== undefined) return { state: "done", summary: done[1].trim() };

  const asking = QUESTION_LINE.exec(line);
  if (asking?.[1] !== undefined) return { state: "asking", question: asking[1].trim() };

  return { state: "working" };
}

/** The last of a pane, short enough to send. */
function excerpt(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length <= TAIL_CHARS ? trimmed : `…${trimmed.slice(-TAIL_CHARS)}`;
}

/** One model call without tools, and the text it answered. */
async function oneAnswer(store: MemoryStore, model: string, systemPrompt: string, prompt: string): Promise<string> {
  let answer = "";
  for await (const message of query({
    prompt,
    options: { model, systemPrompt, tools: [], allowedTools: [], settingSources: [], maxTurns: 1 },
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
  return answer;
}

/** The brief and the screen, as every prompt about one runner starts. */
function situation(report: RunnerReport): string[] {
  return [
    `Brief runner ${report.slot} was started with:`,
    report.task.trim(),
    "",
    "Last screen of its terminal:",
    excerpt(report.tail),
  ];
}

/** Asks the model what it is looking at. */
export async function judge(store: MemoryStore, report: RunnerReport): Promise<Verdict> {
  const answer = await oneAnswer(
    store,
    "sonnet",
    instructions(ownerName(loadConfig())),
    situation(report).join("\n"),
  );
  return readVerdict(answer);
}

/** What JARVIS makes of a runner's question: an answer of his own, or one for the owner. */
export type Consideration = { answer: string } | { ask: string };

/** Questions of one job JARVIS answers himself before the owner hears of the next one. */
export const OWN_ANSWERS_PER_JOB = 5;

/** Longest JARVIS may think about a question before it goes to the owner as it is. */
const CONSIDER_TIMEOUT_MS = 120_000;

const answerInstructions = (owner: string, known: string) =>
  `You are JARVIS, ${owner}'s assistant. A Claude runner doing a job for you on another
machine stopped to ask a question. Answer it yourself whenever you can, so that ${owner}
is only asked what is his to decide.

Answer it yourself when the answer follows from the brief, from what you know below, or
from the judgement a careful senior developer makes without asking: naming, structure,
which of two sound approaches, whether to run the tests, where to look, what to try next
after a failure, whether to go on with the plan it proposed when the plan fits the brief.

Leave it to ${owner} when it is his to decide: a matter of taste he has not stated, money,
credentials or access, anything that deletes something or cannot be undone, anything
outside what the brief asked for -- or when you are not sure what he would want. A guess
at his wishes is worse than a question.

Answer with exactly one of these, and nothing before it:

ANSWER: <your answer, addressed to the runner, complete enough to act on>
ASK: <the question for ${owner}, in one sentence he can answer without seeing the screen>` +
  (known === "" ? "" : `\n\nWhat you know:\n${known}`);

/**
 * Reads JARVIS' decision back.
 *
 * Anything that is not a clear answer goes to the owner with the runner's own
 * question: an answer typed into a pane is acted on, and one that was really a
 * hedge would be acted on just the same.
 */
export function readConsideration(text: string, question: string): Consideration {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^\s*(ANSWER|ASK)\s*:/i.test(line));
  if (start === -1) return { ask: question };
  const head = lines[start] ?? "";
  const rest = [head.replace(/^\s*(ANSWER|ASK)\s*:\s*/i, ""), ...lines.slice(start + 1)].join("\n").trim();
  if (rest === "") return { ask: question };
  if (/^\s*ANSWER/i.test(head)) return { answer: rest };
  return { ask: rest.split("\n")[0]?.trim() || question };
}

/** What JARVIS knows that could bear on the question: the core facts and a few recalled ones. */
async function known(store: MemoryStore, question: string): Promise<string> {
  const lines = [coreBlock(store)];
  try {
    const recalled = await recallFacts(store, question, 6);
    lines.push(...recalled.map((fact) => `- ${fact.subject}: ${fact.body}`));
  } catch (error) {
    // Recall is a help, not a requirement; the core facts are already there.
    console.warn("runners: could not recall facts for a question:", error);
  }
  return lines.filter((line) => line.trim() !== "").join("\n");
}

/** Makes up JARVIS' mind about a runner's question, on the stronger model when there is one. */
export async function consider(
  store: MemoryStore,
  report: RunnerReport,
  question: string,
): Promise<Consideration> {
  const config = loadConfig();
  const model = config.escalateModel !== "" ? config.escalateModel : config.model;
  const answer = await Promise.race([
    (async () =>
      oneAnswer(
        store,
        model,
        answerInstructions(ownerName(config), await known(store, question)),
        [...situation(report), "", `The question: ${question}`].join("\n"),
      ))(),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), CONSIDER_TIMEOUT_MS).unref()),
  ]);
  return readConsideration(answer, question);
}

/** The message that offers to close a slot. */
export function doneMessage(report: RunnerReport, summary: string): string {
  return [
    `<b>Runner ${report.slot} is done</b>`,
    "",
    escapeHtml(summary),
    "",
    `<i>${escapeHtml(firstLine(report.task))}</i>`,
  ].join("\n");
}

/** The message that passes on what the runner wants to know. */
export function questionMessage(
  report: RunnerReport,
  question: string,
  why = "",
  replyable = false,
): string {
  return [
    `<b>Runner ${report.slot} is waiting for you</b>`,
    "",
    escapeHtml(question),
    ...(why === "" ? [] : ["", `<i>${escapeHtml(why)}</i>`]),
    ...(replyable ? ["", "Reply to this message and I will pass your answer on."] : []),
    "",
    `<i>${escapeHtml(firstLine(report.task))}</i>`,
  ].join("\n");
}

/** The message that says JARVIS answered a runner himself, and what. */
export function answeredMessage(report: RunnerReport, question: string, answer: string): string {
  return [
    `<b>Runner ${report.slot} asked, and I answered</b>`,
    "",
    `<b>Q</b> ${escapeHtml(question)}`,
    `<b>A</b> ${escapeHtml(answer)}`,
    "",
    `<i>${escapeHtml(firstLine(report.task))}</i>`,
  ].join("\n");
}

/** The message that says a runner went away without finishing. */
export function goneMessage(slot: number, task: string): string {
  return [
    `<b>Runner ${slot} stopped</b>`,
    "",
    "It ended without saying the job was done.",
    "",
    `<i>${escapeHtml(firstLine(task))}</i>`,
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
    { text: "Close", data: `${TAG}:close:${slot}` },
    { text: "Keep open", data: `${TAG}:keep:${slot}` },
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
  const note = closed ? "Slot closed." : "Kept open.";
  return `${body}\n\n<i>${escapeHtml(detail === "" ? note : `${note} ${detail}`)}</i>`;
}

/**
 * Whether the runner declared itself finished, in its own words.
 *
 * The last `DONE:` or `QUESTION:` line on the screen decides (`KLAAR:` and
 * `VRAAG:` from older briefs count too). The brief itself
 * mentions both words, quoted and with a placeholder after them, and can still
 * be on screen for a short job; a line has to start with the word, after the
 * bullet the terminal draws, to count as the runner speaking.
 */
export function declaredDone(tail: string): boolean {
  let last: "done" | "asking" | null = null;
  for (const raw of tail.split("\n")) {
    const line = raw.replace(/^[\s●⏺•*>-]+/u, "");
    if (line.includes("<")) continue;
    if (DONE_LINE.test(line)) last = "done";
    else if (QUESTION_LINE.test(line)) last = "asking";
  }
  return last === "done";
}

/** Closes a slot over the delegate seam. */
export type CloseSlot = (slot: number) => Promise<Closed>;

/** Types a message into a slot's runner over the delegate seam. */
export type ReplySlot = (slot: number, text: string) => Promise<Closed>;

/** What the supervisor can do beyond closing a slot, each optional. */
export interface RunnerSeam {
  reply?: ReplySlot;
  /** JARVIS' own answer to a question; a model call, replaced in tests. */
  consider?: (report: RunnerReport, question: string) => Promise<Consideration>;
  /** Told when a runner declared its job done, so the job's record can say so. */
  finished?: (slot: number, summary: string) => void;
}

/** What one job's questions have cost so far. */
interface Asking {
  answered: number;
  last: string;
}

const asking = new Map<number, Asking>();

/** Questions that went to the owner, by chat and message, so a reply finds its runner. */
const withOwner = new Map<string, number>();

const messageKey = (chatId: string, messageId: number) => `${chatId}:${messageId}`;

const same = (a: string, b: string) =>
  a.trim().toLowerCase().replace(/\s+/g, " ") === b.trim().toLowerCase().replace(/\s+/g, " ");

/** Drops what was kept about a slot, once its job is over. */
export function forget(slot: number): void {
  asking.delete(slot);
  lastHeard.delete(slot);
  lastScreen.delete(slot);
  for (const [key, held] of withOwner) if (held === slot) withOwner.delete(key);
}

/**
 * A runner's question: answered by JARVIS when he can and may, passed to the owner otherwise.
 *
 * Split from `actOn` so the brakes -- a count per job, and a question that comes
 * back after it was answered -- can be exercised without a model.
 */
export async function onQuestion(
  bot: Sender,
  chatId: string,
  report: RunnerReport,
  question: string,
  seam: RunnerSeam = {},
): Promise<void> {
  const job = asking.get(report.slot) ?? { answered: 0, last: "" };
  asking.set(report.slot, job);
  const repeated = job.last !== "" && same(job.last, question);
  job.last = question;

  let toOwner = question;
  let why = "";
  if (seam.reply !== undefined && seam.consider !== undefined) {
    if (repeated) {
      why = "It asked this before, and my answer did not settle it.";
    } else if (job.answered >= OWN_ANSWERS_PER_JOB) {
      why = `I have answered ${job.answered} of its questions already; this one is yours.`;
    } else {
      const mind = await seam.consider(report, question);
      if ("answer" in mind) {
        const sent = await seam.reply(report.slot, mind.answer);
        if (sent.ok) {
          job.answered += 1;
          await bot.send(chatId, answeredMessage(report, question, mind.answer));
          return;
        }
        console.error(`runners: could not answer slot ${report.slot}: ${sent.error}`);
        why = `I had an answer, but could not pass it on: ${sent.error}`;
      } else {
        toOwner = mind.ask;
      }
    }
  }

  const replyable = seam.reply !== undefined;
  const messageId = await bot.send(chatId, questionMessage(report, toOwner, why, replyable));
  if (messageId !== null && replyable) withOwner.set(messageKey(chatId, messageId), report.slot);
}

/**
 * The owner's reply to a runner's question, typed into that runner.
 *
 * False when the message was not a reply to one, so it goes on to the chat
 * like anything else he types.
 */
export async function handleRunnerReply(
  bot: Pick<Sender, "send">,
  reply: ReplySlot | undefined,
  said: { chatId: string; text: string; replyTo?: number },
): Promise<boolean> {
  if (said.replyTo === undefined || reply === undefined) return false;
  const key = messageKey(said.chatId, said.replyTo);
  const slot = withOwner.get(key);
  if (slot === undefined) return false;

  const sent = await reply(slot, said.text);
  if (sent.ok) {
    withOwner.delete(key);
    await bot.send(said.chatId, `Passed on to runner ${slot}.`);
  } else {
    await bot.send(said.chatId, `Runner ${slot} did not take it: ${escapeHtml(sent.error)}`);
  }
  return true;
}

/** How long a delegated runner may stay silent before it is looked in on. */
export const QUIET_MS = 30 * 60_000;

/** When each slot was last heard from, by its own report or by a look. */
const lastHeard = new Map<number, number>();

/** The screen each slot showed at the last look, so an unchanged one is judged once. */
const lastScreen = new Map<number, string>();

/** One job that is with a runner, as the look needs it. */
export interface Watched {
  slot: number;
  /** The instruction it was handed. */
  task: string;
  /** When it was handed on, in epoch milliseconds. */
  since: number;
}

/**
 * Looks in on runners that have been quiet too long.
 *
 * The runner's own Stop hook is the ordinary way to hear from it; this is for
 * the rest. A runner stuck on a prompt never ends a turn and so never reports,
 * and one whose session died reports nothing at all -- both look, from here,
 * exactly like a runner hard at work. A screen that changed is judged like a
 * report; a slot that is not running any more, or that this delegate no longer
 * has, is `gone`.
 */
export async function lookIn(
  watched: readonly Watched[],
  slots: readonly number[],
  tail: (slot: number, lines: number) => Promise<{ ok: true; text: string } | { ok: false; error: string }>,
  report: (report: RunnerReport) => Promise<unknown>,
  gone: (job: Watched) => Promise<void>,
  now: number,
): Promise<void> {
  for (const job of watched) {
    if (!slots.includes(job.slot)) {
      forget(job.slot);
      await gone(job);
      continue;
    }
    const heard = Math.max(lastHeard.get(job.slot) ?? 0, job.since);
    if (now - heard < QUIET_MS) continue;

    const read = await tail(job.slot, 120);
    if (!read.ok) {
      if (/not running/i.test(read.error)) {
        forget(job.slot);
        await gone(job);
      }
      continue;
    }
    lastHeard.set(job.slot, now);
    if (lastScreen.get(job.slot) === read.text) continue;
    lastScreen.set(job.slot, read.text);
    await report({ slot: job.slot, task: job.task, tail: read.text });
  }
}

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
  seam: RunnerSeam = {},
): Promise<void> {
  if (verdict.state === "asking") {
    await onQuestion(bot, chatId, report, verdict.question, seam);
    return;
  }
  if (verdict.state !== "done") return;

  const body = doneMessage(report, verdict.summary);
  const declared = declaredDone(report.tail);
  if (declared) seam.finished?.(report.slot, verdict.summary);
  if (close !== undefined && declared) {
    const result = await close(report.slot);
    if (result.ok) {
      offered.delete(report.slot);
      forget(report.slot);
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
  seam: RunnerSeam = {},
): Promise<Verdict> {
  if (chatId === "") return { state: "working" };
  lastHeard.set(report.slot, Date.now());
  if (judging.has(report.slot)) return { state: "working" };
  judging.add(report.slot);

  try {
    const verdict = await Promise.race([
      judge(store, report),
      new Promise<Verdict>((resolve) =>
        setTimeout(() => resolve({ state: "working" }), JUDGE_TIMEOUT_MS).unref(),
      ),
    ]);

    await actOn(bot, chatId, report, verdict, close, seam);
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
    await bot.acknowledge(press.queryId, "Kept open.");
    await bot.settle(press.chatId, press.messageId, settled(body, false));
    return true;
  }

  const result = await close(answer.slot);
  offered.delete(answer.slot);
  if (result.ok) forget(answer.slot);
  await bot.acknowledge(press.queryId, result.ok ? "Slot closed." : "That did not work.");
  await bot.settle(
    press.chatId,
    press.messageId,
    settled(body, result.ok, result.ok ? "" : result.error),
  );
  return true;
}
