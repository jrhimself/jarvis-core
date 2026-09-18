/**
 * What the brain remembers about its own screen.
 *
 * Closing a window is the one thing the user can do that destroys information
 * the assistant was relying on. The log exists so that "show me that again" is
 * a lookup rather than a second trip to whatever produced it, and the two
 * things worth pinning down are that the contents survive the closing, and that
 * a window still standing is not reported as gone.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseClientMessage } from "@jarvis/shared";

import {
  describeScreen,
  forgetScreens,
  recentScreens,
  recordScreen,
  screenById,
  screenContents,
  screenGone,
  screenTitle,
} from "../dist/screens.js";

function freshLog(): void {
  forgetScreens();
}

test("a closed window keeps its contents", () => {
  freshLog();
  recordScreen("a1", {
    type: "panel",
    title: "Mail",
    rows: [{ label: "Van de school", value: "2 berichten" }],
  });
  screenGone("a1", "closed");

  const record = screenById("a1");
  assert.ok(record);
  assert.equal(record.gone, "closed");
  // The point of the whole thing: the rows are still readable after the card is
  // gone from the browser.
  assert.match(screenContents(record.payload), /Van de school: 2 berichten/);
});

test("a window still up is not reported as gone", () => {
  freshLog();
  recordScreen("b1", { type: "text", title: "Code", body: "4821" });
  const [record] = recentScreens(1);
  assert.ok(record);
  assert.equal(record.gone, null);
  assert.match(describeScreen(record), /still on screen/);
});

test("the newest window comes first", () => {
  freshLog();
  recordScreen("c1", { type: "text", body: "first" });
  recordScreen("c2", { type: "text", body: "second" });
  assert.deepEqual(
    recentScreens(2).map((record) => record.id),
    ["c2", "c1"],
  );
});

test("a second report does not overwrite how a window went", () => {
  // The HUD can send twice -- a card that times out while the turn that would
  // have cleared it is already running. The first reason is the true one.
  freshLog();
  recordScreen("d1", { type: "text", body: "x" });
  screenGone("d1", "closed");
  screenGone("d1", "next-turn");
  assert.equal(screenById("d1")?.gone, "closed");
});

test("an unknown id is ignored rather than invented", () => {
  freshLog();
  screenGone("nope", "closed");
  assert.equal(screenById("nope"), undefined);
});

test("a chart is summarised by its span, not copied out point by point", () => {
  const text = screenContents({
    type: "chart",
    title: "Buiten",
    unit: "°C",
    points: [
      { label: "08:00", value: 11 },
      { label: "12:00", value: 17 },
      { label: "16:00", value: 14 },
    ],
  });
  assert.match(text, /3 points/);
  assert.match(text, /lowest 11 °C, highest 17 °C/);
});

test("a note without a heading still has something to be called", () => {
  assert.equal(screenTitle({ type: "text", body: "4821" }), "note");
});

test("the HUD's closed-window report is accepted, and a made-up reason is not", () => {
  assert.deepEqual(parseClientMessage({ kind: "display_closed", id: "a1", reason: "closed" }), {
    kind: "display_closed",
    id: "a1",
    reason: "closed",
  });
  assert.equal(parseClientMessage({ kind: "display_closed", id: "a1", reason: "bored" }), null);
  assert.equal(parseClientMessage({ kind: "display_closed", id: "", reason: "closed" }), null);
});
