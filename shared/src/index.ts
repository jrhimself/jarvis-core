/**
 * The websocket protocol between the HUD and the brain.
 *
 * One conversation is one websocket connection. The client speaks first with an
 * `utterance`; the server answers with a stream of `text` chunks, closed by
 * `done`. Anything the assistant does on the way — a tool call, a memory lookup —
 * arrives as `activity`, which the HUD renders in its pipeline panel.
 */

// The house seam and the pack contract. Re-exported here so both the brain and
// the HUD reach them through the one package name they already import.
export * from "./delegate.js";
export * from "./home.js";
export * from "./pack.js";
export * from "./time.js";

import type { HudTile } from "./pack.js";

/** Messages sent by the HUD to the brain. */
export type ClientMessage =
  | {
      kind: "utterance";
      /** What the user said, already transcribed. */
      text: string;
      /** Client-generated id, echoed back on every message of the answer. */
      turnId: string;
    }
  | {
      /** Open the microphone: the brain answers with a `listen` message. */
      kind: "listen_start";
    }
  | {
      kind: "listen_audio";
      /** Base64 raw PCM: signed 16-bit little-endian, mono, 16 kHz. */
      data: string;
    }
  | {
      kind: "listen_stop";
    }
  | {
      /**
       * Speak this text verbatim; the assistant is not asked anything. Used for
       * the fixed lines JARVIS says on his own — the wake-up greeting above all.
       */
      kind: "say";
      text: string;
      /** Client-generated id, echoed back on every message of the answer. */
      turnId: string;
      /** Which language to pronounce it in. Defaults to Dutch. */
      lang?: SpeechLang;
    }
  | {
      kind: "cancel";
      /** The turn to abandon; the brain stops streaming and replies `done`. */
      turnId: string;
    }
  | {
      /**
       * A window has left the screen.
       *
       * The HUD throws the card away; the brain keeps what was in it. That gap
       * is the whole point of this message: a window closed by mistake is the
       * moment you discover you wanted it, and "show me those mails again"
       * should not mean fetching the mailbox a second time to find out what was
       * already on screen.
       */
      kind: "display_closed";
      /** The id the brain handed out when it pushed the item. */
      id: string;
      /** What took it off the screen. */
      reason: DisplayGone;
    };

/** The languages the voice is asked to pronounce. */
export type SpeechLang = "nl" | "en";

/**
 * Something JARVIS puts on screen where the orb normally sits.
 *
 * Images always arrive as a path served by the brain rather than a source URL:
 * the browser must never need a Home Assistant token, and a camera still should
 * not be fetched by whatever the page happens to be pointed at.
 */
export type DisplayPayload =
  | {
      type: "image";
      /** Path on the brain, e.g. /media/ab12cd. */
      url: string;
      /** Spoken-language description, also used as alt text. */
      alt: string;
      caption?: string;
      /** Set for a camera: re-fetch this often, in milliseconds. */
      refreshMs?: number;
    }
  | {
      type: "panel";
      title: string;
      rows: Array<{
        label: string;
        value: string;
        hint?: string;
        /**
         * This row wants something from the user.
         *
         * A standing mark rather than the gold that says a row is being spoken
         * about: out of a list of mails, these are the ones that need an answer.
         * Which they are is a judgement, so it is made by the assistant and not
         * by the pack that read them.
         */
        mark?: boolean;
      }>;
      /**
       * No row of this list lights up.
       *
       * The gold that travels with the sentence is worth having when a list is
       * a set of separate facts and one of them is being read out. It is worth
       * nothing when the whole list is what is being talked about, which is
       * what a window of four chosen mails is: every row lights, one after the
       * other, and the light stops meaning anything. Per window, because it is
       * a property of the list and not of the screen.
       */
      quiet?: boolean;
    }
  | {
      type: "chart";
      title: string;
      /** Unit shown on the axis, e.g. "°C" or "kWh". */
      unit?: string;
      points: Array<{ label: string; value: number }>;
    }
  | {
      type: "text";
      title?: string;
      body: string;
    };

/**
 * Colouring the HUD applies to the audio as it plays. "echo" is a short delay
 * with a darkening tail: the room a film computer speaks in. It is applied in
 * the browser rather than baked into the audio, so it stays adjustable and
 * costs no synthesis credits.
 */
export type SpeechFx = "none" | "echo";

/**
 * Why a window is no longer on screen.
 *
 * "closed" is the only one the user did on purpose, and the only one worth
 * treating as a signal; the rest are the screen tidying up after itself.
 */
export type DisplayGone = "closed" | "timeout" | "next-turn" | "replaced" | "aged-out";

