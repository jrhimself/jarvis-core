/**
 * When something is due, worked out in the household's own hours.
 *
 * "Every weekday at nine" means nine o'clock on the wall, which is a different
 * instant either side of the clocks changing. So nothing here counts in
 * milliseconds from a start: a calendar schedule is searched forwards through
 * local time, and only the interval kind ("every two hours") is a plain span.
 *
 * The forms accepted are few on purpose. The model turns whatever was said
 * into one of them, and a parser that tried to understand a language would be
 * a second, worse model sitting in front of the first.
 */

import { formatter, timeZone } from "@jarvis/shared";

export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "every"; ms: number }
  | { kind: "cron"; expr: string };

/** Shorter than this and a mistaken job is a bill before anyone notices. */
export const MIN_INTERVAL_MS = 5 * 60_000;

/** The wording of a refusal, which the model reads and passes on. */
export class ScheduleError extends Error {}

const FORMS =
  "Use one of: 'in 30m' / 'in 2h' (once, that far from now), 'every 30m' / 'every 2h' (at least 5m), " +
  "'daily at 09:00', 'weekdays at 8:30', 'every monday at 9am', a five-field cron expression " +
  "('0 9 * * 1-5'), or a local timestamp like '2026-10-01T09:00'.";

const DAYS: Record<string, string> = {
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
};

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
};

function duration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(text.trim());
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const unit = UNIT_MS[match[2]];
  if (unit === undefined) return null;
  return Math.round(Number(match[1]) * unit);
}

/** "9", "9am", "09:30", "9:30pm", "noon" as [hour, minute]. */
function clock(text: string): [number, number] | null {
  const word = text.trim();
  if (word === "noon") return [12, 0];
  if (word === "midnight") return [0, 0];
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(word);
  if (match?.[1] === undefined) return null;
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const half = match[3];
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (half === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return [hour, minute];
}

interface Local {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock in the configured zone at an instant. */
function local(at: Date): Local {
  const parts = formatter(
    {
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    },
    "en-US",
  ).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAY[get("weekday")] ?? 0,
  };
}

/** How far the configured zone is ahead of UTC at an instant, in milliseconds. */
function offsetAt(at: Date): number {
  const wall = local(at);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const whole = Math.floor(at.getTime() / 60_000) * 60_000;
  return asUtc - whole;
}

/** The instant a wall-clock time falls on in the configured zone. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Twice, because the offset at the guess is not always the offset at the answer.
  let guess = naive - offsetAt(new Date(naive));
  guess = naive - offsetAt(new Date(guess));
  return new Date(guess);
}

interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function field(text: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (match?.[1] === undefined) throw new ScheduleError(`'${item}' is not valid in the ${name} field of a cron expression.`);
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) throw new ScheduleError(`A step of ${step} is not valid in the ${name} field.`);
    let from = min;
    let to = max;
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-");
      from = Number(a);
      to = b === undefined ? (match[2] === undefined ? from : max) : Number(b);
    }
    if (from < min || to > max || from > to) {
      throw new ScheduleError(`${name} runs from ${min} to ${max}; '${item}' is outside it.`);
    }
    for (let value = from; value <= to; value += step) out.add(value);
  }
  return out;
}

function parseCron(expr: string): Cron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new ScheduleError(`A cron expression has five fields, not ${fields.length}. ${FORMS}`);
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const weekdays = field(dow, 0, 7, "day-of-week");
  // Cron writes Sunday as 0 and as 7.
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    minute: field(m, 0, 59, "minute"),
    hour: field(h, 0, 23, "hour"),
    dom: field(dom, 1, 31, "day-of-month"),
    month: field(mon, 1, 12, "month"),
    dow: weekdays,
    domAny: dom === "*",
    dowAny: dow === "*",
  };
}

function dayMatches(cron: Cron, wall: Local): boolean {
  if (!cron.month.has(wall.month)) return false;
  const byDate = cron.dom.has(wall.day);
  const byWeekday = cron.dow.has(wall.weekday);
  // Cron's own rule: when both are restricted, either is enough.
  if (!cron.domAny && !cron.dowAny) return byDate || byWeekday;
  return byDate && byWeekday;
}

function nextCron(expr: string, after: Date): Date | null {
  const cron = parseCron(expr);
  let at = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  // Steps are a day, an hour or a minute depending on what fails to match, so a
  // year of nothing costs a few thousand iterations rather than half a million.
  for (let guard = 0; guard < 20_000; guard += 1) {
    const wall = local(at);
    if (!dayMatches(cron, wall)) {
      at = new Date(at.getTime() + ((24 - wall.hour) * 60 - wall.minute) * 60_000);
    } else if (!cron.hour.has(wall.hour)) {
      at = new Date(at.getTime() + (60 - wall.minute) * 60_000);
    } else if (!cron.minute.has(wall.minute)) {
      at = new Date(at.getTime() + 60_000);
    } else {
      return at;
    }
  }
  return null;
}

/** Turns what was asked for into a schedule, or says which forms exist. */
export function parseSchedule(input: string, now: Date): Schedule {
  const text = input.trim();
  const lower = text.toLowerCase();
  if (lower === "") throw new ScheduleError(`No schedule given. ${FORMS}`);

  const later = /^in\s+(.+)$/.exec(lower);
  if (later?.[1] !== undefined) {
    const ms = duration(later[1]);
    if (ms === null || ms < 60_000) throw new ScheduleError(`'${input}' is not a span of at least a minute. ${FORMS}`);
    return { kind: "once", at: new Date(now.getTime() + ms).toISOString() };
  }

  const repeat = /^every\s+(.+)$/.exec(lower);
  if (repeat?.[1] !== undefined) {
    const span = repeat[1] === "hour" ? "1h" : repeat[1] === "day" ? "24h" : repeat[1];
    const ms = duration(span);
    if (ms !== null) {
      if (ms < MIN_INTERVAL_MS) throw new ScheduleError("A job cannot repeat more often than every 5 minutes.");
      return { kind: "every", ms };
    }
  }

  const calendar = /^(?:every\s+)?(daily|day|weekdays?|weekends?|[a-z]+day)s?\s*(?:at\s+)?(.+)$/.exec(lower);
  if (calendar?.[1] !== undefined && calendar[2] !== undefined) {
    const word = calendar[1].replace(/s$/, "");
    const time = clock(calendar[2]);
    const dow =
      word === "daily" || word === "day"
        ? "*"
        : word === "weekday"
          ? "1-5"
          : word === "weekend"
            ? "0,6"
            : DAYS[word];
    if (dow !== undefined && time !== null) {
      return { kind: "cron", expr: `${time[1]} ${time[0]} * * ${dow}` };
    }
  }

  if (lower.split(/\s+/).length === 5 && /^[\d*/,\-\s]+$/.test(lower)) {
    parseCron(lower);
    return { kind: "cron", expr: lower.split(/\s+/).join(" ") };
  }

  const stamp = /^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::\d{2})?)?\s*(z|[+-]\d{2}:?\d{2})?$/i.exec(text);
  if (stamp?.[1] !== undefined && stamp[2] !== undefined && stamp[3] !== undefined) {
    const [year, month, day] = [Number(stamp[1]), Number(stamp[2]), Number(stamp[3])];
    const hour = stamp[4] === undefined ? 9 : Number(stamp[4]);
    const minute = stamp[5] === undefined ? 0 : Number(stamp[5]);
    const zone = stamp[6];
    const at =
      zone === undefined
        ? zonedInstant(year, month, day, hour, minute)
        : new Date(text.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isNaN(at.getTime())) throw new ScheduleError(`'${input}' is not a valid date. ${FORMS}`);
    if (at.getTime() <= now.getTime()) throw new ScheduleError(`${input} is already in the past.`);
    return { kind: "once", at: at.toISOString() };
  }

  throw new ScheduleError(`I could not read '${input}' as a schedule. ${FORMS}`);
}

