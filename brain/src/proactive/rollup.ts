/**
 * Turning a live feed into something a baseline can be built from.
 *
 * The state feed reports the moment a door opens. That is the wrong shape for
 * every question worth asking -- nobody wants to know that the landing sensor
 * fired at 19:42:07, they want to know whether there is usually movement
 * upstairs on a Tuesday evening. So the feed is accumulated into five-minute
 * buckets, and what is kept per bucket is how long the thing was on rather
 * than when.
 *
 * Deterministic, and no model is called anywhere near here.
 *
 * Absence is the storage strategy. A row is written only for a bucket in which
 * something was on or something changed; a motion sensor that saw nothing for
 * five minutes writes nothing at all. Written in full this would be 92 rows
 * every five minutes -- 26 000 a day against a database of 425 kB -- and
 * almost all of them would say "no".
 *
 * That only works because a missing row is otherwise ambiguous: it could mean
 * nothing happened, or it could mean nobody was watching. One row per bucket
 * under the subject `__watch__` records how long the watcher was actually
 * connected, which settles it.
 */

import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { StateChange } from "@jarvis/shared";
import { STATE_GROUPS } from "./watchlist.js";
import type { StateGroup, WatchedEntity } from "./watchlist.js";

/** Five minutes, as the plan specifies. Buckets align to the wall clock. */
export const BUCKET_MS = 5 * 60_000;

/**
 * The row that proves the watcher was awake.
 *
 * Not an entity id, and it cannot collide with one: Home Assistant ids are
 * always `domain.object_id` and this has no dot.
 */
export const COVERAGE_SUBJECT = "__watch__";

interface Accumulator {
  group: string;
  active: (state: string) => boolean;
  state: string;
  isActive: boolean;
  /** Start of the segment currently being timed, as a timestamp. */
  since: number;
  activeMs: number;
  observedMs: number;
  changes: number;
  samples: number;
}

/** The start of the bucket a moment falls in. */
export function bucketStart(at: number): number {
  return Math.floor(at / BUCKET_MS) * BUCKET_MS;
}

/**
 * Accumulates state changes and writes closed buckets.
 *
 * Time is passed in rather than read from the clock, which is what makes this
 * testable against a day of synthetic history in a few milliseconds.
 */
export class Rollup {
  readonly #db: DatabaseSync;
  readonly #insert: StatementSync;
  readonly #accumulators = new Map<string, Accumulator>();
  readonly #groups = new Map<string, StateGroup>();

  #bucket: number;
  /** When the current bucket started being watched, for the coverage row. */
  #watchingSince: number;

  constructor(db: DatabaseSync, watchlist: WatchedEntity[], now: number) {
    this.#db = db;
    this.#bucket = bucketStart(now);
    this.#watchingSince = now;

    for (const group of STATE_GROUPS) this.#groups.set(group.id, group);
    for (const entity of watchlist) {
      const group = this.#groups.get(entity.group);
      if (group === undefined) continue;
      this.#accumulators.set(entity.entityId, {
        group: entity.group,
        active: group.active,
        state: "",
        isActive: false,
        since: now,
        activeMs: 0,
        observedMs: 0,
        changes: 0,
        samples: 0,
      });
    }

    // Adding to what is already there is what makes a restart mid-bucket
    // harmless: the process that died wrote nothing, but a process that runs
    // the tick twice, or two buckets that flush into one, still add up.
    this.#insert = db.prepare(`
      INSERT INTO observations
        (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
      VALUES (?, 'state', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject, bucket) DO UPDATE SET
        active_ms   = active_ms   + excluded.active_ms,
        observed_ms = observed_ms + excluded.observed_ms,
        changes     = changes     + excluded.changes,
        samples     = samples     + excluded.samples
    `);
  }

  /**
   * Records a state as of the moment it arrived.
   *
   * Arrival time, not the feed's `last_changed`. On a reconnect Home Assistant
   * re-sends every watched entity with the real time it last changed, which can
   * be days ago; treating that as the start of a segment would credit this
   * bucket with time nobody observed.
   */
  observe(change: StateChange, at: number): void {
    this.advanceTo(at);

    const accumulator = this.#accumulators.get(change.entityId);
    if (accumulator === undefined) return;

    this.#settle(accumulator, at);
    if (accumulator.state !== "" && change.state !== accumulator.state) accumulator.changes += 1;
    accumulator.state = change.state;
    accumulator.isActive = accumulator.active(change.state);
    accumulator.samples += 1;
  }

  /**
   * What every watched entity reads right now.
   *
   * The rules that ask about the present -- a problem sensor that is on, a
   * sensor stuck on one value -- would otherwise need their own round trip to
   * `get_states`, and would then be asking a different question than the one
   * the buckets answer.
   */
  snapshot(): Map<string, string> {
    const states = new Map<string, string>();
    for (const [entityId, accumulator] of this.#accumulators) {
      if (accumulator.state !== "") states.set(entityId, accumulator.state);
    }
    return states;
  }

  /** Closes every bucket that has ended by this moment. */
  advanceTo(now: number): void {
    while (now >= this.#bucket + BUCKET_MS) {
      const end = this.#bucket + BUCKET_MS;
      this.#close(end);
      this.#bucket = end;
    }
  }

  /**
   * Writes what has accumulated so far without closing the bucket.
   *
   * For shutdown: four minutes of evidence is worth more than nothing, and the
   * next process adds to the same row rather than replacing it.
   */
  flush(now: number): void {
    this.advanceTo(now);
    this.#close(now);
  }

  #settle(accumulator: Accumulator, until: number): void {
    const span = Math.max(0, until - accumulator.since);
    accumulator.observedMs += span;
    if (accumulator.isActive) accumulator.activeMs += span;
    accumulator.since = until;
  }

  /** Settles everything to `until`, writes the rows worth writing, and resets. */
  #close(until: number): void {
    const bucket = new Date(this.#bucket).toISOString();
    const watched = Math.max(0, until - this.#watchingSince);

    this.#db.exec("BEGIN");
    try {
      for (const [entityId, accumulator] of this.#accumulators) {
        this.#settle(accumulator, until);

        // Nothing on and nothing moved is the ordinary case and says nothing
        // the coverage row does not already say.
        if (accumulator.activeMs > 0 || accumulator.changes > 0) {
          this.#insert.run(
            entityId,
            accumulator.group,
            bucket,
            accumulator.activeMs,
            accumulator.observedMs,
            accumulator.changes,
            accumulator.samples,
          );
        }

        accumulator.activeMs = 0;
        accumulator.observedMs = 0;
        accumulator.changes = 0;
        accumulator.samples = 0;
      }

      if (watched > 0) {
        this.#insert.run(
          COVERAGE_SUBJECT,
          "coverage",
          bucket,
          0,
          watched,
          0,
          this.#accumulators.size,
        );
      }

      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }

    this.#watchingSince = until;
  }

  /**
   * Stops crediting time, for as long as Home Assistant is unreachable.
   *
   * Without this a night-long outage would look like a night in which every
   * sensor was quiet, which is exactly the shape of the thing the rules are
   * meant to notice.
   */
  pause(at: number): void {
    this.advanceTo(at);
    for (const accumulator of this.#accumulators.values()) this.#settle(accumulator, at);
    this.#close(at);
  }

  /** Starts crediting time again after a reconnect. */
  resume(at: number): void {
    this.#bucket = bucketStart(at);
    this.#watchingSince = at;
    for (const accumulator of this.#accumulators.values()) {
      accumulator.since = at;
      accumulator.state = "";
      accumulator.isActive = false;
    }
  }
}
