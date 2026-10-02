/**
 * The jobs the assistant was asked to do later.
 *
 * In the memory database rather than a file of their own, for the same reason
 * everything else is: one thing to back up, and a restart that forgets nothing.
 * A job that was due while the service was down is not lost, it is late, and
 * the scheduler runs it once when it comes back rather than once per missed
 * tick.
 */

import type { DatabaseSync } from "node:sqlite";

import { decodeSchedule, encodeSchedule, nextRun, type Schedule } from "./schedule.js";

export type JobState = "active" | "paused" | "done";

/**
 * Where a job's result goes. `quiet` keeps it for a later `list` and tells nobody.
 * `digest` is written only, through the digest bot when a deployment has one, and
 * through the ordinary written channels when it does not.
 */
export type Delivery = "all" | "written" | "digest" | "quiet";

export interface Job {
  id: number;
  name: string;
  schedule: Schedule;
  /** The schedule as it was asked for, for showing back. */
  spec: string;
  prompt: string;
  state: JobState;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  runs: number;
  runsLeft: number | null;
  failures: number;
  deliver: Delivery;
  createdAt: string;
}

/** Enough jobs that one more is almost certainly a mistake, not a need. */
export const MAX_ACTIVE_JOBS = 25;

/** A job that fails this many runs in a row stops trying, and says so. */
export const MAX_FAILURES = 3;

/** How much of a result is kept for `list`. */
const RESULT_KEPT = 600;

export function migrateSchedules(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      schedule    TEXT NOT NULL,
      spec        TEXT NOT NULL,
      prompt      TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'active',
      next_run    TEXT,
      last_run    TEXT,
      last_result TEXT,
      runs        INTEGER NOT NULL DEFAULT 0,
      runs_left   INTEGER,
      failures    INTEGER NOT NULL DEFAULT 0,
      deliver     TEXT NOT NULL DEFAULT 'all',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS schedules_due ON schedules(state, next_run);
  `);
}

interface Row {
  id: number;
  name: string;
  schedule: string;
  spec: string;
  prompt: string;
  state: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  runs: number;
  runs_left: number | null;
  failures: number;
  deliver: string;
  created_at: string;
}

function job(row: Row): Job {
  return {
    id: Number(row.id),
    name: row.name,
    schedule: decodeSchedule(row.schedule),
    spec: row.spec,
    prompt: row.prompt,
    state: row.state as JobState,
    nextRun: row.next_run,
    lastRun: row.last_run,
    lastResult: row.last_result,
    runs: Number(row.runs),
    runsLeft: row.runs_left === null ? null : Number(row.runs_left),
    failures: Number(row.failures),
    deliver: row.deliver as Delivery,
    createdAt: row.created_at,
  };
}

export interface NewJob {
  name: string;
  spec: string;
  schedule: Schedule;
  prompt: string;
  deliver: Delivery;
  /** How many times it runs before it is done. Null repeats until removed. */
  repeat: number | null;
}

export function addJob(db: DatabaseSync, input: NewJob, now: Date): Job {
  const active = Number(
    (db.prepare("SELECT count(*) AS n FROM schedules WHERE state = 'active'").get() as { n: number }).n,
  );
  if (active >= MAX_ACTIVE_JOBS) {
    throw new Error(`There are already ${MAX_ACTIVE_JOBS} active jobs; remove one first.`);
  }
  const first = nextRun(input.schedule, now);
  if (first === null) throw new Error("That schedule never comes due.");

  const result = db
    .prepare(
      `INSERT INTO schedules (name, schedule, spec, prompt, next_run, runs_left, deliver, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      encodeSchedule(input.schedule),
      input.spec,
      input.prompt,
      first.toISOString(),
      input.repeat,
      input.deliver,
      now.toISOString(),
    );
  const added = getJob(db, Number(result.lastInsertRowid));
  if (added === null) throw new Error("the job was not saved");
  return added;
}

export function getJob(db: DatabaseSync, id: number): Job | null {
  const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
  return row === undefined ? null : job(row);
}

export function listJobs(db: DatabaseSync): Job[] {
  const rows = db.prepare("SELECT * FROM schedules ORDER BY state = 'done', next_run, id").all() as unknown as Row[];
  return rows.map(job);
}

export function removeJob(db: DatabaseSync, id: number): boolean {
  return Number(db.prepare("DELETE FROM schedules WHERE id = ?").run(id).changes) > 0;
}

/** Pauses or resumes. Resuming works the next run out from now, not from the pause. */
export function setJobState(db: DatabaseSync, id: number, state: "active" | "paused", now: Date): Job | null {
  const found = getJob(db, id);
  if (found === null || found.state === "done") return found;
  if (state === "paused") {
    db.prepare("UPDATE schedules SET state = 'paused' WHERE id = ?").run(id);
  } else {
    const next = nextRun(found.schedule, now);
    db.prepare("UPDATE schedules SET state = 'active', failures = 0, next_run = ? WHERE id = ?").run(
      next === null ? null : next.toISOString(),
      id,
    );
  }
  return getJob(db, id);
}

/** Makes a job due now, so the next tick runs it. */
export function runNow(db: DatabaseSync, id: number, now: Date): Job | null {
  const found = getJob(db, id);
  if (found === null || found.state === "done") return found;
  db.prepare("UPDATE schedules SET state = 'active', next_run = ? WHERE id = ?").run(now.toISOString(), id);
  return getJob(db, id);
}

export function dueJobs(db: DatabaseSync, now: Date): Job[] {
  const rows = db
    .prepare("SELECT * FROM schedules WHERE state = 'active' AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run, id")
    .all(now.toISOString()) as unknown as Row[];
  return rows.map(job);
}

/**
 * Writes down that a run happened and works out what comes next.
 *
 * The next run is counted from now and not from when the run was due: a job
 * that was an hour late does not then fire twice to catch up.
 */
export function finishRun(db: DatabaseSync, id: number, outcome: { ok: boolean; result: string }, now: Date): Job | null {
  const found = getJob(db, id);
  if (found === null) return null;

  const failures = outcome.ok ? 0 : found.failures + 1;
  const runsLeft = found.runsLeft === null ? null : found.runsLeft - 1;
  const next = nextRun(found.schedule, now);

  let state: JobState = "active";
  if (next === null || (runsLeft !== null && runsLeft <= 0)) state = "done";
  else if (failures >= MAX_FAILURES) state = "paused";

  db.prepare(
    `UPDATE schedules
        SET runs = runs + 1, last_run = ?, last_result = ?, failures = ?, runs_left = ?, state = ?, next_run = ?
      WHERE id = ?`,
  ).run(
    now.toISOString(),
    outcome.result.slice(0, RESULT_KEPT),
    failures,
    runsLeft,
    state,
    state === "done" ? null : next === null ? null : next.toISOString(),
    id,
  );
  return getJob(db, id);
}
