/**
 * Four questions asked of the last complete hour.
 *
 * A rule takes what the house recorded, what the house normally does, and
 * returns findings. It does not write anything, it does not decide whether a
 * finding is worth mentioning, and it never calls a model -- reconciliation
 * decides that, and phrasing happens later still. What is here is comparison.
 *
 * The hour that just ended, not the hour in progress. A statistic for an hour
 * that is still happening is a fraction of a number, and an evening that has
 * not finished being quiet is not yet unusually quiet.
 *
 * The four:
 *
 *   deviation  a number far from what that hour of that weekday usually holds
 *   missing    an hour that is reliably busy and this time was not
 *   stuck      a sensor that normally changes and has not, for a day
 *   problem    a `device_class: problem` sensor saying there is one
 *
 * Only the last needs no history, which is why it is the only one that works on
 * the first day.
 */

import type { DatabaseSync } from "node:sqlite";

import type { HomeProvider } from "@jarvis/shared";

import { localSlot, mad, median } from "./baselines.js";
import type { Phrase } from "./phrases.js";
import { BUCKET_MS, COVERAGE_SUBJECT } from "./rollup.js";
import type { Watchlist } from "./watchlist.js";

/**
 * The modified z-score threshold, from Iglewicz and Hoaglin.
 *
 * 3,5 rather than the 3 a standard deviation would use, because the scaled MAD
 * is a tighter estimate of spread and the same number would fire more often.
 */
const Z_THRESHOLD = 3.5;

/** Turns a median absolute deviation into a standard-deviation equivalent. */
const MAD_TO_SIGMA = 1.4826;

/**
 * How much of a subject's usual variability an hour is allowed to borrow.
 *
 * An hour whose own spread is zero -- eight Tuesdays at 03:00 that all read
 * exactly the same -- would otherwise divide by nothing and call any change at
 * all infinitely surprising. Judging it instead against how much this sensor
 * varies across the whole week keeps a genuinely constant hour strict without
 * making it absurd.
 */
const BORROWED_SPREAD = 0.5;

/**
 * The smallest departure worth calling large, as a share of the week's swing.
 *
 * Borrowing spread from the other hours is not enough on its own. A disk
 * temperature that reads exactly 37 degrees every hour of every week has a
 * spread of zero *and* a borrowed spread of almost zero, because the borrowing
 * is from hours that are equally constant -- so a single degree came out at
 * fifty-two deviations. The sensor is not lying and the arithmetic is not
 * wrong; the distribution is quantised, and a quantised sensor has no spread to
 * measure until it happens to tick over.
 *
 * So a finding must also be large against how far this sensor travels in a
 * normal week. Fifteen per cent of that is a departure a person would notice.
 */
const MIN_SWING = 0.15;

/**
 * The smallest departure worth a person's attention, in the unit measured.
 *
 * A modified z-score says how surprising a number is against its own history.
 * It does not say whether the difference matters. A bedroom a degree cooler
 * than most Tuesdays at eight is a real statistical outlier and nothing anybody
 * wants to be told about, and over the first eleven days of running those were
 * four findings in every five: rooms drifting a degree, a disk drifting three.
 *
 * So a finding has to clear both -- unusual for this sensor, *and* far enough
 * in the unit to be worth a sentence. A unit class with no entry here has no
 * floor, because the number to put in it is a judgement about the thing being
 * measured, and inventing one for a unit nobody watches yet would be a guess.
 */
const ABSOLUTE_FLOOR = new Map<string, number>([
  // Three degrees. A room that far off is a window left open or heating that
  // never came on; two is afternoon sun falling on the sensor.
  ["temperature", 3],
  // Two tenths of a kilowatt-hour within one hour, which is about a load of
  // washing. Below that the reading is standby draw and rounding.
  ["energy", 0.2],
]);

/**
 * How large an ordinary hour must be, against the sensor's weekly swing, before
 * that sensor is holding a level rather than recording events.
 *
 * A solar inverter's lifetime counter is the case: its hours run from nothing to
 * thousands, and the median hour is a fraction of that. Nothing is wrong with
 * the number and there is no level in it to depart from -- what it records is
 * whether the sun was out.
 */
