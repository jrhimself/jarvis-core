/**
 * Choosing a voice: what there is, which one somebody means, how one that is
 * not here gets here, and what is remembered about it.
 *
 * The published collection is replaced by a server of a few bytes, so the
 * install path -- index, download, size and digest, atomic move -- is exercised
 * without fetching a voice over the network.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AddressInfo } from "node:net";

import { loadConfig, type Config } from "../dist/config.js";
import {
  describePiperVoice,
  installVoice,
  matchVoices,
  piperVoices,
  remoteVoices,
  voiceInstalled,
  voicesFromElevenLabs,
  voicesFromIndex,
} from "../dist/voice/catalogue.js";
import { DEFAULT_VOICE, VoiceChoice, voiceSetting } from "../dist/voice/choice.js";
import { voiceLine, voiceReset, voicesAnswer, voiceSwitched } from "../dist/voice-tools.js";
import type { SettingStore } from "../dist/language.js";
import { tempDir, withEnv } from "./helpers.ts";

const BLANK: Record<string, string | undefined> = {
  ELEVENLABS_API_KEY: undefined,
  FISH_AUDIO_API_KEY: undefined,
  JARVIS_VOICE_PROVIDER: undefined,
  JARVIS_PIPER_MODELS: undefined,
  JARVIS_PIPER_VOICE: undefined,
  JARVIS_PIPER_VOICE_EN: undefined,
  JARVIS_PIPER_VOICES_URL: undefined,
  JARVIS_VOICE_ID: undefined,
  JARVIS_VOICE_ID_EN: undefined,
};

function configWith(vars: Record<string, string | undefined>): Config {
  return withEnv({ ...BLANK, ...vars }, () => loadConfig());
}

function table(initial: Record<string, string> = {}): SettingStore & { rows: Map<string, string> } {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    setting: (key) => rows.get(key) ?? null,
    setSetting: (key, value) => {
      rows.set(key, value);
    },
  };
}

/** A models directory holding these voices, each with the file its model needs. */
function modelsWith(ids: readonly string[], lonely: readonly string[] = []): string {
  const dir = tempDir();
  for (const id of ids) {
    writeFileSync(join(dir, `${id}.onnx`), "model");
    writeFileSync(join(dir, `${id}.onnx.json`), "{}");
  }
  for (const id of lonely) writeFileSync(join(dir, `${id}.onnx`), "model");
  return dir;
}

test("a Piper id is read as a name, a language and a quality", () => {
  assert.deepEqual(describePiperVoice("en_GB-cori-high"), {
    id: "en_GB-cori-high",
    name: "cori",
    language: "en_GB",
    note: "high",
  });
  assert.deepEqual(describePiperVoice("nl-pim-medium"), {
    id: "nl-pim-medium",
    name: "pim",
    language: "nl",
    note: "medium",
  });
  // Nothing enforces the shape, so anything else is reported as itself.
  assert.deepEqual(describePiperVoice("whatever"), { id: "whatever", name: "whatever" });
});

test("the voices on the machine are the models that have their json beside them", async () => {
  const dir = modelsWith(["nl_NL-pim-medium", "en_GB-cori-high"], ["en_US-half-low"]);
  const voices = await piperVoices(configWith({ JARVIS_VOICE_PROVIDER: "piper", JARVIS_PIPER_MODELS: dir }));
  assert.deepEqual(
    voices.map((voice) => voice.id),
    ["en_GB-cori-high", "nl_NL-pim-medium"],
  );
});

test("a models directory that is not there is no voices, not an error", async () => {
  const missing = join(tempDir(), "nowhere");
  assert.deepEqual(await piperVoices(configWith({ JARVIS_PIPER_MODELS: missing })), []);
});

