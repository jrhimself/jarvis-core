/**
 * Runtime configuration, read from the environment.
 *
 * Everything has a default that works for local development, so the service can
 * be started without an env file while it is still being built out.
 */

import type { SpeechLang } from "@jarvis/shared";

import { resolve } from "node:path";

import { VOICE_PROVIDERS, type VoiceProvider } from "./voice/types.js";

/** What the HUD's memory panel may do: nothing, look, or look and change. */
export type MemoryPanelMode = "off" | "read" | "edit";

const MEMORY_PANEL_MODES: readonly MemoryPanelMode[] = ["off", "read", "edit"];

/** The languages a deployment can be run in. */
const SPEECH_LANGS: readonly SpeechLang[] = ["nl", "en"];

/**
 * How far JARVIS is allowed to go on his own.
 *
 * A ladder, not a set: each rung includes the one before it. `off` is the
 * default and means the proactive side does not exist -- nothing watches,
 * nothing is written, no model is called, and the service behaves exactly as it
 * did before any of this was built. `observe` watches and records but never
 * speaks. `suggest` will offer something when asked or when the HUD is opened.
 * `announce` may interrupt.
 *
 * The rungs exist so the thing can be left running for the two weeks a
 * behavioural baseline needs before it has earned the right to say anything.
 */
export type ProactiveMode = "off" | "observe" | "suggest" | "announce";

const PROACTIVE_MODES: readonly ProactiveMode[] = ["off", "observe", "suggest", "announce"];

/** True when the configured mode is at least this rung of the ladder. */
export function proactiveAtLeast(mode: ProactiveMode, level: ProactiveMode): boolean {
  return PROACTIVE_MODES.indexOf(mode) >= PROACTIVE_MODES.indexOf(level);
}

