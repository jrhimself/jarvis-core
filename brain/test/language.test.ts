/**
 * The language switch: where the choice is kept, who hears about it, and what
 * the model is told.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Language, LANGUAGE_SETTING, languageBlock, type SettingStore } from "../dist/language.js";

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

test("nobody has chosen: the deployment's starting language", () => {
  assert.equal(new Language(table(), "en").current, "en");
  assert.equal(new Language(table(), "nl").current, "nl");
});

test("a choice is kept in the settings table and outranks the start", () => {
  const store = table();
  const lang = new Language(store, "en");
  assert.equal(lang.set("nl"), true);
  assert.equal(store.rows.get(LANGUAGE_SETTING), "nl");
  // A second object over the same table -- a restart -- still speaks Dutch.
  assert.equal(new Language(store, "en").current, "nl");
});

test("a stored value that is not a language is ignored, not spoken", () => {
  assert.equal(new Language(table({ [LANGUAGE_SETTING]: "de" }), "en").current, "en");
});

test("every switch is heard, and a switch to the same language is not one", () => {
  const lang = new Language(table(), "en");
  const heard: string[] = [];
  const stop = lang.onChange((next) => heard.push(next));
  assert.equal(lang.set("en"), false);
  lang.set("nl");
  lang.set("en");
  stop();
  lang.set("nl");
  assert.deepEqual(heard, ["nl", "en"]);
});

test("the model is told the language by name, and that its material may be in another", () => {
  assert.match(languageBlock("en"), /answer in English/);
  assert.match(languageBlock("nl"), /answer in Dutch/);
  assert.match(languageBlock("en"), /another language/);
});
