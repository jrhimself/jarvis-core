/**
 * Ten days of the past, converted into the same buckets the rollup writes.
 *
 * A behavioural baseline needs weeks. The rollup only produces them going
 * forward, which would mean a fortnight of watching before JARVIS could tell
 * an unusual evening from an ordinary one. Home Assistant's recorder already
 * holds ten days -- `purge_keep_days: 10` -- and reading it once at startup
 * buys most of that fortnight back.
 *
 * Ten days is all there is. The recorder purges on a timer and the statistics
 * table, which does keep years, has nothing about a door.
 *
 * Everything here writes with `ON CONFLICT DO NOTHING`. Backfill is the weaker
 * source: it cannot know whether the recorder itself was down, where the live
 * rollup knows exactly when its socket was connected. Where the two overlap,
 * what was actually watched wins.
 */

import type { DatabaseSync } from "node:sqlite";

import type { HomeProvider } from "@jarvis/shared";

import { BUCKET_MS, COVERAGE_SUBJECT, bucketStart } from "./rollup.js";
import { STATE_GROUPS } from "./watchlist.js";
import type { WatchedEntity } from "./watchlist.js";

/** What the recorder keeps, and therefore the most that can ever be asked for. */
export const HISTORY_DAYS = 10;

interface Bucket {
  activeMs: number;
  observedMs: number;
  changes: number;
  samples: number;
}

/** Spreads a segment of time across the buckets it covers. */
function credit(
  buckets: Map<number, Bucket>,
  from: number,
  to: number,
  active: boolean,
): void {
  for (let at = bucketStart(from); at < to; at += BUCKET_MS) {
    const overlap = Math.min(to, at + BUCKET_MS) - Math.max(from, at);
    if (overlap <= 0) continue;

    const bucket = buckets.get(at) ?? { activeMs: 0, observedMs: 0, changes: 0, samples: 0 };
    bucket.observedMs += overlap;
    if (active) bucket.activeMs += overlap;
    buckets.set(at, bucket);
  }
}

/**
 * Reads what the house remembers and writes it into `observations`.
 *
 * Returns the number of rows written and how far back the house actually went,
 * which is not necessarily the window asked for -- a purge boundary moves during
 * the day and an entity added last week has nothing before it. A house with no
 * history at all writes nothing and says so with a null.
 */
export async function backfillHistory(
  home: HomeProvider,
  db: DatabaseSync,
  entities: WatchedEntity[],
  days = HISTORY_DAYS,
): Promise<{ rows: number; from: Date | null; to: Date }> {
  const groups = new Map(STATE_GROUPS.map((group) => [group.id, group]));
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600_000);

  // A house that keeps no past is not an error, it is a slower start: the
  // rollup builds the same buckets going forward, and the baselines become
  // useful after a fortnight instead of on the first evening.
  if (home.history === undefined) return { rows: 0, from: null, to: end };

  const insert = db.prepare(`
    INSERT INTO observations
      (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
    VALUES (?, 'state', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subject, bucket) DO NOTHING
  `);

  let rows = 0;
  let earliest: number | null = null;

  const series = await home.history(
    entities.map((entity) => entity.entityId),
    start,
    end,
  );

  db.exec("BEGIN");
  try {
    for (const entity of entities) {
      const group = groups.get(entity.group);
      const states = series.get(entity.entityId);
      if (group === undefined || states === undefined || states.length === 0) continue;

      const buckets = new Map<number, Bucket>();
      let previous: string | null = null;

      for (let i = 0; i < states.length; i += 1) {
        const point = states[i]!;
        const at = point.at.getTime();
        const until = i + 1 < states.length ? states[i + 1]!.at.getTime() : end.getTime();
        if (earliest === null || at < earliest) earliest = at;

        const bucket = buckets.get(bucketStart(at)) ?? {
          activeMs: 0,
          observedMs: 0,
          changes: 0,
          samples: 0,
        };
        if (previous !== null && point.state !== previous) bucket.changes += 1;
        bucket.samples += 1;
        buckets.set(bucketStart(at), bucket);
        previous = point.state;

        credit(buckets, at, Math.min(until, end.getTime()), group.active(point.state));
      }

      for (const [at, bucket] of buckets) {
        if (bucket.activeMs <= 0 && bucket.changes <= 0) continue;
        insert.run(
          entity.entityId,
          entity.group,
          new Date(at).toISOString(),
          Math.round(bucket.activeMs),
          Math.round(bucket.observedMs),
          bucket.changes,
          bucket.samples,
        );
        rows += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  // Coverage for the backfilled window. The claim is weaker than the live
  // rollup's -- it says the recorder was recording, not that JARVIS was
  // watching -- but it is the same claim the recorder makes about itself, and
  // without it every hour of these ten days would divide by zero.
  if (earliest !== null) {
    db.exec("BEGIN");
    try {
      const stop = end.getTime();
      for (let at = bucketStart(earliest); at < stop; at += BUCKET_MS) {
        const observed = Math.min(stop, at + BUCKET_MS) - Math.max(earliest, at);
        if (observed <= 0) continue;
        insert.run(
          COVERAGE_SUBJECT,
          "coverage",
          new Date(at).toISOString(),
          0,
          Math.round(observed),
          0,
          entities.length,
        );
        rows += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return { rows, from: earliest === null ? null : new Date(earliest), to: end };
}
