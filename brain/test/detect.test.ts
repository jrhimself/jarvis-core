/**
 * The four brakes between a rule firing and anybody hearing about it.
 *
 * These are the numbers that decide whether JARVIS is worth living with, and
 * they are in code rather than in a prompt precisely so they can be counted.
 * So: count them.
 */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { openAnomalies, reconcile, untilMinutePastHour } from "../dist/proactive/detect.js";
import type { Finding } from "../dist/proactive/rules.js";
import { proactiveDb, quietly } from "./helpers.ts";

const HOUR_MS = 3600_000;
const T0 = new Date("2026-08-11T20:00:00.000Z");

function at(hoursLater: number): Date {
  return new Date(T0.getTime() + hoursLater * HOUR_MS);
}

function finding(input: Partial<Finding> & { subject: string }): Finding {
  const rule = input.rule ?? "deviation";
  return {
    fingerprint: input.fingerprint ?? `${rule}:${input.subject}`,
    rule,
    subject: input.subject,
    watchGroup: input.watchGroup ?? "power",
    area: input.area ?? null,
    observed: input.observed ?? 1,
    expected: input.expected ?? 0,
    deviation: input.deviation ?? null,
    detail: input.detail ?? `${input.subject} is off`,
  };
}

function statuses(db: DatabaseSync): Array<{ fingerprint: string; status: string; buckets: number }> {
  return db
    .prepare("SELECT fingerprint, status, buckets FROM anomalies ORDER BY id")
    .all() as unknown as Array<{ fingerprint: string; status: string; buckets: number }>;
}

test("the same condition seen twice is one row, counted twice", () => {
  const db = proactiveDb();
  const one = [finding({ subject: "sensor.verbruik", detail: "read 400" })];

  const first = reconcile(db, one, T0);
  assert.equal(first.opened, 1);
  assert.equal(first.updated, 0);

  const second = reconcile(db, [finding({ subject: "sensor.verbruik", detail: "read 420" })], at(1));
  assert.equal(second.opened, 0);
  assert.equal(second.updated, 1);

  const rows = statuses(db);
  assert.equal(rows.length, 1, "one open row per fingerprint");
  assert.equal(rows[0]!.buckets, 2);

  const open = openAnomalies(db);
  assert.equal(open[0]!.detail, "read 420", "the newest reading is the one worth quoting");
  assert.equal(open[0]!.firstAt, T0.toISOString(), "but it still says how long it has held");
});

test("a condition is not ripe until it has held as long as its rule asks", () => {
  const db = proactiveDb();

  const first = reconcile(db, [finding({ subject: "sensor.verbruik" })], T0);
  assert.equal(first.ripe, 0, "one hour of one number could be a meter reading late");
  assert.equal(openAnomalies(db)[0]!.ripe, false);

  const second = reconcile(db, [finding({ subject: "sensor.verbruik" })], at(1));
  assert.equal(second.ripe, 1);
  assert.equal(openAnomalies(db)[0]!.ripe, true);
});

test("a problem sensor is believed the first time", () => {
  const db = proactiveDb();

  const report = reconcile(
    db,
    [finding({ subject: "binary_sensor.waterlek", rule: "problem", watchGroup: "problems" })],
    T0,
  );

  assert.equal(report.ripe, 1, "it exists for no other purpose than to be believed at once");
});

test("a condition that stops for an hour is not yet over", () => {
  const db = proactiveDb();
  reconcile(db, [finding({ subject: "sensor.verbruik" })], T0);

  const report = reconcile(db, [], at(1));

  assert.equal(report.resolved, 0, "a sensor on a threshold would flap all night");
  assert.equal(statuses(db)[0]!.status, "open");
});

test("a condition absent for three hours is called over", () => {
  const db = proactiveDb();
  reconcile(db, [finding({ subject: "sensor.verbruik" })], T0);

  const report = reconcile(db, [], at(4));

  assert.equal(report.resolved, 1);
  assert.equal(statuses(db)[0]!.status, "resolved");
  assert.equal(openAnomalies(db).length, 0);
});

test("a condition that just ended is not reopened straight away", () => {
  const db = proactiveDb();
  reconcile(db, [finding({ subject: "sensor.verbruik" })], T0);
  reconcile(db, [], at(4));

  const during = reconcile(db, [finding({ subject: "sensor.verbruik" })], at(5));
  assert.equal(during.opened, 0);
  assert.equal(during.suppressed, 1);

  // Six hours after it was resolved, not after it was last seen.
  const after = reconcile(db, [finding({ subject: "sensor.verbruik" })], at(11));
  assert.equal(after.opened, 1);
  assert.equal(after.suppressed, 0);
  assert.equal(statuses(db).length, 2, "a reopening is a new row, not a revived one");
});

test("one rule may not open more than ten conditions in a day", () => {
  const db = proactiveDb();
  // An integration falling over and taking fifteen sensors with it.
  const collapse = Array.from({ length: 15 }, (_, index) =>
    finding({ subject: `sensor.meter_${index}` }),
  );

  const report = quietly(() => reconcile(db, collapse, T0));

  assert.equal(report.findings, 15);
  assert.equal(report.opened, 10);
  assert.equal(report.suppressed, 5);
  assert.equal(openAnomalies(db).length, 10);
});

test("the ceiling is per rule, not shared", () => {
  const db = proactiveDb();
  const deviations = Array.from({ length: 10 }, (_, index) =>
    finding({ subject: `sensor.meter_${index}` }),
  );
  reconcile(db, deviations, T0);

  const report = reconcile(
    db,
    [finding({ subject: "binary_sensor.waterlek", rule: "problem", watchGroup: "problems" })],
    T0,
  );

  assert.equal(report.opened, 1, "a full deviation ceiling does not silence a water leak");
});

test("the ceiling counts the last day, not the calendar day", () => {
  const db = proactiveDb();
  quietly(() =>
    reconcile(
      db,
      Array.from({ length: 10 }, (_, index) => finding({ subject: `sensor.meter_${index}` })),
      T0,
    ),
  );

  const blocked = quietly(() => reconcile(db, [finding({ subject: "sensor.laat" })], at(12)));
  assert.equal(blocked.opened, 0);

  const allowed = reconcile(db, [finding({ subject: "sensor.laat" })], at(25));
  assert.equal(allowed.opened, 1);
});

test("open conditions come back worst-established first", () => {
  const db = proactiveDb();
  reconcile(db, [finding({ subject: "sensor.oud" })], T0);
  reconcile(db, [finding({ subject: "sensor.oud" })], at(1));
  reconcile(db, [finding({ subject: "sensor.oud" }), finding({ subject: "sensor.nieuw" })], at(2));

  assert.deepEqual(
    openAnomalies(db).map((anomaly) => anomaly.subject),
    ["sensor.oud", "sensor.nieuw"],
  );
});

test("the hourly pass waits until the statistics are actually written", () => {
  const from = new Date("2026-08-11T20:03:00.000Z");
  assert.equal(untilMinutePastHour(10, from), 7 * 60_000);

  // Past the minute already: the next one is an hour away, not in the past.
  const late = new Date("2026-08-11T20:42:00.000Z");
  assert.equal(untilMinutePastHour(10, late), 28 * 60_000);

  const exactly = new Date("2026-08-11T20:10:00.000Z");
  assert.equal(untilMinutePastHour(10, exactly), HOUR_MS, "on the minute counts as gone");
});
