/**
 * What a pack is.
 *
 * A pack is a set of tools JARVIS gets, plus the paragraph of prompt that says
 * when to reach for them. Everything he can do beyond talking, remembering and
 * showing something on screen arrives this way: the house, the weather, the
 * mail, and whatever the person running him writes themselves.
 *
 * The shape is borrowed from Home Assistant's custom components, because that
 * is the model this project already lives next to and the one its users already
 * understand: a directory per pack, a manifest, one entry point, and a local
 * pack that shadows a first-party one of the same name. Deliberately not
 * borrowed: a configuration flow, installing dependencies at runtime, and a
 * `hass`-shaped god object handed to every component. A pack gets a context
 * with the four things it can legitimately need and nothing else.
 *
 * Core ships its own packs in exactly this form. That is the point: an
 * interface only one kind of caller uses rots, and there is no faster way to
 * find out that a pack cannot do something than to have written the house as
 * one.
 */

import type { Delegate } from "./delegate.js";
import type { HomeProvider } from "./home.js";
import type { DisplayDismiss, DisplayPayload } from "./index.js";

/**
 * What a pack is handed when it is created.
 *
 * `home` is null when no house is configured, which is a normal state and not
 * an error: a pack that needs one says so in `configured` and is skipped.
 *
 * `store` and `config` are deliberately typed loosely here. `shared` is
 * imported by the HUD as well as the brain, and pulling the memory store and
 * the whole configuration into it would drag the brain's dependencies into the
 * browser. The brain narrows both when it builds the context.
 */
export interface PackContext<Store = unknown, Config = unknown> {
  /** The memory. A pack may read and write facts like any other tool.  */
  store: Store;
  /** The whole configuration, including whatever the pack itself needs. */
  config: Config;
  /** Puts something on screen. Returns the id of what was shown. */
  display: PackDisplay;
  /** The house, or null when this deployment has none. */
  home: HomeProvider | null;

  /**
   * The turn being handled, or null between turns.
   *
   * A pack that guards an action behind a spoken confirmation needs this: the
   * rule is that the request and the execution fall in different turns, so that
   * a real utterance from the user sits between them. A pack keeps its own
   * pending state in the closure `create` returns, and that state dies with the
   * session -- which is the behaviour wanted, since a confirmation should not
   * survive the conversation it was asked in.
   */
  turn(): string | null;
}

/**
 * What a pack may put on screen, in the terms the display already uses.
 *
 * `anchor` is a word JARVIS is about to say about this — "mail", "agenda" — and
 * holds the item back until he says it. Without one the item appears at the
 * point in the sentence where the tool was called, which is right for an answer
 * that is about one thing and wrong for a briefing that walks through five.
 * Alternatives are separated by `|` ("agenda|calendar"): he says one of them,
 * in whichever language he is speaking, and the item goes up.
 *
 * `id` is the id of an item already put up, handed back in to replace it rather
 * than to put a second copy of it on screen. A window that gains something a
 * moment after it went up — a list of mails, once the assistant has judged which
 * of them need an answer — is the same window, and the user should see it change
 * rather than see it twice.
 */
export type PackDisplay = (
  payload: DisplayPayload,
  dismiss?: DisplayDismiss,
  anchor?: string,
  id?: string,
) => string;

/**
 * One environment variable a pack cannot start without.
 *
 * `configured()` remains the authority on whether the pack runs; this only says
 * what to set to change its mind. The two are allowed to disagree in one
 * direction: a pack may need more than an env file can express, so three keys
 * all present while `configured()` still returns false is possible. Core
 * therefore reports what it measured -- which of these are empty -- and never
 * promises that filling them is sufficient.
 */
export interface PackRequirement {
  /** The variable's name, exactly as the pack reads it. */
  env: string;
  /** What it is for, in the half sentence somebody needs to go and find it. */
  why: string;
}

/**
 * One reading in the HUD's context panel.
 *
 * Small on purpose. The panel is glanced at over the top of a conversation, so
 * a tile carries a word and a figure and nothing that has to be read twice.
 */
export interface HudTile {
  /** What it is, in one or two words. */
  label: string;
  /** The reading itself, already formatted and carrying its unit. */
  value: string;
  /** Whether this counts as lit: something is on, running, or waiting. */
  on?: boolean;
}

/**
 * What one tool call hands back: a sentence to say, and the figures behind it.
 *
 * Every pack answers in this one shape, so core needs to know nothing about any
 * of them. `say` is the plain reading the assistant phrases into an answer;
 * `facts` are the same reading already labelled, and they are what fills the
 * context panel. Nothing is parsed out of prose and nothing is asked of the
 * model: a figure it was told to repeat is a figure it can get wrong, which is
 * the whole reason the panel is fed from here.
 */
export type PackAnswer = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: { say: string; facts: readonly HudTile[] };
};

/**
 * The answer a tool returns.
 *
 * `structuredContent` reaches the model in place of the text, which is why
 * `say` is inside it as well as in `content` -- the two are the same sentence,
 * and a tool that filled them differently would be telling the assistant one
 * thing and the screen another.
 *
 * Facts are optional and omitting them is a real answer: a tool with nothing to
 * put on the panel returns plain text, and the panel keeps what it had. Failure
 * does not come through here at all; that is `{ content, isError: true }`, and
 * the panel is deliberately left alone by it.
 */
