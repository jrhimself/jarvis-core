/**
 * What JARVIS still does in a house that can barely do anything.
 *
 * The rest of the proactive tests run against a house with history and
 * statistics, because that is the house this was written in. This file runs the
 * same startup against the other kind: a provider with the six required methods
 * and nothing else, which is what any adapter that is not Home Assistant will
 * start life as.
 *
 * The property under test is not "it does not crash" -- it is that the parts
 * which need no capability keep working at full strength. The watchlist is
 * still resolved, the live feed is still subscribed to, the buckets still fill,
 * the baselines still build from what has been observed. Only the running start
 * is lost: no ten days of recorder history, no numeric baselines. The
 * difference is a fortnight of patience, not a broken assistant.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { StatisticMeta, StatisticPoint } from "@jarvis/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createDisplayServer } from "../dist/display-tool.js";

import { buildBaselines } from "../dist/proactive/baselines.js";
import { detect } from "../dist/proactive/detect.js";
import { beginObserving } from "../dist/proactive/index.js";
import { fakeHome, proactiveDb, quietlyAsync } from "./helpers.ts";

/** A house with motion, a door and a person in it, and no memory of any of them. */
function bareHouse() {
  return fakeHome({
    capabilities: { history: false, statistics: false, camera: false, calendar: false },
    entities: [
      { id: "binary_sensor.overloop", deviceClass: "motion", state: "on", area: "Overloop" },
      { id: "binary_sensor.voordeur", deviceClass: "door", state: "off", area: "Voordeur" },
      { id: "person.someone", state: "home" },
    ],
  });
}

test("a house with no history and no statistics is still worth watching", async () => {
  const home = bareHouse();
  assert.equal(home.history, undefined, "the fake must not offer what it cannot do");
  assert.equal(home.statisticIds, undefined);
  assert.equal(home.statistics, undefined);

  const db = proactiveDb();
  const observation = await quietlyAsync(() => beginObserving(home, db, Date.parse("2026-08-29T10:00:00Z")));

  assert.deepEqual(
    observation.watchlist.entities.map((entity) => entity.entityId).sort(),
    ["binary_sensor.overloop", "binary_sensor.voordeur", "person.someone"],
    "every behavioural entity is watched; only the numbers are missing",
  );
  assert.deepEqual(observation.watchlist.statistics, [], "nothing keeps statistics here");
});

test("the buckets fill from the live feed alone", async () => {
  const home = bareHouse();
  const db = proactiveDb();

  const start = Date.parse("2026-08-29T10:00:00Z");
  const observation = await quietlyAsync(() => beginObserving(home, db, start));
  const rollup = observation.rollup;

  rollup.observe(
    {
      entityId: "binary_sensor.overloop",
      state: "on",
      attributes: {},
      changedAt: new Date(start + 60_000),
    },
    start + 60_000,
  );
  rollup.flush(start + 120_000);

  const rows = db
    .prepare("SELECT subject, active_ms FROM observations WHERE subject = ?")
    .all("binary_sensor.overloop") as Array<{ subject: string; active_ms: number }>;

  assert.ok(rows.length > 0, "a bucket was written without a single history row");
});

test("what is actually lost is the numeric half, and only that", async () => {
  // The same house twice, once with statistics and once without, so the
  // difference between the two reports is the whole cost of the capability.
  const meta: StatisticMeta = {
    statisticId: "sensor.verbruik",
    shape: "total",
    unit: "kWh",
    unitClass: "energy",
  };
  const points: StatisticPoint[] = [];
  for (const day of ["2026-07-28", "2026-08-04", "2026-08-11", "2026-08-18"]) {
    points.push({ at: new Date(`${day}T18:00:00.000Z`), value: 0.4 });
  }

  const rich = fakeHome({
    entities: [{ id: "binary_sensor.overloop", deviceClass: "motion" }],
    statisticIds: [meta],
    statistics: new Map([[meta.statisticId, points]]),
  });
  const richDb = proactiveDb();
  const richWatchlist = (await quietlyAsync(() => beginObserving(rich, richDb, Date.now())))
    .watchlist;
  const richReport = await buildBaselines(rich, richDb, richWatchlist);

  assert.ok(richReport.numeric > 0, "a house that keeps statistics gets numeric baselines");

  const bare = bareHouse();
  const bareDb = proactiveDb();
  const bareWatchlist = (await quietlyAsync(() => beginObserving(bare, bareDb, Date.now())))
    .watchlist;
  const bareReport = await buildBaselines(bare, bareDb, bareWatchlist);

  assert.equal(bareReport.numeric, 0, "no statistics, so no numeric baseline is attempted");
  assert.equal(bareReport.behavioural, richReport.behavioural, "the other half is unaffected");
});

test("the rules run against a house that can only say what it reads now", async () => {
  const home = bareHouse();
  const db = proactiveDb();

  const observation = await quietlyAsync(() => beginObserving(home, db, Date.now()));
  const report = await quietlyAsync(() =>
    detect(home, db, observation.watchlist, new Map([["binary_sensor.overloop", "on"]])),
  );

  assert.equal(typeof report.opened, "number");
  assert.equal(typeof report.resolved, "number");
});

/** Which tools a display server actually offers, by name. */
async function displayTools(home: Parameters<typeof createDisplayServer>[1]) {
  const server = createDisplayServer(() => {}, home);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
  try {
    const listed = await client.listTools();
    return listed.tools.map((entry) => entry.name).sort();
  } finally {
    await client.close();
  }
}

test("a house with no cameras is never offered a camera tool", async () => {
  const withCameras = fakeHome({ capabilities: { camera: true } });
  assert.ok(
    (await displayTools(withCameras)).includes("show_camera"),
    "a house that has cameras still gets the tool",
  );

  // Both ways of having no camera: a house that says so, and no house at all.
  // Registering the tool and failing at call time would be worse than useless
  // -- the assistant reads its tool list as a list of promises, and a promise
  // it discovers is empty halfway through an answer is one the user has heard.
  assert.deepEqual(await displayTools(bareHouse()), await displayTools(null));
  assert.equal((await displayTools(bareHouse())).includes("show_camera"), false);
});
