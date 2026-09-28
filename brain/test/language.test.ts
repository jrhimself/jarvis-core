/**
 * The language switch: where the choice is kept, who hears about it, and what
 * the model is told.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  INTERFACE_SETTING,
  LANGUAGE_SETTING,
  Language,
  languageBlock,
  languageHook,
  languageNote,
  offerNote,
  type SettingStore,
} from "../dist/language.js";
import { screenSwitched, speechSwitched } from "../dist/language-tools.js";

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

test("the note in front of a question names the language and nothing else", () => {
  assert.equal(languageNote("en"), "[Answer in English.]");
  assert.equal(languageNote("nl"), "[Answer in Dutch.]");
});

test("after every batch of tool answers the model is told the language once more", async () => {
  const matcher = languageHook("en");
  assert.equal(matcher.hooks.length, 1);
  const hook = matcher.hooks[0];
  assert.ok(hook !== undefined);
  const output = await hook(
    { hook_event_name: "PostToolBatch", session_id: "s", transcript_path: "", cwd: "", tool_calls: [] } as never,
    undefined,
    { signal: new AbortController().signal },
  );
  const specific = (output as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } })
    .hookSpecificOutput;
  assert.equal(specific?.hookEventName, "PostToolBatch");
  assert.match(specific?.additionalContext ?? "", /^\[Answer in English\.\]/);
  assert.match(specific?.additionalContext ?? "", /from here is in English/);
});

test("the screen keeps its language in a row of its own", () => {
  const store = table();
  const speech = new Language(store, "en");
  const screen = new Language(store, "en", INTERFACE_SETTING);
  speech.set("nl");
  assert.equal(speech.current, "nl");
  assert.equal(screen.current, "en", "switching the voice leaves the screen alone");
  screen.set("nl");
  assert.equal(store.rows.get(INTERFACE_SETTING), "nl");
});

test("a question in another language is not a request to switch", () => {
  assert.match(languageBlock("en"), /not a request to switch/);
  assert.match(languageBlock("en"), /set_speech_language/);
});

test("after the voice switches, the screen is offered, in the new language", () => {
  const text = speechSwitched("nl", true, "en");
  assert.match(text, /Speech is now Dutch/);
  assert.match(text, /ask now, in Dutch, whether the screen should switch to Dutch/);
  assert.doesNotMatch(speechSwitched("nl", true, "nl"), /screen/);
  assert.match(speechSwitched("nl", false, "en"), /already Dutch/);
  assert.match(screenSwitched("nl", true), /screen is now in Dutch/);
});

test("the offer reaches the next session only while it still fits", () => {
  assert.match(offerNote("nl", "en", "nl"), /call set_interface_language with "nl"/);
  assert.equal(offerNote("nl", "nl", "nl"), "", "the screen already followed");
  assert.equal(offerNote("en", "en", "nl"), "", "the voice switched back since");
  assert.equal(offerNote("nl", "en", null), "");
});

test("the note after a tool round follows a switch made in that turn", async () => {
  let current: "en" | "nl" = "nl";
  const hook = languageHook(() => current);
  const fire = async () => {
    const out = (await hook.hooks[0]!({} as never, undefined, { signal: new AbortController().signal })) as {
      hookSpecificOutput: { additionalContext: string };
    };
    return out.hookSpecificOutput.additionalContext;
  };
  assert.match(await fire(), /in Dutch/);
  current = "en";
  assert.match(await fire(), /in English/);
});
