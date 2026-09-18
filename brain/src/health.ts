/**
 * Health checks for the tool servers, run when a HUD connection opens.
 *
 * "brain connected" only ever said the websocket was up; whether the house, the
 * mail or anything else would actually answer was discovered mid-sentence, when
 * a tool failed with someone listening. These checks ask every dependency for
 * real, and the HUD shows the verdict per server.
 *
 * Which servers exist, and how to ask each one's dependency whether it is
 * there, both come from the packs. That is deliberate and was not always so: a
 * fixed list here repeated every pack's own `configured` rule, and a rule
 * written twice is a rule that drifts. A pack that registers a server and
 * declares no probe is reported healthy without being asked, which is right for
 * one that talks to nothing outside this process and wrong for anything else --
 * so a pack that reaches over a network and says nothing about it is a pack
 * with a bug, not a quiet one.
 *
 * Servers sharing a dependency share a probe function, and a function is run
 * once however many servers name it. A dead bridge costs one timeout rather
 * than three, and never delays the others.
 *
 * The expensive probes reuse the tools' own caches -- the forecast's half hour,
 * the mail token's lifetime -- so a HUD that reconnects all morning does not
 * spend API quota on reassurance.
 */

import { proactiveAtLeast, type Config } from "./config.js";
import type { MemoryStore } from "./memory/store.js";

export type HealthState = "ok" | "down" | "off";

export interface HealthCheck {
  server: string;
  state: HealthState;
  /** Safe to show: what answered, or why it did not. */
  detail: string;
  /** How long the probe took; absent for in-process rows. */
  ms?: number;
  /** Whether a pack put this row here; absent means core did. */
  pack?: boolean;
}

/** A probe resolves with what answered and throws with why it did not. */
export type Probe = () => Promise<string>;

/** One row on the health panel: a server, and how to ask after it. */
export interface ServerSpec {
  server: string;
  /** Null is in-process: nothing outside to ask, healthy by construction. */
  probe: Probe | null;
  /** Set by `specsFor` for the rows a pack contributed. */
  pack?: boolean;
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * How long a probe's verdict still counts for.
 *
 * Longer than the interval the watcher re-probes on, so a verdict is normally
 * replaced rather than left to expire. The window is what happens when nothing
 * is watching at all, and then the answer is "assume it answers and let the call
 * find out", which is what everything here did before.
 */
const VERDICT_WINDOW_MS = 12 * 60 * 1000;

const lastVerdict = new Map<string, { state: HealthState; at: number }>();

/**
 * Records what a server was last seen doing.
 *
 * Called by the probes, and by the pack transport when a tool call either
 * answers or runs out of time -- a tool that replied is a dependency that is up,
 * whatever the last probe thought of it.
 */
export function noteServer(server: string, state: HealthState): void {
  lastVerdict.set(server, { state, at: Date.now() });
}

/**
 * Whether a call to this server is worth making at all.
 *
 * A dependency that did not answer a probe will not answer a tool call either,
 * and it takes just as long to say so: with the bridge down, every turn that
 * touched work waited out three separate timeouts before the assistant could get
 * to the rest of the answer. A server nobody has probed, or whose verdict has
 * gone stale, counts as fine -- this skips what was measured to be down, it does
 * not guess.
 */
export function serverIsDown(server: string): boolean {
  const seen = lastVerdict.get(server);
  if (seen === undefined) return false;
  if (Date.now() - seen.at > VERDICT_WINDOW_MS) return false;
  return seen.state === "down";
}

/** Forgets every verdict, so one test cannot inherit another's. */
export function forgetVerdicts(): void {
  lastVerdict.clear();
}

/**
 * Fetches, and throws unless the answer is a success.
 *
 * Exported for the packs: a probe is the pack's own to write, and every one of
 * them otherwise starts by reinventing this with a different timeout.
 */
export async function expectOk(
  url: string,
  headers: Record<string, string>,
  who: string,
): Promise<void> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${who} returned ${response.status}`);
}

/**
 * The servers core provides itself, in the order the HUD shows them.
 *
 * Three at most. Everything else on the panel is a pack, and is there because
 * it started rather than because this file knows it exists.
 */
export function coreSpecs(config: Config, store: MemoryStore): ServerSpec[] {
  return [
    { server: "display", probe: null },
    {
      server: "memory",
      // Not a ping: `all(1)` runs a real query through the open SQLite handle.
      probe: async () => {
        store.all(1);
        return "database antwoordt";
      },
    },
    ...(proactiveAtLeast(config.proactive, "observe")
      ? [
          {
            server: "insight",
            probe: async () => {
              const counts = store.proactiveCounts();
              return `${counts.observations} observaties`;
            },
          },
        ]
      : []),
  ];
}

/**
 * Every row the panel should show for this deployment.
 *
 * A pack that is not running contributes nothing, rather than a row saying it
 * is off. The panel used to list what was switched off, which reads as a list
 * of things that are broken; what a deployment was never configured for is not
 * a fault, and the place that says so is the log line at startup.
 */
export function specsFor(
  config: Config,
  store: MemoryStore,
  packServers: readonly string[],
  packProbes: Readonly<Record<string, Probe>>,
): ServerSpec[] {
  return [
    ...coreSpecs(config, store),
    ...packServers.map((server) => ({ server, probe: packProbes[server] ?? null, pack: true })),
  ];
}

/** Runs every distinct probe once, side by side, and reports one row per server. */
export async function runHealthChecks(specs: readonly ServerSpec[]): Promise<HealthCheck[]> {
  // Keyed by function identity, so servers that share a dependency share the
  // one call and the one timeout.
  const verdicts = new Map<Probe, { state: HealthState; detail: string; ms: number }>();
  const distinct = new Set<Probe>();
  for (const spec of specs) {
    if (spec.probe !== null) distinct.add(spec.probe);
  }

  await Promise.all(
    [...distinct].map(async (probe) => {
      const started = Date.now();
      try {
        const detail = await probe();
        verdicts.set(probe, { state: "ok", detail, ms: Date.now() - started });
      } catch (error) {
        verdicts.set(probe, {
          state: "down",
          detail: error instanceof Error ? error.message : String(error),
          ms: Date.now() - started,
        });
      }
    }),
  );

  const checks = specs.map((spec) => {
    const from = spec.pack === true ? { pack: true } : {};
    if (spec.probe === null)
      return { server: spec.server, state: "ok" as const, detail: "in-process", ...from };
    const verdict = verdicts.get(spec.probe);
    // Unreachable while the set above is built from these same specs.
    if (verdict === undefined)
      return { server: spec.server, state: "down" as const, detail: "geen uitslag", ...from };
    return {
      server: spec.server,
      state: verdict.state,
      detail: verdict.detail,
      ms: verdict.ms,
      ...from,
    };
  });

  for (const check of checks) noteServer(check.server, check.state);
  return checks;
}
