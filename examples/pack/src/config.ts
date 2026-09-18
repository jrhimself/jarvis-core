/** What this pack needs, read from the environment rather than from core. */
export interface ExampleConfig {
  /**
   * What the assistant should call whoever it is greeting.
   *
   * Empty means the pack is not configured, which is how a pack says "not on
   * this machine". Nothing is registered and nothing is said about it.
   */
  who: string;
}

/**
 * This pack's own settings, read from the environment.
 *
 * A pack outside core's repository cannot expect its keys to be in core's
 * `Config`, and should not want them there: it reads what it needs itself and
 * ignores whatever arrives in `context.config`. That is the whole reason a pack
 * can be installed without editing core.
 *
 * Prefix the names distinctively. They share a process with core's own
 * variables and with every other pack's.
 */
export function exampleConfig(): ExampleConfig {
  return { who: process.env["JARVIS_EXAMPLE_WHO"] ?? "" };
}
