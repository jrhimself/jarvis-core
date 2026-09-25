/**
 * What time it is, said before every question.
 *
 * A model has no clock. Asked the hour it either says so, which is a strange
 * answer from something that just read the weather, or it invents one, which is
 * worse. Neither is a gap a tool can close well: a question about the time is
 * the cheapest question there is, and paying a round trip for it makes the one
 * answer that should be instant the slowest in the house.
 *
 * So it travels with the question, like the primed facts and the plan line, and
 * for the same reason -- the system prompt is written once per session and a
 * session outlives the minute it started in. A block built per turn is right
 * every turn.
 *
 * The moment is formatted in the deployment's own locale and zone, from
 * `@jarvis/shared/time`: the answer is spoken in the language the rest of the
 * conversation is in, and the hour is the one the house is living in rather
 * than the container's. The zone is named because it is the part that can be
 * wrong -- an unset zone falls back to the machine's, which is usually UTC, and
 * a self check already says so at startup.
 */

import { formatLocal, timeZone } from "@jarvis/shared";

/** The current moment, as the line that goes in front of the question. */
export function nowBlock(now = new Date()): string {
  const moment = formatLocal(now, { dateStyle: "full", timeStyle: "short" });
  return `[Now: ${moment} (${timeZone()}). Sent with every question, so it is the current time; answer anything about the time or the date from it rather than reaching for a tool.]`;
}
