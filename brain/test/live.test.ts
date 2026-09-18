/**
 * The one path where the brain speaks without being asked.
 *
 * Small enough to read in a minute, and worth testing anyway: the failure
 * notification is the only caller, it fires when nobody is watching, and every
 * way it can go wrong is silent. What matters is that a closed page is really
 * gone, that two open pages do not answer in chorus, and that the caller can
 * tell whether anything was actually heard.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { addLiveSession, liveSessionCount, speakUnprompted } from "../dist/live.js";

test("with nobody listening the line is not spoken", () => {
  assert.equal(liveSessionCount(), 0);
  assert.equal(speakUnprompted("er is niemand"), false);
});

test("the newest page speaks, alone", () => {
  const heard: string[] = [];
  const forgetOld = addLiveSession((text) => heard.push(`hal: ${text}`));
  const forgetNew = addLiveSession((text) => heard.push(`kantoor: ${text}`));

  assert.equal(speakUnprompted("de fix is mislukt"), true);
  assert.deepEqual(heard, ["kantoor: de fix is mislukt"]);

  forgetNew();
  assert.equal(speakUnprompted("nog een keer"), true);
  assert.deepEqual(heard, ["kantoor: de fix is mislukt", "hal: nog een keer"]);

  forgetOld();
  assert.equal(liveSessionCount(), 0);
});

test("a page that closed hears nothing afterwards", () => {
  let heard = 0;
  const forget = addLiveSession(() => (heard += 1));
  forget();
  forget();

  assert.equal(speakUnprompted("iets"), false);
  assert.equal(heard, 0);
});

test("a socket that died on the write reads as not spoken", () => {
  const forget = addLiveSession(() => {
    throw new Error("socket closed");
  });
  assert.equal(speakUnprompted("iets"), false);
  forget();
});

test("an empty line is never spoken, and does not need a listener to prove it", () => {
  const heard: string[] = [];
  const forget = addLiveSession((text) => heard.push(text));
  assert.equal(speakUnprompted("   \n "), false);
  assert.deepEqual(heard, []);
  forget();
});