const EVENT_SHARE = 0.1;

/** Below this many observations of a slot, its median is not worth trusting. */
const MIN_SLOT_SAMPLES = 4;

/** Behavioural slots need fewer, because ten days is all there has ever been. */
const MIN_BEHAVIOUR_SAMPLES = 3;

/**
 * How busy an hour must usually be before its silence is worth remarking on.
 *
 * A quarter of an hour: fifteen minutes of the thing happening, week after
 * week, before none of it counts as an absence. The first threshold here was
 * two per cent -- seventy-two seconds -- on the reasoning that anything above
 * noise was evidence. A week of real hours said otherwise: every finding it
 * produced from a motion sensor or a door sat between three and seven per
 * cent, which is a baseline saying "occasionally", and an hour that is
 * occasionally something is not strange for being nothing.
 */
const MIN_EXPECTED_FRACTION = 0.25;

/**
 * And how busy is too busy for silence to mean anything.
 *
 * An entity active for every minute of an hour, week after week, is describing
 * a state rather than an event: a contact sensor on a door that stands open, a
 * tracker for a phone that never leaves the house. It falling to nothing is
 * that state changing, which is ordinary. The first one measured said "usually
 * active for 100% of this hour and was not active at all", and it was a door
 * being shut. A sensor that has genuinely stopped reporting belongs to `stuck`.
 *
 * Ninety per cent came from that single example. A week of hours found the same
 * kind of thing at seventy-seven and eighty-nine -- both doors that stand open
 * most of the hour and were shut for one of them -- so the line sits at three
 * quarters. What is left in between is the shape the rule was written for:
 * something that reliably happens for part of an hour, and this time did not.
 */
const MAX_EXPECTED_FRACTION = 0.75;

/**
 * Groups where an hour of nothing is a fault rather than a choice.
 *
 * `missing` asks why something that usually happens did not, and that question
 * only has an answer worth reading for things that act on their own. A person
 * who is not home is out; an air conditioner that is not running was turned
 * off; a problem sensor that is not firing is the good day this house was
 * hoping for. All three produced findings over a week, and none of them
 * described anything anyone could act on.
 *
 * So the rule names the groups it applies to rather than the ones it skips: a
 * group added later says nothing until somebody decides its silence means
 * something, which is the safe direction for a rule whose failure is noise.
 */
const MISSING_GROUPS = new Set(["motion", "openings"]);

/** An hour watched for less than half of itself is not evidence either way. */
const MIN_COVERAGE = 0.5;

/** How long a sensor may go without changing before it is presumed stuck. */
const STUCK_HOURS = 24;

/** And how reliably it must normally change for that silence to be strange. */
const MIN_DAILY_CHANGES = 4;

/** A day of it must have been watched, or a long outage reads as a dead sensor. */
const STUCK_COVERAGE = 0.8;

/**
 * Groups whose members are obeying rather than reporting.
 *
 * An air conditioner that has not changed in a day is not stuck; it is off,
 * because somebody turned it off. Measured on one air conditioner: it held for
 * eighteen of the first forty-eight hours the rule was swept over, and was the
 * only false positive in the set.
 */
const CONTROLLED_GROUPS = new Set(["climate"]);

/**
 * States that are not readings.
 *
 * Home Assistant does not have a value for these, and neither does the house.
 * They need no history to judge, which matters: a sensor that died before the
 * observation window opened has no rows at all, and every rule that works by
 * comparing rows would look straight past it. The case that produced this rule
 * was a window sensor that had read unavailable for weeks, invisible to every
 * other rule because it had stopped writing rows at all.
 */
const DEAD_STATES = new Set(["unavailable", "unknown"]);

const HOUR_MS = 3600_000;

export type RuleName = "deviation" | "missing" | "stuck" | "problem" | "heartbeat" | "invariant";

/** The rules that ask the house something. */
export const HOUSE_RULES: RuleName[] = ["deviation", "missing", "stuck", "problem"];

/**
 * The rules in `self.ts`, which ask JARVIS about himself.
 *
 * Separate because the two passes fail independently: the whole point of the
 * self checks is that they still run on an evening when Home Assistant cannot
 * be reached, and reconciling them together would let one pass close the
 * other's findings out of ignorance.
 */
