/**
 * Asking JARVIS to build something, and letting him build it.
 *
 * This is the tool surface for the thing that was asked for in so many words: to be
 * able to say "ik wil dat je X kunt" the way he would say it to a runner, and
 * have it happen -- and, when something turns out to be beyond him, to have him
 * go and fix that rather than only report it.
 *
 * The route is not the model's to pick. `propose_dev_task` takes a description
 * of the *shape* of the job -- which repository, which files, does it need a
 * package, a secret, another machine -- and `dev/guard.ts` decides from that
 * whether it is a small fix JARVIS does himself or a big one that goes to a
 * runner elsewhere. A model that is asked "is this small?" answers with the
 * answer that gets the work started; a model asked "does this need a new
 * dependency?" has to lie about the world instead, and the diff is checked
 * against the same rules afterwards either way.
 *
 * Everything that changes something takes two turns, like `ha-control.ts`: one
 * tool call to register the intent, a spoken question, and a later turn to carry
 * it out. There are three of them here, and the last is the one that matters --
 * merging means JARVIS restarts on code he wrote himself.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { Config } from "./config.js";
import { DAILY_LIMIT, MAX_FILES } from "./dev/guard.js";
import { SelfDevelopment } from "./dev/run.js";
import type { DevTask } from "./dev/store.js";

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

/** One task as short Dutch facts, for the model to speak from. */
export function describeTask(task: DevTask): string {
  const head = `"${task.instruction}"`;
  switch (task.state) {
    case "running":
      return `${head}: daar ben ik nu mee bezig — ${task.detail}.`;
    case "awaiting":
      return task.prUrl === null
        ? `${head}: klaar, maar zonder pull request — ${task.detail}.`
        : `${head}: klaar en groen, wacht op jouw akkoord. ${task.prUrl}`;
    case "merged":
      return `${head}: ${task.detail}.`;
    case "abandoned":
      return `${head}: weggegooid, ${task.detail}.`;
    case "delegated":
      return `${head}: doorgegeven aan runner ${task.slot ?? "?"}, want ${task.detail}.`;
    default:
      return `${head}: mislukt, ${task.detail}.`;
  }
}

