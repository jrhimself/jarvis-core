/**
 * The rules that keep a self-modifying assistant inside his mandate.
 *
 * These are the tests that matter most in this feature, and the reason the
 * guard is a pure module: everything below runs without a model, a network or a
 * repository, so there is no version of "it passed locally" that hides a hole.
 *
 * Two properties are being defended. That a job which is not a small fix is
 * never called one -- the classification side. And that a change which turned
 * out not to be a small fix is thrown away even though it was called one -- the
 * escalation side, which is the only thing standing between a worker that
 * wandered and a pull request the owner is asked to approve.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  branchName,
  budgetVerdict,
  classify,
  DAILY_LIMIT,
  escalation,
  isProtected,
  MAX_FILES,
  protectedAmong,
  slugify,
  type TaskShape,
} from "../dist/dev/guard.js";

/** A job that is small in every way, to vary one thing at a time from. */
function small(overrides: Partial<TaskShape> = {}): TaskShape {
  return {
    repo: "jarvis",
    files: ["brain/src/persona.ts"],
    needsNewDependency: false,
    needsNewSecret: false,
    needsOutsideWork: false,
    ...overrides,
  };
}

test("a one-file change in his own code is a small fix", () => {
  assert.equal(classify(small()).size, "small");
});

test("a shape that names no files is never small", () => {
  const verdict = classify(small({ files: [] }));
  assert.equal(verdict.size, "big");
  assert.match(verdict.size === "big" ? verdict.reason : "", /bestanden/);
});

test("work outside his own repository is never small", () => {
  const verdict = classify(small({ repo: "other" }));
  assert.equal(verdict.size, "big");
  assert.match(verdict.size === "big" ? verdict.reason : "", /eigen code/);
});

test("a new package, a new secret or another machine each make it big", () => {
  for (const key of ["needsNewDependency", "needsNewSecret", "needsOutsideWork"] as const) {
    const verdict = classify(small({ [key]: true }));
    assert.equal(verdict.size, "big", `${key} should escalate`);
  }
});

test("more files than a small fix may span is big", () => {
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => `brain/src/f${i}.ts`);
  assert.equal(classify(small({ files })).size, "big");
});

test("the confirmation boundary is protected even though the change is one line", () => {
  // The case this whole list exists for: "vraag niet meer om bevestiging bij het
  // alarm" is the smallest possible diff and the one that must never be small.
  // It is caught by the pack rule now rather than by a line naming this file,
  // which is the same verdict for a better reason.
  const verdict = classify(small({ files: ["packs/hass/src/control.ts"] }));
  assert.equal(verdict.size, "big");
  assert.match(verdict.size === "big" ? verdict.reason : "", /beschermde code/);
});

test("the guard cannot rewrite itself, its tests, or the deploy path", () => {
  for (const path of [
    "brain/src/dev/guard.ts",
    "brain/src/dev/run.ts",
    "brain/src/dev-tools.ts",
    "brain/test/dev-guard.test.ts",
    "scripts/self-deploy.sh",
    "deploy/jarvis-brain.service",
    ".github/workflows/fat.yml",
    "package.json",
    "brain/package.json",
    "package-lock.json",
  ]) {
    assert.equal(isProtected(path), true, `${path} should be protected`);
  }
});

test("ordinary source is not protected", () => {
  for (const path of [
    "brain/src/persona.ts",
    "brain/src/proactive/self.ts",
    "hud/public/app.js",
    "CHANGELOG.md",
    "brain/test/config.test.ts",
  ]) {
    assert.equal(isProtected(path), false, `${path} should not be protected`);
  }
});

test("a path that merely starts like a protected one is not protected", () => {
  // "brain/src/dev/" is a subtree; "brain/src/development.ts" is not in it.
  assert.equal(isProtected("brain/src/development.ts"), false);
  assert.equal(isProtected("packages/thing.ts"), false);
});

test("every pack is protected, whoever wrote it", () => {
  // Not a judgement about any one pack. None of them is in this repository, so
  // a fix that reached for one would be editing something the pull request
  // cannot show -- as true of the house's confirmation guard as of a
  // credentialled pack for somebody else's system.
  assert.equal(isProtected("packs/bridge/src/code.ts"), true);
  assert.equal(isProtected("packs/hass/src/tools.ts"), true);
  assert.equal(isProtected("packs/weather/src/forecast.ts"), true);
  assert.equal(isProtected("packs/delegate-ssh/pack.json"), true);
});

test("a leading ./ or a windows separator does not slip past the list", () => {
  assert.equal(isProtected("./packs/hass/src/control.ts"), true);
  assert.equal(isProtected("brain\\src\\dev\\guard.ts"), true);
});

test("protectedAmong reports every offender, in order", () => {
  assert.deepEqual(
    protectedAmong(["brain/src/persona.ts", "package.json", "packs/hass/src/control.ts"]),
    ["package.json", "packs/hass/src/control.ts"],
  );
});

test("a finished change that touched protected code is thrown away", () => {
  const verdict = escalation(["brain/src/persona.ts", "packs/hass/src/control.ts"]);
  assert.match(String(verdict), /beschermde code/);
});

test("a change that grew past the file limit is thrown away", () => {
  const changed = Array.from({ length: MAX_FILES + 1 }, (_, i) => `brain/src/f${i}.ts`);
  assert.match(String(escalation(changed)), /bestanden/);
});

test("a worker that changed nothing is not offered as a pull request", () => {
  assert.match(String(escalation([])), /niets gewijzigd/);
});

test("a clean small change survives escalation", () => {
  assert.equal(escalation(["brain/src/persona.ts", "brain/test/persona.test.ts"]), null);
});

test("the daily budget stops the fourth fix of the day", () => {
  assert.equal(budgetVerdict(DAILY_LIMIT - 1, false).size, "small");
  assert.equal(budgetVerdict(DAILY_LIMIT, false).size, "big");
});

test("two fixes never run at the same time", () => {
  const verdict = budgetVerdict(0, true);
  assert.equal(verdict.size, "big");
  assert.match(verdict.size === "big" ? verdict.reason : "", /al met een andere/);
});

test("a branch name keeps the words and folds the accents", () => {
  assert.equal(slugify("Voeg de accu van de robotstofzuiger toe"), "voeg-de-accu-van-de-robotstofzuiger");
  assert.equal(slugify("één regel erbij"), "een-regel-erbij");
  assert.equal(slugify("!!!"), "fix");
});

test("branch names carry a stamp so a repeated request does not collide", () => {
  const first = branchName("zelfde vraag", new Date("2026-08-27T21:04:00Z"));
  const second = branchName("zelfde vraag", new Date("2026-08-27T21:05:00Z"));
  assert.match(first, /^jarvis\/zelfde-vraag-/);
  assert.notEqual(first, second);
});
