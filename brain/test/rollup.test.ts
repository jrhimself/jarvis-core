/**
 * Turning a feed of moments into buckets of duration.
 *
 * Two properties carry the whole design and are easy to break by accident: a
 * bucket with nothing in it writes no row at all, and a bucket that is written
 * twice adds up rather than replacing. The coverage row is what makes the first
 * one safe, so it is checked everywhere the others are.
 */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { BUCKET_MS, COVERAGE_SUBJECT, Rollup, bucketStart } from "../dist/proactive/rollup.js";
import type { StateChange } from "@jarvis/shared";
import type { WatchedEntity } from "../dist/proactive/watchlist.js";
import { proactiveDb } from "./helpers.ts";

const T0 = Date.parse("2026-08-11T20:00:00.000Z");

const WATCHED: WatchedEntity[] = [
  { entityId: "binary_sensor.overloop", group: "motion", area: "Overloop" },
  { entityId: "climate.airco_zolder", group: "climate", area: "Zolder" },
];

function change(entityId: string, state: string): StateChange {
  return { entityId, state, attributes: {}, changedAt: new Date(T0) };
}

interface Row {
  subject: string;
  kind: string;
  watch_group: string;
  bucket: string;
  active_ms: number;
  observed_ms: number;
  changes: number;
  samples: number;
}

function rows(db: DatabaseSync): Row[] {
  return db
    .prepare("SELECT * FROM observations ORDER BY bucket, subject")
    .all() as unknown as Row[];
}

test("a bucket is five minutes of wall clock, whatever the moment", () => {
  assert.equal(bucketStart(T0), T0);
  assert.equal(bucketStart(T0 + 1), T0);
  assert.equal(bucketStart(T0 + BUCKET_MS - 1), T0);
  assert.equal(bucketStart(T0 + BUCKET_MS), T0 + BUCKET_MS);
});

test("what is kept is how long a thing was on, not when it went on", () => {
  const db = proactiveDb();
  const rollup = new Rollup(db, WATCHED, T0);

  rollup.observe(change("binary_sensor.overloop", "on"), T0 + 60_000);
  rollup.observe(change("binary_sensor.overloop", "off"), T0 + 180_000);
  rollup.advanceTo(T0 + BUCKET_MS);

  const written = rows(db);
  assert.equal(written.length, 2, "one sensor row and one coverage row");

  const sensor = written.find((row) => row.subject === "binary_sensor.overloop")!;
  assert.equal(sensor.active_ms, 120_000, "two of the five minutes");
  assert.equal(sensor.observed_ms, BUCKET_MS);
  assert.equal(sensor.changes, 1, "off after on is the change; the first reading is not");
  assert.equal(sensor.samples, 2);
  assert.equal(sensor.watch_group, "motion");
  assert.equal(sensor.bucket, new Date(T0).toISOString());
});

test("a quiet entity writes nothing, and the coverage row says why", () => {
  const db = proactiveDb();
  const rollup = new Rollup(db, WATCHED, T0);

  rollup.observe(change("binary_sensor.overloop", "off"), T0 + 10_000);
  rollup.advanceTo(T0 + BUCKET_MS);

  const written = rows(db);
  assert.equal(written.length, 1);
  assert.equal(written[0]!.subject, COVERAGE_SUBJECT);
  assert.equal(written[0]!.watch_group, "coverage");
  assert.equal(written[0]!.observed_ms, BUCKET_MS);
  assert.equal(written[0]!.samples, WATCHED.length, "how many entities were being watched");
});

test("an entity nobody asked for is ignored rather than accumulated", () => {
  const db = proactiveDb();
  const rollup = new Rollup(db, WATCHED, T0);

  rollup.observe(change("sensor.stroomprijs", "0.24"), T0 + 10_000);
  rollup.advanceTo(T0 + BUCKET_MS);

  assert.deepEqual(
    rows(db).map((row) => row.subject),
    [COVERAGE_SUBJECT],
  );
});

