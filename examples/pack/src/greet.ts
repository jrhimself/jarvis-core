/**
 * The one tool this pack has, and the line behind it.
 *
 * Why this is not in `index.ts`: a pack's own `npm test` runs `node --test`
 * straight over the source, with no build. Node's type stripping does not
 * rewrite `./config.js` into `./config.ts`, so any module that imports a
 * *value* from a sibling cannot be reached from a test at all. This one imports
 * a type, which is stripped, and is handed its configuration as an argument.
 *
 * So: logic here, wiring in `index.ts`. The wiring is the part that stays
 * untested, and it is the part small enough to read in one go.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { answer, type HudTile, type PackDisplay } from "@jarvis/shared";

import type { ExampleConfig } from "./config.js";

/**
 * The MCP server name, and the directory name this pack installs into.
 *
 * The loader insists the two match, and it refuses a pack that claims a name
 * already registered rather than letting one quietly replace another's tools.
 */
export const EXAMPLE_SERVER_NAME = "example";

/**
 * The tools to pre-approve, as patterns the agent matches against.
 *
 * A tool left off this list still exists; the assistant has to ask before it
 * uses it. Everything here is a read, so all of it is pre-approved. A pack that
 * can switch something off lists only what cannot do harm and leaves the rest
 * to be confirmed in a later turn.
 */
export const EXAMPLE_TOOLS = [`mcp__${EXAMPLE_SERVER_NAME}__*`];

const PARTS = [
  { until: 6, line: "goedenacht" },
  { until: 12, line: "goedemorgen" },
  { until: 18, line: "goedemiddag" },
  { until: 24, line: "goedenavond" },
];

/**
 * The line the tool returns, which is also the word the window waits for.
 *
 * A tool returns fact and lets the assistant phrase it. The clock is passed in
 * rather than read here, because a function that reads the clock itself can
 * only be tested at the hour the test happens to run.
 *
 * Exported because it is the anchor as well as the reading: an anchor has to be
 * a word the spoken answer certainly contains, and the only way to be sure of
 * that is to take it from the answer rather than to guess at it.
 */
export function partOf(at: Date): string {
  return (PARTS.find((candidate) => at.getHours() < candidate.until) ?? PARTS[3]).line;
}

export function greeting(config: ExampleConfig, at: Date, name?: string): string {
  const who = (name ?? "").trim() || config.who;
  return `${partOf(at)} ${who}`;
}

/**
 * The same answer, labelled, for the HUD's context panel.
 *
 * Built from what the tool just worked out, never fetched again: these ride
 * along on the answer the tool is already returning, so a panel costs nothing
 * and can never disagree with what was said out loud. A tool with no figures in
 * its answer returns none and the panel keeps what it had.
 */
export function exampleFacts(config: ExampleConfig, at: Date): HudTile[] {
  return [
    { label: "Greeting", value: partOf(at) },
    { label: "Who", value: config.who, on: true },
  ];
}

export function createExampleServer(config: ExampleConfig, display: PackDisplay) {
  const greet = tool(
    "example_greet",
    "Groet iemand passend bij het tijdstip. Zonder naam: degene voor wie deze installatie draait.",
    { name: z.string().optional().describe("Wie er gegroet wordt.") },
    async (args: { name?: string }) => {
      const now = new Date();
      const line = greeting(config, now, args.name);

      // Six tiles are a glance; a window is the thing itself. One line hardly
      // needs one, and it is here because a pack that never calls `display`
      // reads as if a pack could not. The third argument is the anchor: the
      // window is held back until the answer says that word, so it lands under
      // the sentence it belongs to rather than seconds before it.
      display({ type: "text", title: "Greeting", body: line }, { mode: "next-turn" }, partOf(now));

      return answer(line, exampleFacts(config, now));
    },
  );

  return createSdkMcpServer({ name: EXAMPLE_SERVER_NAME, version: "1.0.0", tools: [greet] });
}
