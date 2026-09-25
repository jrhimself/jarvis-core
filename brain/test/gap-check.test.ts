/**
 * The check on a turn that gave up: when it sends the turn back, and when it
 * lets it end. The model call is replaced; what is tested is the decision.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { gapHook, NUDGE, readCheck } from "../dist/gap-check.js";

type Hook = (input: unknown, id: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>;

function run(
  turn: { question: string; tools: string[] } | null,
  input: Record<string, unknown>,
  verdict: boolean,
): Promise<unknown> {
  const matcher = gapHook(() => turn, async () => verdict);
  const hook = matcher.hooks[0] as unknown as Hook;
  return hook(input, undefined, { signal: new AbortController().signal });
}

const GAVE_UP = { last_assistant_message: "Nothing I have reaches that, so I cannot check it." };

test("an answer that gave up is sent back to close the gap", async () => {
  const out = await run({ question: "what are the road works about?", tools: [] }, GAVE_UP, true);
  assert.deepEqual(out, { decision: "block", reason: NUDGE });
});

test("a turn that already closed a gap, or proposed the work, is let go", async () => {
  for (const tool of ["mcp__selfdev__close_gap", "mcp__selfdev__propose_dev_task"]) {
    const out = await run({ question: "q", tools: ["mcp__ha__state", tool] }, GAVE_UP, true);
    assert.deepEqual(out, {}, tool);
  }
});

test("the second stop of a turn is always let go, so the check cannot loop", async () => {
  const out = await run({ question: "q", tools: [] }, { ...GAVE_UP, stop_hook_active: true }, true);
  assert.deepEqual(out, {});
});

test("an answer the check finds fine ends the turn", async () => {
  assert.deepEqual(await run({ question: "q", tools: [] }, GAVE_UP, false), {});
  assert.deepEqual(await run({ question: "q", tools: [] }, { last_assistant_message: "" }, true), {});
  assert.deepEqual(await run(null, GAVE_UP, true), {});
});

test("only a clear GAVE_UP counts", () => {
  assert.equal(readCheck("GAVE_UP"), true);
  assert.equal(readCheck(" gave_up."), true);
  for (const text of ["FINE", "", "maybe GAVE_UP", "I think it gave up"]) {
    assert.equal(readCheck(text), false, text);
  }
});

test("the turn is told it is settling before anything is checked", async () => {
  let settled = 0;
  const matcher = gapHook(() => null, async () => false, () => {
    settled += 1;
  });
  const hook = matcher.hooks[0] as unknown as Hook;
  await hook({ stop_hook_active: true }, undefined, { signal: new AbortController().signal });
  assert.equal(settled, 1);
});
