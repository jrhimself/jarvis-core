/**
 * What a voice is, whoever is speaking.
 *
 * Two services synthesise speech for the brain -- ElevenLabs and Fish Audio --
 * and the conversation must not care which. It feeds text in as it is written,
 * receives audio while the rest is still being thought, and is told when the
 * turn has been spoken or why it will not be. That contract is here; the two
 * sockets that honour it are next door.
 */

export interface Alignment {
  chars: string[];
  startMs: number[];
  durMs: number[];
}

export interface VoiceHandlers {
  /**
   * The voice is connected and will speak this turn.
   *
   * Separate from the first chunk because the browser has to decide whether to
   * read the answer itself long before any audio exists, and audio lags the
   * text it is made from -- about a second warm, several on a cold session.
   */
  onOpen: () => void;
  /**
   * A chunk of audio, base64 PCM at 16 kHz, with per-character timings when the
   * voice sends them. Not every voice does; the HUD paces the transcript by the
   * audio's own length when they are missing.
   */
  onAudio: (data: string, alignment?: Alignment) => void;
  /** Everything for this turn has been spoken. */
  onDone: () => void;
  /** The voice failed; the caller should fall back to the browser. */
  onError: (reason: string) => void;
}

/** One speaking session. Text goes in as it is written, audio comes out. */
export interface SpeakingVoice {
  readonly failed: boolean;
  /** Feeds the next piece of the answer. Safe to call before the socket is up. */
  speak(text: string): void;
  /** No more text is coming. */
  finish(): void;
  /** Stop now -- the turn was cancelled. */
  abort(): void;
}

/** Which service speaks. */
export type VoiceProvider = "elevenlabs" | "fish";

export const VOICE_PROVIDERS: readonly VoiceProvider[] = ["elevenlabs", "fish"];
