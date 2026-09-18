/**
 * The four questions, and what stops each of them shouting.
 *
 * Every rule here has a guard that was added because something fired that
 * should not have: a quantised sensor, an hour nobody watched, an air
 * conditioner somebody turned off. Those guards are what these tests hold
 * still — a rule that fires is easy to write, a rule that stays quiet on the
 * boring hours is the whole job.
 */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { evaluate, lastCompleteHour } from "../dist/proactive/rules.js";
import type { Watchlist } from "../dist/proactive/watchlist.js";
import { proactiveDb } from "./helpers.ts";

// These assertions are about a house in one particular place, so they name it
// rather than inherit whatever zone the machine running them happens to have.
// That is the whole point of `JARVIS_TIMEZONE`: on a container it is UTC.
process.env["JARVIS_TIMEZONE"] = "Europe/Amsterdam";
process.env["JARVIS_LOCALE"] = "nl-NL";


const HOUR_MS = 3600_000;
/** A Tuesday, 20:00 Amsterdam. Weekday 2, hour 20. */
const HOUR = new Date("2026-08-11T18:00:00.000Z");

function baseline(
  db: DatabaseSync,
  input: {
    subject: string;
    shape: "numeric" | "behavioural";
    centre: number;
    spread: number;
    samples?: number;
    weekday?: number;
    hour?: number;
  },
): void {
  db.prepare(
    `INSERT INTO baselines (subject, kind, shape, weekday, hour, centre, spread, samples, built_at)
     VALUES (?, 'state', ?, ?, ?, ?, ?, ?, '2026-08-11T00:00:00.000Z')`,
  ).run(
    input.subject,
    input.shape,
    input.weekday ?? 2,
    input.hour ?? 20,
    input.centre,
    input.spread,
    input.samples ?? 8,
  );
}

/** The whole week of numeric slots, so a subject has a scale and a swing. */
function weekOfBaselines(db: DatabaseSync, subject: string, centre: number, spread: number): void {
  for (let hour = 0; hour < 24; hour += 1) {
    if (hour === 20) continue;
    baseline(db, { subject, shape: "numeric", centre, spread, hour });
  }
}

function watchingStatistic(statisticId: string, unitClass = "power", unit = "W"): Watchlist {
  return {
    entities: [],
    statistics: [{ meta: { statisticId, shape: "measurement", unit, unitClass }, group: unitClass }],
  };
}

function watchingEntity(entityId: string, group = "motion"): Watchlist {
  return { entities: [{ entityId, group, area: "Overloop" }], statistics: [] };
}

function snapshotOf(
  states: Array<[string, string]> = [],
  statistics: Array<[string, number]> = [],
): { hour: Date; states: Map<string, string>; statistics: Map<string, number> } {
  return { hour: HOUR, states: new Map(states), statistics: new Map(statistics) };
}

/** Coverage rows, so the hour counts as watched. */
function coverEntireHour(db: DatabaseSync, hours = 1, until = HOUR.getTime() + HOUR_MS): void {
  const insert = db.prepare(
    `INSERT INTO observations (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
     VALUES ('__watch__', 'state', 'coverage', ?, 0, ?, 0, 1)`,
  );
  for (let index = 0; index < hours; index += 1) {
    insert.run(new Date(until - (index + 1) * HOUR_MS).toISOString(), HOUR_MS);
  }
}

test("the hour to judge is the one that has finished", () => {
  assert.equal(
    lastCompleteHour(new Date("2026-08-11T20:42:07.000Z")).toISOString(),
    "2026-08-11T19:00:00.000Z",
  );
  assert.equal(
    lastCompleteHour(new Date("2026-08-11T20:00:00.000Z")).toISOString(),
    "2026-08-11T19:00:00.000Z",
    "the hour that just started is not complete either",
  );
});

