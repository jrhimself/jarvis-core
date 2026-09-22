/**
 * Which language JARVIS speaks right now.
 *
 * `JARVIS_SPEECH_LANG` is where a deployment starts. From there it is a switch
 * on the HUD, and the choice belongs to whoever flipped it: it is kept in the
 * deployment's own database, next to everything else the assistant knows about
 * the people it talks to, and survives a restart without anybody editing a
 * file. Nothing about it is written into the repository or the config.
 *
 * The model is told the language at the very top of its instructions rather
 * than by the persona. A persona is written in one language, and so are the
 * memory and the tools' descriptions: a rule about the language of the answer
 * buried in the middle of all that loses to the language of everything around
 * it. First, in plain words, it holds.
 */

import type { SpeechLang } from "@jarvis/shared";

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
