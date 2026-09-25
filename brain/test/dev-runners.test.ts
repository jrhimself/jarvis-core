/**
 * What a quiet runner is taken to mean, and what may be done about it.
 *
 * The two properties worth defending are both about restraint. A screen that
 * does not clearly say it is finished must never be read as finished -- the
 * slot on the other side holds work in progress, and closing it throws that
 * away. And a press must only ever close the slot its button named, however
 * stale or malformed the data coming back from Telegram is.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  actOn,
  buttonsFor,
  declaredDone,
  doneMessage,
  handleRunnerPress,
  handleRunnerReply,
  lookIn,
  onQuestion,
  OWN_ANSWERS_PER_JOB,
  pressed,
  questionMessage,
  QUIET_MS,
  readConsideration,
  readVerdict,
  settled,
} from "../dist/dev/runners.js";
import { readReport } from "../dist/dev/report-endpoint.js";
import type { Press } from "../dist/telegram.js";

test("a finished runner is recognised, with what it left behind", () => {
  const verdict = readVerdict("DONE: the branch is ready with green tests");
  assert.equal(verdict.state, "done");
  assert.equal(
    verdict.state === "done" ? verdict.summary : "",
    "the branch is ready with green tests",
  );
});

test("a question is recognised and carries what is being asked", () => {
  const verdict = readVerdict("QUESTION: should the button go left or right?");
  assert.equal(verdict.state, "asking");
  assert.equal(
    verdict.state === "asking" ? verdict.question : "",
    "should the button go left or right?",
  );
});

test("anything unrecognised leaves the runner alone", () => {
  for (const answer of ["BEZIG", "", "hij is denk ik wel klaar", "KLAAR", "VRAAG:"]) {
    assert.equal(readVerdict(answer).state, "working", `should not act on: ${answer}`);
  }
});

test("the verdict is read from the first line, not from a stray word later", () => {
  assert.equal(readVerdict("BEZIG\nKLAAR: toch niet").state, "working");
});

test("a press names the slot it belongs to", () => {
  assert.deepEqual(pressed("runner:close:4"), { action: "close", slot: 4 });
  assert.deepEqual(pressed("runner:keep:5"), { action: "keep", slot: 5 });
});

test("a press from another feature or an older version is not ours", () => {
  for (const data of ["suggest:right:12", "runner:close:", "runner:sluit:4", "runner", ""]) {
    assert.equal(pressed(data), null, `should not be claimed: ${data}`);
  }
});

test("the buttons offer closing and leaving open, in that order", () => {
  const [close, keep] = buttonsFor(4);
  assert.equal(close?.data, "runner:close:4");
  assert.equal(keep?.data, "runner:keep:4");
});

test("what a runner reports is escaped before it becomes a message", () => {
  const report = { slot: 4, task: "gevraagd: fix <b>x</b>", tail: "" };
  assert.match(doneMessage(report, "klaar met <script>"), /&lt;script&gt;/);
  assert.match(questionMessage(report, "welke <kleur>?"), /&lt;kleur&gt;/);
});

test("a message says afterwards what the press did", () => {
  assert.match(settled("<b>Runner 4</b>", true), /Slot closed/);
  assert.match(settled("<b>Runner 4</b>", false), /Kept open/);
  assert.match(settled("<b>Runner 4</b>", false, "ssh gaf niets terug"), /ssh gaf niets terug/);
});

/** A bot that writes down what it was asked to do instead of doing it. */
function recorder(): {
  bot: {
    send: (chatId: string, html: string) => Promise<number | null>;
    acknowledge: (queryId: string, text: string) => Promise<void>;
    settle: (chatId: string, messageId: number, html: string) => Promise<void>;
  };
  acknowledged: string[];
  settledWith: string[];
} {
  const acknowledged: string[] = [];
  const settledWith: string[] = [];
  return {
    bot: {
      send: async () => 1,
      acknowledge: async (_queryId: string, text: string) => {
        acknowledged.push(text);
      },
      settle: async (_chatId: string, _messageId: number, html: string) => {
        settledWith.push(html);
      },
    },
    acknowledged,
    settledWith,
  };
}

