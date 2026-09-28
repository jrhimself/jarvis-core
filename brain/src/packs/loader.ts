/**
 * Finding, checking and starting the packs.
 *
 * A pack is a directory under `packs/`, and every one of them is a checkout of
 * a repository of its own -- this one ships none. What core knows about a pack
 * is what is on disk, which is why this scans rather than reading a list:
 * `config/packs.json` says what a deployment means to have, and a list that can
 * disagree with the disk is a list that will.
 *
 * Three things are held to here, and they are all about one broken pack not
 * being able to take the assistant down with it. A pack that throws while being
 * loaded or created is dropped with a line in the log, and the rest start. A
 * pack that says it is not configured is skipped in silence, because that is
 * the ordinary state of most packs on most machines. And a tool call that never
 * comes back is answered on the pack's behalf, so a hung pack costs one turn
 * rather than the conversation.
 *
 * What is deliberately not here: installing anything. A pack's dependencies are
 * the repository's dependencies, declared in its own `package.json` and
 * installed by npm like everything else. Resolving a tree at runtime, from a
 * process that can speak out loud and change its own code, is not a door worth
 * opening for the convenience of not running `npm install`.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  Delegate,
  JarvisPack,
  PackContext,
  PackRequirement,
  PackSetup,
  PackWatch,
  PackDeskSlot,
} from "@jarvis/shared";
import { NO_DELEGATE } from "@jarvis/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { noteServer, serverIsDown } from "../health.js";

/**
 * How long a single tool call may take before it is answered for.
 *
 * Generous: the mail pack talks to Google, the house to a container over the
 * network, and a slow answer is still an answer. This is not a latency budget,
 * it is the line past which something is wrong and the user is owed a sentence
 * rather than silence.
 */
const TOOL_TIMEOUT_MS = 60_000;

/**
 * Where the packs are, worked out from where this file ended up.
 *
 * `brain/dist/packs/loader.js` is three directories below the repository root,
 * and the packs sit next to `brain`. Derived rather than configured, because a
 * deployment that can point this somewhere else is a deployment where a
 * misconfigured path silently means "no tools" -- which is exactly the failure
 * this loader is otherwise careful to report.
 */
export const packsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packs");

/** What a pack's manifest has to say. Anything else in the file is ignored. */
interface Manifest {
  /** Must match the directory name; a mismatch is a mistake worth reporting. */
  name: string;
  /** Entry point relative to the pack directory, e.g. `dist/index.js`. */
  entry: string;
  /** One line, for the log and for `jarvis packs`. */
  description?: string;
}

/** A pack that loaded, with where it came from. */
export interface LoadedPack {
  pack: JarvisPack;
  /** Absolute path to the directory it was read from. */
  directory: string;
}

/**
 * What one directory under `packs/` turned out to be.
 *
 * `unrecognised` is the one that was previously invisible: a directory with no
 * manifest is skipped without a word, which is right for the log and wrong for
 * anyone asking why a capability is missing. A build directory left behind by a
 * pack that was removed looks exactly like an installed pack from the outside,
 * and the assistant has to be able to say that it is not one.
 */
export type PackState = "started" | "off" | "broken" | "unrecognised";

/** One directory under `packs/`, and what came of it. */
export interface PackReport {
  /** The directory name, which is also the pack's name when it is one. */
  name: string;
  state: PackState;
  /** Why it is not running. Absent only for a pack that started. */
  reason?: string;
  /**
   * Complaints about a pack that started regardless.
   *
   * A second server under a name already taken is refused while the rest of the
   * pack runs, so the pack is neither wholly started nor skipped. Reporting
   * that as either would hide it.
   */
  problems?: string[];
  /** The pack's own line about itself, when it offered one. */
  summary?: string;
  /** What it says it needs. Absent means it did not say, not that it needs nothing. */
  needs?: readonly PackRequirement[];
}

/** What one session got: the servers to register, the tools, the prompt. */
export interface Packs {
  /** MCP servers by pack name, ready to hand to the agent. */
  servers: Record<string, unknown>;
  /** Tool-name patterns to pre-approve, from the packs that were started. */
  tools: string[];
  /** The persona paragraphs of the packs that were started, in load order. */
  persona: string[];
  /** The blocks those packs compute for the prompt, still to be resolved. */
  blocks: Array<() => Promise<string>>;
  /** Somewhere to hand big work, from the first pack that offered one. */
  delegate: Delegate;
  /** How to check each pack server's dependency, by server name. */
  probes: Record<string, () => Promise<string>>;
  /** Readings to take on a clock, from the packs that offered any. */
  watch: PackWatch[];
  /** Standing HUD desk windows declared by the packs that started. */
  desk: PackDeskSlot[];
  /**
   * One entry per directory under `packs/`, whatever became of it.
   *
   * The single answer to "what is installed here and what is running", which
   * used to be two half-answers: a log line for the ones that started and a
   * list of the ones that did not. Reported, never thrown.
   */
  reports: PackReport[];
}

