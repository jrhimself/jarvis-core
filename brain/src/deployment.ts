/**
 * What this deployment actually is, measured rather than assumed.
 *
 * The assistant used to have no way to answer a question about itself. The
 * prompt was a character, a memory and whatever the packs added; nothing in it
 * said which packs those were, what was switched off, or that the machine had
 * no house at all. Asked how to connect Home Assistant, a brain with no house
 * pack and no credentials answered that it was already connected -- not out of
 * malice but because the persona describes a house assistant and nothing
 * contradicted it. The screen said "not configured" at the same moment.
 *
 * Everything here is read from real state: the environment, the packs on disk,
 * the manifest, the version in the manifest of the running build. Nothing is
 * inferred from what the assistant is supposed to be. Where a fact cannot be
 * had, the field says so rather than guessing -- a remedy nobody verified is
 * worse than no remedy, because it will be repeated with confidence.
 *
 * The rule this exists to enforce: if a capability is not in this record, this
 * deployment does not have it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "./config.js";
import { homeConfigured } from "./home/index.js";
import type { PackReport } from "./packs/loader.js";
import { brainVersion } from "./version.js";
import { voiceConfigured, voiceKeyVariable, voiceProviderName } from "./voice/index.js";

/** Where a deployment names the packs it means to run. */
const MANIFEST = join("config", "packs.json");

/**
 * One thing this deployment either can or cannot do, and why.
 *
 * `remedy` is deliberately optional. Core knows how to switch on the things
 * core owns, because it is core that reads those variables; it does not know
 * how to switch on a capability that would arrive as a pack it has never seen,
 * and saying so is the honest answer.
 */
export interface Facility {
  /** What it is, in the words somebody would ask after it by. */
  name: string;
  on: boolean;
  /** What was measured. Never an inference, never a promise. */
  detail: string;
  /** What would change the answer, when that is known here. */
  remedy?: string;
}

/** A pack the manifest names, and whether it made it onto the disk. */
export interface ManifestEntry {
  id: string;
  /** False when nothing was cloned to `packs/<id>` yet. */
  installed: boolean;
}

/** Everything the assistant may say about its own setup. */
export interface Deployment {
  /** Version of the running build, or "unknown" from a build without a manifest. */
  version: string;
  /** Whether the deployment wrote a persona, or the built-in default is in use. */
  ownPersona: boolean;
  /** Model every turn opens on, and the one a hard turn is raised to. */
  model: string;
  escalateModel: string;
  /** One entry per directory under `packs/`, whatever became of each. */
  packs: readonly PackReport[];
  /**
   * What `config/packs.json` names, or null when there is no such file.
   *
   * Null and empty are different answers and are kept apart: a deployment with
   * no manifest was never told which packs to run, and one with an empty
   * manifest was told to run none.
   */
  manifest: readonly ManifestEntry[] | null;
  /** Tool servers registered this session, core's own included. */
  servers: readonly string[];
  /** The rest of what is on or off here. */
  facilities: readonly Facility[];
}

