/**
 * The one place that knows which service is speaking.
 *
 * The conversation asks five things of a voice: is one configured, what to
 * call it in the log, whether there is anything left to spend, which voices it
 * can read with, and to open one for this turn. Each is answered here by
 * looking at `config.voiceProvider` and nowhere else, so switching services is
 * a line in the env file and not a change to the conversation.
 */

import { existsSync } from "node:fs";

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
import { elevenLabsVoices, piperVoices, type VoiceOption } from "./catalogue.js";
import { remainingCharacters, Voice, voiceIdFor } from "./elevenlabs.js";
import { FishVoice, fishCreditsLeft, fishVoiceIdFor } from "./fish.js";
import { PiperVoice, piperVoiceIdFor } from "./piper.js";
import { Listener, type ListenerHandlers } from "./scribe.js";
import { WhisperListener } from "./whisper.js";
import type { Listening, SpeakingVoice, VoiceHandlers } from "./types.js";

export type { Alignment, Listening, SpeakingVoice, VoiceHandlers, VoiceProvider } from "./types.js";
export type { RemoteVoice, VoiceOption } from "./catalogue.js";
export { VOICE_PROVIDERS } from "./types.js";

/**
 * The key the chosen service needs, empty when it has not been given. Piper has
 * no key; what it needs is its voices, so the directory stands in for one.
 */
export function voiceKey(config: Config): string {
  if (config.voiceProvider === "piper") return existsSync(config.piperModels) ? config.piperModels : "";
  return config.voiceProvider === "fish" ? config.fishAudioKey : config.elevenLabsKey;
}

/** Whether anything at all will speak. */
export function voiceConfigured(config: Config): boolean {
  return voiceKey(config) !== "";
}

/** The service's name for the startup record and the log. */
export function voiceProviderName(config: Config): string {
  if (config.voiceProvider === "piper") return "Piper (local)";
  return config.voiceProvider === "fish" ? "Fish Audio" : "ElevenLabs";
}

/** The env variable whose absence leaves the assistant silent. */
export function voiceKeyVariable(config: Config): string {
  if (config.voiceProvider === "piper") return "JARVIS_PIPER_MODELS";
  return config.voiceProvider === "fish" ? "FISH_AUDIO_API_KEY" : "ELEVENLABS_API_KEY";
}

/**
 * Which voice reads this language on the chosen service, as the deployment was
 * configured. What is actually spoken with may have been asked for since:
 * `VoiceChoice` in `choice.ts` is the one that knows, and falls back to this.
 */
export function defaultVoiceFor(config: Config, lang: SpeechLang): string {
  if (config.voiceProvider === "piper") return piperVoiceIdFor(config, lang);
  return config.voiceProvider === "fish" ? fishVoiceIdFor(config, lang) : voiceIdFor(config, lang);
}

/**
 * Every voice the chosen service can read with, or null when it has no list to
 * ask for -- a Fish voice is a model id from a dashboard and nothing here can
 * enumerate it.
 */
export function voiceCatalogue(config: Config): Promise<VoiceOption[] | null> {
  if (config.voiceProvider === "piper") return piperVoices(config);
  return config.voiceProvider === "elevenlabs" ? elevenLabsVoices(config) : Promise.resolve(null);
}

/**
 * Whether a voice this deployment does not have can be fetched. Only the local
 * voices can: the published Piper collection is a directory of files, where a
 * cloud service's voices belong to an account.
 */
export function voicesCanBeFetched(config: Config): boolean {
  return config.voiceProvider === "piper" && config.piperVoicesUrl !== "";
}

/**
 * What is left to spend, in the service's own unit, or null when it cannot or
 * need not be known. Zero means the key is missing.
 */
export function voiceCreditsLeft(config: Config): Promise<number | null> {
  if (config.voiceProvider === "piper") return Promise.resolve(null);
  return config.voiceProvider === "fish" ? fishCreditsLeft(config) : remainingCharacters(config);
}

/**
 * Opens a voice for this turn on whichever service is configured, reading with
 * the voice it is given -- the deployment's own unless one was asked for.
 */
export function openVoice(
  config: Config,
  handlers: VoiceHandlers,
  lang: SpeechLang,
  voice: string = defaultVoiceFor(config, lang),
): SpeakingVoice {
  if (config.voiceProvider === "piper") return new PiperVoice(config, handlers, lang, voice);
  return config.voiceProvider === "fish"
    ? new FishVoice(config, handlers, lang, voice)
    : new Voice(config, handlers, lang, voice);
}

/** Whether anything at all will listen. Whisper has no key; it needs only to be named. */
export function listenConfigured(config: Config): boolean {
  return config.listenProvider === "whisper" || config.elevenLabsKey !== "";
}

/** Why nothing listens, for the browser to show. */
export function listenUnavailableReason(): string {
  return "de transcriptie is niet ingesteld";
}

/** Opens one listening session on whichever service is configured. */
export function openListener(config: Config, handlers: ListenerHandlers, lang: SpeechLang): Listening {
  return config.listenProvider === "whisper"
    ? new WhisperListener(config, handlers, lang)
    : new Listener(config, handlers, lang);
}
