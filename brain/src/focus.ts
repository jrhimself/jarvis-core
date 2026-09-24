/**
 * Which standing desk panel a display or tile push is about.
 *
 * The v1 HUD already maps display payloads to sticky desk topics client-side
 * (`stickyTopicOf` / `WINDOW_TOPICS` in hud/public/index.html). The always-on
 * /v2 desk needs the same answer from the brain, as `focus` / `unfocus`, so the
 * mapping lives here once and both clients can share it.
 */

import type { DisplayCue, DisplayPayload, ServerMessage } from "@jarvis/shared";

/**
 * Core desk topic ids. Packs may add more via `desk`; those ids pass through
 * unchanged when tiles name them. `system` is reserved for the HUD's own
 * metrics strip and is not raised by displays or pack tiles today.
 */
export const CORE_PANEL_IDS = ["weather", "agenda", "mail", "work", "notes"] as const;
export type CorePanelId = (typeof CORE_PANEL_IDS)[number];

/**
 * Title words → desk topic, matching the v1 HUD's WINDOW_TOPICS table.
 * Kept as a mutable record so tests (and a future desk refresh) can extend it
 * the same way `applyDeskSlots` extends the client table.
 */
export const WINDOW_TOPICS: Record<string, string> = {
  agenda: "agenda",
  calendar: "agenda",
  kalender: "agenda",
  afspraak: "agenda",
  afspraken: "agenda",
  mail: "mail",
  email: "mail",
  inbox: "mail",
  weer: "weather",
  weather: "weather",
  forecast: "weather",
  weersverwachting: "weather",
  werk: "work",
  work: "work",
  pull: "work",
  pulls: "work",
  request: "work",
  requests: "work",
  pr: "work",
  prs: "work",
  note: "notes",
  notes: "notes",
  notitie: "notes",
  notities: "notes",
};

/** First WINDOW_TOPICS hit in a title, or the first word, or "". */
export function windowTopic(title: string): string {
  const t = title.trim().toLowerCase();
  if (t === "") return "";
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of words) {
    const hit = WINDOW_TOPICS[w];
    if (hit !== undefined) return hit;
  }
  return words[0] ?? "";
}

/**
 * Desk topic for a display payload, or null when it is not a standing panel
 * (image, chart, one-shot text that names no known subject).
 *
 * Mirrors v1 `stickyTopicOf`: weather payloads are weather; titled panels map
 * through WINDOW_TOPICS; untitled text falls to notes.
 */
export function panelOfDisplay(payload: DisplayPayload): string | null {
  if (payload.type === "weather") return "weather";
  if (payload.type === "image" || payload.type === "chart") return null;

  if (payload.type === "panel") {
    const fromTitle = windowTopic(payload.title);
    return fromTitle === "" ? null : fromTitle;
  }

  // text
  const fromTitle = windowTopic(payload.title ?? "note");
  if (fromTitle === "notes" || payload.title === undefined || payload.title.trim() === "") {
    return "notes";
  }
  return fromTitle === "" ? null : fromTitle;
}

/** Sink the focus gate writes into. Same shape as the per-socket `send`. */
export type FocusSend = (message: ServerMessage) => void;

/**
 * Emits `focus` / `unfocus` for one websocket, only on change.
 *
 * Focus fires for every turn whose display or in-turn tiles map to a desk
 * topic — briefing and ordinary answers alike — so an always-visible panel
 * lights when Jarvis talks about it. Unfocus fires when that turn ends.
 */
export class FocusGate {
  #current: string | null = null;

  constructor(private readonly send: FocusSend) {}

  /** Panel currently lit, or null. Exposed for tests. */
  get current(): string | null {
    return this.#current;
  }

  focus(panel: string, cue?: DisplayCue): void {
    const id = panel.trim();
    if (id === "" || id === this.#current) return;
    this.#current = id;
    this.send({
      kind: "focus",
      panel: id,
      ...(cue === undefined ? {} : { cue }),
    });
  }

  unfocus(): void {
    if (this.#current === null) return;
    this.#current = null;
    this.send({ kind: "unfocus" });
  }
}
