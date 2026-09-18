/**
 * Prints what JARVIS has been costing.
 *
 * The numbers come from the `usage` table, which the conversation and the
 * background passes write to after every call. Meant to be run over ssh on the
 * container; the HUD has the same numbers over /api/usage.
 *
 * Usage: node dist/usage-cli.js [days]
 */

import { loadConfig } from "./config.js";
import { memory, type MemoryStore, type UsageTotals } from "./memory/store.js";
import { formatLocal, locale } from "@jarvis/shared";

function euro(dollars: number): string {
  return `$${dollars.toFixed(4)}`;
}

function thousands(value: number): string {
  return value.toLocaleString(locale());
}

function ms(value: number | null): string {
  return value === null ? "—" : `${(value / 1000).toFixed(1)}s`;
}

function table(title: string, totals: UsageTotals[]): void {
  console.log(`\n${title}`);
  if (totals.length === 0) {
    console.log("  (niets gemeten)");
    return;
  }

  console.log("  kind          calls     in    out  cache-read  cache-write     cost   median  1e tekst");
  for (const row of totals) {
    console.log(
      `  ${row.kind.padEnd(12)}${String(row.calls).padStart(6)}` +
        `${thousands(row.inputTokens).padStart(7)}${thousands(row.outputTokens).padStart(7)}` +
        `${thousands(row.cacheRead).padStart(12)}${thousands(row.cacheWrite).padStart(13)}` +
        `${euro(row.costUsd).padStart(9)}${ms(row.medianMs).padStart(9)}${ms(row.medianFirstTextMs).padStart(10)}`,
    );
  }
  const cost = totals.reduce((sum, row) => sum + row.costUsd, 0);
  const calls = totals.reduce((sum, row) => sum + row.calls, 0);
  console.log(`  ${"totaal".padEnd(12)}${String(calls).padStart(6)}${" ".repeat(39)}${euro(cost).padStart(9)}`);
}

function since(days: number): string {
  const from = new Date();
  if (days === 0) from.setHours(0, 0, 0, 0);
  else from.setTime(from.getTime() - days * 24 * 60 * 60 * 1000);
  return from.toISOString();
}

function recent(store: MemoryStore): void {
  console.log("\nLaatste beurten");
  const rows = store.usageRecent(15);
  if (rows.length === 0) {
    console.log("  (niets gemeten)");
    return;
  }
  for (const row of rows) {
    const at = formatLocal(new Date(row.at), { dateStyle: "short", timeStyle: "medium" });
    console.log(
      `  ${at}  ${row.kind.padEnd(11)} ${ms(row.durationMs).padStart(6)} ` +
        `1e ${ms(row.firstTextMs).padStart(6)}  ${String(row.toolCalls)} tools  ` +
        `in ${thousands(row.inputTokens)} (cache ${thousands(row.cacheRead)}) uit ${thousands(row.outputTokens)}  ${euro(row.costUsd)}`,
    );
  }
}

function main(): void {
  const days = Number(process.argv[2] ?? "7");
  const config = loadConfig();
  const store = memory(config.memoryPath);

  try {
    table("Vandaag", store.usageTotals(since(0)));
    table(`Laatste ${Number.isFinite(days) ? days : 7} dagen`, store.usageTotals(since(Number.isFinite(days) ? days : 7)));
    recent(store);
  } finally {
    store.close();
  }
}

main();
