/**
 * What JARVIS has tried to build for himself, and where each attempt stands.
 *
 * One table in the memory database, for the reason `proactive/store.ts` gives:
 * a second SQLite file is a second write-ahead log and a backup that quietly
 * covers half of what he knows. `MemoryStore` owns the connection.
 *
 * The row outlives the conversation on purpose. A pull request opened at eleven
 * is approved the next morning by a different agent process, and "welke fix
 * wachtte er nog op mij" has to survive a restart to be worth asking.
 */

import type { DatabaseSync } from "node:sqlite";
import { formatLocal } from "@jarvis/shared";

/**
 * The calendar day a moment falls on at home.
 *
 * Spelled out here rather than imported from `pr-tools.ts`: this module is
 * loaded by `MemoryStore` at startup, and reaching into a tool module for three
 * lines would drag the whole MCP SDK in behind it.
 */
function localDay(ms: number): string {
  return formatLocal(new Date(ms), { dateStyle: "short" });
}

/**
 * Where an attempt stands.
 *
 * `awaiting` is the only state that asks something of the owner, and the only one a
 * merge may start from. The three endings are kept apart because they mean
 * different things the next time the same request comes up: `merged` means it
 * works now, `abandoned` means the guard stopped it and a runner should get it,
 * `failed` means the attempt itself broke and repeating it is reasonable.
 * `finished` is a delegated job whose runner said it was done; what it made is
 * in `detail`, and whatever it opened still waits for the owner.
 */
export type DevState =
  | "running"
  | "awaiting"
  | "merged"
  | "abandoned"
  | "failed"
  | "delegated"
  | "finished";

export interface DevTask {
  id: number;
  createdAt: string;
  updatedAt: string;
  instruction: string;
  size: "small" | "big";
  state: DevState;
  branch: string | null;
  worktree: string | null;
  prUrl: string | null;
  prNumber: number | null;
  slot: number | null;
  detail: string;
  /**
   * The tail of the output that ended the attempt, when there was one.
   *
   * Kept apart from `detail` because the two have different readers: "de tests
   * bleven rood" is the whole of what anyone wants to hear, and the forty lines
   * underneath it are what makes the next attempt possible.
   */
  log: string | null;
  /**
   * The gap this attempt was started to close, when JARVIS started it himself.
   *
   * A short stable name ("read-the-clock") rather than the request: the same
   * missing ability is asked for in a dozen phrasings, and the brakes on
   * starting work unasked are counted per ability, not per sentence.
   */
  gap?: string | null;
}

/** Attempts at one gap in a week before JARVIS stops and asks instead. */
export const GAP_ATTEMPTS = 2;

/** Gaps JARVIS may start closing on his own in one day, across all of them. */
export const DAILY_GAPS = 8;

export function migrateDev(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dev_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      instruction TEXT NOT NULL,
      size        TEXT NOT NULL,
      state       TEXT NOT NULL,
      branch      TEXT,
      worktree    TEXT,
      pr_url      TEXT,
      pr_number   INTEGER,
      slot        INTEGER,
      detail      TEXT NOT NULL DEFAULT '',
      log         TEXT
    );

    CREATE INDEX IF NOT EXISTS dev_tasks_state ON dev_tasks(state);
    CREATE INDEX IF NOT EXISTS dev_tasks_created ON dev_tasks(created_at);
  `);

  // Added later: the output that ended the attempt. It used to be handed to the
  // worker for one repair and then dropped, so an attempt that never got past
  // the suite left a sentence saying so and nothing to read.
  const columns = db.prepare("PRAGMA table_info(dev_tasks)").all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "log")) {
    db.exec("ALTER TABLE dev_tasks ADD COLUMN log TEXT");
  }
  // Added later again: which gap an attempt belongs to, for the brakes on work
  // JARVIS starts without being asked.
  if (!columns.some((column) => column.name === "gap")) {
    db.exec("ALTER TABLE dev_tasks ADD COLUMN gap TEXT");
  }
}

/** node:sqlite hands back null-prototype rows; this shapes one. */
function row(raw: Record<string, unknown>): DevTask {
  return {
    id: Number(raw.id),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
    instruction: String(raw.instruction),
    size: raw.size === "big" ? "big" : "small",
    state: String(raw.state) as DevState,
    branch: raw.branch === null || raw.branch === undefined ? null : String(raw.branch),
    worktree: raw.worktree === null || raw.worktree === undefined ? null : String(raw.worktree),
    prUrl: raw.pr_url === null || raw.pr_url === undefined ? null : String(raw.pr_url),
    prNumber: raw.pr_number === null || raw.pr_number === undefined ? null : Number(raw.pr_number),
    slot: raw.slot === null || raw.slot === undefined ? null : Number(raw.slot),
    detail: raw.detail === null || raw.detail === undefined ? "" : String(raw.detail),
    log: raw.log === null || raw.log === undefined ? null : String(raw.log),
    gap: raw.gap === null || raw.gap === undefined ? null : String(raw.gap),
  };
}

export function createDevTask(
  db: DatabaseSync,
  task: { instruction: string; size: "small" | "big"; state: DevState; detail?: string; gap?: string | null },
  at: Date,
): number {
  const iso = at.toISOString();
  db.prepare(
    `INSERT INTO dev_tasks (created_at, updated_at, instruction, size, state, detail, gap)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(iso, iso, task.instruction, task.size, task.state, task.detail ?? "", task.gap ?? null);
  const last = db.prepare("SELECT last_insert_rowid() AS id").get() as Record<string, unknown>;
  return Number(last.id);
}

