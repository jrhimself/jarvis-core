/**
 * What every request costs before anyone has said anything.
 *
 * The system prompt and the tool definitions are sent again with each turn, so
 * they are the one part of the bill that grows quietly: a paragraph added to the
 * persona in March is still being paid for in August, and a tool added last week
 * costs its description on every "goedemorgen". Nothing measured this, so the
 * question "is the persona too big" could only be answered by opinion.
 *
 * It can now be answered by running this. The numbers come from the same
 * builders the agent uses -- `serverSpecs` decides which servers this deployment
 * actually registers -- so what is printed is what is sent, not what the source
 * could send in some other configuration.
 *
 * Token counts are an estimate. There is no Claude tokenizer in this process,
 * and installing one to count a prompt nobody is paying for by the character
 * would be a strange trade. Characters are exact; treat the token column as the
 * order of magnitude it is.
 *
 * Usage: node dist/prompt-size-cli.js
 */

import { z } from "zod";

import { proactiveAtLeast } from "./config.js";

import { loadConfig, type Config } from "./config.js";
import { describeDeployment, deploymentBlock } from "./deployment.js";
import { createDisplayServer, showVia } from "./display-tool.js";
import { createHome } from "./home/index.js";
import { memory, type MemoryStore } from "./memory/store.js";
import { recipesBlock } from "./memory/recipes.js";
import { coreBlock, createMemoryServer } from "./memory/tools.js";
import { loadPacks, notRunning, packsRoot } from "./packs/loader.js";
import { loadPersona } from "./persona.js";
import { createInsightServer } from "./proactive/insight-tools.js";
import { createSetupServer, SETUP_SERVER_NAME } from "./setup-tools.js";
import { locale } from "@jarvis/shared";

/**
 * Characters per token, for Dutch prose with English tool descriptions mixed in.
 * A rough divisor on purpose: see the header.
 */
const CHARS_PER_TOKEN = 3.6;

/** A context getter for a server that is built to be measured, never called. */
function unused(): never {
  throw new Error("prompt-size builds the tool servers to measure them, never to run them");
}

interface RegisteredTool {
  description?: string;
  inputSchema?: unknown;
}

/**
 * The servers core builds itself, as opposed to the ones packs bring.
 *
 * Only the ones this deployment would actually register: an unconfigured server
 * costs nothing per request, and a table that lists it would suggest otherwise.
 */
function coreServers(config: Config, store: MemoryStore): Record<string, unknown> {
  return {
    display: createDisplayServer(() => {}, createHome(config)),
    memory: createMemoryServer(store),
    ...(proactiveAtLeast(config.proactive, "observe") ? { insight: createInsightServer(store) } : {}),
  };
}

function tokens(chars: number): string {
  return `~${Math.round(chars / CHARS_PER_TOKEN).toLocaleString(locale())}`;
}

function count(chars: number): string {
  return chars.toLocaleString(locale());
}

function row(label: string, chars: number, extra = ""): void {
  console.log(`  ${label.padEnd(30)}${count(chars).padStart(9)}${tokens(chars).padStart(10)}  ${extra}`);
}

/**
 * The description and the JSON schema of every tool on one server.
 *
 * `_registeredTools` is the MCP server's own bookkeeping and not a promise to
 * anybody, so a version that renames it costs this CLI and nothing else.
 */
function measureServer(server: unknown): { tools: number; description: number; schema: number } {
  const shape = server as { instance?: { _registeredTools?: Record<string, RegisteredTool> } };
  const registered = shape.instance?._registeredTools;
  if (registered === undefined) return { tools: 0, description: 0, schema: 0 };

  let description = 0;
  let schema = 0;
  for (const tool of Object.values(registered)) {
    description += (tool.description ?? "").length;
    try {
      schema += JSON.stringify(z.toJSONSchema(tool.inputSchema as never, { io: "input" })).length;
    } catch {
      // A schema that will not convert is worth less than a CLI that stops.
    }
  }
  return { tools: Object.keys(registered).length, description, schema };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = memory(config.memoryPath);

  try {
    const home = createHome(config);
    const packs = await loadPacks(packsRoot, {
      store,
      config,
      display: showVia(() => {}),
      home,
      turn: () => null,
    });

    const loaded = loadPersona();
    const persona = loaded.text;
    const core = coreBlock(store);
    const recipes = recipesBlock(store);
    const packPersona = packs.persona.join("\n\n");
    const computed = (await Promise.all(packs.blocks.map((block) => block()))).join("\n\n");

    const measured = { ...coreServers(config, store), ...packs.servers };
    const record = describeDeployment(
      config,
      packs.reports,
      [...Object.keys(measured), SETUP_SERVER_NAME],
      loaded.own,
    );
    const deployment = deploymentBlock(record);
    const servers = { ...measured, [SETUP_SERVER_NAME]: createSetupServer(record, unused) };

    console.log("\nWat er in elke aanvraag zit, voordat er iets gezegd is.");

    console.log("\nSysteem-prompt");
    row("persona", persona.length);
    row("deployment", deployment.length, `${packs.reports.length} packs bekeken`);
    row("pack-persona", packPersona.length, `${packs.persona.length} packs`);
    row("kernfeiten", core.length, `${store.core().length} feiten`);
    row("pack-blokken", computed.length, computed.length === 0 ? "geen" : "");
    row("recipes", recipes.length);
    const promptChars =
      persona.length +
      deployment.length +
      packPersona.length +
      core.length +
      computed.length +
      recipes.length;
    row("samen", promptChars);

    console.log("\nTools");
    console.log(
      `  ${"server".padEnd(14)}${"tools".padStart(6)}${"tekst".padStart(9)}` +
        `${"schema".padStart(9)}${"samen".padStart(9)}${"tokens".padStart(10)}`,
    );

    let toolChars = 0;
    let toolCount = 0;
    for (const [name, server] of Object.entries(servers)) {
      const measured = measureServer(server);
      const together = measured.description + measured.schema;
      toolChars += together;
      toolCount += measured.tools;
      console.log(
        `  ${name.padEnd(14)}${String(measured.tools).padStart(6)}` +
          `${count(measured.description).padStart(9)}${count(measured.schema).padStart(9)}` +
          `${count(together).padStart(9)}${tokens(together).padStart(10)}`,
      );
    }
    console.log(
      `  ${"samen".padEnd(14)}${String(toolCount).padStart(6)}${"".padStart(18)}` +
        `${count(toolChars).padStart(9)}${tokens(toolChars).padStart(10)}`,
    );

    console.log("");
    row("totaal per aanvraag", promptChars + toolChars);
    console.log(
      `\nTokens zijn geschat op ${CHARS_PER_TOKEN} tekens elk. Tekens zijn exact; ` +
        "de tokenkolom is de orde van grootte.\n",
    );
    const idle = notRunning(packs.reports);
    if (idle.length > 0) {
      console.log("\nNiet geladen");
      for (const { name, reason } of idle) {
        console.log(`  ${name.padEnd(20)}${reason ?? ""}`);
      }
    }
  } finally {
    store.close();
  }
}

await main();
