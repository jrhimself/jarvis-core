/**
 * What a house normally does, per hour of the week.
 *
 * Two sources, because the house keeps two kinds of record. Numbers -- energy,
 * temperature -- come from long-term statistics, which Home Assistant keeps for
 * years and which are already summarised by the hour. Behaviour -- movement,
 * doors, who is home -- comes from `observations`, which is the rollup's work
 * plus whatever the recorder's ten days could be persuaded to give up.
 *
 * Median and median absolute deviation rather than mean and standard
 * deviation. One evening of visitors should not move what a normal evening
 * looks like, and with a mean it would: a single outlier drags the centre *and*
 * inflates the spread, so the same outlier makes itself look ordinary. The
 * median does neither.
 *
 * A slot is one hour of one weekday -- Tuesday at 19:00 -- and both shapes
 * reduce to a centre and a spread, so one rule can score them both.
 *
 * No model is called here. This is arithmetic.
 */

import type { DatabaseSync } from "node:sqlite";

import { formatter } from "@jarvis/shared";

import type { HomeProvider } from "@jarvis/shared";

import { BUCKET_MS } from "./rollup.js";
import { COVERAGE_SUBJECT } from "./rollup.js";
import type { Watchlist } from "./watchlist.js";


/**
 * How far back the numeric baselines reach.
 *
 * Eight weeks is eight readings for a given hour of a given weekday: enough for
 * a median to mean something, short enough that last winter does not describe
 * this August.
 */
const BASELINE_WEEKS = 8;

/**
 * How much of an hour must have been watched for that hour to count.
 *
 * An hour observed for ten minutes has a defensible fraction and a misleading
 * one -- ten minutes containing the only movement of the evening reads as a
 * very busy hour. Below this the hour is dropped rather than weighted, because
 * a baseline built from a handful of slots is better than one built from many
 * bad ones.
 */
const MIN_COVERAGE = 0.5;

/**
 * The local calendar hour a moment falls in.
 *
 * `sv-SE` regardless of the configured locale: this string is a key, not
 * something anybody reads, and that locale is the one that writes a date the way
 * a key wants it. The zone, on the other hand, is very much configuration --
 * see `@jarvis/shared/time`.
 */
const slotFormat = (): Intl.DateTimeFormat =>
  formatter(
    {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    },
    "sv-SE",
  );

interface Slot {
  /** Identifies one particular hour, e.g. `2026-08-22T19`. */
  key: string;
  /** 0 is Sunday, as `Date#getDay` has it. */
  weekday: number;
  hour: number;
}

