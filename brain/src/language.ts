/**
 * Which language JARVIS speaks right now.
 *
 * `JARVIS_SPEECH_LANG` is where a deployment starts. From there it is a switch
 * on the HUD, and the choice belongs to whoever flipped it: it is kept in the
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
  ) {}

  /**
   * The language to speak in now.
   *
   * Read from the table every time rather than cached: it is one indexed row,
   * and a cache is one more place for two conversations to disagree about
   * which language they are in.
   */
  get current(): SpeechLang {
    const stored = this.store.setting(LANGUAGE_SETTING);
    return isSpeechLang(stored) ? stored : this.fallback;
  }

  /** Switches, and tells everyone listening. False when nothing changed. */
  set(lang: SpeechLang): boolean {
    if (lang === this.current) return false;
    this.store.setSetting(LANGUAGE_SETTING, lang);
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
    `The language is switched with the language button on the screen; if you are asked to`,
    `speak another one, say so in ${name}.`,
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
export function languageHook(lang: SpeechLang): HookCallbackMatcher {
  const output: HookJSONOutput = {
    hookSpecificOutput: {
      hookEventName: "PostToolBatch",
      additionalContext:
        `${languageNote(lang)} The tool answers above may be in another language; ` +
        `that is material to work from. Everything you say from here is in ${NAMES[lang]}.`,
    },
  };
  return { hooks: [async () => output] };
}
