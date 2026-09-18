/**
 * What the HUD's context panel shows, and who decides it.
 *
 * The panel used to hold six invented readings. It now holds the figures the
 * pack doing the work put on its own answer: ask about the weather and the
 * weather pack's forecast tool carries them, ask about the mail and the mail
 * pack's does. Nothing is decided by the model, nothing is parsed out of prose,
 * and no tool call is spent on it -- the answer already travels back through
 * this process on its way to the model, and `facts` on it is the whole signal.
 *
 * The set that is up stays up until the same subject is answered again. A
 * context panel that emptied itself between questions would be blank almost
 * always, and the last thing discussed is a better answer to "where are we"
 * than nothing at all. A tool that failed carries no facts, so a failure leaves
 * the panel as it was rather than blanking it -- which is the honest outcome:
 * nothing new was learned.
 *
 * Figures are grouped by subject rather than by server. The house pack answers
 * about the weather, about the agenda and about the rooms, and a panel keyed on
 * the server would have those three overwriting each other all morning. The
 * subject is read off the tool name, which is the one thing that already says
 * which of the three was asked.
 */

import type { HudTile } from "@jarvis/shared";

/** How many fit before the panel starts scrolling. */
export const MAX_TILES = 6;

/**
 * The server a tool name belongs to, or null when it names no server.
 *
 * Tool names arrive as `mcp__<server>__<tool>`. Core's own tools do not carry
 * that prefix, and neither do the labels the conversation writes for itself, so
 * those leave the panel alone rather than clearing it.
 */
export function serverOf(label: string): string | null {
  if (!label.startsWith("mcp__")) return null;
  const rest = label.slice("mcp__".length);
  const end = rest.indexOf("__");
  if (end <= 0) return null;
  return rest.slice(0, end);
}

/**
 * The tool a label names, or null when it names none.
 *
 * Same shape as `serverOf`, from the other side of the separator.
 */
export function toolOf(label: string): string | null {
  if (!label.startsWith("mcp__")) return null;
  const rest = label.slice("mcp__".length);
  const end = rest.indexOf("__");
  if (end <= 0) return null;
  const tool = rest.slice(end + 2);
  return tool === "" ? null : tool;
}

/** A subject on the context panel: its key, and what it is called on screen. */
export interface Topic {
  id: string;
  label: string;
}

/**
 * Tools whose subject is not the server they live on.
 *
 * Matched on the tool name alone, because a tool name is unique enough to be
 * worth one line here and a server name is not: `get_weather_forecast` is the
 * weather wherever it ends up living. Anything not listed falls back to its
 * server, which is right for the packs that do one thing.
 */
const TOOL_TOPICS: Record<string, Topic> = {
  get_weather_forecast: { id: "weather", label: "Weather" },
  get_calendar: { id: "agenda", label: "Agenda" },
};

/** What a server's figures are called when its tools do not say otherwise. */
const SERVER_TOPICS: Record<string, Topic> = {
  ha: { id: "house", label: "House" },
  control: { id: "house", label: "House" },
  calendar: { id: "agenda", label: "Agenda" },
  gmail: { id: "mail", label: "Mail" },
  spotify: { id: "music", label: "Music" },
  telegram: { id: "messages", label: "Messages" },
  netflix: { id: "tv", label: "Television" },
  bridge: { id: "work", label: "Work" },
  "ado-pr": { id: "work", label: "Work" },
};

/** Title-cases a bare server name so an unlisted pack still reads as a heading. */
function titled(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words === "" ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which block of the panel a tool's figures belong in. */
export function topicOf(server: string, tool: string | null): Topic {
  const byTool = tool === null ? undefined : TOOL_TOPICS[tool];
  if (byTool !== undefined) return byTool;
  return SERVER_TOPICS[server] ?? { id: server, label: titled(server) };
}

/** Drops what cannot be shown and cuts the rest to what fits. */
export function usable(tiles: readonly HudTile[]): HudTile[] {
  return tiles
    .filter((tile) => tile.label.trim() !== "" && tile.value.trim() !== "")
    .slice(0, MAX_TILES)
    .map((tile) => ({
      label: tile.label.trim(),
      value: tile.value.trim(),
      ...(tile.on === undefined ? {} : { on: tile.on }),
    }));
}

/**
 * The facts on a tool result, if it carried any.
 *
 * The result arrives as whatever the transport made of it: a JSON string when
 * the tool answered with `answer(say, facts)`, an array of content blocks when
 * it answered with plain text, and a bare sentence when it failed. Only the
 * first of those has anything to say here, and everything else -- a pack that
 * does not use the helper, a pack on an older version of it, a tool that threw
 * -- has to come out as no facts rather than as an exception.
 */
export function factsIn(content: unknown): HudTile[] {
  if (typeof content !== "string" || !content.trimStart().startsWith("{")) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  const facts = (parsed as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(facts)) return [];

  const tiles: HudTile[] = [];
  for (const entry of facts) {
    if (typeof entry !== "object" || entry === null) continue;
    const { label, value, on } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof value !== "string") continue;
    tiles.push(typeof on === "boolean" ? { label, value, on } : { label, value });
  }
  return tiles;
}

export type TileSink = (source: string, topic: Topic, tiles: HudTile[]) => void;

/**
 * Watches the answers of one connection and keeps its panel current.
 *
 * One of these per open HUD: what it remembers is per screen, so a second page
 * opening gets the panel filled by whatever it sees next rather than inheriting
 * somebody else's.
 *
 * When a block reaches the screen is the HUD's business, not this one's: the
 * figures are sent the moment they exist and the panel holds them back until
 * the subject is actually spoken.
 */
export function tileFeed(sink: TileSink): (tool: string, content: unknown) => void {
  const showing = new Map<string, string>();

  return (tool: string, content: unknown): void => {
    const server = serverOf(tool);
    if (server === null) return;

    const tiles = usable(factsIn(content));
    if (tiles.length === 0) return;

    const topic = topicOf(server, toolOf(tool));

    // A pack whose tools are called five times in a turn usually reports the
    // same figures five times, and a block does not need to be told twice.
    const shown = JSON.stringify(tiles);
    if (showing.get(topic.id) === shown) return;
    showing.set(topic.id, shown);

    sink(server, topic, tiles);
  };
}
