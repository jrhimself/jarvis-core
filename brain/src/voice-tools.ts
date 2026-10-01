/**
 * Choosing the voice by asking for it.
 *
 * "Speak with Cori from now on" used to be three jobs for a person: find the
 * voice's id, put it in the env file, restart the service. None of the three
 * needs a person. The voice is a setting like the language is a setting, the
 * services can be asked what voices they have, and a Piper voice that is not on
 * the machine yet is two files and a download.
 *
 * So: `list_voices` says what there is, `set_voice` reads with one of them from
 * the next sentence onwards, and neither is particular to a service or a name.
 * A request for a voice nobody has heard of is answered by the catalogue rather
 * than by a guess: an id that is almost right is a voice that fails on the first
 * sentence of the next answer, where nothing can be done about it.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { SpeechLang } from "@jarvis/shared";

import type { Config } from "./config.js";
import { languageName } from "./language.js";
import { installVoice, matchVoices, remoteVoices, voiceInstalled, type RemoteVoice } from "./voice/catalogue.js";
import { DEFAULT_VOICE, type VoiceChoice } from "./voice/choice.js";
import { preloadPiperVoice } from "./voice/piper.js";
import {
  defaultVoiceFor,
  voiceCatalogue,
  voiceProviderName,
  voicesCanBeFetched,
  type VoiceOption,
} from "./voice/index.js";

export const VOICE_SERVER_NAME = "voice";
export const VOICE_TOOLS = [`mcp__${VOICE_SERVER_NAME}__*`];

/** Both languages, or one of them. A voice is set per language, like a voice is. */
const WHICH = z.enum(["both", "en", "nl"]);

/** As many voices as are worth reading out; the rest are a count. */
const LISTED = 40;

/** One voice as a line: what to ask for, what it reads, what it is called. */
export function voiceLine(option: VoiceOption, bytes?: number): string {
  const about = [option.language, option.note, bytes === undefined ? undefined : `${megabytes(bytes)} MB`]
    .filter((part) => part !== undefined && part !== "")
    .join(", ");
  const named = option.name === option.id ? option.id : `${option.name} -- ${option.id}`;
  return about === "" ? `- ${named}` : `- ${named} (${about})`;
}

function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1024 / 1024));
}

/**
 * What the model is told about the voices there are. Pure, so what it reads can
 * be tested without a service on the other end.
 */
export function voicesAnswer(
  providerName: string,
  current: Record<SpeechLang, string>,
  options: readonly VoiceOption[] | null,
  offered: readonly RemoteVoice[],
  like: string,
): string {
  const lines = [
    `Speaking with ${providerName}. Dutch is read by ${current.nl || "its default voice"}, ` +
      `English by ${current.en || "its default voice"}.`,
  ];

  if (options === null) {
    lines.push(
      `${providerName} publishes no list of its voices here, so set_voice takes whatever id you ` +
        `are given and uses it as it stands.`,
    );
  } else {
    const shown = like === "" ? options : matchVoices(options, like);
    const what = like === "" ? "available now" : `matching "${like}"`;
    lines.push(`${shown.length} voice(s) ${what}:`);
    lines.push(...shown.slice(0, LISTED).map((option) => voiceLine(option)));
    if (shown.length > LISTED) lines.push(`...and ${shown.length - LISTED} more; narrow it with "like".`);
  }

  if (offered.length > 0) {
    const shown = like === "" ? offered : matchVoices(offered, like);
    if (shown.length > 0) {
      lines.push(`Not here yet, but set_voice will fetch any of these:`);
      lines.push(...shown.slice(0, LISTED).map((option) => voiceLine(option, option.bytes)));
      if (shown.length > LISTED) lines.push(`...and ${shown.length - LISTED} more; narrow it with "like".`);
    }
  }

  return lines.join("\n");
}

/** What the model is told after the voice changed. Pure. */
export function voiceSwitched(
  langs: readonly SpeechLang[],
  option: VoiceOption,
  alternatives: readonly VoiceOption[],
  fetched: number | null,
): string {
  const which = langs.length === 2 ? "Dutch and English" : languageName(langs[0] as SpeechLang);
  const got = fetched === null ? "" : ` It was fetched first: ${megabytes(fetched)} MB.`;
  const also =
    alternatives.length === 0
      ? ""
      : ` Also matched, if this is the wrong one: ${alternatives.map((other) => other.id).join(", ")}.`;
  return (
    `${which} is now read by ${option.name} (${option.id}).${got} It takes effect on your very next ` +
    `sentence, so say so in it -- and in this voice.${also}`
  );
}

/** What the model is told after the deployment's own voice came back. Pure. */
export function voiceReset(langs: readonly SpeechLang[], voices: readonly string[]): string {
  const which = langs.length === 2 ? "Dutch and English" : languageName(langs[0] as SpeechLang);
  return `${which} is read by the deployment's own voice again (${voices.join(", ")}).`;
}

