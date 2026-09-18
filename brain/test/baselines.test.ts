/**
 * What "normal" is built from.
 *
 * Two things are pinned here. The arithmetic — median and MAD, chosen so one
 * evening of visitors cannot move the centre — and the local clock, because a
 * baseline that says "Tuesday evening" is wrong by an hour twice a year if it
 * is kept in UTC.
 */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { buildBaselines, localSlot, mad, median, untilNextLocal } from "../dist/proactive/baselines.js";
import type { Watchlist } from "../dist/proactive/watchlist.js";
import { fakeHome, proactiveDb } from "./helpers.ts";

// These assertions are about a house in one particular place, so they name it
// rather than inherit whatever zone the machine running them happens to have.
// That is the whole point of `JARVIS_TIMEZONE`: on a container it is UTC.
process.env["JARVIS_TIMEZONE"] = "Europe/Amsterdam";
process.env["JARVIS_LOCALE"] = "nl-NL";


const HOUR_MS = 3600_000;

test("the median holds still while a mean would move", () => {
  assert.equal(median([]), 0);
  assert.equal(median([7]), 7);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5, "an even count averages the middle pair");
  assert.equal(median([1, 1, 1, 1, 900]), 1, "one loud evening does not move it");
});

test("the spread is a median of distances, not an average of them", () => {
  assert.equal(mad([], 0), 0);
  assert.equal(mad([1, 1, 1, 9], 1), 0, "three of four sit exactly on the centre");
  assert.equal(mad([1, 2, 3, 4], 2.5), 1);
  assert.equal(mad([5, 5, 5], 5), 0);
});

test("an hour belongs to the day it has in Amsterdam", () => {
  // Winter: 23:30 UTC is already half past midnight the next day, and that day
  // is a Friday.
  const winter = localSlot(new Date("2026-01-15T23:30:00Z"));
  assert.equal(winter.key, "2026-01-16T00");
  assert.equal(winter.hour, 0);
  assert.equal(winter.weekday, 5);

  // Summer: two hours ahead.
  const summer = localSlot(new Date("2026-07-01T12:00:00Z"));
  assert.equal(summer.key, "2026-07-01T14");
  assert.equal(summer.hour, 14);
  assert.equal(summer.weekday, 3);
});

test("the hour the clocks go forward does not smear the baseline", () => {
  // 2026-03-29: 02:00 local never happens. Either side of it stays honest.
  assert.equal(localSlot(new Date("2026-03-29T00:30:00Z")).hour, 1);
  assert.equal(localSlot(new Date("2026-03-29T01:30:00Z")).hour, 3);

  // 2026-10-25: 02:00 local happens twice, and both times are hour 2.
  assert.equal(localSlot(new Date("2026-10-25T00:30:00Z")).hour, 2);
  assert.equal(localSlot(new Date("2026-10-25T01:30:00Z")).hour, 2);
});

test("the wait until a local time is measured in local time", () => {
  const from = new Date("2026-07-01T12:00:00Z"); // 14:00 in Amsterdam
  assert.equal(untilNextLocal(15, 0, from), 60 * 60_000);
  assert.equal(untilNextLocal(14, 30, from), 30 * 60_000);
  assert.equal(untilNextLocal(14, 0, from), 0, "right now counts as the next one");

  // Across the spring forward: 03:00 local is one hour after 01:00 local, not two.
  assert.equal(untilNextLocal(3, 0, new Date("2026-03-29T00:00:00Z")), 60 * 60_000);
});

/** Writes one hour's worth of observation, as the rollup would have. */
function observe(
  db: DatabaseSync,
  input: { subject: string; bucket: string; activeMs: number; observedMs: number; changes?: number },
): void {
  db.prepare(
    `INSERT INTO observations (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
     VALUES (?, 'state', ?, ?, ?, ?, ?, 1)`,
  ).run(
    input.subject,
    input.subject === "__watch__" ? "coverage" : "motion",
    input.bucket,
    input.activeMs,
    input.observedMs,
    input.changes ?? 0,
  );
}

const EMPTY_WATCHLIST: Watchlist = { entities: [], statistics: [] };
/** buildBaselines only asks the house anything when statistics are watched. */
const NO_HOUSE = fakeHome();

