/**
 * A throwaway checkout to change JARVIS' own code in.
 *
 * Never the live tree. The checkout is what the running service was
 * built from, and a worker that edits it leaves the machine in a state where a
 * crash-restart boots half a feature. A `git worktree` costs a few hundred
 * milliseconds and makes "throw the attempt away" a directory removal instead
 * of a rescue operation.
 *
 * The one piece that is shared is `node_modules`, and it is shared carefully.
 * Symlinking the whole directory would look right and be wrong: npm's workspace
 * links inside it are relative, so `@jarvis/brain` would resolve back to the
 * live sources and the suite would test the running code rather than the
 * change. Each top-level entry is linked individually and the three workspace
 * links are rebuilt to point inside the worktree.
 */

import { mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { run, tail, type Ran } from "./shell.js";
import { WORKER_TIMEOUT_MS } from "./guard.js";

/** The workspaces npm links into node_modules/@jarvis. */
const WORKSPACES = ["brain", "hud", "shared"] as const;

/** A suite run is minutes; a git command is seconds. */
const GIT_TIMEOUT_MS = 60_000;
const SUITE_TIMEOUT_MS = 10 * 60_000;

export interface Worktree {
  /** Absolute path of the throwaway checkout. */
  path: string;
  /** Branch it was created on. */
  branch: string;
}

async function git(cwd: string, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<Ran> {
  return run("git", args, { cwd, timeoutMs });
}

/**
 * Links the live dependencies into a fresh checkout.
 *
 * Absolute links for third-party packages, so a relative link inside them still
 * resolves against the real directory; freshly built relative links for the
 * workspaces, so the code under test is the code in this worktree.
 */
export async function linkDependencies(repo: string, worktree: string): Promise<void> {
  const source = join(repo, "node_modules");
  const target = join(worktree, "node_modules");
  await mkdir(join(target, "@jarvis"), { recursive: true });

  for (const entry of await readdir(source)) {
    if (entry === "@jarvis") continue;
    await symlink(join(source, entry), join(target, entry)).catch(() => undefined);
  }
  for (const workspace of WORKSPACES) {
    await symlink(join(worktree, workspace), join(target, "@jarvis", workspace)).catch(
      () => undefined,
    );
  }
}

/**
 * A worktree on a new branch cut from the current origin/main.
 *
 * From origin/main rather than from the local checkout: the running service may
 * sit on a commit that was rolled back, and a fix branched off that would carry
 * whatever went wrong into the pull request.
 */
export async function createWorktree(
  repo: string,
  root: string,
  branch: string,
): Promise<{ worktree: Worktree } | { error: string }> {
  const fetched = await git(repo, ["fetch", "--quiet", "origin", "main"]);
  if (!fetched.ok) return { error: `git fetch mislukte: ${tail(fetched.stderr, 3)}` };

  const path = join(root, branch.replace(/[^A-Za-z0-9._-]+/g, "-"));
  await rm(path, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const added = await git(repo, ["worktree", "add", "-b", branch, path, "origin/main"]);
  if (!added.ok) return { error: `git worktree mislukte: ${tail(added.stderr, 3)}` };

  await linkDependencies(repo, path);
  return { worktree: { path, branch } };
}

/** Repo-relative paths the worktree has changed, staged or not. */
export async function changedFiles(worktree: string): Promise<string[]> {
  const status = await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!status.ok) return [];
  return status.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== "")
    // A rename reads as "old -> new"; the new path is the one that matters.
    .map((line) => (line.includes(" -> ") ? line.split(" -> ")[1] ?? line : line));
}

/** A short summary of the change, for reading out and for the pull request body. */
export async function diffStat(worktree: string): Promise<string> {
  const stat = await git(worktree, ["diff", "--stat", "HEAD"]);
  return stat.ok ? stat.stdout.trim() : "";
}

export interface SuiteResult {
  ok: boolean;
  /** The tail of the output, only worth keeping when it failed. */
  detail: string;
}

/**
 * The acceptance suite, in the worktree.
 *
 * Both halves, because they fail differently: `npm test` builds and runs the
 * runtime behaviour, `test:types` catches the test file that compiles only
 * because nobody type-checked it. A pull request is not offered unless both are
 * green -- the whole point of the gate is that the owner's yes is about whether they
 * wants the change, not about whether it works.
 */
export async function runSuite(worktree: string): Promise<SuiteResult> {
  const tested = await run("npm", ["test"], { cwd: worktree, timeoutMs: SUITE_TIMEOUT_MS });
  if (!tested.ok) {
    return { ok: false, detail: tail(`${tested.stdout}\n${tested.stderr}`, 40) };
  }
  const typed = await run("npm", ["run", "test:types"], {
    cwd: worktree,
    timeoutMs: SUITE_TIMEOUT_MS,
  });
  if (!typed.ok) {
    return { ok: false, detail: tail(`${typed.stdout}\n${typed.stderr}`, 40) };
  }
  return { ok: true, detail: "" };
}

/**
 * Commits everything in the worktree under JARVIS' own authorship.
 *
 * The name is his; the address is the owner's, because a commit needs one that
 * a forge will accept and JARVIS has no mailbox of his own. It comes from the
 * environment rather than from here -- `JARVIS_COMMIT_EMAIL`, falling back to
 * whatever git is already configured with, which on a machine set up to push is
 * the right answer anyway.
 */
export async function commitAll(
  worktree: string,
  subject: string,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = process.env["JARVIS_COMMIT_EMAIL"] ?? "";
  const added = await git(worktree, ["add", "--all"]);
  if (!added.ok) return { ok: false, error: tail(added.stderr, 3) };

  const message = body.trim() === "" ? subject : `${subject}\n\n${body.trim()}`;
  const committed = await run(
    "git",
    ["commit", "--quiet", "--file", "-"],
    {
      cwd: worktree,
      timeoutMs: GIT_TIMEOUT_MS,
      input: message,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "JARVIS",
        GIT_COMMITTER_NAME: "JARVIS",
        ...(email === "" ? {} : { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email }),
      },
    },
  );
  if (!committed.ok) return { ok: false, error: tail(`${committed.stdout}\n${committed.stderr}`, 5) };
  return { ok: true };
}