test("a problem sensor saying there is one needs no history", () => {
  const db = proactiveDb();
  const watchlist = watchingEntity("binary_sensor.vaatwasser_probleem", "problems");

  const findings = evaluate(db, watchlist, snapshotOf([["binary_sensor.vaatwasser_probleem", "on"]]));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "problem");
  assert.equal(findings[0]!.fingerprint, "problem:binary_sensor.vaatwasser_probleem");
  assert.equal(findings[0]!.area, "Overloop");
});

test("a problem sensor that is off says nothing, and neither does another group", () => {
  const db = proactiveDb();

  assert.equal(
    evaluate(db, watchingEntity("binary_sensor.probleem", "problems"), snapshotOf([["binary_sensor.probleem", "off"]]))
      .length,
    0,
  );
  // The same `on`, from a group whose job is not to report problems.
  assert.equal(
    evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf([["binary_sensor.overloop", "on"]])).length,
    0,
  );
});

test("a sensor that is not there is reported without any history at all", () => {
  const db = proactiveDb();

  const findings = evaluate(
    db,
    watchingEntity("binary_sensor.raam_zolder", "openings"),
    snapshotOf([["binary_sensor.raam_zolder", "unavailable"]]),
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "stuck");
  assert.match(findings[0]!.detail, /unavailable/);
  assert.equal(findings[0]!.observed, null, "there is no reading to report");
});

test("an hour that is reliably busy and was not is missing", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  baseline(db, { subject: "binary_sensor.overloop", shape: "behavioural", centre: 0.4, spread: 0.05 });

  const findings = evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf());

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "missing");
  assert.equal(findings[0]!.observed, 0);
  assert.equal(findings[0]!.expected, 0.4);
  assert.match(findings[0]!.detail, /40%/);
});

test("an hour that was busy after all is not missing", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  baseline(db, { subject: "binary_sensor.overloop", shape: "behavioural", centre: 0.4, spread: 0.05 });
  db.prepare(
    `INSERT INTO observations (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
     VALUES ('binary_sensor.overloop', 'state', 'motion', ?, ?, ?, 1, 1)`,
  ).run(HOUR.toISOString(), 60_000, HOUR_MS);

  assert.equal(evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf()).length, 0);
});

test("an hour nobody watched is not evidence of absence", () => {
  const db = proactiveDb();
  baseline(db, { subject: "binary_sensor.overloop", shape: "behavioural", centre: 0.4, spread: 0.05 });
  // Twenty minutes of coverage: below half the hour.
  db.prepare(
    `INSERT INTO observations (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
     VALUES ('__watch__', 'state', 'coverage', ?, 0, ?, 0, 1)`,
  ).run(HOUR.toISOString(), 20 * 60_000);

  assert.equal(evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf()).length, 0);
});

test("an hour that is barely ever busy is not missing when it is quiet", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  // One per cent of an hour is thirty-six seconds: not reliably anything.
  baseline(db, { subject: "binary_sensor.overloop", shape: "behavioural", centre: 0.01, spread: 0 });

  assert.equal(evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf()).length, 0);
});

test("an hour that is occasionally busy is not missing either", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  // Five per cent: three minutes of an hour, which is a landing somebody
  // walks across now and then rather than an hour that is reliably anything.
  // Every finding a week of real hours produced sat in this band.
  baseline(db, { subject: "binary_sensor.overloop", shape: "behavioural", centre: 0.05, spread: 0 });

  assert.equal(evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf()).length, 0);
});

test("a machine that was not switched on is obeying, not missing", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  // An air conditioner that runs for a third of this hour most weeks. Not
  // running it is a decision somebody made, and reporting it back is the
  // inverse of the thing worth saying.
  baseline(db, { subject: "climate.airco_zolder", shape: "behavioural", centre: 0.33, spread: 0.05 });

  assert.equal(
    evaluate(db, watchingEntity("climate.airco_zolder", "climate"), snapshotOf()).length,
    0,
  );
});