/** Which hour of which local day a moment belongs to. */
export function localSlot(at: Date): Slot {
  const parts = Object.fromEntries(
    slotFormat().formatToParts(at).map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const day = `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
  const hour = Number(parts["hour"]) % 24;
  return {
    key: `${day}T${String(hour).padStart(2, "0")}`,
    weekday: new Date(`${day}T00:00:00Z`).getUTCDay(),
    hour,
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

/**
 * Median absolute deviation.
 *
 * Returned raw, not scaled to a standard deviation. The scaling factor belongs
 * with the rule that computes a z-score, where it can be seen next to the
 * threshold it is being compared against.
 */
export function mad(values: number[], centre: number): number {
  if (values.length === 0) return 0;
  return median(values.map((value) => Math.abs(value - centre)));
}

interface Sample {
  weekday: number;
  hour: number;
  value: number;
}

/** Groups samples into slots and reduces each to a centre and a spread. */
function reduceToSlots(samples: Sample[]): Array<{
  weekday: number;
  hour: number;
  centre: number;
  spread: number;
  samples: number;
}> {
  const bySlot = new Map<string, number[]>();
  for (const sample of samples) {
    const key = `${sample.weekday}:${sample.hour}`;
    const list = bySlot.get(key);
    if (list === undefined) bySlot.set(key, [sample.value]);
    else list.push(sample.value);
  }

  const result = [];
  for (const [key, values] of bySlot) {
    const [weekday, hour] = key.split(":").map(Number) as [number, number];
    const centre = median(values);
    result.push({ weekday, hour, centre, spread: mad(values, centre), samples: values.length });
  }
  return result;
}

interface ObservationRow {
  subject: string;
  watch_group: string;
  bucket: string;
  active_ms: number;
  observed_ms: number;
}

/**
 * Behavioural baselines: the fraction of an hour a thing is usually on.
 *
 * How long an hour was watched comes from the coverage rows rather than from
 * the subject's own, because a subject that was off all hour has no rows at
 * all -- that is the whole point of writing them sparsely. Without coverage
 * every quiet hour would divide by zero and every baseline would be built only
 * from the hours something happened, which is a baseline of the exceptions.
 */
function behaviouralSamples(db: DatabaseSync): Map<string, { group: string; samples: Sample[] }> {
  const rows = db
    .prepare(
      "SELECT subject, watch_group, bucket, active_ms, observed_ms FROM observations WHERE kind = 'state'",
    )
    .all() as unknown as ObservationRow[];

  /** Slot key to milliseconds of that hour anyone was watching. */
  const coverage = new Map<string, number>();
  const slots = new Map<string, Slot>();
  const active = new Map<string, Map<string, number>>();
  const groups = new Map<string, string>();

  for (const row of rows) {
    const at = new Date(row.bucket);
    const slot = localSlot(at);
    slots.set(slot.key, slot);

    if (row.subject === COVERAGE_SUBJECT) {
      coverage.set(slot.key, (coverage.get(slot.key) ?? 0) + row.observed_ms);
      continue;
    }

    groups.set(row.subject, row.watch_group);
    let perSlot = active.get(row.subject);
    if (perSlot === undefined) {
      perSlot = new Map();
      active.set(row.subject, perSlot);
    }
    perSlot.set(slot.key, (perSlot.get(slot.key) ?? 0) + row.active_ms);
  }

  const hourMs = 12 * BUCKET_MS;
  const usable = [...coverage].filter(([, watched]) => watched >= hourMs * MIN_COVERAGE);

  const result = new Map<string, { group: string; samples: Sample[] }>();
  for (const [subject, perSlot] of active) {
    const samples: Sample[] = [];
    for (const [key, watched] of usable) {
      const slot = slots.get(key);
      if (slot === undefined) continue;
      samples.push({
        weekday: slot.weekday,
        hour: slot.hour,
        value: (perSlot.get(key) ?? 0) / watched,
      });
    }
    result.set(subject, { group: groups.get(subject) ?? "unknown", samples });
  }
  return result;
}

export interface BaselineReport {
  behavioural: number;
  numeric: number;
  slots: number;
  pruned: number;
}

/**
 * Throws away observations no baseline will ever read again.
 *
 * Ten days of the house is 3,6 MB, which is a fortnight away from being larger
 * than everything else JARVIS knows put together. A week of slack past the
 * window, so that a build which fails for a few nights still has its input when
 * it runs again.
 */
function prune(db: DatabaseSync, before: Date): number {
  const result = db
    .prepare("DELETE FROM observations WHERE bucket < ?")
    .run(before.toISOString());
  return Number(result.changes);
}

/**
 * Rebuilds every baseline from scratch.
 *
 * Wholesale rather than in place, so a night that produced nonsense can be
 * thrown away by running it again rather than unpicked. The whole thing takes
 * seconds; there is nothing to be saved by being clever about it.
 */
export async function buildBaselines(
  home: HomeProvider,
  db: DatabaseSync,
  watchlist: Watchlist,
): Promise<BaselineReport> {
  const now = new Date();
  const from = new Date(now.getTime() - BASELINE_WEEKS * 7 * 24 * 3600_000);
  const builtAt = now.toISOString();

  const numericSamples = new Map<string, Sample[]>();
  if (watchlist.statistics.length > 0 && home.statistics !== undefined) {
    const series = await home.statistics(
      watchlist.statistics.map((watched) => watched.meta),
      from,
      now,
    );
    for (const [statisticId, points] of series) {
      numericSamples.set(
        statisticId,
        points.map((point) => {
          const slot = localSlot(point.at);
          return { weekday: slot.weekday, hour: slot.hour, value: point.value };
        }),
      );
    }
  }

  const behavioural = behaviouralSamples(db);

  const insert = db.prepare(`
    INSERT INTO baselines
      (subject, kind, shape, weekday, hour, centre, spread, samples, built_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let numericSubjects = 0;
  let behaviouralSubjects = 0;
  let slots = 0;

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM baselines");

    for (const [subject, { samples }] of behavioural) {
      const reduced = reduceToSlots(samples);
      if (reduced.length === 0) continue;
      behaviouralSubjects += 1;
      for (const slot of reduced) {
        insert.run(
          subject,
          "state",
          "behavioural",
          slot.weekday,
          slot.hour,
          slot.centre,
          slot.spread,
          slot.samples,
          builtAt,
        );
        slots += 1;
      }
    }

    for (const [subject, samples] of numericSamples) {
      const reduced = reduceToSlots(samples);
      if (reduced.length === 0) continue;
      numericSubjects += 1;
      for (const slot of reduced) {
        insert.run(
          subject,
          "statistic",
          "numeric",
          slot.weekday,
          slot.hour,
          slot.centre,
          slot.spread,
          slot.samples,
          builtAt,
        );
        slots += 1;
      }
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const pruned = prune(db, new Date(now.getTime() - (BASELINE_WEEKS + 1) * 7 * 24 * 3600_000));

  return { behavioural: behaviouralSubjects, numeric: numericSubjects, slots, pruned };
}

/** Milliseconds until the next occurrence of a local hour and minute. */
export function untilNextLocal(hour: number, minute: number, from = new Date()): number {
  for (let ahead = 0; ahead <= 2 * 24 * 60; ahead += 1) {
    const candidate = new Date(from.getTime() + ahead * 60_000);
    const slot = localSlot(candidate);
    if (slot.hour !== hour) continue;

    const minutes = Number(formatter({ minute: "2-digit" }, "sv-SE").format(candidate));
    if (minutes === minute) return ahead * 60_000;
  }
  return 24 * 3600_000;
}
