/**
 * When the conversation moves to a stronger model, and when it moves back.
 *
 * The rule this defends is that raising is an exception. A session that quietly
 * stayed on the expensive model after one bad tool call would still answer
 * every question correctly, which is exactly why nobody would notice; the bill
 * is the only symptom, and it arrives a month later. So most of what follows
 * tests the way back down rather than the way up.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Escalation } from "../dist/escalate.js";

const DEV = "mcp__jarvis-dev__";

function fresh(raised = "opus") {
  return new Escalation({ base: "sonnet", raised, heavyPrefixes: [DEV] });
}

test("a turn that goes well never changes model", () => {
  const escalation = fresh();
  assert.equal(escalation.startTurn(), null);
  assert.equal(escalation.onTool("mcp__home__get_state"), null);
  escalation.endTurn();
  assert.equal(escalation.startTurn(), null);
});

test("a failed tool raises the rest of the turn, once", () => {
  const escalation = fresh();
  escalation.startTurn();

  const first = escalation.onToolError();
  assert.equal(first?.model, "opus");
  assert.equal(escalation.raised, true);
  // A second failure inside the same turn is the same turn, not a second raise.
  assert.equal(escalation.onToolError(), null);
});

test("building work raises the turn before anything has failed", () => {
  const escalation = fresh();
  escalation.startTurn();
  assert.equal(escalation.onTool("mcp__home__get_state"), null);
  assert.equal(escalation.onTool(`${DEV}propose_dev_task`)?.model, "opus");
});

test("the turn after a failure starts raised, and the one after that does not", () => {
  const escalation = fresh();
  escalation.startTurn();
  escalation.onToolError();
  escalation.endTurn();

  // "Why did that not work" is asked in the next turn, not in the broken one.
  assert.equal(escalation.startTurn()?.model, "opus");
  escalation.endTurn();

  // That turn went fine, so the session goes back to what it normally costs.
  assert.deepEqual(escalation.startTurn(), { model: "sonnet", why: "back to the usual model" });
  assert.equal(escalation.raised, false);
  escalation.endTurn();
  assert.equal(escalation.startTurn(), null);
});

test("a raised turn that goes well is not held against the next one", () => {
  const escalation = fresh();
  escalation.startTurn();
  escalation.onTool(`${DEV}start_dev_task`);
  escalation.endTurn();

  assert.deepEqual(escalation.startTurn(), { model: "sonnet", why: "back to the usual model" });
});

test("failures do not accumulate across turns", () => {
  const escalation = fresh();
  for (let i = 0; i < 3; i += 1) {
    escalation.startTurn();
    escalation.onToolError();
    escalation.endTurn();
  }
  // Still one turn of memory, not three.
  assert.equal(escalation.startTurn()?.why, "the previous turn ran into an error");
  escalation.endTurn();
  assert.equal(escalation.startTurn()?.model, "sonnet");
});

test("no escalation model configured means nothing ever changes", () => {
  const escalation = fresh("");
  assert.equal(escalation.enabled, false);
  escalation.startTurn();
  assert.equal(escalation.onToolError(), null);
  assert.equal(escalation.onTool(`${DEV}propose_dev_task`), null);
  escalation.endTurn();
  assert.equal(escalation.startTurn(), null);
});

test("escalating to the model already in use is the same as not escalating", () => {
  const escalation = fresh("sonnet");
  assert.equal(escalation.enabled, false);
  escalation.startTurn();
  assert.equal(escalation.onToolError(), null);
});