test("a name matches a voice whose id contains it, best quality first", () => {
  const options = [
    describePiperVoice("en_US-amy-low"),
    describePiperVoice("en_GB-cori-medium"),
    describePiperVoice("en_GB-cori-high"),
  ];
  assert.deepEqual(
    matchVoices(options, "Cori").map((voice) => voice.id),
    ["en_GB-cori-high", "en_GB-cori-medium"],
  );
  // An exact id outranks a name that merely contains what was asked for.
  assert.deepEqual(
    matchVoices(options, "en_GB-cori-medium").map((voice) => voice.id),
    ["en_GB-cori-medium"],
  );
  assert.deepEqual(matchVoices(options, "jessica"), []);
  assert.deepEqual(matchVoices(options, "  "), []);
});

test("an ElevenLabs answer becomes voices, and nonsense in it is dropped", () => {
  const voices = voicesFromElevenLabs({
    voices: [
      { voice_id: "abc", name: "Jessica", labels: { language: "en", accent: "american" } },
      { voice_id: "", name: "nameless" },
      { name: "no id" },
      "not an object",
    ],
  });
  assert.deepEqual(voices, [{ id: "abc", name: "Jessica", language: "en", note: "american" }]);
  assert.deepEqual(voicesFromElevenLabs({}), []);
  assert.deepEqual(voicesFromElevenLabs(null), []);
});

test("the published index becomes voices with both their files and a size", () => {
  const voices = voicesFromIndex({
    "en_GB-cori-high": {
      key: "en_GB-cori-high",
      language: { code: "en_GB" },
      quality: "high",
      files: {
        "en/en_GB/cori/high/en_GB-cori-high.onnx": { size_bytes: 100, md5_digest: "aa" },
        "en/en_GB/cori/high/en_GB-cori-high.onnx.json": { size_bytes: 20 },
        "en/en_GB/cori/high/MODEL_CARD": { size_bytes: 5 },
      },
    },
    // No json beside the model: it cannot be installed however it is described.
    "nl-half-medium": {
      key: "nl-half-medium",
      files: { "nl/nl-half-medium.onnx": { size_bytes: 10 } },
    },
    // An id that would be a path rather than a name is not a voice.
    "../escape": { key: "../escape", files: {} },
  });
  assert.equal(voices.length, 1);
  const [cori] = voices;
  assert.equal(cori?.id, "en_GB-cori-high");
  assert.equal(cori?.name, "cori");
  assert.equal(cori?.language, "en_GB");
  assert.equal(cori?.bytes, 120);
  assert.deepEqual(
    cori?.files.map((file) => file.path),
    ["en/en_GB/cori/high/en_GB-cori-high.onnx", "en/en_GB/cori/high/en_GB-cori-high.onnx.json"],
  );
});