export const SELF_RULES: RuleName[] = ["heartbeat", "invariant"];

/**
 * One thing worth a second look.
 *
 * `fingerprint` names the *condition*, not the moment: the same sensor stuck
 * for a second day is the same finding seen twice, which is what lets
 * reconciliation count how long it has persisted rather than reporting it hourly.
 */
export interface Finding {
  fingerprint: string;
  rule: RuleName;
  subject: string;
  watchGroup: string;
  area: string | null;
  observed: number | null;
  expected: number | null;
  deviation: number | null;
  detail: string;
  /**
   * The same sentence as a key and its values, for a reader who does not read
   * English. Optional: a rule that has not been given one still says its piece,
   * in the language this repository is written in.
   */
  phrase?: Phrase;
}

/** What the rules are given: the hour to judge, and what was true during it. */
export interface Snapshot {
  /** Start of the last complete hour. */
  hour: Date;
  /** Current state per watched entity, for the rules that ask about now. */
  states: Map<string, string>;
  /** That hour's value per statistic id. */
  statistics: Map<string, number>;
}

/** The start of the last hour that has finished. */
export function lastCompleteHour(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - HOUR_MS);
}

interface BaselineSlot {
  centre: number;
  spread: number;
  samples: number;
}

/** Baselines of one shape, as subject to weekday-and-hour. */
function loadBaselines(
  db: DatabaseSync,
  shape: "numeric" | "behavioural",
): Map<string, Map<string, BaselineSlot>> {
  const rows = db
    .prepare(
      "SELECT subject, weekday, hour, centre, spread, samples FROM baselines WHERE shape = ?",
    )
    .all(shape) as unknown as Array<{
    subject: string;
    weekday: number;
    hour: number;
    centre: number;
    spread: number;
    samples: number;
  }>;

  const result = new Map<string, Map<string, BaselineSlot>>();
  for (const row of rows) {
    let slots = result.get(row.subject);
    if (slots === undefined) {
      slots = new Map();
      result.set(row.subject, slots);
    }
    slots.set(`${row.weekday}:${row.hour}`, {
      centre: row.centre,
      spread: row.spread,
      samples: row.samples,
    });
  }
  return result;
}

/**
 * How much this subject varies at all, across every hour of the week.
 *
 * The median of the per-hour spreads, falling back to the spread of the hourly
 * medians themselves when every hour is individually constant but they differ
 * from each other -- a thermostat that holds each hour steady at a different
 * temperature has no within-hour variation and a great deal of daily shape.
 */
function subjectScale(slots: Map<string, BaselineSlot>): number {
  const spreads = [...slots.values()].map((slot) => slot.spread);
  const withinHour = median(spreads);
  if (withinHour > 0) return withinHour;

  const centres = [...slots.values()].map((slot) => slot.centre);
  return mad(centres, median(centres));
}

/**
 * How far this subject travels in a normal week: the full range of its hourly
 * medians, busiest hour to quietest.
 *
 * The full range and not a trimmed one, which is the opposite of the usual
 * advice and is right here because this number is only ever used as a floor. An
 * outlier can only make the floor higher, and a higher floor can only produce
 * silence -- never a false positive. Trimming it to the tenth and ninetieth
 * percentiles was tried first and collapsed on exactly the sensors that need
 * the floor most: a hot tub that draws nothing in nine hours out of ten has a
 * ninetieth percentile of nothing, which put an ordinary quiet hour at five
 * hundred and thirty-nine deviations.
 */
function weeklySwing(slots: Map<string, BaselineSlot>): number {
  const centres = [...slots.values()].map((slot) => slot.centre);
  if (centres.length === 0) return 0;
  return Math.max(...centres) - Math.min(...centres);
}

