/**
 * Catching a turn that gave up.
 *
 * The deployment block tells the model that "I cannot" is where the work
 * starts, and most of the time that is enough. Not always: asked what the
 * council was doing to the roads in a nearby village, it answered that nothing
 * it had reached the council, and stopped -- a question a runner with a
 * browser answers in a minute. A rule the model follows most of the time is a
 * rule the owner cannot rely on, so this one is also checked in code.
 *
 * At the end of every turn that did not already close a gap, a small model
 * reads the question and the answer and says whether the answer gave up for
 * want of an ability, a source or a fact. If it did, the turn is not allowed
 * to end: the model is told to call `close_gap` now and say what it started.
 * That happens once per turn at most -- the SDK marks the second stop as
 * `stop_hook_active`, and a turn that was already sent back once is let go --
 * so a disagreement between the two models ends in a sentence rather than in a
 * loop.
 *
 * Judged by a model rather than by words: a list of phrases would be a list in
 * one language, and "dat weet ik niet" and "nothing I have reaches that" are
 * the same answer.
 *
 * The same look also catches the opposite mistake: work that should stop. A
 * gap closed on a guess -- JARVIS assumed a message came from a marketplace and
 * started learning to read one -- went on being built after the owner said it
 * was an e-mail thread, because the correction reached the conversation and
 * nothing else. So the check is also shown the jobs still open, and names any
 * that the exchange shows rest on a misunderstanding or are no longer wanted;
 * the turn is then sent back to drop them with `abandon_dev_task`.
 */

import { query, type HookCallbackMatcher, type HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/** Longest the check may take. A slow check lets the turn end rather than hold it. */
const CHECK_TIMEOUT_MS = 10_000;

/** The tool that drops a job, whose use means the turn already acted on a correction. */
export const DROP_TOOL = "mcp__selfdev__abandon_dev_task";

/** One job still open, as the check is shown it. */
export interface OpenJob {
  id: number;
  /** What it is about, in a line or two. */
  job: string;
}

/** What the check found: whether the answer gave up, and which jobs should stop. */
export interface Check {
  gaveUp: boolean;
  drop: number[];
}

const NOTHING: Check = { gaveUp: false, drop: [] };

/** Tools whose use means the turn already did something about a gap. */
export const GAP_TOOLS = [
  "mcp__selfdev__close_gap",
  "mcp__selfdev__propose_dev_task",
  "mcp__selfdev__start_dev_task",
];

const CHECK_INSTRUCTIONS = `You check the answers of a voice assistant that can learn: it can have a
missing ability built into itself, so that it can do the thing from then on.

You get what the user asked and what the assistant answered. Decide whether the answer
gave up: it says, in any language and in any words, that the assistant cannot do this,
does not know, has no access, tool or source for it, or it gives only part of what was
asked for that reason.

Answer with exactly one word:

GAVE_UP when it gave up in that way.
FINE for everything else: a complete answer, a question back to the user, something
that was done, a refusal for safety or privacy, small talk, or an answer that says the
missing ability is already being built.

You may also be shown the jobs the assistant has running in the background, each with its
number. After that first word, add one line DROP <number> for every job this exchange shows
should stop: the user corrected what the job assumed, said it is not what he meant, or said
it is not needed. A job the exchange does not touch is never dropped, and neither is one
the user merely did not mention.`;

/** The nudge that sends a turn that gave up back to work. */
export const NUDGE =
  "You told the user you cannot do this or do not know it. Do not stop there. Call close_gap " +
  "now, naming the general ability behind the request, so that you can do it yourself next time. " +
  "Then add one short sentence saying that you are learning it. If close_gap refuses, say why in " +
  "one sentence and stop.";

/** The nudge that sends a turn back to drop the jobs a correction made pointless. */
export function dropNudge(jobs: readonly OpenJob[]): string {
  const named = jobs.map((job) => `task ${job.id} (${job.job})`).join(", ");
  return (
    `What the user just said shows that ${named} rests on a misunderstanding or is not wanted. ` +
    "Call abandon_dev_task for it now with the reason, then say in one short sentence that you " +
    "stopped it."
  );
}

/**
 * Reads the checking model's answer back. Anything unclear lets the turn end.
 *
 * The first word decides whether the answer gave up; every later line that
 * starts with DROP and a number names a job, and only numbers that were shown
 * count -- a job the model invents cannot be dropped.
 */
export function readCheck(answer: string, jobs: readonly OpenJob[] = []): Check {
  const lines = answer.trim().split("\n");
  const word = lines[0]?.trim().split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z_]/g, "") ?? "";
  const known = new Set(jobs.map((job) => job.id));
  const drop: number[] = [];
  for (const line of lines) {
    const found = /^\s*DROP\s+#?(\d+)\s*$/i.exec(line);
    const id = found === null ? NaN : Number(found[1]);
    if (known.has(id) && !drop.includes(id)) drop.push(id);
  }
  return { gaveUp: word === "GAVE_UP", drop };
}

