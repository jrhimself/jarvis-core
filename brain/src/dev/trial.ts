/**
 * Trying a pull request live before it is merged.
 *
 * The self-deploy boundary only ever ran what was already on `origin/main`, so
 * an ability a runner had just built sat unused until somebody reviewed and
 * merged it -- and the owner could not judge it without trying it. A trial is
 * the one exception, and it is narrow on purpose: the brain may ask the root
 * side to put *one open pull request* on top of what is running now, by its
 * number, and to take it off again. The root side fetches the pull request
 * itself, merges it onto the running commit, runs the suite and the types, and
 * rolls back on any failure; nothing the brain writes is executed but a number.
 *
 * What makes it the owner's decision rather than the brain's is the tool that
 * asks for it: it needs his yes, and JARVIS asks for that yes out loud when he
 * says the pull request is ready. The yes usually comes in the next question,
 * which starts from a session that never heard the unprompted sentence, so the
 * offer is kept here and put in front of that question, the way the screen
 * language offer is.
 *
 * Only one trial at a time. Two unmerged changes on top of each other are two
 * things to untangle when one of them misbehaves, and "take it off again" has
 * to have one meaning.
 */

import type { DatabaseSync } from "node:sqlite";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { REQUEST_FILE } from "./deploy.js";

/** Where a pull request lives: the assistant's own code, or one pack. */
export type PullTarget =
  | { repo: "core"; number: number }
  | { repo: "pack"; pack: string; number: number };

/** How a trial is asked for: by the task that made the pull request, or by naming it. */
export interface TrialRequest {
  task?: number;
  /** The pull request in whatever words it was said in: a link, a slug and a number, a sentence. */
  reference?: string;
}

/** The file the root side writes while a trial is running, and removes when it ends. */
export const TRIAL_FILE = "trial.json";

/** What the root side says is running on trial. */
export interface Trial {
  target: PullTarget;
  /** The commit the running code was on before the trial, to go back to. */
  base: string;
  /** The merged commit that runs now. */
  sha: string;
  /** When it went live, ISO. */
  at: string;
}

/** A pack id as the root side accepts it. */
const PACK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The pull request a piece of text points at, when it says where it lives.
 *
 * A link is the surest ("github.com/o/jarvis-pack-gmail/pull/6"); everything
 * else is however a runner, a status line or the user happens to word it:
 * "Opened PR #6 on jarvis-pack-gmail", "jrhimself/jarvis-core#24", "PR 24
 * (jarvis-core)", "pull request 12 on the gmail pack". Rather than one pattern
 * per wording, both halves are looked for on their own -- every number that is
 * said to be a pull request, every repository that is named -- and the closest
 * pair wins. A number with no repository near it is still not enough: guessing
 * the wrong one would try a different pull request under the same number.
 */
export function pullRequestTarget(text: string): PullTarget | null {
  const link = /github\.com\/[\w.-]+\/(jarvis-core|jarvis-pack-([a-z0-9-]+))\/pull\/(\d+)/i.exec(text);
  if (link !== null) return target(link[1] ?? "", link[2], Number(link[3]));

  const repos = repoMentions(text);
  if (repos.length === 0) return null;
  let best: { target: PullTarget; distance: number } | null = null;
  for (const found of numberMentions(text)) {
    for (const repo of repos) {
      const distance = Math.abs(repo.at - found.at);
      if (distance > NEAR) continue;
      const made = target(repo.repo, repo.pack, found.number);
      if (made !== null && (best === null || distance < best.distance)) best = { target: made, distance };
    }
  }
  return best?.target ?? null;
}

/** How far apart a number and a repository may be and still be about each other. */
const NEAR = 60;

