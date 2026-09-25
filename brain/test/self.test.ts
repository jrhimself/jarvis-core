/**
 * The checks JARVIS makes on himself.
 *
 * Two things are being tested and they are not the same. One: that a job which
 * stopped running is noticed, which is the whole reason any of this exists.
 * Two: that nothing here fires on a reading it could not take -- an unmeasured
 * disk, a systemd that is not there, a database with no history yet. The second
 * matters more. A self check that cries wolf is one people switch off, and then
 * the first thing is worthless.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";

import { reconcile, openAnomalies } from "../dist/proactive/detect.js";
import { SELF_RULES } from "../dist/proactive/rules.js";
import type { SelfReading } from "../dist/proactive/self.js";
import {
  JOBS,
  SHIPPED_TIMERS,
  expectedJobs,
  inspect,
  judge,
  parseExpiries,
} from "../dist/proactive/self.js";
import { beat, heartbeats, metricAt, pruneMetrics, recordMetric } from "../dist/proactive/store.js";
import { proactiveDb, tempDir } from "./helpers.ts";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const NOW = new Date("2026-08-22T21:00:00.000Z");

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

/** A reading in which everything is exactly as it should be. */
function healthy(over: Partial<SelfReading> = {}): SelfReading {
  const beats = new Map(
    JOBS.map((job) => [
      job.name,
      {
        name: job.name,
        at: ago(HOUR_MS).toISOString(),
        ok: true,
        okAt: ago(HOUR_MS).toISOString(),
        detail: "",
      },
    ]),
  );

  return {
    heartbeats: beats,
    jobs: JOBS,
    since: ago(30 * DAY_MS),
    newestObservation: ago(4 * 60_000),
    newestNote: ago(DAY_MS),
    counts: { facts: 170, corpusFiles: 137, watchlist: 210 },
    before: { facts: 168, corpusFiles: 137, watchlist: 210 },
    diskUsed: 0.22,
    rssBytes: 700 * 1024 * 1024,
    restarts: 12,
    restartsBefore: 11,
    failedUnits: [],
    timers: new Map(
      SHIPPED_TIMERS.map((timer) => [timer, { installed: true, enabled: true, armed: true }]),
    ),
    git: { dirty: false, synced: true },
    missingConfig: [],
    timeZone: { zone: "Europe/Amsterdam", fromHost: false },
    expiries: [],
    ...over,
  };
}

/** Every shipped timer healthy, except the ones named. */
function timersWith(
  overrides: Record<string, { installed: boolean; enabled: boolean; armed: boolean }>,
): Map<string, { installed: boolean; enabled: boolean; armed: boolean }> {
  const timers = new Map(
    SHIPPED_TIMERS.map((timer) => [
      timer,
      { installed: true, enabled: true, armed: true },
    ]),
  );
  for (const [timer, state] of Object.entries(overrides)) timers.set(timer, state);
  return timers;
}

function fingerprints(reading: SelfReading): string[] {
  return judge(reading, NOW)
    .map((found) => found.fingerprint)
    .sort();
}

test("a house in order says nothing about itself", () => {
  assert.deepEqual(fingerprints(healthy()), []);
});

test("a job that missed its night is late, one that is merely due is not", () => {
  const late = healthy();
  late.heartbeats.set("corpus", {
    name: "corpus",
    at: ago(2 * DAY_MS).toISOString(),
    ok: true,
    okAt: ago(2 * DAY_MS).toISOString(),
    detail: "",
  });
  assert.deepEqual(fingerprints(late), ["heartbeat:corpus"]);

  // Twenty-five hours is a daily job with a jittered timer, not a problem.
  const due = healthy();
  due.heartbeats.set("corpus", {
    name: "corpus",
    at: ago(25 * HOUR_MS).toISOString(),
    ok: true,
    okAt: ago(25 * HOUR_MS).toISOString(),
    detail: "",
  });
  assert.deepEqual(fingerprints(due), []);
});

test("a job that ran and failed is a finding even though it ran", () => {
  const failed = healthy();
  failed.heartbeats.set("backup", {
    name: "backup",
    at: ago(HOUR_MS).toISOString(),
    ok: false,
    okAt: ago(3 * DAY_MS).toISOString(),
    detail: "the copy failed its integrity check",
  });

  const found = judge(failed, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.fingerprint, "heartbeat:backup");
  assert.match(found[0]?.detail ?? "", /integrity check/);
});