/** The exchange as the checking model is shown it. */
function checkPrompt(question: string, answer: string, jobs: readonly OpenJob[]): string {
  const parts = [`The user asked:\n${question.trim()}`, `The assistant answered:\n${answer.trim()}`];
  if (jobs.length > 0) {
    parts.push(`Jobs running in the background:\n${jobs.map((job) => `${job.id}: ${job.job}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Asks a small model whether an answer gave up, and which jobs should stop. Nothing on any failure. */
export async function checkTurn(
  question: string,
  answer: string,
  jobs: readonly OpenJob[] = [],
  model = "haiku",
): Promise<Check> {
  const run = async (): Promise<Check> => {
    let text = "";
    for await (const message of query({
      prompt: checkPrompt(question, answer, jobs),
      options: {
        model,
        systemPrompt: CHECK_INSTRUCTIONS,
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
      },
    })) {
      const value = message as { type?: string; message?: { content?: unknown } };
      if (value.type !== "assistant") continue;
      const content = value.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") text += b.text;
      }
    }
    return readCheck(text, jobs);
  };
  try {
    return await Promise.race([
      run(),
      new Promise<Check>((resolve) => setTimeout(() => resolve(NOTHING), CHECK_TIMEOUT_MS).unref()),
    ]);
  } catch (error) {
    console.warn("gap-check: could not check an answer:", error);
    return NOTHING;
  }
}

/** What the hook needs from the turn it runs in. */
export interface GapTurn {
  /** The user's question, as asked. */
  question: string;
  /** Names of the tools the turn called so far. */
  tools: readonly string[];
  /** Jobs that were already open when the turn began. */
  jobs?: readonly OpenJob[];
}

/**
 * The Stop hook that sends a turn that gave up back to work, once.
 *
 * `check` is the model call, passed in so the decision can be exercised
 * without one.
 */
export function gapHook(
  turn: () => GapTurn | null,
  check: (question: string, answer: string, jobs: readonly OpenJob[]) => Promise<Check> = checkTurn,
  /**
   * Told the moment the model stops, before the check. The answer is out, and
   * the check's few seconds are not a silence to fill with a line that says
   * something is being looked up.
   */
  settling: () => void = () => {},
): HookCallbackMatcher {
  return {
    hooks: [
      async (input): Promise<HookJSONOutput> => {
        settling();
        const stop = input as { stop_hook_active?: boolean; last_assistant_message?: string };
        if (stop.stop_hook_active === true) return {};
        const current = turn();
        if (current === null) return {};
        // A turn that already closed a gap needs no nudge to close one; a turn
        // that already dropped a job needs none to drop one. Only what is left
        // is worth a model call.
        const closed = current.tools.some((name) => GAP_TOOLS.includes(name));
        const jobs = current.tools.includes(DROP_TOOL) ? [] : (current.jobs ?? []);
        if (closed && jobs.length === 0) return {};
        const answer = stop.last_assistant_message ?? "";
        if (answer.trim() === "") return {};

        const found = await check(current.question, answer, jobs);
        const gaveUp = found.gaveUp && !closed;
        const drop = jobs.filter((job) => found.drop.includes(job.id));
        if (!gaveUp && drop.length === 0) return {};

        if (drop.length > 0) {
          const ids = drop.map((job) => job.id).join(", ");
          console.log(`gap-check: the exchange makes task ${ids} pointless; sending it back to drop it`);
        }
        if (gaveUp) console.log("gap-check: the turn gave up; sending it back to close the gap");
        const reason = [drop.length > 0 ? dropNudge(drop) : "", gaveUp ? NUDGE : ""]
          .filter((part) => part !== "")
          .join(" ");
        return { decision: "block", reason };
      },
    ],
  };
}
