/**
 * Jobs for later: what a schedule means, and what happens when one comes due.
 *
 * The parts that can be wrong without anybody noticing are the calendar ones
 * -- a nine o'clock that drifts an hour across the clocks changing, a Monday
 * that is really a Sunday -- so those are pinned to real dates in a real zone.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { describeSchedule, nextRun, parseSchedule, ScheduleError } from "../dist/schedule.js";
import { addJob, dueJobs, finishRun, getJob, listJobs, MAX_ACTIVE_JOBS, migrateSchedules, removeJob, runNow, setJobState } from "../dist/schedule-store.js";
import { framePrompt, isSilent, tick } from "../dist/scheduler.js";
import { renderJob } from "../dist/schedule-tools.js";
import { withEnv } from "./helpers.ts";

const AMSTERDAM = { JARVIS_TIMEZONE: "Europe/Amsterdam" };

function db(): DatabaseSync {
  const conn = new DatabaseSync(":memory:");
  migrateSchedules(conn);
  return conn;
}

const at = (iso: string): Date => new Date(iso);

test("the accepted forms turn into schedules", () => {
  withEnv(AMSTERDAM, () => {
    const now = at("2026-10-01T10:00:00Z");
    assert.deepEqual(parseSchedule("in 30m", now), { kind: "once", at: "2026-10-01T10:30:00.000Z" });
    assert.deepEqual(parseSchedule("every 2h", now), { kind: "every", ms: 7_200_000 });
    assert.deepEqual(parseSchedule("weekdays at 8:30", now), { kind: "cron", expr: "30 8 * * 1-5" });
    assert.deepEqual(parseSchedule("Every Monday at 9am", now), { kind: "cron", expr: "0 9 * * 1" });
    assert.deepEqual(parseSchedule("daily at 9pm", now), { kind: "cron", expr: "0 21 * * *" });
    assert.deepEqual(parseSchedule("*/15 * * * *", now), { kind: "cron", expr: "*/15 * * * *" });
    // A wall-clock time with no offset is the household's, not UTC.
    assert.deepEqual(parseSchedule("2026-10-05T09:00", now), { kind: "once", at: "2026-10-05T07:00:00.000Z" });
    assert.deepEqual(parseSchedule("2026-10-05T09:00:00+02:00", now), { kind: "once", at: "2026-10-05T07:00:00.000Z" });
  });
});

test("what cannot be honoured is refused with the forms that can", () => {
  const now = at("2026-10-01T10:00:00Z");
  for (const bad of ["", "whenever", "every 1m", "in 10s", "61 * * * *", "* * * *", "2020-01-01T09:00", "every funday at 9"]) {
    assert.throws(() => parseSchedule(bad, now), ScheduleError, bad);
  }
});

test("nine o'clock stays nine o'clock across the clocks changing", () => {
  withEnv(AMSTERDAM, () => {
    const daily = parseSchedule("daily at 9:00", at("2026-01-01T00:00:00Z"));
    // Summer time begins on 29 March: 09:00 is 08:00 UTC before it and 07:00 UTC after.
    assert.equal(nextRun(daily, at("2026-03-28T12:00:00Z"))?.toISOString(), "2026-03-29T07:00:00.000Z");
    assert.equal(nextRun(daily, at("2026-03-27T12:00:00Z"))?.toISOString(), "2026-03-28T08:00:00.000Z");
    // And back on 25 October.
    assert.equal(nextRun(daily, at("2026-10-24T12:00:00Z"))?.toISOString(), "2026-10-25T08:00:00.000Z");
  });
});

test("weekdays skip the weekend, and the answer is strictly after the moment given", () => {
  withEnv(AMSTERDAM, () => {
    const weekdays = parseSchedule("weekdays at 8:30", at("2026-10-01T00:00:00Z"));
    // Friday afternoon -> Monday morning.
    assert.equal(nextRun(weekdays, at("2026-10-02T10:00:00Z"))?.toISOString(), "2026-10-05T06:30:00.000Z");
    // Exactly at the time is not "after".
    assert.equal(nextRun(weekdays, at("2026-10-05T06:30:00Z"))?.toISOString(), "2026-10-06T06:30:00.000Z");
  });
});

