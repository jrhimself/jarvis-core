/**
 * Which voices there are, asked of whoever would speak with them.
 *
 * Until now the voice was a line in the env file, and "speak with another one"
 * was a person's job: find the id, edit the file, restart. The two questions
 * that job is made of are answered here -- what is there, and how does
 * something that is not there get here -- for each service in its own terms:
 *
 *   ElevenLabs   an account's voices, asked of the account.
 *   Piper        the models on this machine, and the ones that can be fetched
 *                from the published collection.
 *   Fish         nothing. A Fish voice is a model in an account reached by its
 *                reference id, with no list this side of the dashboard, so the
 *                id is taken as given rather than guessed at.
 *
 * Nothing is listed in this file. A catalogue written down in a repository is a
 * catalogue that is wrong by the time somebody downloads a voice.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import type { Config } from "../config.js";

/** One voice a service can read with, as that service lists it. */
export interface VoiceOption {
  /** What the service is told to use. On Piper the file name, without `.onnx`. */
  id: string;
  /** What a person calls it: often one word inside the id. */
  name: string;
  /** Which language it reads, in the service's own notation: `en_GB`, `nl`. */
  language?: string;
  /** Whatever else is worth saying about it, in a phrase. */
  note?: string;
}

/** A voice that could be had but is not here yet, with what it would cost. */
export interface RemoteVoice extends VoiceOption {
  /** The files to fetch, relative to the collection's root. */
  files: ReadonlyArray<{ path: string; bytes: number; md5?: string }>;
  /** Their total size, which is what somebody asking "how big" means. */
  bytes: number;
}

/** How long to wait for a catalogue; a slow answer is still an answer. */
const CATALOGUE_TIMEOUT_MS = 10_000;
/** No published Piper voice is a tenth of this. A bigger one is not a voice. */
const MAX_VOICE_BYTES = 300 * 1024 * 1024;
/** The two files a Piper voice is: the model, and what the model needs to be read. */
const MODEL_SUFFIXES = [".onnx", ".onnx.json"] as const;
/**
 * What may be used as a file name. The ids come from a downloaded index, so
 * this is the line between "a voice called cori" and a path of somebody else's
 * choosing written into the models directory.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Piper's own quality words, worst first; a tie between two voices breaks here. */
export const VOICE_QUALITIES: readonly string[] = ["x_low", "xlow", "low", "medium", "high"];

