/**
 * The voice, spoken by Fish Audio.
 *
 * The same shape as the ElevenLabs socket next door: text is pushed in as the
 * model produces it, audio comes back while the rest is still being written.
 * The differences are on the wire. Fish speaks MessagePack rather than JSON,
 * names its messages `event`s, and sends audio as bytes rather than base64 --
 * so it is encoded here, once, and the HUD sees exactly what it always saw.
 *
 * What Fish does not send is per-character timing. The HUD paces the transcript
 * by the audio's length instead, which is a little less exact and looks the
 * same from across a room. A window waiting for a spoken word opens on the
 * estimate.
 *
 * Why it exists at all: the `s2.1-pro-free` model costs nothing and has no
 * character cap, where the free ElevenLabs tier runs out after ten minutes of
 * speech a month. The trade is that the free model promises no latency and may
 * keep what it is sent for training; the paid `s2.1-pro` is the same model with
 * both promises, at a price per byte and no subscription.
 *
 * The API key stays here. Audio is relayed to the browser over our own socket,
 * so the page never holds a credential and never talks to Fish directly.
 */

import { decode, encode } from "@msgpack/msgpack";
import { WebSocket } from "ws";

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
import type { SpeakingVoice, VoiceHandlers } from "./types.js";

/** Raw PCM is trivial to schedule gaplessly in a browser; mp3 chunks are not. */
const OUTPUT_FORMAT = "pcm";
/** What the HUD schedules; the same rate the ElevenLabs voice is asked for. */
const SAMPLE_RATE = 16000;
/**
 * The latency mode is the deployment's: `balanced` speaks a second in,
 * `normal` waits for the sentence and gets its stress right. Measured on the
 * same Dutch sentence: first audio at 1.0 s against 3.2 s, for eight seconds
 * of speech. `config.fishLatency` decides; the default is the prosody.
 */
/** Give up on a silent socket rather than leaving a turn hanging. */
const CONNECT_TIMEOUT_MS = 8000;
/**
 * How much text Fish gathers before it synthesises on its own. Sentence ends
 * are flushed explicitly below, so this only decides where a sentence longer
 * than this is cut -- and a cut inside a sentence is where the melody goes
 * wrong, because Fish is reading a clause without knowing how it ends. Two
 * hundred is Fish's own default and longer than nearly every spoken sentence;
 * the minimum of a hundred was tried and cut them in half. The HUD gives the
 * brain nine seconds from the first word to the first audio, and two hundred
 * characters arrive from the model well inside that.
 */
const CHUNK_LENGTH = 200;
/**
 * The end of a sentence, at the end of what has been sent so far. The answer
 * arrives as the model writes it -- a few words at a time -- and Fish would
 * otherwise wait for a hundred characters of it. ElevenLabs was asked to start
 * on every chunk; Fish is told to start whenever a sentence has closed, which
 * is the point at which the prosody can be got right anyway.
 */
