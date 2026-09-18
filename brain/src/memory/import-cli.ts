/**
 * One-time import of the household knowledge that lives outside this project.
 *
 * The owner's own notes — everything told to a coding agent over the past months about the
 * house, the network, his habits and his projects — are the reason JARVIS can answer
 * anything on the first day instead of learning it all by being told again. That
 * material was curated by hand into the JSON files under `config/seeds/`, phrased the way a
 * spoken answer should sound and stripped of anything secret: no tokens, no
 * passwords, no keys.
 *
 * Safe to run more than once: facts upsert on subject and kind, so re-running after
 * editing a seed file updates the wording rather than duplicating the fact. Facts
 * JARVIS learned himself are never touched, because a seed never reuses their subject.
 *
 * Usage: node dist/memory/import-cli.js [seedDir]
 *
 * Both the seed directory and the database are found relative to this file rather
 * than the working directory. The config resolves the memory path against the
 * working directory, which is the brain package for the service; running this from
 * anywhere else would open a second, empty database and report a clean import into
 * nothing.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { memory, type FactKind } from "./store.js";

const KINDS: readonly FactKind[] = [
  "voorkeur",
  "feit",
  "persoon",
  "gewoonte",
  "conclusie",
  "lopend",
];

interface SeedFact {
  kind: FactKind;
  subject: string;
  body: string;
  core?: boolean;
}

function parseSeeds(path: string): SeedFact[] {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${path}: expected an array of facts`);
  }

  return parsed.map((entry, index) => {
    const where = `${path}[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${where}: expected an object`);
    }
    const fact = entry as Record<string, unknown>;

    const kind = fact["kind"];
    if (typeof kind !== "string" || !KINDS.includes(kind as FactKind)) {
      throw new Error(`${where}: kind must be one of ${KINDS.join(", ")}, got ${String(kind)}`);
    }
    const subject = fact["subject"];
    if (typeof subject !== "string" || subject.trim() === "") {
      throw new Error(`${where}: subject must be a non-empty string`);
    }
    const body = fact["body"];
    if (typeof body !== "string" || body.trim() === "") {
      throw new Error(`${where}: body must be a non-empty string`);
    }
    const core = fact["core"];
    if (core !== undefined && typeof core !== "boolean") {
      throw new Error(`${where}: core must be a boolean when present`);
    }

    return { kind: kind as FactKind, subject, body, core: core === true };
  });
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const seedDir = resolve(process.argv[2] ?? join(here, "..", "..", "..", "config", "seeds"));

  // Stand where the service stands, so the config resolves the same database.
  process.chdir(join(here, "..", ".."));
  const files = readdirSync(seedDir)
    .filter((name) => name.endsWith(".json"))
    .sort();

  if (files.length === 0) {
    console.error(`No seed files in ${seedDir}.`);
    process.exitCode = 1;
    return;
  }

  const facts: SeedFact[] = [];
  for (const file of files) {
    facts.push(...parseSeeds(join(seedDir, file)));
  }

  // A duplicated subject within one kind would silently overwrite its twin, so the
  // count would look right while a fact went missing. Catch it before writing.
  const seen = new Map<string, string>();
  for (const fact of facts) {
    const key = `${fact.kind}:${fact.subject.trim().toLowerCase()}`;
    const first = seen.get(key);
    if (first !== undefined) {
      throw new Error(`Duplicate subject "${fact.subject}" of kind ${fact.kind} in the seeds`);
    }
    seen.set(key, fact.subject);
  }

  const store = memory(loadConfig().memoryPath);
  const before = store.counts();

  for (const fact of facts) {
    store.remember({
      kind: fact.kind,
      subject: fact.subject,
      body: fact.body,
      core: fact.core,
      source: "owner",
      reason: "imported",
    });
  }

  const after = store.counts();
  console.log(
    `imported ${facts.length} facts from ${files.length} files; ` +
      `memory went from ${before.facts} to ${after.facts} facts (${after.core} core)`,
  );
  console.log("restart the brain so the new facts get their embeddings.");
}

main();
