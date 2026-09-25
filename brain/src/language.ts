/**
 * Which language JARVIS speaks right now.
 *
 * `JARVIS_SPEECH_LANG` is where a deployment starts. From there it changes when
 * somebody asks for it in so many words -- "switch to Dutch" -- through the
 * `set_speech_language` tool, and never because a question came in another
 * language. The choice is kept in the
 * deployment's own database, next to everything else the assistant knows about
 * the people it talks to, and survives a restart without anybody editing a
 * file. Nothing about it is written into the repository or the config.
 *
 * The model is told the language twice, and neither is the persona's job. A
 * persona is written in one language, and so are the memory and the tools'
 * descriptions: a rule about the language of the answer buried in the middle
 * of all that loses to the language of everything around it. So the rule opens
 * the system prompt, and a one-line note sits directly in front of every
 * question. Measured on a Dutch persona with a Dutch memory: the system prompt
 * alone still drew Dutch answers to Dutch questions, because the facts primed
 * in front of the question and the question itself are the last thing read.
 * The note is the thing read last.
 */

import type { SpeechLang } from "@jarvis/shared";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

import { loadConfig, SPEECH_LANGS } from "./config.js";
import { memory } from "./memory/store.js";

/** Where the choice is kept in the settings table. */
export const LANGUAGE_SETTING = "speech.lang";

/** What a language is called when the model is told to answer in it. */
const NAMES: Record<SpeechLang, string> = { en: "English", nl: "Dutch" };

/** What the choice is stored in: a key-value table and nothing more. */
export interface SettingStore {
  setting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

type Listener = (lang: SpeechLang) => void;

export function isSpeechLang(value: unknown): value is SpeechLang {
  return typeof value === "string" && (SPEECH_LANGS as readonly string[]).includes(value);
}

/** The current language, where it is kept, and who wants to hear it change. */
export class Language {
  readonly #listeners = new Set<Listener>();

  constructor(
    private readonly store: SettingStore,
    /** The deployment's starting language, for as long as nobody has chosen. */
    private readonly fallback: SpeechLang,
    /** The settings row it lives in: the voice and the screen each have their own. */
    private readonly key: string = LANGUAGE_SETTING,
  ) {}

  /**
   * The language to speak in now.
   *
   * Read from the table every time rather than cached: it is one indexed row,
   * and a cache is one more place for two conversations to disagree about
   * which language they are in.
   */
  get current(): SpeechLang {
    const stored = this.store.setting(this.key);
    return isSpeechLang(stored) ? stored : this.fallback;
  }

  /** Switches, and tells everyone listening. False when nothing changed. */
  set(lang: SpeechLang): boolean {
    if (lang === this.current) return false;
    this.store.setSetting(this.key, lang);
    for (const listener of this.#listeners) listener(lang);
    return true;
  }

  /** Hears every change. Returns the way to stop hearing. */
  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

let shared: Language | null = null;

/** The deployment's language, kept in its own database. */
export function language(): Language {
  if (shared === null) {
    const config = loadConfig();
    shared = new Language(memory(config.memoryPath), config.speechLang);
  }
  return shared;
}

/** Where the screen's language is kept: apart from the voice's, English until asked. */
export const INTERFACE_SETTING = "ui.lang";

/**
 * A screen switch that was offered and not yet answered, as the language it
 * was offered in. The offer is made in the turn that switches the voice, and
 * the answer arrives in the next question -- which opens a fresh session,
 * because a session speaks the language it was opened in. The fresh session
 * would not know what "yes" answers without this.
 */
export const OFFER_SETTING = "ui.offer";

let screen: Language | null = null;

/** The language the screen is drawn in, kept in the same database. */
export function interfaceLanguage(): Language {
  if (screen === null) {
    screen = new Language(memory(loadConfig().memoryPath), "en", INTERFACE_SETTING);
  }
  return screen;
}

/** What a language is called, for a sentence to the model. */
export function languageName(lang: SpeechLang): string {
  return NAMES[lang];
}

/**
 * The line that tells a fresh session what the previous one just asked.
 *
 * Empty unless the offer was made in the language now spoken and the screen
 * is still in another one: an offer that no longer fits is not repeated.
 */
export function offerNote(speech: SpeechLang, screenLang: SpeechLang, offered: string | null): string {
  if (offered !== speech || screenLang === speech) return "";
  const name = NAMES[speech];
  return (
    `[You have just switched to speaking ${name} and asked whether the screen should ` +
    `switch to ${name} as well. If this answers yes, call set_interface_language with ` +
    `"${speech}"; if it answers no, leave the screen as it is.]`
  );
}

/** The offer note for this question, if there is one, and the offer is spent. */
export function takeOffer(speech: SpeechLang, store: SettingStore): string {
  const offered = store.setting(OFFER_SETTING);
  if (offered === null || offered === "") return "";
  store.setSetting(OFFER_SETTING, "");
  return offerNote(speech, interfaceLanguage().current, offered);
}

/**
 * The note that goes directly in front of every question.
 *
 * Never shown and never stored: the turn log keeps what was asked, not what
 * the model was handed.
 */
export function languageNote(lang: SpeechLang): string {
  return `[Answer in ${NAMES[lang]}.]`;
}

/**
 * The paragraph that opens the system prompt.
 *
 * In English whatever the language, because it is an instruction to the model
 * and not something anybody hears. It names the languages the rest of the
 * prompt may be in, so that a persona in Dutch reads as material to work from
 * rather than as the language to answer in. Names are left alone: a room called
 * what the house calls it is found by that name, not by a translation.
 */
export function languageBlock(lang: SpeechLang): string {
  const name = NAMES[lang];
  return [
    `Language: answer in ${name}, every turn, whatever language you are spoken to in.`,
    `These instructions, your memory and your tools may be written in another language;`,
    `that is material to work from, not the language to answer in. Translate what you read`,
    `rather than quoting it. Names of people, rooms, devices and places stay as they are.`,
    `A question asked in another language is not a request to switch: answer it in ${name}.`,
    `Only an explicit request to speak or switch to another language changes it, through`,
    `set_speech_language.`,
  ].join(" ");
}

/**
 * The same note, after every round of tool answers.
 *
 * The note in front of the question holds for a question answered in one
 * breath. A briefing is not: seven tools answer in the language the packs were
 * written in, the model reads all of them after the note, and the thing read
 * last is a page of Dutch. So the note is said again where the last thing read
 * is -- once per batch of tool answers, before the next model request, which
 * is what `PostToolBatch` is for. `additionalContext` is how a hook gets a
 * line in front of the model without touching the tool answers themselves.
 */
export function languageHook(lang: SpeechLang | (() => SpeechLang)): HookCallbackMatcher {
  // Read when the hook fires, not when the session opened: a turn that switched
  // the language through a tool must be told the new one here, or this line --
  // the last thing the model reads -- talks it back into the old one.
  const now = typeof lang === "function" ? lang : () => lang;
  return {
    hooks: [
      async (): Promise<HookJSONOutput> => {
        const current = now();
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolBatch",
            additionalContext:
              `${languageNote(current)} The tool answers above may be in another language; ` +
              `that is material to work from. Everything you say from here is in ${NAMES[current]}.`,
          },
        };
      },
    ],
  };
}
