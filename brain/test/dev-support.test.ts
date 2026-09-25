/**
 * The small pieces around the pipeline: what crosses the deploy boundary, what
 * GitHub is allowed to be trusted for, and what goes out over Telegram.
 *
 * The deploy check is the one worth reading twice. The brain writes a string
 * into a file that a root service reads, so "is this a commit hash" is a
 * security boundary rather than a validation nicety, and it is asserted from
 * both sides -- the shapes that must pass and the shapes that must not.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { isCommitSha, readDeployResult } from "../dist/dev/deploy.js";
import { readPullRequest } from "../dist/dev/github.js";
import { escapeHtml, failureMessage, reviewMessage, spokenFailure } from "../dist/dev/notify.js";
import { titleFor } from "../dist/dev/run.js";
import { abilityInstruction, describeTask, gapBrake } from "../dist/dev-tools.js";
import { workerPrompt } from "../dist/dev/worker.js";
import { run } from "../dist/dev/shell.js";
import { canPushBranches, linkDependencies } from "../dist/dev/worktree.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

test("only a full lowercase hex hash may be asked for", () => {
  assert.equal(isCommitSha(SHA), true);
  for (const bad of [
    "",
    SHA.slice(0, 39),
    `${SHA}0`,
    SHA.toUpperCase(),
    "main",
    `${SHA};rm -rf /`,
    `${SHA}\n${SHA}`,
    "../../etc/passwd",
  ]) {
    assert.equal(isCommitSha(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test("a deploy result that is not JSON, or is the wrong shape, reads as nothing", () => {
  assert.equal(readDeployResult("not json"), null);
  assert.equal(readDeployResult("null"), null);
  assert.equal(readDeployResult('{"ok":true}'), null);
});

test("a deploy result keeps its verdict and its step", () => {
  const result = readDeployResult(
    `{"sha":"${SHA}","ok":false,"step":"tests","at":"2026-08-27T21:00:00Z","detail":"1 failing"}`,
  );
  assert.equal(result?.ok, false);
  assert.equal(result?.step, "tests");
  assert.equal(result?.detail, "1 failing");
});

test("a pull request without a number or a link is not believed", () => {
  assert.equal(readPullRequest({}), null);
  assert.equal(readPullRequest({ number: 7 }), null);
  assert.equal(readPullRequest({ html_url: "https://x/pull/7" }), null);
});

test("a pull request is read as open unless GitHub says otherwise", () => {
  const open = readPullRequest({ number: 7, html_url: "https://x/pull/7" });
  assert.equal(open?.state, "open");
  assert.equal(open?.merged, false);

  const closed = readPullRequest({ number: 7, html_url: "https://x/pull/7", state: "closed", merged: true });
  assert.equal(closed?.state, "closed");
  assert.equal(closed?.merged, true);
});

test("a long spoken instruction becomes a title that fits on one line", () => {
  const long = "zorg dat je ook de accu van de robotstofzuiger noemt wanneer ik vraag hoe het ermee staat";
  assert.ok(titleFor(long).length <= 68);
  assert.match(titleFor(long), /\.\.\.$/);
  assert.equal(titleFor("  korte   vraag  "), "korte vraag");
});

test("Telegram gets HTML with the three special characters escaped", () => {
  assert.equal(escapeHtml('a & b < c > d'), "a &amp; b &lt; c &gt; d");
  const message = reviewMessage({
    instruction: "toon <accu> & tijd",
    prUrl: "https://github.com/jrhimself/jarvis/pull/9",
    summary: "Accu toegevoegd.",
    stat: "1 file changed",
  });
  assert.ok(!message.includes("<accu>"));
  assert.match(message, /&lt;accu&gt;/);
  assert.match(message, /<a href="https:\/\/github\.com\/jrhimself\/jarvis\/pull\/9">/);
});

test("a failure carries the output that caused it, escaped", () => {
  const message = failureMessage({
    instruction: "toon <accu> & tijd",
    detail: "de tests bleven rood",
    log: "not ok 3 - accu\n  expected <b>3</b>, got 4",
  });
  assert.match(message, /JARVIS' fix failed/);
  assert.match(message, /&lt;accu&gt;/);
  assert.match(message, /<pre>/);
  assert.match(message, /expected &lt;b&gt;3&lt;\/b&gt;/);
});

test("a fix the guard stopped is not called a failure", () => {
  const message = failureMessage({
    instruction: "iets",
    detail: "hij bleef aan beschermde bestanden komen",
    abandoned: true,
  });
  assert.match(message, /dropped a fix/);
  assert.ok(!message.includes("mislukt"));
});

test("nothing readable came out, so there is no empty block to look at", () => {
  for (const log of [undefined, null, "", "   \n\n  "]) {
    const message = failureMessage({ instruction: "iets", detail: "de poging brak af", log });
    assert.ok(!message.includes("<pre>"), `${JSON.stringify(log)} should not produce a block`);
  }
});

test("a long run is cut off at the front, because the end is what broke", () => {
  // Telegram refuses a message over 4096 characters outright, and a refusal here
  // looks exactly like the silence this notification exists to end.
  const log = Array.from({ length: 400 }, (_, index) => `regel ${index} ${"x".repeat(200)}`).join("\n");
  const message = failureMessage({ instruction: "iets", detail: "rood", log });
  assert.ok(message.length < 2000, `message was ${message.length} characters`);
  assert.match(message, /…/);
  assert.ok(!message.includes("regel 300 "), "an old line survived the cut");

  // Twenty short lines fit whole, and the last one is the one that matters.
  const short = Array.from({ length: 400 }, (_, index) => `regel ${index}`).join("\n");
  const kept = failureMessage({ instruction: "iets", detail: "rood", log: short });
  assert.match(kept, /regel 399/);
  assert.ok(!kept.includes("regel 379"));
});

test("the spoken sentence says what was attempted and what went wrong", () => {
  const spoken = spokenFailure({ instruction: "accu erbij", detail: "de tests bleven rood" });
  assert.match(spoken, /accu erbij/);
  assert.match(spoken, /de tests bleven rood/);
  // Spoken, so no markup and no wall of output. It also names no channel: which
  // ones a deployment has is `notify.ts`'s business, and a sentence promising
  // Telegram to somebody who has none is a sentence that lies.
  assert.ok(!spoken.includes("<"));
  assert.equal(/telegram/i.test(spoken), false);
});

test("a task waiting for approval is described with its link", () => {
  const spoken = describeTask({
    id: 1,
    createdAt: "",
    updatedAt: "",
    instruction: "accu erbij",
    size: "small",
    state: "awaiting",
    branch: "jarvis/accu",
    worktree: null,
    prUrl: "https://github.com/jrhimself/jarvis/pull/9",
    prNumber: 9,
    slot: null,
    detail: "1 file changed",
    log: null,
  });
  assert.match(spoken, /waiting for your approval/);
  assert.match(spoken, /pull\/9/);
});

test("a delegated task says which runner has it and why", () => {
  const spoken = describeTask({
    id: 2,
    createdAt: "",
    updatedAt: "",
    instruction: "wake word",
    size: "big",
    state: "delegated",
    branch: null,
    worktree: null,
    prUrl: null,
    prNumber: null,
    slot: 4,
    detail: "it needs a new package",
    log: null,
  });
  assert.match(spoken, /runner 4/);
  assert.match(spoken, /new package/);
});

test("the worker is told about every protected path by name", () => {
  // The prompt is a courtesy, not the enforcement -- but a worker that is never
  // told cannot avoid a rule, and then every attempt burns a quarter of an hour
  // before the guard throws it away.
  const prompt = workerPrompt();
  for (const path of ["packs/", "scripts/", "package-lock.json"]) {
    assert.ok(prompt.includes(path), `${path} should be named in the worker prompt`);
  }
  assert.match(prompt, /at most 4 files/);
});

test("a worktree's dependencies resolve outward, but its workspaces resolve inward", async () => {
  // The trap this guards against is silent and total: npm's workspace links are
  // relative, so symlinking node_modules wholesale would make @jarvis/brain
  // resolve back to the live sources and the suite would test the running code
  // instead of the change. A dotfile is in the fixture on purpose -- .bin is how
  // tsc is found, and a glob that skips dotfiles loses the compiler.
  const source = join(await mkdtemp(join(tmpdir(), "jarvis-src-")), "node_modules");
  await mkdir(join(source, "zod"), { recursive: true });
  await writeFile(join(source, "zod", "package.json"), JSON.stringify({ name: "zod", version: "1.0.0" }));
  await mkdir(join(source, ".bin"), { recursive: true });
  await writeFile(join(source, ".bin", "tsc"), "#!/bin/sh\n");
  await mkdir(join(source, "@jarvis"), { recursive: true });
  await symlink(join(source, "..", "brain"), join(source, "@jarvis", "brain"));

  const worktree = await mkdtemp(join(tmpdir(), "jarvis-wt-"));
  for (const workspace of ["brain", "hud", "shared"]) {
    await mkdir(join(worktree, workspace), { recursive: true });
    await writeFile(
      join(worktree, workspace, "package.json"),
      JSON.stringify({ name: `@jarvis/${workspace}`, version: "0.0.0" }),
    );
  }
  await linkDependencies(dirname(source), worktree);

  const require = createRequire(join(worktree, "brain", "anything.js"));
  assert.equal(require.resolve("zod/package.json"), join(source, "zod", "package.json"));
  assert.equal(
    require.resolve("@jarvis/shared/package.json"),
    join(worktree, "shared", "package.json"),
  );
  assert.equal(existsSync(join(worktree, "node_modules", ".bin", "tsc")), true);

  await rm(worktree, { recursive: true, force: true });
  await rm(dirname(source), { recursive: true, force: true });
});

test("a copy that may not push to its origin is told so before any work happens", async () => {
  // The case is somebody else's install: origin is the repository this was
  // copied from, and nothing there will take their branch. Asked here, it costs
  // a second; asked at the end of the pipeline it costs a quarter of an hour and
  // the commit.
  const root = await mkdtemp(join(tmpdir(), "jarvis-push-"));
  const repo = join(root, "repo");
  const upstream = join(root, "upstream.git");
  await mkdir(repo, { recursive: true });
  await run("git", ["init", "--quiet", "--bare", "--initial-branch=main", upstream], { cwd: root });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repo });
  await writeFile(join(repo, "file"), "content\n");
  await run("git", ["add", "file"], { cwd: repo });
  await run(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--quiet", "-m", "first"],
    { cwd: repo },
  );

  await run("git", ["remote", "add", "origin", join(root, "nowhere.git")], { cwd: repo });
  const refused = await canPushBranches(repo);
  assert.equal(refused.ok, false);

  await run("git", ["remote", "set-url", "origin", upstream], { cwd: repo });
  assert.deepEqual(await canPushBranches(repo), { ok: true });

  // A dry run leaves the remote as it found it.
  const refs = await run("git", ["ls-remote", "--heads", upstream], { cwd: root });
  assert.equal(refs.stdout.trim(), "");

  await rm(root, { recursive: true, force: true });
});

/** A task row with only the fields a test cares about spelled out. */
function task(state: string, id = 1): Parameters<typeof describeTask>[0] {
  return {
    id,
    createdAt: "",
    updatedAt: "",
    instruction: "read the clock",
    size: "small",
    state: state as never,
    branch: null,
    worktree: null,
    prUrl: null,
    prNumber: null,
    slot: 11,
    detail: "writing it",
    log: null,
    gap: "read-the-clock",
  };
}

