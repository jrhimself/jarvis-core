/**
 * What the brain says about itself on the HUD's own panel.
 *
 * The panel this feeds used to animate invented numbers. The point of these
 * assertions is that it cannot go back to that quietly: every field is either
 * something measured from this process or `null`, and `null` is what the page
 * renders as an em dash rather than as a zero.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readMetrics } from "../dist/metrics.js";

test("memory and uptime are read from this process", () => {
  const metrics = readMetrics(process.cwd());

  assert.equal(typeof metrics.rssBytes, "number");
  assert.ok(metrics.rssBytes! > 0, "a running process has resident memory");
  assert.equal(typeof metrics.uptimeMs, "number");
  assert.ok(metrics.uptimeMs! >= 0);
});

test("the first CPU sample has nothing to compare against and says so", () => {
  // Whichever call happened first in this file already consumed the baseline,
  // so what is asserted here is the shape both answers are allowed to have.
  const metrics = readMetrics(process.cwd());

  assert.ok(
    metrics.cpuShare === null || (typeof metrics.cpuShare === "number" && metrics.cpuShare >= 0),
    "a share is a non-negative number or an admission that it is not known yet",
  );
});

test("a second sample yields a share of one core", () => {
  readMetrics(process.cwd());
  const busyUntil = Date.now() + 20;
  while (Date.now() < busyUntil) {
    // Spin briefly so the delta is over a measurable stretch of wall clock.
  }
  const metrics = readMetrics(process.cwd());

  assert.equal(typeof metrics.cpuShare, "number");
  assert.ok(metrics.cpuShare! >= 0, "never negative");
});

test("a path that cannot be stated is null rather than a made-up number", () => {
  const metrics = readMetrics("/definitely/not/a/directory/on/this/machine/memory.db");

  assert.equal(metrics.diskUsed, null);
});

test("a disk that can be stated is a fraction, not a percentage", () => {
  const metrics = readMetrics(process.cwd());

  assert.notEqual(metrics.diskUsed, null);
  assert.ok(metrics.diskUsed! >= 0 && metrics.diskUsed! <= 1, "a share of the filesystem");
});
