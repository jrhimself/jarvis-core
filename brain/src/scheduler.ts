/**
 * Running the jobs when they come due.
 *
 * A job is a question put to the assistant later, by nobody, so the answer has
 * nowhere to go but a message. Two things follow. The prompt is framed so the
 * model knows that: no one is waiting, it should not ask questions, and it has
 * a way to say there is nothing worth reporting. And a job that says nothing
 * is a success, because a monitor that pings every hour to say all is well is
 * one that gets muted.
 */

import type { DatabaseSync } from "node:sqlite";

import { dueJobs, finishRun, MAX_FAILURES, type Job } from "./schedule-store.js";

/** What a job answers when there is nothing to tell. */
export const SILENT = "SILENT";

/** How often the clock is looked at. Jobs are minutes apart at the closest. */
const TICK_MS = 30_000;

/** Longest a single job may run before it is given up on. */
export const RUN_TIMEOUT_MS = 5 * 60_000;

export interface SchedulerDeps {
  db: DatabaseSync;
  /** Puts the framed prompt to a fresh assistant and returns what it said. */
  run(prompt: string, job: Job): Promise<string>;
  /** Sends a result, or a failure notice, to where the job says. */
  deliver(job: Job, text: string, kind: "result" | "failure"): Promise<void>;
  now?: () => Date;
}

/** What the model is told about a run it was not asked for by anyone present. */
export function framePrompt(job: Job, at: Date): string {
  return [
    `This is the scheduled job "${job.name}", running by itself at ${at.toISOString()}. Nobody is waiting on it and nobody can answer a question.`,
    "Do what it says below and reply with exactly the message the owner should read: short, complete on its own, and without preamble.",
    `If there is nothing worth telling them -- nothing changed, nothing due -- reply with only the word ${SILENT}.`,
    "Do not schedule further jobs from here.",
    "",
    job.prompt,
  ].join("\n");
}

/** Whether a reply is the job saying it has nothing to report. */
export function isSilent(reply: string): boolean {
  const text = reply.trim().replace(/[.!\s]+$/, "").replace(/^\[|\]$/g, "");
  return text.toUpperCase() === SILENT;
}

let running = false;

/** Runs everything that is due, one job at a time. Returns how many ran. */
export async function tick(deps: SchedulerDeps): Promise<number> {
  if (running) return 0;
  running = true;
  let ran = 0;
  try {
    const now = deps.now ?? (() => new Date());
    for (const due of dueJobs(deps.db, now())) {
      ran += 1;
      const started = now();
      try {
        const reply = (await deps.run(framePrompt(due, started), due)).trim();
        if (reply === "") throw new Error("the assistant produced no answer");
        const silent = isSilent(reply);
        finishRun(deps.db, due.id, { ok: true, result: silent ? "nothing to report" : reply }, now());
        if (!silent && due.deliver !== "quiet") await deps.deliver(due, reply, "result");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const after = finishRun(deps.db, due.id, { ok: false, result: `failed: ${reason}` }, now());
        const stopped = after !== null && after.failures >= MAX_FAILURES;
        console.error(`schedule: job ${due.id} (${due.name}) failed:`, reason);
        await deps
          .deliver(
            due,
            stopped
              ? `The scheduled job "${due.name}" failed ${MAX_FAILURES} times in a row and is paused. Last error: ${reason}`
              : `The scheduled job "${due.name}" failed: ${reason}`,
            "failure",
          )
          .catch((sendError: unknown) => console.error("schedule: could not report a failure:", sendError));
      }
    }
  } finally {
    running = false;
  }
  return ran;
}

/** Starts the clock. Returns the function that stops it. */
export function startScheduler(deps: SchedulerDeps, intervalMs = TICK_MS): () => void {
  const timer = setInterval(() => {
    void tick(deps).catch((error: unknown) => console.error("schedule: tick failed:", error));
  }, intervalMs);
  timer.unref();
  // Straight away as well, so what came due while the service was down runs now.
  void tick(deps).catch((error: unknown) => console.error("schedule: first tick failed:", error));
  return () => clearInterval(timer);
}
