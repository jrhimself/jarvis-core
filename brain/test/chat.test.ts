/**
 * A conversation over a chat, and the three ways it goes wrong.
 *
 * The agent is not exercised here -- that needs a model and a house. What is
 * held still is everything around it: who gets answered, what happens to a
 * question asked while the last one is still running, and how an answer too
 * long for one message is broken up.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Chat, pieces } from "../dist/chat.js";
import type { ChatSender } from "../dist/chat.js";

function recorder(): ChatSender & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: async (_chatId, html) => {
      sent.push(html);
      return 1;
    },
    typing: async () => {},
  };
}

test("a stranger is not answered", async () => {
  const bot = recorder();
  const chat = new Chat(bot, "42");

  await chat.said({ chatId: "999", text: "wie ben jij", messageId: 1 });

  assert.equal(bot.sent.length, 0, "a bot token is a URL anybody who has it can write to");
});

test("an empty message is not a question", async () => {
  const bot = recorder();
  const chat = new Chat(bot, "42");

  await chat.said({ chatId: "42", text: "   ", messageId: 1 });

  assert.equal(bot.sent.length, 0);
});

test("a long answer is broken on its line breaks", () => {
  const paragraph = `${"a".repeat(300)}\n`;
  const text = paragraph.repeat(10);

  const out = pieces(text, 1000);

  assert.ok(out.length > 1, "it was split");
  assert.ok(
    out.every((piece) => piece.length <= 1000),
    "and every piece fits",
  );
  // Line breaks are where it cuts, so they are the one thing that may move.
  assert.equal(
    out.join("").replace(/\n/g, ""),
    text.replace(/\n/g, ""),
    "and nothing was lost",
  );
});

test("a line with nowhere to break is cut anyway", () => {
  const out = pieces("b".repeat(2500), 1000);

  assert.equal(out.length, 3);
  assert.ok(out.every((piece) => piece.length <= 1000));
  assert.equal(out.join(""), "b".repeat(2500));
});

test("a short answer is one message", () => {
  assert.deepEqual(pieces("kort", 1000), ["kort"]);
});