test("a job that has never run is judged against how long JARVIS has", () => {
  const fresh = healthy({ heartbeats: new Map(), since: ago(2 * HOUR_MS) });
  assert.deepEqual(fingerprints(fresh), []);

  const old = healthy({ heartbeats: new Map(), since: ago(30 * DAY_MS) });
  assert.deepEqual(
    fingerprints(old),
    JOBS.map((job) => `heartbeat:${job.name}`).sort(),
  );
});

test("a deployment with no house is not asked for baselines", () => {
  // The baselines are the one job no timer speaks for, so nothing else would
  // stop a houseless install being told nightly that they never ran.
  const houseless = expectedJobs(false).map((job) => job.name);
  assert.ok(!houseless.includes("baselines"));
  assert.deepEqual(expectedJobs(true), JOBS);

  const silent = healthy({ heartbeats: new Map(), jobs: expectedJobs(false), since: ago(30 * DAY_MS) });
  assert.deepEqual(
    fingerprints(silent),
    ["heartbeat:backup", "heartbeat:consolidate", "heartbeat:corpus"],
  );
});

test("how long JARVIS has been running does not depend on having a house", async () => {
  // Without a house nothing is ever observed, and an age read from the
  // observations alone would leave every job forever too young to be late.
  const db = proactiveDb();
  recordMetric(db, "host.rss_mb", 700, ago(20 * DAY_MS));

  const config = {
    memoryPath: tempDir(),
    corpusDir: join(tempDir(), "notes"),
    haUrl: "",
    haToken: "",
    elevenLabsKey: "",
    voiceId: "",
    devGitHubRepo: "",
    devGitHubToken: "",
  } as never;

  const reading = await inspect(db, config, null, NOW);
  assert.equal(reading.since?.toISOString(), ago(20 * DAY_MS).toISOString());
  assert.equal(reading.counts.watchlist, null);
  assert.ok(!reading.jobs.some((job) => job.name === "baselines"));
});

test("a count that fell is noticed, and one that grew is not", () => {
  const lost = healthy({
    counts: { facts: 120, corpusFiles: 137, watchlist: 210 },
    before: { facts: 170, corpusFiles: 137, watchlist: 210 },
  });
  assert.deepEqual(fingerprints(lost), ["invariant:shrink:facts"]);

  const grew = healthy({
    counts: { facts: 200, corpusFiles: 137, watchlist: 210 },
    before: { facts: 170, corpusFiles: 137, watchlist: 210 },
  });
  assert.deepEqual(fingerprints(grew), []);

  // Consolidation merges facts every week; a few per cent is that, not a loss.
  const trimmed = healthy({
    counts: { facts: 162, corpusFiles: 137, watchlist: 210 },
    before: { facts: 170, corpusFiles: 137, watchlist: 210 },
  });
  assert.deepEqual(fingerprints(trimmed), []);
});

test("a feed that stopped is noticed within the quarter hour", () => {
  const quiet = healthy({ newestObservation: ago(40 * 60_000) });
  assert.deepEqual(fingerprints(quiet), ["invariant:observations"]);

  const justRestarted = healthy({ newestObservation: ago(11 * 60_000) });
  assert.deepEqual(fingerprints(justRestarted), []);
});

test("notes that stopped arriving are noticed after a week", () => {
  assert.deepEqual(fingerprints(healthy({ newestNote: ago(9 * DAY_MS) })), ["invariant:notes"]);
  assert.deepEqual(fingerprints(healthy({ newestNote: ago(3 * DAY_MS) })), []);
});

test("the host is judged on disk, memory and restarts", () => {
  assert.deepEqual(fingerprints(healthy({ diskUsed: 0.91 })), ["invariant:disk"]);
  assert.deepEqual(fingerprints(healthy({ rssBytes: 2_000 * 1024 * 1024 })), ["invariant:rss"]);
  assert.deepEqual(fingerprints(healthy({ restarts: 20, restartsBefore: 11 })), [
    "invariant:restarts",
  ]);

  // A deploy is one restart. That is not a crash loop.
  assert.deepEqual(fingerprints(healthy({ restarts: 12, restartsBefore: 11 })), []);
});

