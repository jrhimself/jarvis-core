/**
 * Dashes out of speech, however the answer is cut into chunks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SpokenText } from "../dist/spoken.js";

/** Feeds the text in the given pieces and returns everything that came out. */
function through(pieces: string[]): string {
  const spoken = new SpokenText();
  return pieces.map((piece) => spoken.push(piece)).join("") + spoken.flush();
}

test("a dash between clauses becomes a comma, whichever dash it was", () => {
  assert.equal(
    through(["Je build faalde gisteren — die twee vragen iets van je."]),
    "Je build faalde gisteren, die twee vragen iets van je.",
  );
  assert.equal(through(["gisteren -- die twee"]), "gisteren, die twee");
  assert.equal(through(["gisteren - die twee"]), "gisteren, die twee");
  assert.equal(through(["gisteren – die twee"]), "gisteren, die twee");
  assert.equal(through(["gisteren—die twee"]), "gisteren, die twee", "an em dash needs no spaces");
});

test("a dash after a mark that already pauses is simply dropped", () => {
  assert.equal(through(["Klaar. — Maar niet gemerged."]), "Klaar. Maar niet gemerged.");
  assert.equal(through(["Twee dingen: — het weer"]), "Twee dingen: het weer");
  assert.equal(through(["ja, -- nee"]), "ja, nee");
});

test("hyphens inside words and en dashes inside ranges are not dashes", () => {
  assert.equal(through(["Stuur de e-mail over de to-do tussen 9–17 uur."]), "Stuur de e-mail over de to-do tussen 9–17 uur.");
  assert.equal(through(["min -3 graden"]), "min -3 graden");
});

test("a dash split across chunks is still one dash", () => {
  const pieces = [["gisteren ", "— die"], ["gisteren —", " die"], ["gisteren -", "- die"], ["gisteren", " — ", "die"]];
  for (const cut of pieces) assert.equal(through(cut), "gisteren, die", JSON.stringify(cut));
  assert.equal(through(["Klaar.", " —", " Maar"]), "Klaar. Maar");
});

test("what is held back is only the unsettled tail, and comes out on its own", () => {
  const spoken = new SpokenText();
  assert.equal(spoken.push("Het is acht "), "Het is acht", "the space may be the start of a dash");
  assert.equal(spoken.push("graden."), " graden.");
  assert.equal(spoken.push(" "), "");
  assert.equal(spoken.flush(), " ");
  assert.equal(spoken.flush(), "");
});

test("a chunk ending in a hyphen inside a word waits for the rest of the word", () => {
  const spoken = new SpokenText();
  assert.equal(spoken.push("Stuur een e-"), "Stuur een e");
  assert.equal(spoken.push("mail."), "-mail.");
});
