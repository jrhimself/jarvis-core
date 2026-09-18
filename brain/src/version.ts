/**
 * What this brain is running.
 *
 * Read from the package manifest rather than written down a second time: a
 * version repeated in the front-end's markup is a version that goes stale, and
 * one that had drifted three releases behind is exactly what this replaces.
 *
 * The manifest is the repository's, not `brain`'s own. The workspaces carry a
 * version nobody bumps -- a release tags the root and writes the root's number
 * in the changelog -- so reading `brain/package.json` reported 0.1.0 through
 * ten releases, which is the drift this file exists to prevent.
 *
 * Never throws. A build without a readable manifest is odd but not a reason to
 * refuse a websocket, so the answer is simply unknown.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | null = null;

export function brainVersion(): string {
  if (cached !== null) return cached;

  try {
    // brain/dist/version.js -> the repository root's package.json
    const manifest = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    const version =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    cached = typeof version === "string" && version !== "" ? version : "unknown";
  } catch {
    cached = "unknown";
  }
  return cached;
}