test("a behavioural baseline is the fraction of an hour a thing is usually on", async () => {
  const db = proactiveDb();
  // Four Tuesdays at 20:00 Amsterdam, half the hour with movement upstairs.
  for (const day of ["2026-07-28", "2026-08-04", "2026-08-11", "2026-08-18"]) {
    const bucket = `${day}T18:00:00.000Z`;
    observe(db, { subject: "__watch__", bucket, activeMs: 0, observedMs: HOUR_MS });
    observe(db, { subject: "binary_sensor.overloop", bucket, activeMs: HOUR_MS / 2, observedMs: HOUR_MS });
  }

  const report = await buildBaselines(NO_HOUSE, db, EMPTY_WATCHLIST);
  assert.equal(report.behavioural, 1);
  assert.equal(report.numeric, 0);

  const slot = db
    .prepare("SELECT * FROM baselines WHERE subject = ?")
    .all("binary_sensor.overloop") as unknown as Array<{
    weekday: number;
    hour: number;
    centre: number;
    spread: number;
    samples: number;
    shape: string;
  }>;

  assert.equal(slot.length, 1, "four Tuesdays are one slot, not four");
  assert.equal(slot[0]!.weekday, 2);
  assert.equal(slot[0]!.hour, 20, "18:00 UTC in August is 20:00 here");
  assert.equal(slot[0]!.centre, 0.5);
  assert.equal(slot[0]!.spread, 0);
  assert.equal(slot[0]!.samples, 4);
  assert.equal(slot[0]!.shape, "behavioural");
});

test("an hour that was barely watched is dropped, not weighted", async () => {
  const db = proactiveDb();
  // Ten minutes of coverage, and all of it busy — the shape of a restart, not
  // the shape of a busy hour.
  const bucket = "2026-08-11T09:00:00.000Z";
  observe(db, { subject: "__watch__", bucket, activeMs: 0, observedMs: 10 * 60_000 });
  observe(db, { subject: "binary_sensor.gang", bucket, activeMs: 10 * 60_000, observedMs: 10 * 60_000 });

  const report = await buildBaselines(NO_HOUSE, db, EMPTY_WATCHLIST);

  assert.equal(report.slots, 0);
  assert.equal(report.behavioural, 0);
});

test("a quiet hour is a sample of zero, not a missing sample", async () => {
  const db = proactiveDb();
  const busy = "2026-08-04T18:00:00.000Z";
  const quiet = "2026-08-05T18:00:00.000Z";
  for (const bucket of [busy, quiet]) {
    observe(db, { subject: "__watch__", bucket, activeMs: 0, observedMs: HOUR_MS });
  }
  observe(db, { subject: "binary_sensor.zolder", bucket: busy, activeMs: HOUR_MS, observedMs: HOUR_MS });

  await buildBaselines(NO_HOUSE, db, EMPTY_WATCHLIST);

  const wednesday = db
    .prepare("SELECT centre FROM baselines WHERE subject = ? AND weekday = 3")
    .get("binary_sensor.zolder") as unknown as { centre: number } | undefined;

  assert.notEqual(wednesday, undefined, "the quiet Wednesday still produced a slot");
  assert.equal(wednesday!.centre, 0);
});

test("rebuilding replaces the old baselines instead of adding to them", async () => {
  const db = proactiveDb();
  const bucket = "2026-08-04T18:00:00.000Z";
  observe(db, { subject: "__watch__", bucket, activeMs: 0, observedMs: HOUR_MS });
  observe(db, { subject: "binary_sensor.gang", bucket, activeMs: HOUR_MS, observedMs: HOUR_MS });

  await buildBaselines(NO_HOUSE, db, EMPTY_WATCHLIST);
  await buildBaselines(NO_HOUSE, db, EMPTY_WATCHLIST);

  const rows = db.prepare("SELECT count(*) AS n FROM baselines").get() as unknown as { n: number };
  assert.equal(rows.n, 1);
});

test("observations no baseline will read again are pruned", async () => {
  const db = proactiveDb();
  observe(db, {
    subject: "binary_sensor.oud",
    bucket: "2025-01-01T12:00:00.000Z",
    activeMs: 1,
    observedMs: HOUR_MS,
  });
  const recent = new Date(Date.now() - 24 * HOUR_MS).toISOString();
  observe(db, { subject: "__watch__", bucket: recent, activeMs: 0, observedMs: HOUR_MS });

  const report = await buildBaselines(NO_HOUSE, db, EMPTY_WATCHLIST);

  assert.equal(report.pruned, 1);
  const left = db.prepare("SELECT count(*) AS n FROM observations").get() as unknown as { n: number };
  assert.equal(left.n, 1);
});
