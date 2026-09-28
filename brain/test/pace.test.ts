import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pcmDurationMs, spreadAlignment } from "../dist/voice/pace.js";

describe("pcmDurationMs", () => {
  it("reads a 16 kHz signed 16-bit clip as 32000 bytes a second", () => {
    assert.equal(pcmDurationMs(32_000), 1000);
    assert.equal(pcmDurationMs(0), 0);
  });
});

describe("spreadAlignment", () => {
  it("gives every character a timing, spread evenly over the clip", () => {
    const a = spreadAlignment("One moment. ", 1200);
    assert.ok(a !== undefined);
    assert.equal(a.chars.join(""), "One moment. ");
    assert.equal(a.startMs[0], 0);
    assert.equal(a.startMs[6], 600);
    assert.ok(a.durMs.every((d) => d === 100));
    assert.equal(a.startMs.at(-1)! + a.durMs.at(-1)!, 1200);
  });

  it("counts characters, not code units", () => {
    assert.deepEqual(spreadAlignment("😀ok", 300)?.chars, ["😀", "o", "k"]);
  });

  it("has nothing to say about an empty line or a silent clip", () => {
    assert.equal(spreadAlignment("", 500), undefined);
    assert.equal(spreadAlignment("Hi.", 0), undefined);
  });
});
