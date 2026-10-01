/**
 * Which pull request the user means.
 *
 * Merging used to start from a task row: the fix JARVIS had written himself was
 * the only one he could be asked to land, so "merge it" needed nothing more than
 * `state = 'awaiting'`. A pull request a runner opened, one built for a pack, one
 * a person pushed by hand -- none of those has such a row, and every one of them
 * is a pull request the owner may reasonably ask for by name.
 *
 * So the way in is the sentence he said, and that sentence is matched against
 * what is actually open rather than parsed into a schema. Three ways, in the
 * order they are sure: a number said as a pull request number, then the branch,
 * then the words of the title. Two matches are a question and not a coin toss --
 * a merge cannot be taken back by asking again -- so an ambiguous reference
 * comes back as the candidates and nothing is merged.
 *
 * A bare number is only read as one when it is said as a pull request number.
 * "The one runner 11 made" names a runner, and merging pull request 11 because
 * of it would be the wrong change landed on a spoken yes meant for another.
 */

import type { PullRequest } from "./github.js";

/** Words that carry no information about which pull request is meant. */
const NOISE = new Set([
  "the", "that", "this", "one", "pull", "request", "pr", "merge", "please",
  "and", "for", "from", "with", "about", "its", "his", "her", "which",
  "de", "het", "een", "die", "dat", "van", "voor",
]);

/**
 * The pull request number a reference names, when it names one.
 *
 * Deliberately narrow: the whole reference, a `#25`, or a number that follows
 * the words for a pull request. Everything else is left to the matcher.
 */
export function pullNumber(reference: string): number | null {
  const text = reference.trim();
  const found =
    /^#?(\d{1,6})$/.exec(text) ??
    /#(\d{1,6})\b/.exec(text) ??
    /\b(?:pr|pull request|pull)s?\s*#?\s*(\d{1,6})\b/i.exec(text);
  if (found === null) return null;
  const number = Number(found[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** The words of a piece of text that say something about which one it is. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !NOISE.has(word));
}

/**
 * The open pull requests a reference could mean, best first.
 *
 * A number that is open ends it. Otherwise every candidate is scored on how
 * much of the reference its title and branch account for, and only the best,
 * which must account for at least half of it, come back. An empty reference
 * matches everything, which is how "merge the pull request" gets to "there is
 * exactly one" or to a question.
 */
export function matchPullRequests(reference: string, open: readonly PullRequest[]): PullRequest[] {
  const number = pullNumber(reference);
  if (number !== null) {
    const numbered = open.find((pull) => pull.number === number);
    if (numbered !== undefined) return [numbered];
  }

  const asked = words(reference);
  if (asked.length === 0) return [...open];

  const scored = open
    .map((pull) => {
      const haystack = `${pull.title} ${pull.branch}`.toLowerCase();
      const hit = asked.filter((word) => haystack.includes(word)).length;
      return { pull, score: hit / asked.length };
    })
    .filter((entry) => entry.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  const best = scored[0]?.score ?? 0;
  return scored.filter((entry) => entry.score === best).map((entry) => entry.pull);
}

/** One pull request in a line, for the model to read out or choose from. */
export function describePullRequest(pull: PullRequest): string {
  const state =
    pull.draft ? "still a draft"
    : pull.mergeable_state === "dirty" ? "conflicts with main"
    : pull.mergeable_state === "blocked" ? "its checks are not green yet"
    : pull.mergeable_state === "behind" ? "behind main"
    : "";
  return `#${pull.number} "${pull.title}" (${pull.branch}${state === "" ? "" : `, ${state}`}) ${pull.url}`;
}
