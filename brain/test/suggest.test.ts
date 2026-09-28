/**
 * What gets asked, what gets held back, and what an answer does.
 *
 * The restraints are the subject here. Offering a finding is one line; not
 * offering the same finding twice, not offering anything at midnight, and not
 * offering more in a day than anybody will read are the reasons this file
 * exists -- each of them is the difference between a channel somebody reads and
 * one they mute.
 */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { handlePress, isQuiet, offer, render } from "../dist/proactive/suggest.js";
import type { Sender } from "../dist/proactive/suggest.js";
import type { OpenAnomaly } from "../dist/proactive/detect.js";
import type { Config } from "../dist/config.js";
import { proactiveDb } from "./helpers.ts";

process.env["JARVIS_TIMEZONE"] = "Europe/Amsterdam";
process.env["JARVIS_LOCALE"] = "nl-NL";

/** A Tuesday, 20:00 Amsterdam: inside nobody's quiet hours. */
const NOW = new Date("2026-08-11T18:00:00.000Z");

interface Sent {
  chatId: string;
  html: string;
  buttons: Array<{ text: string; data: string }>;
}

/** A bot that keeps what it was handed instead of sending it. */
function recorder(nextId = 100): Sender & { sent: Sent[]; acks: string[]; settled: string[] } {
  const sent: Sent[] = [];
  const acks: string[] = [];
  const settled: string[] = [];
  let id = nextId;
  return {
    sent,
    acks,
    settled,
    send: async (chatId, html, buttons = []) => {
      sent.push({ chatId, html, buttons });
      id += 1;
      return id;
    },
    acknowledge: async (_queryId, text) => {
      acks.push(text);
    },
    settle: async (_chatId, _messageId, html) => {
      settled.push(html);
    },
  };
}

/** A bot that cannot reach Telegram at all. */
function unreachable(): Sender {
  return {
    send: async () => null,
    acknowledge: async () => {},
    settle: async () => {},
  };
}

function settings(overrides: Partial<Config> = {}): Config {
  return {
    suggestChat: "42",
    suggestPerDay: 6,
    quietFrom: 21,
    quietTo: 7,
    houseOpsWebhookUrl: "",
    houseOpsWebhookKey: "",
    ...overrides,
  } as Config;
}