test("systemd and the working copy are held to what was designed", () => {
  assert.deepEqual(fingerprints(healthy({ failedUnits: ["jarvis-corpus.service"] })), [
    "invariant:units",
  ]);
  assert.deepEqual(fingerprints(healthy({ timers: timersWith({ "jarvis-backup.timer": { installed: true, enabled: true, armed: false } }) })), [
    "invariant:timers",
  ]);
  assert.deepEqual(fingerprints(healthy({ git: { dirty: true, synced: true } })), [
    "invariant:git",
  ]);
  assert.deepEqual(fingerprints(healthy({ git: { dirty: false, synced: false } })), [
    "invariant:git",
  ]);
  assert.deepEqual(fingerprints(healthy({ missingConfig: ["HA_TOKEN"] })), ["invariant:config"]);
});

test("a timer this machine never enabled is a decision, not a fault", () => {
  // install-units.sh enables nothing on purpose. Somebody who runs the brain and
  // nothing else has not got a broken backup; they have not got a backup timer.
  const notEnabled = timersWith({
    "jarvis-corpus.timer": { installed: true, enabled: false, armed: false },
    "jarvis-backup.timer": { installed: true, enabled: false, armed: false },
    "jarvis-consolidate.timer": { installed: true, enabled: false, armed: false },
    "jarvis-cert-renew.timer": { installed: true, enabled: false, armed: false },
  });

  // Drop the heartbeats of everything a unit drives. What is left is `baselines`,
  // which this process arms itself whenever the proactive side is on at all and
  // is therefore still expected -- the distinction this check is about.
  const unitDriven = new Set(JOBS.filter((job) => job.timer !== "").map((job) => job.name));
  const beats = new Map([...healthy().heartbeats].filter(([name]) => !unitDriven.has(name)));

  assert.deepEqual(fingerprints(healthy({ timers: notEnabled, heartbeats: beats })), []);
});

test("a job whose timer was never enabled is not expected to have run", () => {
  const noCorpus = timersWith({
    "jarvis-corpus.timer": { installed: false, enabled: false, armed: false },
  });
  const beats = new Map(
    [...healthy().heartbeats].filter(([name]) => name !== "corpus"),
  );

  assert.deepEqual(fingerprints(healthy({ timers: noCorpus, heartbeats: beats })), []);
});

test("a job that has reported is watched however it is driven", () => {
  // No timer for it, but it has evidently been running: something drives it, and
  // its silence is still worth hearing about.
  const stale = new Map(healthy().heartbeats);
  stale.set("corpus", { name: "corpus", at: ago(4 * DAY_MS).toISOString(), ok: true, okAt: ago(4 * DAY_MS).toISOString(), detail: "" });

  assert.deepEqual(
    fingerprints(healthy({
      timers: timersWith({ "jarvis-corpus.timer": { installed: false, enabled: false, armed: false } }),
      heartbeats: stale,
    })),
    ["heartbeat:corpus"],
  );
});

test("half-configured is a fault, absent is not", () => {
  // A URL with no token reads as somebody who meant to have a house.
  assert.deepEqual(fingerprints(healthy({ missingConfig: ["HA_TOKEN"] })), ["invariant:config"]);
  // Nothing configured at all is a working assistant that offers less.
  assert.deepEqual(fingerprints(healthy({ missingConfig: [] })), []);
});

test("a container that inherited UTC is told, and a deliberate UTC is not", () => {
  // The cutover case: nothing named a zone and the machine says UTC, which is a
  // container's default rather than anybody's decision.
  assert.deepEqual(fingerprints(healthy({ timeZone: { zone: "UTC", fromHost: true } })), [
    "invariant:timezone",
  ]);

  // Naming it, even as UTC, is an answer and is left alone.
  assert.deepEqual(fingerprints(healthy({ timeZone: { zone: "UTC", fromHost: false } })), []);

  // A host that knows where it is needs no prompting either.
  assert.deepEqual(
    fingerprints(healthy({ timeZone: { zone: "Europe/Berlin", fromHost: true } })),
    [],
  );
});

test("nothing that could not be read is ever a finding", () => {
  const blind = healthy({
    since: null,
    newestObservation: null,
    newestNote: null,
    counts: { facts: null, corpusFiles: null, watchlist: null },
    before: { facts: null, corpusFiles: null, watchlist: null },
    diskUsed: null,
    rssBytes: null,
    restarts: null,
    restartsBefore: null,
    failedUnits: null,
    timers: null,
    git: null,
    missingConfig: [],
  });
  assert.deepEqual(fingerprints(blind), []);
});

