/**
 * The briefing said again.
 *
 * What can go wrong is on either side of the two-hour line: a briefing said
 * again from a cache that has gone stale, or fetched afresh when the one from
 * ten minutes ago would have done. And the windows: a second telling with the
 * text and without the agenda on screen is half a briefing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { DisplayPayload } from "@jarvis/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  BRIEFING_CACHE_KEY,
  BriefingCache,
  againHook,
  asksForBriefing,
  createBriefingServer,
  freshInstruction,
  gateHook,
  looksGated,
  marksBriefing,
  repeatInstruction,
} from "../dist/briefing.js";

const HOUR = 3_600_000;

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    setting: (key: string) => values.get(key) ?? null,
    setSetting: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

const agenda: DisplayPayload = { type: "panel", title: "Agenda", rows: [{ label: "09:00", value: "Standup" }] };

test("a tool called with briefing: true marks the turn, nothing else does", () => {
  assert.equal(marksBriefing({ briefing: true }), true);
  assert.equal(marksBriefing({ briefing: true, again: true }), true);
  assert.equal(marksBriefing({ briefing: false }), false);
  assert.equal(marksBriefing({ days: 1 }), false);
  assert.equal(marksBriefing("briefing"), false);
  assert.equal(marksBriefing(null), false);
});

test("a briefing is fresh within the window and stale past it", () => {
  const store = memory();
  const cache = new BriefingCache(store, 2 * HOUR);
  const at = Date.parse("2026-09-22T07:38:00+02:00");
  cache.remember({ lang: "nl", text: "Goedemorgen.", windows: [] }, at);
  assert.ok(store.values.has(BRIEFING_CACHE_KEY));
  assert.equal(cache.fresh(at + 10 * 60_000)?.text, "Goedemorgen.");
  assert.equal(cache.fresh(at + 2 * HOUR - 1)?.text, "Goedemorgen.");
  assert.equal(cache.fresh(at + 2 * HOUR + 1), null);
  assert.equal(cache.last()?.text, "Goedemorgen.", "stale is still the last one");
});

test("a window of zero keeps nothing at all", () => {
  const store = memory();
  const cache = new BriefingCache(store, 0);
  cache.remember({ lang: "nl", text: "Goedemorgen.", windows: [] });
  assert.equal(store.values.size, 0);
  assert.equal(cache.fresh(), null);
});

test("what is in the store but not a briefing is nothing, not a crash", () => {
  assert.equal(new BriefingCache(memory({ [BRIEFING_CACHE_KEY]: "{not json" }), HOUR).last(), null);
  assert.equal(
    new BriefingCache(memory({ [BRIEFING_CACHE_KEY]: JSON.stringify({ at: "x", text: 3 }) }), HOUR).last(),
    null,
  );
});

test("the instruction to repeat carries the text, and a translation note when the language moved", () => {
  const cached = { at: new Date(Date.now() - 12 * 60_000).toISOString(), lang: "nl" as const, text: "Het regent.", windows: [] };
  const same = repeatInstruction(cached, "nl");
  assert.match(same, /12 minutes ago/);
  assert.match(same, /Do not fetch anything\./);
  assert.ok(same.endsWith("\n\nHet regent."));
  assert.match(same, /Say it in Dutch, whatever language the text below is in/);
  assert.match(repeatInstruction(cached, "en"), /given in Dutch; say it in English/);
});

test("the instruction to start afresh says why, and how to get past the daily gate", () => {
  assert.match(freshInstruction(null, 2 * HOUR), /no earlier one to repeat/);
  assert.match(freshInstruction(null, 2 * HOUR), /last 2 hours/);
  assert.match(freshInstruction(null, 2 * HOUR), /again=true together with briefing=true/);
  const old = { at: "2026-09-22T05:38:00.000Z", lang: "nl" as const, text: "x", windows: [] };
  assert.match(freshInstruction(old, 2 * HOUR), /the last one was at \d\d:\d\d/);
});

async function callAgain(cache: BriefingCache, maxAgeMs: number) {
  const shown: Array<{ payload: DisplayPayload; anchor: string | undefined }> = [];
  const server = createBriefingServer(
    cache,
    (payload, _dismiss, anchor) => {
      shown.push({ payload, anchor });
      return "id";
    },
    () => "en",
    maxAgeMs,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = (await client.callTool({ name: "briefing_again", arguments: {} })) as {
      content: Array<{ type: string; text?: string }>;
    };
    return { text: result.content[0]?.text ?? "", shown };
  } finally {
    await client.close();
  }
}

test("asked again within the window, the tool puts the windows back and hands over the text", async () => {
  const cache = new BriefingCache(memory(), 2 * HOUR);
  cache.remember({
    lang: "en",
    text: "Good morning. Rain later.",
    windows: [{ payload: agenda, dismiss: { mode: "next-turn" }, anchor: "agenda|calendar" }],
  });
  const { text, shown } = await callAgain(cache, 2 * HOUR);
  assert.match(text, /Say the briefing again now/);
  assert.ok(text.endsWith("Good morning. Rain later."));
  assert.equal(shown.length, 1);
  assert.deepEqual(shown[0], { payload: agenda, anchor: "agenda|calendar" });
});

test("asked again with nothing recent, the tool shows nothing and asks for a fresh one", async () => {
  const cache = new BriefingCache(memory(), 2 * HOUR);
  cache.remember({ lang: "en", text: "Old.", windows: [{ payload: agenda, dismiss: { mode: "next-turn" } }] }, Date.now() - 3 * HOUR);
  const { text, shown } = await callAgain(cache, 2 * HOUR);
  assert.match(text, /Give a full, fresh briefing now/);
  assert.equal(shown.length, 0);
});

test("asking for the briefing is recognised in either language, and a letter is not", () => {
  for (const ask of [
    "brief me",
    "Brief me volledig opnieuw",
    "brief me helemaal opnieuw",
    "kan ik de briefing krijgen",
    "briefing please",
    "brief me again",
    "nog een keer de briefing",
  ]) {
    assert.equal(asksForBriefing(ask), true, ask);
  }
  for (const other of ["stuur een brief naar de gemeente", "what is in the mail", "hoe is het weer"]) {
    assert.equal(asksForBriefing(other), false, other);
  }
});

test("the gate's answer is recognised as the gate, in a text or in a tool result", () => {
  assert.equal(looksGated("Vandaag al gebriefd om 08:50. Alleen groeten."), true);
  assert.equal(looksGated("Good morning. Already briefed today, so that's it for now."), true);
  assert.equal(looksGated({ content: [{ type: "text", text: "Vandaag al gebriefd om 08:50." }] }), true);
  assert.equal(looksGated("Good morning. Twelve pull requests open, none for you."), false);
});

test("a turn answered by the gate is not kept as the briefing, and one kept earlier is not repeated", () => {
  const store = memory();
  const cache = new BriefingCache(store, 2 * HOUR);
  cache.remember({ lang: "en", text: "Good morning. Already briefed today, so that's it for now.", windows: [] });
  assert.equal(cache.last(), null, "never written");
  store.setSetting(
    BRIEFING_CACHE_KEY,
    JSON.stringify({ at: new Date().toISOString(), lang: "en", text: "Already briefed today.", windows: [] }),
  );
  assert.equal(cache.fresh(), null, "a poisoned entry from before is not a briefing either");
});

const hookEnv = { signal: new AbortController().signal };
const base = { session_id: "s", transcript_path: "", cwd: "" };

test("on a turn that asked, a briefing call goes out with again=true whether the model said so or not", async () => {
  let asked = true;
  const [hook] = againHook(() => asked).hooks;
  assert.ok(hook !== undefined);
  const call = (tool_input: Record<string, unknown>) =>
    hook({ ...base, hook_event_name: "PreToolUse", tool_name: "get_ado_pr_status", tool_input, tool_use_id: "t1" } as never, "t1", hookEnv);
  const forced = (await call({ briefing: true })) as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } };
  assert.deepEqual(forced.hookSpecificOutput?.updatedInput, { briefing: true, again: true });
  assert.deepEqual(await call({ deep: true }), {}, "a call that is not the briefing is left alone");
  asked = false;
  assert.deepEqual(await call({ briefing: true }), {}, "a greeting keeps its gate");
});

test("a briefing call answered by the gate marks the turn", async () => {
  let gated = 0;
  const [hook] = gateHook(() => gated++).hooks;
  assert.ok(hook !== undefined);
  const call = (tool_input: Record<string, unknown>, tool_response: unknown) =>
    hook({ ...base, hook_event_name: "PostToolUse", tool_name: "x", tool_input, tool_response, tool_use_id: "t1" } as never, "t1", hookEnv);
  await call({ briefing: true }, { content: [{ type: "text", text: "Vandaag al gebriefd om 08:50." }] });
  await call({ briefing: true }, { content: [{ type: "text", text: "12 open pull requests." }] });
  await call({}, { content: [{ type: "text", text: "Vandaag al gebriefd om 08:50." }] });
  assert.equal(gated, 1);
});
