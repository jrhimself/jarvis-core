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
 *
 * Time is the whole cost. On two old cores every reading takes about a second
 * however short the speech, because the model looks at a fixed half minute of
 * audio each time, and choosing the language takes a second more. So the work is
 * arranged around not spending it where the person is waiting:
 *
 * - the language is guessed from the last utterance while the first words are
 *   read, confirmed by one full reading once there is enough speech to be sure,
 *   and held for the rest of the utterance;
 * - when speech ends, a reading already made that covers all of it is the final
 *   -- no second reading -- and one still in progress is waited for, not
 *   abandoned and repeated.
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
const END_SILENCE_MS = 500;
/** An utterance with less voice than this in it is thrown away unread. */
const MIN_VOICED_MS = 300;
/** A stretch this long is read whether or not the speaker has paused. */
const MAX_UTTERANCE_MS = 20_000;
/** How much new audio is worth a fresh partial reading. */
const PARTIAL_EVERY_MS = 400;
/** Partials are of the utterance so far; past this it would take longer than the speaking, so none. */
const PARTIAL_UNTIL_MS = 12_000;
/**
 * The first partial waits for enough speech to have something to read. Measured
 * on a Dutch sentence, a reading of 0.7 s of it was "Het is niet meer." for
 * "Zet het licht in..."; the browser shows what it is given, and a wrong first
 * line is worse than a late one.
 */
const PARTIAL_AFTER_VOICED_MS = 900;
/**
 * How much speech makes the language worth working out. Under two seconds the
 * model is wrong about it often enough to be worse than a guess from the last
 * utterance; from here it is right.
 */
const CONFIRM_AFTER_VOICED_MS = 1500;
/** How sure the model has to be of the language for it to be held. */
const LANGUAGE_SURE = 0.8;
/**
 * A reading that stops this far short of the end of the speech is still the
 * final: what it missed is the last syllable or two, which is not worth a second
 * reading and the wait for it.
 */
const REUSE_SLACK_MS = 300;
/** How often the last text is repeated while speech goes on without a new result. */
const HEARTBEAT_MS = 600;

let pipe: Pipe | null = null;
let pipeKey = "";
/** The language of the last utterance that was sure of one: the best guess for the next. */
let lastLanguage: string | null = null;

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
  lastLanguage = null;
}

/** What the process says about a stretch of speech: the text, and the language it was heard in. */
interface Reading {
  text: string;
  language: string;
  probability: number;
}

