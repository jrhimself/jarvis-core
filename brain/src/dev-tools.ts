/**
 * Asking JARVIS to build something, and letting him build it.
 *
 * This is the tool surface for the thing that was asked for in so many words: to be
 * able to say "I want you to be able to do X" the way he would say it to a runner,
 * and have it happen -- and, when something turns out to be beyond him, to have him
 * go and fix that rather than only report it.
 *
 * The route is not the model's to pick. `propose_dev_task` and `close_gap` take a
 * description of the *shape* of the job -- which repository, which files, does it
 * need a package, a secret, another machine -- and `dev/guard.ts` decides from that
 * whether it is a small fix JARVIS does himself or a big one that goes to a runner
 * elsewhere. A model that is asked "is this small?" answers with the answer that
 * gets the work started; a model asked "does this need a new dependency?" has to lie
 * about the world instead, and the diff is checked against the same rules afterwards
 * either way.
 *
 * Two doors, with different locks. Something the owner asks for takes two turns,
 * like `ha-control.ts`: one tool call to register the intent, a spoken question,
 * and a later turn to carry it out. Something JARVIS finds he cannot do takes one:
 * `close_gap` starts the work at once, because an assistant that stops to ask
 * permission for every missing ability is an assistant that reports gaps instead of
 * closing them. What keeps that door safe is what it cannot reach -- nothing it
 * starts is merged or deployed without the owner's yes -- and the brakes in
 * `dev/store.ts`: one attempt per gap at a time, two per week, a handful a day.
 *
 * Merging is the one that matters most, and it keeps both turns: merging means
 * JARVIS restarts on code he wrote himself.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Config } from "./config.js";
import { DAILY_LIMIT, MAX_FILES, slugify } from "./dev/guard.js";
import { SelfDevelopment } from "./dev/run.js";
import { DAILY_GAPS, GAP_ATTEMPTS, type DevTask } from "./dev/store.js";

/** What was proposed, so a later turn can carry out that and nothing else. */
export interface PendingDevAction {
  kind: "task" | "merge";
  /** The instruction for a task; the pull request number for a merge. */
  key: string;
  /**
   * The route the guard chose when the job was proposed.
   *
   * Carried rather than recomputed. The shape of a job is described once, by the
   * turn that asked the user about it; deciding again at execution time would mean
   * asking the model a second time and letting the second answer win, which is
   * exactly the loophole the guard exists to close.
   */
  route?: { size: "small" } | { size: "big"; reason: string };
  askedInTurn: string;
}

export interface DevContext {
  turnId: string;
  pending: PendingDevAction | null;
  setPending: (action: PendingDevAction | null) => void;
}

