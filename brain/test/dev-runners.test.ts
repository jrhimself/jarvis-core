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
  pressed,
  questionMessage,
  readVerdict,
  settled,
} from "../dist/dev/runners.js";
import { readReport } from "../dist/dev/report-endpoint.js";
import type { Press } from "../dist/telegram.js";

test("a finished runner is recognised, with what it left behind", () => {
  const verdict = readVerdict("KLAAR: de branch staat klaar met groene tests");
  assert.equal(verdict.state, "done");
  assert.equal(
    verdict.state === "done" ? verdict.summary : "",
    "de branch staat klaar met groene tests",
  );
});

test("a question is recognised and carries what is being asked", () => {
  const verdict = readVerdict("VRAAG: moet de knop links of rechts staan?");
  assert.equal(verdict.state, "asking");
  assert.equal(
    verdict.state === "asking" ? verdict.question : "",
    "moet de knop links of rechts staan?",
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
  assert.match(settled("<b>Runner 4</b>", true), /Slot gesloten/);
  assert.match(settled("<b>Runner 4</b>", false), /Blijft open/);
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
  assert.deepEqual(acknowledged, ["Slot gesloten."]);
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
  assert.match(settledWith[0] ?? "", /Blijft open/);
});

test("a slot that refuses to close says so rather than pretending", async () => {
  const { bot, acknowledged, settledWith } = recorder();

  await handleRunnerPress(
    bot,
    async () => ({ ok: false, error: "slot 4 is not running" }),
    press("runner:close:4"),
  );

  assert.deepEqual(acknowledged, ["Dat lukte niet."]);
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
  assert.match(sent[0]?.html ?? "", /Slot gesloten/);
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
  assert.match(sent[0]?.html ?? "", /wacht op jou/);
});
