/**
 * The agent, kept alive between turns.
 *
 * A one-shot query per turn spends roughly two and a half seconds starting a
 * process before it has even read the question. In streaming input mode the
 * process stays up and turns are pushed into it, so that cost is paid once per
 * conversation instead of once per sentence.
 *
 * The tool servers are built when the session opens, so anything that varies per
 * turn — where content for the screen should go, which turn is being confirmed —
 * is read through `#active` rather than captured at construction.
 */

import { randomUUID } from "node:crypto";

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PackDisplay } from "@jarvis/shared";

import { loadConfig, proactiveAtLeast } from "./config.js";
import { describeDeployment, deploymentBlock } from "./deployment.js";
import { createDisplayServer, DISPLAY_TOOLS, showVia, type DisplaySink } from "./display-tool.js";
import { recordScreen } from "./screens.js";
import { runHealthChecks, specsFor } from "./health.js";
import { createHome } from "./home/index.js";
import { channelsFor } from "./notify.js";
import { loadPacks, packsRoot, type Packs } from "./packs/loader.js";
import {
  createDevServer,
  DEV_SERVER_NAME,
  DEV_TOOLS,
  type DevContext,
} from "./dev-tools.js";
import { SelfDevelopment } from "./dev/run.js";
import { Escalation, type ModelSwitch } from "./escalate.js";
import {
  createInsightServer,
  INSIGHT_SERVER_NAME,
  INSIGHT_TOOLS,
} from "./proactive/insight-tools.js";
import {
  coreBlock,
  createMemoryServer,
  MEMORY_SERVER_NAME,
  MEMORY_TOOLS,
  primeFacts,
  primingBlock,
} from "./memory/tools.js";
import { recipesBlock } from "./memory/recipes.js";
import { distilSession } from "./memory/distiller.js";
import { memory } from "./memory/store.js";
import { usageFromResult } from "./memory/usage.js";
import { nowBlock } from "./now.js";
import { loadPersona } from "./persona.js";
import {
  isLimitMessage,
  limitSentence,
  notePlanEvent,
  notePlanReport,
  planContextBlock,
  planUsage,
} from "./plan.js";
import { createSetupServer, SETUP_SERVER_NAME, SETUP_TOOLS } from "./setup-tools.js";
import {
  isWebTool,
  merge,
  sourcesIn,
  sourcesPanel,
  webBlock,
  WEB_TOOLS,
  type Source,
} from "./web.js";

const config = loadConfig();
const store = memory(config.memoryPath);
// The house, if this configuration names one. Nothing here connects to it: the
// conversation only needs it to know what it may promise -- a camera to show,
// an agenda to read -- and the observation layer owns the live connection.
const home = createHome(config);
const haConfigured = home !== null;
// With the proactive side off there is nothing in those tables, and a tool that
// can only answer "I have not been watching" is worth neither its description
// nor the chance of being called.
const insightConfigured = proactiveAtLeast(config.proactive, "observe");
// Self-development needs somewhere to build; without a repository the tools
// would only ever be able to explain why they cannot do anything.
// Read once: an assistant whose character changed halfway through a
// conversation would be a stranger answering the second question.
const persona = loadPersona();
const dev = new SelfDevelopment(config, store.devConnection(), channelsFor(home, config));
const devConfigured = config.devRepo !== "";

if (!haConfigured) {
  console.warn("Home Assistant is not configured (HA_URL / HA_TOKEN); running without it.");
}

/**
 * What the packs contribute, worked out once and shared.
 *
 * The health panel needs to know which servers exist and how to ask after each
 * one's dependency, and it needs that before any conversation has started. The
 * servers built here are never connected to anything -- they are plain objects
 * carrying tool definitions -- so this costs a `create` per pack and no
 * sockets. A session builds its own set, because a session's packs need a live
 * turn to ask about.
 */
let inspected: Promise<Packs> | null = null;

export function packSummary(): Promise<Packs> {
  inspected ??= loadPacks(packsRoot, {
    store,
    config,
    display: showVia(() => {}),
    home,
    turn: () => null,
  });
  return inspected;
}

export interface TurnHandlers {
  /** A fragment of the answer, as it is generated. */
  onText: (text: string) => void;
  /** Something worth showing in the pipeline panel. */
  onActivity?: (label: string) => void;
  /**
   * What a tool answered, raw, with the name of the tool that answered it.
   *
   * The content is whatever the transport made of the result; the context panel
   * is the one thing reading it, and it decides what is worth showing.
   */
  onToolResult?: (tool: string, content: unknown) => void;
  /**
   * The plan is spent and the text that follows is the deployment's sentence
   * about it, not an answer: nothing is fetching, so nothing needs filling.
   */
  onLimit?: () => void;
  /** Content the assistant wants on screen. */
  onDisplay: DisplaySink;
}

