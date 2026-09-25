/**
 * The pipeline a small fix runs through, and the state the owner can ask about.
 *
 * The shape of this module follows one constraint: a spoken turn lasts seconds
 * and this takes minutes. So nothing here is awaited by a tool call. Starting an
 * attempt writes a row, kicks off a background pipeline and returns at once;
 * everything after that is read back out of the row, which is also why the row
 * outlives the conversation, the agent process and the restart at the end.
 *
 * The pipeline is deliberately linear and gives up early. Worker writes code ->
 * what it actually touched is checked against the guard -> the suite must pass,
 * with exactly one chance to fix itself -> commit, push, pull request. Any step
 * that fails discards the worktree and leaves a row saying why, because the
 * failure mode worth avoiding is a half-finished branch nobody remembers.
 *
 * Both endings are carried out of here the same way, and that is deliberate. A
 * pull request used to be the only thing worth a message, which made a failure
 * indistinguishable from an attempt still running: fifteen minutes of nothing,
 * and then nothing. So an attempt that produces no pull request says so out
 * loud and in writing the moment it gives up, and the output that ended it is
 * written onto the row instead of being thrown away with the worktree.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Delegate } from "@jarvis/shared";
import { NO_DELEGATE } from "@jarvis/shared";

import type { Config } from "../config.js";
import { notify, type Channel } from "../notify.js";

import { lastDeploy, requestDeploy } from "./deploy.js";
import {
  budgetVerdict,
  branchName,
  classify,
  escalation,
  WORKER_TIMEOUT_MS,
  type TaskShape,
  type Verdict,
} from "./guard.js";
import {
  deleteBranch,
  getPullRequest,
  mergePullRequest,
  openPullRequest,
  type GitHubConfig,
} from "./github.js";
import { failureMessage, reviewMessage, spokenFailure } from "./notify.js";
import {
  awaitingDevTask,
  createDevTask,
  delegatedDevTasks,
  devTask,
  gapAttempts,
  gapsToday,
  lastFailedDevTask,
  latestDevTasks,
  runningDevTask,
  smallFixesToday,
  updateDevTask,
  type DevTask,
} from "./store.js";
import { DevWorker } from "./worker.js";
import {
  canPushBranches,
  changedFiles,
  commitAll,
  createWorktree,
  diffStat,
  discardWorktree,
  pushBranch,
  runSuite,
} from "./worktree.js";

/** The suite gets one chance to be fixed before the attempt is written off. */
const SUITE_RETRIES = 1;

function githubConfig(config: Config): GitHubConfig {
  return { repo: config.devGitHubRepo, token: config.devGitHubToken };
}

/** A one-line title for the branch's commit and its pull request. */
export function titleFor(instruction: string): string {
  const single = instruction.replace(/\s+/g, " ").trim();
  return single.length <= 68 ? single : `${single.slice(0, 65).trimEnd()}...`;
}

export class SelfDevelopment {
  #worker: DevWorker | null = null;
  /**
   * Somewhere to hand a job that is too big, set once the packs have loaded.
   *
   * It starts as `NO_DELEGATE` rather than null because "too big and nowhere to
   * send it" is a real outcome that has to be handled anyway: the verdict is
   * written down and said out loud, which is what a capability gap already
   * does.
   */
  #delegate: Delegate = NO_DELEGATE;

  constructor(
    private readonly config: Config,
    private readonly db: DatabaseSync,
    /** Where an unprompted message goes. Spoken only, unless a house carries it. */
    private readonly channels: readonly Channel[] = [],
  ) {}

  /** Hands this machinery somewhere to send the big half. */
  useDelegate(delegate: Delegate): void {
    this.#delegate = delegate;
  }

  /** The slots a delegated job can land in, for the tools' descriptions. */
  get delegationSlots(): readonly number[] {
    return this.#delegate.slots;
  }

  /**
   * Whether the machinery has everything it needs to open a pull request.
   *
   * Both halves, because they are configured separately: pushing a branch uses
   * the deploy key already on the machine, and opening a pull request needs a
   * user token and somewhere to open it against.
   */
  get canOpenPullRequests(): boolean {
    return this.config.devGitHubToken !== "" && this.config.devGitHubRepo !== "";
  }

  get canDelegate(): boolean {
    return this.#delegate.available;
  }

  /** Small or big, and whether there is room to start it at all. */
  judge(shape: TaskShape, now: Date): Verdict {
    const size = classify(shape);
    if (size.size === "big") return size;
    return budgetVerdict(smallFixesToday(this.db, now), runningDevTask(this.db) !== null);
  }

  running(): DevTask | null {
    return runningDevTask(this.db);
  }

  awaiting(): DevTask | null {
    return awaitingDevTask(this.db);
  }

  /** The last attempt that came to nothing, with whatever ended it. */
  lastFailure(): DevTask | null {
    return lastFailedDevTask(this.db);
  }

  task(id: number): DevTask | null {
    return devTask(this.db, id);
  }

