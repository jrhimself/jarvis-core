/**
 * Which house, if any.
 *
 * One place decides that, so nothing above it has to ask twice. A brain with no
 * house configured gets `null` and works: it still talks, still remembers, still
 * reads the weather and the mail, still writes its own small fixes. What it must
 * not do is promise otherwise, which is why the answer is a value the rest of
 * the program can see rather than a flag each caller checks for itself.
 */

import type { ConnectionHooks, HomeProvider } from "@jarvis/shared";

import type { Config } from "../config.js";
import { HomeAssistant } from "./homeassistant/provider.js";

export { HomeAssistant } from "./homeassistant/provider.js";

/** Whether this configuration names a house at all. */
export function homeConfigured(config: Config): boolean {
  return config.haUrl !== "" && config.haToken !== "";
}

/**
 * The house this configuration describes, or null when it describes none.
 *
 * Home Assistant is the only implementation today. A second one would be chosen
 * here -- by configuration, not by probing -- and would have to advertise its
 * own capabilities; everything above this function already copes with the ones
 * it does not have.
 */
export function createHome(config: Config, hooks: ConnectionHooks = {}): HomeProvider | null {
  if (!homeConfigured(config)) return null;
  return new HomeAssistant(config.haUrl, config.haToken, hooks);
}