/** The ones that are not running, which is what most callers of `reports` want. */
export function notRunning(reports: readonly PackReport[]): PackReport[] {
  return reports.filter((report) => report.state !== "started");
}

function say(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads one pack directory. Returns null when it is not a pack at all.
 *
 * A directory with no manifest is not an error: a half-finished clone, a
 * `node_modules` somebody's `npm install` left behind, or a pack being worked
 * on all land here, and complaining about them would train the reader to ignore
 * the log.
 */
async function read(directory: string, name: string): Promise<JarvisPack | null> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, "pack.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }

  if (manifest.name !== name) {
    throw new Error(`manifest says "${manifest.name}" but the directory is "${name}"`);
  }
  if (typeof manifest.entry !== "string" || manifest.entry === "") {
    throw new Error("manifest has no entry point");
  }

  const module = (await import(pathToFileURL(join(directory, manifest.entry)).href)) as {
    default?: unknown;
  };
  const pack = module.default;

  if (typeof pack !== "object" || pack === null) throw new Error("no default export");
  const candidate = pack as Partial<JarvisPack>;
  if (candidate.name !== name) throw new Error("the default export is not this pack");
  if (typeof candidate.configured !== "function") throw new Error("no configured()");
  if (typeof candidate.create !== "function") throw new Error("no create()");

  return candidate as JarvisPack;
}

/** Every directory in a directory, or nothing when there is no such directory. */
async function directories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Every pack under `root`.
 *
 * An empty result is the expected one in a worktree and on a fresh checkout,
 * and it is not reported: nothing is installed until somebody installs it.
 *
 * `unrecognised` names the directories that hold no manifest. They stay out of
 * the log for the reason in `read` -- there are innocent ways to end up with
 * one -- but they are counted, because a directory that looks like a pack and
 * is not is precisely what makes a missing capability confusing.
 */
export async function discover(root: string): Promise<{
  packs: LoadedPack[];
  broken: Array<{ name: string; reason: string }>;
  unrecognised: string[];
}> {
  const found: LoadedPack[] = [];
  const broken: Array<{ name: string; reason: string }> = [];
  const unrecognised: string[] = [];

  for (const name of await directories(root)) {
    const directory = join(root, name);
    try {
      const pack = await read(directory, name);
      if (pack === null) {
        unrecognised.push(name);
        continue;
      }
      found.push({ pack, directory });
    } catch (error) {
      broken.push({ name, reason: say(error) });
    }
  }

  return { packs: found, broken, unrecognised };
}

/**
 * Answers a tool call the pack never answered, or was never going to.
 *
 * Done at the transport rather than around each handler, because the handlers
 * belong to the pack and a pack cannot be relied on to wrap its own. Every
 * incoming `tools/call` starts a timer; the first response for that id, real or
 * ours, wins and the other is dropped. What the model sees is a tool that
 * failed with a reason, which it can say out loud, instead of a turn that never
 * ends.
 *
 * A call to a server the probes just found dead is refused here without being
 * forwarded at all. Waiting for a dependency to time out again proves nothing
 * that was not measured a minute ago, and it was being paid for once per tool
 * per turn -- three dead servers cost the morning greeting twenty seconds before
 * it reached the weather. The refusal asks for silence rather than a sentence:
 * a machine this deployment cannot reach is not news, and saying so every
 * morning is how a briefing turns into a list of other people's outages.
 */
function refusal(id: string | number, name: string): unknown {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        {
          type: "text",
          text:
            `${name} is unreachable from this deployment right now, so this tool has nothing ` +
            "to give. Carry on with the rest of the answer and leave this part out entirely: " +
            "do not mention it, do not apologise for it, and do not call this server again " +
            "this turn.",
        },
      ],
      isError: true,
    },
  };
}

export function withToolTimeout(instance: McpServer, name: string, ms = TOOL_TIMEOUT_MS): void {
  const connect = instance.connect.bind(instance);

  instance.connect = async (transport: Parameters<typeof connect>[0]) => {
    const pending = new Map<string | number, NodeJS.Timeout>();
    const answered = new Set<string | number>();
    const send = transport.send.bind(transport);

    const settle = (id: string | number): boolean => {
      const timer = pending.get(id);
      if (timer !== undefined) clearTimeout(timer);
      pending.delete(id);
      if (answered.has(id)) return false;
      answered.add(id);
      return true;
    };

    transport.send = async (message, options) => {
      const id = (message as { id?: string | number }).id;
      // Only a response carries an id we are waiting on; a request from the
      // server side has one too, so the timer map is what distinguishes them.
      if (id !== undefined && pending.has(id)) {
        // It answered, so it is up -- which the probes may not know yet.
        noteServer(name, "ok");
        if (!settle(id)) return;
      }
      await send(message, options);
    };

    await connect(transport);

    const deliver = transport.onmessage?.bind(transport);
    transport.onmessage = (message, extra) => {
      const value = message as { id?: string | number; method?: string };
      if (value.method === "tools/call" && value.id !== undefined) {
        const id = value.id;
        if (serverIsDown(name)) {
          if (settle(id)) void send(refusal(id, name) as Parameters<typeof send>[0]);
          return;
        }
        const timer = setTimeout(() => {
          if (!settle(id)) return;
          noteServer(name, "down");
          // The same refusal a server already known to be down gets. A call that
          // ran out of time is the first turn's evidence for exactly that, and it
          // should buy the same silence rather than a line in the briefing.
          void send(refusal(id, name) as Parameters<typeof send>[0]);
        }, ms);
        timer.unref();
        pending.set(id, timer);
      }
      deliver?.(message, extra);
    };
  };
}

