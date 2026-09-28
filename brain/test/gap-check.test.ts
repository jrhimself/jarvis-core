/**
 * The check on a turn that gave up: when it sends the turn back, and when it
 * lets it end. The model call is replaced; what is tested is the decision.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { dropNudge, gapHook, NUDGE, readCheck, type Check, type OpenJob } from "../dist/gap-check.js";

type Hook = (input: unknown, id: string | undefined, options: { signal: AbortSignal }) => Promise<unknown>;

function run(
  turn: { question: string; tools: string[]; jobs?: OpenJob[] } | null,
  input: Record<string, unknown>,
  verdict: boolean | Check,
): Promise<unknown> {
  const found: Check = typeof verdict === "boolean" ? { gaveUp: verdict, drop: [] } : verdict;
  const matcher = gapHook(() => turn, async () => found);
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
  assert.equal(readCheck("GAVE_UP").gaveUp, true);
  assert.equal(readCheck(" gave_up.").gaveUp, true);
  for (const text of ["FINE", "", "maybe GAVE_UP", "I think it gave up"]) {
    assert.equal(readCheck(text).gaveUp, false, text);
  }
});

const JOBS: OpenJob[] = [
  { id: 15, job: "Read messages from a marketplace -- because: a reply about a desk" },
  { id: 16, job: "Search the full mail history" },
];

test("DROP lines name jobs, and only jobs that were shown", () => {
  assert.deepEqual(readCheck("FINE\nDROP 15", JOBS), { gaveUp: false, drop: [15] });
  assert.deepEqual(readCheck("GAVE_UP\ndrop #16\nDROP 15\nDROP 15", JOBS), { gaveUp: true, drop: [16, 15] });
  // A number the model made up, or a DROP buried in a sentence, drops nothing.
  assert.deepEqual(readCheck("FINE\nDROP 99\nI would DROP 15", JOBS).drop, []);
  assert.deepEqual(readCheck("FINE\nDROP 15").drop, []);
});

test("a correction that makes an open job pointless sends the turn back to drop it", async () => {
  const out = await run(
    { question: "no, it is not a marketplace, it is an e-mail thread", tools: [], jobs: JOBS },
    { last_assistant_message: "Understood, an e-mail thread." },
    { gaveUp: false, drop: [15] },
  );
  assert.deepEqual(out, { decision: "block", reason: dropNudge([JOBS[0]!]) });
});

test("a turn that both gave up and made a job pointless is told both, once", async () => {
  const out = (await run(
    { question: "q", tools: [], jobs: JOBS },
    GAVE_UP,
    { gaveUp: true, drop: [15] },
  )) as { decision: string; reason: string };
  assert.equal(out.decision, "block");
  assert.ok(out.reason.includes("abandon_dev_task"));
  assert.ok(out.reason.includes(NUDGE));
});

test("a turn that closed a gap is still checked for jobs to drop, but not nudged to close another", async () => {
  const tools = ["mcp__selfdev__close_gap"];
  assert.deepEqual(await run({ question: "q", tools, jobs: JOBS }, GAVE_UP, { gaveUp: true, drop: [] }), {});
  const out = (await run({ question: "q", tools, jobs: JOBS }, GAVE_UP, { gaveUp: true, drop: [15] })) as {
    reason: string;
  };
  assert.equal(out.reason, dropNudge([JOBS[0]!]));
});

test("a turn that already dropped a job is not asked to drop again", async () => {
  const tools = ["mcp__selfdev__abandon_dev_task"];
  assert.deepEqual(await run({ question: "q", tools, jobs: JOBS }, GAVE_UP, { gaveUp: false, drop: [15] }), {});
});

test("the turn is told it is settling before anything is checked", async () => {
  let settled = 0;
  const matcher = gapHook(() => null, async () => ({ gaveUp: false, drop: [] }), () => {
    settled += 1;
  });
  const hook = matcher.hooks[0] as unknown as Hook;
  await hook({ stop_hook_active: true }, undefined, { signal: new AbortController().signal });
  assert.equal(settled, 1);
});