/** When a displayed item should disappear. */
export type DisplayDismiss =
  | { mode: "next-turn" }
  | { mode: "timeout"; ms: number }
  | { mode: "manual" };

/**
 * Where in the answer a displayed item belongs.
 *
 * A tool finishes long before the sentence about it is spoken, so an item put on
 * screen the moment it arrives lands under the wrong words. `chars` is how much
 * of the answer had been written when it was pushed, which is the point in the
 * sentence the tool was reached for; `anchor` is a word the item is about, and
 * beats the count when it is given, because a pack knows what JARVIS is going to
 * call the thing better than the character count does.
 */
export interface DisplayCue {
  /** Characters of the answer already written when this was pushed. */
  chars: number;
  /** Word or short phrase to wait for, matched case-insensitively. */
  anchor?: string;
}

/** Messages sent by the brain to the HUD. */
export type ServerMessage =
  | {
      kind: "ready";
      /** Session this connection is bound to, for diagnostics. */
      sessionId: string | null;
      /** What the brain is running, so the page never carries a stale one. */
      version?: string;
    }
  | {
      kind: "text";
      turnId: string;
      /** A fragment of the answer. Concatenating every chunk yields the answer. */
      text: string;
      /**
       * This fragment fills a silence and is not the answer: the brain is still
       * fetching, and the HUD should go on saying what it is fetching rather
       * than treat the turn as being answered.
       */
      opening?: true;
    }
  | {
      kind: "activity";
      turnId: string;
      /** What the brain is doing right now, phrased for display. */
      label: string;
      /** Which pipeline stage this belongs to. */
      stage: PipelineStage;
    }
  | {
      kind: "display";
      turnId: string;
      /** Identifies this item, so it can be replaced or cleared later. */
      id: string;
      payload: DisplayPayload;
      dismiss: DisplayDismiss;
      /** When in the spoken answer to reveal it. Absent means straight away. */
      cue?: DisplayCue;
    }
  | {
      kind: "display_clear";
      /** Omitted clears whatever is on screen. */
      id?: string;
    }
  | {
      /** Sent before any audio for a turn: whether the brain can speak it. */
      kind: "voice";
      turnId: string;
      available: boolean;
      /** Why not, when it cannot — safe to show to the user. */
      reason?: string;
      /** Which language this turn is pronounced in. Absent means Dutch. */
      lang?: SpeechLang;
      /** Post-processing the HUD should put the audio through. */
      fx?: SpeechFx;
    }
  | {
      kind: "audio";
      turnId: string;
      /** Chunk order, so the client can spot a gap. */
      seq: number;
      /** Base64 raw PCM: signed 16-bit little-endian, mono, 16 kHz. */
      data: string;
      /** Per-character timings within this chunk, when the voice provides them. */
      alignment?: {
        chars: string[];
        startMs: number[];
        durMs: number[];
      };
    }
  | {
      kind: "audio_done";
      turnId: string;
    }
  | {
      /**
       * A line the brain wants said without having been asked anything.
       *
       * The HUD opens a turn of its own for it and speaks it through the normal
       * `say` path, so no turn id is invented on the server and the page keeps
       * deciding when its own voice is free. Used for what cannot wait for the
       * next question -- a fix that fell over while nobody was watching.
       */
      kind: "announce";
      text: string;
      /** Absent means Dutch, like everywhere else. */
      lang?: SpeechLang;
    }
  | {
      /**
       * What one block of the context panel should show now.
       *
       * Sent when a tool answers with figures, not on a schedule and not per
       * turn: the panel is a standing answer to "what are we talking about", so
       * a block stays up until the same subject is read again. No turn id,
       * because the blocks outlive the turn that summoned them.
       *
       * `topic` is the subject the figures belong to rather than the server
       * they came from: the house pack answers about the weather, the agenda
       * and the rooms, and those are three blocks on the panel, not one that
       * keeps overwriting itself.
       */
      kind: "tiles";
      /** The server whose figures these are, kept for diagnostics. */
      source: string;
      /** The subject these figures belong to, e.g. "weather". */
      topic: string;
      /** What that subject is called on screen, e.g. "Weather". */
      topicLabel: string;
      tiles: HudTile[];
    }
  | {
      /** Whether the brain can transcribe; false means the browser should. */
      kind: "listen";
      available: boolean;
      reason?: string;
    }
  | {
      kind: "transcript";
      text: string;
      /** False while still being revised, true once the sentence settled. */
      final: boolean;
    }
  | {
      kind: "done";
      turnId: string;
      /** Milliseconds from receiving the utterance to finishing the answer. */
      durationMs: number;
      /**
       * The answer ended in a question, so a reply is likely. The HUD keeps the
       * microphone open longer than it would after a plain statement.
       */
      expectsReply: boolean;
    }
  | {
      kind: "error";
      /** Absent when the failure is not tied to a specific turn. */
      turnId?: string;
      /** Safe to show to the user. */
      message: string;
    }
  | {
      /**
       * Result of the health checks that run when a connection opens: one row
       * per tool server, each probed against its real dependency rather than
       * assumed present. Sent after `ready`, once the probes come back.
       */
      kind: "health";
      checks: Array<{
        server: string;
        /** ok: probed and answered; down: probed and failed; off: not configured. */
        state: "ok" | "down" | "off";
        /** Safe to show: what answered, or why it did not. */
        detail: string;
        /** How long the probe took; absent for off and in-process rows. */
        ms?: number;
        /**
         * Whether this row came from a pack rather than from core itself.
         *
         * The HUD's tour answers "what can you do here" out of this list, and
         * the two rows core always contributes are not an answer to it: a
         * deployment that can reach nothing still has a display and a memory.
         */
        pack?: boolean;
      }>;
    }
  | {
      kind: "metrics";
      metrics: BrainMetrics;
    }
  | {
      /** How much of the claude.ai plan is spent, as far as the brain has heard. */
      kind: "usage";
      usage: PlanUsage;
    };