/** The next instant strictly after `after` at which the schedule fires, or null when it never will. */
export function nextRun(schedule: Schedule, after: Date): Date | null {
  switch (schedule.kind) {
    case "once": {
      const at = new Date(schedule.at);
      return at.getTime() > after.getTime() ? at : null;
    }
    case "every":
      return new Date(after.getTime() + schedule.ms);
    case "cron":
      return nextCron(schedule.expr, after);
  }
}

/** The schedule in a few words, as a person would say it back. */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "once":
      return `once, at ${formatter({ dateStyle: "medium", timeStyle: "short" }, "en-GB").format(new Date(schedule.at))}`;
    case "every": {
      const minutes = Math.round(schedule.ms / 60_000);
      if (minutes % 1440 === 0) return `every ${minutes / 1440} day(s)`;
      if (minutes % 60 === 0) return `every ${minutes / 60} hour(s)`;
      return `every ${minutes} minutes`;
    }
    case "cron":
      return `on the schedule '${schedule.expr}' (${timeZone()})`;
  }
}

/** Serialised for storage. */
export function encodeSchedule(schedule: Schedule): string {
  return JSON.stringify(schedule);
}

/** Read back from storage; throws when the row is not a schedule this version knows. */
export function decodeSchedule(stored: string): Schedule {
  const value: unknown = JSON.parse(stored);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (record["kind"] === "once" && typeof record["at"] === "string") return { kind: "once", at: record["at"] };
    if (record["kind"] === "every" && typeof record["ms"] === "number") return { kind: "every", ms: record["ms"] };
    if (record["kind"] === "cron" && typeof record["expr"] === "string") return { kind: "cron", expr: record["expr"] };
  }
  throw new Error(`not a schedule: ${stored}`);
}
