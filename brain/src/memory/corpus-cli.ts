/**
 * The nightly pass over the owner's notes. See `corpus.ts` for why it exists.
 *
 * Usage: node dist/memory/corpus-cli.js [directory] [--limit N]
 *
 * The limit is for the first pass over a corpus nobody has read yet: a hundred
 * and forty notes at once is a lot of quota in one go, and the notes that do not
 * fit are simply still unread next time.
 *
 * Like the importer and the backup, this stands in the brain package before
 * reading the config, because the memory path is resolved against the working
 * directory and running it from anywhere else would open a second, empty
 * database and report a clean run into nothing.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.js";
import { GIVE_UP, haikuDistil, ingestCorpus } from "./corpus.js";
import { memory } from "./store.js";
import { backfill } from "./tools.js";

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  process.chdir(join(here, "..", ".."));

  const config = loadConfig();
  const args = process.argv.slice(2);
  const flag = args.indexOf("--limit");
  const limit = flag === -1 ? Number.POSITIVE_INFINITY : Number(args[flag + 1]);
  if (!(limit > 0)) {
    console.error("corpus: --limit needs a positive number");
    process.exitCode = 1;
    return;
  }

  const positional = args.filter((arg, at) => !arg.startsWith("--") && at !== flag + 1);
  const dir = positional[0] ?? config.corpusDir;
  const store = memory(config.memoryPath);
  const before = store.counts();

  try {
    const report = await ingestCorpus(store, dir, haikuDistil(store), limit);
    await backfill(store);
    const after = store.counts();
    store.recordCorpusRun({
      at: new Date().toISOString(),
      ...report,
      factsBefore: before.facts,
      factsAfter: after.facts,
    });
    const line =
      `${report.scanned} notes, ${report.read} read, ${report.failed} failed; ` +
      `${report.written} facts written, ${report.skipped} left to their owner, ` +
      `${report.retired} retired, ${report.gone} notes gone; ` +
      `memory went from ${before.facts} to ${after.facts} facts`;
    console.log(`corpus: ${line}`);

    // A pass that read nothing is not a success. The corpus is a directory that
    // a transfer can leave empty, and a run reporting "0 notes, all fine" every
    // night for a month is exactly the silence this is meant to break. Nor is a
    // pass that gave up: three failures in a row is quota or the model, not the
    // notes, and the run stopped early with most of the corpus unseen.
    store.beat("corpus", report.scanned > 0 && report.failed < GIVE_UP, line);
  } catch (error) {
    store.beat("corpus", false, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    store.close();
  }
}

void main();
