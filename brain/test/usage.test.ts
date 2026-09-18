/**
 * Reading what a call cost out of the SDK's result message.
 *
 * The shape of that message is not ours, so everything here is defensive: the
 * question each test asks is what happens when a field moves or goes missing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { recordUsage, usageFromResult } from "../dist/memory/usage.js";
import { quietly, tempStore } from "./helpers.ts";

const RESULT = {
  type: "result",
  duration_ms: 2400.6,
  total_cost_usd: 0.0123,
  usage: {
    input_tokens: 120,
    output_tokens: 80,
    cache_read_input_tokens: 9000,
    cache_creation_input_tokens: 300,
  },
  modelUsage: {
    "claude-haiku-4-5": { inputTokens: 10, outputTokens: 5 },
    "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 80, cacheReadInputTokens: 9000 },
  },
};

test("a result message becomes a record", () => {
  const record = usageFromResult(RESULT, { kind: "turn", sessionId: "s1", firstTextMs: 981, toolCalls: 2 });

  assert.notEqual(record, null);
  assert.equal(record!.kind, "turn");
  assert.equal(record!.sessionId, "s1");
  assert.equal(record!.inputTokens, 120);
  assert.equal(record!.cacheRead, 9000);
  assert.equal(record!.cacheWrite, 300);
  assert.equal(record!.costUsd, 0.0123);
  assert.equal(record!.durationMs, 2401, "milliseconds are rounded, not truncated");
  assert.equal(record!.firstTextMs, 981);
  assert.equal(record!.toolCalls, 2);
});

test("the model that did the work wins, not the first one listed", () => {
  const record = usageFromResult(RESULT, { kind: "turn" });

  assert.equal(record!.model, "claude-sonnet-4-6");
});

test("anything that is not a result yields nothing", () => {
  assert.equal(usageFromResult({ type: "assistant" }, { kind: "turn" }), null);
  assert.equal(usageFromResult(null, { kind: "turn" }), null);
  assert.equal(usageFromResult("result", { kind: "turn" }), null);
  assert.equal(usageFromResult(undefined, { kind: "turn" }), null);
});

test("missing or nonsensical numbers read as zero rather than NaN", () => {
  const record = usageFromResult(
    { type: "result", usage: { input_tokens: "veel" }, total_cost_usd: null },
    { kind: "distil" },
  );

  assert.equal(record!.inputTokens, 0);
  assert.equal(record!.outputTokens, 0);
  assert.equal(record!.costUsd, 0);
  assert.equal(record!.durationMs, null);
  assert.equal(record!.model, null);
  assert.equal(record!.toolCalls, 0);
});

test("recording a metric never breaks the pass that produced it", () => {
  const store = tempStore();
  try {
    quietly(() => {
      recordUsage(store, { type: "assistant" }, "distil");
      recordUsage(store, RESULT, "distil");
      recordUsage(store, { type: "result", usage: null }, "consolidate");
    });

    const recent = store.usageRecent();
    assert.equal(recent.length, 2, "the non-result message is skipped, the rest is kept");
    assert.equal(recent[0]!.kind, "consolidate");
    assert.equal(recent[1]!.kind, "distil");
  } finally {
    store.close();
  }
});
