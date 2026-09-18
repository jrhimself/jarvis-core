/**
 * The Fish Audio voice, against a socket of our own.
 *
 * Fish itself is not on the other end here -- the tests need no key and no
 * network. What is tested is the protocol as documented: MessagePack frames, a
 * start event first, text as it arrives, a stop at the end; audio bytes coming
 * back as base64 the HUD can schedule, and a finish that ends the turn. And the
 * one behaviour that is ours rather than the protocol's: a socket that closes
 * before anything was said is not a failed turn.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decode, encode } from "@msgpack/msgpack";
import { WebSocketServer, type WebSocket } from "ws";

import { loadConfig, type Config } from "../dist/config.js";
import { FishVoice, fishVoiceIdFor, readEvent, startEvent } from "../dist/voice/fish.js";
import { openVoice, voiceConfigured, voiceFor, voiceKeyVariable } from "../dist/voice/index.js";
import { lineKey, recordLine, RecordedLines } from "../dist/voice/lines.js";
import { withEnv } from "./helpers.ts";

const BLANK = {
  ELEVENLABS_API_KEY: undefined,
  FISH_AUDIO_API_KEY: undefined,
  JARVIS_VOICE_PROVIDER: undefined,
  JARVIS_FISH_MODEL: undefined,
  JARVIS_FISH_ENDPOINT: undefined,
  JARVIS_FISH_VOICE_ID: undefined,
  JARVIS_FISH_VOICE_ID_EN: undefined,
  JARVIS_FISH_LATENCY: undefined,
  JARVIS_FISH_NORMALIZE: undefined,
  JARVIS_VOICE_ID: undefined,
  JARVIS_VOICE_ID_EN: undefined,
  JARVIS_VOICE_SPEED: undefined,
};

function configWith(vars: Record<string, string | undefined>): Config {
  return withEnv({ ...BLANK, ...vars }, loadConfig);
}

/** A server that records what the client sends and lets a test answer. */
async function fishServer(): Promise<{
  url: string;
  received: Array<Record<string, unknown>>;
  /** The n-th connection the server saw, waiting for it if it has not yet. */
  client: (index?: number) => Promise<WebSocket>;
  close: () => void;
}> {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);

  const received: Array<Record<string, unknown>> = [];
  const clients: WebSocket[] = [];
  server.on("connection", (socket) => {
    clients.push(socket);
    socket.on("message", (raw) => {
      received.push(decode(raw as Buffer) as Record<string, unknown>);
    });
  });

  return {
    url: `ws://127.0.0.1:${address.port}`,
    received,
    client: async (index = 0) => {
      while (clients.length <= index) await once(server, "connection");
      return clients[index]!;
    },
    close: () => {
      for (const client of clients) client.terminate();
      server.close();
    },
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}

test("the provider follows the key that was given, and ElevenLabs when both are", () => {
  assert.equal(configWith({}).voiceProvider, "elevenlabs");
  assert.equal(configWith({ FISH_AUDIO_API_KEY: "f" }).voiceProvider, "fish");
  assert.equal(configWith({ ELEVENLABS_API_KEY: "e" }).voiceProvider, "elevenlabs");
  assert.equal(
    configWith({ ELEVENLABS_API_KEY: "e", FISH_AUDIO_API_KEY: "f" }).voiceProvider,
    "elevenlabs",
    "two keys do not change who speaks until somebody says so",
  );
  assert.equal(
    configWith({ ELEVENLABS_API_KEY: "e", FISH_AUDIO_API_KEY: "f", JARVIS_VOICE_PROVIDER: "fish" })
      .voiceProvider,
    "fish",
  );
});

