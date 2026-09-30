/**
 * Listening on this machine: Whisper behind a pipe.
 *
 * The Python side is replaced by `fixtures/stt-stub.py`, which answers every
 * stretch of audio with how long it was. What is tested is what is on this side
 * of the pipe, and it is the part that has to be right for the browser to behave:
 * where speech is cut into utterances, what is sent while someone is talking, and
 * that a pause in the middle of a sentence does not look like the end of one.
 *
 * Audio is synthetic: a tone is a voice, zeros are a quiet room. Time is the
 * audio's own, so nothing here waits for a clock.
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { loadConfig, type Config } from "../dist/config.js";
import { listenConfigured, openListener } from "../dist/voice/index.js";
import { level, stopWhisper, WhisperListener } from "../dist/voice/whisper.js";
import { withEnv } from "./helpers.ts";

const STUB = fileURLToPath(new URL("./fixtures/stt-stub.py", import.meta.url));

const EMPTY: Record<string, string | undefined> = {
  ELEVENLABS_API_KEY: undefined,
  JARVIS_LISTEN_PROVIDER: undefined,
  JARVIS_STT_PYTHON: undefined,
  JARVIS_STT_SERVER: undefined,
  JARVIS_STT_MODELS: undefined,
  JARVIS_STT_MODEL: undefined,
  JARVIS_STT_PARTIALS: undefined,
  JARVIS_STT_LANGUAGES: undefined,
};

function configWith(env: Record<string, string | undefined>): Config {
  return withEnv({ ...EMPTY, ...env }, () => loadConfig());
}

function whisperConfig(extra: Record<string, string | undefined> = {}): Config {
  return configWith({
    JARVIS_LISTEN_PROVIDER: "whisper",
    JARVIS_STT_PYTHON: "python3",
    JARVIS_STT_SERVER: STUB,
    ...extra,
  });
}

/** 100 ms of 16 kHz PCM, base64: a 440 Hz tone at the given amplitude, or silence at 0. */
function chunk(amplitude: number): string {
  const samples = new Int16Array(1600);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * index) / 16000));
  }
  return Buffer.from(samples.buffer).toString("base64");
}
const VOICE = chunk(6000);
const QUIET = chunk(0);

function feed(listener: { push: (data: string) => void }, data: string, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 100) listener.push(data);
}

/** What the browser would have been told. */
function recorder() {
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: string[] = [];
  let ready = 0;
  return {
    partials,
    finals,
    errors,
    ready: () => ready,
    handlers: {
      onPartial: (text: string) => partials.push(text),
      onFinal: (text: string) => finals.push(text),
      onError: (reason: string) => errors.push(reason),
      onReady: () => ready++,
    },
  };
}

/** The length the stub was told, in milliseconds, from "heard 1820ms en". */
function heardMs(text: string | undefined): number {
  return Number(/^heard (\d+)ms/.exec(text ?? "")?.[1] ?? NaN);
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 3000; waited += 10) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(`waited for ${what}`);
}

after(() => stopWhisper());

test("Whisper listens when named, and the key is not needed", () => {
  assert.equal(configWith({}).listenProvider, "elevenlabs");
  assert.equal(listenConfigured(configWith({})), false);
  assert.equal(listenConfigured(configWith({ ELEVENLABS_API_KEY: "e" })), true);
  assert.equal(listenConfigured(whisperConfig()), true);
  assert.equal(configWith({ JARVIS_LISTEN_PROVIDER: "whisper" }).sttModel, "base");
  assert.deepEqual(configWith({}).sttLanguages, ["nl", "en"], "Dutch and English, whatever the assistant answers in");
  assert.deepEqual(configWith({ JARVIS_STT_LANGUAGES: " en ,, nl " }).sttLanguages, ["en", "nl"]);
});

test("speaking Piper does not move the microphone", () => {
  const config = configWith({ JARVIS_VOICE_PROVIDER: "piper", ELEVENLABS_API_KEY: "e" });
  assert.equal(config.voiceProvider, "piper");
  assert.equal(config.listenProvider, "elevenlabs");
});