test("a group decides what counts as on, so climate is not binary", () => {
  const db = proactiveDb();
  const rollup = new Rollup(db, WATCHED, T0);

  rollup.observe(change("climate.airco_zolder", "cool"), T0);
  rollup.advanceTo(T0 + BUCKET_MS);
  rollup.observe(change("climate.airco_zolder", "off"), T0 + BUCKET_MS);
  rollup.advanceTo(T0 + 2 * BUCKET_MS);

  const written = rows(db).filter((row) => row.subject === "climate.airco_zolder");
  assert.equal(written[0]!.active_ms, BUCKET_MS, "cool is running");
  assert.equal(written[1]!.active_ms, 0, "off is not");
  assert.equal(written[1]!.changes, 1, "the second bucket is written for the change alone");
});

test("crossing several buckets at once closes each of them", () => {
  const db = proactiveDb();
  const rollup = new Rollup(db, WATCHED, T0);

  rollup.observe(change("binary_sensor.overloop", "on"), T0);
  rollup.advanceTo(T0 + 3 * BUCKET_MS);

  const sensor = rows(db).filter((row) => row.subject === "binary_sensor.overloop");
  assert.equal(sensor.length, 3, "three buckets, not one long one");
  for (const row of sensor) assert.equal(row.active_ms, BUCKET_MS);
  assert.equal(sensor[1]!.samples, 0, "the reading belongs to the bucket it arrived in");
});

test("a restart mid-bucket adds to the row the dead process left", () => {
  const db = proactiveDb();

  const first = new Rollup(db, WATCHED, T0);
  first.observe(change("binary_sensor.overloop", "on"), T0);
  first.flush(T0 + 60_000);

  // A second process picks the same bucket up where the first stopped.
  const second = new Rollup(db, WATCHED, T0 + 60_000);
  second.observe(change("binary_sensor.overloop", "on"), T0 + 60_000);
  second.flush(T0 + 180_000);

  const sensor = rows(db).filter((row) => row.subject === "binary_sensor.overloop");
  assert.equal(sensor.length, 1, "one bucket, one row");
  assert.equal(sensor[0]!.active_ms, 180_000, "a minute plus two, not overwritten by two");
  assert.equal(sensor[0]!.samples, 2);
});

test("an outage is not a quiet night", () => {
  const db = proactiveDb();
  const rollup = new Rollup(db, WATCHED, T0);

  rollup.observe(change("binary_sensor.overloop", "on"), T0);
  rollup.pause(T0 + 60_000);
  // An hour with nobody watching.
  rollup.resume(T0 + 60 * 60_000);
  rollup.advanceTo(T0 + 60 * 60_000 + BUCKET_MS);

  const coverage = rows(db).filter((row) => row.subject === COVERAGE_SUBJECT);
  assert.equal(coverage.length, 2, "the paused hour left no coverage behind");
  assert.equal(coverage[0]!.observed_ms, 60_000);
  assert.equal(coverage[1]!.observed_ms, BUCKET_MS);

  const sensor = rows(db).filter((row) => row.subject === "binary_sensor.overloop");
  assert.equal(sensor.length, 1, "the state from before the outage is not credited after it");
  assert.equal(sensor[0]!.active_ms, 60_000);
});

test("a snapshot answers what things read now, not what they did", () => {
  const db = proactiveDb();
  const rollup = new Rollup(db, WATCHED, T0);

  assert.equal(rollup.snapshot().size, 0, "nothing is known before the first reading");

  rollup.observe(change("binary_sensor.overloop", "on"), T0);
  rollup.observe(change("climate.airco_zolder", "cool"), T0);
  rollup.observe(change("binary_sensor.overloop", "off"), T0 + 60_000);

  assert.deepEqual(
    [...rollup.snapshot()],
    [
      ["binary_sensor.overloop", "off"],
      ["climate.airco_zolder", "cool"],
    ],
  );

  rollup.resume(T0 + 120_000);
  assert.equal(rollup.snapshot().size, 0, "after a reconnect nothing is known again");
});
