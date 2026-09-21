/**
 * Listening, by ElevenLabs Scribe.
 *
 * The browser's own recogniser closes a phrase the moment you draw breath and
 * hands back Dutch of middling quality. This streams the microphone to a model
 * built for it: partial text while you speak, settled text when you stop.
 *
 * Commits are manual. Their voice-activity mode returns nothing on this tier —
 * the socket simply closes without a word — so the end of a sentence is decided
 * here, by the same silence timer the browser path already uses.
 */

import { WebSocket } from "ws";

import type { Config } from "../config.js";

const MODEL_ID = "scribe_v2_realtime";
/** Matches what the HUD captures. */
const AUDIO_FORMAT = "pcm_16000";
const SAMPLE_RATE = 16000;
/** Give up on a socket that never opens rather than swallowing the microphone. */
const CONNECT_TIMEOUT_MS = 6000;

export interface ListenerHandlers {
  /** Text so far, still being revised. */
  onPartial: (text: string) => void;
  /** A settled sentence. */
  onFinal: (text: string) => void;
  /** Listening failed; the caller should fall back to the browser. */
  onError: (reason: string) => void;
}

export class Listener {
  #socket: WebSocket | null = null;
  #open = false;
  #closed = false;
  #failed = false;
  /** Audio recorded before the socket was ready; a second of speech at most. */
  #queue: string[] = [];

  constructor(
    private readonly config: Config,
    private readonly handlers: ListenerHandlers,
  ) {
    this.#connect();
  }

  #connect(): void {
    const url =
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime" +
      `?model_id=${MODEL_ID}&language_code=${this.config.speechLang}&audio_format=${AUDIO_FORMAT}` +
      "&commit_strategy=manual&filter_background_audio=true";

    const socket = new WebSocket(url, {
      headers: { "xi-api-key": this.config.elevenLabsKey },
    });
    this.#socket = socket;

    const timeout = setTimeout(() => {
      if (!this.#open) this.#fail("de transcriptie reageerde niet op tijd");
    }, CONNECT_TIMEOUT_MS);

    socket.on("open", () => {
      clearTimeout(timeout);
      this.#open = true;
      for (const chunk of this.#queue) this.#sendChunk(chunk);
      this.#queue = [];
    });

    socket.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = message["message_type"];
      const text = message["text"];
      if (typeof text !== "string") {
        if (type === "rate_limited") this.#fail("de transcriptie is tijdelijk geblokkeerd");
        return;
      }

      if (type === "partial_transcript") {
        if (text.trim() !== "") this.handlers.onPartial(text);
        return;
      }
      // Final and committed both mean settled; which one arrives depends on the
      // commit strategy, and we care about the text either way.
      if (type === "final_transcript" || type === "committed_transcript") {
        if (text.trim() !== "") this.handlers.onFinal(text);
        // Nothing more is coming for this stretch of speech.
        if (type === "committed_transcript") this.close();
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      this.#fail(error.message);
    });

    socket.on("close", (code) => {
      clearTimeout(timeout);
      if (!this.#failed && !this.#closed && code !== 1000) {
        this.#fail(`de transcriptie verbrak de verbinding (${code})`);
      }
    });
  }

  #fail(reason: string): void {
    if (this.#failed) return;
    this.#failed = true;
    this.handlers.onError(reason);
    this.close();
  }

  #sendChunk(base64: string, commit = false): void {
    if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#socket.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: base64,
        sample_rate: SAMPLE_RATE,
        ...(commit ? { commit: true } : {}),
      }),
    );
  }

  /**
   * Asks for what has been heard so far. The settled text comes back as a
   * committed transcript, which is the only kind this mode produces.
   */
  commit(): void {
    if (this.#failed || this.#closed) return;
    if (this.#open) this.#sendChunk("", true);
  }

  /** Feeds a chunk of microphone audio, base64 PCM at 16 kHz. */
  push(base64: string): void {
    if (this.#failed || this.#closed || base64 === "") return;
    if (this.#open) this.#sendChunk(base64);
    // Cap the backlog: audio that predates the socket by more than a second is
    // not worth transcribing by the time it arrives.
    else if (this.#queue.length < 10) this.#queue.push(base64);
  }

  close(): void {
    this.#closed = true;
    try {
      this.#socket?.close();
    } catch {
      // already gone
    }
    this.#socket = null;
  }
}
