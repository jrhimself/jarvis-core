/**
 * The answer first: waited for as long as a turn can wait, and delivered
 * unprompted when it comes later. The web lookup itself is a model run and is
 * not exercised here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { answerFirst, STAND_IN_TOOLS } from "../dist/dev/stand-in.js";

test("an answer found in time is returned to the turn, and nothing is sent later", async () => {
  const late: Array<string | null> = [];
  const answer = await answerFirst(Promise.resolve("They are resurfacing the streets."), 1_000, (a) => late.push(a));
  assert.equal(answer, "They are resurfacing the streets.");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(late, []);
});

test("an answer that comes after the turn gave up waiting is delivered on its own", async () => {
  const late: Array<string | null> = [];
  const slow = new Promise<string | null>((resolve) => setTimeout(() => resolve("found it"), 50));
  const answer = await answerFirst(slow, 10, (a) => late.push(a));
  assert.equal(answer, null);
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(late, ["found it"]);
});

test("nothing found in time is nothing said by the turn", async () => {
  const late: Array<string | null> = [];
  assert.equal(await answerFirst(Promise.resolve(null), 1_000, (a) => late.push(a)), null);
  assert.deepEqual(late, []);
});

test("the stand-in can read the web and do nothing else", () => {
  assert.deepEqual([...STAND_IN_TOOLS].sort(), ["WebFetch", "WebSearch"]);
});

test("nothing found after the turn promised an answer is said as well", async () => {
  const late: Array<string | null> = [];
  const slow = new Promise<string | null>((resolve) => setTimeout(() => resolve(null), 50));
  assert.equal(await answerFirst(slow, 10, (a) => late.push(a)), null);
  await slow;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(late, [null]);
});