function parseReading(payload: Buffer): Reading | null {
  try {
    const reading = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    return {
      text: typeof reading["text"] === "string" ? reading["text"].trim() : "",
      language: typeof reading["lang"] === "string" ? reading["lang"] : "",
      probability: typeof reading["prob"] === "number" ? reading["prob"] : 0,
    };
  } catch {
    return null;
  }
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

/** An utterance that has ended and is waiting to be settled. */
interface Ended {
  epoch: number;
  audio: Buffer;
  /** How far into the audio the last voiced chunk ended. */
  voicedEndMs: number;
  /** The language, if it was sure by the time the speech ended. */
  language: string | null;
}

/** A partial reading, kept in case it turns out to cover the whole utterance. */
interface Covering {
  epoch: number;
  text: string;
  /** How much of the utterance it read. */
  coveredMs: number;
  /** Whether it was read in a language that was certain, and so is fit to be the final. */
  sure: boolean;
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
  #voicedEndMs = 0;
  #quietMs = 0;
  /** Bumped at the start and at the end of an utterance, so a reading for the one before is not taken for this one's. */
  #epoch = 0;
  /** The language of this utterance, once a reading has been sure of it. */
  #language: string | null = null;

  #partialAt = 0;
  #partialBusy = false;
  #partialJob: { cancel: () => void } | null = null;
  #covering: Covering | null = null;
  /** An utterance that ended while a partial was being read, to be settled when it comes back. */
  #ended: Ended | null = null;

  /** The last text the browser was given, repeated as a heartbeat. */
  #heard = "";
  #heardAt = 0;

  constructor(
    private readonly config: Config,
    private readonly handlers: ListenerHandlers,
    // Not what is transcribed: the language the assistant answers in is not the
    // one the person speaks. Someone who asks in Dutch of an assistant that
    // answers in English would otherwise have their Dutch translated, word by
    // wrong word, into English. See `sttLanguages`.
    _answersIn: SpeechLang = config.speechLang,
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
      this.#voicedEndMs = this.#utteranceMs;
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
    this.#epoch++;
    this.#language = null;
    this.#covering = null;
    this.#utterance = this.#preRoll;
    this.#utteranceMs = this.#preRollMs;
    this.#voicedMs = this.#voicedRun;
    this.#voicedEndMs = this.#utteranceMs;
    this.#quietMs = 0;
    this.#partialAt = this.#utteranceMs;
    this.#preRoll = [];
    this.#preRollMs = 0;
    this.#voicedRun = 0;
  }

  /**
   * Which language to read in, or null to have the model choose. The choice is
   * the expensive part, so it is made once, when there is speech enough to be
   * right about it, and until then the last utterance's language is the guess.
   */
  #languageForPartial(): string | null {
    const allowed = this.config.sttLanguages;
    if (allowed.length === 1) return allowed[0]!;
    if (this.#language !== null) return this.#language;
    if (this.#voicedMs >= CONFIRM_AFTER_VOICED_MS) return null;
    // A first guess is never the model's own: on a second of speech it said English
    // to a Dutch sentence, and then spent four seconds decoding the mistake.
    return lastLanguage ?? allowed[0]!;
  }

  #maybePartial(): void {
    if (this.#partialBusy || !this.config.sttPartials) return;
    if (this.#voicedMs < PARTIAL_AFTER_VOICED_MS || this.#utteranceMs > PARTIAL_UNTIL_MS) return;
    if (this.#utteranceMs - this.#partialAt < PARTIAL_EVERY_MS) return;

    this.#partialAt = this.#utteranceMs;
    this.#partialBusy = true;
    const epoch = this.#epoch;
    const coveredMs = this.#utteranceMs;
    const language = this.#languageForPartial();
    // A language taken from the last utterance is a guess, and a reading made in a
    // guess is not one to stand as the final.
    const certain = language !== null && (this.config.sttLanguages.length === 1 || this.#language !== null);
    this.#partialJob = this.#read(Buffer.concat(this.#utterance), language, certain, epoch, (text, sure) => {
      this.#partialBusy = false;
      this.#partialJob = null;
      if (text !== "") this.#covering = { epoch, text, coveredMs, sure };

      // The utterance ended while this was being read. It is the reading that is
      // waited for, and it may be the last one that is needed.
      const ended = this.#ended;
      if (ended !== null && ended.epoch === epoch) {
        this.#ended = null;
        this.#settle(ended);
        return;
      }
      if (epoch === this.#epoch && this.#speaking) this.#say(text, false);
    });
  }

  /** The utterance is over. Settle it now, or as soon as the reading in progress comes back. */
  #end(): void {
    const ended: Ended = {
      epoch: this.#epoch,
      audio: Buffer.concat(this.#utterance),
      voicedEndMs: this.#voicedEndMs,
      language: this.config.sttLanguages.length === 1 ? this.config.sttLanguages[0]! : this.#language,
    };
    const voiced = this.#voicedMs;

    this.#speaking = false;
    this.#utterance = [];
    this.#utteranceMs = 0;
    this.#voicedMs = 0;
    this.#quietMs = 0;
    this.#voicedRun = 0;
    // Nothing that follows is this utterance's: the next one starts a new epoch.
    this.#epoch++;

    if (voiced < MIN_VOICED_MS) {
      this.#partialJob?.cancel();
      this.#partialBusy = false;
      this.#partialJob = null;
      return;
    }
    if (this.#partialBusy) {
      this.#ended = ended;
      return;
    }
    this.#settle(ended);
  }

  /**
   * Say what the utterance was. A reading made while it was still going, if it got
   * to the end of the speech in a language it was sure of, is that already.
   */
  #settle(ended: Ended): void {
    const covering = this.#covering;
    if (
      covering !== null &&
      covering.epoch === ended.epoch &&
      covering.sure &&
      covering.coveredMs >= ended.voicedEndMs - REUSE_SLACK_MS
    ) {
      this.#say(covering.text, true);
      return;
    }
    // Whatever language the reading in progress was sure of is the one to read the rest in.
    const language = ended.language ?? (covering !== null && covering.epoch === ended.epoch && covering.sure ? lastLanguage : null);
    this.#read(ended.audio, language, language !== null, ended.epoch, (text) => this.#say(text, true));
  }

  /**
   * One reading. `language` null lets the model choose, which is remembered if it
   * was sure; `certain` says a given language is known and not a guess. `done` is
   * told the text, and whether the language it was read in was certain.
   */
  #read(
    audio: Buffer,
    language: string | null,
    certain: boolean,
    epoch: number,
    done: (text: string, sure: boolean) => void,
  ): { cancel: () => void } {
    const languages = this.config.sttLanguages;
    let text = "";
    let sure = certain;
    return pipeFor(this.config).request(
      { audio: audio.toString("base64"), ...(language === null ? { langs: languages } : { lang: language }) },
      {
        onData: (payload) => {
          const heard = parseReading(payload);
          if (heard === null) return;
          text = heard.text;
          if (language === null && heard.text !== "" && heard.probability >= LANGUAGE_SURE) {
            sure = true;
            lastLanguage = heard.language;
            if (epoch === this.#epoch && this.#language === null) this.#language = heard.language;
          }
        },
        onDone: () => done(text, sure),
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
