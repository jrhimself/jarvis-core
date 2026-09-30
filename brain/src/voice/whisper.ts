/**
 * Listening, by Whisper on this machine.
 *
 * The same job as `scribe.ts` -- microphone audio in, partial and settled text
 * out -- without an account. Whisper reads a stretch of speech, not a stream,
 * so the part Scribe does on its own servers is done here: the audio is cut into
 * utterances by the loudness of the room, and each is read as it ends.
 *
 * The browser decides when the person is done, and it decides by watching text
 * arrive: a sentence's worth of quiet after the last transcript, and it sends
 * what it has. So what this sends has to keep the shape it expects:
 *
 * - a settled sentence when speech pauses, so a pause is not read as an ending;
 * - partial text while someone is still talking, so the browser has something
 *   to show and knows they are not done;
 * - a repeat of the last text while speech carries on between two results. Whisper
 *   takes a second or two over a long stretch, the browser gives up on quiet
 *   after a second and a half, and a person mid-sentence must not be cut off
 *   because the model was busy.
 *
 * Loudness is a crude test of speech, and it is only the first one: what it
 * decides is where to cut and when to bother the model. Whether there was a
 * word in it is Whisper's call, through its own voice-activity filter, so a door
 * slam is cut as an utterance and comes back as nothing.
 */

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "../config.js";
import { Pipe } from "./pipe.js";
import type { ListenerHandlers } from "./scribe.js";
import type { Listening } from "./types.js";

/** What the HUD captures. */
const SAMPLES_PER_MS = 16;
/** Longest the model may take to load. The first sentence after a boot waits for it. */
const READY_TIMEOUT_MS = 60_000;
/** Longest one stretch of speech may take to read; a hung process must not hold the microphone. */
const READ_TIMEOUT_MS = 30_000;

/** The quietest sound that counts as a voice, out of 32768. */
const MIN_VOICE_LEVEL = 350;
/** How far above the room's own noise a voice has to be. */
const NOISE_MARGIN = 3;
/** Speech that lasts less than this starts nothing; a click is not a sentence. */
const SPEECH_START_MS = 200;
/** Audio kept from before the speech was noticed, so a word's first sound is not cut. */
const PRE_ROLL_MS = 300;
/** Quiet this long ends an utterance. The browser waits its own second and a half on top. */
const END_SILENCE_MS = 600;
/** An utterance with less voice than this in it is thrown away unread. */
const MIN_VOICED_MS = 300;
/** A stretch this long is read whether or not the speaker has paused. */
const MAX_UTTERANCE_MS = 20_000;
/** How much new speech is worth a fresh partial reading. */
const PARTIAL_EVERY_MS = 900;
/** Partials are of the utterance so far; past this it would take longer than the speaking, so none. */
const PARTIAL_UNTIL_MS = 12_000;
/** The first partial waits for enough speech to have something to read. */
const PARTIAL_AFTER_VOICED_MS = 800;
/** How often the last text is repeated while speech goes on without a new result. */
const HEARTBEAT_MS = 600;

let pipe: Pipe | null = null;
let pipeKey = "";

function pipeFor(config: Config): Pipe {
  const key = JSON.stringify([config.sttPython, config.sttServer, config.sttModels, config.sttModel]);
  if (pipe === null || pipeKey !== key) {
    pipe?.stop();
    pipe = new Pipe({
      command: config.sttPython,
      args: [config.sttServer, config.sttModels, config.sttModel],
      label: "listen: whisper",
      readyTimeoutMs: READY_TIMEOUT_MS,
      jobTimeoutMs: READ_TIMEOUT_MS,
    });
    pipeKey = key;
  }
  return pipe;
}

/** Starts the process and loads the model now, so the first sentence does not wait for it. */
export function warmWhisper(config: Config): void {
  pipeFor(config)
    .ready()
    .catch((error: unknown) => {
      console.warn(`listen: whisper would not start -- ${error instanceof Error ? error.message : String(error)}`);
    });
}

/** Stops the shared process; the next listener starts a fresh one. For tests and shutdown. */
export function stopWhisper(): void {
  pipe?.stop();
  pipe = null;
  pipeKey = "";
}

