/**
 * Where what JARVIS notices is kept.
 *
 * Four tables, and the shape of each one is an argument about the phase that
 * fills it. `observations` is what happened, reduced to a bucket. `baselines`
 * is what usually happens in that bucket. `anomalies` is the difference, once
 * it has held long enough to be worth the word. `suggestions` is the only one
 * a model ever writes to.
 *
 * They live in the memory database rather than one of their own. A second
 * SQLite file means a second write-ahead log, a second connection taking the
 * write lock, and a backup job that silently only covers half of what JARVIS
 * knows. `MemoryStore` owns the connection and hands it here.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * Whether a row describes an entity from the live feed or a long-term statistic.
 *
 * The two arrive by different routes and at different rates -- a door reports
 * the moment it opens, a meter reports once an hour, an hour late -- but they
 * deviate from a baseline in the same way, so everything downstream of the
 * rollup treats them alike.
 */
export type ObservationKind = "state" | "statistic";

/**
 * How a baseline describes normal.
 *
 * `numeric` is a median with a median absolute deviation around it: the usual
 * kilowatt-hour, the usual degree. `behavioural` is the fraction of an hour a
 * thing was on, with the spread of that fraction across the days it was
 * measured. Both reduce to a centre and a spread, which is why one rule can
 * score them both.
 */
export type BaselineShape = "numeric" | "behavioural";

/**
 * Creates the proactive tables. Idempotent, and safe against a database that
 * already has them.
 *
 * Weekday and hour are stored as *local* numbers, not UTC. A baseline exists to
 * say what an evening looks like, and an evening is a thing that happens in
 * Amsterdam; keeping these in UTC would smear every pattern by an hour twice a
 * year and put the whole of a summer evening in the wrong bucket.
 */
