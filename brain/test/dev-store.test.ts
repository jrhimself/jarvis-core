/**
 * The row that outlives the conversation.
 *
 * A pull request opened at eleven is approved the next morning by a different
 * agent process, so everything about a fix that can still be asked about has to
 * be in the database rather than in a field on a session object. These tests are
 * mostly about that: what survives, what the day boundary counts, and that a
 * partial update leaves the rest of the row alone.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DatabaseSync } from "node:sqlite";

import {
  awaitingDevTask,
  createDevTask,
  devTask,
  lastFailedDevTask,
  latestDevTasks,
  migrateDev,
  runningDevTask,
  smallFixesToday,
  updateDevTask,
} from "../dist/dev/store.js";
import { devDb } from "./helpers.ts";

// These assertions are about a house in one particular place, so they name it
// rather than inherit whatever zone the machine running them happens to have.
// That is the whole point of `JARVIS_TIMEZONE`: on a container it is UTC.
process.env["JARVIS_TIMEZONE"] = "Europe/Amsterdam";
process.env["JARVIS_LOCALE"] = "nl-NL";


const AT = new Date("2026-08-27T19:00:00.000Z");

test("a started fix is findable while it runs and no longer after", () => {
  const db = devDb();
  const id = createDevTask(db, { instruction: "accu van de stofzuiger", size: "small", state: "running" }, AT);

  const running = runningDevTask(db);
  assert.notEqual(running, null);
  assert.equal(running?.id, id);
  assert.equal(running?.instruction, "accu van de stofzuiger");

  updateDevTask(db, id, { state: "awaiting" }, AT);
  assert.equal(runningDevTask(db), null);
  assert.equal(awaitingDevTask(db)?.id, id);
});

test("an update writes only the fields it was given", () => {
  const db = devDb();
  const id = createDevTask(db, { instruction: "iets", size: "small", state: "running", detail: "bezig" }, AT);
  updateDevTask(db, id, { branch: "jarvis/iets-2708" }, AT);
  updateDevTask(db, id, { prNumber: 42, prUrl: "https://github.com/x/y/pull/42" }, AT);

  const task = devTask(db, id);
  // Field by field: node:sqlite rows have a null prototype and the shaping is
  // the thing being checked.
  assert.equal(task?.branch, "jarvis/iets-2708");
  assert.equal(task?.prNumber, 42);
  assert.equal(task?.detail, "bezig");
  assert.equal(task?.state, "running");
});

test("an update with nothing in it does not touch the row", () => {
  const db = devDb();
  const id = createDevTask(db, { instruction: "iets", size: "small", state: "running" }, AT);
  updateDevTask(db, id, {}, new Date("2026-08-28T09:00:00.000Z"));
  assert.equal(devTask(db, id)?.updatedAt, AT.toISOString());
});

test("nulls can be written back, so a branch can be forgotten", () => {
  const db = devDb();
  const id = createDevTask(db, { instruction: "iets", size: "small", state: "running" }, AT);
  updateDevTask(db, id, { branch: "jarvis/iets" }, AT);
  updateDevTask(db, id, { branch: null }, AT);
  assert.equal(devTask(db, id)?.branch, null);
});

test("the newest waiting fix wins when there are two", () => {
  const db = devDb();
  createDevTask(db, { instruction: "oude", size: "small", state: "awaiting" }, AT);
  const newer = createDevTask(db, { instruction: "nieuwe", size: "small", state: "awaiting" }, AT);
  assert.equal(awaitingDevTask(db)?.id, newer);
});

test("the day's budget counts attempts, not successes", () => {
  const db = devDb();
  const now = new Date("2026-08-27T19:00:00.000Z");
  createDevTask(db, { instruction: "een", size: "small", state: "failed" }, now);
  createDevTask(db, { instruction: "twee", size: "small", state: "abandoned" }, now);
  assert.equal(smallFixesToday(db, now), 2);
});

test("a delegated job does not spend the small-fix budget", () => {
  const db = devDb();
  const now = new Date("2026-08-27T19:00:00.000Z");
  createDevTask(db, { instruction: "groot", size: "big", state: "delegated" }, now);
  assert.equal(smallFixesToday(db, now), 0);
});

test("yesterday's fixes do not count against today", () => {
  const db = devDb();
  createDevTask(db, { instruction: "gisteren", size: "small", state: "merged" }, new Date("2026-08-26T19:00:00.000Z"));
  assert.equal(smallFixesToday(db, new Date("2026-08-27T19:00:00.000Z")), 0);
});

test("late evening and the small hours are the same day only until midnight at home", () => {
  const db = devDb();
  // 22:30 UTC in August is 00:30 in Amsterdam: already the next day here, which
  // is exactly the boundary a UTC comparison would get wrong.
  createDevTask(db, { instruction: "laat", size: "small", state: "merged" }, new Date("2026-08-27T21:00:00.000Z"));
  assert.equal(smallFixesToday(db, new Date("2026-08-27T21:30:00.000Z")), 1);
  assert.equal(smallFixesToday(db, new Date("2026-08-27T22:30:00.000Z")), 0);
});

test("the output that ended an attempt is kept next to the sentence about it", () => {
  const db = devDb();
  const id = createDevTask(db, { instruction: "accu erbij", size: "small", state: "running" }, AT);
  updateDevTask(
    db,
    id,
    { state: "failed", detail: "de tests bleven rood", log: "not ok 12 - accu\n  expected 3, got 4" },
    AT,
  );

  const task = devTask(db, id);
  assert.equal(task?.detail, "de tests bleven rood");
  assert.match(String(task?.log), /expected 3, got 4/);
});

test("an attempt that failed on nothing readable has no log rather than an empty one", () => {
  const db = devDb();
  const id = createDevTask(db, { instruction: "iets", size: "small", state: "running" }, AT);
  updateDevTask(db, id, { state: "failed", detail: "de poging brak af", log: null }, AT);
  assert.equal(devTask(db, id)?.log, null);
});

test("a database written before the log existed gets the column and keeps its rows", () => {
  // The shape of the table as it shipped, so the migration is exercised rather
  // than described: a fix that failed yesterday must still be readable today.
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE dev_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      instruction TEXT NOT NULL,
      size        TEXT NOT NULL,
      state       TEXT NOT NULL,
      branch      TEXT,
      worktree    TEXT,
      pr_url      TEXT,
      pr_number   INTEGER,
      slot        INTEGER,
      detail      TEXT NOT NULL DEFAULT ''
    );
  `);
  const iso = AT.toISOString();
  db.prepare(
    `INSERT INTO dev_tasks (created_at, updated_at, instruction, size, state, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(iso, iso, "van gisteren", "small", "failed", "de tests bleven rood");

  migrateDev(db);
  migrateDev(db);

  const old = lastFailedDevTask(db);
  assert.equal(old?.instruction, "van gisteren");
  assert.equal(old?.log, null);

  updateDevTask(db, Number(old?.id), { log: "not ok 1" }, AT);
  assert.equal(lastFailedDevTask(db)?.log, "not ok 1");
});

test("the last failure is the newest of both ways an attempt comes to nothing", () => {
  const db = devDb();
  createDevTask(db, { instruction: "eerste", size: "small", state: "failed" }, AT);
  createDevTask(db, { instruction: "tweede", size: "small", state: "abandoned" }, AT);
  createDevTask(db, { instruction: "derde", size: "small", state: "merged" }, AT);
  createDevTask(db, { instruction: "vierde", size: "small", state: "awaiting" }, AT);

  assert.equal(lastFailedDevTask(db)?.instruction, "tweede");
});

test("nothing has failed yet reads as nothing, not as the oldest row", () => {
  const db = devDb();
  createDevTask(db, { instruction: "loopt", size: "small", state: "running" }, AT);
  assert.equal(lastFailedDevTask(db), null);
});

test("the history reads newest first", () => {
  const db = devDb();
  createDevTask(db, { instruction: "eerste", size: "small", state: "merged" }, AT);
  createDevTask(db, { instruction: "tweede", size: "small", state: "merged" }, AT);
  assert.deepEqual(latestDevTasks(db, 5).map((task) => task.instruction), ["tweede", "eerste"]);
});