/** Numbers a long way from where that hour of that weekday usually sits. */
function deviations(db: DatabaseSync, watchlist: Watchlist, snapshot: Snapshot): Finding[] {
  const baselines = loadBaselines(db, "numeric");
  const slot = localSlot(snapshot.hour);
  const findings: Finding[] = [];

  for (const watched of watchlist.statistics) {
    const observed = snapshot.statistics.get(watched.meta.statisticId);
    if (observed === undefined) continue;

    const slots = baselines.get(watched.meta.statisticId);
    const expected = slots?.get(`${slot.weekday}:${slot.hour}`);
    if (slots === undefined || expected === undefined) continue;
    if (expected.samples < MIN_SLOT_SAMPLES) continue;

    // A sensor with no variation anywhere has nothing to deviate from, and any
    // threshold put on it would be a threshold on its unit rather than on its
    // behaviour.
    const swing = weeklySwing(slots);
    const typical = median([...slots.values()].map((candidate) => candidate.centre));
    const floor = ABSOLUTE_FLOOR.get(watched.meta.unitClass ?? "") ?? 0;

    // Two ways for a statistic to be recording events rather than holding a
    // level, and deviation is the wrong question to ask of either. Both were
    // measured on real appliances, and each one misses the other's case.
    //
    // Small beside its own week: the solar counter above -- see `EVENT_SHARE`.
    // A statistic that reads zero in every hour, as the dishwasher does,
    // fails this one too, which is the guard that case originally needed.
    if (typical <= EVENT_SHARE * swing) continue;
    // Small in absolute terms: the tumble dryer's meter draws two and a half
    // thousandths of a kilowatt-hour standing still and its median hour is that
    // in every one of the 168, because it does not run at the same hour twice.
    // Measured: a swing of 0.0002 kWh across the week, so the test above is
    // satisfied and any actual cycle still reads as impossible -- ten of the
    // ninety-two findings over eleven days, at z-scores near four thousand. If
    // the usual hour is smaller than the smallest departure worth mentioning,
    // there is no level in it to depart from.
    if (typical < floor) continue;

    const scale = Math.max(
      expected.spread,
      BORROWED_SPREAD * subjectScale(slots),
      MIN_SWING * swing,
    );
    if (scale <= 0) continue;

    // Surprising is not the same as worth saying -- see `ABSOLUTE_FLOOR`.
    if (Math.abs(observed - expected.centre) < floor) continue;

    const z = (observed - expected.centre) / (MAD_TO_SIGMA * scale);
    if (Math.abs(z) < Z_THRESHOLD) continue;

    const direction = z > 0 ? "high" : "low";
    findings.push({
      fingerprint: `deviation:${watched.meta.statisticId}:${direction}`,
      rule: "deviation",
      subject: watched.meta.statisticId,
      watchGroup: watched.group,
      area: null,
      observed,
      expected: expected.centre,
      deviation: z,
      detail:
        `${watched.meta.statisticId} read ${observed.toFixed(2)} ${watched.meta.unit ?? ""}`.trim() +
        `, against a usual ${expected.centre.toFixed(2)} for this hour (z ${z.toFixed(1)})`,
      phrase: {
        key: "deviation.reading",
        args: {
          subject: watched.meta.statisticId,
          reading: `${observed.toFixed(2)} ${watched.meta.unit ?? ""}`.trim(),
          usual: expected.centre.toFixed(2),
          z: z.toFixed(1),
        },
      },
    });
  }
  return findings;
}

interface HourTotals {
  coverage: number;
  active: Map<string, number>;
}

/** What the observations say about one hour. */
function hourTotals(db: DatabaseSync, hour: Date): HourTotals {
  const rows = db
    .prepare(
      `SELECT subject, SUM(active_ms) AS active_ms, SUM(observed_ms) AS observed_ms
       FROM observations WHERE bucket >= ? AND bucket < ? GROUP BY subject`,
    )
    .all(hour.toISOString(), new Date(hour.getTime() + HOUR_MS).toISOString()) as unknown as Array<{
    subject: string;
    active_ms: number;
    observed_ms: number;
  }>;

  const active = new Map<string, number>();
  let coverage = 0;
  for (const row of rows) {
    if (row.subject === COVERAGE_SUBJECT) coverage += row.observed_ms;
    else active.set(row.subject, row.active_ms);
  }
  return { coverage, active };
}

