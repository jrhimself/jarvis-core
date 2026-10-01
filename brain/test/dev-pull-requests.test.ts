/**
 * Merging a pull request that no task row knows about: which one a sentence
 * means, which repository it lives in, and what survives between the turn that
 * proposes the merge and the turn that carries it out.
 *
 * The case worth reading twice is the number that is not a pull request number.
 * "The one runner 11 made" names a runner, and a merge is not undone by asking
 * again, so a number only counts when it is said as a pull request number.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readPullRequest, type PullRequest } from "../dist/dev/github.js";
import { describePullRequest, matchPullRequests, pullNumber } from "../dist/dev/pull-requests.js";
import { readTargetKey, repoName, sameTarget, targetKey } from "../dist/dev/trial.js";

/** An open pull request with only the fields that decide a match. */
function pull(number: number, title: string, branch: string): PullRequest {
  return {
    number,
    url: `https://github.com/someone/jarvis-core/pull/${number}`,
    title,
    branch,
    headRepo: "someone/jarvis-core",
    state: "open",
    merged: false,
    draft: false,
    mergeable_state: "clean",
  };
}

const OPEN = [
  pull(25, "Try any pull request, not only one a task record carries", "trial-pr-by-ref"),
  pull(24, "Door watch: hold the camera for a minute, not two", "door-watch-minute"),
  pull(11, "Read the meter on the wall", "meter-reading"),
];

test("a number is only a pull request number when it is said as one", () => {
  assert.equal(pullNumber("25"), 25);
  assert.equal(pullNumber("#25"), 25);
  assert.equal(pullNumber("merge PR 25 please"), 25);
  assert.equal(pullNumber("pull request #25"), 25);
  assert.equal(pullNumber("the one runner 11 made"), null);
  assert.equal(pullNumber("the door watch one"), null);
});

test("a pull request said by number is the one that is merged", () => {
  assert.deepEqual(matchPullRequests("#25", OPEN), [OPEN[0]]);
  assert.deepEqual(matchPullRequests("merge pull request 24", OPEN), [OPEN[1]]);
});

test("a number that belongs to a runner does not pick the pull request with that number", () => {
  // The whole point: runner 11 built pull request 25, and merging 11 because of
  // the sentence would land somebody else's change on a yes meant for this one.
  assert.deepEqual(matchPullRequests("the one runner 11 built, trial-pr-by-ref", OPEN), [OPEN[0]]);
});

test("a branch or the words of a title finds it without a number", () => {
  assert.deepEqual(matchPullRequests("trial-pr-by-ref", OPEN), [OPEN[0]]);
  assert.deepEqual(matchPullRequests("the door watch one", OPEN), [OPEN[1]]);
});

test("a reference that fits nothing, or everything, is a question and not a guess", () => {
  assert.deepEqual(matchPullRequests("the washing machine timer", OPEN), []);
  assert.equal(matchPullRequests("", OPEN).length, OPEN.length);
});

test("a pull request keeps its title, its branch and where that branch lives", () => {
  const shaped = readPullRequest({
    number: 25,
    html_url: "https://github.com/someone/jarvis-core/pull/25",
    title: "Try any pull request",
    draft: true,
    head: { ref: "trial-pr-by-ref", repo: { full_name: "someone/jarvis-core" } },
  });
  assert.equal(shaped?.title, "Try any pull request");
  assert.equal(shaped?.branch, "trial-pr-by-ref");
  assert.equal(shaped?.headRepo, "someone/jarvis-core");
  assert.equal(shaped?.draft, true);

  // A payload without a head is still a pull request; it just has no branch to
  // delete afterwards.
  const bare = readPullRequest({ number: 1, html_url: "https://x/pull/1" });
  assert.equal(bare?.branch, "");
  assert.equal(bare?.headRepo, "");
  assert.equal(bare?.draft, false);
});

test("what is in the way of a merge is said in the line that offers it", () => {
  assert.match(describePullRequest({ ...pull(25, "Try it", "ref"), mergeable_state: "dirty" }), /conflicts with main/);
  assert.match(describePullRequest({ ...pull(25, "Try it", "ref"), draft: true }), /still a draft/);
  assert.match(describePullRequest(pull(25, "Try it", "ref")), /#25 "Try it" \(ref\)/);
});

test("a pull request survives between the turn that proposes it and the turn that merges it", () => {
  for (const target of [
    { repo: "core", number: 25 },
    { repo: "pack", pack: "gmail", number: 6 },
  ] as const) {
    assert.deepEqual(readTargetKey(targetKey(target)), target);
  }
  assert.equal(readTargetKey("25"), null);
  assert.equal(readTargetKey("core#0"), null);
  assert.equal(readTargetKey("pack:Gmail#6"), null);
});

test("two targets are the same pull request only when the repository is the same too", () => {
  assert.equal(sameTarget({ repo: "core", number: 6 }, { repo: "core", number: 6 }), true);
  assert.equal(sameTarget({ repo: "core", number: 6 }, { repo: "pack", pack: "gmail", number: 6 }), false);
  assert.equal(
    sameTarget({ repo: "pack", pack: "gmail", number: 6 }, { repo: "pack", pack: "hass", number: 6 }),
    false,
  );
  assert.equal(sameTarget(null, { repo: "core", number: 6 }), false);
});

test("a pack's pull request is merged in the pack's own repository", () => {
  assert.equal(repoName("someone/jarvis-core", { repo: "core", number: 25 }), "someone/jarvis-core");
  assert.equal(
    repoName("someone/jarvis-core", { repo: "pack", pack: "gmail", number: 6 }),
    "someone/jarvis-pack-gmail",
  );
});
