/**
 * What has been on the screen, and what became of it.
 *
 * The HUD owns the windows: it draws them, folds them away and throws them out.
 * That makes closing one destructive in a way nothing else in a conversation
 * is -- the contents existed only as pixels, and the moment they are gone is
 * usually the moment you wanted them. Asking again is not a good answer either:
 * a second trip to the mailbox is slower, costs a tool call, and can come back
 * with a different answer than the one that was on screen.
 *
 * So the brain keeps the payload of everything it pushed, and the HUD reports
 * what left and why. "Show me those mails again" is then a lookup, not a fetch.
 *
 * One log per process rather than per session or per socket, because there is
 * one screen: an agent session that idles out and is replaced should not lose
 * sight of the window still standing in front of the user.
 */

import type { DisplayGone, DisplayPayload } from "@jarvis/shared";

/** How many windows back the log reaches. Beyond this it is history, not memory. */
const KEEP = 24;

export interface ScreenRecord {
  /** The display id, as handed to the HUD. */
  id: string;
  payload: DisplayPayload;
  /** When it was pushed, epoch milliseconds. */
  at: number;
  /** What took it off screen, or null while it is still up. */
  gone: DisplayGone | null;
  /** When it left, epoch milliseconds. */
  goneAt: number | null;
}

const log: ScreenRecord[] = [];

/** Records a window the moment it is pushed. */
export function recordScreen(id: string, payload: DisplayPayload, now = Date.now()): void {
  log.push({ id, payload, at: now, gone: null, goneAt: null });
  while (log.length > KEEP) log.shift();
}

/**
 * Marks a window as gone.
 *
 * Searched backwards because an id can be in the log twice: a window that is
 * refreshed keeps its id, and it is the one currently on screen that just left.
 * Unknown ids are ignored -- the page outlives a restart, so it can report a
 * window this process never pushed.
 */
export function screenGone(id: string, reason: DisplayGone, now = Date.now()): void {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const record = log[i];
    if (record === undefined || record.id !== id || record.gone !== null) continue;
    record.gone = reason;
    record.goneAt = now;
    return;
  }
}

/** The most recent windows, newest first. */
export function recentScreens(limit = KEEP): ScreenRecord[] {
  return log.slice(-Math.max(1, limit)).reverse();
}

/** One window by id, whether it is still up or not: the most recent of that id. */
export function screenById(id: string): ScreenRecord | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const record = log[i];
    if (record !== undefined && record.id === id) return record;
  }
  return undefined;
}

/** Empties the log. For tests; nothing in the running brain forgets on purpose. */
export function forgetScreens(): void {
  log.length = 0;
}

/** A rough "3 minutes ago", in words rather than a timestamp to read aloud. */
function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/** The heading a window carried, for referring to it in a sentence. */
export function screenTitle(payload: DisplayPayload): string {
  switch (payload.type) {
    case "image":
      return payload.alt;
    case "panel":
    case "chart":
    case "weather":
      return payload.title;
    case "text":
      return payload.title ?? "note";
  }
}

/**
 * What a window said, written out.
 *
 * Enough to answer from without showing it again -- the user may want the third
 * line read out rather than the whole thing back on screen.
 */
export function screenContents(payload: DisplayPayload): string {
  switch (payload.type) {
    case "panel":
      return payload.rows
        .map((row) => `- ${row.label}: ${row.value}${row.hint === undefined ? "" : ` (${row.hint})`}`)
        .join("\n");
    case "chart": {
      const unit = payload.unit === undefined ? "" : ` ${payload.unit}`;
      const values = payload.points.map((point) => point.value);
      const first = payload.points[0];
      const last = payload.points[payload.points.length - 1];
      const from = first === undefined ? "" : `${first.label} ${first.value}${unit}`;
      const to = last === undefined ? "" : `${last.label} ${last.value}${unit}`;
      return (
        `- ${payload.points.length} points, from ${from} to ${to}\n` +
        `- lowest ${Math.min(...values)}${unit}, highest ${Math.max(...values)}${unit}`
      );
    }
    case "text":
      return payload.body;
    case "image":
      return payload.caption === undefined ? payload.alt : `${payload.alt} -- ${payload.caption}`;
    case "weather": {
      const degrees = payload.units.temperature;
      const head: string[] = [];
      if (payload.now !== undefined) {
        const now: string[] = [];
        if (payload.now.temperature !== undefined) now.push(`${Math.round(payload.now.temperature)}${degrees}`);
        if (payload.now.summary !== undefined) now.push(payload.now.summary);
        else if (payload.now.condition !== undefined) now.push(payload.now.condition);
        if (now.length > 0) head.push(`- now: ${now.join(", ")}`);
      }
      if (payload.sun?.rise !== undefined || payload.sun?.set !== undefined) {
        head.push(`- sun: ${[payload.sun.rise, payload.sun.set].filter((t) => t !== undefined).join(" - ")}`);
      }
      const days = payload.days
        .map((day) => {
          const parts: string[] = [];
          if (day.summary !== undefined) parts.push(day.summary);
          else if (day.condition !== undefined) parts.push(day.condition);
          if (day.low !== undefined && day.high !== undefined) parts.push(`${day.low}-${day.high}${degrees}`);
          else if (day.high !== undefined) parts.push(`${day.high}${degrees}`);
          if (day.precipitationChance !== undefined) parts.push(`rain ${day.precipitationChance}%`);
          if (day.windSpeed !== undefined) {
            const unit = payload.units.windSpeed ?? "";
            parts.push(
              `wind ${day.windSpeed}${unit}${day.windDirection === undefined ? "" : ` ${day.windDirection}`}`,
            );
          }
          return `- ${day.label}: ${parts.join(", ")}`;
        });
      return [...head, ...days].join("\n");
    }
  }
}

/** One window as a block the assistant can read. */
export function describeScreen(record: ScreenRecord, now = Date.now()): string {
  const state =
    record.gone === null
      ? "still on screen"
      : record.gone === "closed"
        ? `closed by the user ${ago(now - (record.goneAt ?? now))}`
        : `gone (${record.gone})`;
  return [
    `id: ${record.id}`,
    `what: ${record.payload.type} -- ${screenTitle(record.payload)}`,
    `shown: ${ago(now - record.at)}, ${state}`,
    screenContents(record.payload),
  ].join("\n");
}
