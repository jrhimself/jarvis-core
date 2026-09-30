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
 * voice takes longer than saying a sentence with it. Its frames -- see
 * `piper/server.py` -- are ordered and one sentence is in flight at a time, so
 * a turn that is cancelled costs at most the sentence being made.
 *
 * Piper sends no per-character timing. The HUD paces the transcript by the
 * audio's length instead, as it does for Fish.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
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

interface Sink {
  onAudio: (pcm: Buffer) => void;
  onDone: () => void;
  onError: (reason: string) => void;
}

interface Job extends Sink {
  id: number;
  voice: string;
  text: string;
  speed: number;
  cancelled: boolean;
}

/** The one running Python process, and the queue of sentences waiting for it. */
class Engine {
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #onReady: () => void = () => {};
  #buffer: Buffer = Buffer.alloc(0);
  #queue: Job[] = [];
  #active: Job | null = null;
  #timer: NodeJS.Timeout | null = null;
  #next = 1;

  constructor(private readonly config: Config) {}

  /** Resolves once the process is up with its voices loaded; starts it if it is not. */
  ready(): Promise<void> {
    if (this.#ready !== null) return this.#ready;
    const ready = new Promise<void>((resolve, reject) => {
      const voices = [this.config.piperVoice, this.config.piperVoiceEn].filter(
        (voice, index, all) => voice !== "" && all.indexOf(voice) === index,
      );
      const child = spawn(
        this.config.piperPython,
        [this.config.piperServer, this.config.piperModels, ...voices],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      this.#child = child;
      this.#buffer = Buffer.alloc(0);

      const timeout = setTimeout(() => {
        reject(new Error("piper did not start in time"));
        this.#die("piper did not start in time");
      }, READY_TIMEOUT_MS);

      this.#onReady = () => {
        clearTimeout(timeout);
        resolve();
        this.#pump();
      };
      child.stdout.on("data", (data: Buffer) => this.#read(data));
      child.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text !== "") console.warn(`voice: piper: ${text}`);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
        this.#die(error.message);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`piper exited (${code})`));
        this.#die(`piper exited (${code})`);
      });
      // Writing to a process that has gone is reported on the pipe, and it is
      // reported again by `exit`; the second is the one that is acted on.
      child.stdin.on("error", () => {});
    });
    // A rejection nobody awaits yet -- the process died before a turn asked --
    // is not an unhandled one: the next call starts a fresh process.
    ready.catch(() => {});
    this.#ready = ready;
    return ready;
  }

  /** Queues one sentence; audio, then done or an error, arrive on `sink`. */
  request(voice: string, text: string, speed: number, sink: Sink): { cancel: () => void } {
    const job: Job = { ...sink, id: this.#next++, voice, text, speed, cancelled: false };
    this.#queue.push(job);
    this.#pump();
    return {
      cancel: () => {
        job.cancelled = true;
        // Not yet sent: nothing to wait for. Already sent: its frames are
        // dropped as they arrive, and the queue moves on at its done.
        const index = this.#queue.indexOf(job);
        if (index >= 0) this.#queue.splice(index, 1);
      },
    };
  }

  #pump(): void {
    if (this.#active !== null || this.#child === null) return;
    const job = this.#queue.shift();
    if (job === undefined) return;
    this.#active = job;
    this.#timer = setTimeout(() => this.#die("piper took too long over a sentence"), SENTENCE_TIMEOUT_MS);
    this.#child.stdin.write(
      `${JSON.stringify({ id: job.id, voice: job.voice, text: job.text, speed: job.speed })}\n`,
    );
  }

  #read(data: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    // kind (1) + id (4) + length (4), then the payload.
    while (this.#buffer.length >= 9) {
      const length = this.#buffer.readUInt32BE(5);
      if (this.#buffer.length < 9 + length) return;
      const kind = String.fromCharCode(this.#buffer[0]!);
      const id = this.#buffer.readUInt32BE(1);
      const payload = this.#buffer.subarray(9, 9 + length);
      this.#buffer = this.#buffer.subarray(9 + length);
      this.#handle(kind, id, payload);
    }
  }

  #handle(kind: string, id: number, payload: Buffer): void {
    if (kind === "R") {
      this.#onReady();
      return;
    }
    const job = this.#active;
    if (job === null || job.id !== id) return;

    if (kind === "A") {
      if (!job.cancelled) job.onAudio(Buffer.from(payload));
      return;
    }
    if (kind === "D" || kind === "E") {
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#timer = null;
      this.#active = null;
      if (!job.cancelled) {
        if (kind === "D") job.onDone();
        else job.onError(payload.toString("utf8") || "piper failed");
      }
      this.#pump();
    }
  }

  /** The process is gone or stuck: fail what was waiting and let the next call start afresh. */
  #die(reason: string): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    if (child !== null) {
      child.removeAllListeners("exit");
      child.kill();
    }
    const waiting = [...(this.#active === null ? [] : [this.#active]), ...this.#queue];
    this.#active = null;
    this.#queue = [];
    for (const job of waiting) if (!job.cancelled) job.onError(reason);
  }

  stop(): void {
    this.#die("piper stopped");
  }
}

let engine: Engine | null = null;
let engineKey = "";

function engineFor(config: Config): Engine {
  const key = JSON.stringify([config.piperPython, config.piperServer, config.piperModels]);
  if (engine === null || engineKey !== key) {
    engine?.stop();
    engine = new Engine(config);
    engineKey = key;
  }
  return engine;
}

/** Stops the shared process; the next voice starts a fresh one. For tests and shutdown. */
export function stopPiper(): void {
  engine?.stop();
  engine = null;
  engineKey = "";
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
    engineFor(config)
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
      engineFor(this.config).request(piperVoiceIdFor(this.config, this.lang), sentence, this.config.voiceSpeed, {
        onAudio: (pcm) => {
          if (!this.#failed) this.handlers.onAudio(pcm.toString("base64"));
        },
        onDone: () => {
          this.#outstanding--;
          this.#maybeDone();
        },
        onError: (reason) => this.#fail(reason),
      }),
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
