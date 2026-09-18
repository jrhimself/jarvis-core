/**
 * Reading the owner's own notes into the memory JARVIS answers from.
 *
 * Everything the owner works on with a coding agent leaves a note behind: how the
 * network hangs together, why the dryer needed a watchdog, which mistake not to
 * make twice. Those notes are written on another machine and kept in sync to a
 * directory here. They are the same material the seeds were curated from, except
 * they keep arriving, and hand-curating each one does not scale.
 *
 * Two things make that safe to automate.
 *
 * The notes are written *at* a coding agent -- an option to pass, a command never
 * to run -- and a spoken assistant that repeats them sounds like a runbook.
 * So a cheap model rewrites each note into facts about the owner and the house before
 * anything is written down. That is the same step the seeds got by hand.
 *
 * And a note is not the only thing with an opinion about a subject. The curated
 * seeds and the facts JARVIS distils from conversations use the same table, and a
 * note must never silently overwrite either. So a fact is only written when the
 * subject is free or already owned by a note -- ownership being what `corpus_facts`
 * records. That also gives deletions somewhere to land: a note that disappears
 * takes its facts with it, unless another note vouches for them too.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import { recordUsage } from "./usage.js";
import { loadConfig, ownerName } from "../config.js";
import type { FactKind, MemoryStore } from "./store.js";

const KINDS: readonly FactKind[] = [
  "voorkeur",
  "feit",
  "persoon",
  "gewoonte",
  "conclusie",
  "lopend",
];

/**
 * How much of one note the model gets to see.
 *
 * The longest notes are project journals of thirty kilobytes whose first
 * third holds the durable part and whose tail is a changelog. Cutting there
 * costs little and bounds what a runaway file can spend.
 */
const MAX_CHARS = 12_000;

/** Facts per note. A note that seems to hold twenty is a note being paraphrased. */
const MAX_FACTS = 6;

/** Failures in a row that mean the problem is not the note. */
export const GIVE_UP = 3;

/** The index file is a list of links to the other notes; there is no fact in it. */
const SKIP = new Set(["MEMORY.md", "CLAUDE.md"]);

const instructions = (owner: string) => `Je leest één notitie uit de eigen aantekeningen van ${owner}. Die notities zijn
geschreven vóór een programmeerassistent: ze staan vol instructies, commando's en paden. Jij bent de
spraakassistent in zijn huis. Jouw taak is eruit halen wat jij later in een gesprek zou moeten weten,
en dat te herschrijven als feiten over ${owner}, het huis of de spullen daarin — niet als opdrachten aan een
programmeur.

Dus niet: "zet de opmaak van een melding altijd op html".
Maar wel: "Meldingen uit het huis gaan via een berichtenkanaal; die zijn een keer stilgevallen door
een verkeerde opmaakinstelling en werken sindsdien weer."

Bewaar alleen wat duurzaam is: hoe het huis in elkaar zit, welke apparatuur er staat en waar,
gewoontes en voorkeuren van ${owner}, projecten waaraan wordt gewerkt en waarom, en problemen die zijn
opgelost of nog spelen. Namen van machines, IP-adressen en versienummers mogen erin als ze bij het
feit horen.

Laat weg:
- wachtwoorden, tokens, sleutels — ook als ze in de notitie staan
- letterlijke commando's, code, en stap-voor-stap instructies
- dingen die alleen tijdens één klus waar waren
- de notitie zelf ("in dit bestand staat…")

Antwoord met JSON en niets anders:
[{"kind": "<een van: ${KINDS.join(", ")}>", "subject": "<kort label, max 60 tekens>",
"body": "<één of twee zinnen, Nederlands, zoals je het hardop zou zeggen>"}]

Hooguit ${MAX_FACTS} feiten, en liever drie goede dan zes magere. Staat er niets duurzaams in, geef dan
een lege array.`;

export interface Note {
  /** Path relative to the corpus directory — the key a fact is filed under. */
  path: string;
  text: string;
  hash: string;
}

export interface Proposal {
  kind: FactKind;
  subject: string;
  body: string;
}

/** Turns one note into the facts worth keeping from it. */
export type Distil = (note: Note) => Promise<Proposal[]>;

export interface CorpusReport {
  /** Notes found in the directory. */
  scanned: number;
  /** Notes that changed since last time and were read by the model. */
  read: number;
  /** Facts written or rewritten. */
  written: number;
  /** Facts left alone because a seed or JARVIS himself owns that subject. */
  skipped: number;
  /** Facts dropped because no note says them any more. */
  retired: number;
  /** Notes that no longer exist. */
  gone: number;
  /** Notes the model would not read. They keep their old hash and come round again. */
  failed: number;
}

/** Strips the frontmatter block, which is bookkeeping rather than content. */
export function withoutFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return text;
  return text.slice(end + 4).trimStart();
}

/**
 * Every note in the directory, hashed as it reads right now.
 *
 * `.original.md` files are the human-readable backups the compression tool
 * leaves behind, so ingesting them would file everything twice.
 */
