/**
 * The local voice: Piper behind a pipe.
 *
 * The Python side is replaced by `fixtures/piper-stub.py`, which speaks the same
 * frames and reads the text back as its "audio". What is tested is everything
 * on this side of the pipe: which sentences are cut, in what order they are
 * sent, when the turn is open and done, and what a dead process does to it.
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loadConfig, type Config } from "../dist/config.js";
import { openVoice, voiceConfigured, voiceCreditsLeft, voiceFor, voiceKeyVariable } from "../dist/voice/index.js";
import { PiperVoice, piperVoiceIdFor, stopPiper } from "../dist/voice/piper.js";
import { withEnv } from "./helpers.ts";

const STUB = fileURLToPath(new URL("./fixtures/piper-stub.py", import.meta.url));
const MODELS = fileURLToPath(new URL("./fixtures", import.meta.url));

const EMPTY: Record<string, string | undefined> = {
  ELEVENLABS_API_KEY: undefined,
  FISH_AUDIO_API_KEY: undefined,
  JARVIS_VOICE_PROVIDER: undefined,
  JARVIS_PIPER_PYTHON: undefined,
  JARVIS_PIPER_SERVER: undefined,
  JARVIS_PIPER_MODELS: undefined,
  JARVIS_PIPER_VOICE: undefined,
  JARVIS_PIPER_VOICE_EN: undefined,
};

function configWith(env: Record<string, string | undefined>): Config {
  return withEnv({ ...EMPTY, ...env }, () => loadConfig());
}

function piperConfig(extra: Record<string, string | undefined> = {}): Config {
  return configWith({
    JARVIS_VOICE_PROVIDER: "piper",
    JARVIS_PIPER_PYTHON: "python3",
    JARVIS_PIPER_SERVER: STUB,
    JARVIS_PIPER_MODELS: MODELS,
    JARVIS_PIPER_VOICE: "nl-voice",
    JARVIS_PIPER_VOICE_EN: "en-voice",
    ...extra,
  });
}

/** A turn's handlers, recording what the conversation would have been told. */
function recorder() {
  const events: string[] = [];
  const audio: string[] = [];
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => (finished = resolve));
  return {
    events,
    audio,
    done,
    handlers: {
      onOpen: () => events.push("open"),
      onAudio: (data: string) => {
        events.push("audio");
        audio.push(Buffer.from(data, "base64").toString("utf8"));
      },
      onDone: () => {
        events.push("done");
        finished();
      },
      onError: (reason: string) => {
        events.push(`error:${reason}`);
        finished();
      },
    },
  };
}

after(() => stopPiper());

test("Piper is chosen only by name, and needs its models, not a key", () => {
  assert.equal(configWith({ ELEVENLABS_API_KEY: "e" }).voiceProvider, "elevenlabs");
  assert.equal(configWith({ FISH_AUDIO_API_KEY: "f" }).voiceProvider, "fish");
  assert.equal(configWith({}).voiceProvider, "elevenlabs", "no key does not mean a local voice");

  const named = piperConfig();
  assert.equal(named.voiceProvider, "piper");
  assert.equal(voiceConfigured(named), true);

  const missing = piperConfig({ JARVIS_PIPER_MODELS: "/nonexistent/piper" });
  assert.equal(voiceConfigured(missing), false);
  assert.equal(voiceKeyVariable(missing), "JARVIS_PIPER_MODELS");
});

test("there is nothing to run out of", async () => {
  assert.equal(await voiceCreditsLeft(piperConfig()), null);
});

test("each language has its voice, and each falls back to the other's", () => {
  const both = piperConfig();
  assert.equal(voiceFor(both, "nl"), "nl-voice");
  assert.equal(voiceFor(both, "en"), "en-voice");

  // An empty variable means "the default", so a voice is emptied on the config.
  const onlyEnglish = { ...both, piperVoice: "" };
  assert.equal(piperVoiceIdFor(onlyEnglish, "nl"), "en-voice");
  const onlyDutch = { ...both, piperVoiceEn: "" };
  assert.equal(piperVoiceIdFor(onlyDutch, "en"), "nl-voice");
});

test("the defaults name real voices", () => {
  const config = configWith({ JARVIS_VOICE_PROVIDER: "piper" });
  assert.equal(config.piperVoiceEn, "en_GB-alan-medium");
  assert.equal(config.piperVoice, "nl_NL-pim-medium");
});