test("configured means the chosen service has its key, not that any key exists", () => {
  const fishNamedNoKey = configWith({ ELEVENLABS_API_KEY: "e", JARVIS_VOICE_PROVIDER: "fish" });
  assert.equal(fishNamedNoKey.voiceProvider, "fish");
  assert.equal(voiceConfigured(fishNamedNoKey), false);
  assert.equal(voiceKeyVariable(fishNamedNoKey), "FISH_AUDIO_API_KEY");

  assert.equal(voiceConfigured(configWith({ FISH_AUDIO_API_KEY: "f" })), true);
  assert.equal(voiceConfigured(configWith({})), false);
});

test("the free model is the default, and the voices fall back the way ElevenLabs' do", () => {
  const config = configWith({ FISH_AUDIO_API_KEY: "f", JARVIS_FISH_VOICE_ID: "nl-voice" });
  assert.equal(config.fishModel, "s2.1-pro-free");
  assert.equal(fishVoiceIdFor(config, "nl"), "nl-voice");
  assert.equal(fishVoiceIdFor(config, "en"), "nl-voice", "no English voice: the Dutch one reads it");
  assert.equal(voiceFor(config, "nl"), "nl-voice");

  const both = configWith({
    FISH_AUDIO_API_KEY: "f",
    JARVIS_FISH_VOICE_ID: "nl-voice",
    JARVIS_FISH_VOICE_ID_EN: "en-voice",
  });
  assert.equal(fishVoiceIdFor(both, "en"), "en-voice");
});

test("the start event asks for what the HUD can play, and names no voice when none is set", () => {
  const plain = startEvent(configWith({ FISH_AUDIO_API_KEY: "f" }), "nl");
  const request = plain["request"] as Record<string, unknown>;
  assert.equal(plain["event"], "start");
  assert.equal(request["text"], "");
  assert.equal(request["format"], "pcm");
  assert.equal(request["sample_rate"], 16000, "the HUD schedules 16 kHz PCM and nothing else");
  assert.equal(request["latency"], "normal", "prosody over the first word, unless the deployment says otherwise");
  assert.equal(request["chunk_length"], 200, "a sentence is not cut before its end");
  assert.equal(request["normalize"], true);
  assert.equal("reference_id" in request, false, "an empty voice is Fish's default, not an empty id");
  assert.deepEqual(request["prosody"], { speed: 1 });

  const voiced = startEvent(
    configWith({ FISH_AUDIO_API_KEY: "f", JARVIS_FISH_VOICE_ID: "abc", JARVIS_VOICE_SPEED: "0.9" }),
    "nl",
  );
  assert.equal((voiced["request"] as Record<string, unknown>)["reference_id"], "abc");
  assert.deepEqual((voiced["request"] as Record<string, unknown>)["prosody"], { speed: 0.9 });

  const quick = startEvent(
    configWith({ FISH_AUDIO_API_KEY: "f", JARVIS_FISH_LATENCY: "balanced", JARVIS_FISH_NORMALIZE: "no" }),
    "nl",
  );
  assert.equal((quick["request"] as Record<string, unknown>)["latency"], "balanced");
  assert.equal((quick["request"] as Record<string, unknown>)["normalize"], false);
});

test("frames that are not a MessagePack map with an event are ignored", () => {
  assert.equal(readEvent(Buffer.from("not msgpack at all")), null);
  assert.equal(readEvent(encode([1, 2, 3])), null);
  assert.equal(readEvent(encode({ audio: new Uint8Array(2) })), null, "no event name, no event");
  assert.deepEqual(readEvent(encode({ event: "finish", reason: "stop" })), {
    event: "finish",
    reason: "stop",
  });
  const audio = readEvent(encode({ event: "audio", audio: new Uint8Array([1, 2, 3]) }));
  assert.ok(audio?.audio instanceof Uint8Array);
  assert.equal(audio.audio.byteLength, 3);
});