export function readNotes(dir: string): Note[] {
  const notes: Note[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      if (entry.name.endsWith(".original.md")) continue;
      if (SKIP.has(entry.name)) continue;

      const text = readFileSync(full, "utf8");
      notes.push({
        path: relative(dir, full),
        text,
        hash: createHash("sha256").update(text).digest("hex"),
      });
    }
  };

  walk(dir);
  return notes.sort((a, b) => a.path.localeCompare(b.path));
}

function isProposal(item: unknown): item is Proposal {
  if (typeof item !== "object" || item === null) return false;
  const value = item as Record<string, unknown>;
  return (
    typeof value["kind"] === "string" &&
    KINDS.includes(value["kind"] as FactKind) &&
    typeof value["subject"] === "string" &&
    value["subject"].trim().length > 1 &&
    typeof value["body"] === "string" &&
    value["body"].trim().length > 2
  );
}

/** Reads the model's answer, which is a JSON array somewhere in some prose. */
export function parseProposals(text: string): Proposal[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isProposal).slice(0, MAX_FACTS);
}

/** The distillation that actually calls a model. */
export function haikuDistil(store: MemoryStore): Distil {
  return async (note) => {
    const body = withoutFrontmatter(note.text).slice(0, MAX_CHARS);
    let answer = "";

    for await (const message of query({
      prompt: `Notitie "${note.path}":\n\n${body}`,
      options: {
        model: "haiku",
        systemPrompt: instructions(ownerName(loadConfig())),
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
      },
    })) {
      recordUsage(store, message, "distil");
      const value = message as { type?: string; message?: { content?: unknown } };
      if (value.type !== "assistant") continue;
      const content = value.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") answer += b.text;
      }
    }

    return parseProposals(answer);
  };
}

/**
 * Drops a fact a note used to claim, unless something else still claims it.
 *
 * Returns whether it went. The revision is kept either way, so a note deleted
 * by accident is recoverable from the panel.
 */
function retire(store: MemoryStore, factId: number): boolean {
  if (store.corpusClaims(factId) > 0) return false;
  const gone = store.forget(factId, "deleted");
  if (gone) store.releaseCorpusFact(factId);
  return gone;
}

/**
 * Reads the corpus and brings the memory in line with it.
 *
 * Unchanged notes cost nothing: the hash decides, before any model is asked.
 */
export async function ingestCorpus(
  store: MemoryStore,
  dir: string,
  distil: Distil,
  /** Stop after this many changed notes. The rest keep until the next pass. */
  limit = Number.POSITIVE_INFINITY,
): Promise<CorpusReport> {
  const notes = readNotes(dir);
  const report: CorpusReport = {
    scanned: notes.length,
    read: 0,
    written: 0,
    skipped: 0,
    retired: 0,
    gone: 0,
    failed: 0,
  };
  const present = new Set(notes.map((note) => note.path));
  let inARow = 0;

  for (const note of notes) {
    if (store.corpusHash(note.path) === note.hash) continue;
    if (report.read >= limit) break;

    let proposals: Proposal[];
    try {
      proposals = await distil(note);
      inARow = 0;
    } catch (error) {
      console.error(`corpus: could not read ${note.path}:`, error);
      report.failed += 1;
      inARow += 1;
      // Three in a row is not three bad notes, it is the quota or the network.
      // Carrying on would burn through the whole corpus failing; the notes that
      // were not read still have their old hash and come round again tomorrow.
      if (inARow >= GIVE_UP) {
        console.error(`corpus: ${GIVE_UP} notes failed in a row — stopping this pass`);
        break;
      }
      continue;
    }
    report.read += 1;

    const before = store.corpusFactIds(note.path);
    const owned: number[] = [];

    for (const proposal of proposals) {
      const subject = proposal.subject.trim().slice(0, 60);
      const existing = store.bySubject(subject, proposal.kind);

      // A subject the seeds or JARVIS himself already own is not a note's to
      // take. Curated wording outranks a rewrite of a note about the same thing.
      if (existing !== null && store.corpusClaims(existing.id) === 0) {
        report.skipped += 1;
        continue;
      }

      const fact = store.remember({
        kind: proposal.kind,
        subject,
        body: proposal.body.trim().slice(0, 400),
        source: "owner",
        reason: "imported",
      });
      // The wording is new, so whatever vector it had answers the wrong question.
      // The caller backfills in one pass rather than loading the model per fact.
      store.clearVector(fact.id);
      owned.push(fact.id);
      report.written += 1;
    }

    store.recordCorpusFile(note.path, note.hash, owned);

    // What this note used to say and no longer does.
    for (const id of before) {
      if (!owned.includes(id) && retire(store, id)) report.retired += 1;
    }
  }

  // Notes that were deleted or renamed on the other machine.
  for (const path of store.corpusPaths()) {
    if (present.has(path)) continue;
    const orphans = store.corpusFactIds(path);
    store.dropCorpusFile(path);
    report.gone += 1;
    for (const id of orphans) {
      if (retire(store, id)) report.retired += 1;
    }
  }

  return report;
}
