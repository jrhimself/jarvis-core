/**
 * Section markers out of the answer, and where they stood, however it is cut.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SectionMarks, sectionMarkBlock } from "../dist/sections.js";

/** Feeds the pieces; returns the text that came out and each mark as an offset into it. */
function through(pieces: string[]): { text: string; marks: Array<[string, number]> } {
  const sections = new SectionMarks();
  let text = "";
  const marks: Array<[string, number]> = [];
  for (const pass of [...pieces.map((piece) => sections.push(piece)), sections.flush()]) {
    for (const mark of pass.marks) marks.push([mark.topic, text.length + mark.at]);
    text += pass.text;
  }
  return { text, marks };
}

const BRIEFING =
  "⟦weather⟧Rain today, 16 degrees. ⟦agenda⟧On the agenda: a meeting at 8:30. " +
  "⟦work⟧On the pull requests: one about notes. ⟦notes⟧Overnight, two notes.";

test("markers are taken out and each lands where its part begins", () => {
  const { text, marks } = through([BRIEFING]);
  assert.equal(
    text,
    "Rain today, 16 degrees. On the agenda: a meeting at 8:30. " +
      "On the pull requests: one about notes. Overnight, two notes.",
  );
  assert.deepEqual(
    marks.map(([topic, at]) => [topic, text.slice(at, at + 6)]),
    [
      ["weather", "Rain t"],
      ["agenda", "On the"],
      ["work", "On the"],
      ["notes", "Overni"],
    ],
  );
});

test("the same, when every marker is cut through by the chunking", () => {
  const whole = through([BRIEFING]);
  for (const size of [1, 2, 3, 5, 7]) {
    const pieces: string[] = [];
    for (let i = 0; i < BRIEFING.length; i += size) pieces.push(BRIEFING.slice(i, i + size));
    assert.deepEqual(through(pieces), whole, `chunks of ${size}`);
  }
});

test("a word that names a subject is not a marker", () => {
  // The false positives that made this necessary: "notes" in a pull request.
  const { marks } = through(["⟦work⟧A pull request called notes, and a review."]);
  assert.deepEqual(marks.map(([topic]) => topic), ["work"]);
});

test("a marker between spaces leaves one space, not two", () => {
  assert.equal(through(["Rain. ⟦agenda⟧ On the agenda."]).text, "Rain. On the agenda.");
  assert.equal(through(["Rain. ", "⟦agenda⟧", " On the agenda."]).text, "Rain. On the agenda.");
});

test("a bracketed thing that is not a topic is dropped, never said", () => {
  const { text, marks } = through(["Hello ⟦Not A Topic!⟧there."]);
  assert.equal(text, "Hello there.");
  assert.deepEqual(marks, []);
});

test("an opening bracket that never closes is let go, not held for ever", () => {
  const long = "⟦" + "x".repeat(60);
  assert.equal(through([long, " and on."]).text, long + " and on.");
  // Short and unclosed at the end: flushed as it stands.
  assert.equal(through(["Done ⟦wea"]).text, "Done ⟦wea");
});

test("topics are lowercased and pack topics pass through", () => {
  assert.deepEqual(through(["⟦Weather⟧Sun. ⟦house-energy⟧Solar."]).marks.map(([t]) => t), [
    "weather",
    "house-energy",
  ]);
});

test("the prompt names every valid topic as its marker", () => {
  const block = sectionMarkBlock(["weather", "agenda", "Bad Topic"]);
  assert.match(block, /⟦weather⟧, ⟦agenda⟧/);
  assert.doesNotMatch(block, /Bad Topic/);
  assert.equal(sectionMarkBlock([]), "");
});