test("a first day with no history compares against nothing and stays quiet", () => {
  const first = healthy({
    counts: { facts: 12, corpusFiles: 4, watchlist: 210 },
    before: { facts: null, corpusFiles: null, watchlist: null },
    restarts: 3,
    restartsBefore: null,
  });
  assert.deepEqual(fingerprints(first), []);
});

test("a heartbeat keeps the last success when a later run fails", async () => {
  const db = proactiveDb();

  beat(db, "corpus", true, "137 notes");
  const good = heartbeats(db).get("corpus");
  assert.equal(good?.ok, true);
  assert.equal(good?.okAt, good?.at);

  // Genuinely later, rather than trusting two writes in the same millisecond to
  // sort themselves out -- the tie that broke this suite once already.
  await setTimeout(5);
  beat(db, "corpus", false, "ssh: connect to host failed");
  const bad = heartbeats(db).get("corpus");
  assert.equal(bad?.ok, false);
  assert.equal(bad?.detail, "ssh: connect to host failed");
  assert.equal(bad?.okAt, good?.okAt);
  assert.notEqual(bad?.at, good?.at);
});

test("a metric is read as of a moment, and pruned by age", () => {
  const db = proactiveDb();

  recordMetric(db, "memory.facts", 100, ago(3 * DAY_MS));
  recordMetric(db, "memory.facts", 150, ago(DAY_MS));
  recordMetric(db, "memory.facts", 170, NOW);

  assert.equal(metricAt(db, "memory.facts", ago(DAY_MS)), 150);
  assert.equal(metricAt(db, "memory.facts", ago(2 * DAY_MS)), 100);
  assert.equal(metricAt(db, "memory.facts", ago(10 * DAY_MS)), null);
  assert.equal(metricAt(db, "nothing.here", NOW), null);

  assert.equal(pruneMetrics(db, 2, NOW), 1);
  assert.equal(metricAt(db, "memory.facts", ago(2 * DAY_MS)), null);
});

test("a self pass does not close what the house pass opened", () => {
  const db = proactiveDb();
  const long = new Date(NOW.getTime() + 12 * HOUR_MS);

  reconcile(
    db,
    [
      {
        fingerprint: "problem:binary_sensor.waterlek",
        rule: "problem",
        subject: "binary_sensor.waterlek",
        watchGroup: "problems",
        area: null,
        observed: 1,
        expected: 0,
        deviation: null,
        detail: "reporting a problem",
      },
    ],
    NOW,
  );

  // Half a day later the self pass runs on its own, as it would on an evening
  // when Home Assistant cannot be reached. The leak is still a leak.
  reconcile(db, [], long, SELF_RULES);

  const open = openAnomalies(db);
  assert.equal(open.length, 1);
  assert.equal(open[0]?.fingerprint, "problem:binary_sensor.waterlek");
});

test("expiry dates are read as name=YYYY-MM-DD pairs, and a bad date is kept", () => {
  const read = parseExpiries(" model=2027-08-23, github = 2026-12-01 ,=2026-01-01, typo=2027-02-31,");
  assert.deepEqual(
    read.map((e) => [e.name, e.date?.toISOString().slice(0, 10) ?? null]),
    [
      ["model", "2027-08-23"],
      ["github", "2026-12-01"],
      ["typo", null],
    ],
  );
  assert.deepEqual(parseExpiries(""), []);
});

test("a credential far from expiring says nothing", () => {
  assert.deepEqual(fingerprints(healthy({ expiries: parseExpiries("model=2027-08-23") })), []);
});

test("a credential within a month of expiring is a finding of its own", () => {
  const reading = healthy({ expiries: parseExpiries("model=2026-09-12,other=2027-01-01") });
  assert.deepEqual(fingerprints(reading), ["invariant:expiry:model"]);
  assert.match(judge(reading, NOW)[0]?.detail ?? "", /model expires on 2026-09-12, in 21 days/);
});

test("an expired credential says so, with how long ago", () => {
  const found = judge(healthy({ expiries: parseExpiries("model=2026-08-20") }), NOW);
  assert.match(found[0]?.detail ?? "", /model expired on 2026-08-20, 2 days ago/);
});

test("a date that does not parse is a finding, not silence", () => {
  const reading = healthy({ expiries: parseExpiries("model=23-08-2027") });
  assert.deepEqual(fingerprints(reading), ["invariant:expiry:model"]);
  assert.match(judge(reading, NOW)[0]?.detail ?? "", /not a YYYY-MM-DD date/);
});
