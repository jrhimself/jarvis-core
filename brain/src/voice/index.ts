/**
 * The one place that knows which service is speaking.
 *
 * The conversation asks four things of a voice: is one configured, what to
 * call it in the log, whether there is anything left to spend, and to open one
 * for this turn. Each is answered here by looking at `config.voiceProvider`
 * and nowhere else, so switching services is a line in the env file and not a
 * change to the conversation.
 */

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
import { remainingCharacters, Voice, voiceIdFor } from "./elevenlabs.js";
import { FishVoice, fishCreditsLeft, fishVoiceIdFor } from "./fish.js";
import type { SpeakingVoice, VoiceHandlers } from "./types.js";

export type { Alignment, SpeakingVoice, VoiceHandlers, VoiceProvider } from "./types.js";
export { VOICE_PROVIDERS } from "./types.js";

/** The key the chosen service needs, empty when it has not been given. */
export function voiceKey(config: Config): string {
  return config.voiceProvider === "fish" ? config.fishAudioKey : config.elevenLabsKey;
}

/** Whether anything at all will speak. */
export function voiceConfigured(config: Config): boolean {
  return voiceKey(config) !== "";
}

/** The service's name for the startup record and the log. */
export function voiceProviderName(config: Config): string {
  return config.voiceProvider === "fish" ? "Fish Audio" : "ElevenLabs";
}

/** The env variable whose absence leaves the assistant silent. */
export function voiceKeyVariable(config: Config): string {
  return config.voiceProvider === "fish" ? "FISH_AUDIO_API_KEY" : "ELEVENLABS_API_KEY";
}

/** Which voice reads this language on the chosen service. */
export function voiceFor(config: Config, lang: SpeechLang): string {
  return config.voiceProvider === "fish" ? fishVoiceIdFor(config, lang) : voiceIdFor(config, lang);
}

/**
 * What is left to spend, in the service's own unit, or null when it cannot or
 * need not be known. Zero means the key is missing.
 */
export function voiceCreditsLeft(config: Config): Promise<number | null> {
  return config.voiceProvider === "fish" ? fishCreditsLeft(config) : remainingCharacters(config);
}

/** Opens a voice for this turn on whichever service is configured. */
export function openVoice(config: Config, handlers: VoiceHandlers, lang: SpeechLang): SpeakingVoice {
  return config.voiceProvider === "fish"
    ? new FishVoice(config, handlers, lang)
    : new Voice(config, handlers, lang);
}
