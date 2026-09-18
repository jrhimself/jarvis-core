/**
 * One conversation: a websocket connection and the agent session behind it.
 *
 * Sessions are deliberately short-lived. A follow-up question a few seconds later
 * should land in the same session ("en de droger?"), but yesterday's chatter has
 * no business being resent on every turn — continuity is the memory layer's job,
 * not the context window's.
 */

import type {
  DisplayCue,
  DisplayDismiss,
  DisplayPayload,
  SpeechFx,
  SpeechLang,
} from "@jarvis/shared";

import { dirname, join } from "node:path";

import { loadConfig } from "./config.js";
import { AgentSession } from "./agent.js";
import { Opening } from "./opening.js";
import { SpokenText } from "./spoken.js";
import { RecordedLines } from "./voice/lines.js";
import type { PendingDevAction } from "./dev-tools.js";
import {
  openVoice,
  voiceConfigured,
  voiceCreditsLeft,
  voiceFor,
  voiceProviderName,
  type Alignment,
  type SpeakingVoice,
} from "./voice/index.js";

const config = loadConfig();

/**
 * The lines that fill a silence, recorded once. Next to the database because
 * that is the deployment's own directory, and never tracked.
 */
const recorded = new RecordedLines(config, join(dirname(config.memoryPath), "voice-lines"));

/** Records the deployment's lines that are not on disk yet. Called at startup. */
export function warmRecordedLines(): Promise<number> {
  return recorded.warm(config.thinkingLines, "nl");
}

/** Re-check the credit balance at most this often. */
const CREDIT_CACHE_MS = 5 * 60 * 1000;

/**
 * A balance below this is treated as no balance at all.
 *
 * Zero was the old test, and it let a balance of ten characters through: the
 * socket opened, the brain told the HUD to expect a voice, and the refusal came
 * only once the first sentence was sent -- by which time the HUD was holding the
 * answer back for audio that was never going to arrive. Ten characters is not a
 * sentence, and neither is anything under a short one.
 */
const VOICE_MIN_CHARACTERS = 120;
let credits: { left: number | null; at: number } | null = null;

async function creditsLeft(): Promise<number | null> {
  if (credits !== null && Date.now() - credits.at < CREDIT_CACHE_MS) return credits.left;
  const left = await voiceCreditsLeft(config);
  credits = { left, at: Date.now() };
  return left;
}

/**
 * Did the answer put the ball back in the user's court?
 *
 * A question mark at the end is a crude test, but it is the one the assistant
 * actually controls, and being wrong only means the microphone stays open a few
 * seconds too long or too short.
 */