const press = (data: string): Press => ({
  queryId: "q",
  data,
  messageId: 7,
  chatId: "chat",
});

test("pressing close asks the delegate to close that slot", async () => {
  const { bot, acknowledged } = recorder();
  const closedSlots: number[] = [];

  const handled = await handleRunnerPress(
    bot,
    async (slot) => {
      closedSlots.push(slot);
      return { ok: true };
    },
    press("runner:close:5"),
  );

  assert.equal(handled, true);
  assert.deepEqual(closedSlots, [5]);
  assert.deepEqual(acknowledged, ["Slot closed."]);
});

test("pressing leave open closes nothing", async () => {
  const { bot, settledWith } = recorder();
  let asked = false;

  await handleRunnerPress(
    bot,
    async () => {
      asked = true;
      return { ok: true };
    },
    press("runner:keep:4"),
  );

  assert.equal(asked, false);
  assert.match(settledWith[0] ?? "", /Kept open/);
});

test("a slot that refuses to close says so rather than pretending", async () => {
  const { bot, acknowledged, settledWith } = recorder();

  await handleRunnerPress(
    bot,
    async () => ({ ok: false, error: "slot 4 is not running" }),
    press("runner:close:4"),
  );

  assert.deepEqual(acknowledged, ["That did not work."]);
  assert.match(settledWith[0] ?? "", /slot 4 is not running/);
});

test("a press that is not ours is left for whoever it belongs to", async () => {
  const { bot } = recorder();
  const handled = await handleRunnerPress(
    bot,
    async () => ({ ok: true }),
    press("suggest:right:3"),
  );
  assert.equal(handled, false);
});

test("a report needs a slot, a brief and something on the screen", () => {
  assert.deepEqual(readReport({ slot: 4, task: "t", tail: "output" }), {
    slot: 4,
    task: "t",
    tail: "output",
  });

  for (const payload of [
    null,
    "nope",
    { slot: "4", task: "t", tail: "output" },
    { slot: 4.5, task: "t", tail: "output" },
    { slot: 4, task: "t", tail: "   " },
    { slot: 4, tail: "output" },
  ]) {
    assert.equal(readReport(payload), null, `should be refused: ${JSON.stringify(payload)}`);
  }
});

test("only the runner's own KLAAR line counts as declaring the job done", () => {
  assert.equal(declaredDone("werk werk\n● KLAAR: PR #14 staat open, suite groen\n❯ "), true);
  assert.equal(declaredDone("KLAAR: klaar\nnog even\n● VRAAG: welke naam wil je?"), false);
  assert.equal(declaredDone("● VRAAG: welke naam?\n● KLAAR: naam gekozen, PR open"), true);
  // The brief quotes both words with a placeholder; it is not the runner speaking.
  assert.equal(
    declaredDone("Sluit elke beurt af met één regel: 'KLAAR: <wat er ligt>' als je klaar bent,"),
    false,
  );
  assert.equal(declaredDone("● KLAAR: <wat er ligt>"), false);
  assert.equal(declaredDone("alles gedaan, denk ik"), false);
});

const REPORT = { slot: 11, task: "Bouw iets", tail: "● KLAAR: PR #14 staat open" };

function sender() {
  const sent: { html: string; buttons: boolean }[] = [];
  return {
    sent,
    bot: {
      send: async (_chat: string, html: string, buttons?: unknown[]) => {
        sent.push({ html, buttons: buttons !== undefined && buttons.length > 0 });
        return 1;
      },
      acknowledge: async () => {},
      settle: async () => {},
    } as never,
  };
}

test("a job the runner declared done closes its slot without asking", async () => {
  const { bot, sent } = sender();
  const closed: number[] = [];
  await actOn(bot, "chat", REPORT, { state: "done", summary: "PR staat open" }, async (slot) => {
    closed.push(slot);
    return { ok: true };
  });
  assert.deepEqual(closed, [11]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.buttons, false);
  assert.match(sent[0]?.html ?? "", /Slot closed/);
});

