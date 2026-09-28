/**
 * The door watch: a camera that goes up because somebody is at the door.
 *
 * Nothing here can be seen failing. It fires when nobody is talking to the
 * assistant, it writes to a page that may not be open, and the picture it is
 * about is gone half a minute later. So the tests are about the edges that
 * decide whether it fires at all: the state that was already `on` when the feed
 * connected, the three sensors that move for one ring, and the pairing a
 * deployment wrote by hand.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { HomeProvider, StateChange } from "@jarvis/shared";

import { parseDoorWatch, startDoorWatch } from "../dist/door.js";
import { addLiveSession } from "../dist/live.js";
import { recentScreens } from "../dist/screens.js";

import { fakeHome } from "./helpers.ts";

/** A house whose feed the test drives by hand. */
function watchedHouse(ids: string[]): {
  home: HomeProvider;
  move: (entityId: string, state: string) => void;
  subscribed: () => string[];
} {
  const home = fakeHome({ entities: ids.map((id) => ({ id })) });
  let listener: ((change: StateChange) => void) | null = null;
  let asked: string[] = [];
  home.subscribe = async (subscribeTo, onChange) => {
    asked = subscribeTo;
    listener = onChange;
  };
  return {
    home,
    move: (entityId, state) =>
      listener?.({ entityId, state, attributes: {}, changedAt: new Date() }),
    subscribed: () => asked,
  };
}

/** A camera that answers with an image, so nothing reaches the network. */
function stubFetch(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from("jpeg"), {
      headers: { "content-type": "image/jpeg" },
    })) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

