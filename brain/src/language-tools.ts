/**
 * Changing language by asking for it.
 *
 * There is no button. "Switch to Dutch" switches the voice for the whole
 * deployment, and JARVIS then asks, in the new language, whether the screen
 * should follow; the screen is a setting of its own, so a household can talk
 * Dutch to an English screen or the other way round. A question that merely
 * arrives in another language changes nothing -- the tool description says
 * so, and so does the language paragraph that opens the system prompt.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { SpeechLang } from "@jarvis/shared";

import { OFFER_SETTING, languageName, type Language, type SettingStore } from "./language.js";

export const LANGUAGE_SERVER_NAME = "language";
export const LANGUAGE_TOOLS = [`mcp__${LANGUAGE_SERVER_NAME}__*`];

const LANG = z.enum(["en", "nl"]);

/** What the model is told after the voice switched. Pure. */
export function speechSwitched(lang: SpeechLang, changed: boolean, screenLang: SpeechLang): string {
  const name = languageName(lang);
  if (!changed) return `Speech was already ${name}. Carry on in ${name}.`;
  const said =
    `Speech is now ${name}. Your reply to this, and everything after it, is in ${name} -- ` +
    `not in the language you were speaking until now.`;
  if (screenLang === lang) return said;
  return (
    `${said} The screen is still in ${languageName(screenLang)}: ask now, in ${name}, ` +
    `whether the screen should switch to ${name} as well. If the answer is yes, call ` +
    `set_interface_language.`
  );
}

/** What the model is told after the screen switched. Pure. */
export function screenSwitched(lang: SpeechLang, changed: boolean): string {
  const name = languageName(lang);
  return changed ? `The screen is now in ${name}.` : `The screen was already in ${name}.`;
}

export function createLanguageServer(speech: Language, screen: Language, store: SettingStore) {
  const setSpeech = tool(
    "set_speech_language",
    "Switch the language you speak in, for the whole deployment. Call it only when " +
      "someone explicitly asks you to speak or switch to another language -- 'switch to " +
      "Dutch', 'praat Nederlands', 'speak English from now on'. A question that is merely " +
      "asked in another language is NOT such a request: answer it in the current language " +
      "and do not call this. After a switch, follow what the result tells you to ask.",
    { lang: LANG.describe("en for English, nl for Dutch") },
    async ({ lang }) => {
      const changed = speech.set(lang);
      const screenLang = screen.current;
      store.setSetting(OFFER_SETTING, changed && screenLang !== lang ? lang : "");
      return { content: [{ type: "text" as const, text: speechSwitched(lang, changed, screenLang) }] };
    },
  );

  const setScreen = tool(
    "set_interface_language",
    "Switch the language of the screen -- its labels, dates and placeholders -- on every " +
      "open page. Call it when someone says yes to switching the screen after a language " +
      "switch, or asks for the screen's language directly. It does not change the language " +
      "you speak in.",
    { lang: LANG.describe("en for English, nl for Dutch") },
    async ({ lang }) => {
      const changed = screen.set(lang);
      store.setSetting(OFFER_SETTING, "");
      return { content: [{ type: "text" as const, text: screenSwitched(lang, changed) }] };
    },
  );

  return createSdkMcpServer({
    name: LANGUAGE_SERVER_NAME,
    version: "1.0.0",
    tools: [setSpeech, setScreen],
  });
}