export interface Config {
  /** Port the HTTPS server listens on. */
  port: number;
  /** Directory holding the TLS certificate and key. */
  certDir: string;
  /** Certificate file name inside certDir. */
  certFile: string;
  /** Private key file name inside certDir. */
  keyFile: string;
  /** Directory served as static content — the HUD. */
  hudDir: string;
  /**
   * Base URL of Home Assistant, empty when not configured yet.
   *
   * Still here although the tools that use it left for a pack of their own: the
   * observation layer is core, and it watches the house whether or not anyone
   * is talking. A pack reads the same two from the environment itself.
   */
  haUrl: string;
  /** Long-lived access token for Home Assistant, empty when not configured yet. */
  haToken: string;
  /**
   * What to call the person this assistant belongs to.
   *
   * Used where a prompt has to name somebody -- the nightly passes over the
   * notes and the conversations, which read better with a name than with a
   * pronoun. Empty falls back to "de gebruiker", which works and reads like a
   * manual. The persona is where the name really lives; this is for the prompts
   * the persona does not reach.
   */
  owner: string;
  /**
   * Where a written notice goes through the house: a notify entity.
   *
   * Empty leaves JARVIS with the spoken channel alone, which is a working
   * assistant that says a thing once rather than a broken one. A review link is
   * then never written down, so it is worth setting one of the two written
   * routes on any machine that runs unattended.
   */
  notifyEntity: string;
  /**
   * The service that entity is driven with.
   *
   * `notify.send_message` is the generic one every notify entity answers, and
   * the default for that reason. A deployment whose messaging wants extra
   * arguments -- a parse mode, a topic, a priority -- names its own service here
   * and puts the arguments in `notifyData`.
   */
  notifyService: string;
  /** Extra arguments for that service, as a JSON object. Empty is none. */
  notifyData: Record<string, unknown>;
  /**
   * A written channel that needs no house at all.
   *
   * The other route goes through the house, which is no use to a deployment
   * that has none. This one posts the notice to a URL, which is enough for a
   * bot API, a push service or anything that accepts a webhook. Empty leaves it
   * out of the list.
   */
  notifyWebhook: string;
  /** The body to post. `{{json}}` is the notice as a JSON string, `{{text}}` raw. */
  notifyWebhookBody: string;
  /** Content type for that body. */
  notifyWebhookContentType: string;
  /** Extra request headers, as a JSON object. Empty is none. */
  notifyWebhookHeaders: Record<string, string>;
  /**
   * A bot token, for the one channel that can be answered.
   *
   * The notify routes above are one-way. This one is a chat: findings go out
   * with buttons under them and the press comes back, which is the only way a
   * verdict on a finding ever gets recorded. Empty leaves the whole thing off,
   * detection included in nothing but the log.
   */
  suggestToken: string;
  /** Where suggestions are sent, and the only chat whose answers are taken. */
  suggestChat: string;
  /**
   * Shared secret a delegated runner reports with, empty leaves the door shut.
   *
   * The far side is a shell hook on another machine, so there is no session and
   * no user to authenticate -- one token, compared in constant time, is the
   * whole of it. Without it the report route does not exist at all.
   */
  runnerToken: string;
  /**
   * When the credentials this deployment lives on stop working, as
   * `name=YYYY-MM-DD` pairs separated by commas. Empty checks nothing.
   *
   * Some credentials carry no expiry anyone can read back -- a long-lived model
   * token is an opaque string -- so the date is whatever the person who minted
   * it wrote down. Held here as text; the self checks parse it, so a typo is a
   * finding rather than a startup failure.
   */
  credentialExpiry: string;
  /** How many may be sent in a rolling day, before anything is rendered. */
  suggestPerDay: number;
  /** Local hour the quiet window opens; equal to `quietTo` means never quiet. */
  quietFrom: number;
  /** And the local hour it closes again. */
  quietTo: number;
  /** SQLite file holding what JARVIS remembers. */
  memoryPath: string;
  /** Directory the nightly memory backups are written to. */
  backupDir: string;
  /** Directory holding the copy of the owner's own notes the nightly ingest reads. */
  corpusDir: string;
  /** How many backups to keep before the oldest is dropped. */
  backupKeep: number;
  /**
   * Which service speaks: ElevenLabs, or Fish Audio. Listening stays with
   * ElevenLabs either way -- Fish transcribes files, not a live microphone.
   */
  voiceProvider: VoiceProvider;
  /** ElevenLabs API key, empty when neither speaking nor transcribing is configured. */
  elevenLabsKey: string;
  /** Which ElevenLabs voice JARVIS speaks with. */
  voiceId: string;
  /** Voice for English turns; empty means the same voice as the Dutch one. */
  voiceIdEn: string;
  /** Fish Audio API key, empty when Fish is not to speak. */
  fishAudioKey: string;
  /** Fish model: `s2.1-pro-free` costs nothing, `s2.1-pro` is the same model with guarantees. */
  fishModel: string;
  /** Where Fish's live socket is; overridden only by a test or a proxy. */
  fishEndpoint: string;
  /** Which Fish voice reads Dutch; empty leaves Fish's own default. */
  fishVoiceId: string;
  /** Which Fish voice reads English; empty means the Dutch one reads both. */
  fishVoiceIdEn: string;
  /**
   * How Fish trades the first word against the prosody of the rest.
   *
   * `balanced` starts speaking about a second in; `normal` waits for the whole
   * sentence to be synthesised first -- three seconds on a long one -- and
   * gets the stress and the melody right more often, which on Dutch is the
   * difference that is heard.
   */
  fishLatency: "balanced" | "normal";
  /** Whether Fish expands numbers and dates before reading them. */
  fishNormalize: boolean;
  /**
   * What is said when the plan is spent and the model cannot answer.
   *
   * `{reset}` becomes the time the window opens again, as an hour or a weekday
   * and an hour; the sentence carrying it is dropped when that is not known.
   * Spoken, so it belongs to the deployment's language.
   */
  limitSentence: string;
  /** From which percentage of a window the model is told to economise. */
  planWarnPct: number;
  /** How evenly the voice reads: 0 performs, 1 keeps one register. */
  voiceStability: number;
  /** How closely the voice holds to its own timbre. */
  voiceSimilarity: number;
  /** Reading speed, 1 being the voice's own. */
  voiceSpeed: number;
  /**
   * How much the browser colours the voice, 0 to 100.
   *
   * The brain sends the same audio either way; this only says how the HUD plays
   * it, which is why it is served to the page rather than used here.
   */
  voiceTimbre: number;
  /** How much of the memory store the HUD is allowed to see and change. */
  memoryPanel: MemoryPanelMode;
  /** Model every turn opens on. */
  model: string;
  /**
   * Model a turn is raised to once it has run into an error or started
   * building. Empty leaves every turn on `model`, which is what a deployment
   * that has not thought about it should get.
   */
  escalateModel: string;
  /** Model to fall back on when the primary one is overloaded. Empty tries nothing else. */
  fallbackModel: string;
  /** How many steps one question may take before the turn is stopped. 0 does not stop it. */
  maxSteps: number;
  /** What one question may cost before the turn is stopped, in dollars. 0 does not stop it. */
  maxTurnUsd: number;
  /**
   * The language this deployment speaks and listens in.
   *
   * One setting for the whole house: which voice reads an answer, which
   * language the microphone is transcribed as, and what a fixed line is
   * spoken in when the caller names no language of its own. It does not
   * translate anything -- the persona decides what the assistant writes,
   * and this says how what it writes is heard, so the two belong together.
   */
  speechLang: SpeechLang;
  /**
   * What is said when a turn was stopped by one of those brakes.
   *
   * Spoken, so it belongs to the deployment's language rather than to the
   * program, and short on purpose: it is an admission, not an explanation.
   */
  stoppedSentence: string;
  /**
   * What is said to fill the silence while a slow turn is still fetching.
   *
   * Spoken, so these belong to the deployment's language rather than to the
   * program. One is picked at random: a turn that needs half a minute is rare
   * enough that a single fixed line would be a tic before it was a courtesy.
   * Empty turns the acknowledgement off.
   */
  thinkingLines: string[];
  /**
   * How long a turn may work in silence before one of those lines is spoken.
   *
   * The clock starts at the first tool call, not at the question: a turn that
   * reaches for nothing is a turn that is already answering. Zero turns the
   * acknowledgement off.
   */
  thinkingAfterMs: number;
  /** How long a conversation survives without a turn before the agent is dropped. */
  sessionIdleMs: number;
  /** Turns after which the conversation restarts, to bound how big its context gets. */
  sessionMaxTurns: number;
  /** How far JARVIS may go on his own. `off` is the default and changes nothing. */
  proactive: ProactiveMode;
  /** Directory holding runtime state: the database, the backups, the deploy handshake. */
  dataDir: string;
  /** Root of the git checkout the service runs from; where self-development happens. */
  devRepo: string;
  /** Directory the throwaway worktrees are made in. Must be writable by the unit. */
  devWorktrees: string;
  /** owner/name of the repository on GitHub. */
  devGitHubRepo: string;
  /** Fine-grained GitHub token with contents and pull-requests write on that repo.
   *  Empty leaves JARVIS able to write code and push a branch, but not to open a PR. */
  devGitHubToken: string;
}