/** Reads the deployment's pack manifest. Null when it does not have one. */
function readManifest(root: string, installed: ReadonlySet<string>): ManifestEntry[] | null {
  let raw: string;
  try {
    raw = readFileSync(join(root, MANIFEST), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    const packs = (parsed as { packs?: unknown }).packs;
    if (!Array.isArray(packs)) return null;
    // Ids only. The manifest also carries the repository each pack came from,
    // and a private clone URL is not something to put in a prompt.
    return packs
      .map((entry) => String((entry as { id?: unknown }).id ?? ""))
      .filter((id) => id !== "")
      .map((id) => ({ id, installed: installed.has(id) }));
  } catch {
    // A manifest that will not parse is not the same as one that is absent, and
    // it is worth a line: `packs-sync` refuses outright on this file.
    console.warn(`deployment: ${MANIFEST} is not valid JSON`);
    return null;
  }
}

function repoRoot(): string {
  // brain/dist/deployment.js -> two directories up.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * The house, which is core's own credential rather than a pack's.
 *
 * Worth its own line because it is the thing people ask about first and the one
 * most easily half-configured. Two truths sit behind the one question and they
 * are reported as two: core holds the connection the observation layer uses,
 * and the tools to read or change anything come from a pack. Which pack that is
 * is not stated here -- core does not know what any pack talks to, and guessing
 * is the failure this whole file exists to stop.
 */
function houseFacility(config: Config): Facility {
  const missing = [
    ...(config.haUrl === "" ? ["HA_URL"] : []),
    ...(config.haToken === "" ? ["HA_TOKEN"] : []),
  ];

  if (homeConfigured(config)) {
    return {
      name: "house connection",
      on: true,
      detail:
        "HA_URL and HA_TOKEN are set, so core itself can reach the house; whether you have tools " +
        "to read or change anything in it depends entirely on the packs listed above",
    };
  }

  return {
    name: "house connection",
    on: false,
    detail: `core has no house: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} empty`,
    remedy:
      "set HA_URL and HA_TOKEN in the env file the service reads and restart it; that gives core " +
      "the connection, while the tools to use it arrive separately as a pack",
  };
}

/** Whether an environment variable has a value on this machine. */
function isSet(name: string): boolean {
  const value = process.env[name];
  return value !== undefined && value !== "";
}

/**
 * What this deployment is, right now.
 *
 * Built once per agent session, from the packs that session loaded: a record
 * assembled from anything else would describe a different process.
 */
export function describeDeployment(
  config: Config,
  packs: readonly PackReport[],
  servers: readonly string[],
  ownPersona: boolean,
  root = repoRoot(),
): Deployment {
  // A directory that turned out not to be a pack does not count as installed,
  // however much it looks the part from the manifest's side. That is the whole
  // confusion: build output left behind by a pack that was removed occupies the
  // name and answers nothing.
  const installed = new Set(
    packs.filter((pack) => pack.state !== "unrecognised").map((pack) => pack.name),
  );

  const facilities: Facility[] = [
    houseFacility(config),
    {
      name: "voice",
      on: voiceConfigured(config),
      detail: voiceConfigured(config)
        ? `answers are spoken by ${voiceProviderName(config)}${config.voiceProvider === "fish" ? ` (${config.fishModel})` : ""}`
        : `no speech synthesis: ${voiceKeyVariable(config)} is empty, so answers are shown but not spoken`,
      ...(voiceConfigured(config)
        ? {}
        : {
            remedy: `set ${voiceKeyVariable(config)} in the env file and restart; JARVIS_VOICE_PROVIDER chooses between elevenlabs and fish`,
          }),
    },
    {
      name: "written notices",
      on: config.notifyEntity !== "" || config.notifyWebhook !== "",
      detail: writtenDetail(config),
      ...(config.notifyEntity === "" && config.notifyWebhook === ""
        ? {
            remedy:
              "set JARVIS_NOTIFY_ENTITY, which needs a house, or JARVIS_NOTIFY_WEBHOOK, which does not",
          }
        : {}),
    },
    {
      name: "watching on my own",
      on: config.proactive !== "off",
      detail:
        config.proactive === "off"
          ? "nothing is observed, no baselines are built and nothing is ever raised unasked"
          : `JARVIS_PROACTIVE is "${config.proactive}"`,
      ...(config.proactive === "off"
        ? { remedy: "set JARVIS_PROACTIVE to observe, suggest or announce" }
        : {}),
    },
    {
      name: "changing my own code",
      on: config.devRepo !== "",
      detail:
        config.devGitHubToken === ""
          ? "code can be written and a branch pushed, but no pull request can be opened: GITHUB_TOKEN_JARVIS is empty"
          : "code can be written and a pull request opened",
    },
  ];

  return {
    version: brainVersion(),
    ownPersona,
    model: config.model,
    escalateModel: config.escalateModel,
    packs,
    manifest: readManifest(root, installed),
    servers,
    facilities,
  };
}

function writtenDetail(config: Config): string {
  const routes = [
    ...(config.notifyEntity === "" ? [] : ["through the house"]),
    ...(config.notifyWebhook === "" ? [] : ["to a webhook"]),
  ];
  return routes.length === 0
    ? "spoken only: a notice reaches whoever is in the room and nobody else"
    : `a notice can also be written ${routes.join(" and ")}`;
}

/** One pack, as a line somebody can act on. */
function packLine(pack: PackReport): string {
  const what = pack.summary === undefined ? "" : ` (${pack.summary})`;

  if (pack.state === "started") {
    const trouble =
      pack.problems === undefined ? "" : ` -- but ${pack.problems.join("; ")}`;
    return `- ${pack.name}${what}: running${trouble}`;
  }

  if (pack.state === "unrecognised") {
    return (
      `- ${pack.name}: a directory under packs/ with no pack.json, so it is not a pack and ` +
      "contributes nothing. Most often what a removed pack left behind."
    );
  }

  if (pack.state === "broken") {
    return `- ${pack.name}${what}: installed but failed to start -- ${pack.reason ?? "no reason given"}`;
  }

  // Off. The only case where a remedy can be spelled out, and only when the
  // pack said what it wanted; core does not know another pack's variables.
  if (pack.needs === undefined || pack.needs.length === 0) {
    return (
      `- ${pack.name}${what}: installed, and reports it is not configured. It does not declare ` +
      "what it needs, so read its own README rather than guessing."
    );
  }

  const empty = pack.needs.filter((need) => !isSet(need.env));
  if (empty.length === 0) {
    return (
      `- ${pack.name}${what}: installed, and reports it is not configured even though ` +
      `${pack.needs.map((need) => need.env).join(", ")} all have values. Something it needs is not an ` +
      "environment variable; its README will say what."
    );
  }

  const wants = empty.map((need) => `${need.env} (${need.why})`).join(", ");
  return `- ${pack.name}${what}: installed but off, because ${wants} ${empty.length === 1 ? "is" : "are"} empty here.`;
}

/**
 * What to do about a capability that is missing, for a deployment that can build.
 *
 * The rest of the block is written to stop the model claiming what is not
 * there, and on its own it taught the opposite lesson too well: a request for
 * the time was answered with "I cannot check the clock", and that was the end
 * of it. Admitting the gap is right; stopping there is not, when the same
 * process can hand the gap to something that can close it. So the order is
 * spelled out -- try what you have, close what is missing, ask only what is
 * the owner's to decide -- with the brakes named, because an assistant told to
 * never give up needs to be told just as plainly when to stop.
 */
const RESOURCEFUL = [
  "### When you cannot do something, or do not know it",
  "",
  "Not being able to do something yet is a problem to solve, not an answer to give. An answer",
  "that says you cannot, or that gives only the part you could, is only complete when the same",
  "turn also called close_gap for the rest. Asked for the time with no clock to read, for",
  "example: say what you do know, and build the gap 'read the clock' in that same turn. Work",
  "through it in this order.",
  "",
  "First, look for a way with what you have: another tool, the same tool asked differently,",
  "something you remember. A tool that failed once can often be asked another way.",
  "",
  "When nothing here gets there, close the gap with close_gap, without asking first: 'build'",
  "whenever the same kind of request can come again -- the time, a device, a service, an",
  "automation -- so that next time it simply works; 'find_out' only for a one-off fact that a",
  "machine with a shell and the internet could look up and that will not be asked again. A",
  "request you cannot carry out is a gap too, even when it",
  "is phrased as a new feature or an automation: it was already asked for, so do not ask",
  "again whether to build it. Say in one sentence what you cannot do yet and what you",
  "started, and carry on with whatever else was asked. Runners report back to you; you",
  "answer their questions when you can, and the user hears when a job is done. Nothing is",
  "merged or deployed without his yes.",
  "",
  "Ask the user only what is his to decide: taste, money, access, anything that deletes",
  "something or cannot be undone, or what you are not sure he wants. Do not ask permission",
  "to find something out or to fix what is plainly missing.",
  "",
  "close_gap has brakes: one attempt per gap at a time, two a week, a few a day. When it",
  "refuses, say why and stop; never try the same thing again in other words.",
];

/**
 * The record as a block of system prompt.
 *
 * Written as facts and one rule, not as a character note: the persona says who
 * the assistant is and this says what it is made of, and mixing the two is how
 * a deployment ends up with an assistant that improvises its own setup.
 */
export function deploymentBlock(deployment: Deployment): string {
  // Whether JARVIS can do something about a missing capability, or only admit it.
  // The server's name rather than an import: this module is read by the tests
  // and the setup tools, and the tool module drags the whole SDK in behind it.
  const selfdev = deployment.servers.includes("selfdev");
  const lines: string[] = [
    "## How you are built",
    "",
    "This section is measured from the running process, not written by hand. It is the only",
    "truth about what this deployment can do. If a capability is not listed here, you do not",
    selfdev
      ? "have it yet -- the last section says what to do about that -- and never assume that"
      : "have it -- say so plainly and say what would give it to you, rather than assuming that",
    "anything described in your character is present. Never state that something is connected,",
    "installed or working unless it says so below or you have just checked it with a tool.",
    "",
    `You are core version ${deployment.version}, on model ${deployment.model}` +
      (deployment.escalateModel === ""
        ? ""
        : `, raised to ${deployment.escalateModel} for a turn that runs into trouble`) +
      ".",
  ];

  if (!deployment.ownPersona) {
    lines.push(
      "",
      "Nobody has given this deployment a persona: you are running on the built-in default, which",
      "is why you know nothing about this household. It goes in config/persona.md, and there is one",
      "to copy in examples/persona.md.",
    );
  }

  lines.push("", "### Packs, which are where every capability beyond talking comes from", "");

  if (deployment.packs.length === 0) {
    lines.push(
      "Nothing is installed under packs/. Core on its own can talk, remember, and put something",
      "on screen. It cannot reach a house, a mailbox, a calendar, a music system or anything else:",
      "all of that arrives as a pack, and this machine has none.",
    );
  } else {
    lines.push(...deployment.packs.map(packLine));
  }

  if (deployment.manifest === null) {
    lines.push(
      "",
      "There is no config/packs.json, so this deployment has never been told which packs to run.",
    );
  } else {
    const absent = deployment.manifest.filter((entry) => !entry.installed);
    lines.push(
      "",
      deployment.manifest.length === 0
        ? "config/packs.json exists and names no packs."
        : `config/packs.json names ${deployment.manifest.map((entry) => entry.id).join(", ")}.`,
    );
    if (absent.length > 0) {
      lines.push(
        `Named but not on disk: ${absent.map((entry) => entry.id).join(", ")} -- "npm run packs-sync" is what fetches them.`,
      );
    }
  }

  lines.push(
    "",
    "Installing a pack is four steps and a person has to do all four: name it in config/packs.json",
    'with its repository, run "npm run packs-sync", set whatever it needs in the env file the',
    "service reads, and restart the service -- packs are only read at startup. You cannot do any of",
    "this yourself from a conversation. Do not name a specific pack or repository unless it appears",
    ...(selfdev
      ? ["above. A capability nothing here provides is a gap to close -- see the last section."]
      : [
          "above; if someone wants a capability nothing here provides, say that it would take a pack and",
          "that you do not know of one.",
        ]),
    "",
    "### The rest of the setup",
    "",
    ...deployment.facilities.map(
      (facility) =>
        `- ${facility.name}: ${facility.detail}.` +
        (facility.remedy === undefined ? "" : ` To change that: ${facility.remedy}.`),
    ),
    "",
    `Tool servers running this session: ${deployment.servers.join(", ")}.`,
  );

  if (selfdev) lines.push("", ...RESOURCEFUL);

  return lines.join("\n");
}
