/**
 * Talking to JARVIS from a phone, without a HUD.
 *
 * The websocket is the assistant's front door: a browser, a microphone, a voice
 * answering out loud. It is also the only door, which means the assistant is
 * unreachable from a train, from the office, or from a kitchen where nobody
 * wants to say anything out loud. The bot that carries findings out is already
 * a two-way channel; this is the other direction through it.
 *
 * The same `Conversation` the HUD drives, with the same session rules: one
 * agent per chat, dropped after the idle window or the turn cap, so a question
 * asked an hour later starts fresh rather than dragging a morning behind it.
 * What differs is the voice, which is off -- speaking into a text channel would
 * spend credits on audio nobody can hear -- and the shape of an answer, which
 * arrives as one message rather than a stream, because a chat that edits its
 * own message forty times is unreadable.
 */

import type { SpeechLang } from "@jarvis/shared";

import { Conversation } from "./conversation.js";
import { language } from "./language.js";
import { escapeHtml } from "./dev/notify.js";
import type { Said } from "./telegram.js";

/** What this needs of a bot. */
export interface ChatSender {
  send(chatId: string, html: string): Promise<number | null>;
  typing(chatId: string): Promise<void>;
}

/** Telegram refuses a message over 4096 characters; this leaves room to breathe. */
const CHUNK = 3800;

/** A typing indicator lasts five seconds, so it is renewed just inside that. */
const TYPING_MS = 4000;

/** What is said when a question arrives while the last one is still being answered. */
const BUSY: Record<SpeechLang, string> = {
  en: "I am still working on your last question.",
  nl: "Ik ben nog met je vorige vraag bezig.",
};

/** And when a turn produced no words at all, which should not happen but can. */
const NOTHING: Record<SpeechLang, string> = {
  en: "I could not put an answer together for that.",
  nl: "Ik heb daar geen antwoord op kunnen vormen.",
};

/** Splits a long answer on line breaks where it can, mid-line where it must. */
export function pieces(text: string, limit = CHUNK): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    const at = cut > limit / 2 ? cut : limit;
    out.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest !== "") out.push(rest);
  return out;
}

interface Live {
  conversation: Conversation;
  busy: boolean;
  turn: number;
  /** Where this turn's words go. Replaced per turn, because the conversation outlives it. */
  onChunk: (chunk: string) => void;
  onFail: (message: string) => void;
}

/**
 * One chat, one conversation.
 *
 * Keyed by chat rather than held as a single field, because the map is what
 * makes a second chat somebody else's conversation rather than a continuation
 * of this one. Only the configured chat is answered at all -- a bot token is a
 * URL anybody who has it can write to, and an assistant that answers strangers
 * is an assistant that reads this house's memory to strangers.
 */
export class Chat {
  readonly #live = new Map<string, Live>();

  constructor(
    private readonly bot: ChatSender,
    private readonly allowed: string,
  ) {}

  /** Answers one message. Never throws: a failed turn is a sentence, not a crash. */
  async said(said: Said): Promise<void> {
    if (said.chatId !== this.allowed) return;
    const text = said.text.trim();
    if (text === "") return;

    const live = this.#for(said.chatId);
    if (live.busy) {
      await this.bot.send(said.chatId, BUSY[language().current]);
      return;
    }

    live.busy = true;
    live.turn += 1;
    const turnId = `chat-${live.turn}`;

    let answer = "";
    let failure: string | null = null;
    live.onChunk = (chunk) => {
      answer += chunk;
    };
    live.onFail = (message) => {
      failure = message;
    };

    // Renewed while the agent works, so a question that takes half a minute
    // does not look like one that was never received.
    const typing = setInterval(() => {
      void this.bot.typing(said.chatId).catch(() => {});
    }, TYPING_MS);
    typing.unref();
    void this.bot.typing(said.chatId).catch(() => {});

    try {
      await live.conversation.handleUtterance(turnId, text);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      clearInterval(typing);
      live.onChunk = () => {};
      live.onFail = () => {};
      live.busy = false;
    }

    const body = failure !== null ? String(failure) : answer.trim() === "" ? NOTHING[language().current] : answer;
    for (const piece of pieces(body)) {
      await this.bot.send(said.chatId, escapeHtml(piece));
    }
  }

  /** Drops every conversation, so a shutdown does not leave an agent running. */
  close(): void {
    for (const live of this.#live.values()) live.conversation.close();
    this.#live.clear();
  }

  #for(chatId: string): Live {
    const existing = this.#live.get(chatId);
    if (existing !== undefined) return existing;

    const live: Live = {
      conversation: null as unknown as Conversation,
      busy: false,
      turn: 0,
      onChunk: () => {},
      onFail: () => {},
    };

    live.conversation = new Conversation(
      {
        onText: (_turnId, chunk) => {
          live.onChunk(chunk);
        },
        // Everything below belongs to a screen and a speaker. A chat has
        // neither, and a turn that reported nothing is a turn that worked.
        onActivity: () => {},
        onToolResult: () => {},
        onDisplay: () => {},
        onVoice: () => {},
        onAudio: () => {},
        onAudioDone: () => {},
        onDone: () => {},
        onError: (_turnId, message) => {
          live.onFail(message);
        },
      },
      undefined,
      "off",
    );

    this.#live.set(chatId, live);
    return live;
  }
}