test("openVoice hands out the local voice when Piper is the provider", () => {
  const voice = openVoice(piperConfig(), recorder().handlers, "en");
  assert.ok(voice instanceof PiperVoice);
  voice.abort();
});

test("a turn: open once, sentences read in order in the language's voice, done last", async () => {
  const turn = recorder();
  const voice = openVoice(piperConfig(), turn.handlers, "en");

  // The model writes a few words at a time; a sentence closes when the next begins.
  voice.speak("Good morning");
  voice.speak(", sir. The door is");
  voice.speak(" locked. It is 21.");
  voice.speak("4 degrees.");
  voice.finish();
  await turn.done;

  assert.equal(turn.events[0], "open");
  assert.equal(turn.events.at(-1), "done");
  assert.equal(turn.events.filter((event) => event === "open").length, 1);
  assert.equal(turn.events.filter((event) => event === "done").length, 1);
  assert.equal(voice.failed, false);

  // The stub returns "<voice>|<text>" split in two frames per sentence.
  const heard = turn.audio.join("");
  assert.equal(
    heard,
    "en-voice|Good morning, sir.en-voice|The door is locked.en-voice|It is 21.4 degrees.",
    "a decimal point is not a sentence end, and order is kept",
  );
});

test("a turn that says nothing is done without a voice being asked for", async () => {
  const turn = recorder();
  const voice = openVoice(piperConfig(), turn.handlers, "nl");
  voice.finish();
  await turn.done;
  assert.deepEqual(turn.events, ["done"]);
});

test("text that arrives before the process is ready waits for it", async () => {
  stopPiper();
  const turn = recorder();
  const voice = openVoice(piperConfig(), turn.handlers, "nl");
  voice.speak("Eerste zin. Tweede zin.");
  voice.finish();
  await turn.done;
  assert.equal(turn.events[0], "open", "open comes before any audio");
  assert.equal(turn.audio.join(""), "nl-voice|Eerste zin.nl-voice|Tweede zin.");
});

test("an error frame fails the turn, once, and the process serves the next", async () => {
  const bad = recorder();
  const first = openVoice(piperConfig(), bad.handlers, "en");
  first.speak("FAIL this one.");
  first.finish();
  await bad.done;
  assert.deepEqual(
    bad.events.filter((event) => event.startsWith("error")),
    ["error:no such voice"],
  );
  assert.equal(first.failed, true);

  const good = recorder();
  const second = openVoice(piperConfig(), good.handlers, "en");
  second.speak("Fine.");
  second.finish();
  await good.done;
  assert.equal(good.events.at(-1), "done");
});

test("a process that dies mid-turn fails the turn, and the next turn starts a new one", async () => {
  const doomed = recorder();
  const voice = openVoice(piperConfig(), doomed.handlers, "en");
  voice.speak("CRASH now.");
  voice.finish();
  await doomed.done;
  assert.equal(doomed.events.filter((event) => event.startsWith("error")).length, 1);
  assert.equal(doomed.events.includes("done"), false);

  const next = recorder();
  const again = openVoice(piperConfig(), next.handlers, "en");
  again.speak("Back again.");
  again.finish();
  await next.done;
  assert.equal(next.events.at(-1), "done", "a fresh process took over");
});

test("aborting a turn silences it, and the next turn is not held up", async () => {
  const cancelled = recorder();
  const voice = openVoice(piperConfig(), cancelled.handlers, "en");
  voice.speak("SLOW one. Then another. And a third.");
  voice.abort();

  const next = recorder();
  const after = openVoice(piperConfig(), next.handlers, "en");
  after.speak("Still here.");
  after.finish();
  await next.done;

  assert.equal(next.audio.join(""), "en-voice|Still here.");
  assert.equal(cancelled.events.includes("done"), false);
  assert.equal(cancelled.audio.length, 0, "nothing of a cancelled turn is played");
});

test("a process that cannot be started is a failed turn, not a hang", async () => {
  const turn = recorder();
  const voice = openVoice(piperConfig({ JARVIS_PIPER_PYTHON: "/nonexistent/python" }), turn.handlers, "en");
  voice.speak("Hello.");
  voice.finish();
  await turn.done;
  assert.equal(turn.events.some((event) => event.startsWith("error")), true);
  assert.equal(voice.failed, true);
});