/**
 * What to call the owner inside a prompt.
 *
 * Falls back to a word rather than to a placeholder: an unset name should
 * produce a prompt that reads like a manual, not one with a hole in it. The
 * persona is where a real name belongs; this covers the prompts the persona
 * does not reach -- the nightly passes, which are written in Dutch because
 * that is the language they read and write in.
 */
export function ownerName(config: Config): string {
  return config.owner === "" ? "de gebruiker" : config.owner;
}

/**
 * A JSON object from the environment, or the empty one.
 *
 * A malformed value costs the extra arguments and never the service: a typo in
 * an env file should not be the reason a notice does not go out.
 */
function envObject(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`${name} must be a JSON object — ignored`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    console.warn(`${name} is not valid JSON — ignored`);
    return {};
  }
}

function envString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

/**
 * A list written as one line, separated by `|`.
 *
 * A pipe rather than a comma because these are sentences, and a sentence with a
 * comma in it is the ordinary case rather than the exception.
 */
/** A yes or a no, in any of the usual spellings. */
function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  console.warn(`config: ${name}="${raw}" is not a yes or a no; using ${fallback}`);
  return fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const items = value
    .split("|")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return items;
}

function envPort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a port number between 1 and 65535, got: ${value}`);
  }
  return parsed;
}

/**
 * A fractional setting, for the knobs that are not whole numbers.
 *
 * Separate from `envNumber`, which insists on integers: a voice stability of
 * 0.9 is not a typo for 9, and rounding it would silently change the voice.
 */
function envDecimal(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(`${name} must be a number between ${min} and ${max}, got: ${value} -- falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

