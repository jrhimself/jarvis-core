/**
 * Asking the assistant something with nobody there.
 *
 * The scheduler's turns have no screen and no speaker, the same as a chat
 * over a phone, and they differ from one in a single respect: each is a fresh
 * conversation that is over when it has answered. A job that carried the last
 * run's morning with it would be answering a question that is no longer the
 * one it was asked.
 */

import { Conversation } from "./conversation.js";
import { RUN_TIMEOUT_MS } from "./scheduler.js";

/** Runs one framed prompt to its answer and returns the words. Throws on failure or timeout. */
export async function runUnattended(prompt: string, turnId: string, timeoutMs = RUN_TIMEOUT_MS): Promise<string> {
  let answer = "";
  let failure: string | null = null;

  const conversation = new Conversation(
    {
      onText: (_id, chunk) => {
        answer += chunk;
      },
      onActivity: () => {},
      onToolResult: () => {},
      onDisplay: () => {},
      onVoice: () => {},
      onAudio: () => {},
      onAudioDone: () => {},
      onDone: () => {},
      onError: (_id, message) => {
        failure = message;
      },
    },
    undefined,
    "off",
    "unattended",
  );

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      conversation.handleUtterance(turnId, prompt),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    conversation.close();
  }

  if (failure !== null) throw new Error(failure);
  return answer;
}