test("an ending the runner did not declare still waits for a press", async () => {
  const { bot, sent } = sender();
  let asked = false;
  await actOn(
    bot,
    "chat",
    { ...REPORT, tail: "ik kom hier niet verder" },
    { state: "done", summary: "gestrand" },
    async () => {
      asked = true;
      return { ok: true };
    },
  );
  assert.equal(asked, false);
  assert.equal(sent[0]?.buttons, true);
});

test("a slot that will not close falls back to the buttons", async () => {
  const { bot, sent } = sender();
  await actOn(bot, "chat", REPORT, { state: "done", summary: "klaar" }, async () => ({
    ok: false,
    error: "slot 11 is not running",
  }));
  assert.equal(sent[0]?.buttons, true);
});

test("a question never closes anything", async () => {
  const { bot, sent } = sender();
  let asked = false;
  await actOn(
    bot,
    "chat",
    { ...REPORT, tail: "● VRAAG: welke kleur?" },
    { state: "asking", question: "welke kleur?" },
    async () => {
      asked = true;
      return { ok: true };
    },
  );
  assert.equal(asked, false);
  assert.match(sent[0]?.html ?? "", /waiting for you/);
});

test("the older Dutch words still end a turn, for runners started on an older brief", () => {
  assert.equal(readVerdict("KLAAR: PR is open").state, "done");
  assert.equal(readVerdict("VRAAG: which name?").state, "asking");
  assert.equal(declaredDone("● DONE: PR open\n❯ "), true);
  assert.equal(declaredDone("● DONE: PR open\n● QUESTION: merge it?"), false);
});

test("JARVIS' answer is read with everything after the word, lines and all", () => {
  assert.deepEqual(readConsideration("ANSWER: use the second one.\nKeep the test.", "q"), {
    answer: "use the second one.\nKeep the test.",
  });
  assert.deepEqual(readConsideration("Thinking...\nASK: which colour do you want?", "q"), {
    ask: "which colour do you want?",
  });
});

test("anything that is not a clear answer goes to the owner with the runner's question", () => {
  for (const text of ["", "I think maybe the left one", "ANSWER:", "ASK:"]) {
    assert.deepEqual(readConsideration(text, "left or right?"), { ask: "left or right?" }, text);
  }
});

/** A bot that remembers what it sent, and numbers its messages. */
function messages() {
  const sent: string[] = [];
  return {
    sent,
    bot: {
      send: async (_chat: string, html: string) => {
        sent.push(html);
        return 100 + sent.length;
      },
      acknowledge: async () => {},
      settle: async () => {},
    } as never,
  };
}

test("a question JARVIS can answer is typed into the runner, and the owner is told", async () => {
  const { bot, sent } = messages();
  const typed: string[] = [];
  await onQuestion(bot, "chat", { ...REPORT, slot: 21 }, "tabs or spaces?", {
    consider: async () => ({ answer: "Spaces, like the rest of the file." }),
    reply: async (_slot, text) => {
      typed.push(text);
      return { ok: true };
    },
  });
  assert.deepEqual(typed, ["Spaces, like the rest of the file."]);
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /asked, and I answered/);
});