/** Lets the fetch behind a push finish. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

test("a pairing is read per camera, with its sensors", () => {
  assert.deepEqual(
    parseDoorWatch("camera.one=binary_sensor.a,binary_sensor.b; camera.two=event.c"),
    [
      { camera: "camera.one", triggers: ["binary_sensor.a", "binary_sensor.b"] },
      { camera: "camera.two", triggers: ["event.c"] },
    ],
  );
});

test("a sensor named twice is watched once", () => {
  assert.deepEqual(parseDoorWatch("camera.one=binary_sensor.a,binary_sensor.a"), [
    { camera: "camera.one", triggers: ["binary_sensor.a"] },
  ]);
});

test("nothing configured watches nothing", () => {
  assert.deepEqual(parseDoorWatch(undefined), []);
  assert.deepEqual(parseDoorWatch("  "), []);
});

test("a pairing that is not a camera, or has no sensor, is dropped", () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(parseDoorWatch("light.one=binary_sensor.a"), []);
    assert.deepEqual(parseDoorWatch("camera.one="), []);
    assert.deepEqual(parseDoorWatch("camera.one"), []);
  } finally {
    console.error = quiet;
  }
});

test("the state the feed replays on connect is not somebody at the door", async () => {
  const restore = stubFetch();
  const shown: string[] = [];
  const forget = addLiveSession({ say: () => {}, show: (id) => shown.push(id) });
  const house = watchedHouse(["camera.one", "binary_sensor.a"]);
  const stop = await startDoorWatch(house.home, [
    { camera: "camera.one", triggers: ["binary_sensor.a"] },
  ]);
  try {
    assert.deepEqual(house.subscribed(), ["binary_sensor.a"]);

    // What the feed sends the moment it subscribes, whatever it reads.
    house.move("binary_sensor.a", "on");
    await settle();
    assert.deepEqual(shown, []);

    house.move("binary_sensor.a", "off");
    house.move("binary_sensor.a", "on");
    await settle();
    assert.deepEqual(shown, ["door:camera.one"]);
  } finally {
    stop();
    forget();
    restore();
  }
});

test("one ring on three sensors is one window", async () => {
  const restore = stubFetch();
  let shown = 0;
  const forget = addLiveSession({ say: () => {}, show: () => (shown += 1) });
  const house = watchedHouse([
    "camera.one",
    "binary_sensor.a",
    "binary_sensor.b",
    "event.c",
  ]);
  const stop = await startDoorWatch(house.home, [
    { camera: "camera.one", triggers: ["binary_sensor.a", "binary_sensor.b", "event.c"] },
  ]);
  try {
    for (const id of ["binary_sensor.a", "binary_sensor.b"]) house.move(id, "off");
    house.move("event.c", "unknown");

    house.move("binary_sensor.a", "on");
    house.move("binary_sensor.b", "on");
    house.move("event.c", "2026-09-26T10:00:00+00:00");
    await settle();

    assert.equal(shown, 1);
  } finally {
    stop();
    forget();
    restore();
  }
});

test("an event entity fires on a new timestamp and not on an empty one", async () => {
  const restore = stubFetch();
  const shown: string[] = [];
  const forget = addLiveSession({ say: () => {}, show: (id) => shown.push(id) });
  const house = watchedHouse(["camera.one", "event.c"]);
  const stop = await startDoorWatch(house.home, [
    { camera: "camera.one", triggers: ["event.c"] },
  ]);
  try {
    house.move("event.c", "2026-09-26T10:00:00+00:00");
    house.move("event.c", "unavailable");
    await settle();
    assert.deepEqual(shown, []);

    house.move("event.c", "2026-09-26T10:00:10+00:00");
    await settle();
    assert.deepEqual(shown, ["door:camera.one"]);
  } finally {
    stop();
    forget();
    restore();
  }
});

test("what went up is in the log of what was on screen, with the camera's name", async () => {
  const restore = stubFetch();
  const forget = addLiveSession({ say: () => {}, show: () => {} });
  const house = watchedHouse(["camera.one", "binary_sensor.a"]);
  const entities = await house.home.listEntities();
  const camera = entities.find((entity) => entity.id === "camera.one");
  if (camera !== undefined) camera.name = "Front door";

  const stop = await startDoorWatch(house.home, [
    { camera: "camera.one", triggers: ["binary_sensor.a"] },
  ]);
  try {
    house.move("binary_sensor.a", "off");
    house.move("binary_sensor.a", "on");
    await settle();

    const last = recentScreens(1)[0];
    assert.equal(last?.id, "door:camera.one");
    assert.equal(last?.payload.type === "image" ? last.payload.alt : "", "Front door");
  } finally {
    stop();
    forget();
    restore();
  }
});

test("a window nobody could see is not logged as shown", async () => {
  const restore = stubFetch();
  const before = recentScreens(20).length;
  const house = watchedHouse(["camera.one", "binary_sensor.a"]);
  const stop = await startDoorWatch(house.home, [
    { camera: "camera.one", triggers: ["binary_sensor.a"] },
  ]);
  try {
    house.move("binary_sensor.a", "off");
    house.move("binary_sensor.a", "on");
    await settle();
    assert.equal(recentScreens(20).length, before);
  } finally {
    stop();
    restore();
  }
});

test("stopping the watch stops the windows", async () => {
  const restore = stubFetch();
  let shown = 0;
  const forget = addLiveSession({ say: () => {}, show: () => (shown += 1) });
  const house = watchedHouse(["camera.one", "binary_sensor.a"]);
  const stop = await startDoorWatch(house.home, [
    { camera: "camera.one", triggers: ["binary_sensor.a"] },
  ]);
  try {
    house.move("binary_sensor.a", "off");
    stop();
    house.move("binary_sensor.a", "on");
    await settle();
    assert.equal(shown, 0);
  } finally {
    forget();
    restore();
  }
});

test("a house without cameras is said so, once, and watches nothing", async () => {
  const house = watchedHouse(["camera.one", "binary_sensor.a"]);
  house.home.capabilities.camera = false;
  delete house.home.cameraStill;

  const quiet = console.error;
  const said: string[] = [];
  console.error = (line: unknown) => said.push(String(line));
  try {
    const stop = await startDoorWatch(house.home, [
      { camera: "camera.one", triggers: ["binary_sensor.a"] },
    ]);
    stop();
  } finally {
    console.error = quiet;
  }
  assert.equal(said.length, 1);
  assert.deepEqual(house.subscribed(), []);
});