export interface TurnResult {
  /** Full answer text, assembled from the streamed fragments. */
  text: string;
}

/** Reads a nested property without asserting the whole shape of the message. */
function pick(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A tool's arguments, short enough to keep next to a question. */
function describeInput(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    // Arrays matter here: the tool that answers most questions takes its entity
    // ids as one, and skipping them recorded every state lookup as argumentless.
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string | number => typeof item !== "object");
      if (items.length > 0) parts.push(`${key}=${items.map(String).join(" ").slice(0, 120)}`);
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${String(value).slice(0, 60)}`);
    }
  }
  return parts.join(", ");
}

interface ActiveTurn {
  /** The turn's own id, which a pack's confirmation guard reads. */
  turnId: string;
  handlers: TurnHandlers;
  devControl: DevContext;
  text: string;
  finish: () => void;
  /** When the question went in, so the wait for the first word can be measured. */
  startedAt: number;
  firstTextMs: number | null;
  toolCalls: number;
  /** Name and arguments of every tool the turn used, for learning recipes. */
  tools: Array<{ name: string; input: string }>;
  /**
   * What this turn has read on the web, newest first.
   *
   * Per turn rather than per session, and in one window rather than one per
   * search: a question answered from four searches read four sets of pages for
   * the same answer, and a screen that stacks them buries the answer under its
   * own footnotes.
   */
  sources: Source[];
}

/** One conversation's agent process, reused for every turn in it. */
export class AgentSession {
  /**
   * Identifies this conversation in the turn log and the metrics.
   *
   * Ours rather than the SDK's: the id is needed the moment a turn is written
   * down, and it has to survive the process being replaced mid-conversation.
   */
  readonly id = randomUUID();
  #active: ActiveTurn | null = null;
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  #stream: ReturnType<typeof query> | null = null;
  /** The session's way onto the screen, for what core itself shows. */
  #show: PackDisplay | null = null;
  #pump: Promise<void> | null = null;
  #broken = false;
  /** Whether the SDK will answer for the plan's windows on this session. */
  #planAvailable = true;
  /**
   * Which model this conversation's turns run on.
   *
   * Per session rather than per process: what one conversation ran into says
   * nothing about the next one, and a raised model that outlived its
   * conversation would be a cost nobody could trace back to a cause.
   */
  #escalation = new Escalation({
    base: config.model,
    raised: config.escalateModel,
    heavyPrefixes: [`mcp__${DEV_SERVER_NAME}__`],
  });

  /** True once the process is gone and the session must be replaced. */
  get broken(): boolean {
    return this.#broken;
  }

  /** Starts the process before there is anything to ask, so the first turn is not
   *  the one that pays for it. */
  async warm(): Promise<void> {
    await this.#start();
  }

  async #start(): Promise<void> {
    if (this.#stream !== null) return;

    // Everything that reaches the screen passes here -- the display tools and
    // the packs that show their own windows both -- so this is the one place
    // that can keep a copy of what the user is looking at.
    const sink: DisplaySink = (id, payload, dismiss, anchor) => {
      recordScreen(id, payload);
      this.#active?.handlers.onDisplay(id, payload, dismiss, anchor);
    };
    const display = createDisplayServer(sink, home);
    this.#show = showVia(sink);

    // Everything a pack could need, and nothing more. `turn` is a function
    // rather than a value because a pack outlives the turn it was created in:
    // the confirmation guard has to be able to ask which turn it is *now*.
    const packs = await loadPacks(packsRoot, {
      store,
      config,
      display: showVia(sink),
      home,
      turn: () => this.#active?.turnId ?? null,
    });

    // Somewhere to hand work that is too big to write here. Set every session
    // rather than once, so a local pack that appears after a restart is picked
    // up without anything else having to know it exists.
    dev.useDelegate(packs.delegate);

    for (const report of packs.reports) {
      // Being off is the ordinary state of most packs on most machines, and a
      // directory that is not a pack has innocent explanations; neither is
      // worth a line. Broken is a pack that meant to work and did not, and a
      // problem is one that started with a piece of itself refused.
      if (report.state === "broken") {
        console.warn(`packs: ${report.name} is not running -- ${report.reason ?? "no reason"}`);
      }
      for (const problem of report.problems ?? []) {
        console.warn(`packs: ${report.name} started, but ${problem}`);
      }
    }

    const computed = await Promise.all(
      packs.blocks.map(async (block) => {
        try {
          return await block();
        } catch (error) {
          console.warn("packs: a prompt block failed:", error);
          return "";
        }
      }),
    );

    // Named from the same expression that registers them a few lines down, so
    // the list the assistant is told about cannot drift from the one it has.
    const serverNames = [
      "display",
      MEMORY_SERVER_NAME,
      ...Object.keys(packs.servers),
      ...(insightConfigured ? [INSIGHT_SERVER_NAME] : []),
      ...(devConfigured ? [DEV_SERVER_NAME] : []),
      SETUP_SERVER_NAME,
    ];
    const deployment = describeDeployment(config, packs.reports, serverNames, persona.own);

    // Directly after the character and before anything a pack says, because it
    // is the paragraph that bounds the rest: the persona describes an assistant
    // with a house, and on a machine without one that description is the thing
    // being contradicted.
    const systemPrompt = [
      persona.text,
      deploymentBlock(deployment),
      ...packs.persona,
      coreBlock(store),
      ...(config.web ? [webBlock()] : []),
      ...computed,
      recipesBlock(store),
    ]
      .filter((part) => part !== "")
      .join("\n\n");

    const self = this;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (self.#queue.length === 0) {
          if (self.#closed) return;
          await new Promise<void>((resolve) => {
            self.#wake = resolve;
          });
        }
        const next = self.#queue.shift();
        if (next !== undefined) yield next;
      }
    }

    this.#stream = query({
      prompt: input(),
      options: {
        model: config.model,
        ...(config.fallbackModel === "" ? {} : { fallbackModel: config.fallbackModel }),
        // Brakes, not budgets: they exist so a turn that has started going in
        // circles ends in a sentence rather than in a bill. A turn that trips
        // one is answered with a stopped-turn line, and the conversation
        // carries on -- the process survives its own limit.
        ...(config.maxSteps === 0 ? {} : { maxTurns: config.maxSteps }),
        ...(config.maxTurnUsd === 0 ? {} : { maxBudgetUsd: config.maxTurnUsd }),
        systemPrompt,
        mcpServers: {
          display,
          [MEMORY_SERVER_NAME]: createMemoryServer(store),
          ...packs.servers,
          ...(insightConfigured ? { [INSIGHT_SERVER_NAME]: createInsightServer(store) } : {}),
          ...(devConfigured
            ? {
                [DEV_SERVER_NAME]: createDevServer(config, dev, () => {
                  const active = this.#active;
                  if (active === null) throw new Error("no turn in progress");
                  return active.devControl;
                }),
              }
            : {}),
          // Asks the same dependencies the HUD's panel asks, from the packs this
          // session loaded rather than from a list written here.
          [SETUP_SERVER_NAME]: createSetupServer(deployment, () =>
            runHealthChecks(specsFor(config, store, Object.keys(packs.servers), packs.probes)),
          ),
        },
        allowedTools: [
          ...DISPLAY_TOOLS,
          ...MEMORY_TOOLS,
          ...packs.tools,
          ...(insightConfigured ? INSIGHT_TOOLS : []),
          ...(devConfigured ? DEV_TOOLS : []),
          ...SETUP_TOOLS,
          ...(config.web ? WEB_TOOLS : []),
        ],
        // The two that read the web, and nothing else: this assistant has no
        // business reading the filesystem, and every other built-in tool does.
        tools: config.web ? [...WEB_TOOLS] : [],
        // Nothing from ~/.claude should leak into the assistant's behaviour.
        settingSources: [],
        includePartialMessages: true,
      },
    });

    this.#pump = this.#read();
  }

  /** Reads for the life of the session, routing everything to the active turn. */
  async #read(): Promise<void> {
    const stream = this.#stream;
    if (stream === null) return;

    // Which tool a result belongs to. The name is only in the `tool_use` block
    // that went out; the result that comes back carries the id and nothing
    // else, and the panel needs the name to know whose figures these are.
    // Emptied as results arrive, and again per turn, so a turn that was
    // abandoned mid-call does not leave its calls behind for the session.
    const calls = new Map<string, string>();

    try {
      for await (const message of stream) {
        const type = pick(message, "type");

        // The state of the plan rides along on every call. Kept for the HUD's
        // pill and for the sentence below, which needs the reset time.
        if (type === "rate_limit_event") {
          notePlanEvent(pick(message, "rate_limit_info"));
          continue;
        }

        if (type === "stream_event") {
          const delta = pick(message, "event", "delta");
          if (pick(delta, "type") === "text_delta") {
            const chunk = pick(delta, "text");
            if (typeof chunk === "string" && chunk !== "" && this.#active !== null) {
              this.#active.firstTextMs ??= performance.now() - this.#active.startedAt;
              this.#active.text += chunk;
              this.#active.handlers.onText(chunk);
            }
          }
          continue;
        }

        // A tool result comes back as a user message. An error in one is the
        // clearest evidence there is that this turn is not the easy kind; a
        // successful one may be carrying the figures for the context panel.
        if (type === "user") {
          const content = pick(message, "message", "content") ?? pick(message, "content");
          if (Array.isArray(content)) {
            for (const block of content) {
              if (pick(block, "type") !== "tool_result") continue;
              const id = pick(block, "tool_use_id");
              const tool = typeof id === "string" ? calls.get(id) : undefined;
              if (typeof id === "string") calls.delete(id);
              if (pick(block, "is_error") === true) {
                await this.#raise(this.#escalation.onToolError());
              } else if (tool !== undefined) {
                this.#active?.handlers.onToolResult?.(tool, pick(block, "content"));
                this.#noteSources(tool, pick(block, "content"));
              }
            }
          }
          continue;
        }

        if (type === "assistant") {
          const content = pick(message, "message", "content") ?? pick(message, "content");
          // A spent plan comes back as an assistant message with an error on it
          // and the SDK's own English line as its text. Nothing was streamed
          // before it, so nothing has been said yet; what is said instead is
          // the deployment's sentence, with the reset time from the event.
          const firstText = Array.isArray(content)
            ? content.map((block) => pick(block, "text")).find((text) => typeof text === "string")
            : undefined;
          if (
            pick(message, "error") === "rate_limit" ||
            (typeof firstText === "string" && isLimitMessage(firstText))
          ) {
            const active = this.#active;
            if (active !== null && active.text === "") {
              console.warn(`agent: the plan is spent -- ${typeof firstText === "string" ? firstText : "rate_limit"}`);
              const sentence = limitSentence(config.limitSentence, planUsage());
              active.text = sentence;
              active.handlers.onLimit?.();
              active.handlers.onText(sentence);
            }
            continue;
          }
          if (Array.isArray(content)) {
            for (const block of content) {
              if (pick(block, "type") === "tool_use") {
                const name = pick(block, "name");
                if (this.#active !== null) {
                  this.#active.toolCalls += 1;
                  if (typeof name === "string") {
                    this.#active.tools.push({ name, input: describeInput(pick(block, "input")) });
                  }
                }
                if (typeof name === "string") {
                  const id = pick(block, "id");
                  if (typeof id === "string") calls.set(id, name);
                  this.#active?.handlers.onActivity?.(name);
                  await this.#raise(this.#escalation.onTool(name));
                }
              } else if (pick(block, "type") === "text" && this.#active?.text === "") {
                // Fallback for a turn that produced no stream events at all.
                const text = pick(block, "text");
                if (typeof text === "string" && text !== "") {
                  this.#active.text += text;
                  this.#active.handlers.onText(text);
                }
              }
            }
          }
          continue;
        }

        if (type === "result") {
          this.#record(message);
          calls.clear();
          const subtype = pick(message, "subtype");
          // A turn stopped by a brake produces no text at all, and silence is
          // the one answer a voice assistant may never give.
          const active = this.#active;
          if (active !== null && active.text === "" && typeof subtype === "string" && subtype.startsWith("error_")) {
            console.warn(`agent: a turn was stopped (${subtype})`);
            active.text = config.stoppedSentence;
            active.handlers.onText(config.stoppedSentence);
          }
          this.#active?.finish();
          void this.#refreshPlan();
        }
      }
    } catch (error) {
      console.error("agent session ended:", error);
    } finally {
      this.#broken = true;
      this.#active?.finish();
    }
  }

  /**
   * Puts what a web tool just read on the screen, as one window per turn.
   *
   * The same discipline a pack's own window follows: built from the result that
   * was travelling back anyway, so the list cannot disagree with what is being
   * said, and no model is asked to repeat a URL it could get wrong. It goes up
   * where the sentence has got to -- there is no word to wait for, because the
   * assistant answers the question rather than announcing that it searched.
   */
  #noteSources(tool: string, content: unknown): void {
    const active = this.#active;
    const show = this.#show;
    if (active === null || show === null || !isWebTool(tool)) return;

    const merged = merge(active.sources, sourcesIn(content));
    // A search that turned up nothing new -- or nothing at all -- leaves the
    // window exactly as it is rather than redrawing the same list.
    if (merged.map((source) => source.url).join("\n") === active.sources.map((source) => source.url).join("\n")) {
      return;
    }
    active.sources = merged;

    const panel = sourcesPanel(merged);
    // Same id every time in this turn, so a second search updates the window in
    // place instead of pushing the first one down the row.
    if (panel !== null) show(panel, undefined, undefined, `sources-${active.turnId}`);
  }

  /**
   * Applies a model change, or does nothing when there is none to apply.
   *
   * Never allowed to end the turn: a session that cannot change model is a
   * session running on the wrong one, which is worse than the alternative only
   * if the alternative is not answering at all.
   */
  async #raise(change: ModelSwitch | null): Promise<void> {
    if (change === null || this.#stream === null) return;
    try {
      await this.#stream.setModel(change.model);
      console.log(`agent: ${change.model} for this turn -- ${change.why}`);
    } catch (error) {
      console.error("agent: could not change model:", error);
    }
  }

  /** Runs one turn, resolving when the assistant has finished answering. */
  async ask(
    text: string,
    turnId: string,
    handlers: TurnHandlers,
    devControl: DevContext,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    await this.#start();

    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const active: ActiveTurn = {
      turnId,
      handlers,
      devControl,
      text: "",
      finish,
      startedAt: performance.now(),
      firstTextMs: null,
      toolCalls: 0,
      tools: [],
      sources: [],
    };
    this.#active = active;
    await this.#raise(this.#escalation.startTurn());

    // Facts the question already reaches for, found locally in a few milliseconds
    // and sent along with it. Without this the assistant pays a tool round trip to
    // learn something the database could have volunteered.
    let asked = text;
    try {
      const block = primingBlock(await primeFacts(store, text));
      if (block !== "") asked = `${block}

${text}`;
    } catch (error) {
      console.error("memory: could not prime the question:", error);
    }

    // The plan, once it is worth economising on. In front of the question
    // rather than in the system prompt, which was written before it drained.
    const plan = planContextBlock(planUsage(), config.planWarnPct);
    if (plan !== "") asked = `${plan}

${asked}`;

    // The clock, first of all and for the same reason: the session was started
    // at an hour that has passed, and everything else in this message is about
    // something that happened at a time.
    asked = `${nowBlock()}

${asked}`;

    this.#queue.push({
      type: "user",
      message: { role: "user", content: asked },
      parent_tool_use_id: null,
      session_id: "",
    } as SDKUserMessage);

    const wake = this.#wake;
    this.#wake = null;
    wake?.();

    const onAbort = () => {
      void this.#stream?.interrupt().catch(() => undefined);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await finished;
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.#escalation.endTurn();
      if (this.#active === active) this.#active = null;
    }

    if (active.text.trim() !== "" && !signal.aborted) {
      // Written down now, judged later: distillation happens when the whole
      // conversation is over, on a cheaper model, out of the answer's way.
      const turnId = store.logTurn(this.id, text, active.text);
      store.recordToolCalls(turnId, active.tools);
    }

    return { text: active.text };
  }

  /**
   * Asks the SDK for both windows of the plan, after a turn. The method is
   * experimental and the token is not always allowed to ask; the first refusal
   * is remembered for the session, since every turn after it would be refused
   * the same way. The events keep the pill honest in the meantime.
   */
  async #refreshPlan(): Promise<void> {
    const stream = this.#stream;
    if (stream === null || !this.#planAvailable) return;
    const ask = (stream as unknown as Record<string, unknown>)[
      "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"
    ];
    if (typeof ask !== "function") {
      this.#planAvailable = false;
      return;
    }
    try {
      const report: unknown = await (ask as () => Promise<unknown>).call(stream);
      if (notePlanReport(report) === null) this.#planAvailable = false;
    } catch {
      // The pill keeps what the events said.
    }
  }

  /** Writes down what the finished turn cost. Never allowed to break the turn. */
  #record(message: unknown): void {
    const active = this.#active;
    if (active === null) return;
    try {
      const record = usageFromResult(message, {
        kind: "turn",
        sessionId: this.id,
        firstTextMs: active.firstTextMs,
        toolCalls: active.toolCalls,
      });
      if (record !== null) store.recordUsage(record);
    } catch (error) {
      console.error("usage: could not record the turn:", error);
    }
  }

  close(): void {
    this.#closed = true;
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
    this.#stream = null;
    // The conversation is over, so this is the moment its transcript is complete.
    void distilSession(store, this.id);
  }
}
