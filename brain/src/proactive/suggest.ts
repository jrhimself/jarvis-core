/**
 * Putting a finding to somebody, and hearing what they think of it.
 *
 * Detection answers "is this unusual". Nobody lives in that question. The one
 * worth asking is "was this worth telling you", and there is exactly one place
 * the answer to it exists: the person who read the sentence. So a finding that
 * has held long enough is written down as a suggestion, sent with three buttons
 * under it, and the press is kept next to what was sent.
 *
 * That table is the point of the whole exercise. Rules can be tuned against
 * recorded hours -- and have been, twice -- but recorded hours cannot say
 * whether a true reading was a welcome one. Only a verdict can, and a verdict
 * only exists if somebody was asked.
 *
 * Three restraints, none of them a model: nothing is offered twice, nothing is
 * offered about a subject that has been put away, and nothing at all is sent
 * inside the quiet hours or past the daily count. All four are counted before
 * anything is rendered, because a message that should not have been sent cannot
 * be unsent.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Config } from "../config.js";
import { openAnomalies, type OpenAnomaly } from "./detect.js";
import {
  alreadySuggested,
  markDelivered,
  markUndeliverable,
  recordSuggestion,
  recordVerdict,
  snoozeSuggestion,
  snoozedSubjects,
  suggestedSince,
  suggestion,
} from "./store.js";
import { escapeHtml } from "../dev/notify.js";
import { languageOf, ruleName, say, word } from "./phrases.js";
import { locale } from "@jarvis/shared";
import type { Button, Press } from "../telegram.js";
import { localSlot } from "./baselines.js";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/** How long a subject is left alone when somebody asks for that. */
const SNOOZE_DAYS = 7;

/** The three answers, in the order the buttons are shown. */
const VERDICTS = ["right", "noise", "later"] as const;

/** The prefix that marks a press as belonging to this feature. */
const TAG = "suggest";

/**
 * The part of a bot this needs.
 *
 * An interface rather than the class, so a test can hand in something that
 * records what it was asked to send. The real one is in `telegram.ts`; nothing
 * here cares which messenger it is talking to.
 */
export interface Sender {
  send(chatId: string, html: string, buttons?: Button[]): Promise<number | null>;
  acknowledge(queryId: string, text: string): Promise<void>;
  settle(chatId: string, messageId: number, html: string): Promise<void>;
}

/**
 * The language messages are written in.
 *
 * Taken from the configured locale rather than a setting of its own. A
 * deployment that has said its house speaks Dutch has already answered this,
 * and a second setting that could disagree with the first is a bug waiting for
 * a quiet evening.
 */
function language(): string {
  return languageOf(locale());
}

/** Buttons for one suggestion. */
export function buttonsFor(id: number, lang = language()): Button[] {
  return VERDICTS.map((verdict) => ({
    text: word(`button.${verdict}`, lang),
    data: `${TAG}:${verdict}:${id}`,
  }));
}

/**
 * The sentence that goes out.
 *
 * The rule name is in it because the four rules fail in different ways, and a
 * verdict is far more useful when the thing being judged is legible: "stuck" on
 * a sensor that turns out to have been unplugged for a month is a different
 * lesson from "deviation" on a meter that reads high every Sunday.
 */
export function render(anomaly: OpenAnomaly, lang = language()): string {
  const where = anomaly.area === null ? "" : ` &middot; ${escapeHtml(anomaly.area)}`;
  const held =
    anomaly.buckets === 1
      ? word("held.first", lang)
      : word("held.hours", lang, { hours: anomaly.buckets });
  return (
    `<b>${escapeHtml(ruleName(anomaly.rule, lang))}</b>${where}\n` +
    `${escapeHtml(say(anomaly.phrase, lang, anomaly.detail))}\n` +
    `<i>${escapeHtml(held)}</i>`
  );
}

/** What a message becomes once it has been answered. */
function settled(body: string, verdict: string, lang: string): string {
  return `${body}\n\n<i>${escapeHtml(word(`said.${verdict}`, lang))}</i>`;
}

/** Whether the clock is inside the hours nobody wants to be spoken to in. */
export function isQuiet(now: Date, from: number, to: number): boolean {
  if (from === to) return false;
  const hour = localSlot(now).hour;
  // A window that wraps midnight is two windows, and the ordinary case -- quiet
  // from the evening until the morning -- is that one.
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** What one pass did, for the log and for the tests. */
export interface OfferReport {
  offered: number;
  /** Ripe and unsuggested, but held back by quiet hours, the cap or a snooze. */
  held: number;
}

/**
 * Offers what is worth offering, and returns what it did.
 *
 * Ordered by how long a condition has held, so a cap that bites drops the
 * newest rather than the best established.
 */
export async function offer(
  db: DatabaseSync,
  bot: Sender,
  config: Config,
  now = new Date(),
): Promise<OfferReport> {
  const report: OfferReport = { offered: 0, held: 0 };
  if (config.suggestChat === "") return report;

  const asleep = isQuiet(now, config.quietFrom, config.quietTo);
  const snoozed = snoozedSubjects(db, now);
  let room = config.suggestPerDay - suggestedSince(db, new Date(now.getTime() - DAY_MS));

  for (const anomaly of openAnomalies(db)) {
    if (!anomaly.ripe) continue;
    if (alreadySuggested(db, anomaly.id)) continue;

    if (asleep || room <= 0 || snoozed.has(anomaly.subject)) {
      report.held += 1;
      continue;
    }

    const body = render(anomaly);
    const id = recordSuggestion(db, anomaly.id, body, now);
    const messageId = await bot.send(config.suggestChat, body, buttonsFor(id));

    if (messageId === null) {
      markUndeliverable(db, id);
      continue;
    }

    markDelivered(db, id, config.suggestChat, messageId, now);
    report.offered += 1;
    room -= 1;
  }

  return report;
}

/**
 * Takes a press and writes down what it meant.
 *
 * Unknown presses are acknowledged rather than ignored. A button from an older
 * version of this code is still a person tapping a thing and getting nothing,
 * which reads as broken however correct the silence is.
 */
export async function handlePress(
  db: DatabaseSync,
  bot: Sender,
  press: Press,
  now = new Date(),
): Promise<void> {
  const [tag, verdict, rawId] = press.data.split(":");
  if (tag !== TAG || verdict === undefined || rawId === undefined) return;

  const lang = language();
  const id = Number(rawId);
  const known = (VERDICTS as readonly string[]).includes(verdict);
  const row = Number.isFinite(id) ? suggestion(db, id) : null;

  if (!known || row === null) {
    await bot.acknowledge(press.queryId, word("ack.gone", lang));
    return;
  }

  if (verdict === "later") {
    snoozeSuggestion(db, id, new Date(now.getTime() + SNOOZE_DAYS * DAY_MS), now);
  } else {
    recordVerdict(db, id, verdict, now);
  }

  await bot.acknowledge(press.queryId, word(`ack.${verdict}`, lang, { days: SNOOZE_DAYS }));
  await bot.settle(press.chatId, press.messageId, settled(row.body, verdict, lang));
}