test("loudness is the root mean square", () => {
  assert.equal(level(Buffer.from(QUIET, "base64")), 0);
  const tone = level(Buffer.from(VOICE, "base64"));
  assert.ok(Math.abs(tone - 6000 / Math.SQRT2) < 5, `a sine of 6000 has an RMS near 4243, got ${tone}`);
});

test("openListener hands out the local listener, and it says it is ready at once", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig(), turn.handlers, "en");
  assert.ok(listener instanceof WhisperListener);
  await sleep(5);
  assert.equal(turn.ready(), 1, "the browser gives the brain two seconds to say so");
  listener.close();
});

test("speech, then quiet: one utterance, read once, the language left to the model", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_PARTIALS: "0" }), turn.handlers, "nl");
  feed(listener, QUIET, 500);
  feed(listener, VOICE, 1000);
  assert.equal(turn.finals.length, 0, "nothing settles while the voice is still going");
  feed(listener, QUIET, 700);
  await until(() => turn.finals.length === 1, "the utterance to be read");

  const ms = heardMs(turn.finals[0]);
  assert.ok(ms >= 1500 && ms <= 2200, `about a second of voice with its lead-in and the quiet after: ${ms}`);
  assert.match(turn.finals[0]!, /auto$/, "the assistant answers in English; that says nothing of what is spoken");
  assert.deepEqual(turn.partials, []);
  listener.close();
});

test("a click is not an utterance", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig(), turn.handlers, "en");
  feed(listener, QUIET, 500);
  feed(listener, VOICE, 100);
  feed(listener, QUIET, 1500);
  await sleep(100);
  assert.deepEqual(turn.finals, []);
  assert.deepEqual(turn.partials, []);
  listener.close();
});

test("a pause between two sentences settles the first, and the second is its own", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_PARTIALS: "0" }), turn.handlers, "en");
  feed(listener, QUIET, 400);
  feed(listener, VOICE, 800);
  feed(listener, QUIET, 800);
  await until(() => turn.finals.length === 1, "the first sentence");
  feed(listener, VOICE, 1500);
  feed(listener, QUIET, 800);
  await until(() => turn.finals.length === 2, "the second sentence");
  assert.ok(heardMs(turn.finals[1]) > heardMs(turn.finals[0]), "the second is the longer one, and its own audio");
  listener.close();
});

test("text appears while someone is still speaking, and is repeated until the next arrives", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig(), turn.handlers, "en");
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 1500);
  await until(() => turn.partials.length >= 1, "a partial");
  const first = turn.partials.length;
  assert.equal(turn.finals.length, 0, "a partial is not a settled sentence");

  // Speech carries on; the model is busy or slow. The last text is sent again so
  // the browser's wait for a quiet gap does not run out under a talking person.
  feed(listener, VOICE, 700);
  assert.ok(turn.partials.length > first, "a heartbeat while the voice goes on");
  assert.equal(turn.partials.at(-1), turn.partials[first - 1]);
  listener.close();
});

test("no heartbeat before anything has been heard", () => {
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_PARTIALS: "0" }), turn.handlers, "en");
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 3000);
  assert.deepEqual(turn.partials, [], "the browser waits for the first text before it starts its clock");
  listener.close();
});

test("commit reads what has been said without waiting for quiet", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_PARTIALS: "0" }), turn.handlers, "en");
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 1000);
  listener.commit();
  await until(() => turn.finals.length === 1, "the committed utterance");
  listener.close();
});

test("a listener that is closed says nothing more", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_PARTIALS: "0" }), turn.handlers, "en");
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 1000);
  listener.commit();
  listener.close();
  await sleep(150);
  assert.deepEqual(turn.finals, []);
});

test("a process that cannot be started is an error, and not a hang", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_PYTHON: "/nonexistent/python" }), turn.handlers, "en");
  await until(() => turn.errors.length === 1, "the failure");
  listener.push(VOICE);
  assert.equal(turn.errors.length, 1, "once");
});

