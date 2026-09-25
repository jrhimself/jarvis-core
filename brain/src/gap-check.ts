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
 */

import { query, type HookCallbackMatcher, type HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/** Longest the check may take. A slow check lets the turn end rather than hold it. */
const CHECK_TIMEOUT_MS = 10_000;

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
missing ability is already being built.`;

/** The nudge that sends a turn that gave up back to work. */
export const NUDGE =
  "You told the user you cannot do this or do not know it. Do not stop there. Call close_gap " +
  "now, naming the general ability behind the request, so that you can do it yourself next time. " +
  "Then add one short sentence saying that you are learning it. If close_gap refuses, say why in " +
  "one sentence and stop.";

/** Reads the checking model's one word back. Anything unclear lets the turn end. */
export function readCheck(answer: string): boolean {
  const word = answer.trim().split(/\s+/)[0]?.toUpperCase().replace(/[^A-Z_]/g, "") ?? "";
  return word === "GAVE_UP";
}

/** Asks a small model whether an answer gave up. False on any failure. */
export async function gaveUp(question: string, answer: string, model = "haiku"): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    let text = "";
    for await (const message of query({
      prompt: `The user asked:\n${question.trim()}\n\nThe assistant answered:\n${answer.trim()}`,
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
    return readCheck(text);
  };
  try {
    return await Promise.race([
      run(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CHECK_TIMEOUT_MS).unref()),
    ]);
  } catch (error) {
    console.warn("gap-check: could not check an answer:", error);
    return false;
  }
}

/** What the hook needs from the turn it runs in. */
export interface GapTurn {
  /** The user's question, as asked. */
  question: string;
  /** Names of the tools the turn called so far. */
  tools: readonly string[];
}

/**
 * The Stop hook that sends a turn that gave up back to work, once.
 *
 * `check` is the model call, passed in so the decision can be exercised
 * without one.
 */
export function gapHook(
  turn: () => GapTurn | null,
  check: (question: string, answer: string) => Promise<boolean> = gaveUp,
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
        if (current.tools.some((name) => GAP_TOOLS.includes(name))) return {};
        const answer = stop.last_assistant_message ?? "";
        if (answer.trim() === "") return {};
        if (!(await check(current.question, answer))) return {};
        console.log("gap-check: the turn gave up; sending it back to close the gap");
        return { decision: "block", reason: NUDGE };
      },
    ],
  };
}