/** Hours that are reliably busy, and this time were not. */
function missing(db: DatabaseSync, watchlist: Watchlist, snapshot: Snapshot): Finding[] {
  const totals = hourTotals(db, snapshot.hour);
  if (totals.coverage < HOUR_MS * MIN_COVERAGE) return [];

  const baselines = loadBaselines(db, "behavioural");
  const slot = localSlot(snapshot.hour);
  const findings: Finding[] = [];

  for (const entity of watchlist.entities) {
    if (!MISSING_GROUPS.has(entity.group)) continue;

    const expected = baselines.get(entity.entityId)?.get(`${slot.weekday}:${slot.hour}`);
    if (expected === undefined) continue;
    if (expected.samples < MIN_BEHAVIOUR_SAMPLES) continue;
    if (expected.centre < MIN_EXPECTED_FRACTION) continue;
    if (expected.centre > MAX_EXPECTED_FRACTION) continue;

    const observed = (totals.active.get(entity.entityId) ?? 0) / totals.coverage;
    if (observed > 0) continue;

    findings.push({
      fingerprint: `missing:${entity.entityId}`,
      rule: "missing",
      subject: entity.entityId,
      watchGroup: entity.group,
      area: entity.area,
      observed: 0,
      expected: expected.centre,
      deviation: null,
      detail:
        `${entity.entityId} is usually active for ${(expected.centre * 100).toFixed(0)}% of this ` +
        `hour and was not active at all`,
      phrase: {
        key: "missing.quiet",
        args: { subject: entity.entityId, percent: (expected.centre * 100).toFixed(0) },
      },
    });
  }
  return findings;
}

/** Sensors with nothing to say, because they are not there. */
function dead(watchlist: Watchlist, snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const entity of watchlist.entities) {
    const state = snapshot.states.get(entity.entityId);
    if (state === undefined || !DEAD_STATES.has(state)) continue;

    findings.push({
      fingerprint: `stuck:${entity.entityId}`,
      rule: "stuck",
      subject: entity.entityId,
      watchGroup: entity.group,
      area: entity.area,
      observed: null,
      expected: null,
      deviation: null,
      detail: `${entity.entityId} is reporting ${state} and has no reading to give`,
      phrase: { key: "stuck.dead", args: { subject: entity.entityId, state } },
    });
  }
  return findings;
}

/** Sensors that normally change and have not, for a day. */
function stuck(db: DatabaseSync, watchlist: Watchlist, snapshot: Snapshot): Finding[] {
  const until = snapshot.hour.getTime() + HOUR_MS;
  const since = until - STUCK_HOURS * HOUR_MS;

  const rows = db
    .prepare("SELECT subject, bucket, changes, observed_ms FROM observations WHERE bucket < ?")
    .all(new Date(until).toISOString()) as unknown as Array<{
    subject: string;
    bucket: string;
    changes: number;
    observed_ms: number;
  }>;

  /** Local day to milliseconds watched, and subject to local day to changes. */
  const watchedPerDay = new Map<string, number>();
  const changesPerDay = new Map<string, Map<string, number>>();
  const recent = new Map<string, number>();
  let recentCoverage = 0;

  for (const row of rows) {
    const at = new Date(row.bucket).getTime();
    const day = localSlot(new Date(at)).key.slice(0, 10);

    if (row.subject === COVERAGE_SUBJECT) {
      watchedPerDay.set(day, (watchedPerDay.get(day) ?? 0) + row.observed_ms);
      if (at >= since) recentCoverage += row.observed_ms;
      continue;
    }

    let perDay = changesPerDay.get(row.subject);
    if (perDay === undefined) {
      perDay = new Map();
      changesPerDay.set(row.subject, perDay);
    }
    perDay.set(day, (perDay.get(day) ?? 0) + row.changes);
    if (at >= since) recent.set(row.subject, (recent.get(row.subject) ?? 0) + row.changes);
  }

  // A day-long outage is not a dead sensor, and saying so would be the first
  // false positive out of the gate.
  if (recentCoverage < STUCK_HOURS * HOUR_MS * STUCK_COVERAGE) return [];

  // Only days that were themselves watched enough to count, so that the day
  // JARVIS was restarted does not drag the median down to zero.
  const days = [...watchedPerDay]
    .filter(([, watched]) => watched >= 24 * HOUR_MS * MIN_COVERAGE)
    .map(([day]) => day);
  if (days.length < 2) return [];

  const findings: Finding[] = [];
  for (const entity of watchlist.entities) {
    if (CONTROLLED_GROUPS.has(entity.group)) continue;

    // Already said, and better said, by the rule above.
    const state = snapshot.states.get(entity.entityId);
    if (state !== undefined && DEAD_STATES.has(state)) continue;

    const perDay = changesPerDay.get(entity.entityId);
    if (perDay === undefined) continue;

    // Zeroes count. A subject with rows on three days out of ten changed
    // nothing on the other seven, and a median over only the busy days would
    // make every sensor look busy.
    const usual = median(days.map((day) => perDay.get(day) ?? 0));
    if (usual < MIN_DAILY_CHANGES) continue;
    if ((recent.get(entity.entityId) ?? 0) > 0) continue;

    findings.push({
      fingerprint: `stuck:${entity.entityId}`,
      rule: "stuck",
      subject: entity.entityId,
      watchGroup: entity.group,
      area: entity.area,
      observed: 0,
      expected: usual,
      deviation: null,
      detail:
        `${entity.entityId} normally changes about ${usual.toFixed(0)} times a day and has not ` +
        `changed in ${STUCK_HOURS} hours (it reads ` +
        `${snapshot.states.get(entity.entityId) ?? "nothing"})`,
      phrase: {
        key: "stuck.frozen",
        args: {
          subject: entity.entityId,
          changes: usual.toFixed(0),
          hours: STUCK_HOURS,
          state: snapshot.states.get(entity.entityId) ?? "nothing",
        },
      },
    });
  }
  return findings;
}