function endsInQuestion(text: string): boolean {
  return /\?["'’”)\]]*\s*$/.test(text.trim());
}

/**
 * Which colouring a language gets.
 *
 * English is the language of the system lines here — the wake-up greeting, the
 * acknowledgements — and those are the ones that should sound like a machine
 * speaking in a room. Dutch is JARVIS answering a question, and stays dry: an
 * echo on every reply wears out within an evening.
 */
function fxFor(lang: SpeechLang): SpeechFx {
  return lang === "en" ? "echo" : "none";
}

/** Longest we wait for speech to finish before calling the turn done anyway. */
const SPEECH_TIMEOUT_MS = 30_000;

/** Resolves with the promise, or after the timeout, whichever comes first. */
async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

/**
 * How long a conversation lives.
 *
 * Three minutes was chosen when a session was expensive to hold open; it made
 * "en hoe zit dat dan met..." twenty minutes later start from cold, at twice the
 * latency, and drop the pending confirmation with it. Twenty minutes matches how
 * talking to something in the room actually goes.
 *
 * The turn cap is the other half: an evening of questions on one session grows a
 * transcript that is re-sent every turn. Restarting after thirty turns costs one
 * cold start and loses nothing, because continuity lives in memory rather than in
 * the context.
 */
export interface SessionLimits {
  idleMs: number;
  maxTurns: number;
}

const DEFAULT_LIMITS: SessionLimits = { idleMs: 20 * 60 * 1000, maxTurns: 30 };

export interface ConversationCallbacks {
  /** A fragment of the answer; `opening` marks a line said only to fill a silence. */
  onText: (turnId: string, text: string, opening?: boolean) => void;
  onActivity: (turnId: string, label: string) => void;
  /**
   * What a tool answered, for whatever is keeping the context panel.
   *
   * No turn id: the panel is a standing answer to "what are we talking about"
   * and outlives the turn that filled it.
   */
  onToolResult: (tool: string, content: unknown) => void;
  onDisplay: (
    turnId: string,
    id: string,
    payload: DisplayPayload,
    dismiss: DisplayDismiss,
    cue: DisplayCue,
  ) => void;
  /**
   * Whether the brain can speak this turn; false means the browser should.
   * When it can, `lang` and `fx` tell the HUD how to pronounce and colour it.
   */
  onVoice: (
    turnId: string,
    available: boolean,
    reason?: string,
    lang?: SpeechLang,
    fx?: SpeechFx,
  ) => void;
  onAudio: (turnId: string, seq: number, data: string, alignment?: Alignment) => void;
  onAudioDone: (turnId: string) => void;
  onDone: (turnId: string, durationMs: number, expectsReply: boolean) => void;
  onError: (turnId: string | undefined, message: string) => void;
}

export class Conversation {
  #idleTimer: NodeJS.Timeout | null = null;
  #current: { turnId: string; abort: AbortController } | null = null;
  #closed = false;
  // The house's own pending confirmation is not here any more: it lives in the
  // pack that guards it, for exactly as long as the agent session does, which is
  // the same conversation this class ends.
  /** A piece of self-development awaiting a spoken yes, remembered across turns. */
  #pendingDev: PendingDevAction | null = null;
  /** The agent process, kept alive for the length of the conversation. */
  #agent: AgentSession | null = null;
  /** Turns answered on the current agent, against the cap. */
  #turns = 0;

  constructor(
    private readonly callbacks: ConversationCallbacks,
    private readonly limits: SessionLimits = DEFAULT_LIMITS,
    /**
     * Whether an answer is spoken as well as written.
     *
     * Off for a conversation held over text. Opening the voice costs credits
     * the moment it connects, and audio nobody can hear is the purest way there
     * is to spend them.
     */
    private readonly voice: "on" | "off" = "on",
  ) {}

  /** True while a turn is being answered. */
  get busy(): boolean {
    return this.#current !== null;
  }

  /** Opens the agent ahead of the first question. Failures are not fatal. */
  warm(): void {
    if (this.#closed || this.#agent !== null) return;
    const agent = new AgentSession();
    this.#agent = agent;
    void agent.warm().catch((error: unknown) => {
      console.error("could not warm the agent:", error);
    });
  }

  async handleUtterance(turnId: string, text: string): Promise<void> {
    if (this.#closed) return;

    if (this.#current !== null) {
      // One voice, one turn at a time: drop the older answer rather than
      // interleaving two of them into the same speaker.
      this.#current.abort.abort();
    }

    const abort = new AbortController();
    this.#current = { turnId, abort };
    this.#clearIdleTimer();

    const startedAt = performance.now();
    this.callbacks.onActivity(turnId, "denkt na");

    // How far the answer has been written when something is put on screen. A
    // tool is reached for mid-sentence and answers in milliseconds, so this is
    // the only moment at which the screen and the sentence are still in step.
    let written = 0;

    // Opened before the first token so the first sentence can be spoken as
    // soon as it exists, rather than after the answer is complete.
    const speaking = this.voice === "off" ? null : await this.#openVoice(turnId, abort);
    const voice = speaking?.voice ?? null;

    // Text for the screen waits until the browser knows whether the brain
    // speaks this turn. The voice itself needs no such gate -- it queues what
    // it is given until its socket is up -- and the model is not held either:
    // only the page is, for the half second the socket takes, or until the
    // voice gives up and the page has to read the answer itself.
    let held: Array<[string, boolean]> | null = speaking === null ? null : [];
    const show = (text: string, opening = false): void => {
      if (held !== null) {
        held.push([text, opening]);
        return;
      }
      this.callbacks.onText(turnId, text, opening);
    };
    void speaking?.ready.then(() => {
      const queued = held ?? [];
      held = null;
      if (abort.signal.aborted) return;
      for (const [text, opening] of queued) this.callbacks.onText(turnId, text, opening);
    });

    // Something to say while this turn is still fetching. The boundaries are
    // Opening's; the clock is this one's, because it is the one holding a voice.
    const opening = new Opening(config.thinkingLines, config.thinkingAfterMs);
    let thinking: NodeJS.Timeout | null = null;
    // The answer, with its dashes taken out on the way to the voice and the
    // transcript. Everything the model writes goes through it; the opening
    // lines below do not, being ours.
    const spoken = new SpokenText();

    const stopThinking = (): void => {
      if (thinking === null) return;
      clearTimeout(thinking);
      thinking = null;
    };

    const armThinking = (): void => {
      stopThinking();
      if (!opening.waiting) return;
      thinking = setTimeout(() => {
        thinking = null;
        if (abort.signal.aborted) return;
        const line = opening.due();
        if (line === null || line === "") return;
        // The trailing space keeps it off the front of the answer's first word:
        // the two are one stream, to the voice and to the transcript both. The
        // space the filter may be holding from a greeting goes out first, for
        // the same reason.
        const said = `${spoken.flush()}${line} `;
        written += said.length;
        show(said, true);
        // Recorded earlier, so it is heard now and the voice's socket stays
        // free for the first sentence of the answer.
        const clip = speaking === null ? null : recorded.get(line, "nl");
        if (clip !== null && speaking !== null) speaking.play(clip);
        else voice?.speak(said);
      }, opening.afterMs);
      thinking.unref?.();
    };

    armThinking();

    try {
      if (this.#agent === null || this.#agent.broken) {
        this.#agent?.close();
        this.#agent = new AgentSession();
      }

      const result = await this.#agent.ask(
        text,
        turnId,
        {
          onText: (chunk) => {
            if (abort.signal.aborted) return;
            // A greeting restarts the clock; the first word of the answer stops
            // it for good.
            if (opening.said()) armThinking();
            else stopThinking();
            const text = spoken.push(chunk);
            if (text === "") return;
            written += text.length;
            show(text);
            voice?.speak(text);
          },
          onActivity: (label) => {
            if (!abort.signal.aborted) this.callbacks.onActivity(turnId, label);
          },
          onToolResult: (tool, content) => {
            if (abort.signal.aborted) return;
            opening.told();
            this.callbacks.onToolResult(tool, content);
          },
          onLimit: () => {
            // The sentence that follows is the whole answer: nothing is being
            // fetched, so no line is owed for the silence after it.
            opening.told();
            opening.said();
            stopThinking();
          },
          onDisplay: (id, payload, dismiss, anchor) => {
            if (abort.signal.aborted) return;
            this.callbacks.onDisplay(turnId, id, payload, dismiss, {
              chars: written,
              ...(anchor === undefined ? {} : { anchor }),
            });
          },
        },
        {
          turnId,
          pending: this.#pendingDev,
          setPending: (action) => {
            this.#pendingDev = action;
          },
        },
        abort.signal,
      );

      const rest = spoken.flush();
      if (rest !== "" && !abort.signal.aborted) {
        written += rest.length;
        show(rest);
        voice?.speak(rest);
      }
      voice?.finish();

      // "done" means the answer has been spoken, not merely written. The HUD
      // reopens the microphone on it, and doing that while audio is still
      // playing would have JARVIS transcribing himself.
      if (speaking !== null) await withTimeout(speaking.spoken, SPEECH_TIMEOUT_MS);
      if (abort.signal.aborted) return;

      this.callbacks.onDone(
        turnId,
        Math.round(performance.now() - startedAt),
        endsInQuestion(result.text),
      );
    } catch (error) {
      voice?.abort();
      if (abort.signal.aborted) return;
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`turn ${turnId} failed:`, error);
      this.callbacks.onError(turnId, `Something went wrong: ${reason}`);
    } finally {
      stopThinking();
      if (abort.signal.aborted) voice?.abort();
      if (this.#current?.turnId === turnId) this.#current = null;
      this.#turns += 1;
      // Long conversations are ended here rather than mid-answer, so the cap
      // never costs anyone a reply -- only the next question a cold start.
      if (this.#turns >= this.limits.maxTurns) this.#endSession();
      this.#startIdleTimer();
    }
  }

  /**
   * Says a fixed line out loud without asking the assistant anything.
   *
   * This is how JARVIS speaks on his own initiative — the wake-up greeting
   * above all. It runs as a normal turn so the HUD reveals the text against the
   * audio the way it does for an answer, but nothing is thought about and no
   * tokens are spent: the text goes straight to the voice.
   */
  async say(turnId: string, text: string, lang: SpeechLang = "nl"): Promise<void> {
    if (this.#closed) return;

    if (this.#current !== null) this.#current.abort.abort();

    const abort = new AbortController();
    this.#current = { turnId, abort };
    this.#clearIdleTimer();

    const startedAt = performance.now();
    const speaking = await this.#openVoice(turnId, abort, lang);

    try {
      // The same rule as a turn: the page hears whether the brain speaks
      // before it sees a word, or it reads the line itself and is talked over.
      if (speaking !== null) await speaking.ready;
      if (abort.signal.aborted) return;
      this.callbacks.onText(turnId, text);

      if (speaking === null) {
        // No voice: the HUD reads it out itself, so the turn is done as soon as
        // the text has been handed over.
        this.callbacks.onDone(turnId, Math.round(performance.now() - startedAt), false);
        return;
      }

      speaking.voice.speak(text);
      speaking.voice.finish();
      await withTimeout(speaking.spoken, SPEECH_TIMEOUT_MS);
      if (abort.signal.aborted) return;

      this.callbacks.onDone(turnId, Math.round(performance.now() - startedAt), false);
    } finally {
      if (abort.signal.aborted) speaking?.voice.abort();
      if (this.#current?.turnId === turnId) this.#current = null;
      this.#startIdleTimer();
    }
  }

  /**
   * Opens a voice for this turn, or reports why there is none. A missing key, an
   * empty balance or a refused socket all end the same way: the browser speaks
   * instead, which sounds worse but keeps the conversation going.
   */
  async #openVoice(
    turnId: string,
    abort: AbortController,
    lang: SpeechLang = "nl",
  ): Promise<{
    voice: SpeakingVoice;
    spoken: Promise<void>;
    ready: Promise<void>;
    /** Plays audio that was recorded earlier, as if the voice had just made it. */
    play: (clip: Buffer) => void;
  } | null> {
    console.log(
      `voice: opening (${voiceProviderName(config)}, key ${voiceConfigured(config) ? "present" : "missing"}, voice ${voiceFor(config, lang) || "default"}, lang ${lang})`,
    );
    if (!voiceConfigured(config)) {
      this.callbacks.onVoice(turnId, false, "de stem is niet ingesteld");
      return null;
    }

    const left = await creditsLeft();
    // ElevenLabs counts characters; Fish counts dollars, and a free Fish model
    // counts nothing at all and answers null. Only a metered balance can run out.
    const unit = config.voiceProvider === "fish" ? "dollars" : "characters";
    const floor = config.voiceProvider === "fish" ? 0.01 : VOICE_MIN_CHARACTERS;
    console.log(`voice: ${left === null ? "balance unknown" : `${left} ${unit} left`}`);
    if (left !== null && left < floor) {
      this.callbacks.onVoice(turnId, false, "de credits van de stem zijn op");
      return null;
    }
    if (abort.signal.aborted) return null;

    let seq = 0;
    let announced = false;
    let heard = false;
    let settle: () => void = () => {};
    const spoken = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // Resolved the moment the browser has been told whether this turn will be
    // spoken, either way. Text is held back until then: a sentence that
    // reaches the page before the socket is up is read by the browser, and
    // then again by the voice when it arrives, one over the other.
    let decide: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      decide = resolve;
    });

    const play = (data: string, alignment?: Alignment): void => {
      if (abort.signal.aborted) return;
      heard = true;
      if (!announced) {
        announced = true;
        this.callbacks.onVoice(turnId, true, undefined, lang, fxFor(lang));
        decide();
      }
      this.callbacks.onAudio(turnId, seq++, data, alignment);
    };

    const voice = openVoice(
      config,
      {
        onOpen: () => {
          if (abort.signal.aborted || announced) return;
          announced = true;
          this.callbacks.onVoice(turnId, true, undefined, lang, fxFor(lang));
          decide();
        },
        onAudio: play,
        onDone: () => {
          if (!abort.signal.aborted) this.callbacks.onAudioDone(turnId);
          settle();
        },
        onError: (reason) => {
          settle();
          // Only useful before anything has been heard; once audio is playing the
          // browser cannot take over halfway without talking over itself. The
          // turn may already have been announced -- that is the point of
          // announcing early -- so what matters here is whether a chunk landed.
          if (!heard && !abort.signal.aborted) this.callbacks.onVoice(turnId, false, reason);
          credits = null;
          decide();
        },
      },
      lang,
    );

    return { voice, spoken, ready, play: (clip) => play(clip.toString("base64")) };
  }

  cancel(turnId: string): void {
    if (this.#current?.turnId === turnId) {
      this.#current.abort.abort();
      this.#current = null;
      this.#startIdleTimer();
    }
  }

  close(): void {
    this.#closed = true;
    this.#agent?.close();
    this.#agent = null;
    this.#current?.abort.abort();
    this.#current = null;
    this.#clearIdleTimer();
  }

  #startIdleTimer(): void {
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      // Letting the agent go is what ends the conversation: the next turn opens
      // a new one, with no memory of this one beyond what was written down.
      this.#endSession();
      this.#idleTimer = null;
    }, this.limits.idleMs);
    this.#idleTimer.unref();
  }

  /** Drops the agent, so the next turn starts a fresh conversation. */
  #endSession(): void {
    this.#agent?.close();
    this.#agent = null;
    this.#turns = 0;
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }
}