test("a gap nobody is working on may be started", () => {
  assert.equal(gapBrake([], 0), null);
  assert.equal(gapBrake([task("failed")], 0), null);
});

test("a gap that is already being worked on is not started again", () => {
  for (const state of ["running", "awaiting", "delegated"]) {
    const brake = gapBrake([task(state)], 0);
    assert.match(String(brake), /already being worked on/, state);
  }
});

test("a gap tried twice this week goes to the owner instead of a third attempt", () => {
  const brake = gapBrake([task("failed", 2), task("finished", 1)], 0);
  assert.match(String(brake), /tried 2 times/);
  assert.match(String(brake), /ask how he wants it solved/);
});

test("a busy day stops new gaps, whichever they are", () => {
  assert.match(String(gapBrake([], 8)), /most in one day/);
  assert.equal(gapBrake([], 7), null);
});

test("a finished delegated job says what the runner left behind", () => {
  const spoken = describeTask({ ...task("finished"), detail: "PR 12 is open" });
  assert.match(spoken, /runner 11 finished it/);
  assert.match(spoken, /PR 12 is open/);
});

test("a missing ability becomes a job to build it, not to answer the request", () => {
  const job = abilityInstruction("search the web for current news", "what are the road works about?", true);
  assert.match(job, /^Give JARVIS the ability to search the web for current news, so that he does it himself/);
  assert.match(job, /not an answer to this one request/);
  assert.match(job, /put the answer in your DONE line too/);
  assert.doesNotMatch(abilityInstruction("read the clock", "time?", false), /DONE line/);
});
