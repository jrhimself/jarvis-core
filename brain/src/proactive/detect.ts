/**
 * Turning a stream of findings into a short list of things that are wrong.
 *
 * The rules are stateless and honest to a fault: run them every hour and the
 * same cold hot tub is reported forty-seven times. Measured over two days of
 * the real house, 410 findings described 17 conditions. This is where the 410
 * becomes 17.
 *
 * Four brakes, all of them in code rather than in a prompt, because a false
 * positive costs more than silence and a prompt cannot be relied on to count.
 *
 *   dedupe       one open row per fingerprint, enforced by a partial unique
 *                index rather than by remembering to check
 *   persistence  a condition is not ripe until it has held for N hours, and N
 *                depends on the rule -- a water leak has waited long enough
 *   cooldown     a condition that has just been resolved is not reopened for
 *                some hours, so a flapping sensor is one finding and not twelve
 *   cap          a hard ceiling on how many new conditions a single rule may
 *                open in a day
 *
 * Nothing is said to anybody here. An open anomaly is a note in a table; who
 * reads it back is somebody else's problem.
 */

import type { DatabaseSync } from "node:sqlite";

import type { HomeProvider } from "@jarvis/shared";

import type { Config } from "../config.js";
import type { Phrase } from "./phrases.js";
import type { Finding, RuleName } from "./rules.js";
import { HOUSE_RULES, SELF_RULES, collect, evaluate } from "./rules.js";
import { inspect, judge } from "./self.js";
import { pruneMetrics } from "./store.js";
import type { Watchlist } from "./watchlist.js";

const HOUR_MS = 3600_000;

/**
 * How many hours a condition must hold before it is worth anyone's attention.
 *
 * Per rule, because the rules do not carry the same weight of evidence. A
 * deviation is one hour of one number and could be a meter reading late; a
 * stuck sensor has already been silent for a day by the time the rule sees it,
 * and a problem sensor exists for no other purpose than to be believed at once.
 */
const PERSISTENCE: Record<RuleName, number> = {
  deviation: 2,
  missing: 2,
  stuck: 1,
  problem: 1,
  // A job is already half an interval past due by the time the rule sees it.
  heartbeat: 1,
  // Two hours, because several of these are momentarily true in normal
  // operation: a deploy leaves the working copy behind for a minute, a restart
  // leaves the observation feed empty, and neither is worth a word.
  invariant: 2,
};

/**
 * How long a condition must be absent before it is called over.
 *
 * Not one hour. A sensor sitting exactly on a threshold would otherwise open
 * and close all night, and each reopening is a new row. Three hours of quiet is
 * a condition that has actually stopped.
 */
const CLOSE_AFTER_HOURS = 3;

/** And how long after that before the same condition may open again. */
const COOLDOWN_HOURS = 6;

/**
 * The most new conditions one rule may open in a day.
 *
 * A ceiling, not a target. The case it exists for is an integration falling
 * over and taking thirty sensors with it: the first ten say everything the
 * thirty would have, and the count of what was dropped is logged so the
 * ceiling is never silently the reason nothing was noticed.
 */
const MAX_NEW_PER_RULE_PER_DAY = 10;

/** Every rule there is, for a pass that ran all of them. */
const ALL_RULES: RuleName[] = [...HOUSE_RULES, ...SELF_RULES];

export interface DetectReport {
  /** What the rules said, before any of it was filtered. */
  findings: number;
  opened: number;
  updated: number;
  resolved: number;
  /** Held back by a cooldown or by the daily cap. */
  suppressed: number;
  /** Open conditions that have now held long enough to count. */
  ripe: number;
}

/** One open condition, as anything downstream wants to read it. */
export interface OpenAnomaly {
  id: number;
  fingerprint: string;
  subject: string;
  rule: RuleName;
  watchGroup: string;
  area: string | null;
  firstAt: string;
  lastAt: string;
  buckets: number;
  observed: number | null;
  expected: number | null;
  deviation: number | null;
  detail: string;
  /** The sentence as a key and its values, when the rule wrote one. */
  phrase: Phrase | null;
  ripe: boolean;
}

