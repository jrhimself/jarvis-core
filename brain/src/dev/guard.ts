/**
 * What JARVIS is allowed to change about himself, decided before anything runs.
 *
 * Everything here is pure. That is the point: the rules that keep a
 * self-modifying assistant from talking himself into a wider mandate must be
 * checkable without a model, a network or a clock, and they must be testable
 * without any of the machinery they guard.
 *
 * The classification is asked of the assistant as a shape -- which repository,
 * which files, does this need a dependency, a secret, another machine -- and
 * decided here. A model that answers those five questions honestly cannot
 * reason its way past the verdict, because it never sees the verdict being
 * made; and a model that answers them dishonestly still meets `escalation()`
 * afterwards, which reads the diff that actually happened rather than the plan
 * that was promised.
 */

/**
 * Paths a small fix may never touch, repo-relative and POSIX-shaped.
 *
 * A trailing slash means the whole subtree. The list is deliberately not about
 * how risky a file looks: the house's `control.ts` is a hundred lines and the change
 * that removes the alarm's confirmation is one of them. It is about what a
 * change to the file can do to the boundaries themselves -- the confirmation
 * grammar, this file's own rules, the deploy path, the dependency manifest --
 * because those are exactly the edits that would be smallest to make and
 * hardest to notice afterwards.
 */
export const PROTECTED_PATHS: readonly string[] = [
  // The self-development machinery, this file included.
  "brain/src/dev/",
  "brain/src/dev-tools.ts",
  "brain/test/dev-",
  // Every pack, whoever wrote it. None of them is in this repository -- a
  // worktree cut from origin/main holds no `packs/` at all -- so a fix that
  // reached for one would be editing a file the pull request cannot show. That
  // is true of the credentialled ones and equally true of the house's
  // confirmation guard, which used to be named here on its own.
  "packs/",
  // Anything that decides what runs, where, as whom.
  "scripts/",
  "deploy/",
  ".github/",
  "package.json",
  "package-lock.json",
  "brain/package.json",
  "hud/package.json",
  "shared/package.json",
];

/** Files a single small fix may span before it stops being small. */
export const MAX_FILES = 4;

/** Small fixes allowed per calendar day. */
export const DAILY_LIMIT = 5;

/** How long a worker may run before it is cut off and the work delegated. */
export const WORKER_TIMEOUT_MS = 15 * 60_000;

/** Conversation turns the worker gets, as a second rein on a runaway loop. */
export const WORKER_MAX_TURNS = 60;

/** Whether a repo-relative path falls inside the protected set. */
export function isProtected(path: string): boolean {
  const clean = path.replace(/^\.\//, "").replace(/\\/g, "/");
  return PROTECTED_PATHS.some((entry) =>
    entry.endsWith("/") || entry.endsWith("-") ? clean.startsWith(entry) : clean === entry,
  );
}

/** Every protected path in a list, in the order they were given. */
export function protectedAmong(paths: readonly string[]): string[] {
  return paths.filter(isProtected);
}

/**
 * How the assistant describes a job before it is started.
 *
 * These are questions about the world, not about the verdict. "Does this need a
 * package that is not installed" has an answer; "is this a small fix" is the
 * thing being decided, and asking a model for it directly invites the answer
 * that gets the work started.
 */
export interface TaskShape {
  /** Which codebase the work belongs in. */
  repo: "jarvis" | "other";
  /** Files the change is expected to touch, repo-relative. */
  files: readonly string[];
  /** A package that is not in the manifest yet. */
  needsNewDependency: boolean;
  /** A new token, key or credential. */
  needsNewSecret: boolean;
  /** Hardware, another machine, or a service outside this repository. */
  needsOutsideWork: boolean;
}

export type Verdict =
  | { size: "small" }
  | { size: "big"; reason: string };

/**
 * Small or big, from the shape alone.
 *
 * First match wins and the order is roughly widest-first, so the reason JARVIS
 * says out loud is the most informative one: "it is not in my own code"
 * says more than "it touches five files" when both are true.
 */
export function classify(shape: TaskShape): Verdict {
  if (shape.repo !== "jarvis") {
    return { size: "big", reason: "it is not in my own code" };
  }
  if (shape.needsOutsideWork) {
    return { size: "big", reason: "it needs work outside this machine" };
  }
  if (shape.needsNewDependency) {
    return { size: "big", reason: "it needs a new package" };
  }
  if (shape.needsNewSecret) {
    return { size: "big", reason: "it needs a new key or token" };
  }
  // A shape with no files is not a small plan, it is no plan. Every check below
  // reads the file list, so an empty one would sail past all of them -- the one
  // honest answer that must not default to "small".
  if (shape.files.length === 0) {
    return { size: "big", reason: "I cannot tell which files it touches" };
  }
  const blocked = protectedAmong(shape.files);
  if (blocked.length > 0) {
    return { size: "big", reason: `it touches protected code (${blocked.join(", ")})` };
  }
  if (shape.files.length > MAX_FILES) {
    return { size: "big", reason: `it touches ${shape.files.length} files` };
  }
  return { size: "small" };
}

/**
 * Whether a finished small fix has to be thrown away after all.
 *
 * Called on the real diff, not on the plan. A worker that wandered into
 * `ha-control.ts` on its way to something else produces a branch that is
 * deleted rather than reviewed -- there is no version of "it only changed one
 * line there" that is worth reading at half past eleven at night.
 */
export function escalation(changed: readonly string[]): string | null {
  const blocked = protectedAmong(changed);
  if (blocked.length > 0) {
    return `the change touched protected code (${blocked.join(", ")})`;
  }
  if (changed.length > MAX_FILES) {
    return `the change touched ${changed.length} files, more than a small fix may`;
  }
  if (changed.length === 0) {
    return "nothing was changed";
  }
  return null;
}

/** Whether another small fix may start right now. */
export function budgetVerdict(doneToday: number, oneRunning: boolean): Verdict {
  if (oneRunning) {
    return { size: "big", reason: "I am already working on another fix" };
  }
  if (doneToday >= DAILY_LIMIT) {
    return { size: "big", reason: `I have already done ${doneToday} myself today` };
  }
  return { size: "small" };
}

/**
 * A branch name from a spoken instruction.
 *
 * Dutch goes in, so the diacritics are folded rather than dropped: "één regel"
 * becoming "n-regel" reads like a typo in the branch list forever after.
 */
export function slugify(instruction: string): string {
  const folded = instruction
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const short = folded.split("-").filter((word) => word !== "").slice(0, 6).join("-");
  return short === "" ? "fix" : short.slice(0, 48).replace(/-+$/, "");
}

/** The branch a task gets, unique enough to survive a repeated instruction. */
export function branchName(instruction: string, at: Date): string {
  const stamp = at.toISOString().slice(5, 16).replace(/[-:T]/g, "");
  return `jarvis/${slugify(instruction)}-${stamp}`;
}