  /**
   * Starts a small fix and returns immediately.
   *
   * The row is written before the pipeline is kicked off, so a crash one second
   * later still leaves evidence that something was attempted.
   */
  startSmall(instruction: string, now: Date, gap: string | null = null): { id: number } {
    const id = createDevTask(
      this.db,
      { instruction, size: "small", state: "running", detail: "writing it", gap },
      now,
    );
    void this.#pipeline(id, instruction).catch((error: unknown) => {
      console.error("self-development pipeline crashed:", error);
      const detail = `the attempt got stuck: ${String(error)}`;
      updateDevTask(this.db, id, { state: "failed", detail }, new Date());
      void this.#reportFailure({ instruction, detail, state: "failed", log: null });
    });
    return { id };
  }

  /**
   * Says an attempt came to nothing, and sends the same thing to Telegram.
   *
   * Spoken first, because the point is that he hears it while it is still news;
   * the chat message is what he reads afterwards and is the only copy that keeps
   * the output. Neither is allowed to throw: a fix that failed must not fail
   * again on the way to reporting that it failed.
   */
  async #reportFailure(failure: {
    instruction: string;
    detail: string;
    state: DevTask["state"];
    log: string | null;
  }): Promise<void> {
    try {
      await notify(this.channels, {
        spoken: spokenFailure(failure),
        written: failureMessage({ ...failure, abandoned: failure.state === "abandoned" }),
      });
    } catch (error: unknown) {
      console.error("could not report a failed fix:", error);
    }
  }

  /** Hands the job to whatever the delegate is, and records where it went. */
  async delegateBig(
    instruction: string,
    reason: string,
    now: Date,
    gap: string | null = null,
  ): Promise<{ ok: true; slot: number; id: number } | { ok: false; error: string }> {
    const handed = await this.#delegate.send({ instruction, reason });
    if (!handed.ok) return handed;

    const id = createDevTask(
      this.db,
      { instruction, size: "big", state: "delegated", detail: reason, gap },
      now,
    );
    updateDevTask(this.db, id, { slot: handed.slot }, now);
    return { ok: true, slot: handed.slot, id };
  }

  /** What a delegated runner is showing right now. */
  async runnerOutput(slot: number, lines: number) {
    return this.#delegate.tail(slot, lines);
  }

  /** Types a message into a delegated runner, when the delegate can reach back. */
  async replyToRunner(slot: number, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.#delegate.reply === undefined) {
      return { ok: false, error: "This delegate cannot pass a message to a runner once it has started." };
    }
    return this.#delegate.reply(slot, text);
  }

  /** Delegated jobs whose runner finished in the last day, newest first. */
  recentlyFinished(now: Date): DevTask[] {
    const since = now.getTime() - 24 * 3_600_000;
    return latestDevTasks(this.db, 20).filter(
      (task) => task.state === "finished" && Date.parse(task.updatedAt) >= since,
    );
  }

  /** Jobs that are with a runner right now. */
  delegated(): DevTask[] {
    return delegatedDevTasks(this.db);
  }

  /** Every attempt at one gap this week, for the brakes on unasked work. */
  gapAttempts(gap: string, now: Date): DevTask[] {
    return gapAttempts(this.db, gap, now);
  }

  gapsToday(now: Date): number {
    return gapsToday(this.db, now);
  }

  /**
   * Passes an extra instruction to the worker that is running.
   *
   * This is the part that makes the thing feel like a runner rather than a
   * button: "nee, doe het in het paneel in plaats van hardop" reaches the same
   * session that just wrote the code, mid-attempt.
   */
  async steer(text: string): Promise<string | null> {
    const worker = this.#worker;
    if (worker === null) return null;
    return worker.ask(text);
  }

  /**
   * Merges the waiting pull request and asks to be restarted on it.
   *
   * Refuses on anything it did not open itself, on a pull request GitHub says is
   * not clean, and on a task that is not in `awaiting` -- three ways of saying
   * that the only thing a spoken yes can do is land a change that already
   * passed everything else.
   */
  async approve(now: Date): Promise<{ ok: true; sha: string; task: DevTask } | { ok: false; error: string }> {
    const task = awaitingDevTask(this.db);
    if (task === null) return { ok: false, error: "No fix is waiting for approval." };
    if (task.prNumber === null) return { ok: false, error: "That fix has no pull request." };
    if (!this.canOpenPullRequests) return { ok: false, error: "I have no GitHub token." };

    const github = githubConfig(this.config);
    const current = await getPullRequest(github, task.prNumber);
    if (!current.ok) return { ok: false, error: current.error };
    if (current.value.state === "closed" && !current.value.merged) {
      updateDevTask(this.db, task.id, { state: "abandoned", detail: "the pull request was closed" }, now);
      return { ok: false, error: "That pull request was closed." };
    }

    const merged = await mergePullRequest(github, task.prNumber, titleFor(task.instruction));
    if (!merged.ok) return { ok: false, error: merged.error };
    if (task.branch !== null) await deleteBranch(github, task.branch);

    const asked = await requestDeploy(this.config.dataDir, merged.value);
    if (!asked.ok) {
      updateDevTask(this.db, task.id, { state: "merged", detail: asked.error }, now);
      return { ok: false, error: `Merged, but ${asked.error}` };
    }

    updateDevTask(this.db, task.id, { state: "merged", detail: `merged as ${merged.value.slice(0, 7)}` }, now);
    return { ok: true, sha: merged.value, task };
  }

  /** How the last requested deploy ended, once the root side has written it down. */
  async lastDeployResult() {
    return lastDeploy(this.config.dataDir);
  }

  async #pipeline(id: number, instruction: string): Promise<void> {
    const now = () => new Date();
    const repo = this.config.devRepo;
    const branch = branchName(instruction, now());

    const allowed = await canPushBranches(repo);
    if (!allowed.ok) {
      const detail =
        "I may not push to origin, so no pull request can come of this -- " +
        "point origin at a copy of this repository that is yours";
      updateDevTask(this.db, id, { state: "failed", detail, log: allowed.error }, now());
      await this.#reportFailure({ instruction, detail, state: "failed", log: allowed.error });
      return;
    }

    const made = await createWorktree(repo, this.config.devWorktrees, branch);
    if ("error" in made) {
      // Reported like any other ending. This one happens before there is a
      // worktree to clean up, so it returns rather than going through `finish`
      // -- which is exactly how it stayed silent: the row said "failed" and
      // nobody was told.
      // The sentence and the output go to their own fields, as everywhere else:
      // git's complaint is several lines long and reading it out loud is no use
      // to anyone, but it is the whole of what makes this fixable.
      const detail = "I could not create a worktree to work in";
      updateDevTask(this.db, id, { state: "failed", detail, log: made.error }, now());
      await this.#reportFailure({ instruction, detail, state: "failed", log: made.error });
      return;
    }
    const { path } = made.worktree;
    updateDevTask(this.db, id, { branch, worktree: path, detail: "writing it" }, now());

    const worker = new DevWorker({ cwd: path, timeoutMs: WORKER_TIMEOUT_MS });
    this.#worker = worker;

    const finish = async (
      state: DevTask["state"],
      detail: string,
      options: { keepBranch?: boolean; log?: string } = {},
    ) => {
      worker.close();
      this.#worker = null;
      if (options.keepBranch !== true) await discardWorktree(repo, path, branch);
      const log = options.log ?? null;
      updateDevTask(this.db, id, { state, detail, log }, now());
      if (state === "failed" || state === "abandoned") {
        await this.#reportFailure({ instruction, detail, state, log });
      }
    };

    const summary = await worker.ask(instruction);
    if (summary === null) {
      await finish(
        "failed",
        worker.timedOut ? "I had not worked it out after a quarter of an hour" : "the attempt broke off",
      );
      return;
    }

    const touched = await changedFiles(path);
    const blocked = escalation(touched);
    if (blocked !== null) {
      await finish("abandoned", blocked);
      return;
    }

    updateDevTask(this.db, id, { detail: "running the tests" }, now());
    let suite = await runSuite(path);
    for (let attempt = 0; attempt < SUITE_RETRIES && !suite.ok; attempt += 1) {
      updateDevTask(this.db, id, { detail: "the tests failed, trying to repair it" }, now());
      const retried = await worker.ask(
        `The test suite failed. Repair this; do not change what a test checks unless the test itself is wrong.\n\n${suite.detail}`,
      );
      if (retried === null) break;
      const again = escalation(await changedFiles(path));
      if (again !== null) {
        await finish("abandoned", again);
        return;
      }
      suite = await runSuite(path);
    }
    if (!suite.ok) {
      await finish("failed", "the tests stayed red, so nothing is ready", {
        log: suite.detail,
      });
      return;
    }

    const committed = await commitAll(path, titleFor(instruction), summary);
    if (!committed.ok) {
      await finish("failed", `committing failed: ${committed.error}`);
      return;
    }
    const stat = await diffStat(path);

    const pushed = await pushBranch(path, branch);
    if (!pushed.ok) {
      await finish("failed", `pushing failed: ${pushed.error}`);
      return;
    }

    if (!this.canOpenPullRequests) {
      await finish(
        "awaiting",
        `the branch ${branch} is on GitHub, but I have no token to open a pull request for it`,
        { keepBranch: true },
      );
      return;
    }

    const pr = await openPullRequest(githubConfig(this.config), {
      title: titleFor(instruction),
      branch,
      body: [
        `Asked: ${instruction}`,
        "",
        summary,
        "",
        "Opened by JARVIS. The acceptance suite and the type check were green before this",
        "pull request existed; nothing here has been merged without a spoken yes.",
      ].join("\n"),
    });
    if (!pr.ok) {
      await finish("failed", `pull request openen mislukte: ${pr.error}`, { keepBranch: true });
      return;
    }

    worker.close();
    this.#worker = null;
    await discardWorktree(repo, path, null);
    updateDevTask(
      this.db,
      id,
      { state: "awaiting", prUrl: pr.value.url, prNumber: pr.value.number, detail: stat },
      now(),
    );

    // Written only: a pull request waiting to be reviewed is read when there is
    // time for it, and saying it out loud would interrupt about something that
    // can wait. A fix that fell over is the other case, and does speak.
    await notify(this.channels, {
      written: reviewMessage({ instruction, prUrl: pr.value.url, summary, stat }),
    });
  }
}
