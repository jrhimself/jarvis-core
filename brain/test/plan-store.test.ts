/**
 * Plan usage surviving a process restart.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  configurePlanStore,
  forgetPlanUsage,
  freshenPlanUsage,
  loadPlanUsage,
  notePlanEvent,
  PLAN_USAGE_FILE,
  planUsage,
} from "../dist/plan.js";
import { tempDir } from "./helpers.ts";

const NOW = new Date("2026-09-16T12:00:00Z");
const TONIGHT = Math.floor(Date.parse("2026-09-17T00:00:00Z") / 1000);

test("publish writes plan-usage.json and loadPlanUsage restores it", () => {
  forgetPlanUsage();
  const dir = tempDir();
  configurePlanStore(dir);
  const usage = notePlanEvent(
    { status: "allowed", rateLimitType: "five_hour", utilization: 42, resetsAt: TONIGHT },
    NOW,
  );
  assert.ok(usage !== null);
  assert.equal(planUsage()?.session?.utilization, 42);

  // Simulate a process restart: forget memory, keep the file, load again.
  const kept = dir;
  forgetPlanUsage();
  assert.equal(planUsage(), null);
  configurePlanStore(kept);
  const loaded = loadPlanUsage(NOW);
  assert.ok(loaded !== null);
  assert.equal(loaded.session?.utilization, 42);
  assert.equal(planUsage()?.session?.utilization, 42);

  const raw = JSON.parse(readFileSync(join(kept, PLAN_USAGE_FILE), "utf8")) as {
    session: { utilization: number };
  };
  assert.equal(raw.session.utilization, 42);
});

test("freshenPlanUsage zeroes a window whose resetsAt has passed", () => {
  const stale = freshenPlanUsage(
    {
      status: "warning",
      binding: "session",
      session: { utilization: 88, resetsAt: "2026-09-16T10:00:00.000Z" },
      week: { utilization: 20, resetsAt: "2026-09-20T00:00:00.000Z" },
      at: "2026-09-16T09:00:00.000Z",
    },
    NOW,
  );
  assert.equal(stale.session?.utilization, 0);
  assert.equal(stale.week?.utilization, 20);
  assert.equal(stale.status, "ok");
});

test("loadPlanUsage returns null when the store file is missing", () => {
  forgetPlanUsage();
  configurePlanStore(tempDir());
  assert.equal(loadPlanUsage(NOW), null);
});
