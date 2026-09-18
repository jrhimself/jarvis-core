/**
 * What the brain can honestly say about itself, cheaply and often.
 *
 * The HUD used to show a panel of numbers that were generated rather than
 * measured -- a random walk labelled CPU and memory. In a program whose persona
 * says never to invent a value, a dashboard that invents one is the worst place
 * to leave that. So either the numbers are real or the panel does not claim
 * them.
 *
 * Everything here is read from this process and this filesystem, with no
 * subprocess and no network, because it runs every few seconds for every open
 * page. `null` is an honest answer throughout: a reading that could not be
 * taken is shown as an em dash rather than as a zero, the same rule the self
 * checks follow.
 *
 * Deliberately not here: anything about the house, which is what the health
 * probes are for, and anything needing `systemctl` or `git`, which is what the
 * hourly self checks are for. This is the cheap half.
 */

import { statfsSync } from "node:fs";
import { dirname } from "node:path";

import type { BrainMetrics } from "@jarvis/shared";

/** How often a connected HUD is sent a fresh set. */
export const METRICS_INTERVAL_MS = 5_000;

/**
 * CPU as a share of one core since the previous reading.
 *
 * A cumulative counter is useless on a dashboard -- it only ever rises -- so
 * what is reported is the difference between two samples over the wall clock
 * between them. The first call has nothing to compare against and says `null`.
 */
let previous: { cpu: NodeJS.CpuUsage; at: number } | null = null;

function cpuShare(): number | null {
  const cpu = process.cpuUsage();
  const at = Date.now();
  const last = previous;
  previous = { cpu, at };

  if (last === null) return null;
  const elapsedMs = at - last.at;
  if (elapsedMs <= 0) return null;

  const usedMs = (cpu.user - last.cpu.user + (cpu.system - last.cpu.system)) / 1000;
  return Math.max(0, usedMs / elapsedMs);
}

/** Share of the filesystem holding the database that is in use. */
function diskUsed(memoryPath: string): number | null {
  try {
    const stats = statfsSync(dirname(memoryPath));
    if (stats.blocks === 0) return null;
    return (stats.blocks - stats.bfree) / stats.blocks;
  } catch {
    return null;
  }
}

/** Everything the panel shows, taken now. */
export function readMetrics(memoryPath: string): BrainMetrics {
  return {
    rssBytes: process.memoryUsage().rss,
    cpuShare: cpuShare(),
    uptimeMs: Math.round(process.uptime() * 1000),
    diskUsed: diskUsed(memoryPath),
  };
}
