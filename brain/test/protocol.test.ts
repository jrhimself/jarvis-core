/**
 * The wire protocol between the HUD and the brain.
 *
 * The parser is the only thing standing between a browser page and the rest of
 * the brain, so what it refuses matters as much as what it accepts. `say` in
 * particular carries a language that ends up in a URL: anything other than the
 * two we know must not get through.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseClientMessage } from "@jarvis/shared";

test("a say without a language is Dutch by omission", () => {
  const parsed = parseClientMessage({ kind: "say", text: "Goedemorgen.", turnId: "t1" });
  assert.deepEqual(parsed, { kind: "say", text: "Goedemorgen.", turnId: "t1" });
});

test("a say carries the language when it names one", () => {
  const parsed = parseClientMessage({
    kind: "say",
    text: "All systems online.",
    turnId: "t2",
    lang: "en",
  });
  assert.deepEqual(parsed, {
    kind: "say",
    text: "All systems online.",
    turnId: "t2",
    lang: "en",
  });
});

test("a say with an unknown language is refused outright", () => {
  // Not silently corrected to Dutch: a language we do not know means the page
  // is not the page we wrote, and guessing on its behalf is how odd things
  // reach the voice API.
  assert.equal(
    parseClientMessage({ kind: "say", text: "Hallo", turnId: "t3", lang: "de" }),
    null,
  );
});

test("a say needs text and a turn", () => {
  assert.equal(parseClientMessage({ kind: "say", text: "   ", turnId: "t4" }), null);
  assert.equal(parseClientMessage({ kind: "say", text: "Hallo", turnId: "" }), null);
  assert.equal(parseClientMessage({ kind: "say", turnId: "t5" }), null);
});