const SENTENCE_END = /[.!?…]["'’”)\]]*\s*$/;
/**
 * Where one piece of text can be cut into sentences: after a sentence mark and
 * its closing quotes, before the next word. The model's deltas rarely hold two
 * sentences; a fixed line -- the wake-up greeting, the sentence for a spent
 * plan -- often does, and under `normal` latency Fish would otherwise
 * synthesise all of it before the first word is heard.
 */
const SENTENCE_BREAK = /(?<=[.!?…]["'’”)\]]*)\s+(?=\S)/;

/**
 * One speaking session over Fish Audio's live socket.
 *
 * The socket is opened when the turn starts, not when the first word exists,
 * so that the HUD can be told early that a voice is coming. Fish's idle policy
 * is not documented, and a turn that fetches for half a minute before its first
 * sentence may find the socket gone by the time it speaks. So a socket that
 * closes before any text has been sent is not a failure: the next `speak`
 * simply opens another one. Only a socket that dies mid-sentence fails the
 * turn, because by then the browser cannot take over without talking over
 * itself.
 */
export class FishVoice implements SpeakingVoice {
  #socket: WebSocket | null = null;
  #open = false;
  #queue: string[] = [];
  #closed = false;
  #failed = false;
  /** Whether any text has gone down the current socket. */
  #spoken = false;
  /** Text sent since the last flush, to see whether a sentence has closed. */
  #pending = "";

  constructor(
    private readonly config: Config,
    private readonly handlers: VoiceHandlers,
    /**
     * Fish detects the language from the text itself; what changes per language
     * is which voice reads it, because a voice cloned from Dutch rarely reads
     * English well, and the other way around.
     */
    private readonly lang: SpeechLang = "nl",
  ) {
    this.#connect();
  }

  get failed(): boolean {
    return this.#failed;
  }

  #connect(): void {
    const socket = new WebSocket(this.config.fishEndpoint, {
      headers: {
        Authorization: `Bearer ${this.config.fishAudioKey}`,
        model: this.config.fishModel,
      },
    });
    this.#socket = socket;
    this.#open = false;
    this.#spoken = false;
    this.#pending = "";

    const timeout = setTimeout(() => {
      if (!this.#open) this.#fail("de stem reageerde niet op tijd");
    }, CONNECT_TIMEOUT_MS);

    socket.on("open", () => {
      clearTimeout(timeout);
      this.#open = true;

      socket.send(encode(startEvent(this.config, this.lang)));

      this.handlers.onOpen();

      for (const text of this.#queue) this.#sendText(text);
      this.#queue = [];
      if (this.#closed) this.#stop();
    });

    socket.on("message", (raw) => {
      const message = readEvent(raw);
      if (message === null) return;

      if (message.event === "audio" && message.audio !== undefined) {
        if (message.audio.byteLength > 0) {
          this.handlers.onAudio(Buffer.from(message.audio).toString("base64"));
        }
        return;
      }

      if (message.event === "finish") {
        if (message.reason === "error") {
          this.#fail("de stem brak af");
        } else {
          this.handlers.onDone();
          this.#socket?.close();
        }
        return;
      }

      // Anything else is a future extension of the protocol, which the
      // documentation asks clients to ignore.
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      this.#fail(error.message);
    });

    socket.on("close", (code) => {
      clearTimeout(timeout);
      if (this.#failed || this.#closed) return;
      if (this.#spoken) {
        this.#fail(`de stem verbrak de verbinding (${code})`);
        return;
      }
      // Nothing said yet: the next sentence opens a fresh socket.
      this.#socket = null;
      this.#open = false;
    });
  }

  #fail(reason: string): void {
    if (this.#failed) return;
    this.#failed = true;
    // A voice that gives up is otherwise only visible in the browser, which
    // quietly falls back to the local one: the answer is still spoken, so
    // nothing looks broken. Say it here, where the logs are.
    console.warn(`voice: giving up -- ${reason}`);
    this.handlers.onError(reason);
    try {
      this.#socket?.close();
    } catch {
      // already gone
    }
  }

  #sendText(text: string): void {
    if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) return;
    this.#spoken = true;
    // One piece per sentence, so each is flushed as it closes and the first is
    // heard while the rest is still being made. The whitespace between them
    // goes with the sentence before it, so nothing is lost on the wire.
    const pieces = text.split(SENTENCE_BREAK);
    for (let index = 0; index < pieces.length; index++) {
      const piece = index < pieces.length - 1 ? `${pieces[index]} ` : pieces[index]!;
      if (piece === "") continue;
      this.#socket.send(encode({ event: "text", text: piece }));
      this.#pending += piece;
      if (SENTENCE_END.test(this.#pending)) {
        this.#socket.send(encode({ event: "flush" }));
        this.#pending = "";
      }
    }
  }

  #stop(): void {
    if (this.#socket === null || this.#socket.readyState !== WebSocket.OPEN) return;
    if (!this.#spoken) {
      // Nothing was ever said. Fish would answer a bare stop with a finish, but
      // an empty turn spoken by nobody is done the moment it is closed.
      this.#socket.close();
      this.handlers.onDone();
      return;
    }
    this.#socket.send(encode({ event: "stop" }));
  }

  speak(text: string): void {
    if (this.#failed || this.#closed || text === "") return;
    if (this.#socket === null) this.#connect();
    if (this.#open) this.#sendText(text);
    else this.#queue.push(text);
  }

  finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket === null) {
      // The socket went idle and nothing more is coming: there is no turn to
      // finish, and no audio the HUD should wait for.
      this.handlers.onDone();
      return;
    }
    if (this.#open) this.#stop();
  }

  abort(): void {
    this.#closed = true;
    this.#failed = true;
    try {
      this.#socket?.close();
    } catch {
      // already gone
    }
  }
}

/** Which Fish voice reads this language; English gets its own when one is set. */
export function fishVoiceIdFor(config: Config, lang: SpeechLang): string {
  return lang === "en" && config.fishVoiceIdEn !== "" ? config.fishVoiceIdEn : config.fishVoiceId;
}

/**
 * The first message on the socket: the whole configuration, no text.
 *
 * Exported for the tests, which run a socket of their own and read what arrives.
 */
export function startEvent(config: Config, lang: SpeechLang): Record<string, unknown> {
  const voice = fishVoiceIdFor(config, lang);
  return {
    event: "start",
    request: {
      text: "",
      // An empty reference falls back to Fish's own default voice, which is how
      // a deployment tries the service before choosing a voice for it.
      ...(voice === "" ? {} : { reference_id: voice }),
      format: OUTPUT_FORMAT,
      sample_rate: SAMPLE_RATE,
      latency: config.fishLatency,
      chunk_length: CHUNK_LENGTH,
      // Numbers and times written out before they are read: "21,4" and
      // "14:30" are on every briefing, and read as digits they are where the
      // stress lands wrong first.
      normalize: config.fishNormalize,
      prosody: { speed: config.voiceSpeed },
    },
  };
}

interface FishEvent {
  event: string;
  audio?: Uint8Array;
  reason?: string;
}

/** One frame from the server, or null for anything that is not a MessagePack map. */
export function readEvent(raw: unknown): FishEvent | null {
  let decoded: unknown;
  try {
    decoded = decode(toBytes(raw));
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;

  const record = decoded as Record<string, unknown>;
  const event = record["event"];
  if (typeof event !== "string") return null;

  const audio = record["audio"];
  const reason = record["reason"];
  return {
    event,
    ...(audio instanceof Uint8Array ? { audio } : {}),
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

function toBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw as Buffer[]);
  throw new TypeError("not a binary frame");
}

/**
 * Fish's credit balance, or null when it cannot or need not be established.
 *
 * The free model is not metered, so a deployment on it has nothing to run out
 * of and the question is not asked. On the paid model the balance is in
 * dollars, not characters; it is reported as such in the log and treated as
 * "some" or "none" by the caller.
 */
export async function fishCreditsLeft(config: Config): Promise<number | null> {
  if (config.fishAudioKey === "") return 0;
  if (config.fishModel.endsWith("-free")) return null;
  try {
    const response = await fetch("https://api.fish.audio/wallet/self/api-credit", {
      headers: { Authorization: `Bearer ${config.fishAudioKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as { credit?: unknown };
    const credit = Number(body.credit);
    return Number.isFinite(credit) ? Math.max(0, credit) : null;
  } catch {
    return null;
  }
}