/** Sensors whose whole job is to say when something is wrong. */
function problems(watchlist: Watchlist, snapshot: Snapshot): Finding[] {
  const findings: Finding[] = [];
  for (const entity of watchlist.entities) {
    if (entity.group !== "problems") continue;
    if (snapshot.states.get(entity.entityId) !== "on") continue;

    findings.push({
      fingerprint: `problem:${entity.entityId}`,
      rule: "problem",
      subject: entity.entityId,
      watchGroup: entity.group,
      area: entity.area,
      observed: 1,
      expected: 0,
      deviation: null,
      detail: `${entity.entityId} is reporting a problem`,
      phrase: { key: "problem.active", args: { subject: entity.entityId } },
    });
  }
  return findings;
}

/** Every rule, over one hour. Deterministic, and free. */
export function evaluate(db: DatabaseSync, watchlist: Watchlist, snapshot: Snapshot): Finding[] {
  return [
    ...deviations(db, watchlist, snapshot),
    ...missing(db, watchlist, snapshot),
    ...dead(watchlist, snapshot),
    ...stuck(db, watchlist, snapshot),
    ...problems(watchlist, snapshot),
  ];
}

/**
 * Gathers what the rules need for the last complete hour.
 *
 * The statistics are asked for over a window an hour wider than the one that
 * matters, because Home Assistant timestamps an hourly statistic at its start
 * and a request that ends exactly on the boundary is one point short.
 */
export async function collect(
  home: HomeProvider,
  watchlist: Watchlist,
  states: Map<string, string>,
  now = new Date(),
): Promise<Snapshot> {
  const hour = lastCompleteHour(now);
  const statistics = new Map<string, number>();

  // A house that keeps no statistics leaves this empty; every rule that reads a
  // number then simply has nothing to say, which is what it says when a sensor
  // is quiet as well.
  if (watchlist.statistics.length > 0 && home.statistics !== undefined) {
    const series = await home.statistics(
      watchlist.statistics.map((watched) => watched.meta),
      hour,
      new Date(hour.getTime() + 2 * HOUR_MS),
    );
    for (const [statisticId, points] of series) {
      const point = points.find((candidate) => candidate.at.getTime() === hour.getTime());
      if (point !== undefined) statistics.set(statisticId, point.value);
    }
  }

  return { hour, states, statistics };
}

/** Five-minute buckets to the hour, for anyone reasoning about the two. */
export const BUCKETS_PER_HOUR = HOUR_MS / BUCKET_MS;
