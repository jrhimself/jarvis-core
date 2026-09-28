/**
 * The runner board: what each slot shows, and how the health row follows it.
 * Built from plain rows, so nothing here needs a runner or a database.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { composeBoard, jobLine, topicOf, withBoard, type RunnerNote } from "../dist/dev/board.js";
import { healthWithBoard } from "../dist/health.js";

type Task = Parameters<typeof composeBoard>[2][number];

function task(id: number, slot: number | null, extra: Partial<Task> = {}): Task {
  return {
    id,
    createdAt: "2026-09-28T08:10:00.000Z",
    updatedAt: "2026-09-28T08:10:00.000Z",
    instruction: "Give JARVIS the ability to search the full mail history, so that he does it himself from now on.",
    size: "big",
    state: "delegated",
    branch: null,
    worktree: null,
    prUrl: null,
    prNumber: null,
    slot,
    detail: "",
    log: null,
    gap: null,
    ...extra,
  };
}

test("a gap reads as its ability, a request as its first line", () => {
  assert.equal(topicOf({ gap: "search-the-full-mail-history", instruction: "x" }), "Search the full mail history");
  assert.equal(
    topicOf({
      gap: null,
      instruction: "Give JARVIS the ability to read the clock, so that he does it himself from now on.\nWhat made this come up: q",
    }),
    "Read the clock",
  );
  assert.equal(topicOf({ gap: null, instruction: "make the lights dim at night" }), "Make the lights dim at night");
  assert.ok(topicOf({ gap: null, instruction: "a".repeat(200) }).length <= 80);
});

test("the check is shown why a job came up, since that is what a correction contradicts", () => {
  const line = jobLine({
    gap: "read-messages-from-a-marketplace",
    instruction: "Give JARVIS the ability to ...\nWhat made this come up: a reply about a desk\nBuild it.",
  });
  assert.equal(line, "Read messages from a marketplace -- because: a reply about a desk");
  assert.equal(jobLine({ gap: "read-the-clock", instruction: "no reason given" }), "Read the clock");
});

test("every slot gets a row: its job, whether it is busy, and its last judged screen", () => {
  const notes = new Map<number, RunnerNote>([
    [12, { state: "asking", text: "Which label?", at: Date.parse("2026-09-28T08:20:00Z") }],
  ]);
  const board = composeBoard(
    [11, 12, 13],
    [11, 13],
    [task(16, 12, { gap: "search-the-full-mail-history" })],
    notes,
  );
  assert.equal(board.reachable, true);
  assert.deepEqual(board.runners[0], { slot: 11, busy: false });
  assert.deepEqual(board.runners[1], {
    slot: 12,
    busy: true,
    job: { id: 16, topic: "Search the full mail history", since: "2026-09-28T08:10:00.000Z", learning: true },
    note: { state: "asking", text: "Which label?", at: "2026-09-28T08:20:00.000Z" },
  });
  assert.deepEqual(board.runners[2], { slot: 13, busy: false });
});

test("a reused slot shows its newest job, and a note never outlives the job it was about", () => {
  const notes = new Map<number, RunnerNote>([[11, { state: "working", at: 0 }]]);
  const board = composeBoard([11], [], [task(3, 11), task(9, 11)], notes);
  assert.equal(board.runners[0]?.job?.id, 9);
  const empty = composeBoard([11], [11], [], notes);
  assert.equal(empty.runners[0]?.note, undefined);
});

test("an unreachable delegate says so instead of calling every slot idle", () => {
  const board = composeBoard([11, 12], null, [task(1, 11)], new Map());
  assert.equal(board.reachable, false);
  assert.equal(board.runners[0]?.busy, null);
  assert.equal(board.runners[0]?.job?.id, 1);
});

test("the delegate's health row takes its count from a newer board, and nothing else", () => {
  const board = composeBoard([11, 12, 13], [13], [], new Map());
  assert.equal(withBoard("3 of 3 slots free on somewhere", board), "1 of 3 slots free on somewhere");
  const checks = healthWithBoard(
    [
      { server: "delegate", state: "ok", detail: "3 of 3 slots free on somewhere", ms: 80 },
      { server: "mail", state: "ok", detail: "3 of 3 slots free" },
    ],
    board,
  );
  assert.equal(checks[0]?.detail, "1 of 3 slots free on somewhere");
  assert.equal(checks[1]?.detail, "3 of 3 slots free");
  const down = healthWithBoard([{ server: "delegate", state: "down", detail: "unreachable" }], board);
  assert.equal(down[0]?.detail, "unreachable");
});
