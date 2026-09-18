/**
 * Where the opening ends.
 *
 * The two obvious boundaries are both wrong, and both were tried on a live
 * deployment before this file existed, so each of them has a test naming what
 * it did.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Opening } from "../dist/opening.js";

const LINES = ["Momentje.", "Even kijken."];

test("a silent turn is filled once, with one of the lines", () => {
  const opening = new Opening(LINES, 2000);
  const line = opening.due();
  assert.ok(line !== null && LINES.includes(line));
  // Once per turn: the second silence is the answer's own.
  assert.equal(opening.due(), null);
});

test("a greeting restarts the clock rather than stopping it", () => {
  // The case this was rewritten for: "Goedemorgen." at 1.6 seconds, then
  // twenty-two seconds of nothing. Twelve characters are not an answer.
  const opening = new Opening(LINES, 2000);
  assert.equal(opening.said(), true);
  assert.ok(opening.due() !== null);
});

test("the answer itself closes the opening", () => {
  const opening = new Opening(LINES, 2000);
  opening.told();
  assert.equal(opening.said(), false);
  assert.equal(opening.due(), null);
});

test("a tool that has answered nothing yet does not close it", () => {
  // Between the call going out and the result coming back there is nothing to
  // report, which is the longest silence of the lot.
  const opening = new Opening(LINES, 2000);
  opening.told();
  assert.ok(opening.due() !== null);
});

test("nothing is filled once a line has gone out, whatever happens next", () => {
  const opening = new Opening(LINES, 2000);
  assert.ok(opening.due() !== null);
  assert.equal(opening.said(), false);
  assert.equal(opening.waiting, false);
});

test("two turns in a row never open with the same words", () => {
  let previous: string | null = null;
  for (let turn = 0; turn < 20; turn++) {
    const line = new Opening(LINES, 2000).due();
    assert.ok(line !== null);
    assert.notEqual(line, previous, `turn ${turn} repeated the line before it`);
    previous = line;
  }
  // With one line there is nothing else to say, and it is still said.
  assert.equal(new Opening(["Momentje."], 2000).due(), "Momentje.");
  assert.equal(new Opening(["Momentje."], 2000).due(), "Momentje.");
});

test("a deployment can switch it off from either end", () => {
  assert.equal(new Opening([], 2000).enabled, false);
  assert.equal(new Opening([], 2000).due(), null);
  assert.equal(new Opening(LINES, 0).enabled, false);
  assert.equal(new Opening(LINES, 0).due(), null);
});
