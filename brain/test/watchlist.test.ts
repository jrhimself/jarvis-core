/**
 * Deciding what is worth watching.
 *
 * Every exclusion here was paid for. The car reports doors and windows and
 * sleeps every night; the cameras report motion and fire at rain. Selecting on
 * device class alone gives you a watchlist of a parked car, so the registry is read
 * and the platform decides.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { StatisticMeta } from "@jarvis/shared";

import {
  ignoredPlatforms,
  STATE_GROUPS,
  describeWatchlist,
  resolveWatchlist,
} from "../dist/proactive/watchlist.js";
import { fakeHome } from "./helpers.ts";

function group(id: string) {
  const found = STATE_GROUPS.find((candidate) => candidate.id === id);
  assert.notEqual(found, undefined, `no group ${id}`);
  return found!;
}

function candidate(entityId: string, deviceClass: string | null = null) {
  return {
    entityId,
    domain: entityId.split(".")[0] ?? "",
    deviceClass,
    platform: null,
    area: null,
  };
}

test("a binary sensor belongs to a group by what it measures", () => {
  assert.ok(group("motion").matches(candidate("binary_sensor.gang_boven", "occupancy")));
  assert.ok(group("openings").matches(candidate("binary_sensor.voordeur", "door")));
  assert.ok(group("safety").matches(candidate("binary_sensor.rookmelder", "smoke")));
  assert.ok(group("problems").matches(candidate("binary_sensor.vaatwasser", "problem")));

  // No device class is no group: the id says nothing reliable.
  assert.equal(
    STATE_GROUPS.some((candidateGroup) => candidateGroup.matches(candidate("binary_sensor.iets"))),
    false,
  );
  assert.equal(
    STATE_GROUPS.some((candidateGroup) => candidateGroup.matches(candidate("sensor.temperatuur"))),
    false,
    "a number is a statistic, not behaviour",
  );
});

test("a person and a tracker are presence, whatever they are called", () => {
  assert.ok(group("presence").matches(candidate("person.alex")));
  assert.ok(group("presence").matches(candidate("device_tracker.telefoon_alex")));
});

test("what counts as the thing happening is the group's to decide", () => {
  assert.equal(group("motion").active("on"), true);
  assert.equal(group("motion").active("off"), false);

  // A named zone is not home.
  assert.equal(group("presence").active("home"), true);
  assert.equal(group("presence").active("not_home"), false);
  assert.equal(group("presence").active("Werk"), false);

  // A climate entity's state is its mode, and every mode but off is running.
  assert.equal(group("climate").active("cool"), true);
  assert.equal(group("climate").active("heat"), true);
  assert.equal(group("climate").active("off"), false);
  assert.equal(group("climate").active("unavailable"), false);
  assert.equal(group("climate").active("unknown"), false);
});

const STATISTICS: StatisticMeta[] = [
  { statisticId: "sensor.verbruik", shape: "total", unit: "kWh", unitClass: "energy" },
  { statisticId: "sensor.woonkamer_temp", shape: "measurement", unit: "°C", unitClass: "temperature" },
  { statisticId: "sensor.wifi_signaal", shape: "measurement", unit: "dBm", unitClass: "signal_strength" },
];

test("the car and the cameras are kept off the list", async () => {
  process.env["JARVIS_WATCH_IGNORE_PLATFORMS"] = " camera_platform , vehicle_platform ,";
  assert.deepEqual([...ignoredPlatforms()].sort(), ["camera_platform", "vehicle_platform"]);

  const home = fakeHome({
    entities: [
      { id: "binary_sensor.auto_deur", platform: "vehicle_platform", deviceClass: "door" },
      { id: "binary_sensor.buiten_beweging", platform: "camera_platform", deviceClass: "motion" },
      { id: "binary_sensor.gang_boven", platform: "light_platform", deviceClass: "motion", state: "on" },
    ],
  });

  const watchlist = await resolveWatchlist(home, []);

  assert.deepEqual(
    watchlist.entities.map((entity) => entity.entityId),
    ["binary_sensor.gang_boven"],
  );
});

test("an entity that is disabled or a setting is not a signal", async () => {
  const home = fakeHome({
    entities: [
      { id: "binary_sensor.uit", disabled: true, deviceClass: "motion" },
      { id: "binary_sensor.instelling", category: "config", deviceClass: "motion" },
      // Diagnostic stays: all 58 problem sensors are diagnostic.
      { id: "binary_sensor.vaatwasser", category: "diagnostic", deviceClass: "problem" },
    ],
  });

  const watchlist = await resolveWatchlist(home, []);

  assert.deepEqual(
    watchlist.entities.map((entity) => entity.entityId),
    ["binary_sensor.vaatwasser"],
  );
});

test("the room an entity is in travels with it", async () => {
  const home = fakeHome({
    entities: [
      { id: "binary_sensor.eigen", area: "Overloop", deviceClass: "motion" },
      { id: "binary_sensor.via_apparaat", area: "Zolder", deviceClass: "motion" },
      { id: "binary_sensor.nergens", deviceClass: "motion" },
    ],
  });

  const watchlist = await resolveWatchlist(home, []);

  assert.deepEqual(
    watchlist.entities.map((entity) => entity.area),
    ["Overloop", "Zolder", null],
  );
});

test("an entity no registry ever heard of is judged on its state alone", async () => {
  const home = fakeHome({
    entities: [{ id: "binary_sensor.yaml", state: "on", deviceClass: "motion" }],
  });

  const watchlist = await resolveWatchlist(home, []);

  assert.equal(watchlist.entities.length, 1);
  assert.equal(watchlist.entities[0]!.group, "motion");
});

test("only energy and temperature are worth a numeric baseline", async () => {
  const watchlist = await resolveWatchlist(fakeHome(), STATISTICS);

  assert.deepEqual(
    watchlist.statistics.map((watched) => [watched.meta.statisticId, watched.group]),
    [
      ["sensor.verbruik", "energy"],
      ["sensor.woonkamer_temp", "temperature"],
    ],
  );
});

test("an energy statistic that is not a total is not the house's consumption", async () => {
  const watchlist = await resolveWatchlist(fakeHome(), [
    { statisticId: "sensor.vermogen", shape: "measurement", unit: "W", unitClass: "energy" },
  ]);

  assert.equal(watchlist.statistics.length, 0);
});

test("the watchlist describes itself by group", () => {
  const description = describeWatchlist({
    entities: [
      { entityId: "binary_sensor.a", group: "motion", area: null },
      { entityId: "binary_sensor.b", group: "motion", area: null },
      { entityId: "person.alex", group: "presence", area: null },
    ],
    statistics: [
      { meta: STATISTICS[0]!, group: "energy" },
    ],
  });

  assert.equal(
    description,
    "watching 3 entities (motion 2, presence 1) and 1 statistics (energy 1)",
  );
});
