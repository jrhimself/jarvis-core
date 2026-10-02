/**
 * Asking for something to happen later.
 *
 * One tool with an action, not five: the model picks a tool by reading the
 * list, and a family of near-identical names is how it ends up removing a job
 * when it meant to pause one.
 */

import type { DatabaseSync } from "node:sqlite";

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { formatter } from "@jarvis/shared";
import { z } from "zod";

import { describeSchedule, parseSchedule, ScheduleError } from "./schedule.js";
import {
  addJob,
  getJob,
  listJobs,
  removeJob,
  runNow,
  setJobState,
  type Job,
} from "./schedule-store.js";

export const SCHEDULE_SERVER_NAME = "schedule";
export const SCHEDULE_TOOLS = [`mcp__${SCHEDULE_SERVER_NAME}__*`];

function text(value: string, isError = false) {
  return { content: [{ type: "text" as const, text: value }], ...(isError ? { isError: true } : {}) };
}

function when(iso: string | null): string {
  return iso === null ? "never" : formatter({ dateStyle: "medium", timeStyle: "short" }, "en-GB").format(new Date(iso));
}

/** One job as a few lines the model can read back to someone. */
export function renderJob(job: Job): string {
  const lines = [
    `#${job.id} "${job.name}" -- ${job.state}, ${describeSchedule(job.schedule)}`,
    `  does: ${job.prompt.length > 200 ? `${job.prompt.slice(0, 199)}…` : job.prompt}`,
  ];
  if (job.state === "active") lines.push(`  next run: ${when(job.nextRun)}`);
  if (job.lastRun !== null) {
    lines.push(`  last run: ${when(job.lastRun)} -- ${job.lastResult ?? ""}`);
  }
  return lines.join("\n");
}

export function createScheduleServer(db: DatabaseSync, options: { unattended: boolean }) {
  const schedule = tool(
    "schedule",
    "Do something later, or over and over: a reminder, a daily check, a watch on something that " +
      "changes. `create` takes a `when`, a `name` and a `prompt`; `list` shows what exists; `pause`, " +
      "`resume`, `remove` and `run` (do it now, once) take an `id`. Always `list` before touching an " +
      "id -- never guess one. " +
      "The `prompt` is run later by a fresh assistant that has none of this conversation, so it must " +
      "say everything: what to look at, what counts as worth reporting, and what to say. For a reminder " +
      "write it as the message to deliver ('Remind the owner to call the plumber'). For a watch, tell " +
      "it to reply with only SILENT when nothing changed, or every run will send a message. " +
      "`when` is one of: 'in 30m', 'in 2h' (once); 'every 2h', 'every 30m' (at least 5m); 'daily at " +
      "09:00', 'weekdays at 8:30', 'every monday at 9am'; a five-field cron expression; or a local " +
      "timestamp '2026-10-01T09:00'. Results go to the owner's phone, and are spoken as well if a " +
      "screen is open; `deliver: written` is never spoken, `deliver: digest` is written to the separate " +
      "digest bot when there is one, and `deliver: quiet` keeps them for `list` only.",
    {
      action: z.enum(["create", "list", "pause", "resume", "remove", "run"]),
      id: z.number().int().optional().describe("The job's number, from `list`"),
      name: z.string().min(2).max(60).optional().describe("Short name, for create"),
      when: z.string().optional().describe("When it runs, for create"),
      prompt: z.string().min(5).max(2000).optional().describe("Self-contained instruction, for create"),
      deliver: z.enum(["all", "written", "digest", "quiet"]).default("all").describe("Where the result goes"),
      repeat: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .describe("Stop after this many runs. Leave out to repeat until removed"),
    },
    async (args) => {
      const now = new Date();
      if (args.action === "list") {
        const jobs = listJobs(db);
        return text(jobs.length === 0 ? "There are no scheduled jobs." : jobs.map(renderJob).join("\n"));
      }

      if (options.unattended) {
        return text("A scheduled job cannot change the schedule. Do the task itself and answer.", true);
      }

      if (args.action === "create") {
        if (args.name === undefined || args.when === undefined || args.prompt === undefined) {
          return text("create needs a name, a when and a prompt.", true);
        }
        try {
          const created = addJob(
            db,
            {
              name: args.name,
              spec: args.when,
              schedule: parseSchedule(args.when, now),
              prompt: args.prompt,
              deliver: args.deliver,
              repeat: args.repeat ?? null,
            },
            now,
          );
          return text(`Scheduled.\n${renderJob(created)}`);
        } catch (error) {
          const reason = error instanceof ScheduleError || error instanceof Error ? error.message : String(error);
          return text(reason, true);
        }
      }

      if (args.id === undefined) return text(`${args.action} needs an id. Call list first.`, true);
      if (getJob(db, args.id) === null) return text(`There is no job #${args.id}. Call list.`, true);

      switch (args.action) {
        case "remove":
          removeJob(db, args.id);
          return text(`Removed job #${args.id}.`);
        case "pause":
        case "resume": {
          const changed = setJobState(db, args.id, args.action === "pause" ? "paused" : "active", now);
          return text(changed === null ? "Not found." : `Job #${args.id} is now ${changed.state}.`);
        }
        default: {
          runNow(db, args.id, now);
          return text(`Job #${args.id} will run within the minute, and its result is delivered like any other.`);
        }
      }
    },
    { annotations: { readOnlyHint: false } },
  );

  return createSdkMcpServer({ name: SCHEDULE_SERVER_NAME, version: "1.0.0", tools: [schedule] });
}
