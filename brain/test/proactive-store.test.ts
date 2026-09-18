/**
 * The schema the proactive side leans on.
 *
 * One of these indexes is load-bearing: dedupe is enforced by the database
 * rather than by remembering to check, and if that index were ever written
 * without its WHERE clause the same window next week could never be reported
 * again. Cheap to assert, expensive to discover.
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { migrateProactive, proactiveCounts } from "../dist/proactive/store.js";
import { proactiveDb } from "./helpers.ts";

function anomaly(db: DatabaseSync, fingerprint: string, status = "open"): void {
  db.prepare(
    `INSERT INTO anomalies
       (fingerprint, subject, rule, watch_group, area, first_at, last_at, detail, status)
     VALUES (?, 'sensor.x', 'deviation', 'power', NULL, '2026-08-11T20:00:00.000Z',
             '2026-08-11T20:00:00.000Z', 'iets', ?)`,
  ).run(fingerprint, status);
}

test("migrating a database that is already migrated changes nothing", () => {
  const db = proactiveDb();
  anomaly(db, "deviation:sensor.x");

  migrateProactive(db);
  migrateProactive(db);

  assert.equal(proactiveCounts(db).anomalies, 1, "the tables are not recreated under the data");
});

test("one condition may be open once, and closed as often as it likes", () => {
  const db = proactiveDb();
  anomaly(db, "deviation:sensor.x");

  assert.throws(
    () => anomaly(db, "deviation:sensor.x"),
    /UNIQUE/,
    "dedupe does not depend on anyone remembering to check",
  );

  db.exec("UPDATE anomalies SET status = 'resolved'");
  anomaly(db, "deviation:sensor.x");
  anomaly(db, "deviation:sensor.x", "resolved");

  const counts = proactiveCounts(db);
  assert.equal(counts.anomalies, 3, "the same window next week is a new one");
  assert.equal(counts.openAnomalies, 1);
});

test("a bucket belongs to one subject once, and a second write adds to it", () => {
  const db = proactiveDb();
  const insert = db.prepare(
    `INSERT INTO observations (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
     VALUES ('sensor.x', 'state', 'motion', '2026-08-11T20:00:00.000Z', 1, 1, 0, 1)`,
  );
  insert.run();

  assert.throws(() => insert.run(), /UNIQUE/, "the rollup must add rather than insert twice");
  assert.equal(proactiveCounts(db).observations, 1);
});

test("the counts read a database nobody has written to yet", () => {
  const db = new DatabaseSync(":memory:");
  migrateProactive(db);

  assert.deepEqual(proactiveCounts(db), {
    observations: 0,
    baselines: 0,
    anomalies: 0,
    openAnomalies: 0,
    suggestions: 0,
  });
});