/** The Piper voices on this machine: a model with the file it needs beside it. */
export async function piperVoices(config: Config): Promise<VoiceOption[]> {
  let names: string[];
  try {
    names = await readdir(config.piperModels);
  } catch {
    // No directory is no voices, which is what the startup record already says.
    return [];
  }
  const present = new Set(names);
  return names
    .filter((name) => name.endsWith(".onnx") && present.has(`${name}.json`))
    .map((name) => describePiperVoice(name.slice(0, -".onnx".length)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * A Piper id read as what it is made of: `nl_NL-pim-medium` is Pim, reading
 * Dutch, at medium quality. Nothing enforces that shape, so anything that does
 * not have it is reported as its own name and no more.
 */
export function describePiperVoice(id: string): VoiceOption {
  const match = /^([A-Za-z]{2}(?:_[A-Za-z]{2,3})?)-(.+?)(?:-(x_low|xlow|low|medium|high))?$/.exec(id);
  if (match === null) return { id, name: id };
  const [, language, name, quality] = match;
  return {
    id,
    name: name ?? id,
    ...(language === undefined ? {} : { language }),
    ...(quality === undefined ? {} : { note: quality }),
  };
}

/** An ElevenLabs account's voices, or null when it has no key to ask with. */
export async function elevenLabsVoices(config: Config): Promise<VoiceOption[] | null> {
  if (config.elevenLabsKey === "") return null;
  const response = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": config.elevenLabsKey },
    signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ElevenLabs returned ${response.status}`);
  return voicesFromElevenLabs(await response.json());
}

/** The voices in an ElevenLabs `/v1/voices` answer. Exported for the tests. */
export function voicesFromElevenLabs(body: unknown): VoiceOption[] {
  const listed = (body as { voices?: unknown } | null)?.voices;
  if (!Array.isArray(listed)) return [];

  const voices: VoiceOption[] = [];
  for (const entry of listed) {
    if (typeof entry !== "object" || entry === null) continue;
    const voice = entry as Record<string, unknown>;
    const id = voice["voice_id"];
    const name = voice["name"];
    if (typeof id !== "string" || id === "" || typeof name !== "string") continue;
    const labels = typeof voice["labels"] === "object" && voice["labels"] !== null
      ? (voice["labels"] as Record<string, unknown>)
      : {};
    const language = labels["language"];
    const note = [labels["accent"], labels["description"]].filter((value) => typeof value === "string" && value !== "");
    voices.push({
      id,
      name: name === "" ? id : name,
      ...(typeof language === "string" && language !== "" ? { language } : {}),
      ...(note.length === 0 ? {} : { note: note.join(", ") }),
    });
  }
  return voices;
}

/**
 * Every Piper voice that has been published, whether or not it is here.
 *
 * The collection ships an index of itself, which is also where the file names
 * and sizes come from: a voice is fetched by the paths it declares rather than
 * by a URL this code guesses from a name.
 */
export async function remoteVoices(config: Config): Promise<RemoteVoice[]> {
  const response = await fetch(new URL("voices.json", withSlash(config.piperVoicesUrl)), {
    signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`the voice collection returned ${response.status}`);
  return voicesFromIndex(await response.json());
}

/** The voices in the published index. Exported for the tests. */
export function voicesFromIndex(body: unknown): RemoteVoice[] {
  if (typeof body !== "object" || body === null) return [];

  const voices: RemoteVoice[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Record<string, unknown>;
    const id = typeof entry["key"] === "string" && entry["key"] !== "" ? entry["key"] : key;
    if (!SAFE_ID.test(id)) continue;

    const files: Array<{ path: string; bytes: number; md5?: string }> = [];
    const listed = typeof entry["files"] === "object" && entry["files"] !== null
      ? (entry["files"] as Record<string, unknown>)
      : {};
    for (const suffix of MODEL_SUFFIXES) {
      const path = Object.keys(listed).find((name) => name.endsWith(`${id}${suffix}`));
      if (path === undefined) continue;
      const file = listed[path];
      const detail = typeof file === "object" && file !== null ? (file as Record<string, unknown>) : {};
      const bytes = Number(detail["size_bytes"]);
      const md5 = detail["md5_digest"];
      files.push({
        path,
        bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : 0,
        ...(typeof md5 === "string" && md5 !== "" ? { md5 } : {}),
      });
    }
    // A voice without its model, or without the file the model needs, cannot be
    // installed from this index however it is described.
    if (files.length !== MODEL_SUFFIXES.length) continue;

    const described = describePiperVoice(id);
    const language = languageOf(entry) ?? described.language;
    const quality = entry["quality"];
    voices.push({
      ...described,
      ...(language === undefined ? {} : { language }),
      ...(typeof quality === "string" && quality !== "" ? { note: quality } : {}),
      files,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    });
  }
  return voices.sort((left, right) => left.id.localeCompare(right.id));
}

function languageOf(entry: Record<string, unknown>): string | undefined {
  const language = entry["language"];
  if (typeof language === "string" && language !== "") return language;
  if (typeof language === "object" && language !== null) {
    const code = (language as Record<string, unknown>)["code"];
    if (typeof code === "string" && code !== "") return code;
  }
  return undefined;
}

/**
 * Fetches a voice onto this machine and returns how many bytes it took.
 *
 * Written to a temporary name and moved into place, so a download that is
 * interrupted leaves nothing that Piper would try to load. The size and the
 * digest come from the index: a file that does not match what was promised is
 * thrown away rather than kept and wondered about later.
 */
export async function installVoice(config: Config, voice: RemoteVoice): Promise<number> {
  if (!SAFE_ID.test(voice.id)) throw new Error(`${voice.id} is not a voice name`);
  if (voice.bytes > MAX_VOICE_BYTES) throw new Error(`${voice.id} is larger than a voice should be`);
  await mkdir(config.piperModels, { recursive: true });

  const base = withSlash(config.piperVoicesUrl);
  let written = 0;
  for (const [index, suffix] of MODEL_SUFFIXES.entries()) {
    const file = voice.files[index];
    if (file === undefined) throw new Error(`${voice.id} has no ${suffix} to fetch`);
    written += await fetchFile(new URL(file.path, base), join(config.piperModels, `${voice.id}${suffix}`), file);
  }
  return written;
}

async function fetchFile(
  url: URL,
  to: string,
  expected: { bytes: number; md5?: string },
): Promise<number> {
  const partial = `${to}.part`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new Error(`${url.pathname.split("/").pop() ?? "the file"} could not be fetched (${response.status})`);
  }

  const digest = createHash("md5");
  let bytes = 0;
  try {
    await pipeline(
      async function* () {
        for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
          bytes += chunk.length;
          if (bytes > MAX_VOICE_BYTES) throw new Error("the download is larger than a voice should be");
          digest.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
    if (expected.bytes > 0 && bytes !== expected.bytes) {
      throw new Error(`${bytes} bytes arrived where ${expected.bytes} were promised`);
    }
    if (expected.md5 !== undefined && digest.digest("hex") !== expected.md5) {
      throw new Error("what arrived is not what was published");
    }
    await rename(partial, to);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return bytes;
}

/** Whether this Piper voice is already on the machine, both of its files. */
export async function voiceInstalled(config: Config, id: string): Promise<boolean> {
  if (!SAFE_ID.test(id)) return false;
  try {
    for (const suffix of MODEL_SUFFIXES) await stat(join(config.piperModels, `${id}${suffix}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * The voices somebody asking for this one could mean, best first.
 *
 * "Cori" is not an id, and the id is what a service needs; between them sits
 * this. An exact id or name wins, then a whole word inside the id --
 * `en_GB-cori-high` is Cori -- then anything containing what was asked for.
 * Equal matches are ordered by quality, so the highest-quality Cori on the
 * machine is the one that reads, and the rest are reported as alternatives
 * rather than silently dropped.
 */
export function matchVoices<T extends VoiceOption>(options: readonly T[], wanted: string): T[] {
  const needle = wanted.trim().toLowerCase();
  if (needle === "") return [];

  const ranked: Array<{ option: T; rank: number }> = [];
  for (const option of options) {
    const rank = rankOf(option, needle);
    if (rank !== null) ranked.push({ option, rank });
  }
  return ranked
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        qualityOf(right.option) - qualityOf(left.option) ||
        left.option.id.localeCompare(right.option.id),
    )
    .map((entry) => entry.option);
}

function rankOf(option: VoiceOption, needle: string): number | null {
  const id = option.id.toLowerCase();
  const name = option.name.toLowerCase();
  if (id === needle || name === needle) return 0;
  if (words(id).includes(needle) || words(name).includes(needle)) return 1;
  if (id.includes(needle) || name.includes(needle)) return 2;
  return null;
}

function words(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter((word) => word !== "");
}

function qualityOf(option: VoiceOption): number {
  const found = VOICE_QUALITIES.findIndex((quality) => option.id.toLowerCase().endsWith(quality));
  return found === -1 ? 0 : found;
}

function withSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