function langsOf(which: "both" | "en" | "nl"): SpeechLang[] {
  return which === "both" ? ["nl", "en"] : [which];
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The voice tool server.
 *
 * The choice and the config are passed in rather than read here, so that what a
 * turn switches is the same object the conversation asks before it speaks.
 */
export function createVoiceServer(config: Config, choice: VoiceChoice) {
  const current = (): Record<SpeechLang, string> => ({ nl: choice.for("nl"), en: choice.for("en") });

  const list = tool(
    "list_voices",
    "Every voice that can read your answers: the ones available now, and -- where they can be " +
      "fetched -- the ones that could be. Call it when somebody asks which voices there are, " +
      "which voice you are using, or for a voice by a name you have not seen in a list yet. " +
      "`like` narrows it to the voices whose name or id contains a word.",
    { like: z.string().optional().describe("a name or part of one, to narrow the list") },
    async ({ like }) => {
      let options: readonly VoiceOption[] | null = null;
      try {
        options = await voiceCatalogue(config);
      } catch (error) {
        return say(
          `The voices of ${voiceProviderName(config)} could not be listed: ${reasonFor(error)}. ` +
            `Say so rather than guessing at an id.`,
        );
      }
      let offered: RemoteVoice[] = [];
      if (voicesCanBeFetched(config)) {
        try {
          const installed = new Set((options ?? []).map((option) => option.id));
          offered = (await remoteVoices(config)).filter((voice) => !installed.has(voice.id));
        } catch {
          // The collection being unreachable is not worth a paragraph: what is
          // already on the machine is still the answer to the question asked.
          offered = [];
        }
      }
      return say(voicesAnswer(voiceProviderName(config), current(), options, offered, (like ?? "").trim()));
    },
  );

  const set = tool(
    "set_voice",
    "Read your answers with another voice from now on, for the whole deployment. Call it when " +
      "somebody asks for a voice by name -- 'use Cori', 'spreek met Jessica', 'a different voice " +
      "for English'. Name it as it was asked for: the id is looked up here, and a voice that is " +
      "not on the machine yet is fetched. `default` puts the deployment's own voice back. The " +
      "change holds until somebody asks for another one, surviving restarts.",
    {
      voice: z.string().describe("the voice as a person names it, its exact id, or `default`"),
      lang: WHICH.optional().describe("which language it reads: both (the default), en, or nl"),
    },
    async ({ voice, lang }) => {
      const langs = langsOf(lang ?? "both");
      const wanted = voice.trim();

      if (wanted.toLowerCase() === DEFAULT_VOICE) {
        for (const each of langs) choice.clear(each);
        return say(voiceReset(langs, langs.map((each) => defaultVoiceFor(config, each))));
      }

      let options: readonly VoiceOption[] | null;
      try {
        options = await voiceCatalogue(config);
      } catch (error) {
        return say(`The voices of ${voiceProviderName(config)} could not be listed: ${reasonFor(error)}.`);
      }

      // No catalogue at all: the id is the user's to give, as it was before any
      // of this existed.
      if (options === null) {
        for (const each of langs) choice.set(each, wanted);
        return say(voiceSwitched(langs, { id: wanted, name: wanted }, [], null));
      }

      const [here, ...alsoHere] = matchVoices(options, wanted);
      if (here !== undefined) {
        const failure = await use(config, choice, langs, here.id);
        if (failure !== null) return say(failure);
        return say(voiceSwitched(langs, here, alsoHere, null));
      }

      if (!voicesCanBeFetched(config)) {
        return say(
          `No voice of ${voiceProviderName(config)} is called "${wanted}". Call list_voices and ` +
            `offer what is actually there.`,
        );
      }

      let offered: RemoteVoice[];
      try {
        offered = await remoteVoices(config);
      } catch (error) {
        return say(
          `"${wanted}" is not on this machine and the voice collection could not be reached ` +
            `(${reasonFor(error)}), so it cannot be fetched now.`,
        );
      }
      const [found, ...alsoFound] = matchVoices(offered, wanted);
      if (found === undefined) {
        return say(
          `Nothing published is called "${wanted}" either. Call list_voices and offer what is there.`,
        );
      }

      let fetched = 0;
      try {
        // A voice may be published under a name whose files are already here --
        // fetching it again would be two minutes for nothing.
        fetched = (await voiceInstalled(config, found.id)) ? 0 : await installVoice(config, found);
      } catch (error) {
        return say(`${found.id} could not be fetched: ${reasonFor(error)}.`);
      }
      const failure = await use(config, choice, langs, found.id);
      if (failure !== null) return say(failure);
      return say(voiceSwitched(langs, found, alsoFound, fetched));
    },
  );

  return createSdkMcpServer({ name: VOICE_SERVER_NAME, version: "1.0.0", tools: [list, set] });
}

/**
 * Stores the choice and makes the voice ready, or says why it cannot be used.
 *
 * A local voice is loaded here rather than on the first sentence: a model that
 * will not load is then a sentence saying so, instead of a turn that goes out
 * in the browser's own voice for no visible reason. Nothing is stored unless it
 * loaded, so a failed attempt leaves the deployment speaking as it was.
 */
async function use(
  config: Config,
  choice: VoiceChoice,
  langs: readonly SpeechLang[],
  id: string,
): Promise<string | null> {
  if (config.voiceProvider === "piper") {
    try {
      await preloadPiperVoice(config, id);
    } catch (error) {
      return `${id} would not load: ${reasonFor(error)}. Nothing changed.`;
    }
  }
  for (const each of langs) choice.set(each, id);
  return null;
}

function say(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
