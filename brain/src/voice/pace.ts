/**
 * Timings for audio that came without any.
 *
 * A recorded line is played back from a file, and a file knows how long it is
 * but not where its words fall. The HUD paces the transcript on per-character
 * timings when it has them and on a guessed speaking rate when it does not,
 * and a guess that is wrong by a fifth puts every later word a fifth late for
 * the rest of the turn. Spreading the line's characters evenly over its length
 * is not where the words fall either, but it starts and ends where the sound
 * does, so nothing that follows inherits an error.
 */

import type { Alignment } from "./types.js";

/** Samples per second of the raw PCM the voices produce and the HUD plays. */
export const PCM_RATE = 16_000;
/** Bytes per sample: signed 16-bit. */
const PCM_WIDTH = 2;

/** How long a raw 16 kHz mono PCM clip plays, in milliseconds. */
export function pcmDurationMs(bytes: number): number {
  return (bytes / (PCM_RATE * PCM_WIDTH)) * 1000;
}

/** The text's characters spread evenly over the clip, one timing each. */
export function spreadAlignment(text: string, durationMs: number): Alignment | undefined {
  const chars = Array.from(text);
  if (chars.length === 0 || !(durationMs > 0)) return undefined;
  const step = durationMs / chars.length;
  return {
    chars,
    startMs: chars.map((_c, i) => Math.round(i * step)),
    durMs: chars.map(() => Math.round(step)),
  };
}
