/**
 * How much of the plan is left, and what is done about it.
 *
 * The assistant runs on a claude.ai subscription, which is metered in two
 * windows: five hours and seven days. When one is spent, the model answers
 * with a line of English about weekly limits and a reset time in a bracketed
 * time zone -- read aloud, in a Dutch living room, by a voice that had just
 * said "Momentje." Three things are done here instead.
 *
 * The HUD is told. Every API call carries the state of whichever window is
 * closer to full, and the SDK relays it as a `rate_limit_event`; the SDK can
 * also be asked for both windows at once, when the token is allowed to ask.
 * Whatever is learned is kept here and handed to every open page.
 *
 * The model is told, quietly. Past a threshold the turn carries a line about
 * the window and an instruction to economise -- and to say nothing about it.
 * A spent plan is the household's business, not the assistant's small talk.
 *
 * The user is told, kindly. When the answer is the limit line, it is replaced
 * by the deployment's own sentence with the reset time worked into it, in the
 * language and the words the house chose.
 */

import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";

import { formatLocal, locale, type PlanUsage, type PlanWindow } from "@jarvis/shared";

type Listener = (usage: PlanUsage) => void;

let current: PlanUsage | null = null;
const listeners = new Set<Listener>();

/** The latest word on the plan, or null before anything has been heard. */
export function planUsage(): PlanUsage | null {
  return current;
}

/** Hears every change. Returns the way to stop hearing. */
export function onPlanUsage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Back to knowing nothing. For the tests, which share this module. */
export function forgetPlanUsage(): void {
  current = null;
}

function publish(next: PlanUsage): PlanUsage {
  current = next;
  for (const listener of listeners) listener(next);
  return next;
}

function pick(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function percent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
}

/**
 * A `rate_limit_event` from the SDK: the state of the window that binds.
 *
 * The event names one window and says whether calls are allowed, allowed with
 * a warning, or rejected. It does not always carry a percentage -- a rejection
 * comes bare -- and a rejection is a hundred percent by any measure. The other
 * window keeps whatever was last heard about it.
 */
export function notePlanEvent(info: unknown, now = new Date()): PlanUsage | null {
  const status = pick(info, "status");
  if (status !== "allowed" && status !== "allowed_warning" && status !== "rejected") return null;

  const type = pick(info, "rateLimitType");
  const binding: PlanUsage["binding"] =
    type === "five_hour"
      ? "session"
      : typeof type === "string" && (type.startsWith("seven_day") || type === "overage")
        ? "week"
        : null;

  const resetsAt = pick(info, "resetsAt");
  const reading: PlanWindow = {
    utilization: percent(pick(info, "utilization")) ?? (status === "rejected" ? 100 : null),
    resetsAt: typeof resetsAt === "number" ? new Date(resetsAt * 1000).toISOString() : null,
  };

  return publish({
    status: status === "rejected" ? "rejected" : status === "allowed_warning" ? "warning" : "ok",
    binding,
    session: binding === "session" ? reading : current?.session ?? null,
    week: binding === "week" ? reading : current?.week ?? null,
    at: now.toISOString(),
  });
}

function windowFrom(value: unknown): PlanWindow | null {
  if (typeof value !== "object" || value === null) return null;
  const resetsAt = pick(value, "resets_at");
  return {
    utilization: percent(pick(value, "utilization")),
    resetsAt: typeof resetsAt === "string" ? resetsAt : null,
  };
}

/**
 * The SDK's structured `/usage` answer: both windows at once, when the token
 * may ask. Returns null when it may not, so the caller can stop asking.
 */
export function notePlanReport(report: unknown, now = new Date()): PlanUsage | null {
  if (pick(report, "rate_limits_available") !== true) return null;
  const limits = pick(report, "rate_limits");
  const session = windowFrom(pick(limits, "five_hour"));
  const week = windowFrom(pick(limits, "seven_day"));
  if (session === null && week === null) return null;

  const fuller =
    (session?.utilization ?? -1) >= (week?.utilization ?? -1) ? ("session" as const) : ("week" as const);
  const top = Math.max(session?.utilization ?? 0, week?.utilization ?? 0);
  return publish({
    // A rejection is only ever heard from an event; a report that shows a
    // window at a hundred says the same thing in numbers.
    status: current?.status === "rejected" || top >= 100 ? "rejected" : top >= 80 ? "warning" : "ok",
    binding: fuller,
    session,
    week,
    at: now.toISOString(),
  });
}