export function migrateProactive(db: DatabaseSync): void {
  db.exec(`
    -- One bucket of one thing. The rollup worker writes these; nothing else
    -- does. A binary sensor fills the millisecond columns and 'changes' and
    -- leaves 'value' null; a meter fills 'value'.
    --
    -- Time rather than a fraction, because the two are not the same thing when
    -- a bucket is partial. A restart at four minutes past leaves two rows'
    -- worth of evidence for one bucket, and milliseconds add where fractions
    -- would have to be averaged with weights nobody kept.
    CREATE TABLE IF NOT EXISTS observations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      subject     TEXT NOT NULL,
      kind        TEXT NOT NULL,
      watch_group TEXT NOT NULL,
      bucket      TEXT NOT NULL,
      value       REAL,
      active_ms   INTEGER NOT NULL DEFAULT 0,
      observed_ms INTEGER NOT NULL DEFAULT 0,
      changes     INTEGER NOT NULL DEFAULT 0,
      samples     INTEGER NOT NULL DEFAULT 0
    );

    -- A tick that runs twice, or a restart mid-bucket, must not double-count.
    CREATE UNIQUE INDEX IF NOT EXISTS observations_bucket
      ON observations(subject, bucket);
    CREATE INDEX IF NOT EXISTS observations_at ON observations(bucket);

    -- What a subject usually does in a given hour of a given weekday. Rebuilt
    -- nightly rather than updated in place, so a bad night can be thrown away.
    CREATE TABLE IF NOT EXISTS baselines (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      subject  TEXT NOT NULL,
      kind     TEXT NOT NULL,
      shape    TEXT NOT NULL,
      weekday  INTEGER NOT NULL,
      hour     INTEGER NOT NULL,
      centre   REAL NOT NULL,
      spread   REAL NOT NULL,
      samples  INTEGER NOT NULL,
      built_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS baselines_slot
      ON baselines(subject, weekday, hour);

    -- A finding, not an event. 'buckets' counts how many buckets in a row the
    -- condition has held, because one bucket is noise and the rules require
    -- persistence before they will say anything.
    CREATE TABLE IF NOT EXISTS anomalies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      fingerprint TEXT NOT NULL,
      subject     TEXT NOT NULL,
      rule        TEXT NOT NULL,
      watch_group TEXT NOT NULL,
      area        TEXT,
      first_at    TEXT NOT NULL,
      last_at     TEXT NOT NULL,
      buckets     INTEGER NOT NULL DEFAULT 1,
      observed    REAL,
      expected    REAL,
      deviation   REAL,
      detail      TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',
      resolved_at TEXT
    );

    -- Dedupe enforced by the schema rather than by remembering to check: a
    -- window that is still open is one finding however many times it is seen.
    -- Closed rows are exempt, so the same window next week is a new one.
    CREATE UNIQUE INDEX IF NOT EXISTS anomalies_open
      ON anomalies(fingerprint) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS anomalies_at ON anomalies(last_at);
    CREATE INDEX IF NOT EXISTS anomalies_subject ON anomalies(subject, last_at);

    -- Something worth saying, and what came of saying it. The outcome columns
    -- are the only record of whether any of this was useful; a suggestion that
    -- was dismissed twice is what teaches the next one not to fire.
    CREATE TABLE IF NOT EXISTS suggestions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      anomaly_id    INTEGER,
      at            TEXT NOT NULL,
      body          TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      delivered_at  TEXT,
      outcome       TEXT,
      outcome_at    TEXT,
      snoozed_until TEXT,
      verdict       TEXT,
      verdict_at    TEXT
    );

    -- The daily cap is a count over this index, taken before anything is said.
    CREATE INDEX IF NOT EXISTS suggestions_at ON suggestions(at);
    CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions(status, at);

    -- One row per scheduled job, rewritten every time it runs. A job that
    -- fails still stamps 'at', so 'ok_at' keeps saying when it last actually
    -- worked -- the distinction the whole thing exists for, because a nightly
    -- ingest that has run and returned nothing for a week looks identical to a
    -- healthy one if only the attempt is recorded.
    CREATE TABLE IF NOT EXISTS heartbeats (
      name   TEXT PRIMARY KEY,
      at     TEXT NOT NULL,
      ok     INTEGER NOT NULL,
      ok_at  TEXT,
      detail TEXT NOT NULL DEFAULT ''
    );

    -- A thin time series of JARVIS's own numbers: how many facts he holds, how
    -- many notes were ingested, how much memory he is using. Kept because the
    -- interesting question is almost never the value but the change -- a fact
    -- count is only alarming next to yesterday's.
    CREATE TABLE IF NOT EXISTS self_metrics (
      name  TEXT NOT NULL,
      at    TEXT NOT NULL,
      value REAL NOT NULL,
      PRIMARY KEY (name, at)
    );
    CREATE INDEX IF NOT EXISTS self_metrics_at ON self_metrics(at);
  `);

  addDeliveryColumns(db);

}

/** When a scheduled job last ran, and whether that run got anywhere. */
/**
 * Where a suggestion was delivered.
 *
 * Added after the table: the first version wrote the sentence and forgot where
 * it had been put, which is enough to record an answer but not enough to go
 * back and take the buttons away. A suggestion whose buttons still work after
 * it has been answered invites the same answer twice.
 */
function addDeliveryColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(suggestions)").all() as unknown as Array<{
    name: string;
  }>;
  const has = (name: string): boolean => columns.some((column) => column.name === name);
  if (!has("chat_id")) db.exec("ALTER TABLE suggestions ADD COLUMN chat_id TEXT");
  if (!has("message_id")) db.exec("ALTER TABLE suggestions ADD COLUMN message_id INTEGER");

  // Added later as well: the sentence as a key and its values, so a finding can
  // be read in a language the rule that wrote it does not speak. Rows from
  // before it have prose and nothing else, which still reads.
  const anomalyColumns = db.prepare("PRAGMA table_info(anomalies)").all() as unknown as Array<{
    name: string;
  }>;
  if (!anomalyColumns.some((column) => column.name === "phrase")) {
    db.exec("ALTER TABLE anomalies ADD COLUMN phrase TEXT");
  }
}

