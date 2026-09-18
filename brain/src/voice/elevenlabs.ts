/**
 * The voice, spoken by ElevenLabs.
 *
 * The connection is a websocket rather than a series of requests because the
 * answer arrives sentence by sentence: text is pushed in as the model produces
 * it, and audio comes back while the rest is still being written. That is the
 * difference between speech starting after two seconds and after five.
 *
 * The API key stays here. Audio is relayed to the browser over our own socket,
 * so the page never holds a credential and never talks to ElevenLabs directly.
 */

import { WebSocket } from "ws";

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
import type { Alignment, SpeakingVoice, VoiceHandlers } from "./types.js";

export type { Alignment, VoiceHandlers } from "./types.js";

/** Fastest model; ~75ms inference, Dutch among its languages. */
const MODEL_ID = "eleven_flash_v2_5";
/** Raw PCM is trivial to schedule gaplessly in a browser; mp3 chunks are not. */
const OUTPUT_FORMAT = "pcm_16000";
/** Give up on a silent socket rather than leaving a turn hanging. */
const CONNECT_TIMEOUT_MS = 8000;
/**
 * How often to nudge a connected voice that has nothing to say yet.
 *
 * ElevenLabs closes an idle stream with `input_timeout_exceeded` after twenty
 * seconds, and the socket is opened when the turn starts rather than when the
 * first word exists -- a question that needs a tool call, or a session that has
 * to warm up first, spends longer than that thinking. A space is not speech: it
 * keeps the stream open, costs no credit and produces no audio.
 */
const KEEPALIVE_MS = 10000;

/**
 * One speaking session. Text goes in as it is written, audio comes out.
 */
export class Voice implements SpeakingVoice {
  #socket: WebSocket | null = null;
  #open = false;
  #queue: string[] = [];
  #closed = false;
  #failed = false;
  #keepalive: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: Config,
    private readonly handlers: VoiceHandlers,
    /**
     * One socket pronounces one language: the code is fixed when the stream
     * opens. An English line therefore has to be its own turn, never a fragment
     * glued into a Dutch sentence.
     */
    private readonly lang: SpeechLang = "nl",
  ) {
    this.#connect();
  }

  get failed(): boolean {
    return this.#failed;
  }

  #connect(): void {
    const url =
      `wss://api.elevenlabs.io/v1/text-to-speech/${voiceIdFor(this.config, this.lang)}/stream-input` +
      `?model_id=${MODEL_ID}&output_format=${OUTPUT_FORMAT}&language_code=${this.lang}`;

    const socket = new WebSocket(url, {
      headers: { "xi-api-key": this.config.elevenLabsKey },
    });
    this.#socket = socket;

    const timeout = setTimeout(() => {
      if (!this.#open) this.#fail("de stem reageerde niet op tijd");
    }, CONNECT_TIMEOUT_MS);

    socket.on("open", () => {
      clearTimeout(timeout);
      this.#open = true;

      // The opening message sets up the voice; a single space is the documented
      // way to start a stream without speaking anything yet.
      socket.send(
        JSON.stringify({
          text: " ",
          voice_settings: {
            stability: this.config.voiceStability,
            similarity_boost: this.config.voiceSimilarity,
            speed: this.config.voiceSpeed,
          },
          generation_config: {
            // Start generating after a short phrase rather than waiting for a full
            // buffer: latency matters more here than perfectly even prosody.
            chunk_length_schedule: [80, 160, 250, 290],
          },
        }),
      );

      this.handlers.onOpen();
      this.#startKeepalive();

      for (const text of this.#queue) this.#send(text);
      this.#queue = [];
      if (this.#closed) this.#send("");
    });

    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      const audio = message["audio"];
      if (typeof audio === "string" && audio !== "") {
        this.handlers.onAudio(audio, normaliseAlignment(message["normalizedAlignment"] ?? message["alignment"]));
      }

      if (message["isFinal"] === true) {
        this.handlers.onDone();
        this.#socket?.close();
      }

      const error = message["error"];
      if (typeof error === "string") this.#fail(error);
      // Credit exhaustion arrives as a normal message, not a socket error.
      if (message["code"] === "quota_exceeded") this.#fail("de credits van de stem zijn op");
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      this.#fail(error.message);
    });

    socket.on("close", (code) => {
      clearTimeout(timeout);
      if (!this.#failed && code !== 1000 && !this.#closed) {
        this.#fail(`de stem verbrak de verbinding (${code})`);
      }
    });
  }

  #startKeepalive(): void {
    if (this.#keepalive !== null) return;
    this.#keepalive = setInterval(() => {
      if (this.#closed || this.#failed) {
        this.#stopKeepalive();
        return;
      }
      this.#send(" ");
    }, KEEPALIVE_MS);
    // Nothing here should hold the process open on its own.
    this.#keepalive.unref?.();
  }

  #stopKeepalive(): void {
    if (this.#keepalive === null) return;
    clearInterval(this.#keepalive);
    this.#keepalive = null;
  }

  #fail(reason: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#stopKeepalive();
    // A voice that gives up is otherwise only visible in the browser, which
    // quietly falls back to the local one: the answer is still spoken, so
    // nothing looks broken while every turn is costing credit for audio nobody
    // hears. Say it here, where the logs are.
    console.warn(`voice: giving up -- ${reason}`);
    this.handlers.onError(reason);
    try {
      this.#socket?.close();
    } catch {
      // already gone
    }
  }

  #send(text: string): void {
    if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(JSON.stringify(text === "" ? { text: "" } : { text, try_trigger_generation: true }));
  }

  /** Feeds the next piece of the answer. Safe to call before the socket is up. */
  speak(text: string): void {
    if (this.#failed || this.#closed || text === "") return;
    if (this.#open) this.#send(text);
    else this.#queue.push(text);
  }

  /** No more text is coming. */
  finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopKeepalive();
    if (this.#open) this.#send("");
  }

  /** Stop now — the turn was cancelled. */
  abort(): void {
    this.#closed = true;
    this.#failed = true;
    this.#stopKeepalive();
    try {
      this.#socket?.close();
    } catch {
      // already gone
    }
  }
}

/** Which voice speaks this language; English gets its own when one is set. */
export function voiceIdFor(config: Config, lang: SpeechLang): string {
  return lang === "en" && config.voiceIdEn !== "" ? config.voiceIdEn : config.voiceId;
}

function normaliseAlignment(value: unknown): Alignment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;

  const chars = raw["chars"];
  const starts = raw["charStartTimesMs"];
  const durations = raw["charDurationsMs"];

  if (!Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(durations)) return undefined;
  if (chars.length === 0) return undefined;

  return {
    chars: chars.map(String),
    startMs: starts.map(Number),
    durMs: durations.map(Number),
  };
}

/**
 * Characters left this billing period, or null when it cannot be established.
 * Used to decide whether to bother trying at all.
 */
export async function remainingCharacters(config: Config): Promise<number | null> {
  if (config.elevenLabsKey === "") return 0;
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": config.elevenLabsKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { character_count?: number; character_limit?: number };
    if (typeof body.character_count !== "number" || typeof body.character_limit !== "number") {
      return null;
    }
    return Math.max(0, body.character_limit - body.character_count);
  } catch {
    return null;
  }
}
