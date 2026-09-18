/**
 * Nightly copy of what JARVIS has learned.
 *
 * The seeds under `config/seeds/` can rebuild the imported knowledge at any time, but
 * everything JARVIS worked out himself — the distilled facts, the conversation
 * summaries, the recipes, the metrics — exists in one file and nowhere else. A
 * consolidation pass that deletes too much, or a bad migration, would take it with
 * no way back. The container image is backed up by the host, but restoring the whole
 * container to recover one fact is not a thing anyone will actually do.
 *
 * Usage: node dist/memory/backup-cli.js [directory]
 *
 * Like the importer, this stands in the brain package before reading the config,
 * because the memory path is resolved against the working directory.
 */

import { DatabaseSync } from "node:sqlite";
import { formatter } from "@jarvis/shared";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { memory } from "./store.js";

/** memory-2026-08-22.db, and the same name with a time when that one is taken. */
const NAME = /^memory-\d{4}-\d{2}-\d{2}(-\d{4})?\.db$/;

/** Local rather than UTC: a backup made at one in the morning belongs to that night. */
function stamp(date: Date, withTime: boolean): string {
  const parts = formatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }, "sv-SE").formatToParts(date);

  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  return withTime ? `${day}-${get("hour")}${get("minute")}` : day;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Opens the copy and asks SQLite whether it is sound. Throws if it is not. */
function verify(path: string): { facts: number; turns: number } {
  const copy = new DatabaseSync(path, { readOnly: true });
  try {
    const check = copy.prepare("PRAGMA integrity_check").get() as unknown as {
      integrity_check: string;
    };
    if (check.integrity_check !== "ok") {
      throw new Error(`the copy failed its integrity check: ${check.integrity_check}`);
    }
    const one = (sql: string): number =>
      Number((copy.prepare(sql).get() as unknown as { n: number }).n);
    return { facts: one("SELECT count(*) AS n FROM facts"), turns: one("SELECT count(*) AS n FROM turns") };
  } finally {
    copy.close();
  }
}

/** Drops the oldest copies. Names sort chronologically, so the newest are the last. */
function prune(directory: string, keep: number): string[] {
  const all = readdirSync(directory)
    .filter((name) => NAME.test(name))
    .sort();

  const stale = all.slice(0, Math.max(0, all.length - keep));
  for (const name of stale) unlinkSync(join(directory, name));
  return stale;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const override = process.argv[2];
  process.chdir(join(here, "..", ".."));

  const config = loadConfig();
  const directory = override === undefined ? config.backupDir : resolve(override);

  const now = new Date();
  let target = join(directory, `memory-${stamp(now, false)}.db`);
  // A second run on the same day is a manual one, usually right before something
  // risky. It should not overwrite the night's copy, nor refuse to run.
  if (exists(target)) target = join(directory, `memory-${stamp(now, true)}.db`);

  const store = memory(config.memoryPath);
  try {
    store.backupTo(target);

    // Verified before it is called a success: a copy that exists and cannot be
    // opened is worse than no copy, because it is the one nobody checks.
    const counts = verify(target);
    const size = (statSync(target).size / 1024).toFixed(0);
    const dropped = prune(directory, config.backupKeep);

    const line =
      `${target}: ${size} kB, ${counts.facts} feiten, ${counts.turns} beurten` +
      (dropped.length > 0 ? `; ${dropped.length} oude verwijderd` : "");
    console.log(line);
    store.beat("backup", true, line);
  } catch (error) {
    store.beat("backup", false, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    store.close();
  }
}

main();
