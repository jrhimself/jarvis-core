/**
 * Reading the environment.
 *
 * The interesting behaviour here is what happens to a typo: a bad port stops
 * the service, a bad mode does not. That asymmetry is deliberate and easy to
 * undo by accident, so it is written down here.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, proactiveAtLeast } from "../dist/config.js";
import { voiceIdFor } from "../dist/voice/elevenlabs.js";
import { quietly, withEnv } from "./helpers.ts";

/** Every variable loadConfig reads, so a test starts from a clean slate. */
const BLANK = {
  JARVIS_PORT: undefined,
  JARVIS_CERT_DIR: undefined,
  JARVIS_CERT_FILE: undefined,
  JARVIS_KEY_FILE: undefined,
  JARVIS_HUD_DIR: undefined,
  HA_URL: undefined,
  HA_TOKEN: undefined,
  JARVIS_MEMORY_PATH: undefined,
  JARVIS_BACKUP_DIR: undefined,
  JARVIS_BACKUP_KEEP: undefined,
  ELEVENLABS_API_KEY: undefined,
  FISH_AUDIO_API_KEY: undefined,
  JARVIS_VOICE_PROVIDER: undefined,
  JARVIS_FISH_MODEL: undefined,
  JARVIS_FISH_ENDPOINT: undefined,
  JARVIS_FISH_VOICE_ID: undefined,
  JARVIS_FISH_VOICE_ID_EN: undefined,
  JARVIS_FISH_LATENCY: undefined,
  JARVIS_FISH_NORMALIZE: undefined,
  JARVIS_LIMIT_SENTENCE: undefined,
  JARVIS_LIMIT_SENTENCE_EN: undefined,
  JARVIS_LIMIT_SENTENCE_NL: undefined,
  JARVIS_SPEECH_LANG: undefined,
  JARVIS_PLAN_WARN_PCT: undefined,
  JARVIS_VOICE_ID: undefined,
  JARVIS_VOICE_ID_EN: undefined,
  JARVIS_VOICE_STABILITY: undefined,
  JARVIS_VOICE_SIMILARITY: undefined,
  JARVIS_VOICE_SPEED: undefined,
  JARVIS_VOICE_TIMBRE: undefined,
  JARVIS_MEMORY_PANEL: undefined,
  JARVIS_THINKING_LINES: undefined,
  JARVIS_THINKING_LINES_EN: undefined,
  JARVIS_THINKING_LINES_NL: undefined,
  JARVIS_THINKING_AFTER_MS: undefined,
  JARVIS_SESSION_IDLE_MIN: undefined,
  JARVIS_SESSION_MAX_TURNS: undefined,
  JARVIS_PROACTIVE: undefined,
  JARVIS_MODEL: undefined,
  JARVIS_ESCALATE_MODEL: undefined,
  JARVIS_FALLBACK_MODEL: undefined,
  JARVIS_MAX_STEPS: undefined,
  JARVIS_MAX_TURN_USD: undefined,
  JARVIS_STOPPED_SENTENCE: undefined,
  JARVIS_STOPPED_SENTENCE_EN: undefined,
  JARVIS_STOPPED_SENTENCE_NL: undefined,
};

test("an empty environment still yields a working configuration", () => {
  const config = withEnv(BLANK, loadConfig);

  assert.equal(config.port, 443);
  assert.equal(config.haUrl, "");
  assert.equal(config.haToken, "");
  assert.equal(
    config.memoryPanel,
    "read",
    "the panel looks but does not write until somebody says it may",
  );
  assert.equal(config.proactive, "off", "the proactive side is opt-in");
  assert.equal(config.sessionIdleMs, 20 * 60_000);
  assert.equal(config.sessionMaxTurns, 30);
  assert.equal(config.backupKeep, 14);
  assert.equal(config.escalateModel, "", "a stronger model is opt-in, and costs money");
  assert.equal(config.maxSteps, 16, "the step brake is on by default; it is not a budget");
  assert.equal(config.maxTurnUsd, 0, "a spending limit is not guessed at on somebody's behalf");
});

test("a budget that is not an amount falls back to no budget at all", () => {
  const config = quietly(() =>
    withEnv({ ...BLANK, JARVIS_MAX_TURN_USD: "twee euro" }, loadConfig),
  );

  assert.equal(config.maxTurnUsd, 0);
});

