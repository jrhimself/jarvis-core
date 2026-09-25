/**
 * What JARVIS remembers between conversations.
 *
 * Two kinds of things live here. Facts are what he knows about the household —
 * preferences, people, running concerns, conclusions he drew. Turns are the raw
 * conversation log, kept so a later pass can summarise it and so "waar hadden we
 * het over" has something to look at.
 *
 * Nothing about the state of the house is stored: that is Home Assistant's job and
 * it is always fresher there. This holds only what exists nowhere else.
 *
 * Full-text search rather than embeddings — no second API key, deterministic
 * results, and at household scale the vocabulary is small enough that word matching
 * finds what a spoken question is reaching for.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDev } from "../dev/store.js";
import { beat, migrateProactive, proactiveCounts } from "../proactive/store.js";

export type FactKind = "voorkeur" | "feit" | "persoon" | "gewoonte" | "conclusie" | "lopend";

/**
 * Older wordings kept per fact.
 *
 * Enough to walk back a bad consolidation pass or a mistyped edit, and few enough
 * that a fact rewritten every week does not carry a year of noise.
 */
const REVISIONS_PER_FACT = 20;

/** Which kind of call spent the tokens: the conversation itself, or a background pass. */
export type UsageKind = "turn" | "distil" | "consolidate" | "recipes" | "supervise";

/** One metered call to the model. */
export interface UsageEntry {
  kind: UsageKind;
  sessionId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  durationMs: number | null;
  firstTextMs: number | null;
  toolCalls: number;
}

/** Totals over a window, per kind of call. */
export interface UsageTotals {
  kind: UsageKind;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** Median duration, which says more about a typical turn than the mean does. */
  medianMs: number | null;
  medianFirstTextMs: number | null;
}

export interface Fact {
  id: number;
  kind: FactKind;
  subject: string;
  body: string;
  /** Core facts ride along in every prompt; the rest is searched for. */
  core: boolean;
  source: "owner" | "jarvis";
  createdAt: string;
  updatedAt: string;
  /** How often recall has actually put this fact in front of the assistant. */
  hits: number;
  /** When that last happened, or null for a fact nothing has ever asked for. */
  lastUsedAt: string | null;
}

interface FactRow {
  id: number;
  kind: string;
  subject: string;
  body: string;
  core: number;
  source: string;
  created_at: string;
  updated_at: string;
  hits: number;
  last_used_at: string | null;
}

function toFact(row: FactRow): Fact {
  return {
    id: row.id,
    kind: row.kind as FactKind,
    subject: row.subject,
    body: row.body,
    core: row.core === 1,
    source: row.source === "jarvis" ? "jarvis" : "owner",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hits: row.hits,
    lastUsedAt: row.last_used_at ?? null,
  };
}

/**
 * Why a fact's previous wording was put aside.
 *
 * Kept apart from `corrections`, which record the owner's judgement and are fed back
 * to the distiller as lessons. This is the plain audit trail: every overwrite,
 * whoever made it and whatever it meant.
 */
export type RevisionReason =
  | "rewritten"
  | "folded"
  | "consolidated"
  | "deleted"
  | "imported"
  | "distilled";

/** A fact as it read before something replaced or removed it. */
export interface Revision {
  id: number;
  factId: number;
  at: string;
  reason: RevisionReason;
  kind: FactKind;
  subject: string;
  body: string;
  core: boolean;
  source: "owner" | "jarvis";
}

function toRevision(row: Record<string, string | number>): Revision {
  return {
    id: Number(row["id"]),
    factId: Number(row["fact_id"]),
    at: String(row["at"]),
    reason: String(row["reason"]) as RevisionReason,
    kind: String(row["kind"]) as FactKind,
    subject: String(row["subject"]),
    body: String(row["body"]),
    core: Number(row["core"]) === 1,
    source: String(row["source"]) === "jarvis" ? "jarvis" : "owner",
  };
}

/** Something the owner threw out or rewrote after JARVIS wrote it down. */
export interface Correction {
  id: number;
  at: string;
  action: "deleted" | "rewritten";
  kind: string;
  subject: string;
  before: string;
  after: string | null;
}

/** What one conversation was about. */
export interface Session {
  id: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  summary: string;
}

/**
 * What one nightly pass over the owner's notes did.
 *
 * The counts are the same ones the pass prints; keeping them makes the run
 * comparable to the ones before it, which is the only form in which the number
 * means anything -- twenty-three new facts is a busy night or a runaway note
 * depending on what the week looked like.
 */
export interface CorpusRun {
  /** When the pass finished, ISO 8601. */
  at: string;
  /** Notes found in the directory. */
  scanned: number;
  /** Notes that had changed and were read by the model. */
  read: number;
  /** Facts written or rewritten. */
  written: number;
  /** Facts left alone because a seed or JARVIS himself owns that subject. */
  skipped: number;
  /** Facts dropped because no note says them any more. */
  retired: number;
  /** Notes that no longer exist. */
  gone: number;
  /** Notes the model would not read. */
  failed: number;
  /** Facts held before the pass, and after it. */
  factsBefore: number;
  factsAfter: number;
}

interface CorpusRunRow {
  at: string;
  scanned: number;
  read: number;
  written: number;
  skipped: number;
  retired: number;
  gone: number;
  failed: number;
  facts_before: number;
  facts_after: number;
}