test("a question that is the owner's goes to him, and his reply goes to the runner", async () => {
  const { bot, sent } = messages();
  const typed: Array<[number, string]> = [];
  const reply = async (slot: number, text: string) => {
    typed.push([slot, text]);
    return { ok: true as const };
  };
  await onQuestion(bot, "chat", { ...REPORT, slot: 22 }, "delete the old branch?", {
    consider: async () => ({ ask: "May the runner delete the old branch?" }),
    reply,
  });
  assert.equal(typed.length, 0);
  assert.match(sent[0] ?? "", /May the runner delete the old branch\?/);
  assert.match(sent[0] ?? "", /Reply to this message/);

  // Message 101 was the question; a reply to it reaches runner 22.
  assert.equal(await handleRunnerReply(bot, reply, { chatId: "chat", text: "yes", replyTo: 101 }), true);
  assert.deepEqual(typed, [[22, "yes"]]);
  assert.match(sent[1] ?? "", /Passed on to runner 22/);

  // A reply to anything else is ordinary chat.
  assert.equal(await handleRunnerReply(bot, reply, { chatId: "chat", text: "hi", replyTo: 5 }), false);
  assert.equal(await handleRunnerReply(bot, reply, { chatId: "chat", text: "hi" }), false);
});

test("the same question twice is not answered by JARVIS a second time", async () => {
  const { bot, sent } = messages();
  let considered = 0;
  const seam = {
    consider: async () => {
      considered += 1;
      return { answer: "Run the tests." };
    },
    reply: async () => ({ ok: true as const }),
  };
  await onQuestion(bot, "chat", { ...REPORT, slot: 23 }, "What next?", seam);
  await onQuestion(bot, "chat", { ...REPORT, slot: 23 }, "what  next?", seam);
  assert.equal(considered, 1);
  assert.match(sent[1] ?? "", /did not settle it/);
});

test("after a handful of answers, the next question is the owner's", async () => {
  const { bot, sent } = messages();
  const seam = {
    consider: async () => ({ answer: "Go on." }),
    reply: async () => ({ ok: true as const }),
  };
  for (let i = 0; i < OWN_ANSWERS_PER_JOB; i += 1) {
    await onQuestion(bot, "chat", { ...REPORT, slot: 24 }, `question ${i}`, seam);
  }
  await onQuestion(bot, "chat", { ...REPORT, slot: 24 }, "one more", seam);
  assert.match(sent.at(-1) ?? "", /this one is yours/);
});

test("without a way to reach back, every question goes to the owner as before", async () => {
  const { bot, sent } = messages();
  await onQuestion(bot, "chat", { ...REPORT, slot: 25 }, "left or right?");
  assert.match(sent[0] ?? "", /is waiting for you/);
  assert.doesNotMatch(sent[0] ?? "", /Reply to this message/);
});

test("a job the runner declared done is marked finished", async () => {
  const { bot } = messages();
  const finished: Array<[number, string]> = [];
  await actOn(
    bot,
    "chat",
    REPORT,
    { state: "done", summary: "PR open" },
    async () => ({ ok: true }),
    { finished: (slot, summary) => finished.push([slot, summary]) },
  );
  assert.deepEqual(finished, [[REPORT.slot, "PR open"]]);
});

test("a quiet runner is looked in on, and an unchanged screen is judged once", async () => {
  const reports: number[] = [];
  const job = { slot: 31, task: "build it", since: 0 };
  const tail = async () => ({ ok: true as const, text: "same screen" });
  const report = async (r: { slot: number }) => reports.push(r.slot);
  const gone = async () => assert.fail("not gone");

  await lookIn([job], [31], tail, report, gone, QUIET_MS - 1);
  assert.deepEqual(reports, [], "too soon to look");
  await lookIn([job], [31], tail, report, gone, QUIET_MS);
  await lookIn([job], [31], tail, report, gone, 3 * QUIET_MS);
  assert.deepEqual(reports, [31]);
});

test("a runner that is not running any more, or not a slot any more, is gone", async () => {
  const gone: number[] = [];
  const onGone = async (job: { slot: number }) => {
    gone.push(job.slot);
  };
  const dead = async () => ({ ok: false as const, error: "jarvis-delegate: slot 32 is not running" });
  await lookIn([{ slot: 32, task: "x", since: 0 }], [32], dead, async () => {}, onGone, QUIET_MS);
  await lookIn([{ slot: 4, task: "x", since: 0 }], [11, 12, 13], dead, async () => {}, onGone, QUIET_MS);
  assert.deepEqual(gone, [32, 4]);
});
