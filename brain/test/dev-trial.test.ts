/**
 * Trying a pull request before it is merged: which pull request a sentence
 * points at, the line the root side reads, and the offer that waits for a yes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { offerNote, OFFER_MS, pullRequestTarget, readTrial, trialLine } from "../dist/dev/trial.js";
import { spokenReady } from "../dist/dev/notify.js";

test("a link or a runner's own words name the pull request and its repository", () => {
  assert.deepEqual(pullRequestTarget("see https://github.com/someone/jarvis-pack-gmail/pull/6 for it"), {
    repo: "pack",
    pack: "gmail",
    number: 6,
  });
  assert.deepEqual(pullRequestTarget("Pull request https://github.com/someone/jarvis-core/pull/19 adds it"), {
    repo: "core",
    number: 19,
  });
  assert.deepEqual(pullRequestTarget("Opened PR #6 on jarvis-pack-gmail (v0.8.0) adding a tool"), {
    repo: "pack",
    pack: "gmail",
    number: 6,
  });
  assert.deepEqual(pullRequestTarget("PR #8 in someone/jarvis-pack-hass, 71 tests green"), {
    repo: "pack",
    pack: "hass",
    number: 8,
  });
});

test("a number without a repository is not guessed at", () => {
  assert.equal(pullRequestTarget("Opened PR #6, all green."), null);
  assert.equal(pullRequestTarget("The time is 14:58."), null);
});

test("the root side is only ever handed a fixed line", () => {
  assert.equal(trialLine({ repo: "core", number: 21 }), "try core 21");
  assert.equal(trialLine({ repo: "pack", pack: "gmail", number: 6 }), "try pack gmail 6");
  assert.equal(trialLine(null), "untry");
});

test("what the root side wrote about a trial is read back, and nonsense is not", () => {
  const trial = readTrial('{"kind":"pack","pack":"gmail","pr":6,"base":"abc","sha":"def","at":"2026-09-28T11:00:00+02:00"}');
  assert.deepEqual(trial?.target, { repo: "pack", pack: "gmail", number: 6 });
  assert.equal(trial?.base, "abc");
  assert.equal(readTrial('{"kind":"core","pack":"","pr":21}')?.target.repo, "core");
  assert.equal(readTrial('{"kind":"pack","pack":"../etc","pr":6}'), null);
  assert.equal(readTrial("not json"), null);
});

test("an offer is put before the next question while it is fresh, and never after", () => {
  const now = new Date("2026-09-28T10:00:00Z");
  const said = spokenReady("Search the full mail history", 6, true);
  assert.ok(said.endsWith("Shall I put it live so you can try it?"));
  const stored = JSON.stringify({ task: 16, said, at: now.getTime() - 60_000 });
  const note = offerNote(stored, now);
  assert.ok(note.includes("try_pull_request with task 16"));
  assert.ok(note.includes(said));
  const stale = JSON.stringify({ task: 16, said, at: now.getTime() - OFFER_MS - 1 });
  assert.equal(offerNote(stale, now), "");
  assert.equal(offerNote("", now), "");
});