/**
 * Starts every pack this deployment is configured for.
 *
 * Nothing here throws. A pack that cannot be read, cannot be created, or is
 * simply not configured ends up in `reports` with a reason, and the assistant
 * starts with the tools it does have -- which is the whole point of the
 * arrangement, and the state every fresh install is in.
 */
export async function loadPacks(root: string, context: PackContext): Promise<Packs> {
  const { packs, broken, unrecognised } = await discover(root);

  const servers: Record<string, unknown> = {};
  const tools: string[] = [];
  const persona: string[] = [];
  const blocks: Array<() => Promise<string>> = [];
  const reports: PackReport[] = [
    ...broken.map(({ name, reason }): PackReport => ({ name, state: "broken", reason })),
    ...unrecognised.map((name): PackReport => ({ name, state: "unrecognised", reason: "no pack.json" })),
  ];
  let delegate = NO_DELEGATE;
  const probes: Record<string, () => Promise<string>> = {};
  const watch: PackWatch[] = [];
  const desk: PackDeskSlot[] = [];

  for (const { pack } of packs) {
    // Carried on every report, running or not: what a pack is for and what it
    // wants are exactly the questions asked about the ones that did not start.
    const declared = {
      ...(pack.summary === undefined ? {} : { summary: pack.summary }),
      ...(pack.needs === undefined ? {} : { needs: pack.needs }),
    };

    let wanted: boolean;
    try {
      wanted = pack.configured(context);
    } catch (error) {
      reports.push({
        name: pack.name,
        state: "broken",
        reason: `configured() threw: ${say(error)}`,
        ...declared,
      });
      continue;
    }
    if (!wanted) {
      reports.push({ name: pack.name, state: "off", reason: "not configured", ...declared });
      continue;
    }

    let setup: PackSetup;
    try {
      setup = pack.create(context);
    } catch (error) {
      reports.push({
        name: pack.name,
        state: "broken",
        reason: `create() threw: ${say(error)}`,
        ...declared,
      });
      continue;
    }

    const problems: string[] = [];

    for (const [name, server] of Object.entries(setup.servers)) {
      // A collision would silently replace one pack's tools with another's, so
      // it is reported and the first one keeps the name. Two packs claiming the
      // same server name is a mistake in one of them, not a preference.
      if (name in servers) {
        problems.push(`server "${name}" is already registered`);
        continue;
      }
      const instance = (server as { instance?: McpServer }).instance;
      if (instance !== undefined) withToolTimeout(instance, name);
      servers[name] = server;
    }

    for (const [name, probe] of Object.entries(setup.probes ?? {})) {
      if (name in servers) probes[name] = probe;
    }

    // A watcher for a server that did not register is a watcher for a
    // capability this deployment does not have, and taking its reading anyway
    // would put figures on the panel that nothing can be asked about.
    for (const watcher of setup.watch ?? []) {
      if (watcher.server in servers) watch.push(watcher);
    }

    for (const slot of setup.desk ?? []) {
      if (typeof slot.topic === "string" && slot.topic.trim() !== "" &&
          typeof slot.label === "string" && slot.label.trim() !== "") {
        desk.push({
          topic: slot.topic.trim(),
          label: slot.label.trim(),
          ...(slot.briefing === true ? { briefing: true } : {}),
        });
      }
    }

    tools.push(...setup.tools);
    if (setup.persona !== undefined && setup.persona !== "") persona.push(setup.persona);
    if (setup.prompt !== undefined) blocks.push(setup.prompt);
    // First one wins, and a second is reported rather than silently ignored:
    // two places to send big work is a configuration mistake, not a preference.
    if (setup.delegate !== undefined) {
      if (delegate.available) {
        problems.push("a delegate is already registered");
      } else {
        delegate = setup.delegate;
      }
    }

    reports.push({
      name: pack.name,
      state: "started",
      ...(problems.length === 0 ? {} : { problems }),
      ...declared,
    });

    // Every pack that started, named. Nothing else says which tools a
    // deployment actually has: the manifest states an intention, and a pack
    // that failed its own `configured()` is skipped in silence by design.
    console.log(`packs: ${pack.name}`);
  }

  return { servers, tools, persona, blocks, delegate, probes, watch, desk, reports };
}