/** Writes only the fields that were given; the rest keep what they had. */
export function updateDevTask(
  db: DatabaseSync,
  id: number,
  patch: Partial<
    Pick<DevTask, "state" | "branch" | "worktree" | "prUrl" | "prNumber" | "slot" | "detail" | "log">
  >,
  at: Date,
): void {
  const columns: Record<string, string> = {
    state: "state",
    branch: "branch",
    worktree: "worktree",
    prUrl: "pr_url",
    prNumber: "pr_number",
    slot: "slot",
    detail: "detail",
    log: "log",
  };
  const sets: string[] = ["updated_at = ?"];
  const values: Array<string | number | null> = [at.toISOString()];
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value === null ? null : (value as string | number));
  }
  if (sets.length === 1) return;
  values.push(id);
  db.prepare(`UPDATE dev_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function devTask(db: DatabaseSync, id: number): DevTask | null {
  const raw = db.prepare("SELECT * FROM dev_tasks WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return raw === undefined ? null : row(raw);
}

/** The attempt still being worked on, if there is one. */
export function runningDevTask(db: DatabaseSync): DevTask | null {
  const raw = db
    .prepare("SELECT * FROM dev_tasks WHERE state = 'running' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return raw === undefined ? null : row(raw);
}

/** The newest attempt with a pull request waiting for the owner's yes. */
export function awaitingDevTask(db: DatabaseSync): DevTask | null {
  const raw = db
    .prepare("SELECT * FROM dev_tasks WHERE state = 'awaiting' ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return raw === undefined ? null : row(raw);
}

/**
 * The newest attempt that ended badly.
 *
 * Both endings that produce nothing to review, because from the other side of
 * the room they are the same question: "waarom kwam er niks?". Which of the two
 * it was is in `state`, and why is in `detail` and `log`.
 */
export function lastFailedDevTask(db: DatabaseSync): DevTask | null {
  const raw = db
    .prepare("SELECT * FROM dev_tasks WHERE state IN ('failed', 'abandoned') ORDER BY id DESC LIMIT 1")
    .get() as Record<string, unknown> | undefined;
  return raw === undefined ? null : row(raw);
}

/** Jobs that are with a runner right now, oldest first. */
export function delegatedDevTasks(db: DatabaseSync): DevTask[] {
  const rows = db
    .prepare("SELECT * FROM dev_tasks WHERE state = 'delegated' AND slot IS NOT NULL ORDER BY id")
    .all() as Array<Record<string, unknown>>;
  return rows.map(row);
}

/**
 * Ends the job a slot was running, in whichever way it ended.
 *
 * By slot, because that is all a runner's report carries. Only the newest
 * delegated row for it is touched: a slot is reused, and an older job that was
 * never closed off must not be rewritten with a newer job's ending.
 */
export function endDelegated(
  db: DatabaseSync,
  slot: number,
  ending: { state: "finished" | "failed"; detail: string },
  at: Date,
): DevTask | null {
  const found = db
    .prepare("SELECT * FROM dev_tasks WHERE state = 'delegated' AND slot = ? ORDER BY id DESC LIMIT 1")
    .get(slot) as Record<string, unknown> | undefined;
  if (found === undefined) return null;
  const task = row(found);
  updateDevTask(db, task.id, ending, at);
  return { ...task, ...ending };
}

/** Every attempt at one gap in the week before `now`, newest first. */
export function gapAttempts(db: DatabaseSync, gap: string, now: Date): DevTask[] {
  const since = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString();
  const rows = db
    .prepare("SELECT * FROM dev_tasks WHERE gap = ? AND created_at >= ? ORDER BY id DESC")
    .all(gap, since) as Array<Record<string, unknown>>;
  return rows.map(row);
}

/** How many gaps were started today at home, whatever became of them. */
export function gapsToday(db: DatabaseSync, now: Date): number {
  const window = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const rows = db
    .prepare("SELECT created_at FROM dev_tasks WHERE gap IS NOT NULL AND created_at >= ?")
    .all(window) as Array<Record<string, unknown>>;
  const today = localDay(now.getTime());
  return rows.filter((raw) => localDay(Date.parse(String(raw.created_at))) === today).length;
}

export function latestDevTasks(db: DatabaseSync, limit: number): DevTask[] {
  const rows = db
    .prepare("SELECT * FROM dev_tasks ORDER BY id DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(row);
}

/**
 * How many small fixes were started today at home.
 *
 * Started, not finished: an attempt that failed still spent the quota and the
 * model run, and a day of three failures is exactly the day that should not
 * become a day of six.
 *
 * The day boundary is compared rather than computed. Asking SQLite for
 * "since local midnight" means deriving that moment, which is an offset that
 * changes twice a year; comparing two formatted local dates cannot drift.
 */
export function smallFixesToday(db: DatabaseSync, now: Date): number {
  const window = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const rows = db
    .prepare("SELECT created_at FROM dev_tasks WHERE size = 'small' AND created_at >= ?")
    .all(window) as Array<Record<string, unknown>>;
  const today = localDay(now.getTime());
  return rows.filter((raw) => localDay(Date.parse(String(raw.created_at))) === today).length;
}
