/**
 * Searching the exact words of earlier exchanges.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { tempStore } from "./helpers.ts";

test("every term must appear, in the question or in the answer, newest first", () => {
  const store = tempStore();
  store.logTurn("s1", "What did the plumber say?", "He comes on Thursday.");
  store.logTurn("s1", "Is it going to rain?", "Yes, from three o'clock.");
  store.logTurn("s2", "Remind me about the plumber", "I will remind you Thursday morning.");

  const both = store.searchTurns(["plumber", "Thursday"], null, 10);
  assert.deepEqual(both.map((turn) => turn.asked), ["Remind me about the plumber", "What did the plumber say?"]);

  assert.equal(store.searchTurns(["plumber", "rain"], null, 10).length, 0);
  assert.equal(store.searchTurns(["rain"], null, 10).length, 1);
});

test("the search is bounded by time and by count", () => {
  const store = tempStore();
  for (let i = 0; i < 5; i += 1) store.logTurn(null, `question ${i} about tea`, "answer");

  assert.equal(store.searchTurns(["tea"], null, 3).length, 3);
  assert.equal(store.searchTurns(["tea"], new Date(Date.now() + 60_000).toISOString(), 10).length, 0);
});

test("wildcards typed by a person are words, not patterns", () => {
  const store = tempStore();
  store.logTurn(null, "it is 100% done", "yes");
  store.logTurn(null, "it is 100 done", "yes");

  assert.equal(store.searchTurns(["100%"], null, 10).length, 1);
  assert.equal(store.searchTurns(["_"], null, 10).length, 0);
});
