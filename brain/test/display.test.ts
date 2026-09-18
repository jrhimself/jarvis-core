/**
 * Which word a window waits for.
 *
 * A tool answers in milliseconds; the sentence about what it found is spoken
 * seconds later. The anchor is how that gap is closed -- the word the answer is
 * about to contain, carried from whoever put the thing on screen all the way to
 * the browser. What can go wrong is that it is dropped somewhere in between, and
 * a dropped anchor is invisible: the window still appears, just under the wrong
 * sentence.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { DisplayDismiss, DisplayPayload } from "@jarvis/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createDisplayServer, showVia } from "../dist/display-tool.js";

interface Shown {
  payload: DisplayPayload;
  dismiss: DisplayDismiss;
  anchor: string | undefined;
}

/** Calls one display tool and reports what reached the sink. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Shown> {
  const shown: Shown[] = [];
  const server = createDisplayServer(
    (_id, payload, dismiss, anchor) => shown.push({ payload, dismiss, anchor }),
    null,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
  try {
    await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
  assert.equal(shown.length, 1, `${name} put exactly one thing on screen`);
  return shown[0] as Shown;
}

const rows = [{ label: "billing@example.com", value: "Invoice February" }];

test("a panel carries the word it should wait for", async () => {
  const shown = await callTool("show_panel", { title: "Mail", rows, anchor: "mail" });
  assert.equal(shown.anchor, "mail");
  assert.deepEqual(shown.payload, { type: "panel", title: "Mail", rows });
});

test("no anchor given is no anchor sent, not an empty one", async () => {
  const shown = await callTool("show_panel", { title: "Mail", rows });
  assert.equal(shown.anchor, undefined);
});

test("a note waits for a word too, and still stays until dismissed", async () => {
  const shown = await callTool("show_note", { body: "Code 4821", anchor: "code" });
  assert.equal(shown.anchor, "code");
  assert.deepEqual(shown.dismiss, { mode: "manual" });
});

test("a chart takes the anchor beside the points it draws", async () => {
  const shown = await callTool("show_chart", {
    title: "Temperature",
    points: [
      { label: "08:00", value: 18 },
      { label: "09:00", value: 19 },
    ],
    anchor: "temperature",
  });
  assert.equal(shown.anchor, "temperature");
});

test("a pack's own window is timed the same way, without a tool call", () => {
  const shown: Shown[] = [];
  const display = showVia((_id, payload, dismiss, anchor) =>
    shown.push({ payload, dismiss, anchor }),
  );

  const id = display({ type: "panel", title: "Mail", rows }, undefined, "mail");

  assert.equal(typeof id, "string");
  assert.equal(shown[0]?.anchor, "mail");
  // The pack said nothing about how long it stays: a panel belongs to the
  // question that produced it.
  assert.deepEqual(shown[0]?.dismiss, { mode: "next-turn" });
});
