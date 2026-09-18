/**
 * What a folded fact says afterwards.
 *
 * Folding used to replace the body outright, which silently erased the half of
 * a fact nobody repeated. These tests pin the repaired behaviour: restatements
 * replace, new information appends while it fits, and a body that already says
 * it is left alone. The decision function is pure, so none of this needs the
 * embedding model — the similarity is handed in.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { foldedBody } from "../dist/memory/tools.js";

test("a restatement replaces the old body", () => {
  const body = foldedBody("de droger stopt soms halverwege", "de wasdroger valt soms halverwege stil", 0.9);
  assert.equal(body, "de wasdroger valt soms halverwege stil");
});

test("new information about the same subject is appended, not lost", () => {
  const body = foldedBody("De droger stopt soms halverwege.", "De droger piept bij het starten.", 0.5);
  assert.equal(body, "De droger stopt soms halverwege. De droger piept bij het starten.");
});

test("appending adds a period when the old body had none", () => {
  const body = foldedBody("de droger stopt soms halverwege", "hij piept bij het starten", 0.5);
  assert.equal(body, "de droger stopt soms halverwege. hij piept bij het starten");
});

test("a body that already contains the new text is left alone", () => {
  const had = "De droger stopt soms halverwege en piept bij het starten.";
  assert.equal(foldedBody(had, "piept bij het starten", 0.5), had);
});

test("without embeddings the fold falls back to replacing", () => {
  const body = foldedBody("de droger stopt soms halverwege", "de droger piept bij het starten", null);
  assert.equal(body, "de droger piept bij het starten");
});

test("past the body cap the newest text wins", () => {
  const had = "x".repeat(390);
  const got = "de droger piept bij het starten";
  assert.equal(foldedBody(had, got, 0.5), got, "no room to append, so the update replaces");
});
