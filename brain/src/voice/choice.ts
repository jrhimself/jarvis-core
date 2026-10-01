/**
 * Which voice JARVIS speaks with, when somebody has asked for one.
 *
 * The env file is where a deployment starts: one voice per language per
 * service. From there it changes the way the language does -- by being asked
 * for, in so many words, through `set_voice` -- and the answer is kept in the
 * deployment's own database next to everything else it knows, so it survives a
 * restart without anybody editing a file or deploying a tag.
 *
 * Kept per service as well as per language, because an id means nothing on
 * another service. A deployment that switches from Piper back to ElevenLabs
 * finds ElevenLabs' own voice waiting rather than the name of a file on disk.
 */

import type { SpeechLang } from "@jarvis/shared";

import { loadConfig, type Config } from "../config.js";
import type { SettingStore } from "../language.js";
import { memory } from "../memory/store.js";
import { defaultVoiceFor } from "./index.js";
import type { VoiceProvider } from "./types.js";

/** The word that means "whatever the env file says", in place of an id. */
export const DEFAULT_VOICE = "default";

/** Where a choice is kept: one row per service and language. */
export function voiceSetting(provider: VoiceProvider, lang: SpeechLang): string {
  return `voice.${provider}.${lang}`;
}

/** Told which language now reads with another voice. */
type Listener = (lang: SpeechLang) => void;

/** The voice to read each language with, and how it is changed. */
export class VoiceChoice {
  readonly #listeners = new Set<Listener>();

  constructor(
    private readonly store: SettingStore,
    private readonly config: Config,
  ) {}

  /**
   * The voice this language is read in: what was asked for, or the
   * deployment's own. Read from the table every time, like the language: it is
   * one indexed row, and a cache is one more place for two turns to disagree.
   */
  for(lang: SpeechLang): string {
    return this.chosen(lang) ?? defaultVoiceFor(this.config, lang);
  }

  /** What was asked for, or null while nobody has asked. */
  chosen(lang: SpeechLang): string | null {
    const stored = this.store.setting(voiceSetting(this.config.voiceProvider, lang));
    return stored === null || stored === "" ? null : stored;
  }

  /** Reads this language with that voice from now on. False when it already did. */
  set(lang: SpeechLang, id: string): boolean {
    if (this.for(lang) === id && this.chosen(lang) !== null) return false;
    this.store.setSetting(voiceSetting(this.config.voiceProvider, lang), id);
    for (const listener of this.#listeners) listener(lang);
    return true;
  }

  /** Back to the deployment's own voice. False when nothing was chosen. */
  clear(lang: SpeechLang): boolean {
    if (this.chosen(lang) === null) return false;
    this.store.setSetting(voiceSetting(this.config.voiceProvider, lang), "");
    for (const listener of this.#listeners) listener(lang);
    return true;
  }

  /**
   * Hears every change. Returns the way to stop hearing.
   *
   * What listens is the recording of the fixed lines: they are kept per voice,
   * so a switch leaves none on disk for the new one and the next silence would
   * otherwise be filled by a line synthesised on the spot.
   */
  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

let shared: VoiceChoice | null = null;

/** The deployment's chosen voices, kept in its own database. */
export function voiceChoice(): VoiceChoice {
  if (shared === null) {
    const config = loadConfig();
    shared = new VoiceChoice(memory(config.memoryPath), config);
  }
  return shared;
}