export function answer(say: string, facts: readonly HudTile[] = []): PackAnswer {
  const content = [{ type: "text" as const, text: say }];
  return facts.length === 0 ? { content } : { content, structuredContent: { say, facts } };
}

/**
 * What one pack contributes to a session.
 *
 * `servers` is keyed by MCP server name, which is what the tool names are built
 * from. A pack usually contributes one; the house contributes three, because
 * reading it, acting on it and reading its calendars are three different things
 * to allow, and the confirmation boundary should be visible in the tool name.
 *
 * `tools` is the list of tool-name patterns to pre-approve. A pack that returns
 * tools it does not list gets them registered and then refused, which reads
 * from the outside like a broken tool rather than a misconfigured pack.
 *
 * `persona` is the pack's own paragraph of system prompt: when to use these
 * tools and how to speak about what comes back. It is optional because a pack
 * whose tools describe themselves adequately should not be made to repeat them
 * -- prose written twice drifts, and drift between two prompts is invisible
 * until the model follows the stale one.
 *
 * All three are returned from `create` rather than declared as constants, so a
 * pack that is half-configured contributes exactly half. The house without any
 * calendars named registers no calendar server, pre-approves no calendar tool
 * and adds no paragraph about the agenda -- which is what a prompt describing
 * the assistant that actually started has to look like.
 */
/** One reading a pack offers to have taken on a clock rather than on a question. */
export interface PackWatch {
  /** The server the tool lives on, named as it is in `servers`. */
  server: string;
  /** The tool whose figures these are: it decides which subject they land under. */
  tool: string;
  /** The figures, as they stand now. */
  read: () => Promise<HudTile[]>;
}

export interface PackSetup {
  servers: Record<string, unknown>;
  tools: readonly string[];
  persona?: string;

  /**
   * How to tell whether what this pack talks to is actually answering.
   *
   * Keyed by server name, and the same function may be given for several:
   * servers that sit behind one daemon stand or fall together, so a dead
   * daemon should cost one timeout rather than one per server. A probe resolves
   * with a short line to show -- what answered -- and throws with the reason
   * when it did not.
   *
   * A server with no probe is reported as healthy without being asked, which is
   * right for one that talks to nothing outside this process and wrong for
   * anything else: silence about a dependency reads as health, and a false tick
   * is worse than no line at all.
   */
  probes?: Record<string, () => Promise<string>>;

  /**
   * Figures worth keeping current without being asked.
   *
   * A block on the context panel is written when a tool answers, and a tool
   * answers because somebody asked. The agenda is the one that goes stale while
   * it is still on screen: the next appointment stops being next the moment it
   * starts, and nobody is going to ask again to find that out. A watcher is
   * read on a clock for as long as a HUD is open, and what it returns reaches
   * the panel by the same path a tool's own figures take -- so an unchanged
   * reading changes nothing, and a changed one lands as news, with the gold on
   * it that an answer would have put there.
   *
   * Reading has to be cheap: it happens every minute, for every open page,
   * whether or not anything is being said. A watcher that throws is ignored and
   * the panel keeps what it had, which is the honest outcome of having learned
   * nothing new.
   */
  watch?: readonly PackWatch[];

  /**
   * Somewhere to hand work that is too big for the assistant itself.
   *
   * A pack may offer one; core keeps the first that is offered and otherwise
   * uses `NO_DELEGATE`. This is not a tool -- it is a capability the
   * self-development machinery reaches for on its own, which is why it does not
   * arrive as a server.
   */
  delegate?: Delegate;

  /**
   * A block of prompt this pack computes rather than writes.
   *
   * Resolved once when the session starts, and allowed to be slow: the house
   * map is a whole registry boiled down to what a spoken question reaches for,
   * and it costs a round of requests to build. A pack that has
   * nothing to compute omits it; one whose computation fails should return
   * what it can rather than throw, since a session that will not start is a
   * worse outcome than a prompt with one section missing.
   */
  prompt?: () => Promise<string>;
}

/**
 * One pack.
 *
 * `create` is called once per agent session, not once per turn, so a pack may
 * hold a cache -- or a pending confirmation -- in the closure.
 */
export interface JarvisPack<Store = unknown, Config = unknown> {
  /** Directory name, and the name a local pack shadows a first-party one by. */
  readonly name: string;

  /** One line on what this pack is for, said when it is asked what it can do. */
  readonly summary?: string;

  /**
   * What has to be set before this pack will start.
   *
   * Optional, and the reason it exists is that "not configured" is not an
   * answer anybody can act on. A pack that declares nothing is reported as
   * off without a remedy, which is honest and useless; one that declares its
   * keys lets the assistant say which of them is empty on this machine.
   *
   * Declared rather than derived from `configured()`, because a predicate can
   * be asked whether it is satisfied and never which part of it was not.
   */
  readonly needs?: readonly PackRequirement[];

  /**
   * Whether this deployment has what the pack needs.
   *
   * Called before `create`. Returning false is the ordinary case for most packs
   * on most machines, and it is not a failure: nothing is registered, no
   * paragraph is added, and nothing is said about it.
   */
  configured(context: PackContext<Store, Config>): boolean;

  /** Builds what this pack contributes. Called once per agent session. */
  create(context: PackContext<Store, Config>): PackSetup;
}