function envNumber(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(`${name} must be a whole number between ${min} and ${max}, got: ${value} — falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

/**
 * One of a fixed set of words, or the fallback.
 *
 * A misspelt mode falls back rather than throwing, deliberately: the failure
 * that matters here is a service that will not start because of a typo in an
 * env file, not one that runs with a setting somebody meant to change.
 */
/**
 * A dollar amount, which unlike every other number here is not a whole one.
 *
 * Nonsense is refused rather than rounded: a budget read as 0 would mean "no
 * limit" and a typo would silently remove the brake it was meant to set.
 */
function envMoney(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(`${name} must be a positive amount in dollars, got: ${value} — falling back to ${fallback}`);
    return fallback;
  }
  return parsed;
}

function envEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;

  if (!allowed.includes(value as T)) {
    console.warn(
      `${name} must be one of ${allowed.join(", ")}, got: ${value} — falling back to ${fallback}`,
    );
    return fallback;
  }
  return value as T;
}

export function loadConfig(): Config {
  const elevenLabsKey = envString("ELEVENLABS_API_KEY", "");
  const fishAudioKey = envString("FISH_AUDIO_API_KEY", "");
  return {
    port: envPort("JARVIS_PORT", 443),
    certDir: envString("JARVIS_CERT_DIR", "/etc/jarvis/certs"),
    certFile: envString("JARVIS_CERT_FILE", "jarvis.crt"),
    keyFile: envString("JARVIS_KEY_FILE", "jarvis.key"),
    hudDir: resolve(envString("JARVIS_HUD_DIR", "../hud/public")),
    haUrl: envString("HA_URL", ""),
    haToken: envString("HA_TOKEN", ""),
    owner: envString("JARVIS_OWNER", ""),
    notifyEntity: envString("JARVIS_NOTIFY_ENTITY", ""),
    notifyService: envString("JARVIS_NOTIFY_SERVICE", "notify.send_message"),
    notifyData: envObject("JARVIS_NOTIFY_DATA"),
    notifyWebhook: envString("JARVIS_NOTIFY_WEBHOOK", ""),
    notifyWebhookBody: envString("JARVIS_NOTIFY_WEBHOOK_BODY", '{"text":{{json}}}'),
    notifyWebhookContentType: envString("JARVIS_NOTIFY_WEBHOOK_CONTENT_TYPE", "application/json"),
    notifyWebhookHeaders: envObject("JARVIS_NOTIFY_WEBHOOK_HEADERS") as Record<string, string>,
    suggestToken: envString("JARVIS_TELEGRAM_TOKEN", ""),
    suggestChat: envString("JARVIS_TELEGRAM_CHAT", ""),
    runnerToken: envString("JARVIS_RUNNER_TOKEN", ""),
    credentialExpiry: envString("JARVIS_CREDENTIAL_EXPIRY", ""),
    suggestPerDay: envNumber("JARVIS_SUGGEST_PER_DAY", 6, 1, 50),
    quietFrom: envNumber("JARVIS_QUIET_FROM", 21, 0, 23),
    quietTo: envNumber("JARVIS_QUIET_TO", 7, 0, 23),
    memoryPath: resolve(envString("JARVIS_MEMORY_PATH", "../data/memory.db")),
    backupDir: resolve(envString("JARVIS_BACKUP_DIR", "../data/backups")),
    corpusDir: resolve(envString("JARVIS_CORPUS_DIR", "../data/corpus")),
    backupKeep: envNumber("JARVIS_BACKUP_KEEP", 14, 1, 365),
    // Unnamed, the provider is whichever key was given; both given, ElevenLabs
    // keeps speaking as it always has, and switching is a deliberate line.
    voiceProvider: envEnum(
      "JARVIS_VOICE_PROVIDER",
      VOICE_PROVIDERS,
      fishAudioKey !== "" && elevenLabsKey === "" ? "fish" : "elevenlabs",
    ),
    elevenLabsKey,
    // Jessica: bright and quick, chosen by ear from the stock voices. She
    // sounds like someone already standing by, which is the whole point.
    voiceId: envString("JARVIS_VOICE_ID", "cgSgspJ2msm6clMCkdW9"),
    // A voice picked for Dutch rarely reads English well, and the other way
    // around. Empty keeps one voice for both, as before.
    voiceIdEn: envString("JARVIS_VOICE_ID_EN", ""),
    fishAudioKey,
    fishModel: envString("JARVIS_FISH_MODEL", "s2.1-pro-free"),
    fishEndpoint: envString("JARVIS_FISH_ENDPOINT", "wss://api.fish.audio/v1/tts/live"),
    fishVoiceId: envString("JARVIS_FISH_VOICE_ID", ""),
    fishVoiceIdEn: envString("JARVIS_FISH_VOICE_ID_EN", ""),
    fishLatency: envEnum("JARVIS_FISH_LATENCY", ["balanced", "normal"] as const, "normal"),
    fishNormalize: envFlag("JARVIS_FISH_NORMALIZE", true),
    limitSentence: envString(
      "JARVIS_LIMIT_SENTENCE",
      "I have reached the limit of my plan and cannot look anything up right now. It opens again at {reset}.",
    ),
    planWarnPct: envNumber("JARVIS_PLAN_WARN_PCT", 75, 0, 100),
    // An assistant reading out the temperature is not performing, so the
    // defaults lean towards an even register rather than an expressive one: a
    // voice that acts is a voice that surprises you halfway through a sentence.
    voiceStability: envDecimal("JARVIS_VOICE_STABILITY", 0.4, 0, 1),
    voiceSimilarity: envDecimal("JARVIS_VOICE_SIMILARITY", 0.75, 0, 1),
    voiceSpeed: envDecimal("JARVIS_VOICE_SPEED", 1.0, 0.7, 1.2),
    voiceTimbre: envNumber("JARVIS_VOICE_TIMBRE", 0, 0, 100),
    memoryPanel: envEnum("JARVIS_MEMORY_PANEL", MEMORY_PANEL_MODES, "read"),
    speechLang: envEnum("JARVIS_SPEECH_LANG", SPEECH_LANGS, "nl"),
    model: envString("JARVIS_MODEL", "sonnet"),
    escalateModel: envString("JARVIS_ESCALATE_MODEL", ""),
    fallbackModel: envString("JARVIS_FALLBACK_MODEL", ""),
    // Sixteen is roughly twice the longest turn seen in ordinary use, which is
    // the shape a brake should have: invisible until something is wrong.
    maxSteps: envNumber("JARVIS_MAX_STEPS", 16, 0, 200),
    maxTurnUsd: envMoney("JARVIS_MAX_TURN_USD", 0),
    stoppedSentence: envString(
      "JARVIS_STOPPED_SENTENCE",
      "I did not get to the bottom of that in one go. Say the word and I will have it looked into.",
    ),
    thinkingLines: envList("JARVIS_THINKING_LINES", ["One moment.", "Let me look.", "Bear with me."]),
    // Long enough that an ordinary question -- one tool, an answer three
    // seconds later -- never hears it, short enough to land before the silence
    // is what he notices.
    thinkingAfterMs: envNumber("JARVIS_THINKING_AFTER_MS", 2000, 0, 30_000),
    sessionIdleMs: envNumber("JARVIS_SESSION_IDLE_MIN", 20, 1, 240) * 60_000,
    sessionMaxTurns: envNumber("JARVIS_SESSION_MAX_TURNS", 30, 2, 500),
    proactive: envEnum("JARVIS_PROACTIVE", PROACTIVE_MODES, "off"),
    dataDir: resolve(envString("JARVIS_DATA_DIR", "../data")),
    devRepo: resolve(envString("JARVIS_DEV_REPO", "..")),
    devWorktrees: resolve(envString("JARVIS_DEV_WORKTREES", "../../jarvis-dev")),
    devGitHubRepo: envString("JARVIS_GITHUB_REPO", ""),
    devGitHubToken: envString("GITHUB_TOKEN_JARVIS", ""),
  };
}