test("somebody who is out is not a missing sensor", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  // Home for two thirds of this hour in an ordinary week. The evening he is
  // not is an evening out, and the house has nothing to say about it.
  baseline(db, { subject: "person.someone", shape: "behavioural", centre: 0.68, spread: 0.1 });

  assert.equal(
    evaluate(db, watchingEntity("person.someone", "presence"), snapshotOf()).length,
    0,
  );
});

test("an entity that is always active is not missing when it stops", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  // A contact sensor on a door that stands open: on for every minute of the
  // hour, every week. Its going quiet is the door being shut.
  baseline(db, { subject: "binary_sensor.deur_open", shape: "behavioural", centre: 1, spread: 0 });

  assert.equal(evaluate(db, watchingEntity("binary_sensor.deur_open", "openings"), snapshotOf()).length, 0);
});

test("a slot seen twice is not a baseline yet", () => {
  const db = proactiveDb();
  coverEntireHour(db);
  baseline(db, {
    subject: "binary_sensor.overloop",
    shape: "behavioural",
    centre: 0.4,
    spread: 0.05,
    samples: 2,
  });

  assert.equal(evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf()).length, 0);
});

test("a number far from where that hour usually sits is a deviation", () => {
  const db = proactiveDb();
  weekOfBaselines(db, "sensor.verbruik", 100, 10);
  baseline(db, { subject: "sensor.verbruik", shape: "numeric", centre: 100, spread: 10 });

  const findings = evaluate(db, watchingStatistic("sensor.verbruik"), snapshotOf([], [["sensor.verbruik", 400]]));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "deviation");
  assert.equal(findings[0]!.fingerprint, "deviation:sensor.verbruik:high");
  assert.ok(findings[0]!.deviation! > 3.5);

  const low = evaluate(db, watchingStatistic("sensor.verbruik"), snapshotOf([], [["sensor.verbruik", -200]]));
  assert.equal(low[0]!.fingerprint, "deviation:sensor.verbruik:low", "the direction is part of the condition");
});

test("a number near where that hour usually sits is not", () => {
  const db = proactiveDb();
  weekOfBaselines(db, "sensor.verbruik", 100, 10);
  baseline(db, { subject: "sensor.verbruik", shape: "numeric", centre: 100, spread: 10 });

  assert.equal(
    evaluate(db, watchingStatistic("sensor.verbruik"), snapshotOf([], [["sensor.verbruik", 130]])).length,
    0,
  );
});

test("a quantised sensor does not turn one degree into fifty deviations", () => {
  const db = proactiveDb();
  // A disk that reads exactly 37 every hour of every week: no spread within an
  // hour, and none between hours either.
  weekOfBaselines(db, "sensor.schijf_temperatuur", 37, 0);
  baseline(db, { subject: "sensor.schijf_temperatuur", shape: "numeric", centre: 37, spread: 0 });

  const findings = evaluate(
    db,
    watchingStatistic("sensor.schijf_temperatuur"),
    snapshotOf([], [["sensor.schijf_temperatuur", 38]]),
  );

  assert.equal(findings.length, 0, "there is no spread to measure until it ticks over");
});

test("a statistic that is zero in most hours is an event, not a level", () => {
  const db = proactiveDb();
  // The dishwasher: nothing in almost every hour of the week.
  weekOfBaselines(db, "sensor.vaatwasser_energie", 0, 0);
  baseline(db, { subject: "sensor.vaatwasser_energie", shape: "numeric", centre: 0, spread: 0 });

  assert.equal(
    evaluate(
      db,
      watchingStatistic("sensor.vaatwasser_energie"),
      snapshotOf([], [["sensor.vaatwasser_energie", 900]]),
    ).length,
    0,
  );
});