/** A suggestion as everything downstream reads it. */
export interface Suggestion {
  id: number;
  anomalyId: number | null;
  at: string;
  body: string;
  status: string;
  chatId: string | null;
  messageId: number | null;
  verdict: string | null;
}

interface SuggestionRow {
  id: number;
  anomaly_id: number | null;
  at: string;
  body: string;
  status: string;
  chat_id: string | null;
  message_id: number | null;
  verdict: string | null;
}

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    anomalyId: row.anomaly_id,
    at: row.at,
    body: row.body,
    status: row.status,
    chatId: row.chat_id,
    messageId: row.message_id,
    verdict: row.verdict,
  };
}

/** Writes down something worth saying, before any attempt to say it. */
export function recordSuggestion(
  db: DatabaseSync,
  anomalyId: number | null,
  body: string,
  now: Date,
): number {
  const result = db
    .prepare("INSERT INTO suggestions (anomaly_id, at, body) VALUES (?, ?, ?)")
    .run(anomalyId, now.toISOString(), body);
  return Number(result.lastInsertRowid);
}

/** Marks one as delivered, and remembers where it went. */
export function markDelivered(
  db: DatabaseSync,
  id: number,
  chatId: string,
  messageId: number,
  now: Date,
): void {
  db.prepare(
    "UPDATE suggestions SET status = 'delivered', delivered_at = ?, chat_id = ?, message_id = ? WHERE id = ?",
  ).run(now.toISOString(), chatId, messageId, id);
}

/** And one that never arrived, so the next pass does not sit waiting on it. */
export function markUndeliverable(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE suggestions SET status = 'undelivered' WHERE id = ?").run(id);
}

/**
 * Whether this condition has already been put to somebody.
 *
 * A row that never arrived does not count. Ten minutes of a domestic
 * connection being down would otherwise make a condition permanently
 * unaskable: the record of the attempt is kept, and the question is asked
 * again on the next pass.
 */
export function alreadySuggested(db: DatabaseSync, anomalyId: number): boolean {
  const row = db
    .prepare("SELECT count(*) AS n FROM suggestions WHERE anomaly_id = ? AND status <> 'undelivered'")
    .get(anomalyId) as unknown as { n: number } | undefined;
  return Number(row?.n ?? 0) > 0;
}

/** How many have been sent in the last day, which is what the cap counts. */
export function suggestedSince(db: DatabaseSync, since: Date): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM suggestions WHERE at >= ?")
    .get(since.toISOString()) as unknown as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/** One suggestion by id, or null when it has been deleted underneath. */
export function suggestion(db: DatabaseSync, id: number): Suggestion | null {
  const row = db
    .prepare(
      `SELECT id, anomaly_id, at, body, status, chat_id, message_id, verdict
       FROM suggestions WHERE id = ?`,
    )
    .get(id) as unknown as SuggestionRow | undefined;
  return row === undefined ? null : toSuggestion(row);
}

/**
 * Records what somebody said about a suggestion.
 *
 * The verdict is kept whatever it says; a suggestion called noise is not
 * deleted, because a table of things that were wrong is the only evidence there
 * is that the rules are improving.
 */
export function recordVerdict(db: DatabaseSync, id: number, verdict: string, now: Date): void {
  db.prepare("UPDATE suggestions SET verdict = ?, verdict_at = ?, status = 'answered' WHERE id = ?").run(
    verdict,
    now.toISOString(),
    id,
  );
}

/** Puts a subject away until a date, so the same sentence stops arriving. */
export function snoozeSuggestion(db: DatabaseSync, id: number, until: Date, now: Date): void {
  db.prepare(
    "UPDATE suggestions SET verdict = 'snoozed', verdict_at = ?, snoozed_until = ?, status = 'answered' WHERE id = ?",
  ).run(now.toISOString(), until.toISOString(), id);
}

