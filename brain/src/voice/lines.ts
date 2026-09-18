/**
 * Fixed lines, recorded once and played from disk.
 *
 * The line that fills a silence exists to be heard quickly, and it was being
 * synthesised on the spot: the voice's socket took it, made it, sent it back
 * -- a second at best, three under the latency mode that gets Dutch stress
 * right -- and the first sentence of the answer then queued behind it. A line
 * that never changes has no business being made twice.
 *
 * So the lines a deployment configures are spoken once by the configured
 * voice, on the same socket the conversation uses, and kept as raw PCM under
 * the data directory, keyed on everything that changes the sound: provider,
 * model, voice, speed, language, and the words. Change any of it and the line
 * is recorded again on the next start; the old file is left, being small and
 * honest about what it is.
 *
 * Nothing here is spoken by the model, so nothing here is ever wrong about the
 * world; the worst a stale file can be is a voice the house no longer uses,
 * and the key rules that out.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
import { openVoice, voiceConfigured, voiceFor, voiceProviderName } from "./index.js";

/** Longest a single line may take to come back before it is given up on. */
const RECORD_TIMEOUT_MS = 20_000;

/** Everything that changes how a line sounds, in one string. */
export function lineKey(config: Config, text: string, lang: SpeechLang): string {
  const model = config.voiceProvider === "fish" ? config.fishModel : "";
  const facts = [config.voiceProvider, model, voiceFor(config, lang), config.voiceSpeed, lang, text];
  return createHash("sha1").update(JSON.stringify(facts)).digest("hex");
}

/**
 * Speaks one line through the configured voice and returns the audio, or null
 * when the voice would not or could not.
 */
export function recordLine(config: Config, text: string, lang: SpeechLang): Promise<Buffer | null> {
  if (!voiceConfigured(config)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (result: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      voice.abort();
      settle(null);
    }, RECORD_TIMEOUT_MS);
    const voice = openVoice(
      config,
      {
        onOpen: () => {},
        onAudio: (data) => chunks.push(Buffer.from(data, "base64")),
        onDone: () => settle(chunks.length === 0 ? null : Buffer.concat(chunks)),
        onError: () => settle(null),
      },
      lang,
    );
    voice.speak(text);
    voice.finish();
  });
}

/** The recorded lines of one deployment: what is on disk, and what is not yet. */
export class RecordedLines {
  readonly #dir: string;
  readonly #clips = new Map<string, Buffer>();

  constructor(
    private readonly config: Config,
    dir: string,
  ) {
    this.#dir = dir;
    try {
      mkdirSync(dir, { recursive: true });
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".pcm")) continue;
        this.#clips.set(name.slice(0, -4), readFileSync(join(dir, name)));
      }
    } catch (error) {
      console.warn(`voice: no recorded lines -- ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** How many lines are on hand. */
  get size(): number {
    return this.#clips.size;
  }

  /** The recording of this line in this voice, or null when there is none. */
  get(text: string, lang: SpeechLang): Buffer | null {
    return this.#clips.get(lineKey(this.config, text, lang)) ?? null;
  }

  /**
   * Records whatever of these lines is not on disk yet, one at a time so the
   * voice's socket is not asked for five things at once. Returns how many were
   * made. Never throws: a line that could not be recorded is simply spoken
   * live, as it was before.
   */
  async warm(lines: readonly string[], lang: SpeechLang): Promise<number> {
    let made = 0;
    for (const text of lines) {
      if (text === "" || this.get(text, lang) !== null) continue;
      const clip = await recordLine(this.config, text, lang);
      if (clip === null) {
        console.warn(`voice: could not record "${text}"`);
        continue;
      }
      const key = lineKey(this.config, text, lang);
      try {
        writeFileSync(join(this.#dir, `${key}.pcm`), clip);
      } catch (error) {
        console.warn(`voice: could not keep "${text}" -- ${error instanceof Error ? error.message : String(error)}`);
      }
      this.#clips.set(key, clip);
      made += 1;
    }
    if (made > 0) console.log(`voice: recorded ${made} line(s) with ${voiceProviderName(this.config)}`);
    return made;
  }
}