test("a degree off a usual room is a real outlier and not worth a sentence", () => {
  const db = proactiveDb();
  // A bedroom that holds twenty within a fifth of a degree: by its own history,
  // one and a half degrees is five deviations.
  weekOfBaselines(db, "sensor.slaapkamer_temperatuur", 20, 0.2);
  baseline(db, { subject: "sensor.slaapkamer_temperatuur", shape: "numeric", centre: 20, spread: 0.2 });

  const quiet = evaluate(
    db,
    watchingStatistic("sensor.slaapkamer_temperatuur", "temperature", "\u00b0C"),
    snapshotOf([], [["sensor.slaapkamer_temperatuur", 21.5]]),
  );
  assert.equal(quiet.length, 0, "unusual for the sensor, and nothing a person would want told");

  const loud = evaluate(
    db,
    watchingStatistic("sensor.slaapkamer_temperatuur", "temperature", "\u00b0C"),
    snapshotOf([], [["sensor.slaapkamer_temperatuur", 24]]),
  );
  assert.equal(loud.length, 1, "four degrees is a window left open");
  assert.equal(loud[0]!.rule, "deviation");
});

test("a floor is a floor, not a ban on the unit", () => {
  const db = proactiveDb();
  // The house meter: half a kilowatt-hour in an ordinary hour.
  weekOfBaselines(db, "sensor.verbruik_import", 0.5, 0.01);
  baseline(db, { subject: "sensor.verbruik_import", shape: "numeric", centre: 0.5, spread: 0.01 });

  const rounding = evaluate(
    db,
    watchingStatistic("sensor.verbruik_import", "energy", "kWh"),
    snapshotOf([], [["sensor.verbruik_import", 0.6]]),
  );
  assert.equal(rounding.length, 0, "a tenth of a unit, however many deviations it scores");

  const real = evaluate(
    db,
    watchingStatistic("sensor.verbruik_import", "energy", "kWh"),
    snapshotOf([], [["sensor.verbruik_import", 0.9]]),
  );
  assert.equal(real.length, 1, "the reading the rule exists for");
});

test("a meter whose ordinary hour is standby is an event too", () => {
  const db = proactiveDb();
  // The tumble dryer, as measured: two and a half thousandths of a
  // kilowatt-hour in every hour of the week, because it never runs at the same
  // hour twice. Not zero, and no swing either, so neither of the guards the
  // dishwasher and the solar counter needed would catch it.
  weekOfBaselines(db, "sensor.wasdroger_energie", 0.0025, 0);
  baseline(db, { subject: "sensor.wasdroger_energie", shape: "numeric", centre: 0.0025, spread: 0 });

  assert.equal(
    evaluate(
      db,
      watchingStatistic("sensor.wasdroger_energie", "energy", "kWh"),
      snapshotOf([], [["sensor.wasdroger_energie", 0.31]]),
    ).length,
    0,
    "whether it ran is a question for a rule that knows what a cycle is",
  );
});

test("a counter that runs from nothing to thousands holds no level", () => {
  const db = proactiveDb();
  // A solar inverter's lifetime energy: the median hour is a fraction of the
  // hour it peaks at, and what it records is whether the sun was out.
  for (let hour = 0; hour < 24; hour += 1) {
    if (hour === 20) continue;
    baseline(db, {
      subject: "sensor.zon_totaal",
      shape: "numeric",
      centre: hour >= 10 && hour <= 16 ? 3886 : 262,
      spread: 20,
      hour,
    });
  }
  baseline(db, { subject: "sensor.zon_totaal", shape: "numeric", centre: 262, spread: 20 });

  assert.equal(
    evaluate(
      db,
      watchingStatistic("sensor.zon_totaal", "energy", "kWh"),
      snapshotOf([], [["sensor.zon_totaal", 3000]]),
    ).length,
    0,
  );
});

test("a statistic with no baseline for this hour is left alone", () => {
  const db = proactiveDb();
  weekOfBaselines(db, "sensor.verbruik", 100, 10);
  // Every hour but this one.

  assert.equal(
    evaluate(db, watchingStatistic("sensor.verbruik"), snapshotOf([], [["sensor.verbruik", 9000]])).length,
    0,
  );
});

