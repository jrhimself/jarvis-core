/**
 * The answer now, while the ability to find it is being built.
 *
 * Closing a gap is slow on purpose: the ability behind the question is built,
 * tested and approved, and that takes an evening. The owner asked his question
 * today. So when the gap is a question, it is also looked up at once -- one
 * short model run that may search and read the web and nothing else: no files,
 * no shell, nothing that changes anything -- and the answer is said first.
 *
 * This is a stand-in, not the capability. It runs only as part of closing a
 * gap, so the same question asked again next week either reaches the ability
 * that was built, or goes through the brakes like any other gap.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

/** The only tools the stand-in has: reading the web, nothing that writes. */
export const STAND_IN_TOOLS = ["WebSearch", "WebFetch"];

/** Longest the stand-in may take in total, found or not. */
const STAND_IN_TIMEOUT_MS = 180_000;

const instructions = (language: string) =>
  `You find the answer to one question for a voice assistant, by searching and reading
the web. Answer in ${language}, in at most three short spoken sentences: no lists, no
markup, no links. Say where the answer comes from in a few words when it matters. If the
web does not give a reliable answer, say so in one sentence instead of guessing.`;

/**
 * Looks one question up. Resolves with the answer, or null when nothing usable
 * came back in time; never rejects.
 */
export async function lookUp(question: string, language: string, model = "sonnet"): Promise<string | null> {
  const started = Date.now();
  const run = async (): Promise<string | null> => {
    let text = "";
    for await (const message of query({
      prompt: question,
      options: {
        model,
        systemPrompt: instructions(language),
        tools: STAND_IN_TOOLS,
        allowedTools: STAND_IN_TOOLS,
        settingSources: [],
        maxTurns: 8,
      },
    })) {
      const value = message as { type?: string; subtype?: string; result?: unknown };
      if (value.type === "result" && value.subtype === "success" && typeof value.result === "string") {
        text = value.result;
      }
    }
    const answer = text.trim();
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(answer === "" ? `stand-in: nothing found in ${seconds}s` : `stand-in: answered in ${seconds}s`);
    return answer === "" ? null : answer;
  };
  try {
    return await Promise.race([
      run(),
      new Promise<null>((resolve) =>
        setTimeout(() => {
          console.log(`stand-in: gave up after ${STAND_IN_TIMEOUT_MS / 1000}s`);
          resolve(null);
        }, STAND_IN_TIMEOUT_MS).unref(),
      ),
    ]);
  } catch (error) {
    console.warn("stand-in: could not look a question up:", error);
    return null;
  }
}

/**
 * Waits for an answer as long as a turn can reasonably wait for it.
 *
 * `late` gets the answer when it comes after that, so it can be delivered
 * unprompted instead of being lost -- and gets null when nothing came of it,
 * because the turn already promised an answer and silence would break that.
 */
export async function answerFirst(
  lookup: Promise<string | null>,
  waitMs: number,
  late: (answer: string | null) => void,
): Promise<string | null> {
  let inTime = true;
  const early = await Promise.race([
    lookup,
    new Promise<null>((resolve) =>
      setTimeout(() => {
        inTime = false;
        resolve(null);
      }, waitMs).unref(),
    ),
  ]);
  if (early !== null) return early;
  if (!inTime) {
    void lookup.then((answer) => late(answer));
  }
  return null;
}