/** The published collection, as a handful of bytes on localhost. */
async function collection(files: Record<string, string>): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, response) => {
    const path = (request.url ?? "/").slice(1);
    const body = files[path];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

function index(id: string, model: string, meta: string): Record<string, unknown> {
  return {
    [id]: {
      key: id,
      language: { code: "en_GB" },
      quality: "high",
      files: {
        [`voices/${id}.onnx`]: {
          size_bytes: Buffer.byteLength(model),
          md5_digest: createHash("md5").update(model).digest("hex"),
        },
        [`voices/${id}.onnx.json`]: { size_bytes: Buffer.byteLength(meta) },
      },
    },
  };
}

test("a voice that is not here is fetched, verified and moved into place", async () => {
  const id = "en_GB-cori-high";
  const model = "the model itself";
  const meta = '{"sample_rate":22050}';
  const published = await collection({
    "voices.json": JSON.stringify(index(id, model, meta)),
    [`voices/${id}.onnx`]: model,
    [`voices/${id}.onnx.json`]: meta,
  });
  try {
    const dir = join(tempDir(), "models");
    const config = configWith({
      JARVIS_VOICE_PROVIDER: "piper",
      JARVIS_PIPER_MODELS: dir,
      JARVIS_PIPER_VOICES_URL: published.url,
    });

    const offered = await remoteVoices(config);
    const [cori] = matchVoices(offered, "cori");
    assert.equal(cori?.id, id);
    assert.equal(await voiceInstalled(config, id), false);

    const bytes = await installVoice(config, cori!);
    assert.equal(bytes, Buffer.byteLength(model) + Buffer.byteLength(meta));
    assert.equal(await voiceInstalled(config, id), true);
    assert.equal(readFileSync(join(dir, `${id}.onnx`), "utf8"), model);
    // The directory holds the two files and no half-finished download.
    assert.deepEqual(readdirSync(dir).sort(), [`${id}.onnx`, `${id}.onnx.json`]);
    // And it is now a voice this deployment can be asked for by name.
    assert.deepEqual(
      (await piperVoices(config)).map((voice) => voice.id),
      [id],
    );
  } finally {
    published.close();
  }
});

test("a download that is not what was published is thrown away, not kept", async () => {
  const id = "en_GB-cori-high";
  const model = "the model itself";
  const published = await collection({
    "voices.json": JSON.stringify(index(id, model, "{}")),
    [`voices/${id}.onnx`]: "something else entirely",
    [`voices/${id}.onnx.json`]: "{}",
  });
  try {
    const dir = join(tempDir(), "models");
    const config = configWith({
      JARVIS_VOICE_PROVIDER: "piper",
      JARVIS_PIPER_MODELS: dir,
      JARVIS_PIPER_VOICES_URL: published.url,
    });
    const [cori] = await remoteVoices(config);
    await assert.rejects(() => installVoice(config, cori!));
    assert.equal(await voiceInstalled(config, id), false);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    published.close();
  }
});

test("a voice whose name is a path is refused before anything is written", async () => {
  const dir = join(tempDir(), "models");
  const config = configWith({ JARVIS_VOICE_PROVIDER: "piper", JARVIS_PIPER_MODELS: dir });
  await assert.rejects(() =>
    installVoice(config, {
      id: "../../escape",
      name: "escape",
      files: [
        { path: "a", bytes: 1 },
        { path: "b", bytes: 1 },
      ],
      bytes: 2,
    }),
  );
  mkdirSync(dir, { recursive: true });
  assert.deepEqual(readdirSync(dir), []);
});

test("nobody has asked: each language is read by the voice the deployment configured", () => {
  const config = configWith({
    JARVIS_VOICE_PROVIDER: "piper",
    JARVIS_PIPER_VOICE: "nl-voice",
    JARVIS_PIPER_VOICE_EN: "en-voice",
  });
  const choice = new VoiceChoice(table(), config);
  assert.equal(choice.chosen("nl"), null);
  assert.equal(choice.for("nl"), "nl-voice");
  assert.equal(choice.for("en"), "en-voice");
});

test("a chosen voice is kept per service and per language, and survives a restart", () => {
  const config = configWith({
    JARVIS_VOICE_PROVIDER: "piper",
    JARVIS_PIPER_VOICE: "nl-voice",
    JARVIS_PIPER_VOICE_EN: "en-voice",
  });
  const store = table();
  const choice = new VoiceChoice(store, config);
  assert.equal(choice.set("en", "en_GB-cori-high"), true);
  assert.equal(store.rows.get(voiceSetting("piper", "en")), "en_GB-cori-high");
  // The other language is untouched, and a second object over the same table
  // -- a restart -- reads with what was asked for.
  assert.equal(choice.for("nl"), "nl-voice");
  assert.equal(new VoiceChoice(store, config).for("en"), "en_GB-cori-high");

  // The same table on another service does not hand it a Piper file name.
  const elsewhere = configWith({ ELEVENLABS_API_KEY: "e", JARVIS_VOICE_ID_EN: "jessica" });
  assert.equal(new VoiceChoice(store, elsewhere).for("en"), "jessica");

  assert.equal(choice.clear("en"), true);
  assert.equal(choice.clear("en"), false);
  assert.equal(choice.for("en"), "en-voice");
});

test("every change is heard, and a change to the voice already read with is not one", () => {
  const config = configWith({ JARVIS_VOICE_PROVIDER: "piper", JARVIS_PIPER_VOICE: "nl-voice" });
  const choice = new VoiceChoice(table(), config);
  const heard: string[] = [];
  const stop = choice.onChange((lang) => heard.push(lang));
  // Nothing was chosen, so asking for the deployment's own voice is a choice.
  assert.equal(choice.set("nl", "nl-voice"), true);
  assert.equal(choice.set("nl", "nl-voice"), false);
  choice.set("en", "en_GB-cori-high");
  choice.clear("nl");
  stop();
  choice.set("nl", "nl_NL-pim-medium");
  assert.deepEqual(heard, ["nl", "en", "nl"]);
});

test("the catalogue read out names what reads each language and what else there is", () => {
  const answer = voicesAnswer(
    "Piper (local)",
    { nl: "nl_NL-pim-medium", en: "en_GB-cori-high" },
    [describePiperVoice("en_GB-cori-high"), describePiperVoice("nl_NL-pim-medium")],
    [{ ...describePiperVoice("en_US-amy-medium"), files: [], bytes: 63 * 1024 * 1024 }],
    "",
  );
  assert.match(answer, /Dutch is read by nl_NL-pim-medium/);
  assert.match(answer, /English by en_GB-cori-high/);
  assert.match(answer, /2 voice\(s\) available now/);
  assert.match(answer, /- cori -- en_GB-cori-high \(en_GB, high\)/);
  assert.match(answer, /set_voice will fetch any of these/);
  assert.match(answer, /- amy -- en_US-amy-medium \(en_US, medium, 63 MB\)/);
});

test("a service with no list says so rather than inviting a guess", () => {
  const answer = voicesAnswer("Fish Audio", { nl: "abc", en: "" }, null, [], "");
  assert.match(answer, /English by its default voice/);
  assert.match(answer, /publishes no list of its voices here/);
  assert.doesNotMatch(answer, /voice\(s\) available now/);
});

test("`like` narrows both lists to what contains it", () => {
  const answer = voicesAnswer(
    "Piper (local)",
    { nl: "nl_NL-pim-medium", en: "en_GB-cori-high" },
    [describePiperVoice("en_GB-cori-high"), describePiperVoice("nl_NL-pim-medium")],
    [{ ...describePiperVoice("en_US-amy-medium"), files: [], bytes: 1 }],
    "cori",
  );
  assert.match(answer, /1 voice\(s\) matching "cori"/);
  assert.doesNotMatch(answer, /pim/);
  assert.doesNotMatch(answer, /amy/);
});

test("what the model is told after a switch says when it takes effect", () => {
  const switched = voiceSwitched(
    ["en"],
    describePiperVoice("en_GB-cori-high"),
    [describePiperVoice("en_GB-cori-medium")],
    63 * 1024 * 1024,
  );
  assert.match(switched, /English is now read by cori \(en_GB-cori-high\)/);
  assert.match(switched, /fetched first: 63 MB/);
  assert.match(switched, /your very next sentence/);
  assert.match(switched, /Also matched.*en_GB-cori-medium/);

  const both = voiceSwitched(["nl", "en"], { id: "abc", name: "abc" }, [], null);
  assert.match(both, /Dutch and English is now read by abc/);
  assert.doesNotMatch(both, /fetched/);
  assert.doesNotMatch(both, /Also matched/);

  assert.match(voiceReset(["nl", "en"], ["nl-voice", "en-voice"]), /own voice again \(nl-voice, en-voice\)/);
});

test("a voice whose name is its id is named once", () => {
  assert.equal(voiceLine({ id: "abc", name: "abc" }), "- abc");
  assert.equal(voiceLine({ id: "abc", name: "Cori", language: "en" }), "- Cori -- abc (en)");
  assert.equal(voiceLine({ id: "abc", name: "Cori" }, 1), "- Cori -- abc (1 MB)");
});

test("`default` is a word, not an id a service could have", () => {
  assert.equal(DEFAULT_VOICE, "default");
});