test("a budget may be a fraction of a dollar, unlike every other number here", () => {
  const config = withEnv({ ...BLANK, JARVIS_MAX_TURN_USD: "0.25" }, loadConfig);

  assert.equal(config.maxTurnUsd, 0.25);
});

test("the step brake can be taken off, which is not the same as a typo", () => {
  const off = withEnv({ ...BLANK, JARVIS_MAX_STEPS: "0" }, loadConfig);
  const typo = quietly(() => withEnv({ ...BLANK, JARVIS_MAX_STEPS: "veel" }, loadConfig));

  assert.equal(off.maxSteps, 0, "zero is a deliberate answer and is kept");
  assert.equal(typo.maxSteps, 16, "a typo leaves the brake where it was");
});

test("the voice knobs take fractions, and a typo costs the knob rather than the voice", () => {
  const tuned = withEnv(
    { ...BLANK, JARVIS_VOICE_STABILITY: "0.9", JARVIS_VOICE_SPEED: "0.94", JARVIS_VOICE_TIMBRE: "20" },
    loadConfig,
  );

  assert.equal(tuned.voiceStability, 0.9);
  assert.equal(tuned.voiceSpeed, 0.94);
  assert.equal(tuned.voiceTimbre, 20);

  // 9 is not 0.9, and speaking in a register nobody chose is worse than
  // speaking in the default one.
  const typo = quietly(() =>
    withEnv({ ...BLANK, JARVIS_VOICE_STABILITY: "9", JARVIS_VOICE_TIMBRE: "0.2" }, loadConfig),
  );

  assert.equal(typo.voiceStability, 0.4);
  assert.equal(typo.voiceTimbre, 0);
});

test("english speaks its own voice only when one is set", () => {
  const one = withEnv({ ...BLANK, JARVIS_VOICE_ID: "dutch" }, loadConfig);
  assert.equal(voiceIdFor(one, "nl"), "dutch");
  assert.equal(voiceIdFor(one, "en"), "dutch", "no English voice set, so the Dutch one speaks");

  const two = withEnv({ ...BLANK, JARVIS_VOICE_ID: "dutch", JARVIS_VOICE_ID_EN: "english" }, loadConfig);
  assert.equal(voiceIdFor(two, "nl"), "dutch");
  assert.equal(voiceIdFor(two, "en"), "english");
});

test("the deployment starts in one language, and English unless told otherwise", () => {
  assert.equal(withEnv({ ...BLANK }, loadConfig).speechLang, "en");
  assert.equal(withEnv({ ...BLANK, JARVIS_SPEECH_LANG: "nl" }, loadConfig).speechLang, "nl");

  // A language nobody speaks is a typo, and answering in a language that was
  // never chosen is worse than answering in the default one.
  const typo = quietly(() => withEnv({ ...BLANK, JARVIS_SPEECH_LANG: "de" }, loadConfig));
  assert.equal(typo.speechLang, "en");
});

test("every language has its own spoken lines, ready before anybody switches", () => {
  const config = withEnv({ ...BLANK }, loadConfig);
  assert.ok(config.spoken.en.thinking.length > 0);
  assert.ok(config.spoken.nl.thinking.length > 0);
  assert.notEqual(config.spoken.en.stopped, config.spoken.nl.stopped);
  assert.ok(config.spoken.en.limit.includes("{reset}"));
  assert.ok(config.spoken.nl.limit.includes("{reset}"));
});

test("an unsuffixed line belongs to the starting language, a suffixed one to its own", () => {
  const dutch = withEnv(
    {
      ...BLANK,
      JARVIS_SPEECH_LANG: "nl",
      JARVIS_STOPPED_SENTENCE: "Dat lukte niet.",
      JARVIS_STOPPED_SENTENCE_EN: "That did not work.",
    },
    loadConfig,
  );
  assert.equal(dutch.spoken.nl.stopped, "Dat lukte niet.");
  assert.equal(dutch.spoken.en.stopped, "That did not work.");

  // Written for a Dutch deployment, so it is no fallback for English.
  const older = withEnv(
    { ...BLANK, JARVIS_SPEECH_LANG: "nl", JARVIS_THINKING_LINES: "Momentje." },
    loadConfig,
  );
  assert.deepEqual(older.spoken.nl.thinking, ["Momentje."]);
  assert.notDeepEqual(older.spoken.en.thinking, ["Momentje."]);

  // And the suffixed name wins over the unsuffixed one for the same language.
  const both = withEnv(
    { ...BLANK, JARVIS_THINKING_LINES: "Old.", JARVIS_THINKING_LINES_EN: "New." },
    loadConfig,
  );
  assert.deepEqual(both.spoken.en.thinking, ["New."]);
});