/**
 * The subjects that are not to be spoken about yet.
 *
 * A snooze is per subject rather than per condition: the thing being put away
 * is a sensor somebody knows about, and a condition that closes and reopens the
 * next hour would otherwise walk straight through it.
 */
export function snoozedSubjects(db: DatabaseSync, now: Date): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.subject AS subject
       FROM suggestions s JOIN anomalies a ON a.id = s.anomaly_id
       WHERE s.snoozed_until IS NOT NULL AND s.snoozed_until > ?`,
    )
    .all(now.toISOString()) as unknown as Array<{ subject: string }>;
  return new Set(rows.map((row) => row.subject));
}

export interface Heartbeat {
  name: string;
  at: string;
  ok: boolean;
  okAt: string | null;
  detail: string;
}

/**
 * Records that a job ran. A failed run keeps the previous success time.
 */
export function beat(db: DatabaseSync, name: string, ok: boolean, detail = ""): void {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO heartbeats (name, at, ok, ok_at, detail) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       at = excluded.at,
       ok = excluded.ok,
       ok_at = CASE WHEN excluded.ok = 1 THEN excluded.at ELSE heartbeats.ok_at END,
       detail = excluded.detail`,
  ).run(name, at, ok ? 1 : 0, ok ? at : null, detail);
}

/** Every job that has ever reported in, by name. */
export function heartbeats(db: DatabaseSync): Map<string, Heartbeat> {
  const rows = db
    .prepare("SELECT name, at, ok, ok_at, detail FROM heartbeats")
    .all() as unknown as Array<{
    name: string;
    at: string;
    ok: number;
    ok_at: string | null;
    detail: string;
  }>;
  return new Map(
    rows.map((row) => [
      row.name,
      { name: row.name, at: row.at, ok: row.ok === 1, okAt: row.ok_at, detail: row.detail },
    ]),
  );
}

/** Writes one sample of one of JARVIS's own numbers. */
export function recordMetric(db: DatabaseSync, name: string, value: number, at: Date): void {
  db.prepare(
    `INSERT INTO self_metrics (name, at, value) VALUES (?, ?, ?)
     ON CONFLICT(name, at) DO UPDATE SET value = excluded.value`,
  ).run(name, at.toISOString(), value);
}

/**
 * The newest sample taken at or before a moment, for comparing now with then.
 *
 * Null when nothing that old exists, which a fresh database always is. Every
 * caller treats that as "no opinion" rather than as a change of zero: a
 * comparison against a history that is not there yet is not evidence.
 */
export function metricAt(db: DatabaseSync, name: string, before: Date): number | null {
  const row = db
    .prepare(
      "SELECT value FROM self_metrics WHERE name = ? AND at <= ? ORDER BY at DESC LIMIT 1",
    )
    .get(name, before.toISOString()) as unknown as { value: number } | undefined;
  return row === undefined ? null : Number(row.value);
}

/** Drops samples older than the window the checks look back over. */
export function pruneMetrics(db: DatabaseSync, keepDays: number, now: Date): number {
  const cutoff = new Date(now.getTime() - keepDays * 24 * 3600_000).toISOString();
  return Number(db.prepare("DELETE FROM self_metrics WHERE at < ?").run(cutoff).changes);
}

/** How much of each table there is, for a CLI or a health line. */
export function proactiveCounts(db: DatabaseSync): {
  observations: number;
  baselines: number;
  anomalies: number;
  openAnomalies: number;
  suggestions: number;
} {
  const one = (sql: string): number =>
    Number((db.prepare(sql).get() as unknown as { n: number } | undefined)?.n ?? 0);
  return {
    observations: one("SELECT count(*) AS n FROM observations"),
    baselines: one("SELECT count(*) AS n FROM baselines"),
    anomalies: one("SELECT count(*) AS n FROM anomalies"),
    openAnomalies: one("SELECT count(*) AS n FROM anomalies WHERE status = 'open'"),
    suggestions: one("SELECT count(*) AS n FROM suggestions"),
  };
}