test("the language is worked out once, on the first partial, and the rest is read in it", async () => {
  stopWhisper(); // nothing is known of the last utterance
  const turn = recorder();
  const listener = openListener(whisperConfig(), turn.handlers, "en");
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 1000);
  await until(() => turn.partials.length >= 1, "the first partial");
  assert.match(turn.partials[0]!, /nl$/, "nothing is known yet: the first language allowed is the guess, and the model is not asked");
  assert.equal(turn.partials.some((text) => text.endsWith("auto")), false, "not yet: too little speech to choose on");

  // Enough speech to choose on: one reading is the model's own.
  for (let spoken = 0; spoken < 30 && !turn.partials.some((text) => text.endsWith("auto")); spoken++) {
    feed(listener, VOICE, 400);
    await sleep(40);
  }
  assert.ok(turn.partials.some((text) => text.endsWith("auto")), "the model chose once, on enough speech");

  feed(listener, VOICE, 800);
  await sleep(60);

  feed(listener, QUIET, 700);
  await until(() => turn.finals.length === 1, "the final");
  assert.match(turn.finals[0]!, /nl$/, "the final, which the person waits for, does not choose again");
  listener.close();
});

test("the language of one utterance is not the next one's", async () => {
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_PARTIALS: "0" }), turn.handlers, "en");
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 800);
  feed(listener, QUIET, 800);
  await until(() => turn.finals.length === 1, "the first");
  feed(listener, VOICE, 800);
  feed(listener, QUIET, 800);
  await until(() => turn.finals.length === 2, "the second");
  assert.match(turn.finals[0]!, /auto$/);
  assert.match(turn.finals[1]!, /auto$/, "someone who switches language is heard in the new one");
  listener.close();
});

test("one allowed language is a language chosen, and nothing is worked out", async () => {
  const turn = recorder();
  const listener = openListener(
    whisperConfig({ JARVIS_STT_PARTIALS: "0", JARVIS_STT_LANGUAGES: "en" }),
    turn.handlers,
    "nl",
  );
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 800);
  feed(listener, QUIET, 800);
  await until(() => turn.finals.length === 1, "the utterance");
  assert.match(turn.finals[0]!, /en$/);
  listener.close();
});

test("the last utterance's language is the guess for the first words, and one full reading confirms it", async () => {
  stopWhisper();
  const first = recorder();
  const one = openListener(whisperConfig(), first.handlers, "en");
  feed(one, QUIET, 300);
  feed(one, VOICE, 2000);
  feed(one, QUIET, 700);
  await until(() => first.finals.length === 1, "the first utterance");
  one.close();

  const turn = recorder();
  const two = openListener(whisperConfig(), turn.handlers, "en");
  feed(two, QUIET, 700);
  feed(two, VOICE, 1000);
  await until(() => turn.partials.length >= 1, "the first words");
  assert.match(turn.partials[0]!, /nl$/, "read at once in the language of the last one, not left to the model");
  assert.equal(turn.partials.some((text) => text.endsWith("auto")), false);

  // Enough speech now to be sure; one reading is spent on choosing.
  for (let spoken = 0; spoken < 30 && !turn.partials.some((text) => text.endsWith("auto")); spoken++) {
    feed(two, VOICE, 400);
    await sleep(40);
  }
  assert.ok(turn.partials.some((text) => text.endsWith("auto")), "the confirming reading");
  two.close();
});

test("a reading that reached the end of the speech is the final, and nothing is read twice", async () => {
  stopWhisper();
  const turn = recorder();
  const listener = openListener(whisperConfig({ JARVIS_STT_LANGUAGES: "nl" }), turn.handlers, "en");
  feed(listener, QUIET, 300);
  feed(listener, VOICE, 1000);
  await until(() => turn.partials.length >= 1, "a partial");
  const covered = turn.partials[0]!;

  assert.ok(covered.length > 0);
  feed(listener, QUIET, 600);
  await until(() => turn.finals.length === 1, "the final");
  // The whole utterance -- lead-in, voice and the quiet that ended it -- is 1800 ms.
  // A final read of all of it would say so; one that is a reading already made,
  // taken during the quiet, is shorter.
  assert.ok(heardMs(turn.finals[0]) < 1800, `not read again from the top: ${turn.finals[0]}`);
  listener.close();
});