test("a date and a weekday together mean either, as cron does", () => {
  withEnv(AMSTERDAM, () => {
    const schedule = parseSchedule("0 12 13 * 5", at("2026-10-01T00:00:00Z"));
    // 13 October 2026 is a Tuesday; the Friday the 2nd comes first.
    assert.equal(nextRun(schedule, at("2026-10-01T00:00:00Z"))?.toISOString(), "2026-10-02T10:00:00.000Z");
  });
});

test("a one-off in the past never comes due", () => {
  assert.equal(nextRun({ kind: "once", at: "2026-01-01T00:00:00.000Z" }, at("2026-10-01T00:00:00Z")), null);
});

test("a schedule is described in words", () => {
  withEnv(AMSTERDAM, () => {
    assert.match(describeSchedule({ kind: "every", ms: 7_200_000 }), /every 2 hour/);
    assert.match(describeSchedule({ kind: "cron", expr: "0 9 * * 1" }), /0 9 \* \* 1/);
  });
});

test("a job is stored, comes due, and works out what is next from when it ran", () => {
  const conn = db();
  const t0 = at("2026-10-01T10:00:00Z");
  const job = addJob(conn, { name: "stretch", spec: "every 30m", schedule: { kind: "every", ms: 1_800_000 }, prompt: "Remind me to stretch", deliver: "all", repeat: null }, t0);

  assert.equal(job.nextRun, "2026-10-01T10:30:00.000Z");
  assert.equal(dueJobs(conn, at("2026-10-01T10:29:00Z")).length, 0);
  assert.equal(dueJobs(conn, at("2026-10-01T10:31:00Z")).length, 1);

  // An hour late: the next run counts from now, so it does not fire twice to catch up.
  const after = finishRun(conn, job.id, { ok: true, result: "done" }, at("2026-10-01T11:30:00Z"));
  assert.equal(after?.nextRun, "2026-10-01T12:00:00.000Z");
  assert.equal(after?.runs, 1);
});

test("a one-off is done after it ran, and so is a job that has run its count", () => {
  const conn = db();
  const t0 = at("2026-10-01T10:00:00Z");
  const once = addJob(conn, { name: "once", spec: "in 10m", schedule: { kind: "once", at: "2026-10-01T10:10:00.000Z" }, prompt: "Say hello", deliver: "all", repeat: null }, t0);
  assert.equal(finishRun(conn, once.id, { ok: true, result: "x" }, at("2026-10-01T10:11:00Z"))?.state, "done");

  const twice = addJob(conn, { name: "twice", spec: "every 10m", schedule: { kind: "every", ms: 600_000 }, prompt: "Say hello", deliver: "all", repeat: 2 }, t0);
  assert.equal(finishRun(conn, twice.id, { ok: true, result: "x" }, at("2026-10-01T10:11:00Z"))?.state, "active");
  assert.equal(finishRun(conn, twice.id, { ok: true, result: "x" }, at("2026-10-01T10:22:00Z"))?.state, "done");
  assert.equal(dueJobs(conn, at("2027-01-01T00:00:00Z")).length, 0, "a finished job never comes due again");
});

test("pausing keeps a job from running and resuming works the next run out from now", () => {
  const conn = db();
  const t0 = at("2026-10-01T10:00:00Z");
  const job = addJob(conn, { name: "n", spec: "every 10m", schedule: { kind: "every", ms: 600_000 }, prompt: "Say hello", deliver: "all", repeat: null }, t0);

  setJobState(conn, job.id, "paused", t0);
  assert.equal(dueJobs(conn, at("2026-10-02T00:00:00Z")).length, 0);

  const resumed = setJobState(conn, job.id, "active", at("2026-10-02T00:00:00Z"));
  assert.equal(resumed?.nextRun, "2026-10-02T00:10:00.000Z");

  runNow(conn, job.id, at("2026-10-02T00:01:00Z"));
  assert.equal(dueJobs(conn, at("2026-10-02T00:01:00Z")).length, 1);

  assert.equal(removeJob(conn, job.id), true);
  assert.equal(getJob(conn, job.id), null);
  assert.equal(listJobs(conn).length, 0);
});

