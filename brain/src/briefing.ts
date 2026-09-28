/**
 * The briefing, kept for a second telling.
 *
 * A morning briefing is the most expensive thing the assistant says: seven
 * tools, each answered into a fresh round with the whole prompt in front of
 * it, for a minute of speech. Asked for it again ten minutes later -- somebody
 * came back into the room, somebody else wants to hear it -- the honest answer
 * is the same minute of speech, and the tools would come back with the same
 * mail, the same agenda and the same sky. So the answer is kept, along with
 * the windows that went up with it, and for a while a second briefing is a
 * lookup: one tool call that puts the windows back and hands the text over to
 * be said again, instead of seven that fetch what is already known.
 *
 * "A while" is a setting, two hours by default. Past it the weather has moved
 * on and the mail has come in, and the tool says so: give a fresh one. That is
 * also what happens when the request is the first of the day, or when the
 * cache was never filled because the deployment has no tool that marks a turn
 * as the briefing.
 *
 * Which turn was the briefing is decided by a convention rather than by the
 * words: any tool called with `briefing: true` marks its turn. The pull request
 * pack does that already for its once-a-day gate, and a pack written for
 * another house can do the same without core knowing its name.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { HookCallbackMatcher, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { formatLocal } from "@jarvis/shared";
import type { DisplayDismiss, DisplayPayload, PackDisplay, SpeechLang } from "@jarvis/shared";
import { z } from "zod";

export const BRIEFING_SERVER_NAME = "briefing";
export const BRIEFING_TOOLS = [`mcp__${BRIEFING_SERVER_NAME}__*`];

/** Where the last briefing lives in the settings table. */
export const BRIEFING_CACHE_KEY = "briefing.cache";

/** A window as it went up during the briefing, so it can go up the same way again. */
export interface ShownWindow {
  payload: DisplayPayload;
  dismiss: DisplayDismiss;
  anchor?: string;
  /** How far into the answer it went up, in characters, so it can go up there again. */
  at?: number;
}

/** Puts a window back on screen; `at` is where in the answer it belongs. */
export type ReplayDisplay = (
  payload: DisplayPayload,
  dismiss: DisplayDismiss,
  anchor?: string,
  at?: number,
) => string;

export interface CachedBriefing {
  /** When it was given, ISO 8601. */
  at: string;
  /** The language it was spoken in. */
  lang: SpeechLang;
  /** What was said, in full. */
  text: string;
  windows: ShownWindow[];
}

/** The two methods of the store this module uses. */
export interface SettingStore {
  setting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

/** Whether a tool call, by its arguments, marks its turn as the briefing. */
export function marksBriefing(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as Record<string, unknown>)["briefing"] === true
  );
}

/**
 * Whether the question asks for the briefing in so many words.
 *
 * "Brief me", "de briefing", "brief me opnieuw", "briefing please". Not the
 * Dutch letter ("stuur een brief"): a bare "brief" counts only with somebody to
 * brief or a word for again beside it. Decided here rather than by the model,
 * because the model twice read a gate's answer as its own and said "already
 * briefed" to the one question that word can never answer.
 */
export function asksForBriefing(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bbriefing\b/.test(t) ||
    /\bbrief\s+(me|mij|ons|us)\b/.test(t) ||
    /\bbrief\b[^.!?]*\b(opnieuw|again|nogmaals|once more|nog een keer)\b/.test(t)
  );
}

/**
 * Whether a text is the once-a-day gate speaking rather than a briefing.
 *
 * The pull request pack answers a second morning call with "vandaag al
 * gebriefd"; a turn built on that answer is not a briefing, whatever it was
 * marked as, and must not be kept as one -- kept, it was said again word for
 * word to "brief me opnieuw", windows and all.
 */
export function looksGated(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return /\b(al gebriefd|already briefed|briefed today|briefed you today)\b/i.test(text);
}

/**
 * The paragraph put against an explicit request for the briefing.
 *
 * Against the question, in the same message, so it is the last thing read
 * before answering: the persona says the same further up and was outvoted.
 */
export function askedInstruction(): string {
  return (
    "[The user asked for the briefing in so many words. Give it, in full, now. Call " +
    "briefing_again first: say its text if it hands one over, otherwise fetch everything " +
    "the way a morning briefing goes, with again=true beside briefing=true. Any tool that " +
    "says the briefing was already given today is not about this request; \"already " +
    "briefed\" is never the answer to it.]"
  );
}

/**
 * The hook that makes the request stick: on a turn that asked for the
 * briefing, every tool called with `briefing: true` is called with
 * `again: true` as well, whether the model remembered to or not. A pack
 * without that argument ignores it.
 */
export function againHook(asked: () => boolean): HookCallbackMatcher {
  return {
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== "PreToolUse" || !asked()) return {};
        const args = input.tool_input;
        if (!marksBriefing(args) || (args as Record<string, unknown>)["again"] === true) return {};
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { ...(args as Record<string, unknown>), again: true },
          },
        };
      },
    ],
  };
}

/** The hook that notices a briefing call being answered by the gate. */
export function gateHook(onGate: () => void): HookCallbackMatcher {
  return {
    hooks: [
      async (input: HookInput) => {
        if (
          input.hook_event_name === "PostToolUse" &&
          marksBriefing(input.tool_input) &&
          looksGated(input.tool_response)
        ) {
          onGate();
        }
        return {};
      },
    ],
  };
}

