/**
 * The clock the model is handed with every question.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { nowBlock } from "../dist/now.js";
import { withEnv } from "./helpers.ts";

/** Half past two in the afternoon in Amsterdam, on a Wednesday. */
const NOW = new Date("2026-09-16T12:30:00Z");

test("the block carries the local moment and names the zone", () => {
  const block = withEnv({ JARVIS_TIMEZONE: "Europe/Brussels", JARVIS_LOCALE: "nl-NL" }, () =>
    nowBlock(NOW),
  );

  assert.match(block, /^\[Now: /);
  assert.match(block, /woensdag 16 september 2026/);
  assert.match(block, /14:30/);
  assert.match(block, /\(Europe\/Brussels\)/);
});

test("the same moment reads in the configured language", () => {
  const block = withEnv({ JARVIS_TIMEZONE: "Europe/Brussels", JARVIS_LOCALE: "en-GB" }, () =>
    nowBlock(NOW),
  );

  assert.match(block, /Wednesday/);
  assert.match(block, /16 September 2026/);
});

test("a zone away from the house moves the hour, not just the label", () => {
  const block = withEnv({ JARVIS_TIMEZONE: "UTC", JARVIS_LOCALE: "en-GB" }, () => nowBlock(NOW));

  assert.match(block, /12:30/);
  assert.match(block, /\(UTC\)/);
});
