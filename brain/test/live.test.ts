/**
 * The one path where the brain speaks, or shows something, without being asked.
 *
 * Small enough to read in a minute, and worth testing anyway: the callers fire
 * when nobody is watching, and every way they can go wrong is silent. What
 * matters is that a closed page is really gone, that two open pages do not
 * answer in chorus, and that the caller can tell whether anything was heard.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DisplayPayload } from "@jarvis/shared";

import {
  addLiveSession,
  liveSessionCount,
  showUnprompted,
  speakUnprompted,
  type LiveSession,
} from "../dist/live.js";

const CARD: DisplayPayload = { type: "image", url: "/media/x.jpg", alt: "Door" };

/** A page that only listens, for the tests that are about speech alone. */
function ear(say: (text: string) => void): LiveSession {
  return { say, show: () => {} };
}

test("with nobody listening the line is not spoken", () => {
  assert.equal(liveSessionCount(), 0);
  assert.equal(speakUnprompted("there is nobody here"), false);
});

test("the newest page speaks, alone", () => {
  const heard: string[] = [];
  const forgetOld = addLiveSession(ear((text) => heard.push(`first: ${text}`)));
  const forgetNew = addLiveSession(ear((text) => heard.push(`second: ${text}`)));

  assert.equal(speakUnprompted("the fix failed"), true);
  assert.deepEqual(heard, ["second: the fix failed"]);

  forgetNew();
  assert.equal(speakUnprompted("once more"), true);
  assert.deepEqual(heard, ["second: the fix failed", "first: once more"]);

  forgetOld();
  assert.equal(liveSessionCount(), 0);
});

test("a page that closed hears nothing afterwards", () => {
  let heard = 0;
  const forget = addLiveSession(ear(() => (heard += 1)));
  forget();
  forget();

  assert.equal(speakUnprompted("anything"), false);
  assert.equal(heard, 0);
});

test("a socket that died on the write reads as not spoken", () => {
  const forget = addLiveSession(
    ear(() => {
      throw new Error("socket closed");
    }),
  );
  assert.equal(speakUnprompted("anything"), false);
  forget();
});

test("an empty line is never spoken, and does not need a listener to prove it", () => {
  const heard: string[] = [];
  const forget = addLiveSession(ear((text) => heard.push(text)));
  assert.equal(speakUnprompted("   \n "), false);
  assert.deepEqual(heard, []);
  forget();
});

test("with nobody watching a window is not shown", () => {
  assert.equal(liveSessionCount(), 0);
  assert.equal(showUnprompted("door:x", CARD, { mode: "manual" }), false);
});

test("a window goes to the newest page only, with its id and its dismissal", () => {
  const shown: string[] = [];
  function record(where: string): LiveSession {
    return {
      say: () => {},
      show: (id, payload, dismiss) => {
        assert.equal(payload, CARD);
        shown.push(`${where}: ${id} ${dismiss.mode}`);
      },
    };
  }

  const forgetOld = addLiveSession(record("first"));
  const forgetNew = addLiveSession(record("second"));

  assert.equal(showUnprompted("door:x", CARD, { mode: "timeout", ms: 1000 }), true);
  assert.deepEqual(shown, ["second: door:x timeout"]);

  forgetNew();
  forgetOld();
});

test("a socket that died on the push reads as not shown", () => {
  const forget = addLiveSession({
    say: () => {},
    show: () => {
      throw new Error("socket closed");
    },
  });
  assert.equal(showUnprompted("door:x", CARD, { mode: "manual" }), false);
  forget();
});
