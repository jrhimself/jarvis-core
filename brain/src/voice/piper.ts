/**
 * The voice, spoken by Piper on this machine.
 *
 * No service, no key, no balance: a small Python process holds the model in
 * memory and turns sentences into audio faster than they can be spoken, on a
 * CPU with no help. It exists because every other voice here is somebody
 * else's account -- the free ElevenLabs tier ends after ten minutes of speech
 * a month, and the assistant is then mute until it renews.
 *
 * The shape is the same as the socket voices next door: text is pushed in as
 * the model writes it, audio comes back while the rest is still being
 * written. What differs is granularity. Piper does not stream within a
 * sentence, so the text is cut into sentences and each is synthesised as it
 * closes; the first is heard while the model is still writing the second.
 *
 * There is one Python process for the whole brain, not one per turn: loading a
 * voice takes longer than saying a sentence with it. See `pipe.ts` for how it
 * is run and `piper/server.py` for what it does with a sentence.
 *
 * Piper sends no per-character timing. The HUD paces the transcript by the
 * audio's length instead, as it does for Fish.
 */

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
import { Pipe } from "./pipe.js";
import type { SpeakingVoice, VoiceHandlers } from "./types.js";

/** Longest the process may take to load its voices before it is given up on. */
const READY_TIMEOUT_MS = 30_000;
/** Longest a single sentence may take; a hung process must not hold a turn. */
const SENTENCE_TIMEOUT_MS = 20_000;
/**
 * Where one piece of text can be cut into sentences: after a sentence mark and
 * its closing quotes, before the next word. The whitespace is required, so
 * "21." at the end of one delta is not cut from the "4" that opens the next.
 */
const SENTENCE_BREAK = /(?<=[.!?…]["'’”)\]]*)\s+(?=\S)/;

let pipe: Pipe | null = null;
let pipeKey = "";

function pipeFor(config: Config): Pipe {
  const key = JSON.stringify([config.piperPython, config.piperServer, config.piperModels]);
  if (pipe === null || pipeKey !== key) {
    pipe?.stop();
    const voices = [config.piperVoice, config.piperVoiceEn].filter(
      (voice, index, all) => voice !== "" && all.indexOf(voice) === index,
    );
    pipe = new Pipe({
      command: config.piperPython,
      args: [config.piperServer, config.piperModels, ...voices],
      label: "voice: piper",
      readyTimeoutMs: READY_TIMEOUT_MS,
      jobTimeoutMs: SENTENCE_TIMEOUT_MS,
    });
    pipeKey = key;
  }
  return pipe;
}

/** Starts the process and loads the voices now, so the first turn does not wait for them. */
export function warmPiper(config: Config): void {
  pipeFor(config)
    .ready()
    .catch((error: unknown) => {
      console.warn(`voice: piper would not start -- ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** Stops the shared process; the next voice starts a fresh one. For tests and shutdown. */
export function stopPiper(): void {
  pipe?.stop();
  pipe = null;
  pipeKey = "";
}

/**
 * One speaking session on the local voice.
 *
 * `onOpen` is told when the process is ready, the same promise the socket
 * voices make: a voice is coming, well before any audio exists. Text that
 * arrives before that waits for it.
 */
export class PiperVoice implements SpeakingVoice {
  #open = false;
  #closed = false;
  #failed = false;
  #done = false;
  /** Text received that has not yet closed a sentence. */
  #pending = "";
  /** Sentences that closed before the process was ready. */
  #waiting: string[] = [];
  /** Sentences sent and not yet finished. */
  #outstanding = 0;
  #jobs: Array<{ cancel: () => void }> = [];

  constructor(
    private readonly config: Config,
    private readonly handlers: VoiceHandlers,
    private readonly lang: SpeechLang = "nl",
  ) {
    pipeFor(config)
      .ready()
      .then(() => {
        if (this.#failed || this.#done) return;
        this.#open = true;
        this.handlers.onOpen();
        for (const sentence of this.#waiting) this.#send(sentence);
        this.#waiting = [];
        this.#maybeDone();
      })
      .catch((error: unknown) => this.#fail(error instanceof Error ? error.message : String(error)));
  }

  get failed(): boolean {
    return this.#failed;
  }

  #fail(reason: string): void {
    if (this.#failed) return;
    this.#failed = true;
    // Only visible in the browser otherwise, which quietly reads the answer
    // itself: nothing looks broken, and the logs would never say why.
    console.warn(`voice: giving up -- ${reason}`);
    for (const job of this.#jobs) job.cancel();
    this.handlers.onError(reason);
  }

  #send(sentence: string): void {
    this.#outstanding++;
    this.#jobs.push(
      pipeFor(this.config).request(
        { voice: piperVoiceIdFor(this.config, this.lang), text: sentence, speed: this.config.voiceSpeed },
        {
          onData: (pcm) => {
            if (!this.#failed) this.handlers.onAudio(pcm.toString("base64"));
          },
          onDone: () => {
            this.#outstanding--;
            this.#maybeDone();
          },
          onError: (reason) => this.#fail(reason),
        },
      ),
    );
  }

  #enqueue(sentence: string): void {
    if (sentence.trim() === "") return;
    if (this.#open) this.#send(sentence);
    else this.#waiting.push(sentence);
  }

  #maybeDone(): void {
    if (this.#done || this.#failed || !this.#closed || !this.#open) return;
    if (this.#outstanding > 0 || this.#waiting.length > 0) return;
    this.#done = true;
    this.handlers.onDone();
  }

  speak(text: string): void {
    if (this.#failed || this.#closed || text === "") return;
    const pieces = (this.#pending + text).split(SENTENCE_BREAK);
    // Everything but the last piece is followed by more text, so it is closed.
    this.#pending = pieces.pop() ?? "";
    for (const piece of pieces) this.#enqueue(piece);
  }

  finish(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#enqueue(this.#pending);
    this.#pending = "";
    // A turn that never said anything has nothing to wait for, ready or not.
    if (this.#outstanding === 0 && this.#waiting.length === 0 && !this.#failed && !this.#done) {
      this.#done = true;
      this.handlers.onDone();
      return;
    }
    this.#maybeDone();
  }

  abort(): void {
    this.#closed = true;
    this.#failed = true;
    for (const job of this.#jobs) job.cancel();
  }
}

/** Which Piper voice reads this language; each falls back to the other's. */
export function piperVoiceIdFor(config: Config, lang: SpeechLang): string {
  if (lang === "en") return config.piperVoiceEn !== "" ? config.piperVoiceEn : config.piperVoice;
  return config.piperVoice !== "" ? config.piperVoice : config.piperVoiceEn;
}