interface AnomalyRow {
  id: number;
  fingerprint: string;
  subject: string;
  rule: string;
  watch_group: string;
  area: string | null;
  first_at: string;
  last_at: string;
  buckets: number;
  observed: number | null;
  expected: number | null;
  deviation: number | null;
  detail: string;
  phrase: string | null;
}

/** The stored phrase, or null when the row predates the column or is not JSON. */
function readPhrase(stored: string | null): Phrase | null {
  if (stored === null || stored === "") return null;
  try {
    const parsed = JSON.parse(stored) as Phrase;
    return typeof parsed.key === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function toOpenAnomaly(row: AnomalyRow): OpenAnomaly {
  const rule = row.rule as RuleName;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    subject: row.subject,
    rule,
    watchGroup: row.watch_group,
    area: row.area,
    firstAt: row.first_at,
    lastAt: row.last_at,
    buckets: row.buckets,
    observed: row.observed,
    expected: row.expected,
    deviation: row.deviation,
    detail: row.detail,
    phrase: readPhrase(row.phrase),
    ripe: row.buckets >= (PERSISTENCE[rule] ?? 1),
  };
}

/** Every condition currently open, worst-established first. */
export function openAnomalies(db: DatabaseSync, limit = 50): OpenAnomaly[] {
  const rows = db
    .prepare(
      `SELECT id, fingerprint, subject, rule, watch_group, area, first_at, last_at,
              buckets, observed, expected, deviation, detail, phrase
       FROM anomalies WHERE status = 'open'
       ORDER BY buckets DESC, last_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as AnomalyRow[];
  return rows.map(toOpenAnomaly);
}

/** The phrase as it is stored, or null for a rule that wrote none. */
function writePhrase(finding: Finding): string | null {
  return finding.phrase === undefined ? null : JSON.stringify(finding.phrase);
}

/** Whether this condition was resolved too recently to be reopened. */
function inCooldown(db: DatabaseSync, fingerprint: string, now: Date): boolean {
  const row = db
    .prepare(
      "SELECT MAX(resolved_at) AS at FROM anomalies WHERE fingerprint = ? AND status = 'resolved'",
    )
    .get(fingerprint) as unknown as { at: string | null } | undefined;
  if (row?.at == null) return false;
  return now.getTime() - new Date(row.at).getTime() < COOLDOWN_HOURS * HOUR_MS;
}

/** How many conditions this rule has already opened today. */
function openedToday(db: DatabaseSync, rule: RuleName, now: Date): number {
  const row = db
    .prepare("SELECT count(*) AS n FROM anomalies WHERE rule = ? AND first_at >= ?")
    .get(rule, new Date(now.getTime() - 24 * HOUR_MS).toISOString()) as unknown as
    | { n: number }
    | undefined;
  return Number(row?.n ?? 0);
}

/**
 * Writes this hour's findings against what is already open.
 *
 * One transaction, because a half-reconciled table would double-count the next
 * time round: a condition updated but not closed reads as still holding.
 */
export function reconcile(
  db: DatabaseSync,
  findings: Finding[],
  now: Date,
  /**
   * Which rules this pass is allowed to close conditions for.
   *
   * A pass only knows about the rules it ran. The self checks run every hour
   * whether or not Home Assistant answered, and if they were allowed to close
   * everything, an unreachable house would quietly resolve every condition in
   * it -- the exact failure that made these checks necessary.
   */
  rules: RuleName[] = ALL_RULES,
): DetectReport {
  const at = now.toISOString();
  const report: DetectReport = {
    findings: findings.length,
    opened: 0,
    updated: 0,
    resolved: 0,
    suppressed: 0,
    ripe: 0,
  };

  const open = new Map(
    (
      db
        .prepare("SELECT id, fingerprint, buckets FROM anomalies WHERE status = 'open'")
        .all() as unknown as Array<{ id: number; fingerprint: string; buckets: number }>
    ).map((row) => [row.fingerprint, row]),
  );

  const budget = new Map<RuleName, number>();
  const dropped = new Map<RuleName, number>();

  db.exec("BEGIN");
  try {
    for (const finding of findings) {
      const existing = open.get(finding.fingerprint);
      if (existing !== undefined) {
        // Refreshed rather than merely counted: the newest reading is the one
        // worth quoting, and `first_at` still says how long it has held.
        db.prepare(
          `UPDATE anomalies
           SET last_at = ?, buckets = buckets + 1, observed = ?, expected = ?,
               deviation = ?, detail = ?, phrase = ?
           WHERE id = ?`,
        ).run(
          at,
          finding.observed,
          finding.expected,
          finding.deviation,
          finding.detail,
          writePhrase(finding),
          existing.id,
        );
        report.updated += 1;
        continue;
      }

      if (inCooldown(db, finding.fingerprint, now)) {
        report.suppressed += 1;
        continue;
      }

      let used = budget.get(finding.rule);
      if (used === undefined) {
        used = openedToday(db, finding.rule, now);
        budget.set(finding.rule, used);
      }
      if (used >= MAX_NEW_PER_RULE_PER_DAY) {
        dropped.set(finding.rule, (dropped.get(finding.rule) ?? 0) + 1);
        report.suppressed += 1;
        continue;
      }
      budget.set(finding.rule, used + 1);

      db.prepare(
        `INSERT INTO anomalies
           (fingerprint, subject, rule, watch_group, area, first_at, last_at, buckets,
            observed, expected, deviation, detail, phrase, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'open')`,
      ).run(
        finding.fingerprint,
        finding.subject,
        finding.rule,
        finding.watchGroup,
        finding.area,
        at,
        at,
        finding.observed,
        finding.expected,
        finding.deviation,
        finding.detail,
        writePhrase(finding),
      );
      report.opened += 1;
    }

    const placeholders = rules.map(() => "?").join(", ");
    const stale = db
      .prepare(
        `UPDATE anomalies SET status = 'resolved', resolved_at = ?
         WHERE status = 'open' AND last_at < ? AND rule IN (${placeholders})`,
      )
      .run(at, new Date(now.getTime() - CLOSE_AFTER_HOURS * HOUR_MS).toISOString(), ...rules);
    report.resolved = Number(stale.changes);

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  for (const [rule, n] of dropped) {
    console.warn(`proactive: ${rule} hit its daily ceiling, ${n} new conditions not opened`);
  }

  report.ripe = openAnomalies(db).filter((anomaly) => anomaly.ripe).length;
  return report;
}

/** One pass: ask the house, ask the rules, write down what changed. */
export async function detect(
  home: HomeProvider,
  db: DatabaseSync,
  watchlist: Watchlist,
  states: Map<string, string>,
  now = new Date(),
): Promise<DetectReport> {
  const snapshot = await collect(home, watchlist, states, now);
  return reconcile(db, evaluate(db, watchlist, snapshot), now, HOUSE_RULES);
}

/**
 * How long a sample of one of JARVIS's own numbers is kept.
 *
 * A fortnight: long enough that a week of drift is visible, short enough that
 * the table stays a few thousand rows and never becomes a thing to prune by
 * hand.
 */
const METRIC_DAYS = 14;

/** The same pass, turned on JARVIS himself. Needs no socket, so it always runs. */
export async function introspect(
  db: DatabaseSync,
  config: Config,
  watchlistSize: number | null,
  now = new Date(),
): Promise<DetectReport> {
  const reading = await inspect(db, config, watchlistSize, now);
  const report = reconcile(db, judge(reading, now), now, SELF_RULES);
  pruneMetrics(db, METRIC_DAYS, now);
  return report;
}

/**
 * Milliseconds until the next time the clock reads this many minutes past.
 *
 * Past the hour rather than on it, because Home Assistant writes an hourly
 * statistic a little after the hour it describes and asking too early gets a
 * silence that reads exactly like a sensor having nothing to say.
 */
export function untilMinutePastHour(minute: number, from = new Date()): number {
  const next = new Date(from);
  next.setMinutes(minute, 0, 0);
  if (next.getTime() <= from.getTime()) next.setTime(next.getTime() + HOUR_MS);
  return next.getTime() - from.getTime();
}
