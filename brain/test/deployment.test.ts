/**
 * What the assistant is allowed to say about itself.
 *
 * These tests exist because of one sentence spoken on a machine with no packs
 * and no credentials: "Home Assistant is already connected to me." Nothing was
 * broken -- the prompt simply said nothing about the deployment, so the model
 * answered from its character. Every case below is the same shape: a fact that
 * was not measured must not appear, and a fact that was must appear plainly.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { describeDeployment, deploymentBlock } from "../dist/deployment.js";
import { loadConfig } from "../dist/config.js";
import type { PackReport } from "../dist/packs/loader.js";
import { tempDir, withEnv } from "./helpers.ts";

/** The environment of a machine nobody has configured yet. */
const BARE = {
  HA_URL: undefined,
  HA_TOKEN: undefined,
  ELEVENLABS_API_KEY: undefined,
  JARVIS_NOTIFY_ENTITY: undefined,
  JARVIS_NOTIFY_WEBHOOK: undefined,
  JARVIS_PROACTIVE: undefined,
  JARVIS_WEB: undefined,
  JARVIS_DEV_REPO: undefined,
  GITHUB_TOKEN_JARVIS: undefined,
};

/** The record, with the environment the test says and nothing left over. */
function describe(
  env: Record<string, string | undefined>,
  packs: PackReport[] = [],
  root = tempDir(),
  ownPersona = true,
): string {
  return withEnv({ ...BARE, ...env }, () =>
    deploymentBlock(describeDeployment(loadConfig(), packs, ["display", "memory"], ownPersona, root)),
  );
}

/** A `config/packs.json` under `root`, as `packs-sync` would leave it. */
function manifest(root: string, ids: string[]): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "packs.json"),
    JSON.stringify({ packs: ids.map((id) => ({ id, repo: `git@example.com:${id}.git` })) }),
  );
}

test("a deployment with no house says so, and says what would give it one", () => {
  const block = describe({});

  assert.match(block, /core has no house: HA_URL and HA_TOKEN are empty/);
  assert.match(block, /set HA_URL and HA_TOKEN/);
});

test("credentials for the house are not a claim to have tools for it", () => {
  // The half-truth that started this. Core holding the connection is what the
  // observation layer needs; reading or changing anything is a pack's job, and
  // conflating the two is how "connected" gets said with nothing behind it.
  const block = describe({ HA_URL: "http://house", HA_TOKEN: "secret" });

  assert.match(block, /core itself can reach the house/);
  assert.match(block, /depends entirely on the packs/);
});

test("no packs is stated as no capabilities, not left to be inferred", () => {
  const block = describe({});

  assert.match(block, /Nothing is installed under packs\//);
  assert.match(block, /this machine has none/);
});

test("a pack that is off names the variables it is missing, and why", () => {
  const block = describe({}, [
    {
      name: "spotify",
      state: "off",
      reason: "not configured",
      summary: "plays music",
      needs: [{ env: "SPOTIFY_CLIENT_ID", why: "identifies the app to Spotify" }],
    },
  ]);

  assert.match(block, /SPOTIFY_CLIENT_ID \(identifies the app to Spotify\)/);
  assert.match(block, /is empty here/);
});

test("a pack that is off with every variable set does not invent a reason", () => {
  const block = describe({ SPOTIFY_CLIENT_ID: "set" }, [
    {
      name: "spotify",
      state: "off",
      reason: "not configured",
      needs: [{ env: "SPOTIFY_CLIENT_ID", why: "identifies the app to Spotify" }],
    },
  ]);

  assert.match(block, /Something it needs is not an environment variable/);
  assert.doesNotMatch(block, /is empty here/);
});

test("a pack that declares nothing sends the reader to its own README", () => {
  const block = describe({}, [{ name: "greenhouse", state: "off", reason: "not configured" }]);

  assert.match(block, /does not declare what it needs/);
  assert.match(block, /rather than guessing/);
});

test("a directory that is not a pack is not reported as an installed capability", () => {
  const block = describe({}, [
    { name: "home-assistant", state: "unrecognised", reason: "no pack.json" },
  ]);

  assert.match(block, /no pack.json, so it is not a pack/);
  assert.doesNotMatch(block, /home-assistant.*running/);
});

test("a pack that started with a piece refused says both halves", () => {
  const block = describe({}, [
    { name: "house", state: "started", problems: ['server "house" is already registered'] },
  ]);

  assert.match(block, /house.*: running -- but server "house" is already registered/);
});

test("a manifest naming a pack that is not on disk is a cross-check, not a capability", () => {
  const root = tempDir();
  manifest(root, ["hass", "gmail"]);
  const block = describe({}, [{ name: "hass", state: "started" }], root);

  assert.match(block, /config\/packs.json names hass, gmail/);
  assert.match(block, /Named but not on disk: gmail/);
  assert.match(block, /packs-sync/);
});

test("the manifest's repository URLs stay out of the prompt", () => {
  // They are clone URLs for private repositories. The ids answer the question;
  // the URLs only add somewhere for a secret to leak from.
  const root = tempDir();
  manifest(root, ["gmail"]);

  assert.doesNotMatch(describe({}, [], root), /example\.com/);
});

test("no manifest and an empty manifest are different answers", () => {
  const root = tempDir();
  manifest(root, []);

  assert.match(describe({}, [], root), /exists and names no packs/);
  assert.match(describe({}, [], tempDir()), /has never been told which packs to run/);
});

test("running on the built-in persona is something to admit", () => {
  const block = describe({}, [], tempDir(), false);

  assert.match(block, /built-in default/);
  assert.match(block, /config\/persona.md/);
});

test("the block forbids naming a pack it does not list", () => {
  // Without this the model recommends the pack it read about in training, and a
  // repository that may not exist is worse than "I do not know of one".
  // Unwrapped first: where the lines happen to break is not the property.
  const block = describe({}).replace(/\s+/g, " ");

  assert.match(block, /Do not name a specific pack or repository unless it appears above/);
  assert.match(block, /You cannot do any of this yourself from a conversation/);
});

test("the facilities report what is off as well as what is on", () => {
  const off = describe({});
  assert.match(off, /ELEVENLABS_API_KEY is empty/);
  assert.match(off, /nothing is observed/);
  assert.match(off, /spoken only/);

  const on = describe({ ELEVENLABS_API_KEY: "key", JARVIS_PROACTIVE: "announce" });
  assert.match(on, /answers are spoken/);
  assert.match(on, /JARVIS_PROACTIVE is "announce"/);
});

test("reading the web is reported either way, since it is on unasked", () => {
  // The one facility that is on by default, which makes its off case the one
  // that has to be stated: an assistant that cannot look anything up has to
  // know that about itself before it offers to.
  assert.match(describe({}), /searching the web and reading a page are available/);

  const off = describe({ JARVIS_WEB: "off" });
  assert.match(off, /JARVIS_WEB is off/);
  assert.match(off, /set JARVIS_WEB to on/);
});