test("there is a ceiling on how many jobs are active", () => {
  const conn = db();
  const t0 = at("2026-10-01T10:00:00Z");
  for (let i = 0; i < MAX_ACTIVE_JOBS; i += 1) {
    addJob(conn, { name: `job ${i}`, spec: "every 1h", schedule: { kind: "every", ms: 3_600_000 }, prompt: "Say hello", deliver: "all", repeat: null }, t0);
  }
  assert.throws(
    () => addJob(conn, { name: "one too many", spec: "every 1h", schedule: { kind: "every", ms: 3_600_000 }, prompt: "Say hello", deliver: "all", repeat: null }, t0),
    /already 25 active/,
  );
});

test("the framed prompt says nobody is there and how to say nothing", () => {
  const conn = db();
  const job = addJob(conn, { name: "post", spec: "every 1h", schedule: { kind: "every", ms: 3_600_000 }, prompt: "Check the post", deliver: "all", repeat: null }, at("2026-10-01T10:00:00Z"));
  const framed = framePrompt(job, at("2026-10-01T11:00:00Z"));
  assert.match(framed, /Nobody is waiting/);
  assert.match(framed, /only the word SILENT/);
  assert.match(framed, /Check the post$/);
  assert.equal(isSilent(" [silent]. "), true);
  assert.equal(isSilent("Silent night"), false);
});

test("a due job runs, is delivered, and a silent one is not", async () => {
  const conn = db();
  const t0 = at("2026-10-01T10:00:00Z");
  addJob(conn, { name: "loud", spec: "in 10m", schedule: { kind: "once", at: "2026-10-01T10:10:00.000Z" }, prompt: "Say hello", deliver: "all", repeat: null }, t0);
  addJob(conn, { name: "quiet one", spec: "every 10m", schedule: { kind: "every", ms: 600_000 }, prompt: "Watch the post", deliver: "all", repeat: null }, t0);

  const delivered: Array<{ name: string; text: string; kind: string }> = [];
  const ran = await tick({
    db: conn,
    now: () => at("2026-10-01T10:11:00Z"),
    run: async (_prompt, job) => (job.name === "loud" ? "Hello there." : "SILENT"),
    deliver: async (job, text, kind) => {
      delivered.push({ name: job.name, text, kind });
    },
  });

  assert.equal(ran, 2);
  assert.deepEqual(delivered, [{ name: "loud", text: "Hello there.", kind: "result" }]);
  assert.equal(listJobs(conn).find((job) => job.name === "quiet one")?.lastResult, "nothing to report");
});

test("a job that keeps failing is paused and says so", async () => {
  const conn = db();
  const t0 = at("2026-10-01T10:00:00Z");
  const job = addJob(conn, { name: "flaky", spec: "every 10m", schedule: { kind: "every", ms: 600_000 }, prompt: "Say hello", deliver: "all", repeat: null }, t0);

  const notices: string[] = [];
  const deps = {
    db: conn,
    run: async (): Promise<string> => {
      throw new Error("the model is down");
    },
    deliver: async (_job: unknown, text: string, kind: string) => {
      assert.equal(kind, "failure");
      notices.push(text);
    },
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    for (let minute = 11; minute <= 51; minute += 20) {
      await tick({ ...deps, now: () => at(`2026-10-01T10:${minute}:00Z`) });
    }
  } finally {
    console.error = originalError;
  }

  assert.equal(getJob(conn, job.id)?.state, "paused");
  assert.equal(notices.length, 3);
  assert.match(notices[2] ?? "", /paused/);
  assert.match(notices[0] ?? "", /the model is down/);
});

test("a job reads back as a few lines", () => {
  const conn = db();
  const job = addJob(conn, { name: "post", spec: "every 1h", schedule: { kind: "every", ms: 3_600_000 }, prompt: "Check the post", deliver: "all", repeat: null }, at("2026-10-01T10:00:00Z"));
  const text = renderJob(job);
  assert.match(text, /#1 "post" -- active, every 1 hour/);
  assert.match(text, /does: Check the post/);
});