/** One of the plan's metered windows. */
export interface PlanWindow {
  /** Share of the window used, 0-100, or null when only its state is known. */
  utilization: number | null;
  /** When it opens again, ISO 8601, or null when not said. */
  resetsAt: string | null;
}

/**
 * The state of the claude.ai plan the assistant runs on.
 *
 * Two windows are metered, five hours and seven days, and whichever fills
 * first is the one that stops the conversation. `binding` names it when the
 * API has; the pill in the HUD shows both when both are known.
 */
export interface PlanUsage {
  status: "ok" | "warning" | "rejected";
  binding: "session" | "week" | null;
  session: PlanWindow | null;
  week: PlanWindow | null;
  /** When this was learned. */
  at: string;
}

/**
 * What the brain measures about itself, for the HUD's own panel.
 *
 * Every field may be `null`, and a null is shown as "not measured" rather than
 * as a zero. That is the same rule the self checks follow: a reading that could
 * not be taken is no opinion, never a number somebody might believe.
 */
export interface BrainMetrics {
  /** Resident memory of the brain process. */
  rssBytes: number | null;
  /** CPU since the previous sample, as a share of one core. Null on the first. */
  cpuShare: number | null;
  /** How long this process has been up. */
  uptimeMs: number | null;
  /** Share of the filesystem holding the database that is in use. */
  diskUsed: number | null;
}

/** Stages the HUD shows while a turn is being handled. */
export type PipelineStage = "stt" | "llm" | "tool" | "memory" | "tts";

export type WsMessage = ClientMessage | ServerMessage;

const GONE_REASONS: readonly DisplayGone[] = [
  "closed",
  "timeout",
  "next-turn",
  "replaced",
  "aged-out",
];

/** Narrows unknown JSON to a ClientMessage. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;

  if (value["kind"] === "utterance") {
    const { text, turnId } = value;
    if (typeof text !== "string" || typeof turnId !== "string") return null;
    if (text.trim() === "" || turnId === "") return null;
    return { kind: "utterance", text, turnId };
  }

  if (value["kind"] === "say") {
    const { text, turnId, lang } = value;
    if (typeof text !== "string" || typeof turnId !== "string") return null;
    if (text.trim() === "" || turnId === "") return null;
    if (lang !== undefined && lang !== "nl" && lang !== "en") return null;
    return lang === undefined
      ? { kind: "say", text, turnId }
      : { kind: "say", text, turnId, lang };
  }

  if (value["kind"] === "listen_start") return { kind: "listen_start" };
  if (value["kind"] === "listen_stop") return { kind: "listen_stop" };

  if (value["kind"] === "listen_audio") {
    const { data } = value;
    if (typeof data !== "string" || data === "") return null;
    return { kind: "listen_audio", data };
  }

  if (value["kind"] === "cancel") {
    const { turnId } = value;
    if (typeof turnId !== "string" || turnId === "") return null;
    return { kind: "cancel", turnId };
  }

  if (value["kind"] === "display_closed") {
    const { id, reason } = value;
    if (typeof id !== "string" || id === "") return null;
    if (!GONE_REASONS.includes(reason as DisplayGone)) return null;
    return { kind: "display_closed", id, reason: reason as DisplayGone };
  }

  return null;
}