test("a turn on Fish: start, text, stop; audio back as base64; finish ends it", async () => {
  const server = await fishServer();
  const opened: string[] = [];
  const audio: string[] = [];
  let done = 0;
  const errors: string[] = [];

  const config = configWith({ FISH_AUDIO_API_KEY: "f", JARVIS_FISH_VOICE_ID: "abc" });
  const voice = new FishVoice(
    { ...config, fishEndpoint: server.url },
    {
      onOpen: () => opened.push("open"),
      onAudio: (data, alignment) => {
        audio.push(data);
        assert.equal(alignment, undefined, "Fish sends no timings, and none are invented");
      },
      onDone: () => (done += 1),
      onError: (reason) => errors.push(reason),
    },
    "nl",
  );
  voice.speak("Goedemorgen. ");
  const client = await server.client();
  await settle();

  assert.deepEqual(opened, ["open"]);
  assert.equal(server.received[0]?.["event"], "start");
  assert.equal(
    (server.received[0]?.["request"] as Record<string, unknown>)["reference_id"],
    "abc",
  );
  assert.deepEqual(server.received[1], { event: "text", text: "Goedemorgen. " });
  assert.deepEqual(server.received[2], { event: "flush" }, "a closed sentence is synthesised now");

  voice.speak("Het is acht");
  voice.speak(" graden.");
  voice.finish();
  await settle();
  assert.deepEqual(
    server.received.slice(3).map((m) => m["event"]),
    ["text", "text", "flush", "stop"],
    "words inside a sentence are buffered; its full stop flushes; then the stop",
  );

  client.send(encode({ event: "audio", audio: new Uint8Array([0, 1, 2, 3]) }));
  client.send(encode({ event: "audio", audio: new Uint8Array(0) }));
  client.send(encode({ event: "finish", reason: "stop" }));
  await settle();

  assert.deepEqual(audio, [Buffer.from([0, 1, 2, 3]).toString("base64")], "an empty chunk is not audio");
  assert.equal(done, 1);
  assert.deepEqual(errors, []);
  assert.equal(voice.failed, false);
  server.close();
});

test("one piece of text with several sentences is flushed sentence by sentence", async () => {
  const server = await fishServer();
  const config = { ...configWith({ FISH_AUDIO_API_KEY: "f" }), fishEndpoint: server.url };
  const voice = new FishVoice(
    config,
    { onOpen: () => {}, onAudio: () => {}, onDone: () => {}, onError: () => {} },
    "nl",
  );
  voice.speak("Je zit aan je limiet. Ik kan nu even niets opzoeken. Om 2 uur wordt hij");
  await server.client();
  await settle();
  assert.deepEqual(
    server.received.slice(1).map((m) => (m["event"] === "text" ? `text:${String(m["text"])}` : String(m["event"]))),
    [
      "text:Je zit aan je limiet. ",
      "flush",
      "text:Ik kan nu even niets opzoeken. ",
      "flush",
      "text:Om 2 uur wordt hij",
    ],
    "each sentence is heard while the next is still being made; the open one waits",
  );
  voice.abort();
  server.close();
});

test("a socket that closes before the first sentence is reopened by it", async () => {
  const server = await fishServer();
  const errors: string[] = [];
  const config = { ...configWith({ FISH_AUDIO_API_KEY: "f" }), fishEndpoint: server.url };
  const voice = new FishVoice(
    config,
    { onOpen: () => {}, onAudio: () => {}, onDone: () => {}, onError: (r) => errors.push(r) },
    "nl",
  );
  const first = await server.client();
  await settle();
  first.close(1001);
  await settle();

  assert.equal(voice.failed, false, "nothing was said yet, so nothing was lost");
  voice.speak("Laat.");
  const second = await server.client(1);
  assert.notEqual(second, first);
  await settle();

  const events = server.received.map((m) => m["event"]);
  assert.deepEqual(events, ["start", "start", "text", "flush"], "a fresh start, then the sentence");
  assert.deepEqual(errors, []);
  server.close();
});