function toCorpusRun(row: CorpusRunRow): CorpusRun {
  return {
    at: row.at,
    scanned: Number(row.scanned),
    read: Number(row.read),
    written: Number(row.written),
    skipped: Number(row.skipped),
    retired: Number(row.retired),
    gone: Number(row.gone),
    failed: Number(row.failed),
    factsBefore: Number(row.facts_before),
    factsAfter: Number(row.facts_after),
  };
}

interface SessionRow {
  id: string;
  started_at: string;
  ended_at: string;
  turns: number;
  summary: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    turns: Number(row.turns),
    summary: row.summary,
  };
}

export class MemoryStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        kind       TEXT NOT NULL,
        subject    TEXT NOT NULL,
        body       TEXT NOT NULL,
        core       INTEGER NOT NULL DEFAULT 0,
        source     TEXT NOT NULL DEFAULT 'owner',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        hits       INTEGER NOT NULL DEFAULT 0
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
        subject, body, content='facts', content_rowid='id', tokenize='unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
        INSERT INTO facts_fts(rowid, subject, body) VALUES (new.id, new.subject, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, subject, body)
        VALUES ('delete', old.id, old.subject, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
        INSERT INTO facts_fts(facts_fts, rowid, subject, body)
        VALUES ('delete', old.id, old.subject, old.body);
        INSERT INTO facts_fts(rowid, subject, body) VALUES (new.id, new.subject, new.body);
      END;

      CREATE TABLE IF NOT EXISTS turns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT,
        at          TEXT NOT NULL,
        asked       TEXT NOT NULL,
        answered    TEXT NOT NULL,
        distilled   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id);
      CREATE INDEX IF NOT EXISTS turns_pending ON turns(distilled, id);

      -- Which tools a turn actually used, and with what. This is what a question
      -- pattern gets turned into a recipe from.
      CREATE TABLE IF NOT EXISTS turn_tools (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER NOT NULL,
        name    TEXT NOT NULL,
        input   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_tools_turn ON turn_tools(turn_id);

      -- Recurring question patterns and the tool calls that answered them.
      CREATE TABLE IF NOT EXISTS recipes (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern    TEXT NOT NULL,
        recipe     TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        at            TEXT NOT NULL,
        kind          TEXT NOT NULL,
        session_id    TEXT,
        model         TEXT,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read    INTEGER NOT NULL DEFAULT 0,
        cache_write   INTEGER NOT NULL DEFAULT 0,
        cost_usd      REAL NOT NULL DEFAULT 0,
        duration_ms   INTEGER,
        first_text_ms INTEGER,
        tool_calls    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS usage_at ON usage(at);

      -- How a fact read before it was overwritten or removed. Rows outlive the
      -- fact on purpose: the wording of something that was deleted is exactly
      -- what someone comes looking for.
      CREATE TABLE IF NOT EXISTS fact_revisions (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        fact_id INTEGER NOT NULL,
        at      TEXT NOT NULL,
        reason  TEXT NOT NULL,
        kind    TEXT NOT NULL,
        subject TEXT NOT NULL,
        body    TEXT NOT NULL,
        core    INTEGER NOT NULL DEFAULT 0,
        source  TEXT NOT NULL DEFAULT 'owner'
      );
      CREATE INDEX IF NOT EXISTS fact_revisions_fact ON fact_revisions(fact_id, id);

      -- What the owner did to a fact JARVIS wrote down. The distiller reads it back so
      -- the same wrong thing does not get written twice.
      CREATE TABLE IF NOT EXISTS corrections (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        at      TEXT NOT NULL,
        action  TEXT NOT NULL,
        kind    TEXT NOT NULL,
        subject TEXT NOT NULL,
        before  TEXT NOT NULL,
        after   TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at   TEXT NOT NULL,
        turns      INTEGER NOT NULL,
        summary    TEXT NOT NULL
      );

      -- Standalone rather than external-content: sessions are keyed by a uuid and
      -- fts5 needs an integer rowid to shadow a table.
      CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
        session_id UNINDEXED, summary, tokenize='unicode61'
      );

      -- The owner's own notes as they stood when they were last read. The hash is what
      -- keeps a nightly pass from paying a model for a hundred unchanged files.
      CREATE TABLE IF NOT EXISTS corpus_files (
        path        TEXT PRIMARY KEY,
        hash        TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      -- Which facts a note produced. Without it, a deleted note leaves its
      -- facts behind forever, and nothing tells a fact that came from a note
      -- apart from one JARVIS worked out himself or one curated by hand.
      CREATE TABLE IF NOT EXISTS corpus_facts (
        path    TEXT NOT NULL,
        fact_id INTEGER NOT NULL,
        PRIMARY KEY (path, fact_id)
      );
      CREATE INDEX IF NOT EXISTS corpus_facts_fact ON corpus_facts(fact_id);
    `);

    // Added later: the vector next to each fact, for meaning-based recall.
    const columns = this.#db.prepare("PRAGMA table_info(facts)").all() as unknown as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "vec")) {
      this.#db.exec("ALTER TABLE facts ADD COLUMN vec BLOB");
    }

    // Added later: when a fact was last recalled. Counting hits without a date
    // made a fact that was useful once, a year ago, indistinguishable from one
    // that is asked for every week.
    if (!columns.some((column) => column.name === "last_used_at")) {
      this.#db.exec("ALTER TABLE facts ADD COLUMN last_used_at TEXT");
    }

    // Added later: single values about the assistant's own routine — when the
    // last briefing was given, and whatever comes next. In the database rather
    // than in a module variable because a deploy restarts the brain, and the
    // routine should not start over because the code moved.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // `source` distinguishes what the owner said himself from what the assistant
    // worked out, and nothing reads the column literally: both `toFact` and
    // `toRevision` map anything that is not `jarvis` onto `owner`. A database
    // carrying some older word for the owner therefore reads back correctly
    // without being rewritten, which is why there is no migration here.

    // Added later: one row per nightly pass over the owner's notes. The pass already
    // printed its tally and beat its heartbeat, but a heartbeat keeps only the
    // last run and a journal is rotated away, so "what came in this week" had no
    // answer. The briefing is the reason it needs one: a night that changed
    // nothing must be distinguishable from a night that did not run.
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS corpus_runs (
        at           TEXT PRIMARY KEY,
        scanned      INTEGER NOT NULL,
        read         INTEGER NOT NULL,
        written      INTEGER NOT NULL,
        skipped      INTEGER NOT NULL,
        retired      INTEGER NOT NULL,
        gone         INTEGER NOT NULL,
        failed       INTEGER NOT NULL,
        facts_before INTEGER NOT NULL,
        facts_after  INTEGER NOT NULL
      );
    `);

    migrateProactive(this.#db);
    migrateDev(this.#db);
  }

  /**
   * The connection the proactive tables sit on.
   *
   * Named for what it is for rather than exposed as a general `db`, because the
   * point is that observations and facts share one file: one write-ahead log,
   * one lock, one thing for `backupTo` to copy.
   */
  proactiveConnection(): DatabaseSync {
    return this.#db;
  }

  /**
   * The same connection, for the tables that record what JARVIS built for
   * himself. Named separately for the same reason: what shares a file should
   * say so at the call site.
   */
  devConnection(): DatabaseSync {
    return this.#db;
  }

  /** How much the proactive side has accumulated. */
  proactiveCounts(): ReturnType<typeof proactiveCounts> {
    return proactiveCounts(this.#db);
  }

  /**
   * Records that a scheduled job ran, so its absence is noticeable.
   *
   * On the store rather than left to each job's own bookkeeping, because a job
   * that has to remember to open a database in order to say it worked is a job
   * that will one day stop saying it.
   */
  beat(name: string, ok: boolean, detail = ""): void {
    beat(this.#db, name, ok, detail);
  }

  /** One stored value by key, or null when it was never set. */
  setting(key: string): string | null {
    const row = this.#db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Sets or replaces one stored value. */
  setSetting(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  /** Adds a fact, or updates the existing one on the same subject and kind. */
  remember(input: {
    kind: FactKind;
    subject: string;
    body: string;
    core?: boolean;
    source?: "owner" | "jarvis";
    /** What replaced the old wording, for the revision this update leaves behind. */
    reason?: RevisionReason;
  }): Fact {
    const now = new Date().toISOString();
    const subject = input.subject.trim().toLowerCase();

    const existing = this.#db
      .prepare("SELECT * FROM facts WHERE lower(subject) = ? AND kind = ?")
      .get(subject, input.kind) as unknown as FactRow | undefined;

    if (existing !== undefined) {
      const body = input.body.trim();
      if (body !== existing.body) {
        this.#snapshot(toFact(existing), input.reason ?? "rewritten");
      }
      this.#db
        .prepare("UPDATE facts SET body = ?, core = ?, updated_at = ? WHERE id = ?")
        .run(body, input.core === true ? 1 : existing.core, now, existing.id);
      return this.byId(existing.id)!;
    }

    const result = this.#db
      .prepare(
        `INSERT INTO facts (kind, subject, body, core, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.subject.trim(),
        input.body.trim(),
        input.core === true ? 1 : 0,
        input.source ?? "owner",
        now,
        now,
      );

    return this.byId(Number(result.lastInsertRowid))!;
  }

  /**
   * Sets or clears the core flag.
   *
   * remember() upserts and can only ever raise the flag — lowering it there would
   * make an update that omits `core` silently demote a fact. So demotion gets its
   * own call rather than a delete-and-reinsert, which would lose the id, the
   * creation date and the hit count.
   */
  setCore(id: number, core: boolean): Fact | null {
    const changed = this.#db
      .prepare("UPDATE facts SET core = ?, updated_at = ? WHERE id = ?")
      .run(core ? 1 : 0, new Date().toISOString(), id).changes;
    return changed > 0 ? this.byId(id) : null;
  }

  /** Rewrites the text of a fact, keeping everything else about it. */
  setBody(id: number, body: string, reason: RevisionReason = "rewritten"): Fact | null {
    const current = this.byId(id);
    if (current === null) return null;
    if (current.body !== body.trim()) this.#snapshot(current, reason);

    const changed = this.#db
      .prepare("UPDATE facts SET body = ?, updated_at = ? WHERE id = ?")
      .run(body.trim(), new Date().toISOString(), id).changes;
    return changed > 0 ? this.byId(id) : null;
  }

  /** Stores the embedding for a fact. */
  setVector(id: number, vector: Uint8Array): void {
    this.#db.prepare("UPDATE facts SET vec = ? WHERE id = ?").run(vector, id);
  }

  /**
   * Throws away the embedding of a fact whose wording changed.
   *
   * A stale vector is worse than none: the fact still turns up, but for the
   * question its old wording answered. `withoutVectors` picks it back up.
   */
  clearVector(id: number): void {
    this.#db.prepare("UPDATE facts SET vec = NULL WHERE id = ?").run(id);
  }

  /** Every fact that has an embedding, for a similarity sweep. */
  vectors(): Array<{ id: number; vec: Uint8Array }> {
    return this.#db
      .prepare("SELECT id, vec FROM facts WHERE vec IS NOT NULL")
      .all() as unknown as Array<{ id: number; vec: Uint8Array }>;
  }

  /** Facts still missing an embedding, so they can be backfilled. */
  withoutVectors(limit = 500): Fact[] {
    const rows = this.#db
      .prepare("SELECT * FROM facts WHERE vec IS NULL LIMIT ?")
      .all(limit) as unknown as FactRow[];
    return rows.map(toFact);
  }

  /** Looks several facts up at once, for merging ranked results. */
  byIds(ids: number[]): Fact[] {
    if (ids.length === 0) return [];
    const rows = this.#db
      .prepare(`SELECT * FROM facts WHERE id IN (${ids.map(Number).join(",")})`)
      .all() as unknown as FactRow[];
    return rows.map(toFact);
  }

  /** The fact filed under exactly this subject and kind, if there is one. */
  bySubject(subject: string, kind: FactKind): Fact | null {
    const row = this.#db
      .prepare("SELECT * FROM facts WHERE lower(subject) = ? AND kind = ?")
      .get(subject.trim().toLowerCase(), kind) as unknown as FactRow | undefined;
    return row === undefined ? null : toFact(row);
  }

  byId(id: number): Fact | null {
    const row = this.#db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as unknown as FactRow | undefined;
    return row === undefined ? null : toFact(row);
  }

  forget(id: number, reason: RevisionReason = "deleted"): boolean {
    const current = this.byId(id);
    if (current === null) return false;
    this.#snapshot(current, reason);
    return this.#db.prepare("DELETE FROM facts WHERE id = ?").run(id).changes > 0;
  }

  /** Files the fact as it reads now, before something replaces or removes it. */
  #snapshot(fact: Fact, reason: RevisionReason): void {
    this.#db
      .prepare(
        `INSERT INTO fact_revisions (fact_id, at, reason, kind, subject, body, core, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.id,
        new Date().toISOString(),
        reason,
        fact.kind,
        fact.subject,
        fact.body,
        fact.core ? 1 : 0,
        fact.source,
      );

    this.#db
      .prepare(
        `DELETE FROM fact_revisions
          WHERE fact_id = ?
            AND id NOT IN (SELECT id FROM fact_revisions WHERE fact_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(fact.id, fact.id, REVISIONS_PER_FACT);
  }

  /** How this fact used to read, newest first. */
  revisions(factId: number, limit = REVISIONS_PER_FACT): Revision[] {
    const rows = this.#db
      .prepare("SELECT * FROM fact_revisions WHERE fact_id = ? ORDER BY id DESC LIMIT ?")
      .all(factId, limit) as unknown as Array<Record<string, string | number>>;
    return rows.map(toRevision);
  }

  revisionById(id: number): Revision | null {
    const row = this.#db.prepare("SELECT * FROM fact_revisions WHERE id = ?").get(id) as unknown as
      | Record<string, string | number>
      | undefined;
    return row === undefined ? null : toRevision(row);
  }

  /**
   * The last thing each vanished fact said, newest first.
   *
   * Every removal files a snapshot, so the newest revision of a fact that no
   * longer exists is how it read when it went. Matching on the reason instead
   * would have missed exactly the case worth having: consolidation deletes under
   * its own reason, and that pass is the one nobody watched.
   */
  orphanRevisions(limit = 25): Revision[] {
    const rows = this.#db
      .prepare(
        `SELECT r.* FROM fact_revisions r
          WHERE r.id IN (SELECT max(id) FROM fact_revisions GROUP BY fact_id)
            AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = r.fact_id)
          ORDER BY r.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as Array<Record<string, string | number>>;
    return rows.map(toRevision);
  }

  /**
   * Puts a fact back the way a revision has it.
   *
   * A fact that still exists is rewritten, which files its current wording as a
   * revision of its own — undoing an undo is the same operation again. A fact that
   * was deleted comes back as a new row, and its revisions are moved onto the new
   * id so the history follows the fact rather than staying with a number nothing
   * points at any more.
   */
  restore(revisionId: number): Fact | null {
    const revision = this.revisionById(revisionId);
    if (revision === null) return null;

    const current = this.byId(revision.factId);
    if (current !== null) return this.setBody(current.id, revision.body);

    const fact = this.remember({
      kind: revision.kind,
      subject: revision.subject,
      body: revision.body,
      core: revision.core,
      source: revision.source,
    });
    this.#db
      .prepare("UPDATE fact_revisions SET fact_id = ? WHERE fact_id = ?")
      .run(fact.id, revision.factId);
    return fact;
  }

  /** Facts that ride along in every prompt. Kept short on purpose. */
  /**
   * Every core fact, in the order they were first written down.
   *
   * There used to be a limit of 25 here, and an order of most-recently-changed.
   * Both were wrong in the same direction. A fact earns its place in the core by
   * being foundational, and the most foundational ones -- who lives in this
   * house -- are exactly the ones nothing ever rewrites, so ordering by
   * `updated_at` sank them to the bottom and the limit then dropped them off the
   * end. The house had 26 core facts and JARVIS was told 25 of them; the missing
   * one was the residents.
   *
   * The order is also part of the system prompt. Oldest first is stable, where
   * most-recently-changed reshuffles the whole block every time any one fact is
   * touched, and pays for a fresh cached prefix to say the same thing.
   *
   * Nothing is dropped here. A core block that has grown too big is a curation
   * problem, and `coreBlock` says so out loud rather than hiding half of it.
   */
  core(): Fact[] {
    const rows = this.#db
      .prepare("SELECT * FROM facts WHERE core = 1 ORDER BY created_at ASC, id ASC")
      .all() as unknown as FactRow[];
    return rows.map(toFact);
  }

  all(limit = 200, offset = 0): Fact[] {
    const rows = this.#db
      .prepare("SELECT * FROM facts ORDER BY updated_at DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as FactRow[];
    return rows.map(toFact);
  }

  /**
   * Word search over subjects and bodies. Terms are OR-ed and ranked, so a
   * question phrased loosely still finds the fact it is reaching for.
   */
  search(query: string, limit = 8): Fact[] {
    const terms = query
      .toLowerCase()
      // Only letters and digits reach FTS5: its query syntax gives meaning to
      // much more than quotes and brackets, and a slash or a colon in a
      // sentence was a syntax error rather than a search.
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (terms.length === 0) return [];
    const match = terms.map((t) => `${t}*`).join(" OR ");

    const rows = this.#db
      .prepare(
        `SELECT f.* FROM facts_fts
           JOIN facts f ON f.id = facts_fts.rowid
          WHERE facts_fts MATCH ?
          ORDER BY bm25(facts_fts) LIMIT ?`,
      )
      .all(match, limit) as unknown as FactRow[];

    // Deliberately no hit counting here: searching is also what the memory panel
    // does while somebody scrolls through it, and that is not the fact being used.
    // Recall marks what it hands to the assistant, on both paths.
    return rows.map(toFact);
  }

  /** Records that these facts were actually recalled, just now. */
  markUsed(ids: number[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    this.#db.exec(
      `UPDATE facts SET hits = hits + 1, last_used_at = '${now}'
        WHERE id IN (${ids.map(Number).join(",")})`,
    );
  }

  /**
   * Records that these facts rode along as priming hints, just now.
   *
   * Deliberately not markUsed. Priming is a guess made before the assistant has
   * said a word, and nobody ever learns whether the hint was used — bumping
   * `hits` here made every hint count as "opgezocht" and inflated the signal
   * consolidation reads. Only the freshness date moves: enough
   * to keep a fact that priming keeps serving out of unusedSince, without it
   * looking better searched than it is.
   */
  markPrimed(ids: number[]): void {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    this.#db.exec(
      `UPDATE facts SET last_used_at = '${now}' WHERE id IN (${ids.map(Number).join(",")})`,
    );
  }

  /**
   * Facts nothing has asked for since a date, oldest first.
   *
   * What consolidation needs to tell a fact that is quietly wrong from one that
   * is simply about something that has not come up.
   */
  unusedSince(iso: string, limit = 50): Fact[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM facts
          WHERE core = 0 AND (last_used_at IS NULL OR last_used_at < ?) AND created_at < ?
          ORDER BY updated_at LIMIT ?`,
      )
      .all(iso, iso, limit) as unknown as FactRow[];
    return rows.map(toFact);
  }

  /** Records a completed exchange, for later distillation. Returns its id. */
  logTurn(sessionId: string | null, asked: string, answered: string): number {
    const result = this.#db
      .prepare("INSERT INTO turns (session_id, at, asked, answered) VALUES (?, ?, ?, ?)")
      .run(sessionId, new Date().toISOString(), asked, answered);
    return Number(result.lastInsertRowid);
  }

  /** Records which tools a turn used, and with what arguments. */
  recordToolCalls(turnId: number, calls: Array<{ name: string; input: string }>): void {
    if (calls.length === 0) return;
    const insert = this.#db.prepare("INSERT INTO turn_tools (turn_id, name, input) VALUES (?, ?, ?)");
    for (const call of calls) insert.run(turnId, call.name, call.input.slice(0, 400));
  }

  /**
   * Exchanges that used at least one tool, with those tools, newest first.
   *
   * The raw material for recipes: a question and the calls it took to answer it.
   * Turns that used nothing are left out — they were already answered from what
   * JARVIS carries, and there is no procedure to learn from them.
   */
  toolTurns(since: string, limit = 200): Array<{ asked: string; tools: string[] }> {
    const rows = this.#db
      .prepare(
        `SELECT t.id, t.asked, tt.name, tt.input
           FROM turns t JOIN turn_tools tt ON tt.turn_id = t.id
          WHERE t.at >= ? ORDER BY t.id DESC LIMIT ?`,
      )
      .all(since, limit * 4) as unknown as Array<{
      id: number;
      asked: string;
      name: string;
      input: string;
    }>;

    const byTurn = new Map<number, { asked: string; tools: string[] }>();
    for (const row of rows) {
      const entry = byTurn.get(row.id) ?? { asked: row.asked, tools: [] };
      entry.tools.push(`${row.name}(${row.input})`);
      byTurn.set(row.id, entry);
    }
    return [...byTurn.values()].slice(0, limit);
  }

  /** Replaces the whole set of recipes with a freshly learned one. */
  replaceRecipes(recipes: Array<{ pattern: string; recipe: string }>): void {
    const now = new Date().toISOString();
    this.#db.exec("DELETE FROM recipes");
    const insert = this.#db.prepare(
      "INSERT INTO recipes (pattern, recipe, updated_at) VALUES (?, ?, ?)",
    );
    for (const entry of recipes) insert.run(entry.pattern.trim(), entry.recipe.trim(), now);
  }

  /** What JARVIS has learned about how his own questions get answered. */
  recipes(limit = 12): Array<{ pattern: string; recipe: string }> {
    return this.#db
      .prepare("SELECT pattern, recipe FROM recipes ORDER BY id LIMIT ?")
      .all(limit) as unknown as Array<{ pattern: string; recipe: string }>;
  }

  /** Exchanges that no distillation pass has looked at yet. */
  pendingTurns(limit = 40): Array<{ id: number; at: string; asked: string; answered: string }> {
    return this.#db
      .prepare("SELECT id, at, asked, answered FROM turns WHERE distilled = 0 ORDER BY id LIMIT ?")
      .all(limit) as unknown as Array<{ id: number; at: string; asked: string; answered: string }>;
  }

  markDistilled(ids: number[]): void {
    if (ids.length === 0) return;
    this.#db.exec(`UPDATE turns SET distilled = 1 WHERE id IN (${ids.map(Number).join(",")})`);
  }

  /**
   * Conversations that ended without anyone distilling them.
   *
   * Turns from before this existed carry no session id; they are grouped under
   * one null session so a sweep still picks them up.
   */
  pendingSessions(): Array<{ sessionId: string | null; turns: number }> {
    const rows = this.#db
      .prepare(
        `SELECT session_id, count(*) AS n FROM turns
          WHERE distilled = 0 GROUP BY session_id ORDER BY min(id)`,
      )
      .all() as unknown as Array<{ session_id: string | null; n: number }>;
    return rows.map((row) => ({ sessionId: row.session_id, turns: Number(row.n) }));
  }

  /** The undistilled exchanges of one conversation, oldest first. */
  pendingTurnsFor(
    sessionId: string | null,
    limit = 200,
  ): Array<{ id: number; at: string; asked: string; answered: string }> {
    const sql =
      sessionId === null
        ? "SELECT id, at, asked, answered FROM turns WHERE distilled = 0 AND session_id IS NULL ORDER BY id LIMIT ?"
        : "SELECT id, at, asked, answered FROM turns WHERE distilled = 0 AND session_id = ? ORDER BY id LIMIT ?";
    const args = sessionId === null ? [limit] : [sessionId, limit];
    return this.#db.prepare(sql).all(...args) as unknown as Array<{
      id: number;
      at: string;
      asked: string;
      answered: string;
    }>;
  }

  /** Stores what a conversation was about, so "waar hadden we het over" has an answer. */
  recordSession(input: {
    id: string;
    startedAt: string;
    endedAt: string;
    turns: number;
    summary: string;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (id, started_at, ended_at, turns, summary)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at,
                                       turns = excluded.turns,
                                       summary = excluded.summary`,
      )
      .run(input.id, input.startedAt, input.endedAt, input.turns, input.summary.trim());

    this.#db.prepare("DELETE FROM sessions_fts WHERE session_id = ?").run(input.id);
    this.#db
      .prepare("INSERT INTO sessions_fts (session_id, summary) VALUES (?, ?)")
      .run(input.id, input.summary.trim());
  }

  /** The last conversations, newest first. */
  recentSessions(limit = 10): Session[] {
    const rows = this.#db
      .prepare("SELECT * FROM sessions ORDER BY ended_at DESC LIMIT ?")
      .all(limit) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** Word search over what conversations were about. */
  searchSessions(query: string, limit = 5): Session[] {
    const terms = query
      .toLowerCase()
      // Only letters and digits reach FTS5: its query syntax gives meaning to
      // much more than quotes and brackets, and a slash or a colon in a
      // sentence was a syntax error rather than a search.
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (terms.length === 0) return [];
    const match = terms.map((t) => `${t}*`).join(" OR ");

    const ids = this.#db
      .prepare("SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?")
      .all(match, limit) as unknown as Array<{ session_id: string }>;
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const rows = this.#db
      .prepare(`SELECT * FROM sessions WHERE id IN (${placeholders}) ORDER BY ended_at DESC`)
      .all(...ids.map((row) => row.session_id)) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /**
   * Records that the owner rejected or rewrote something in memory.
   *
   * Only his corrections belong here. Consolidation also deletes facts, but that
   * is memory tidying itself up, and feeding it back as a lesson would teach the
   * distiller to write less of what it was right about.
   */
  recordCorrection(input: {
    action: "deleted" | "rewritten";
    fact: Fact;
    after?: string;
  }): void {
    this.#db
      .prepare(
        `INSERT INTO corrections (at, action, kind, subject, before, after)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        input.action,
        input.fact.kind,
        input.fact.subject,
        input.fact.body,
        input.after ?? null,
      );
  }

  /** The last corrections, newest first. */
  recentCorrections(limit = 12): Correction[] {
    const rows = this.#db
      .prepare("SELECT * FROM corrections ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: Number(row["id"]),
      at: String(row["at"]),
      action: String(row["action"]) === "deleted" ? "deleted" : "rewritten",
      kind: String(row["kind"]),
      subject: String(row["subject"]),
      before: String(row["before"]),
      after: row["after"] === null ? null : String(row["after"]),
    }));
  }

  /** Writes down what one call to the model cost. */
  recordUsage(entry: UsageEntry): void {
    this.#db
      .prepare(
        `INSERT INTO usage (at, kind, session_id, model, input_tokens, output_tokens,
                            cache_read, cache_write, cost_usd, duration_ms, first_text_ms, tool_calls)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Date().toISOString(),
        entry.kind,
        entry.sessionId,
        entry.model,
        Math.round(entry.inputTokens),
        Math.round(entry.outputTokens),
        Math.round(entry.cacheRead),
        Math.round(entry.cacheWrite),
        entry.costUsd,
        entry.durationMs === null ? null : Math.round(entry.durationMs),
        entry.firstTextMs === null ? null : Math.round(entry.firstTextMs),
        Math.round(entry.toolCalls),
      );
  }

  /**
   * Totals per kind of call since a moment.
   *
   * The medians are computed in JavaScript over the durations of that kind: SQLite
   * has no percentile function, and at a few thousand rows a week sorting them here
   * is cheaper than a window-function query would be to read.
   */
  usageTotals(since: string): UsageTotals[] {
    const rows = this.#db
      .prepare(
        `SELECT kind,
                count(*)            AS calls,
                sum(input_tokens)   AS input_tokens,
                sum(output_tokens)  AS output_tokens,
                sum(cache_read)     AS cache_read,
                sum(cache_write)    AS cache_write,
                sum(cost_usd)       AS cost_usd
           FROM usage WHERE at >= ? GROUP BY kind ORDER BY cost_usd DESC`,
      )
      .all(since) as unknown as Array<Record<string, number | string | null>>;

    return rows.map((row) => {
      const kind = String(row["kind"]) as UsageKind;
      return {
        kind,
        calls: Number(row["calls"] ?? 0),
        inputTokens: Number(row["input_tokens"] ?? 0),
        outputTokens: Number(row["output_tokens"] ?? 0),
        cacheRead: Number(row["cache_read"] ?? 0),
        cacheWrite: Number(row["cache_write"] ?? 0),
        costUsd: Number(row["cost_usd"] ?? 0),
        medianMs: this.#median(since, kind, "duration_ms"),
        medianFirstTextMs: this.#median(since, kind, "first_text_ms"),
      };
    });
  }

  #median(since: string, kind: UsageKind, column: "duration_ms" | "first_text_ms"): number | null {
    const rows = this.#db
      .prepare(
        `SELECT ${column} AS v FROM usage
          WHERE at >= ? AND kind = ? AND ${column} IS NOT NULL ORDER BY ${column}`,
      )
      .all(since, kind) as unknown as Array<{ v: number }>;
    if (rows.length === 0) return null;
    const middle = Math.floor(rows.length / 2);
    if (rows.length % 2 === 1) return Math.round(rows[middle]!.v);
    return Math.round((rows[middle - 1]!.v + rows[middle]!.v) / 2);
  }

  /** The most recent metered calls, newest first. */
  usageRecent(limit = 50): Array<UsageEntry & { id: number; at: string }> {
    const rows = this.#db
      .prepare("SELECT * FROM usage ORDER BY id DESC LIMIT ?")
      .all(limit) as unknown as Array<Record<string, number | string | null>>;

    return rows.map((row) => ({
      id: Number(row["id"]),
      at: String(row["at"]),
      kind: String(row["kind"]) as UsageKind,
      sessionId: row["session_id"] === null ? null : String(row["session_id"]),
      model: row["model"] === null ? null : String(row["model"]),
      inputTokens: Number(row["input_tokens"] ?? 0),
      outputTokens: Number(row["output_tokens"] ?? 0),
      cacheRead: Number(row["cache_read"] ?? 0),
      cacheWrite: Number(row["cache_write"] ?? 0),
      costUsd: Number(row["cost_usd"] ?? 0),
      durationMs: row["duration_ms"] === null ? null : Number(row["duration_ms"]),
      firstTextMs: row["first_text_ms"] === null ? null : Number(row["first_text_ms"]),
      toolCalls: Number(row["tool_calls"] ?? 0),
    }));
  }

  /**
   * Writes a consistent copy of the database to a new file.
   *
   * `VACUUM INTO` runs inside a read transaction, so the copy is a single point in
   * time even while a conversation is writing, and it folds the write-ahead log in
   * rather than leaving it behind — the -wal file here is routinely ten times the
   * database, and a copy without it would be missing the newest facts.
   */
  backupTo(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    this.#db.prepare("VACUUM INTO ?").run(path);
  }

  counts(): { facts: number; core: number; turns: number } {
    const one = (sql: string): number =>
      Number((this.#db.prepare(sql).get() as unknown as { n: number } | undefined)?.n ?? 0);
    return {
      facts: one("SELECT count(*) AS n FROM facts"),
      core: one("SELECT count(*) AS n FROM facts WHERE core = 1"),
      turns: one("SELECT count(*) AS n FROM turns"),
    };
  }

  /** The hash of a note as it read when it was last ingested. */
  corpusHash(path: string): string | null {
    const row = this.#db
      .prepare("SELECT hash FROM corpus_files WHERE path = ?")
      .get(path) as unknown as { hash: string } | undefined;
    return row === undefined ? null : row.hash;
  }

  /** Every note that has been ingested, so vanished ones can be noticed. */
  corpusPaths(): string[] {
    const rows = this.#db.prepare("SELECT path FROM corpus_files ORDER BY path").all() as unknown as Array<{
      path: string;
    }>;
    return rows.map((row) => row.path);
  }

  /** The facts a note is currently answerable for. */
  corpusFactIds(path: string): number[] {
    const rows = this.#db
      .prepare("SELECT fact_id FROM corpus_facts WHERE path = ?")
      .all(path) as unknown as Array<{ fact_id: number }>;
    return rows.map((row) => Number(row.fact_id));
  }

  /** How many notes claim this fact. Zero means nobody vouches for it any more. */
  corpusClaims(factId: number): number {
    const row = this.#db
      .prepare("SELECT count(*) AS n FROM corpus_facts WHERE fact_id = ?")
      .get(factId) as unknown as { n: number };
    return Number(row.n);
  }

  /** Records a note and exactly which facts it produced this time round. */
  recordCorpusFile(path: string, hash: string, factIds: number[]): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO corpus_files (path, hash, ingested_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, ingested_at = excluded.ingested_at`,
      )
      .run(path, hash, now);
    this.#db.prepare("DELETE FROM corpus_facts WHERE path = ?").run(path);
    const claim = this.#db.prepare("INSERT OR IGNORE INTO corpus_facts (path, fact_id) VALUES (?, ?)");
    for (const id of factIds) claim.run(path, id);
  }

  /** Drops every claim on a fact, for when the fact itself is gone. */
  releaseCorpusFact(factId: number): void {
    this.#db.prepare("DELETE FROM corpus_facts WHERE fact_id = ?").run(factId);
  }

  /**
   * Records what a nightly pass did.
   *
   * Keyed on the moment it finished, so a pass run twice by hand in the same
   * second cannot make two rows that claim to be the same run -- and so a
   * re-run of an interrupted night overwrites its own row rather than doubling
   * the week's totals.
   */
  recordCorpusRun(run: CorpusRun): void {
    this.#db
      .prepare(
        `INSERT INTO corpus_runs
           (at, scanned, read, written, skipped, retired, gone, failed, facts_before, facts_after)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(at) DO UPDATE SET
           scanned = excluded.scanned, read = excluded.read, written = excluded.written,
           skipped = excluded.skipped, retired = excluded.retired, gone = excluded.gone,
           failed = excluded.failed, facts_before = excluded.facts_before,
           facts_after = excluded.facts_after`,
      )
      .run(
        run.at,
        run.scanned,
        run.read,
        run.written,
        run.skipped,
        run.retired,
        run.gone,
        run.failed,
        run.factsBefore,
        run.factsAfter,
      );
  }

  /**
   * The notes read after a given moment, most recent first.
   *
   * A run's counts say how much changed; this says what about. Derived from the
   * note's own timestamp rather than stored per run, because the note table
   * already carries when it was last read and two sources for one fact drift.
   */
  corpusFilesSince(iso: string, limit = 12): Array<{ path: string; ingestedAt: string }> {
    const rows = this.#db
      .prepare(
        "SELECT path, ingested_at FROM corpus_files WHERE ingested_at > ? ORDER BY ingested_at DESC LIMIT ?",
      )
      .all(iso, limit) as unknown as Array<{ path: string; ingested_at: string }>;
    return rows.map((row) => ({ path: row.path, ingestedAt: row.ingested_at }));
  }

  /** The most recent passes, newest first. */
  corpusRuns(limit = 7): CorpusRun[] {
    const rows = this.#db
      .prepare("SELECT * FROM corpus_runs ORDER BY at DESC LIMIT ?")
      .all(limit) as unknown as CorpusRunRow[];
    return rows.map(toCorpusRun);
  }

  /** The passes that finished after a given moment, newest first. */
  corpusRunsSince(iso: string): CorpusRun[] {
    const rows = this.#db
      .prepare("SELECT * FROM corpus_runs WHERE at > ? ORDER BY at DESC")
      .all(iso) as unknown as CorpusRunRow[];
    return rows.map(toCorpusRun);
  }

  /** Forgets a note ever existed. The facts it claimed are left to the caller. */
  dropCorpusFile(path: string): void {
    this.#db.prepare("DELETE FROM corpus_facts WHERE path = ?").run(path);
    this.#db.prepare("DELETE FROM corpus_files WHERE path = ?").run(path);
  }

  /**
   * Folds the write-ahead log into the database and shortens the file.
   *
   * Returns whether another connection was in the way. See `checkpoint.ts` for
   * why this is worth doing at all when SQLite already checkpoints itself.
   */
  checkpoint(): boolean {
    const row = this.#db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as unknown as
      | { busy: number }
      | undefined;
    return Number(row?.busy ?? 0) === 1;
  }

  close(): void {
    this.#db.close();
  }
}

let instance: MemoryStore | null = null;

export function memory(path: string): MemoryStore {
  instance ??= new MemoryStore(path);
  return instance;
}
