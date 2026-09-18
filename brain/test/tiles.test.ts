/**
 * The context panel, and the ways an answer can fail to fill it.
 *
 * The panel it feeds held invented readings until v0.8.0, so the assertions
 * that matter here are the negative ones: an answer that carries no figures,
 * carries broken ones, or failed outright must leave what is on screen alone
 * rather than replace it with a blank or a half-parsed set.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { answer, type HudTile } from "@jarvis/shared";

import {
  factsIn,
  serverOf,
  tileFeed,
  toolOf,
  topicOf,
  usable,
  MAX_TILES,
  type Topic,
} from "../dist/tiles.js";

/** Collects what the feed would have sent to a HUD. */
function collector() {
  const sent: Array<{ source: string; topic: string; tiles: HudTile[] }> = [];
  return {
    sent,
    sink: (source: string, topic: Topic, tiles: HudTile[]) =>
      sent.push({ source, topic: topic.id, tiles }),
  };
}

/** A tool result as the transport delivers it: the envelope, JSON, as a string. */
function result(say: string, facts: readonly HudTile[]): string {
  return JSON.stringify(answer(say, facts).structuredContent);
}

test("the server is read out of the tool name", () => {
  assert.equal(serverOf("mcp__weather__forecast"), "weather");
  assert.equal(serverOf("mcp__gmail__search__deep"), "gmail");
});

test("names that name no server leave the panel alone", () => {
  assert.equal(serverOf("denkt na"), null);
  assert.equal(serverOf("memory_recall"), null);
  assert.equal(serverOf("mcp____forecast"), null);
  assert.equal(serverOf("mcp__weather"), null);
});

test("the tool is read out of the other half of the name", () => {
  assert.equal(toolOf("mcp__weather__forecast"), "forecast");
  assert.equal(toolOf("mcp__gmail__search__deep"), "search__deep");
  assert.equal(toolOf("mcp__weather__"), null);
  assert.equal(toolOf("memory_recall"), null);
});

test("the subject comes off the tool where the server is not one", () => {
  // The house answers three different questions, and they are three blocks.
  assert.deepEqual(topicOf("ha", "get_weather_forecast"), { id: "weather", label: "Weather" });
  assert.deepEqual(topicOf("ha", "get_state"), { id: "house", label: "House" });
  assert.deepEqual(topicOf("calendar", "get_calendar"), { id: "agenda", label: "Agenda" });
});

test("a pack nobody listed still gets a heading", () => {
  assert.deepEqual(topicOf("ado-pr", "list_prs"), { id: "work", label: "Work" });
  assert.deepEqual(topicOf("weather", "forecast"), { id: "weather", label: "Weather" });
  assert.deepEqual(topicOf("tide-clock", null), { id: "tide-clock", label: "Tide clock" });
});

test("blank tiles are dropped and the rest is cut to what fits", () => {
  const many = Array.from({ length: MAX_TILES + 3 }, (_, i) => ({
    label: `n${i}`,
    value: `${i}`,
  }));

  assert.equal(usable(many).length, MAX_TILES);
  assert.deepEqual(usable([{ label: " ", value: "3" }, { label: "Out", value: "" }]), []);
  assert.deepEqual(usable([{ label: " Out ", value: " 14° " }]), [{ label: "Out", value: "14°" }]);
});

test("the facts are read off the envelope the pack returned", () => {
  assert.deepEqual(factsIn(result("het is 14 graden", [{ label: "Out", value: "14°", on: true }])), [
    { label: "Out", value: "14°", on: true },
  ]);
});

test("an answer without figures carries none", () => {
  assert.deepEqual(factsIn(JSON.stringify({ say: "gelukt" })), []);
  assert.deepEqual(factsIn("het is 14 graden"), []);
  assert.deepEqual(factsIn([{ type: "text", text: "het is 14 graden" }]), []);
  assert.deepEqual(factsIn(undefined), []);
});

test("a fact that is not one is skipped rather than shown half", () => {
  const mixed = JSON.stringify({
    facts: [
      { label: "Out", value: 14 },
      "Rain",
      null,
      { value: "3" },
      { label: "In", value: "21°", on: "yes" },
    ],
  });

  assert.deepEqual(factsIn(mixed), [{ label: "In", value: "21°" }]);
});

test("an answer that is not JSON at all does not throw", () => {
  assert.deepEqual(factsIn("{ dit is geen json"), []);
});

test("the pack behind the tool that answered fills the panel", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);

  note("mcp__weather__forecast", result("het is 14 graden", [{ label: "Out", value: "14°" }]));

  assert.deepEqual(sent, [
    { source: "weather", topic: "weather", tiles: [{ label: "Out", value: "14°" }] },
  ]);
});

test("the same figures twice are sent once", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);
  const same = result("het is 14 graden", [{ label: "Out", value: "14°" }]);

  note("mcp__weather__forecast", same);
  note("mcp__weather__hourly", same);

  assert.equal(sent.length, 1);
});

test("figures that moved are sent again", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);

  note("mcp__weather__forecast", result("14", [{ label: "Out", value: "14°" }]));
  note("mcp__weather__forecast", result("15", [{ label: "Out", value: "15°" }]));

  assert.deepEqual(
    sent.map((s) => s.tiles[0]?.value),
    ["14°", "15°"],
  );
});

test("another pack gets a block of its own", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);

  note("mcp__weather__forecast", result("14", [{ label: "Out", value: "14°" }]));
  note("mcp__gmail__search", result("3 ongelezen", [{ label: "Unread", value: "3" }]));

  assert.deepEqual(
    sent.map((s) => s.topic),
    ["weather", "mail"],
  );
});

test("one subject repeating does not silence another", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);
  const weather = result("14", [{ label: "Out", value: "14°" }]);

  note("mcp__ha__get_weather_forecast", weather);
  note("mcp__gmail__search", result("3 ongelezen", [{ label: "Unread", value: "3" }]));
  // The same forecast a second time is still the same forecast, even though
  // another subject was sent in between: the dedupe is per block, not global.
  note("mcp__ha__get_weather_forecast", weather);

  assert.deepEqual(
    sent.map((s) => s.topic),
    ["weather", "mail"],
  );
});

test("a pack with nothing to report keeps the previous panel", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);

  note("mcp__weather__forecast", result("14", [{ label: "Out", value: "14°" }]));
  note("mcp__gmail__search", "3 ongelezen berichten");

  assert.deepEqual(
    sent.map((s) => s.source),
    ["weather"],
  );
});

test("a tool that failed leaves the panel as it was", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);

  note("mcp__gmail__search", "Kon de mailbox niet bereiken: token verlopen.");

  assert.deepEqual(sent, []);
});

test("core's own tools do not touch the panel", () => {
  const { sent, sink } = collector();
  const note = tileFeed(sink);

  note("memory_recall", result("14", [{ label: "Out", value: "14°" }]));

  assert.deepEqual(sent, []);
});
