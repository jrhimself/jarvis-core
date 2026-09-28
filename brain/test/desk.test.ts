/**
 * Standing desk slots: core defaults, pack merge, briefing line.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CORE_DESK,
  deskBriefingBlock,
  mergeDeskSlots,
} from "../dist/desk.js";

test("core desk is five briefing subjects", () => {
  assert.equal(CORE_DESK.length, 5);
  assert.deepEqual(
    CORE_DESK.map((s) => s.topic),
    ["weather", "agenda", "mail", "work", "notes"],
  );
  assert.ok(CORE_DESK.every((s) => s.briefing === true));
});

test("with no packs the merge is the core desk", () => {
  assert.deepEqual(mergeDeskSlots([]), [...CORE_DESK]);
});

test("a pack appends a new topic after core", () => {
  const merged = mergeDeskSlots([{ topic: "house", label: "Huis" }]);
  assert.equal(merged.length, CORE_DESK.length + 1);
  assert.deepEqual(merged.at(-1), { topic: "house", label: "Huis" });
  assert.equal(merged.at(-1)?.briefing, undefined);
});

test("a pack that redeclares a core topic wins label and briefing", () => {
  const merged = mergeDeskSlots([
    { topic: "work", label: "PRs", briefing: true },
    { topic: "notes", label: "Notes" },
  ]);
  const work = merged.find((s) => s.topic === "work");
  const notes = merged.find((s) => s.topic === "notes");
  assert.deepEqual(work, { topic: "work", label: "PRs", briefing: true });
  assert.deepEqual(notes, { topic: "notes", label: "Notes" });
  assert.equal(notes?.briefing, undefined);
});

test("an empty topic is skipped", () => {
  const merged = mergeDeskSlots([
    { topic: "  ", label: "Blank" },
    { topic: "", label: "Also blank" },
    { topic: "house", label: "Huis" },
  ]);
  assert.equal(merged.filter((s) => s.label === "Blank" || s.label === "Also blank").length, 0);
  assert.ok(merged.some((s) => s.topic === "house"));
});

test("deskBriefingBlock names only briefing:true labels", () => {
  const block = deskBriefingBlock([
    { topic: "weather", label: "Weer", briefing: true },
    { topic: "house", label: "Huis" },
    { topic: "mail", label: "Mail", briefing: true },
  ]);
  assert.match(block, /Weer/);
  assert.match(block, /Mail/);
  assert.doesNotMatch(block, /Huis/);
  assert.match(block, /Standing desk/);
});

test("deskBriefingBlock is empty when nothing is in the briefing", () => {
  assert.equal(deskBriefingBlock([{ topic: "house", label: "Huis" }]), "");
  assert.equal(deskBriefingBlock([]), "");
});
