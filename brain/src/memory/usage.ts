/**
 * What a turn cost.
 *
 * Every call to the SDK ends with a `result` message that carries the tokens,
 * the cache hits and the dollars for that call. Until now it was thrown away,
 * which left the most basic question about this assistant — what does an evening
 * of talking to it actually cost, and where does the latency go — unanswerable.
 *
 * This module does the reading. Recording is the store's job, and both the
 * conversation and the background passes hand their result message here.
 */

import type { MemoryStore, UsageKind } from "./store.js";

export interface UsageRecord {
  kind: UsageKind;
  sessionId: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  durationMs: number | null;
  firstTextMs: number | null;
  toolCalls: number;
}

/** Reads a nested property without asserting the whole shape of the message. */
function pick(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Which model did the work.
 *
 * `modelUsage` is keyed by full model id and often holds more than one entry: a
 * Sonnet turn still bills a little Haiku for the harness's own housekeeping.
 * Taking the first key reported every turn as Haiku, so the busiest entry wins
 * instead — the tokens below are the total across all of them either way.
 */
function modelOf(message: unknown): string | null {
  const usage = pick(message, "modelUsage");
  if (typeof usage !== "object" || usage === null) return null;

  let winner: string | null = null;
  let most = -1;
  for (const [model, spend] of Object.entries(usage as Record<string, unknown>)) {
    const total =
      num(pick(spend, "inputTokens")) +
      num(pick(spend, "outputTokens")) +
      num(pick(spend, "cacheReadInputTokens")) +
      num(pick(spend, "cacheCreationInputTokens"));
    if (total > most) {
      most = total;
      winner = model;
    }
  }
  return winner;
}

/**
 * Turns a `result` message into a record, or null when it is not one.
 *
 * Costs are read from the message rather than computed from a price table:
 * the SDK already knows the rates, and a table here would go stale silently.
 */
export function usageFromResult(
  message: unknown,
  extra: {
    kind: UsageKind;
    sessionId?: string | null;
    firstTextMs?: number | null;
    toolCalls?: number;
  },
): UsageRecord | null {
  if (pick(message, "type") !== "result") return null;

  const usage = pick(message, "usage");
  const duration = pick(message, "duration_ms");

  return {
    kind: extra.kind,
    sessionId: extra.sessionId ?? null,
    model: modelOf(message),
    inputTokens: num(pick(usage, "input_tokens")),
    outputTokens: num(pick(usage, "output_tokens")),
    cacheRead: num(pick(usage, "cache_read_input_tokens")),
    cacheWrite: num(pick(usage, "cache_creation_input_tokens")),
    costUsd: num(pick(message, "total_cost_usd")),
    durationMs: typeof duration === "number" ? Math.round(duration) : null,
    firstTextMs: extra.firstTextMs ?? null,
    toolCalls: extra.toolCalls ?? 0,
  };
}

/**
 * Records the cost of a one-shot background call.
 *
 * The distiller and the consolidator both iterate their own query; this saves
 * them from repeating the plumbing. Failing to write a metric must never break
 * the pass that produced it, so everything here is swallowed.
 */
export function recordUsage(store: MemoryStore, message: unknown, kind: UsageKind): void {
  try {
    const record = usageFromResult(message, { kind });
    if (record !== null) store.recordUsage(record);
  } catch (error) {
    console.error("usage: could not record:", error);
  }
}