/** The last briefing, kept in the store, and whether it is still worth repeating. */
export class BriefingCache {
  constructor(
    private readonly store: SettingStore,
    /** How long a briefing stays good for. Zero keeps nothing. */
    private readonly maxAgeMs: number,
  ) {}

  /** Writes the briefing down, replacing the previous one. */
  remember(entry: Omit<CachedBriefing, "at">, now = Date.now()): void {
    if (this.maxAgeMs <= 0) return;
    if (looksGated(entry.text)) return;          // the gate speaking is not a briefing
    const cached: CachedBriefing = { at: new Date(now).toISOString(), ...entry };
    this.store.setSetting(BRIEFING_CACHE_KEY, JSON.stringify(cached));
  }

  /** The last briefing, however old, or null when there was none. */
  last(): CachedBriefing | null {
    const raw = this.store.setting(BRIEFING_CACHE_KEY);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<CachedBriefing>;
      if (
        typeof parsed.at !== "string" ||
        typeof parsed.text !== "string" ||
        (parsed.lang !== "nl" && parsed.lang !== "en") ||
        !Array.isArray(parsed.windows)
      ) {
        return null;
      }
      return { at: parsed.at, lang: parsed.lang, text: parsed.text, windows: parsed.windows };
    } catch {
      return null;
    }
  }

  /** The last briefing if it is recent enough to be said again, else null. */
  fresh(now = Date.now()): CachedBriefing | null {
    if (this.maxAgeMs <= 0) return null;
    const last = this.last();
    if (last === null) return null;
    const at = Date.parse(last.at);
    if (Number.isNaN(at) || at > now || now - at > this.maxAgeMs) return null;
    if (looksGated(last.text)) return null;      // kept before this check existed
    return last;
  }
}

const NAMES: Record<SpeechLang, string> = { en: "English", nl: "Dutch" };

function clock(iso: string): string {
  return formatLocal(new Date(iso), { hour: "2-digit", minute: "2-digit" });
}

function minutesAgo(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

/**
 * What the tool answers when there is a briefing to repeat.
 *
 * An instruction rather than a report, like the display tools' answers: the
 * model is told to say the text, not that there is a text. Exported for the
 * tests, and so the wording lives in one place.
 */
export function repeatInstruction(cached: CachedBriefing, lang: SpeechLang, now = Date.now()): string {
  // The language is named every time, not only when the switch was flipped in
  // between: the text below is whatever was said, and what was said is not
  // always the language the session was in.
  const translate =
    cached.lang === lang
      ? ` Say it in ${NAMES[lang]}, whatever language the text below is in.`
      : ` It was given in ${NAMES[cached.lang]}; say it in ${NAMES[lang]}.`;
  return (
    `The briefing from ${clock(cached.at)} (${minutesAgo(cached.at, now)} minutes ago). ` +
    "Its windows are back on screen; say nothing about that. Say the briefing again now, " +
    "this text, word for word except where the clock has moved on since, keeping its " +
    "desk markers where they stand. Do not fetch " +
    `anything.${translate}\n\n${cached.text}`
  );
}

/** What the tool answers when there is nothing recent enough to repeat. */
export function freshInstruction(last: CachedBriefing | null, maxAgeMs: number): string {
  const hours = Math.round((maxAgeMs / 3_600_000) * 10) / 10;
  const since =
    last === null
      ? "there is no earlier one to repeat"
      : `the last one was at ${clock(last.at)}`;
  const window = maxAgeMs <= 0 ? "" : ` from the last ${hours} hour${hours === 1 ? "" : "s"}`;
  return (
    `No briefing${window} to repeat: ${since}. Give a full, fresh briefing now, the way ` +
    "a morning briefing goes: fetch everything, and pass again=true together with " +
    "briefing=true to the pull request status tool so its once-a-day gate lets this one " +
    "through."
  );
}

/**
 * The tool the assistant reaches for when asked to brief again.
 *
 * `lang` is read per call rather than fixed: a briefing given in Dutch and
 * asked for again after the switch is said in English, and the instruction
 * says so.
 */
export function createBriefingServer(
  cache: BriefingCache,
  display: ReplayDisplay,
  lang: () => SpeechLang,
  maxAgeMs: number,
) {
  const again = tool(
    "briefing_again",
    "Call this first whenever the user asks to be briefed again or once more -- 'brief me " +
      "opnieuw', 'nog een keer de briefing', 'brief me again', 'repeat the briefing'. If " +
      "the briefing from the last while is kept, it puts its windows back on screen and " +
      "hands you its text to say again: say that, and fetch nothing. If nothing recent is " +
      "kept, it says so, and you give a full fresh briefing instead.",
    {},
    async () => {
      const now = Date.now();
      const cached = cache.fresh(now);
      if (cached === null) {
        return { content: [{ type: "text" as const, text: freshInstruction(cache.last(), maxAgeMs) }] };
      }
      for (const window of cached.windows) {
        display(window.payload, window.dismiss, window.anchor, window.at);
      }
      return { content: [{ type: "text" as const, text: repeatInstruction(cached, lang(), now) }] };
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({ name: BRIEFING_SERVER_NAME, version: "1.0.0", tools: [again] });
}