test("an empty string counts as unset", () => {
  const config = withEnv({ ...BLANK, HA_URL: "", JARVIS_PORT: "" }, loadConfig);

  assert.equal(config.haUrl, "");
  assert.equal(config.port, 443);
});

test("paths are resolved, so the working directory cannot move the database", () => {
  const config = withEnv({ ...BLANK, JARVIS_MEMORY_PATH: "../data/memory.db" }, loadConfig);

  assert.ok(config.memoryPath.startsWith("/"), `expected an absolute path, got ${config.memoryPath}`);
});

test("a port that is not a port stops the service", () => {
  for (const value of ["0", "70000", "8.5", "https", "-1"]) {
    assert.throws(
      () => withEnv({ ...BLANK, JARVIS_PORT: value }, loadConfig),
      /must be a port number/,
      `expected ${value} to be refused`,
    );
  }
});

test("a number out of range falls back instead of stopping the service", () => {
  const config = quietly(() =>
    withEnv(
      { ...BLANK, JARVIS_SESSION_MAX_TURNS: "1", JARVIS_SESSION_IDLE_MIN: "veertig" },
      loadConfig,
    ),
  );

  assert.equal(config.sessionMaxTurns, 30);
  assert.equal(config.sessionIdleMs, 20 * 60_000);
});

test("a misspelt mode falls back rather than throwing", () => {
  const config = quietly(() =>
    withEnv({ ...BLANK, JARVIS_PROACTIVE: "observ", JARVIS_MEMORY_PANEL: "readonly" }, loadConfig),
  );

  assert.equal(config.proactive, "off");
  assert.equal(config.memoryPanel, "read");
});

test("minutes are stored as milliseconds", () => {
  const config = withEnv({ ...BLANK, JARVIS_SESSION_IDLE_MIN: "5" }, loadConfig);

  assert.equal(config.sessionIdleMs, 5 * 60_000);
});

test("the autonomy ladder includes every rung below it", () => {
  assert.equal(proactiveAtLeast("announce", "observe"), true);
  assert.equal(proactiveAtLeast("observe", "observe"), true);
  assert.equal(proactiveAtLeast("observe", "suggest"), false);
  assert.equal(proactiveAtLeast("off", "observe"), false);
  assert.equal(proactiveAtLeast("off", "off"), true);
});

test("without a GitHub token JARVIS can still build, but not open a pull request", () => {
  // The two halves are configured separately on purpose: pushing a branch uses
  // the deploy key that is already on the machine, opening a pull request needs
  // a user token that is not.
  const config = withEnv(BLANK, loadConfig);
  assert.equal(config.devGitHubToken, "");
  // No default repository either: naming one would be naming somebody's.
  assert.equal(config.devGitHubRepo, "");
  assert.equal(
    withEnv({ ...BLANK, JARVIS_GITHUB_REPO: "someone/something" }, loadConfig).devGitHubRepo,
    "someone/something",
  );
});

test("a pack's own settings are not core's to hold", () => {
  // Delegation, a bridge to another machine and an operations reader all read
  // their own environment now. Core carrying their keys meant core carrying
  // their defaults, and those defaults were one household's machines.
  const config = withEnv(BLANK, loadConfig) as unknown as Record<string, unknown>;
  for (const key of ["delegateHost", "delegateUser", "delegateKey", "opsUrl", "bridgeUrl"]) {
    assert.equal(key in config, false, `${key} does not belong in core's configuration`);
  }
});

test("the lines that fill a silence are a list, split on the pipe", () => {
  withEnv({ ...BLANK, JARVIS_THINKING_LINES: "Momentje. | Even kijken, hoor. |" }, () => {
    // Trimmed, empty items dropped -- and the comma inside the second line
    // survives, which is why the separator is not one.
    assert.deepEqual(loadConfig().spoken.en.thinking, ["Momentje.", "Even kijken, hoor."]);
  });
});

test("a deployment that wants no acknowledgement can say so two ways", () => {
  withEnv({ ...BLANK, JARVIS_THINKING_LINES: " | " }, () => {
    assert.deepEqual(loadConfig().spoken.en.thinking, []);
  });
  withEnv({ ...BLANK, JARVIS_THINKING_AFTER_MS: "0" }, () => {
    assert.equal(loadConfig().thinkingAfterMs, 0);
  });
});