/**
 * Whether `origin` will accept a branch from this machine, asked before the work.
 *
 * A copy of this repository that somebody else installed has an `origin` they
 * cannot write to, and without this the refusal arrives a quarter of an hour
 * later, after a worker has written a change and a suite has run on it, with
 * the commit thrown away. `--dry-run` asks the same question the real push asks
 * and creates nothing.
 */
export async function canPushBranches(
  repo: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const probed = await git(repo, [
    "push",
    "--dry-run",
    "--quiet",
    "origin",
    "HEAD:refs/heads/jarvis-write-probe",
  ]);
  return probed.ok ? { ok: true } : { ok: false, error: tail(probed.stderr, 3) };
}

/** Pushes the branch to GitHub over the deploy key that is already there. */
export async function pushBranch(
  worktree: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pushed = await git(worktree, ["push", "--quiet", "--set-upstream", "origin", branch]);
  return pushed.ok ? { ok: true } : { ok: false, error: tail(pushed.stderr, 3) };
}

/**
 * Removes the worktree and, unless it was merged, the branch with it.
 *
 * Deliberately forgiving: a worktree that will not go away must not be able to
 * hold up the answer somebody is waiting for. What is left behind is a directory,
 * and `git worktree prune` on the next attempt clears it.
 */
export async function discardWorktree(
  repo: string,
  worktree: string,
  branch: string | null,
): Promise<void> {
  await git(repo, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
  await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
  if (branch !== null) {
    await git(repo, ["branch", "-D", branch]).catch(() => undefined);
  }
  await git(repo, ["worktree", "prune"]).catch(() => undefined);
}

export { WORKER_TIMEOUT_MS };