test("a socket that dies mid-sentence fails the turn, once", async () => {
  const server = await fishServer();
  const errors: string[] = [];
  const config = { ...configWith({ FISH_AUDIO_API_KEY: "f" }), fishEndpoint: server.url };
  const voice = new FishVoice(
    config,
    { onOpen: () => {}, onAudio: () => {}, onDone: () => {}, onError: (r) => errors.push(r) },
    "nl",
  );
  voice.speak("Halverwege");
  const client = await server.client();
  await settle();
  client.close(1011);
  await settle();

  assert.equal(voice.failed, true);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /1011/);
  voice.speak("meer");
  await settle();
  assert.equal(server.received.filter((m) => m["event"] === "text").length, 1, "a failed voice is silent");
  server.close();
});

test("a finish with reason error is a failure, not a quiet end", async () => {
  const server = await fishServer();
  const errors: string[] = [];
  let done = 0;
  const config = { ...configWith({ FISH_AUDIO_API_KEY: "f" }), fishEndpoint: server.url };
  new FishVoice(
    config,
    { onOpen: () => {}, onAudio: () => {}, onDone: () => (done += 1), onError: (r) => errors.push(r) },
    "nl",
  );
  const client = await server.client();
  await settle();
  client.send(encode({ event: "finish", reason: "error" }));
  await settle();

  assert.equal(done, 0);
  assert.equal(errors.length, 1);
  server.close();
});

test("openVoice hands out the voice the provider names", async () => {
  const server = await fishServer();
  const config = { ...configWith({ FISH_AUDIO_API_KEY: "f" }), fishEndpoint: server.url };
  const voice = openVoice(
    config,
    { onOpen: () => {}, onAudio: () => {}, onDone: () => {}, onError: () => {} },
    "nl",
  );
  assert.ok(voice instanceof FishVoice);
  voice.abort();
  server.close();
});

test("a fixed line is recorded once, kept on disk, and read back in the same voice only", async () => {
  const server = await fishServer();
  const config = { ...configWith({ FISH_AUDIO_API_KEY: "f", JARVIS_FISH_VOICE_ID: "abc" }), fishEndpoint: server.url };
  const dir = mkdtempSync(join(tmpdir(), "jarvis-lines-"));

  // Every connection is answered the same way: four bytes of audio, then done.
  const answer = async (index: number): Promise<void> => {
    const client = await server.client(index);
    await settle();
    client.send(encode({ event: "audio", audio: new Uint8Array([1, 2, 3, 4]) }));
    client.send(encode({ event: "finish", reason: "stop" }));
  };

  const recording = recordLine(config, "Momentje.", "nl");
  await answer(0);
  const clip = await recording;
  assert.ok(clip !== null);
  assert.deepEqual([...clip], [1, 2, 3, 4]);
  assert.deepEqual(
    server.received.map((m) => m["event"]),
    ["start", "text", "flush", "stop"],
    "the line goes down the ordinary socket, sentence end and all",
  );

  const lines = new RecordedLines(config, dir);
  assert.equal(lines.get("Momentje.", "nl"), null);
  const warming = lines.warm(["Momentje.", "Even kijken."], "nl");
  await answer(1);
  await answer(2);
  assert.equal(await warming, 2);
  assert.deepEqual([...(lines.get("Even kijken.", "nl") ?? [])], [1, 2, 3, 4]);

  const again = new RecordedLines(config, dir);
  assert.equal(again.size, 2, "read back from disk on the next start");
  assert.deepEqual([...(again.get("Momentje.", "nl") ?? [])], [1, 2, 3, 4]);
  assert.equal(await again.warm(["Momentje."], "nl"), 0, "nothing is recorded twice");

  const faster = { ...config, voiceSpeed: 1.1 };
  assert.equal(new RecordedLines(faster, dir).get("Momentje.", "nl"), null, "another speed is another voice");
  assert.notEqual(lineKey(config, "Momentje.", "nl"), lineKey(config, "Momentje.", "en"));
  server.close();
});