/** Every number said to be a pull request: "PR 24", "pull request #6", "#24". */
function numberMentions(text: string): { number: number; at: number }[] {
  const found: { number: number; at: number }[] = [];
  for (const match of text.matchAll(/(?:\bPRs?\b|\bpull requests?\b|#)[\s:#]*(\d+)\b/gi)) {
    found.push({ number: Number(match[1]), at: match.index });
  }
  return found;
}

/**
 * Every repository named, as a slug or in words.
 *
 * A slug counts anywhere; the spoken forms only after a word that points at
 * them ("on core", "on the gmail pack"), because a green core suite and a pack
 * that builds are mentioned in half the summaries a runner writes.
 */
function repoMentions(text: string): { repo: string; pack?: string; at: number }[] {
  const found: { repo: string; pack?: string; at: number }[] = [];
  for (const match of text.matchAll(/(?:[\w.-]+\/)?jarvis-pack-([a-z0-9-]+)/gi)) {
    found.push({ repo: "jarvis-pack", pack: match[1], at: match.index });
  }
  for (const match of text.matchAll(/(?:[\w.-]+\/)?jarvis-core\b/gi)) {
    found.push({ repo: "jarvis-core", at: match.index });
  }
  for (const match of text.matchAll(/\b(?:on|in|for|to|of)\s+(?:the\s+)?core\b|\b(?:the\s+)?assistant'?s own code\b/gi)) {
    found.push({ repo: "jarvis-core", at: match.index });
  }
  const spokenPack = /\b(?:on|in|for|to|of)\s+(?:the\s+)?(?:pack\s+([a-z0-9][a-z0-9-]*)|([a-z0-9][a-z0-9-]*)\s+pack)\b/gi;
  for (const match of text.matchAll(spokenPack)) {
    const id = (match[1] ?? match[2] ?? "").toLowerCase();
    if (!PACK_WORDS.has(id)) found.push({ repo: "jarvis-pack", pack: id, at: match.index });
  }
  return found;
}

/** Words that stand next to "pack" without being the name of one. */
const PACK_WORDS = new Set(["the", "a", "an", "this", "that", "it", "its", "and", "is", "was", "one", "own", "new"]);

function target(repo: string, pack: string | undefined, number: number): PullTarget | null {
  if (!Number.isInteger(number) || number <= 0) return null;
  if (repo.toLowerCase() === "jarvis-core") return { repo: "core", number };
  const id = (pack ?? "").toLowerCase();
  return PACK_ID.test(id) ? { repo: "pack", pack: id, number } : null;
}

/** Whether two targets are the same pull request. */
export function sameTarget(a: PullTarget | null, b: PullTarget | null): boolean {
  if (a === null || b === null || a.number !== b.number) return false;
  if (a.repo === "core") return b.repo === "core";
  return b.repo === "pack" && a.pack === b.pack;
}

/**
 * The repository a target lives in, as GitHub spells it.
 *
 * A pack is `<owner>/jarvis-pack-<id>` beside the assistant's own source, which
 * is the convention the pack tooling already assumes. A pack published under
 * another owner is GitHub's 404 to give, not a guess to make here.
 */
export function repoName(coreRepo: string, target: PullTarget): string {
  if (target.repo === "core") return coreRepo;
  const owner = coreRepo.split("/")[0] ?? "";
  return `${owner}/jarvis-pack-${target.pack}`;
}

/**
 * A target as one word, to carry between the turn that proposes a merge and the
 * turn that carries it out.
 */
export function targetKey(target: PullTarget): string {
  return target.repo === "core" ? `core#${target.number}` : `pack:${target.pack}#${target.number}`;
}

/** The other half of `targetKey`; anything else reads as nothing. */
export function readTargetKey(key: string): PullTarget | null {
  const match = /^(?:core|pack:([a-z0-9-]+))#(\d+)$/.exec(key.trim());
  if (match === null) return null;
  return target(match[1] === undefined ? "jarvis-core" : "jarvis-pack", match[1], Number(match[2]));
}

/** The one line the root side reads. */
export function trialLine(target: PullTarget | null): string {
  if (target === null) return "untry";
  return target.repo === "core" ? `try core ${target.number}` : `try pack ${target.pack} ${target.number}`;
}

/** A pull request as it is said out loud. */
export function describeTarget(target: PullTarget): string {
  return target.repo === "core"
    ? `pull request ${target.number} on the assistant's own code`
    : `pull request ${target.number} on the ${target.pack} pack`;
}

/** Asks the root side to start a trial, or with null, to end the one that runs. */
export async function requestTrial(
  dataDir: string,
  target: PullTarget | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await writeFile(join(dataDir, REQUEST_FILE), `${trialLine(target)}\n`, "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Could not ask for it: ${String(error)}` };
  }
}

/** Reads what the root side wrote about the running trial. */
export function readTrial(raw: string): Trial | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const number = Number(body.pr);
  const kind = body.kind;
  const pack = typeof body.pack === "string" ? body.pack : "";
  if (!Number.isInteger(number) || number <= 0) return null;
  const found: PullTarget | null =
    kind === "core" ? { repo: "core", number } : kind === "pack" && PACK_ID.test(pack) ? { repo: "pack", pack, number } : null;
  if (found === null) return null;
  return {
    target: found,
    base: typeof body.base === "string" ? body.base : "",
    sha: typeof body.sha === "string" ? body.sha : "",
    at: typeof body.at === "string" ? body.at : "",
  };
}

export async function currentTrial(dataDir: string): Promise<Trial | null> {
  const raw = await readFile(join(dataDir, TRIAL_FILE), "utf8").catch(() => null);
  return raw === null ? null : readTrial(raw);
}

/** The setting that holds an offer to try something, until a question takes it. */
const OFFER_SETTING = "dev.trial-offer";

/** How long an offer is worth answering: after that, a "yes" is about something else. */
export const OFFER_MS = 30 * 60_000;

/** Remembers that JARVIS just offered to put a task's pull request live. */
export function rememberOffer(db: DatabaseSync, task: number, said: string, now: Date): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(OFFER_SETTING, JSON.stringify({ task, said, at: now.getTime() }));
}

/**
 * The note for the next question, and the offer is spent.
 *
 * Spent whatever the question turns out to be: an offer answered with
 * something unrelated has been declined by being ignored, and repeating it in
 * front of every question for half an hour would make it a nag.
 */
export function takeTrialOffer(db: DatabaseSync, now: Date): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(OFFER_SETTING) as
    | { value: string }
    | undefined;
  if (row === undefined || row.value === "") return "";
  db.prepare("UPDATE settings SET value = '' WHERE key = ?").run(OFFER_SETTING);
  return offerNote(row.value, now);
}

/** Pure half of `takeTrialOffer`, for the tests. */
export function offerNote(stored: string, now: Date): string {
  let offer: { task?: unknown; said?: unknown; at?: unknown };
  try {
    offer = JSON.parse(stored) as typeof offer;
  } catch {
    return "";
  }
  const task = Number(offer.task);
  const at = Number(offer.at);
  if (!Number.isInteger(task) || !Number.isFinite(at) || now.getTime() - at > OFFER_MS) return "";
  const said = typeof offer.said === "string" ? offer.said : "";
  return (
    `[A moment ago you said to the user, unprompted: "${said}" If this answers yes, call ` +
    `try_pull_request with task ${task} and confirmed true -- and if that task turns out not to say ` +
    `which pull request it made, call it again naming the pull request itself; if it answers no, leave it.]`
  );
}
