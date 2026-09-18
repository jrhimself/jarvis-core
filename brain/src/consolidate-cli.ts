/**
 * Entry point for the weekly memory consolidation pass.
 *
 * Run by hand while iterating, and by jarvis-consolidate.timer in
 * production. Loads config the same way the server does, opens the memory
 * store, runs one consolidation pass, and prints a summary of what changed.
 *
 * `node dist/consolidate-cli.js recipes` runs only the recipe pass, which is
 * cheap and touches no facts — handy while tuning it.
 */

import { loadConfig } from "./config.js";
import { consolidate } from "./memory/consolidate.js";
import { learnRecipes } from "./memory/recipes.js";
import { memory } from "./memory/store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = memory(config.memoryPath);

  const only = process.argv[2];

  try {
    if (only === "recipes") {
      await learnRecipes(store);
      return;
    }

    const summary = await consolidate(store);
    const line =
      `merged ${summary.merged}, dropped ${summary.dropped}, ` +
      `rewritten ${summary.rewritten}, promoted ${summary.promoted}, demoted ${summary.demoted}`;
    console.log(`memory: consolidation done — ${line}`);

    // Same cadence on purpose: a recipe is only worth writing once a question
    // pattern has actually repeated, which takes days rather than turns.
    await learnRecipes(store);
    store.beat("consolidate", true, line);
  } catch (error) {
    store.beat("consolidate", false, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error("memory: consolidation run failed:", error);
  process.exitCode = 1;
});