export function createDevServer(
  config: Config,
  dev: SelfDevelopment,
  context: () => DevContext,
) {
  const propose = tool(
    "propose_dev_task",
    "Register a piece of work before asking the user about it: a feature he asked " +
      "for, a gap you just ran into and want to close so the same request works next " +
      "time, or an investigation into why something is broken when the cause is not " +
      "visible from here — no logs, no shell, no other machine. Describe the shape of " +
      "the job honestly — the answer decides whether you do it yourself or hand it to " +
      "a runner, and it is checked against the real diff afterwards. An investigation " +
      "has no file list yet, which routes it to a runner; that is the honest answer, " +
      "not a guess dressed up as one. Call this, then say out loud in one sentence " +
      "what you understood and which route it takes, and stop. Carry it out with " +
      "start_dev_task once the user has said yes.",
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
          "Kleine fix: die doe ik zelf. Zeg hardop wat je gaat bouwen en dat je er een " +
            "pull request van maakt die hij eerst ziet, vraag of je mag beginnen, en stop daar.",
        );
      }
      if (!dev.canDelegate) {
        return ok(
          `Dat is te groot voor mij (${verdict.reason}) en ik kan geen runner starten. ` +
            "Zeg dat hardop en vraag of je het moet noteren.",
        );
      }
      return ok(
        `Grote klus, want ${verdict.reason}. Zeg hardop dat je dit niet zelf doet en waarom, ` +
          "dat je het doorgeeft aan een runner, vraag of dat goed is, en stop daar.",
      );
    },
    { annotations: { readOnlyHint: false, idempotentHint: true } },
  );

  const start = tool(
    "start_dev_task",
    "Carry out the work registered with propose_dev_task, on the route the guard " +
      "chose: a small fix runs here and ends in a pull request, a big one is handed " +
      "to a runner elsewhere. Needs a spoken yes from an earlier turn. This takes " +
      "minutes — say that you have started and that you will come back to it, then " +
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
          "Dit moet eerst voorgesteld worden. Roep propose_dev_task aan, vraag het hardop, " +
            "en probeer het opnieuw zodra hij in een latere beurt geantwoord heeft.",
        );
      }
      if (!args.confirmed) return refused("Hij heeft nog niets bevestigd. Vraag het, en zet dan confirmed op true.");
      setPending(null);

      const now = new Date();
      const route = pending.route ?? { size: "big" as const, reason: "ik weet niet meer hoe groot dit was" };
      if (route.size === "big") {
        const handed = await dev.delegateBig(args.instruction, route.reason, now);
        return handed.ok
          ? ok(`Runner ${handed.slot} pakt het op, want ${route.reason}.`)
          : refused(handed.error);
      }

      const started = dev.startSmall(args.instruction, now);
      return ok(
        `Begonnen (taak ${started.id}). Zeg dat je eraan werkt en dat je je meldt zodra er ` +
          "een pull request klaarstaat. Vraag later dev_status voor de stand; verzin niets.",
      );
    },
    { annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  );

  const status = tool(
    "dev_status",
    "Where JARVIS' own building work stands: what is running, what is waiting for " +
      "the user's yes, how the last attempt failed and what the output said, how the last " +
      "deploy ended. The only acceptable source for claims like 'die fix staat klaar' " +
      "or 'de tests faalden hierop' — never say either from memory.",
    {},
    async () => {
      const lines: string[] = [];
      const running = dev.running();
      const waiting = dev.awaiting();

      if (running !== null) lines.push(describeTask(running));
      if (waiting !== null) lines.push(describeTask(waiting));
      if (running === null && waiting === null) {
        lines.push("Ik ben nergens mee bezig en er wacht niets op akkoord.");
      }

      // The failure and its output, so "waarom ging dat mis" is answered from
      // what actually happened rather than from what the attempt was about.
      const failed = dev.lastFailure();
      if (failed !== null && failed.id !== running?.id && failed.id !== waiting?.id) {
        lines.push(`Laatste mislukking — ${describeTask(failed)}`);
        if (failed.log !== null && failed.log.trim() !== "") {
          lines.push("De laatste regels van die run:", failed.log);
        }
      }
      if (!dev.canOpenPullRequests) {
        lines.push("Let op: ik heb geen GitHub-token, dus ik kan wel pushen maar geen pull request openen.");
      }

      const deployed = await dev.lastDeployResult();
      if (deployed !== null) {
        lines.push(
          deployed.ok
            ? `Laatste deploy: ${deployed.sha.slice(0, 7)} draait sinds ${deployed.at}.`
            : `Laatste deploy mislukte bij "${deployed.step}": ${deployed.detail}`,
        );
      }
      return ok(lines.join("\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const steer = tool(
    "dev_steer",
    "Pass an extra instruction to the fix that is being written right now — a " +
      "correction, a preference, a change of mind. Use it when the user says something " +
      "about the work while it is running. Refused when nothing is running.",
    {
      message: z.string().min(1).describe("What to tell the worker, in the user's own words"),
    },
    async (args) => {
      const answered = await dev.steer(args.message);
      return answered === null
        ? refused("Er is op dit moment geen fix bezig om iets aan door te geven.")
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
      if (waiting === null) return refused("Er wacht geen fix op akkoord.");
      if (waiting.prNumber === null) return refused("Die fix heeft geen pull request om te mergen.");
      const { turnId, setPending } = context();
      setPending({ kind: "merge", key: String(waiting.prNumber), askedInTurn: turnId });
      return ok(
        `Klaar om te mergen: ${describeTask(waiting)} Vraag hardop of het mag, noem dat je ` +
          "daarna herstart, en stop daar.",
      );
    },
    { annotations: { readOnlyHint: false, idempotentHint: true } },
  );

  const approveMerge = tool(
    "approve_merge",
    "Merge the waiting pull request and restart on it. Needs propose_merge and a " +
      "spoken yes from an earlier turn. The restart happens after the suite has run " +
      "again on the merged commit, so it is a minute or two away — say so, and check " +
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
          "Dit moet eerst voorgesteld worden. Roep propose_merge aan, vraag het hardop, en " +
            "probeer het opnieuw zodra hij in een latere beurt geantwoord heeft.",
        );
      }
      if (!args.confirmed) return refused("Hij heeft nog niets bevestigd. Vraag het, en zet dan confirmed op true.");
      setPending(null);

      const merged = await dev.approve(new Date());
      return merged.ok
        ? ok(
            `Gemerged als ${merged.sha.slice(0, 7)}. De deploy draait de suite opnieuw en ` +
              "herstart me daarna; controleer het later met dev_status.",
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
      return read.ok ? ok(read.text === "" ? "Die runner toont niets leesbaars." : read.text) : refused(read.error);
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: DEV_SERVER_NAME,
    version: "1.0.0",
    tools: [propose, start, status, steer, proposeMerge, approveMerge, runner],
  });
}

/** The limits, so the persona can be honest about them without guessing. */
export const DEV_LIMITS = { DAILY_LIMIT, MAX_FILES };
