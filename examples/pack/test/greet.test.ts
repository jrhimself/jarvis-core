/**
 * The line, at the four hours it changes.
 *
 * Imported from `../dist/`, because that is what the repository's own `npm test`
 * has built by the time it gets here. A pack in its own repository tests the
 * source instead — either way, only modules whose sibling imports are types can
 * be reached, which is why this imports `greet` and never `index`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { exampleFacts, greeting, partOf } from "../dist/greet.js";

const CONFIG = { who: "Ada" };

function at(hour: number): Date {
  return new Date(2026, 0, 15, hour, 0, 0);
}

test("the greeting follows the clock", () => {
  assert.equal(greeting(CONFIG, at(3)), "goedenacht Ada");
  assert.equal(greeting(CONFIG, at(9)), "goedemorgen Ada");
  assert.equal(greeting(CONFIG, at(14)), "goedemiddag Ada");
  assert.equal(greeting(CONFIG, at(21)), "goedenavond Ada");
});

test("a name in the call wins over the configured one", () => {
  assert.equal(greeting(CONFIG, at(9), "Grace"), "goedemorgen Grace");
});

test("a blank name falls back rather than greeting nobody", () => {
  assert.equal(greeting(CONFIG, at(9), "   "), "goedemorgen Ada");
});

test("the anchor is a word the spoken answer certainly contains", () => {
  for (const hour of [3, 9, 14, 21]) {
    assert.ok(greeting(CONFIG, at(hour)).includes(partOf(at(hour))));
  }
});

test("the facts on the answer report what the pack knows, not what it guesses", () => {
  assert.deepEqual(exampleFacts(CONFIG, at(9)), [
    { label: "Greeting", value: "goedemorgen" },
    { label: "Who", value: "Ada", on: true },
  ]);
});
