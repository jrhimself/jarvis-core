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

import { lastDeploy, requestDeploy, requestPackDeploy } from "./deploy.js";
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
  inRepo,
  listPullRequests,
  mergePullRequest,
  openPullRequest,
  type GitHubConfig,
  type PullRequest,
} from "./github.js";
import { refreshBoard, topicOf } from "./board.js";
import { escapeHtml, failureMessage, reviewMessage, spokenFailure, spokenReady } from "./notify.js";
import { describePullRequest, matchPullRequests, pullNumber } from "./pull-requests.js";
import { forget } from "./runners.js";
import {
  currentTrial,
  describeTarget,
  pullRequestTarget,
  rememberOffer,
  repoName,
  requestTrial,
  sameTarget,
  type PullTarget,
  type Trial,
  type TrialRequest,
} from "./trial.js";
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
    updateDevTask(this.db, id, { slot: handed.slot, job: handed.job ?? null }, now);
    refreshBoard();
    return { ok: true, slot: handed.slot, id };
  }

  /**
   * Drops a job that turned out not to be wanted, and gives its runner back.
   *
   * Written after a runner spent a morning building a reader for a marketplace
   * the owner had never mentioned: JARVIS guessed where a message came from,
   * started learning to reach it, and two sentences later heard that it was
   * mail. He understood the correction and carried on -- and the job built on
   * the guess carried on too, because nothing he had could stop it.
   *
   * A job with a runner has its slot closed first; if the slot will not close
   * the row stays open, because a runner still at work on a job marked dropped
   * is worse than one on a job marked running. A job whose pull request is
   * already waiting is only marked: the pull request is the owner's to close.
   * A small fix being written here cannot be stopped halfway -- the worker
   * holds a worktree and a model session -- so that one is refused with the
   * way that does work.
   */
  async abandon(
    id: number,
    reason: string,
    now: Date,
  ): Promise<{ ok: true; task: DevTask; closed: number | null } | { ok: false; error: string }> {
    const task = devTask(this.db, id);
    if (task === null) return { ok: false, error: `There is no task ${id}.` };
    if (task.state === "running") {
      return {
        ok: false,
        error:
          "That fix is being written here right now and cannot be stopped halfway. Tell it to stop " +
          "with dev_steer, or let it finish and do not merge it.",
      };
    }
    if (task.state !== "delegated" && task.state !== "awaiting") {
      return { ok: false, error: `Task ${id} is not open any more: it is ${task.state}.` };
    }

    let closed: number | null = null;
    if (task.state === "delegated" && task.slot !== null) {
      // Only the newest job on a slot owns what runs there now.
      const newest = delegatedDevTasks(this.db).filter((other) => other.slot === task.slot).at(-1);
      if (newest?.id === task.id) {
        const result = await this.#delegate.kill(task.slot);
        if (!result.ok && !/not running|no such|not found/i.test(result.error)) {
          return { ok: false, error: `Runner ${task.slot} could not be closed: ${result.error}` };
        }
        forget(task.slot);
        if (result.ok) closed = task.slot;
      }
    }

    updateDevTask(this.db, id, { state: "abandoned", detail: `dropped: ${reason}` }, now);
    refreshBoard();
    return { ok: true, task, closed };
  }

  /**
   * The pull request a task left behind, and which repository it is in.
   *
   * A small fix records its own; a runner's is read from what it said when
   * it was done, which names the repository when it is not this one.
   */
  targetOf(task: DevTask): PullTarget | null {
    const linked = task.prUrl === null ? null : pullRequestTarget(task.prUrl);
    if (linked !== null) return linked;
    if (task.size === "small" && task.prNumber !== null) return { repo: "core", number: task.prNumber };
    return pullRequestTarget(task.detail);
  }

  /** What runs on trial now, if anything. */
  async trial(): Promise<Trial | null> {
    return currentTrial(this.config.dataDir);
  }

  /**
   * The pull request a request for a trial is about: a task's, or one named.
   *
   * A task number is the short way to say it when the record carries the pull
   * request, and it often does not -- a runner's summary is prose, and a job
   * the user did himself has no row at all. So anything that names a pull
   * request is accepted too, in whatever words it was said in, and it wins
   * over the task when both are given: it is the more specific of the two.
   */
  resolveTarget(ref: TrialRequest): { ok: true; target: PullTarget } | { ok: false; error: string } {
    const said = (ref.reference ?? "").trim();
    if (said !== "") {
      const named = pullRequestTarget(said);
      return named === null
        ? {
            ok: false,
            error:
              `Could not tell which pull request "${said}" is. Say the repository and the number, ` +
              `like "jarvis-core#24", "jarvis-pack-gmail#6" or a link to it.`,
          }
        : { ok: true, target: named };
    }
    if (ref.task === undefined) {
      return { ok: false, error: "Say which pull request to try: a task number, or the repository and number." };
    }
    const task = devTask(this.db, ref.task);
    if (task === null) return { ok: false, error: `There is no task ${ref.task}.` };
    const target = this.targetOf(task);
    return target === null
      ? {
          ok: false,
          error:
            `Task ${ref.task} does not say which pull request it made. Call it again with the pull request ` +
            `itself, like "jarvis-core#24" -- what dev_status says about the task, or what the user says, ` +
            `may name it.`,
        }
      : { ok: true, target };
  }

  /**
   * Asks the root side to put a pull request live on top of what runs.
   *
   * Refused while another one is on trial. The restart that follows ends this
   * process; the next one says how it went (`announceTrial`). A trial that
   * fails never restarts anything, so that outcome is watched for here.
   */
  async tryLive(ref: TrialRequest, now: Date): Promise<{ ok: true; target: PullTarget } | { ok: false; error: string }> {
    const found = this.resolveTarget(ref);
    if (!found.ok) return found;
    const target = found.target;
    const running = await this.trial();
    if (running !== null) {
      return {
        ok: false,
        error:
          `${describeTarget(running.target)} is on trial already. Take it off first with end_trial, ` +
          "or merge it; only one runs on trial at a time.",
      };
    }
    const asked = await requestTrial(this.config.dataDir, target);
    if (!asked.ok) return asked;
    this.#watchTrial(describeTarget(target), now);
    return { ok: true, target };
  }

  /** Asks the root side to take the trial off again. */
  async endTrial(now: Date): Promise<{ ok: true; trial: Trial } | { ok: false; error: string }> {
    const running = await this.trial();
    if (running === null) return { ok: false, error: "Nothing is on trial." };
    const asked = await requestTrial(this.config.dataDir, null);
    if (!asked.ok) return asked;
    this.#watchTrial(`taking ${describeTarget(running.target)} off`, now);
    return { ok: true, trial: running };
  }

  /**
   * Says it when a trial request failed.
   *
   * A trial that works restarts the brain, and the new process says so. One
   * that fails -- a conflict, a red suite -- leaves this process running and
   * says nothing, so it is looked for: the root side's answer, newer than the
   * request, within the time the suite can take.
   */
  #watchTrial(what: string, since: Date): void {
    const started = since.getTime() - 2000;
    const until = since.getTime() + 20 * 60_000;
    const timer = setInterval(() => {
      void (async () => {
        const result = await this.lastDeployResult();
        const at = result === null ? NaN : Date.parse(result.at);
        if (result !== null && at >= started) {
          clearInterval(timer);
          if (!result.ok) await this.tell(`${what} did not work, at "${result.step}": ${result.detail}`);
          return;
        }
        if (Date.now() > until) clearInterval(timer);
      })();
    }, 15_000);
    timer.unref();
  }

  /**
   * After a restart: says what a trial just did, once.
   *
   * Waits a little first, because the page that should hear it reconnects a
   * few seconds after the brain is back.
   */
  async announceTrial(seen: { get: () => string | null; set: (value: string) => void }): Promise<void> {
    const result = await this.lastDeployResult();
    if (result === null || !result.ok || !["trying", "untried"].includes(result.step)) return;
    if (seen.get() === result.at || Date.now() - Date.parse(result.at) > 10 * 60_000) return;
    seen.set(result.at);
    const trial = await this.trial();
    const text =
      result.step === "trying" && trial !== null
        ? `${describeTarget(trial.target)} is live now, on trial. Try it, and tell me if it should come off again.`
        : "The trial is over; the code from before it is running again.";
    setTimeout(() => void this.tell(text.charAt(0).toUpperCase() + text.slice(1)), 20_000).unref();
  }

  /** Every job that is still open: running here, waiting for a yes, or with a runner. */
  open(): DevTask[] {
    const here = [runningDevTask(this.db), awaitingDevTask(this.db)].filter(
      (task): task is DevTask => task !== null,
    );
    return [...here, ...delegatedDevTasks(this.db)];
  }

  /** What a delegated runner is showing right now. */
  async runnerOutput(slot: number, lines: number) {
    return this.#delegate.tail(slot, lines);
  }

  /** Says something unprompted, and sends it to the written channel too. Never throws. */
  async tell(text: string): Promise<void> {
    try {
      await notify(this.channels, { spoken: text, written: escapeHtml(text) });
    } catch (error: unknown) {
      console.error("could not deliver a late answer:", error);
    }
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

  /** The open pull requests on the assistant's own source, most recent first. */
  async openPullRequests(): Promise<PullRequest[]> {
    if (!this.canOpenPullRequests) return [];
    const listed = await listPullRequests(githubConfig(this.config));
    return listed.ok ? listed.value : [];
  }

  /**
   * The attempt that left a pull request behind, whichever door opened it.
   *
   * A small fix records its own number; a runner's is in what it said when it
   * was done. Either way the row is what turns a merge into an answer to "is
   * that one done".
   */
  #taskFor(target: PullTarget): DevTask | null {
    return latestDevTasks(this.db, 50).find((task) => sameTarget(this.targetOf(task), target)) ?? null;
  }

  /**
   * Which pull request a spoken reference means, and whether it can be merged.
   *
   * The reference wins when there is one, because it is the more specific of
   * the two: a link or a number is not a guess. Without one it is the fix
   * waiting for a yes, and failing that whatever is open -- one candidate is an
   * answer, several are a question. Nothing here merges anything; the point of
   * separating it is that the owner hears which pull request he is saying yes
   * to before he says it.
   */
  async chooseMerge(
    reference: string,
  ): Promise<{ ok: true; target: PullTarget; pull: PullRequest; task: DevTask | null } | { ok: false; error: string }> {
    if (!this.canOpenPullRequests) {
      return { ok: false, error: "I have no GitHub token, so I cannot merge anything." };
    }
    const github = githubConfig(this.config);
    const said = reference.trim();
    const number = said === "" ? null : pullNumber(said);
    let target: PullTarget | null =
      (said === "" ? null : pullRequestTarget(said)) ??
      (number === null ? null : { repo: "core", number });

    if (target === null) {
      const waiting = said === "" ? awaitingDevTask(this.db) : null;
      target = waiting === null ? null : this.targetOf(waiting);
    }

    if (target === null) {
      const listed = await listPullRequests(github);
      if (!listed.ok) return listed;
      const [only, ...rest] = matchPullRequests(said, listed.value);
      if (only === undefined) {
        return {
          ok: false,
          error:
            listed.value.length === 0
              ? "Nothing is open on your own code to merge."
              : `I cannot tell which pull request that is. These are open:\n${listed.value.map(describePullRequest).join("\n")}\nAsk which one he means.`,
        };
      }
      if (rest.length > 0) {
        return {
          ok: false,
          error: `That fits more than one; ask which:\n${[only, ...rest].map(describePullRequest).join("\n")}`,
        };
      }
      target = { repo: "core", number: only.number };
    }

    const got = await getPullRequest(inRepo(github, repoName(this.config.devGitHubRepo, target)), target.number);
    if (!got.ok) return got;
    const pull = got.value;
    const what = describeTarget(target);
    if (pull.merged) return { ok: false, error: `${what} is merged already.` };
    if (pull.state === "closed") return { ok: false, error: `${what} was closed without being merged.` };
    if (pull.draft) return { ok: false, error: `${what} is still a draft, so it is not finished.` };
    if (pull.mergeable_state === "dirty") {
      return {
        ok: false,
        error: `${what} conflicts with main and GitHub will not merge it. It has to be rebased first; say so.`,
      };
    }
    return { ok: true, target, pull, task: this.#taskFor(target) };
  }

  /**
   * Merges one pull request and asks to be restarted on it.
   *
   * Whichever door opened it: a fix written here, a runner's work, a pack's
   * pull request, something pushed by hand. What keeps it the owner's decision
   * is the tool that calls this, which needs his yes in an earlier turn. Core
   * and a pack take different routes across the deploy boundary -- a pack's
   * running copy is a checkout of its own repository -- and the caller is told
   * which of the two is on its way.
   */
  async merge(
    target: PullTarget,
    now: Date,
  ): Promise<{ ok: true; sha: string; deploying: "core" | "pack" } | { ok: false; error: string }> {
    if (!this.canOpenPullRequests) return { ok: false, error: "I have no GitHub token." };
    const github = inRepo(githubConfig(this.config), repoName(this.config.devGitHubRepo, target));
    const task = this.#taskFor(target);
    const what = describeTarget(target);

    const current = await getPullRequest(github, target.number);
    if (!current.ok) return current;
    if (current.value.merged) return { ok: false, error: `${what} is merged already.` };
    if (current.value.state === "closed") {
      if (task !== null) {
        updateDevTask(this.db, task.id, { state: "abandoned", detail: "the pull request was closed" }, now);
      }
      return { ok: false, error: `${what} was closed.` };
    }

    const merged = await mergePullRequest(github, target.number, current.value.title);
    if (!merged.ok) return merged;
    // Only a branch in the repository that was merged into: a fork's is not this
    // token's to delete, and a failure there would say nothing useful anyway.
    if (current.value.headRepo === github.repo && current.value.branch !== "") {
      await deleteBranch(github, current.value.branch);
    }

    const record = (detail: string) => {
      if (task !== null) updateDevTask(this.db, task.id, { state: "merged", detail }, now);
      refreshBoard();
    };
    const landed = `merged as ${merged.value.slice(0, 7)}`;

    const asked =
      target.repo === "core"
        ? await requestDeploy(this.config.dataDir, merged.value)
        : await requestPackDeploy(this.config.dataDir, target.pack, merged.value);
    if (!asked.ok) {
      record(asked.error);
      return { ok: false, error: `Merged, but ${asked.error}` };
    }
    record(landed);
    return { ok: true, sha: merged.value, deploying: target.repo === "core" ? "core" : "pack" };
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

    // Said out loud as well as written: the owner wants to hear the moment
    // there is something to look at, not find it in the chat hours later. The
    // sentence ends in the offer to try it, and the offer is kept for the
    // question that answers it.
    const task = devTask(this.db, id);
    const said = spokenReady(topicOf({ gap: task?.gap ?? null, instruction }), pr.value.number, true);
    rememberOffer(this.db, id, said, now());
    await notify(this.channels, {
      spoken: said,
      written: reviewMessage({ instruction, prUrl: pr.value.url, summary, stat }),
    });
  }
}
