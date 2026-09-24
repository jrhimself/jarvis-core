/**
 * Desk-panel focus: mapping from displays, and the focus/unfocus gate.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ServerMessage } from "@jarvis/shared";

import { FocusGate, panelOfDisplay, windowTopic } from "../dist/focus.js";

test("windowTopic matches the v1 HUD title table", () => {
  assert.equal(windowTopic("Agenda vandaag"), "agenda");
  assert.equal(windowTopic("Kalender"), "agenda");
  assert.equal(windowTopic("Weer"), "weather");
  assert.equal(windowTopic("Pull requests"), "work");
  assert.equal(windowTopic("Notities"), "notes");
  assert.equal(windowTopic("Inbox"), "mail");
  assert.equal(windowTopic(""), "");
});

test("panelOfDisplay mirrors stickyTopicOf for weather, panels and notes", () => {
  assert.equal(
    panelOfDisplay({
      type: "weather",
      title: "Weer",
      units: { temperature: "°C" },
      days: [{ label: "vandaag" }],
    }),
    "weather",
  );
  assert.equal(
    panelOfDisplay({ type: "panel", title: "Mail", rows: [{ label: "a", value: "b" }] }),
    "mail",
  );
  assert.equal(panelOfDisplay({ type: "text", body: "hello" }), "notes");
  assert.equal(panelOfDisplay({ type: "text", title: "Notities", body: "x" }), "notes");
  assert.equal(panelOfDisplay({ type: "image", url: "/media/x", alt: "cam" }), null);
  assert.equal(panelOfDisplay({ type: "chart", title: "kWh", points: [] }), null);
});

test("FocusGate sends focus only on change and unfocus once", () => {
  const sent: ServerMessage[] = [];
  const gate = new FocusGate((m) => sent.push(m));

  gate.focus("weather");
  gate.focus("weather");
  gate.focus("mail", { chars: 12, anchor: "mail|post" });
  gate.unfocus();
  gate.unfocus();

  assert.deepEqual(sent, [
    { kind: "focus", panel: "weather" },
    { kind: "focus", panel: "mail", cue: { chars: 12, anchor: "mail|post" } },
    { kind: "unfocus" },
  ]);
  assert.equal(gate.current, null);
});

test("empty panel ids are ignored", () => {
  const sent: ServerMessage[] = [];
  const gate = new FocusGate((m) => sent.push(m));
  gate.focus("  ");
  assert.equal(sent.length, 0);
});