/** The window that is spent first: the one named as binding, else the fuller. */
export function bindingWindow(usage: PlanUsage): PlanWindow | null {
  if (usage.binding === "session") return usage.session;
  if (usage.binding === "week") return usage.week;
  const s = usage.session?.utilization ?? -1;
  const w = usage.week?.utilization ?? -1;
  return s >= w ? usage.session : usage.week;
}

type DayPart = "night" | "morning" | "afternoon" | "evening";

function dayPart(hour: number): DayPart {
  if (hour < 6) return "night";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** Whether two moments fall on the same local calendar day. */
function sameDay(a: Date, b: Date): boolean {
  return formatLocal(a, { dateStyle: "short" }) === formatLocal(b, { dateStyle: "short" });
}

const DUTCH_PART: Record<DayPart, [today: string, tomorrow: string, plain: string]> = {
  night: ["vannacht", "vannacht", "'s nachts"],
  morning: ["vanochtend", "morgenochtend", "'s ochtends"],
  afternoon: ["vanmiddag", "morgenmiddag", "'s middags"],
  evening: ["vanavond", "morgenavond", "'s avonds"],
};

const ENGLISH_PART: Record<DayPart, [today: string, tomorrow: string, plain: string]> = {
  night: ["tonight", "tonight", "at night"],
  morning: ["this morning", "tomorrow morning", "in the morning"],
  afternoon: ["this afternoon", "tomorrow afternoon", "in the afternoon"],
  evening: ["this evening", "tomorrow evening", "in the evening"],
};

/**
 * The hour as a voice says it, with the part of the day it falls in.
 *
 * "2:00" is read as two digits by every voice tried, and "2 uur" on its own
 * was heard at eleven in the morning as two in the afternoon. So the hour is
 * on the twelve-hour clock and says which part of which day: "2 uur vannacht",
 * "9 uur morgenochtend", "3 uur 30 vanmiddag". Beyond a day the weekday is
 * given by the caller and the part of day loses its "van": "'s nachts".
 */
export function spokenHour(at: Date, now: Date, withinDay = true): string {
  const hour = Number(formatLocal(at, { hour: "numeric", hourCycle: "h23" }));
  const minute = Number(formatLocal(at, { minute: "numeric" }));
  const part = dayPart(hour);
  const dutch = locale().toLowerCase().startsWith("nl");
  const words = (dutch ? DUTCH_PART : ENGLISH_PART)[part];
  const when = !withinDay ? words[2] : sameDay(at, now) ? words[0] : words[1];

  if (!dutch) {
    return `${formatLocal(at, { hour: "numeric", minute: "2-digit", hour12: true })} ${when}`;
  }
  const clock = hour % 12 === 0 ? 12 : hour % 12;
  return `${clock} uur${minute === 0 ? "" : ` ${minute}`} ${when}`;
}

/**
 * When the window opens again, as it would be said: an hour and the part of
 * the day if that is within a day, a weekday before it otherwise. Local zone,
 * local language.
 */
export function describeReset(at: Date, now = new Date()): string {
  if (at.getTime() - now.getTime() < 24 * 60 * 60 * 1000) return spokenHour(at, now);
  return `${formatLocal(at, { weekday: "long" })} ${spokenHour(at, now, false)}`;
}

/**
 * What the model is told about the plan, or nothing while there is nothing to
 * economise on. Goes in front of the question, like the primed facts, because
 * the system prompt is written once per session and the plan drains during it.
 */
export function planContextBlock(usage: PlanUsage | null, warnAt: number, now = new Date()): string {
  if (usage === null) return "";
  const window = bindingWindow(usage);
  if (window === null || window.utilization === null || window.utilization < warnAt) return "";

  const name = usage.binding === "session" ? "5-hour" : "weekly";
  const reset = window.resetsAt === null ? "" : `, resets ${describeReset(new Date(window.resetsAt), now)}`;
  return (
    `[Plan usage: the ${name} window is at ${Math.round(window.utilization)}%${reset}. ` +
    "Keep tool calls and answers to what the question needs. Never mention this to the user.]"
  );
}

/** Whether an answer is the SDK's own line about a spent plan. */
export function isLimitMessage(text: string): boolean {
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/**
 * The deployment's own sentence for a spent plan, with `{reset}` filled in.
 * When no reset time is known, the sentence that wanted one is left out
 * rather than spoken with a hole in it.
 */
export function limitSentence(template: string, usage: PlanUsage | null, now = new Date()): string {
  const window = usage === null ? null : bindingWindow(usage);
  const resetsAt = window?.resetsAt ?? null;
  if (resetsAt !== null) return template.replaceAll("{reset}", describeReset(new Date(resetsAt), now));
  return template
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !sentence.includes("{reset}"))
    .join(" ")
    .trim();
}
