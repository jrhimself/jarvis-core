/**
 * The publication gate's mailbox rule, exercised against a throwaway checkout.
 *
 * Addresses are assembled at runtime. A literal one in this file would be the
 * thing the gate fails on, and the gate does not print what it matched, so the
 * assertions look for the rule name and for the address being absent.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const script = path.resolve(import.meta.dirname, "check-no-house-facts.sh");

function address(local: string, domain: string): string {
  return `${local}@${domain}`;
}

const CURSOR_AGENT = address("cursoragent", "cursor.com");
const DEPENDABOT = address("support", "github.com");
const NOREPLY = address("1+dev", "users.noreply.github.com");
const PERSONAL = address("ada", "mailbox-check.org");

function env(extra?: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.DENYLIST_EXTRA;
  base.GIT_CONFIG_GLOBAL = "/dev/null";
  base.GIT_CONFIG_SYSTEM = "/dev/null";
  base.GIT_AUTHOR_NAME = "Test";
  base.GIT_AUTHOR_EMAIL = address("dev", "example.com");
  base.GIT_COMMITTER_NAME = "Test";
  base.GIT_COMMITTER_EMAIL = address("dev", "example.com");
  if (extra !== undefined) base.DENYLIST_EXTRA = extra;
  return base;
}

interface Outcome {
  status: number;
  output: string;
}

function execFailure(error: unknown): { status: number; stdout: string; stderr: string } | null {
  if (typeof error !== "object" || error === null) return null;
  if (!("status" in error) || !("stdout" in error) || !("stderr" in error)) return null;
  const { status, stdout, stderr } = error;
  if (typeof status !== "number") return null;
  if (typeof stdout !== "string" || typeof stderr !== "string") return null;
  return { status, stdout, stderr };
}

function scan(message: string, file = "plain\n", extra?: string): Outcome {
  const dir = mkdtempSync(path.join(tmpdir(), "no-house-facts-"));
  const run = env(extra);
  try {
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: dir, env: run });
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", address("dev", "example.com"));
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(dir, "README"), file);
    git("add", "README");
    git("commit", "-q", "-m", message);
    try {
      const stdout = execFileSync("bash", [script, "--path", dir, "--since", ""], {
        env: run,
        encoding: "utf8",
      });
      return { status: 0, output: stdout };
    } catch (error) {
      const failed = execFailure(error);
      if (failed === null) throw error;
      return { status: failed.status, output: `${failed.stdout}${failed.stderr}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertClean(outcome: Outcome): void {
  assert.equal(outcome.status, 0, outcome.output);
  assert.match(outcome.output, /no-house-facts: clean/);
  assert.doesNotMatch(outcome.output, /mailbox/);
}

function assertMailbox(outcome: Outcome, rule: "message-mailbox" | "mailbox"): void {
  assert.equal(outcome.status, 1, outcome.output);
  assert.match(outcome.output, new RegExp(`^  ${rule}:`, "m"));
  // The gate reports where, never what. A leaked address would be the failure.
  assert.equal(outcome.output.includes(PERSONAL), false);
  assert.equal(outcome.output.includes(CURSOR_AGENT), false);
  assert.equal(outcome.output.includes(DEPENDABOT), false);
}

test("a Cursor agent Co-authored-by trailer is the forge, not a mailbox", () => {
  assertClean(scan(`Let a gate through.\n\nCo-authored-by: Cursor Agent <${CURSOR_AGENT}>`));
});

test("Dependabot's Signed-off-by trailer is the forge, not a mailbox", () => {
  assertClean(scan(`deps: bump a fixture\n\nSigned-off-by: dependabot[bot] <${DEPENDABOT}>`));
});

test("a noreply address on a Co-authored-by trailer stays allowed", () => {
  assertClean(scan(`A commit.\n\nCo-authored-by: Dev <${NOREPLY}>`));
});

test("a forge may capitalise the trailer prefix however it likes", () => {
  assertClean(
    scan(`A commit.\n\nco-authored-by: Cursor Agent <${CURSOR_AGENT}>\nsigned-off-by: dependabot[bot] <${DEPENDABOT}>`),
  );
});

test("a person's address on a Co-authored-by trailer is still a mailbox", () => {
  assertMailbox(scan(`A commit.\n\nCo-authored-by: Ada Lovelace <${PERSONAL}>`), "message-mailbox");
});

test("a person's address on a Signed-off-by trailer is still a mailbox", () => {
  assertMailbox(scan(`A commit.\n\nSigned-off-by: Ada Lovelace <${PERSONAL}>`), "message-mailbox");
});

test("a person's address in the message, beside a service trailer, is still a mailbox", () => {
  const message = `Write to ${PERSONAL} about it.\n\nCo-authored-by: Cursor Agent <${CURSOR_AGENT}>\nSigned-off-by: dependabot[bot] <${DEPENDABOT}>`;
  assertMailbox(scan(message), "message-mailbox");
});

test("a service address written in the message itself is still a mailbox", () => {
  assertMailbox(scan(`The sign-off uses ${DEPENDABOT} and ${CURSOR_AGENT}.`), "message-mailbox");
});

test("a person's address in a tracked file is still a mailbox", () => {
  assertMailbox(scan("A commit with a clean message.", `${PERSONAL}\n`), "mailbox");
});

test("a service address in a tracked file is still a mailbox", () => {
  assertMailbox(scan("A commit with a clean message.", `${CURSOR_AGENT}\n${DEPENDABOT}\n`), "mailbox");
});

test("a private pattern still fails a commit whose only address is a service trailer", () => {
  const outcome = scan(
    `deps: bump fixture-word-that-is-private\n\nSigned-off-by: dependabot[bot] <${DEPENDABOT}>`,
    "plain\n",
    "fixture-word-that-is-private",
  );
  assert.equal(outcome.status, 1, outcome.output);
  assert.match(outcome.output, /message-private-1/);
  assert.doesNotMatch(outcome.output, /message-mailbox/);
  assert.match(outcome.output, /1 private pattern\(s\) from DENYLIST_EXTRA/);
});