/** A day of changes, day by day, for the stuck rule to have history. */
function history(
  db: DatabaseSync,
  input: { subject: string; group: string; days: number; changesPerDay: number; quietDays: number },
): void {
  const insert = db.prepare(
    `INSERT INTO observations (subject, kind, watch_group, bucket, active_ms, observed_ms, changes, samples)
     VALUES (?, 'state', ?, ?, 0, ?, ?, 1)`,
  );
  const until = HOUR.getTime() + HOUR_MS;
  for (let day = 0; day < input.days; day += 1) {
    const at = until - (day + 1) * 24 * HOUR_MS;
    const quiet = day < input.quietDays;
    insert.run(
      input.subject,
      input.group,
      new Date(at).toISOString(),
      HOUR_MS,
      quiet ? 0 : input.changesPerDay,
    );
  }
}

test("a sensor that normally changes and has not for a day is stuck", () => {
  const db = proactiveDb();
  coverEntireHour(db, 24 * 6);
  history(db, {
    subject: "binary_sensor.overloop",
    group: "motion",
    days: 6,
    changesPerDay: 20,
    quietDays: 1,
  });

  const findings = evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf([["binary_sensor.overloop", "off"]]));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "stuck");
  assert.equal(findings[0]!.expected, 20);
  assert.match(findings[0]!.detail, /has not changed in 24 hours/);
});

test("a sensor that did change is not stuck", () => {
  const db = proactiveDb();
  coverEntireHour(db, 24 * 6);
  history(db, {
    subject: "binary_sensor.overloop",
    group: "motion",
    days: 6,
    changesPerDay: 20,
    quietDays: 0,
  });

  assert.equal(
    evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf([["binary_sensor.overloop", "off"]])).length,
    0,
  );
});

test("a sensor that rarely changes anyway is not stuck", () => {
  const db = proactiveDb();
  coverEntireHour(db, 24 * 6);
  history(db, {
    subject: "binary_sensor.zolderluik",
    group: "openings",
    days: 6,
    changesPerDay: 2,
    quietDays: 1,
  });

  assert.equal(
    evaluate(db, watchingEntity("binary_sensor.zolderluik", "openings"), snapshotOf([["binary_sensor.zolderluik", "off"]]))
      .length,
    0,
  );
});

test("an air conditioner somebody switched off is obeying, not stuck", () => {
  const db = proactiveDb();
  coverEntireHour(db, 24 * 6);
  history(db, {
    subject: "climate.airco_zolder",
    group: "climate",
    days: 6,
    changesPerDay: 20,
    quietDays: 1,
  });

  assert.equal(
    evaluate(db, watchingEntity("climate.airco_zolder", "climate"), snapshotOf([["climate.airco_zolder", "off"]])).length,
    0,
  );
});

test("a day-long outage is not a dead sensor", () => {
  const db = proactiveDb();
  // Plenty of history, but only a few hours of it in the last day.
  coverEntireHour(db, 4);
  history(db, {
    subject: "binary_sensor.overloop",
    group: "motion",
    days: 6,
    changesPerDay: 20,
    quietDays: 1,
  });

  assert.equal(
    evaluate(db, watchingEntity("binary_sensor.overloop"), snapshotOf([["binary_sensor.overloop", "off"]])).length,
    0,
  );
});

test("a sensor that is gone is reported once, not twice", () => {
  const db = proactiveDb();
  coverEntireHour(db, 24 * 6);
  history(db, {
    subject: "binary_sensor.overloop",
    group: "motion",
    days: 6,
    changesPerDay: 20,
    quietDays: 1,
  });

  const findings = evaluate(
    db,
    watchingEntity("binary_sensor.overloop"),
    snapshotOf([["binary_sensor.overloop", "unavailable"]]),
  );

  assert.equal(findings.length, 1, "both rules match, and they share a fingerprint");
  assert.match(findings[0]!.detail, /no reading to give/, "the better-said one wins");
});