export const DEV_SERVER_NAME = "selfdev";
export const DEV_TOOLS = [`mcp__${DEV_SERVER_NAME}__*`];

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function refused(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** One task as short facts, for the model to speak from. */
export function describeTask(task: DevTask): string {
  const head = `"${task.instruction}"`;
  switch (task.state) {
    case "running":
      return `${head}: working on it now -- ${task.detail}.`;
    case "awaiting":
      return task.prUrl === null
        ? `${head}: done, but without a pull request -- ${task.detail}.`
        : `${head}: done and green, waiting for your approval. ${task.prUrl}`;
    case "merged":
      return `${head}: ${task.detail}.`;
    case "abandoned":
      return `${head}: dropped, ${task.detail}.`;
    case "delegated":
      return `${head}: handed to runner ${task.slot ?? "?"}, because ${task.detail}.`;
    case "finished":
      return `${head}: runner ${task.slot ?? "?"} finished it -- ${task.detail}.`;
    default:
      return `${head}: failed, ${task.detail}.`;
  }
}

/**
 * The job a missing ability becomes.
 *
 * The ability first and the request second, and said in so many words, because
 * the first gap handed to a runner came back as an answer: it looked up what was
 * asked, reported it, and left JARVIS exactly as unable as before. An answer is
 * welcome on the way; the ability is the job.
 */
export function abilityInstruction(ability: string, request: string, runner: boolean): string {
  return [
    `Give JARVIS the ability to ${ability.replace(/^to\s+/i, "")}, so that he does it himself from now on.`,
    `What made this come up: ${request}`,
    "Build the general ability, not an answer to this one request: a tool in JARVIS' own code, or " +
      "in a pack, that the next request of this kind reaches without anyone's help.",
    ...(runner
      ? [
          "If you can answer the request while you build it, put the answer in your DONE line too, " +
            "after what you built, so it reaches the user now.",
        ]
      : []),
  ].join("\n");
}

/**
 * Whether a gap may be worked on now, and if not, what to say instead.
 *
 * Pure, so the brakes can be tested without a database: `recent` is every
 * attempt at this gap in the last week, `today` the number of gaps started
 * today. The order is the order the reasons matter in -- an attempt that is
 * still running is the answer to "why not again", whatever the counts say.
 */
export function gapBrake(recent: readonly DevTask[], today: number): string | null {
  const open = recent.find((task) => ["running", "awaiting", "delegated"].includes(task.state));
  if (open !== undefined) {
    return `This gap is already being worked on: ${describeTask(open)} Say so, and do not start it again.`;
  }
  if (recent.length >= GAP_ATTEMPTS) {
    return (
      `This gap was tried ${recent.length} times this week and is still open. Do not try again: ` +
      "tell the user what you cannot do, what was tried, and ask how he wants it solved."
    );
  }
  if (today >= DAILY_GAPS) {
    return (
      `${today} gaps were started today, which is the most in one day. Say what you cannot do ` +
      "yet and that you will not start more work on it today; ask whether it should wait until tomorrow."
    );
  }
  return null;
}

export function createDevServer(
  config: Config,
  dev: SelfDevelopment,
  context: () => DevContext,
) {
  const propose = tool(
    "propose_dev_task",
    "Register a piece of work the user asked for, before asking him about it: a " +
      "feature, an automation, a change to how you behave. For something you ran into " +
      "yourself -- an ability you turned out not to have, a fact you could not find -- " +
      "use close_gap instead, which does not wait for a yes. Describe the shape of the " +
      "job honestly -- the answer decides whether you do it yourself or hand it to a " +
      "runner, and it is checked against the real diff afterwards. An investigation has " +
      "no file list yet, which routes it to a runner; that is the honest answer, not a " +
      "guess dressed up as one. Call this, then say out loud in one sentence what you " +
      "understood and which route it takes, and stop. Carry it out with start_dev_task " +
      "once the user has said yes.",
    {
      instruction: z.string().min(1)
        .describe("The job, in the user's own words, as literally as you can keep it"),
      repo: z.enum(["jarvis", "other"])
        .describe("'jarvis' only when the change lives in this assistant's own source"),
      files: z.array(z.string()).default([])
        .describe(
          "Repo-relative paths you expect to change, as far as you can tell; empty for an " +
            "investigation, which changes nothing until it has found something",
        ),
      needsNewDependency: z.boolean().default(false)
        .describe("True when a package that is not installed would be needed"),
      needsNewSecret: z.boolean().default(false)
        .describe("True when a new token, key or account would be needed"),
      needsOutsideWork: z.boolean().default(false)
        .describe("True when hardware, another machine or another service is involved"),
    },
    async (args) => {
      const { turnId, setPending } = context();
      const verdict = dev.judge(
        {
          repo: args.repo,
          files: args.files,
          needsNewDependency: args.needsNewDependency,
          needsNewSecret: args.needsNewSecret,
          needsOutsideWork: args.needsOutsideWork,
        },
        new Date(),
      );
      setPending({ kind: "task", key: args.instruction, route: verdict, askedInTurn: turnId });

      if (verdict.size === "small") {
        return ok(
          "A small fix: you do it yourself. Say out loud what you will build and that it " +
            "becomes a pull request he sees first, ask whether you may start, and stop there.",
        );
      }
      if (!dev.canDelegate) {
        return ok(
          `Too big to do here (${verdict.reason}) and there is no runner to hand it to. ` +
            "Say so, and ask whether you should note it down.",
        );
      }
      return ok(
        `A big job, because ${verdict.reason}. Say out loud that you will not do it here and ` +
          "why, that you will hand it to a runner, ask whether that is all right, and stop there.",
      );
    },
    { annotations: { readOnlyHint: false, idempotentHint: true } },
  );

  const start = tool(
    "start_dev_task",
    "Carry out the work registered with propose_dev_task, on the route the guard " +
      "chose: a small fix runs here and ends in a pull request, a big one is handed " +
      "to a runner elsewhere. Needs a spoken yes from an earlier turn. This takes " +
      "minutes -- say that you have started and that you will come back to it, then " +
      "stop; do not wait for it inside this turn.",
    {
      instruction: z.string().min(1).describe("Must match what was passed to propose_dev_task"),
      confirmed: z.boolean().default(false)
        .describe("True only after the user answered yes to a question you asked in an earlier turn"),
    },
    async (args) => {
      const { turnId, pending, setPending } = context();
      const matches =
        pending !== null &&
        pending.kind === "task" &&
        pending.key.trim() === args.instruction.trim();
      if (!matches || pending?.askedInTurn === turnId) {
        return refused(
          "This has to be proposed first. Call propose_dev_task, ask out loud, and try " +
            "again once he has answered in a later turn.",
        );
      }
      if (!args.confirmed) return refused("He has not confirmed anything yet. Ask, then set confirmed to true.");
      setPending(null);

      const now = new Date();
      const route = pending.route ?? { size: "big" as const, reason: "I no longer know how big this was" };
      if (route.size === "big") {
        const handed = await dev.delegateBig(args.instruction, route.reason, now);
        return handed.ok
          ? ok(`Runner ${handed.slot} has it, because ${route.reason}.`)
          : refused(handed.error);
      }

      const started = dev.startSmall(args.instruction, now);
      return ok(
        `Started (task ${started.id}). Say that you are working on it and that you will ` +
          "report back once a pull request is ready. Ask dev_status later for where it stands; invent nothing.",
      );
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  );

  const gap = tool(
    "close_gap",
    "Give yourself an ability you just found you lack, without asking first: something the " +
      "user asked that you cannot do, or cannot know, with anything you have. Try your other " +
      "tools first -- this is for when none of them gets there. It always builds: the point is " +
      "that the next request of this kind is answered by you, not by somebody working for you. " +
      "Name the general ability behind the request, not the request itself: 'look up current " +
      "local news and road works', not 'what is happening on my street'. A small fix is written " +
      "here and becomes a pull request; anything bigger goes to a runner on another machine, " +
      "which builds the ability and, when it can, answers this request along the way. Nothing " +
      "is merged or deployed without the user's yes. After the call, say in one sentence what " +
      "you cannot do yet and that you are learning it, and move on; do not wait for it inside " +
      "this turn. When it refuses, say why and stop -- never try the same thing again in other words.",
    {
      ability: z.string().min(1)
        .describe("The general ability that is missing, short and stable, e.g. 'read the clock' or 'search the web for current news'"),
      request: z.string().min(1)
        .describe("What the user asked, in his own words, and what exactly you could not do or know"),
      repo: z.enum(["jarvis", "other"]).default("jarvis")
        .describe("'jarvis' only when the ability can live in this assistant's own source"),
      files: z.array(z.string()).default([])
        .describe("Repo-relative paths you expect to change; empty when you cannot tell"),
      needsNewDependency: z.boolean().default(false),
      needsNewSecret: z.boolean().default(false),
      needsOutsideWork: z.boolean().default(false)
        .describe("True when hardware, another machine or another service is involved"),
    },
    async (args) => {
      const now = new Date();
      const key = slugify(args.ability);
      const brake = gapBrake(dev.gapAttempts(key, now), dev.gapsToday(now));
      if (brake !== null) return refused(brake);

      const verdict = dev.judge(
        {
          repo: args.repo,
          files: args.files,
          needsNewDependency: args.needsNewDependency,
          needsNewSecret: args.needsNewSecret,
          needsOutsideWork: args.needsOutsideWork,
        },
        now,
      );
      if (verdict.size === "small") {
        const started = dev.startSmall(abilityInstruction(args.ability, args.request, false), now, key);
        return ok(
          `Started (task ${started.id}): the ability is written here and becomes a pull request ` +
            "the user approves. Say what you cannot do yet and that you are learning it.",
        );
      }
      if (!dev.canDelegate) {
        return refused(
          `Learning this needs more than a small fix (${verdict.reason}) and there is no runner to hand it to. ` +
            "Say what you cannot do and what it would take.",
        );
      }
      const handed = await dev.delegateBig(abilityInstruction(args.ability, args.request, true), verdict.reason, now, key);
      return handed.ok
        ? ok(
            `Runner ${handed.slot} is building the ability, because ${verdict.reason}. You answer ` +
              "its questions; the user hears when it is done, and gets the answer to this request " +
              "then if the runner found it. Say what you cannot do yet and that you are learning it.",
          )
        : refused(handed.error);
    },
    { annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  );

  const status = tool(
    "dev_status",
    "Where JARVIS' own building work stands: what is running, what is waiting for " +
      "the user's yes, what runners are doing, how the last attempt failed and what the " +
      "output said, how the last deploy ended. The only acceptable source for claims like " +
      "'that fix is ready' or 'the tests failed on this' -- never say either from memory.",
    {},
    async () => {
      const lines: string[] = [];
      const running = dev.running();
      const waiting = dev.awaiting();
      const handed = dev.delegated();

      if (running !== null) lines.push(describeTask(running));
      if (waiting !== null) lines.push(describeTask(waiting));
      for (const task of handed) lines.push(describeTask(task));
      // What a runner found out or built comes back here as well as to the chat,
      // so "what did it find" has an answer in conversation.
      for (const task of dev.recentlyFinished(new Date())) lines.push(describeTask(task));
      if (running === null && waiting === null && handed.length === 0) {
        lines.push("Nothing is being built, and nothing is waiting for approval.");
      }

      // The failure and its output, so "why did that go wrong" is answered from
      // what actually happened rather than from what the attempt was about.
      const failed = dev.lastFailure();
      if (failed !== null && failed.id !== running?.id && failed.id !== waiting?.id) {
        lines.push(`Last failure -- ${describeTask(failed)}`);
        if (failed.log !== null && failed.log.trim() !== "") {
          lines.push("The last lines of that run:", failed.log);
        }
      }
      if (!dev.canOpenPullRequests) {
        lines.push("Note: there is no GitHub token, so a branch can be pushed but no pull request opened.");
      }

      const deployed = await dev.lastDeployResult();
      if (deployed !== null) {
        lines.push(
          deployed.ok
            ? `Last deploy: ${deployed.sha.slice(0, 7)}, running since ${deployed.at}.`
            : `Last deploy failed at "${deployed.step}": ${deployed.detail}`,
        );
      }
      return ok(lines.join("\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const steer = tool(
    "dev_steer",
    "Pass an extra instruction to the fix that is being written right now -- a " +
      "correction, a preference, a change of mind. Use it when the user says something " +
      "about the work while it is running. Refused when nothing is running.",
    {
      message: z.string().min(1).describe("What to tell the worker, in the user's own words"),
    },
    async (args) => {
      const answered = await dev.steer(args.message);
      return answered === null
        ? refused("No fix is being written right now to pass this on to.")
        : ok(answered);
    },
    { annotations: { readOnlyHint: false, idempotentHint: false } },
  );

  const proposeMerge = tool(
    "propose_merge",
    "Register that you intend to merge the pull request that is waiting, before " +
      "asking the user. Merging deploys the change and restarts JARVIS on his own new " +
      "code, so say that out loud along with the link, ask whether to go ahead, and " +
      "stop. Carry it out with approve_merge in a later turn.",
    {},
    async () => {
      const waiting = dev.awaiting();
      if (waiting === null) return refused("No fix is waiting for approval.");
      if (waiting.prNumber === null) return refused("That fix has no pull request to merge.");
      const { turnId, setPending } = context();
      setPending({ kind: "merge", key: String(waiting.prNumber), askedInTurn: turnId });
      return ok(
        `Ready to merge: ${describeTask(waiting)} Ask out loud whether you may, mention that ` +
          "you restart afterwards, and stop there.",
      );
    },
    { annotations: { readOnlyHint: false, idempotentHint: true } },
  );

  const approveMerge = tool(
    "approve_merge",
    "Merge the waiting pull request and restart on it. Needs propose_merge and a " +
      "spoken yes from an earlier turn. The restart happens after the suite has run " +
      "again on the merged commit, so it is a minute or two away -- say so, and check " +
      "dev_status afterwards rather than claiming it worked.",
    {
      confirmed: z.boolean().default(false)
        .describe("True only after the user answered yes to a question you asked in an earlier turn"),
    },
    async (args) => {
      const { turnId, pending, setPending } = context();
      const waiting = dev.awaiting();
      const matches =
        pending !== null &&
        pending.kind === "merge" &&
        waiting !== null &&
        pending.key === String(waiting.prNumber);
      if (!matches || pending?.askedInTurn === turnId) {
        return refused(
          "This has to be proposed first. Call propose_merge, ask out loud, and try again " +
            "once he has answered in a later turn.",
        );
      }
      if (!args.confirmed) return refused("He has not confirmed anything yet. Ask, then set confirmed to true.");
      setPending(null);

      const merged = await dev.approve(new Date());
      return merged.ok
        ? ok(
            `Merged as ${merged.sha.slice(0, 7)}. The deploy runs the suite again and restarts ` +
              "you afterwards; check it later with dev_status.",
          )
        : refused(merged.error);
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  );

  const runner = tool(
    "runner_output",
    "Read what a delegated runner is showing right now. Use it when " +
      "the user asks how a handed-over job is going.",
    {
      slot: z.number().int().describe(`Which runner: ${dev.delegationSlots.join(" or ")}`),
      lines: z.number().int().min(10).max(200).default(60)
        .describe("How many pane lines to read back"),
    },
    async (args) => {
      const read = await dev.runnerOutput(args.slot, args.lines);
      return read.ok ? ok(read.text === "" ? "That runner shows nothing readable." : read.text) : refused(read.error);
    },
    { annotations: { readOnlyHint: true } },
  );

  const reply = tool(
    "runner_reply",
    "Type a message into a delegated runner: the user's answer to a question it asked, " +
      "or a correction he wants passed on. Runner questions you can answer yourself are " +
      "answered without this tool; use it when the user tells you what to say to one.",
    {
      slot: z.number().int().describe(`Which runner: ${dev.delegationSlots.join(" or ")}`),
      message: z.string().min(1).describe("What to tell the runner, complete enough to act on"),
    },
    async (args) => {
      const sent = await dev.replyToRunner(args.slot, args.message);
      return sent.ok ? ok(`Runner ${args.slot} has it.`) : refused(sent.error);
    },
    { annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true } },
  );

  return createSdkMcpServer({
    name: DEV_SERVER_NAME,
    version: "1.0.0",
    tools: [propose, start, gap, status, steer, proposeMerge, approveMerge, runner, reply],
  });
}

/** The limits, so the persona can be honest about them without guessing. */
export const DEV_LIMITS = { DAILY_LIMIT, MAX_FILES, DAILY_GAPS, GAP_ATTEMPTS };