/** One condition standing long enough to be worth mentioning. */
function standing(
  db: DatabaseSync,
  input: { subject?: string; rule?: string; buckets?: number; detail?: string } = {},
): number {
  const result = db
    .prepare(
      `INSERT INTO anomalies (fingerprint, subject, rule, watch_group, area, first_at, last_at,
                              buckets, observed, expected, deviation, detail)
       VALUES (?, ?, ?, 'motion', 'Overloop', ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      `${input.rule ?? "stuck"}:${input.subject ?? "binary_sensor.overloop"}`,
      input.subject ?? "binary_sensor.overloop",
      input.rule ?? "stuck",
      NOW.toISOString(),
      NOW.toISOString(),
      input.buckets ?? 6,
      input.detail ?? "binary_sensor.overloop has not changed in 24 hours",
    );
  return Number(result.lastInsertRowid);
}

test("a condition that has held is put to somebody, with buttons", async () => {
  const db = proactiveDb();
  const id = standing(db);
  const bot = recorder();

  const report = await offer(db, bot, settings(), NOW);

  assert.equal(report.offered, 1);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0]!.chatId, "42");
  assert.match(bot.sent[0]!.html, /has not changed in 24 hours/);
  assert.equal(bot.sent[0]!.buttons.length, 3);

  const row = db.prepare("SELECT anomaly_id, status, message_id FROM suggestions").get() as unknown as
    | { anomaly_id: number; status: string; message_id: number }
    | undefined;
  assert.equal(row?.anomaly_id, id);
  assert.equal(row?.status, "delivered");
  assert.equal(typeof row?.message_id, "number");
});

test("the same condition is not put twice", async () => {
  const db = proactiveDb();
  standing(db);
  const bot = recorder();

  await offer(db, bot, settings(), NOW);
  const second = await offer(db, bot, settings(), NOW);

  assert.equal(second.offered, 0);
  assert.equal(bot.sent.length, 1);
});

test("a condition that has not held yet waits", async () => {
  const db = proactiveDb();
  // A deviation needs two hours behind it before it counts as standing: one
  // strange reading is a reading, two in a row is a condition.
  standing(db, { rule: "deviation", buckets: 1 });
  const bot = recorder();

  const report = await offer(db, bot, settings(), NOW);

  assert.equal(report.offered, 0);
  assert.equal(report.held, 0, "not ripe is not the same as held back");
  assert.equal(bot.sent.length, 0);
});

test("nothing is sent inside the quiet hours", async () => {
  const db = proactiveDb();
  standing(db);
  const bot = recorder();

  // 23:30 Amsterdam, well inside 21:00 to 07:00.
  const report = await offer(db, bot, settings(), new Date("2026-08-11T21:30:00.000Z"));

  assert.equal(report.offered, 0);
  assert.equal(report.held, 1);
  assert.equal(bot.sent.length, 0, "and nothing is written down as sent either");
  assert.equal(db.prepare("SELECT count(*) AS n FROM suggestions").get()!["n"], 0);
});

test("the daily count is a ceiling, not a target", async () => {
  const db = proactiveDb();
  for (let i = 0; i < 5; i += 1) {
    standing(db, { subject: `binary_sensor.room_${i}` });
  }
  const bot = recorder();

  const report = await offer(db, bot, settings({ suggestPerDay: 2 }), NOW);

  assert.equal(report.offered, 2);
  assert.equal(report.held, 3);
  assert.equal(bot.sent.length, 2);
});

test("a message that never arrived is not recorded as sent", async () => {
  const db = proactiveDb();
  standing(db);

  const report = await offer(db, unreachable(), settings(), NOW);

  assert.equal(report.offered, 0);
  const row = db.prepare("SELECT status FROM suggestions").get() as unknown as { status: string };
  assert.equal(row.status, "undelivered");
});

test("a message that never arrived is asked again", async () => {
  const db = proactiveDb();
  standing(db);

  await offer(db, unreachable(), settings(), NOW);
  const bot = recorder();
  const second = await offer(db, bot, settings(), new Date(NOW.getTime() + 600_000));

  assert.equal(second.offered, 1, "ten minutes of a bad connection is not a decision");
  assert.equal(bot.sent.length, 1);
});

test("a verdict is written down and the message says so", async () => {
  const db = proactiveDb();
  standing(db);
  const bot = recorder();
  await offer(db, bot, settings(), NOW);

  const id = Number(db.prepare("SELECT id FROM suggestions").get()!["id"]);
  await handlePress(
    db,
    bot,
    { queryId: "q1", data: `suggest:noise:${id}`, messageId: 101, chatId: "42" },
    NOW,
  );

  const row = db.prepare("SELECT verdict, status, verdict_at FROM suggestions").get() as unknown as {
    verdict: string;
    status: string;
    verdict_at: string;
  };
  assert.equal(row.verdict, "noise");
  assert.equal(row.status, "answered");
  assert.equal(row.verdict_at, NOW.toISOString());
  assert.equal(bot.acks.length, 1);
  // The tests run in this house's locale, so the message comes out Dutch.
  assert.match(bot.settled[0]!, /je zei: Ruis/);
});

test("a subject put away is left alone, condition and all", async () => {
  const db = proactiveDb();
  standing(db);
  const bot = recorder();
  await offer(db, bot, settings(), NOW);

  const id = Number(db.prepare("SELECT id FROM suggestions").get()!["id"]);
  await handlePress(
    db,
    bot,
    { queryId: "q1", data: `suggest:later:${id}`, messageId: 101, chatId: "42" },
    NOW,
  );

  // The condition closes and comes back an hour later, as a flapping sensor
  // does. A snooze that only knew about the old row would say it all again.
  db.exec("DELETE FROM suggestions WHERE 0 = 1");
  standing(db, { rule: "missing" });

  const later = new Date(NOW.getTime() + 600_000);
  const report = await offer(db, bot, settings(), later);

  assert.equal(report.offered, 0);
  assert.equal(report.held, 1);
});

test("a press for something that is no longer on file still answers", async () => {
  const db = proactiveDb();
  const bot = recorder();

  await handlePress(
    db,
    bot,
    { queryId: "q1", data: "suggest:right:9999", messageId: 1, chatId: "42" },
    NOW,
  );

  assert.equal(bot.acks.length, 1);
  assert.match(bot.acks[0]!, /niet meer op de lijst/);
  assert.equal(bot.settled.length, 0);
});

test("quiet hours wrap midnight", () => {
  // 21:00 to 07:00: the ordinary evening-to-morning window.
  assert.equal(isQuiet(new Date("2026-08-11T20:30:00.000Z"), 21, 7), true, "22:30 local");
  assert.equal(isQuiet(new Date("2026-08-11T03:30:00.000Z"), 21, 7), true, "05:30 local");
  assert.equal(isQuiet(new Date("2026-08-11T18:00:00.000Z"), 21, 7), false, "20:00 local");
  assert.equal(isQuiet(new Date("2026-08-11T20:30:00.000Z"), 0, 0), false, "never quiet");
});

test("what is sent names the rule, the place and how long it held", () => {
  const html = render(anomaly(), "en");

  assert.match(html, /<b>stuck<\/b>/);
  assert.match(html, /Overloop/);
  assert.match(html, /held for 6 hours/);
});

test("the same finding reads in the language of whoever is being told", () => {
  const dutch = render(
    { ...anomaly(), phrase: { key: "stuck.dead", args: { subject: "binary_sensor.raam", state: "unavailable" } } },
    "nl",
  );

  assert.match(dutch, /<b>vastgelopen<\/b>/);
  assert.match(dutch, /meldt unavailable en heeft geen waarde te geven/);
  assert.match(dutch, /staat al 6 uur/);
});

test("a rule with no phrase of its own still says its piece", () => {
  // The self checks write English prose and no key. A reader in another
  // language gets that prose rather than a blank line.
  const dutch = render({ ...anomaly(), rule: "invariant" as const, phrase: null }, "nl");

  assert.match(dutch, /has not changed in 24 hours/);
  assert.match(dutch, /<b>aanname<\/b>/);
});

function anomaly(): OpenAnomaly {
  return ({
    id: 1,
    fingerprint: "stuck:binary_sensor.overloop",
    subject: "binary_sensor.overloop",
    rule: "stuck",
    watchGroup: "motion",
    area: "Overloop",
    firstAt: NOW.toISOString(),
    lastAt: NOW.toISOString(),
    buckets: 6,
    observed: null,
    expected: null,
    deviation: null,
    detail: "binary_sensor.overloop has not changed in 24 hours",
    phrase: null,
    ripe: true,
  });
}
