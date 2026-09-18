/**
 * Keeping the write-ahead log from becoming the largest thing on disk.
 *
 * SQLite checkpoints on its own once the log passes a thousand pages, and that
 * part works: measured on the live database, 4,1 MB of write-ahead log held
 * only 308 pages of anything. What it never does is give the space back. The
 * file is reused in place, so its size is a high-water mark of the busiest
 * moment the database has ever had, and it only ever goes up.
 *
 * `TRUNCATE` is the checkpoint mode that also shortens the file. It costs
 * nothing when there is nothing to do -- the same measurement, truncated, is
 * zero bytes and 113 facts still there.
 *
 * This matters more from here on than it did: a rollup worker writing every
 * five minutes is a busier tenant than a conversation nobody is having.
 */

import { statSync } from "node:fs";

import type { MemoryStore } from "./store.js";

/** Fifteen minutes. Often enough to stay small, rare enough to be free. */
const INTERVAL_MS = 15 * 60_000;

/**
 * When a log that would not truncate is worth saying something about.
 *
 * Below this a busy checkpoint is ordinary — the backup CLI is a second process
 * on the same file and will lose the race sometimes. Above it, something is
 * holding a read open that should not be.
 */
const COMPLAIN_ABOVE_BYTES = 16 * 1024 * 1024;

export interface CheckpointResult {
  /** Size of the write-ahead log afterwards. */
  walBytes: number;
  /** How much shorter the file got. */
  freedBytes: number;
  /** True when another connection held it open and nothing was reclaimed. */
  busy: boolean;
}

function walSize(databasePath: string): number {
  try {
    return statSync(`${databasePath}-wal`).size;
  } catch {
    // Truncating to nothing removes the file on some platforms.
    return 0;
  }
}

/**
 * Folds the write-ahead log back into the database and shortens the file.
 *
 * `busy_timeout` is zero, which is what makes this safe to call from the event
 * loop: SQLite gives up immediately rather than blocking the process until a
 * reader goes away. A skipped checkpoint costs fifteen minutes, a blocked one
 * costs a conversation.
 */
export function checkpoint(store: MemoryStore, databasePath: string): CheckpointResult {
  const before = walSize(databasePath);
  const busy = store.checkpoint();
  const after = walSize(databasePath);
  return { walBytes: after, freedBytes: Math.max(0, before - after), busy };
}

/**
 * Runs the checkpoint on a timer for as long as the process lives.
 *
 * Unreferenced, so it never keeps Node alive on its own — a service with
 * nothing left to do should exit when systemd asks, not fifteen minutes later.
 */
export function startCheckpointing(store: MemoryStore, databasePath: string): () => void {
  const timer = setInterval(() => {
    try {
      const result = checkpoint(store, databasePath);
      if (result.busy && result.walBytes > COMPLAIN_ABOVE_BYTES) {
        console.warn(
          `memory: write-ahead log is ${(result.walBytes / 1024 / 1024).toFixed(1)} MB and ` +
            "would not truncate — something is holding a read open",
        );
      }
    } catch (error) {
      console.error("memory: could not checkpoint:", error);
    }
  }, INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