/** The loudness of a chunk of 16-bit little-endian PCM: root mean square, out of 32768. */
export function level(pcm: Buffer): number {
  const samples = pcm.length >> 1;
  if (samples === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index++) {
    const value = pcm.readInt16LE(index * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

export class WhisperListener implements Listening {
  #closed = false;
  #failed = false;

  /** Time in the audio's own units, so behaviour follows the sound and not the clock. */
  #clock = 0;
  /** The room's own noise, learned from the quiet stretches. */
  #floor = 150;

  /** Audio from just before now, while nobody is speaking. */
  #preRoll: Buffer[] = [];
  #preRollMs = 0;
  /** How much voice has run unbroken while waiting for speech to start. */
  #voicedRun = 0;

  #speaking = false;
  #utterance: Buffer[] = [];
  #utteranceMs = 0;
  #voicedMs = 0;
  #quietMs = 0;
  /** Bumped when an utterance ends, so that a partial for the one before it is dropped. */
  #epoch = 0;

  #partialAt = 0;
  #partialBusy = false;
  #partialJob: { cancel: () => void } | null = null;

  /** The last text the browser was given, repeated as a heartbeat. */
  #heard = "";
  #heardAt = 0;

  constructor(
    private readonly config: Config,
    private readonly handlers: ListenerHandlers,
    private readonly lang: SpeechLang = config.speechLang,
  ) {
    pipeFor(config)
      .ready()
      .catch((error: unknown) => this.#fail(error instanceof Error ? error.message : String(error)));
    // The browser gives the brain two seconds to say a listener exists, and the
    // model can take longer than that to load on a cold start. Audio spoken in the
    // meantime waits in the pipe; a model that never loads is reported as a failure.
    queueMicrotask(() => {
      if (!this.#closed && !this.#failed) this.handlers.onReady?.();
    });
  }

  #fail(reason: string): void {
    if (this.#failed) return;
    this.#failed = true;
    console.warn(`listen: giving up -- ${reason}`);
    this.handlers.onError(reason);
    this.close();
  }

  #say(text: string, settled: boolean): void {
    if (this.#closed || this.#failed || text === "") return;
    this.#heard = text;
    this.#heardAt = this.#clock;
    if (settled) this.handlers.onFinal(text);
    else this.handlers.onPartial(text);
  }

  /** Feeds a chunk of microphone audio, base64 PCM at 16 kHz. */
  push(base64: string): void {
    if (this.#failed || this.#closed || base64 === "") return;
    const chunk = Buffer.from(base64, "base64");
    const pcm = chunk.subarray(0, chunk.length & ~1);
    if (pcm.length === 0) return;

    const ms = pcm.length / 2 / SAMPLES_PER_MS;
    const loudness = level(pcm);
    const voiced = loudness > Math.max(MIN_VOICE_LEVEL, this.#floor * NOISE_MARGIN);
    this.#clock += ms;

    if (!this.#speaking) {
      // Only quiet teaches the floor; a voice would raise it until the voice was noise.
      if (!voiced) this.#floor = Math.min(2000, this.#floor * 0.9 + loudness * 0.1);
      this.#preRoll.push(pcm);
      this.#preRollMs += ms;
      while (this.#preRollMs - this.#preRoll[0]!.length / 2 / SAMPLES_PER_MS >= PRE_ROLL_MS) {
        this.#preRollMs -= this.#preRoll.shift()!.length / 2 / SAMPLES_PER_MS;
      }

      this.#voicedRun = voiced ? this.#voicedRun + ms : 0;
      if (this.#voicedRun >= SPEECH_START_MS) this.#begin();
      return;
    }

    this.#utterance.push(pcm);
    this.#utteranceMs += ms;
    if (voiced) {
      this.#voicedMs += ms;
      this.#quietMs = 0;
    } else {
      this.#quietMs += ms;
    }

    if (this.#quietMs >= END_SILENCE_MS || this.#utteranceMs >= MAX_UTTERANCE_MS) {
      this.#end();
      return;
    }

    // Speech goes on. The browser is watching for a gap between results; if the
    // model is slow to give one, give the last again rather than let it decide
    // the person has stopped.
    if (voiced && this.#heard !== "" && this.#clock - this.#heardAt >= HEARTBEAT_MS) {
      this.#heardAt = this.#clock;
      this.handlers.onPartial(this.#heard);
    }
    this.#maybePartial();
  }

  #begin(): void {
    this.#speaking = true;
    this.#utterance = this.#preRoll;
    this.#utteranceMs = this.#preRollMs;
    this.#voicedMs = this.#voicedRun;
    this.#quietMs = 0;
    this.#partialAt = this.#utteranceMs;
    this.#preRoll = [];
    this.#preRollMs = 0;
    this.#voicedRun = 0;
  }

  #maybePartial(): void {
    if (this.#partialBusy || !this.config.sttPartials) return;
    if (this.#voicedMs < PARTIAL_AFTER_VOICED_MS || this.#utteranceMs > PARTIAL_UNTIL_MS) return;
    if (this.#utteranceMs - this.#partialAt < PARTIAL_EVERY_MS) return;

    this.#partialAt = this.#utteranceMs;
    this.#partialBusy = true;
    const epoch = this.#epoch;
    let text = "";
    this.#partialJob = this.#read(Buffer.concat(this.#utterance), {
      onText: (heard) => (text = heard),
      onDone: () => {
        this.#partialBusy = false;
        this.#partialJob = null;
        if (epoch === this.#epoch) this.#say(text, false);
      },
    });
  }

  /** The utterance is over: read all of it, and say what it was. */
  #end(): void {
    const audio = Buffer.concat(this.#utterance);
    const voiced = this.#voicedMs;

    this.#speaking = false;
    this.#utterance = [];
    this.#utteranceMs = 0;
    this.#voicedMs = 0;
    this.#quietMs = 0;
    this.#voicedRun = 0;
    // A partial still being read is for text the final will supersede.
    this.#epoch++;
    this.#partialBusy = false;
    this.#partialJob?.cancel();
    this.#partialJob = null;

    if (voiced < MIN_VOICED_MS) return;
    let text = "";
    this.#read(audio, {
      onText: (heard) => (text = heard),
      onDone: () => this.#say(text, true),
    });
  }

  #read(audio: Buffer, then: { onText: (text: string) => void; onDone: () => void }): { cancel: () => void } {
    return pipeFor(this.config).request(
      { lang: this.lang, audio: audio.toString("base64") },
      {
        onData: (payload) => then.onText(payload.toString("utf8").trim()),
        onDone: then.onDone,
        onError: (reason) => this.#fail(reason),
      },
    );
  }

  /** Reads what has been said so far, for a browser that has stopped listening. */
  commit(): void {
    if (this.#failed || this.#closed || !this.#speaking) return;
    this.#end();
  }

  close(): void {
    this.#closed = true;
    this.#partialJob?.cancel();
    this.#partialJob = null;
  }
}
