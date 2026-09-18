/**
 * The tool JARVIS uses to put something on screen.
 *
 * The screen belongs to one conversation, so the server is built per turn around
 * a sink that knows which socket to write to.
 *
 * Every handler answers with the same line, and the line is an instruction not to
 * talk about it. "Panel is on screen." read back as news worth passing on, and
 * the answers duly ended in "de historie staat op het scherm" — a sentence that
 * tells someone looking at the screen what they can already see. The window is
 * there to be looked at; saying so is the one thing it makes unnecessary.
 */

import { randomUUID } from "node:crypto";

import type { DisplayDismiss, DisplayPayload, HomeProvider, PackDisplay } from "@jarvis/shared";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { fetchAndStore, MediaFetchError } from "./media.js";
import { describeScreen, recentScreens, screenById, screenTitle } from "./screens.js";

export type DisplaySink = (
  id: string,
  payload: DisplayPayload,
  dismiss: DisplayDismiss,
  anchor?: string,
) => void;

/**
 * How long each kind of content earns on screen.
 *
 * A camera still is glanced at, so it goes away by itself. Figures and charts are
 * read, so they stay until the conversation moves on. A note stays put — it is
 * shown precisely because it should not be missed.
 */
function defaultDismiss(payload: DisplayPayload): DisplayDismiss {
  switch (payload.type) {
    case "image":
      return { mode: "timeout", ms: 45_000 };
    case "panel":
    case "chart":
      return { mode: "next-turn" };
    case "text":
      return { mode: "manual" };
  }
}

/**
 * Putting something on screen, without a tool call in between.
 *
 * The same path the display tools take, exposed because a pack has a screen
 * too: it is handed this rather than the sink, so it does not have to invent an
 * id or decide how long a chart stays up.
 *
 * Handing back an id it was given earlier replaces that item: the HUD clears the
 * card with that id before it draws the new one, so the same window is updated
 * in place instead of being pushed twice.
 */
export function showVia(sink: DisplaySink): PackDisplay {
  return (payload, dismiss, anchor, id) => {
    const shownAs = id ?? randomUUID().slice(0, 8);
    sink(shownAs, payload, dismiss ?? defaultDismiss(payload), anchor);
    return shownAs;
  };
}

/**
 * The word the item waits for, offered to every display tool.
 *
 * It is the same field on all of them because the assistant should not have to
 * learn which kinds of content can be timed; the ones that are shown while he
 * talks are exactly the ones worth timing.
 */
const anchorField = z
  .string()
  .min(2)
  .optional()
  .describe(
    "A word from your own answer that this belongs to, for example 'mail' or 'agenda'. " +
      "The screen holds it back until you say that word. Leave it out to have it " +
      "appear where you are in the sentence right now.",
  );

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * What every handler that put something up answers.
 *
 * Terse on purpose, and an instruction rather than a report: anything that reads
 * as a fact about the screen comes back out of the model as a sentence about the
 * screen.
 */
const SHOWN = "Done. Say nothing about the screen or about having shown anything; " +
  "answer as if the window were not there.";

/** The same rule, for the tool descriptions the model reads before calling. */
const NEVER_NARRATE =
  " Never say that you are showing something, that it is on screen, or where to look: " +
  "the window is seen, not announced.";

function failed(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * The display server, with as many tools as the house can back.
 *
 * `show_camera` is only registered when there is a house and it says it has
 * cameras. Registering it regardless and failing at call time would be worse
 * than useless: the assistant reads the tool list as a list of promises, and a
 * promise it discovers is empty halfway through an answer is one the user
 * already heard it make.
 */
export function createDisplayServer(sink: DisplaySink, home: HomeProvider | null) {
  const show = showVia(sink);

  const showImage = tool(
    "show_image",
    "Show an image on the HUD, in place of the orb. Use it for camera stills, maps, " +
      "photos or diagrams — anything the user is better off seeing than hearing. " +
      "The image is fetched by the brain, so a source that needs credentials is fine." +
      NEVER_NARRATE +
      " " +
      "Always keep talking as well: the image supports the answer, it does not replace it.",
    {
      source: z
        .string()
        .url()
        .describe("http(s) address of the image to fetch and display"),
      alt: z
        .string()
        .min(3)
        .describe("Short description of what is in the image, in Dutch"),
      caption: z.string().optional().describe("Optional caption shown under the image, in Dutch"),
      refresh_seconds: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("Set only for a live camera: how often to refresh the image"),
      anchor: anchorField,
    },
    async (args) => {
      try {
        const stored = await fetchAndStore(args.source);
        const payload: DisplayPayload = {
          type: "image",
          url: stored.url,
          alt: args.alt,
          ...(args.caption === undefined ? {} : { caption: args.caption }),
          ...(args.refresh_seconds === undefined
            ? {}
            : { refreshMs: args.refresh_seconds * 1000 }),
        };
        show(payload, undefined, args.anchor);
        return ok(SHOWN);
      } catch (error) {
        if (error instanceof MediaFetchError) return failed(error.message);
        const reason = error instanceof Error ? error.message : String(error);
        return failed(`Could not fetch the image: ${reason}`);
      }
    },
    { annotations: { readOnlyHint: false, openWorldHint: true } },
  );

  const showPanel = tool(
    "show_panel",
    "Show a small table of values on the HUD — statuses, readings, a short list. " +
      "Use it when several numbers belong together and reading them all out loud " +
      "would be tedious. Say the headline out loud, show the detail." + NEVER_NARRATE,
    {
      title: z.string().min(1).describe("Panel heading, in Dutch"),
      rows: z
        .array(
          z.object({
            label: z.string().min(1).describe("What the value is, in Dutch"),
            value: z.string().min(1).describe("The value, already formatted for reading"),
            hint: z.string().optional().describe("Optional smaller note beside the value"),
          }),
        )
        .min(1)
        .max(12)
        .describe("Rows to show, at most twelve — this is a glance, not a report"),
      anchor: anchorField,
    },
    async (args) => {
      show({ type: "panel", title: args.title, rows: args.rows }, undefined, args.anchor);
      return ok(SHOWN);
    },
    { annotations: { readOnlyHint: false } },
  );

  const showChart = tool(
    "show_chart",
    "Show a simple chart on the HUD for something that changes over time — " +
      "temperature, solar yield, consumption. Give the points in chronological order." +
      NEVER_NARRATE,
    {
      title: z.string().min(1).describe("Chart heading, in Dutch"),
      unit: z.string().optional().describe('Unit for the axis, for example "°C" or "kWh"'),
      points: z
        .array(
          z.object({
            label: z.string().min(1).describe('Point label, for example "08:00" or "ma"'),
            value: z.number().describe("Numeric value at this point"),
          }),
        )
        .min(2)
        .max(60)
        .describe("Points in chronological order"),
      anchor: anchorField,
    },
    async (args) => {
      show(
        {
          type: "chart",
          title: args.title,
          ...(args.unit === undefined ? {} : { unit: args.unit }),
          points: args.points,
        },
        undefined,
        args.anchor,
      );
      return ok(SHOWN);
    },
    { annotations: { readOnlyHint: false } },
  );

  const showNote = tool(
    "show_note",
    "Put a short passage of text on the HUD. Use it for something worth keeping in " +
      "view — a code, an address, a list of steps — not for your spoken answer." +
      NEVER_NARRATE,
    {
      title: z.string().optional().describe("Optional heading, in Dutch"),
      body: z.string().min(1).max(800).describe("The text to show, in Dutch"),
      anchor: anchorField,
    },
    async (args) => {
      show(
        {
          type: "text",
          ...(args.title === undefined ? {} : { title: args.title }),
          body: args.body,
        },
        undefined,
        args.anchor,
      );
      return ok(SHOWN);
    },
    { annotations: { readOnlyHint: false } },
  );

  /**
   * What is, and was, on the screen.
   *
   * Without this the screen is write-only: the assistant knows it called
   * `show_panel`, and nothing about what happened to the window afterwards. The
   * user does -- they closed it -- and the next sentence is about a thing only
   * one of the two can see.
   */
  const recentScreensTool = tool(
    "recent_screens",
    "What you have put on the HUD recently: the contents of each window, when it went " +
      "up, and whether it is still there or the user closed it. Use it whenever the user " +
      "refers to something you showed -- 'what did that say again', 'I closed that by " +
      "accident', 'show me those mails once more'. It answers from what was already on " +
      "screen, so prefer it over fetching the same thing a second time: that is slower " +
      "and can come back different from what they were looking at.",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(12)
        .optional()
        .describe("How many windows back to go. Defaults to the last six."),
    },
    async (args) => {
      const records = recentScreens(args.limit ?? 6);
      if (records.length === 0) return ok("Nothing has been on the screen yet.");
      return ok(records.map((record) => describeScreen(record)).join("\n\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const showAgain = tool(
    "show_again",
    "Put a window that was shown before back on the HUD, exactly as it was. Take the id " +
      "from recent_screens. Use it when the user wants to look at something again rather " +
      "than hear it read out -- an overview they closed, a chart that scrolled away." +
      NEVER_NARRATE,
    {
      id: z.string().min(1).describe("The id of the window, from recent_screens"),
      anchor: anchorField,
    },
    async (args) => {
      const record = screenById(args.id);
      if (record === undefined) return failed("There is no window with that id any more.");
      show(record.payload, undefined, args.anchor);
      return ok(SHOWN);
    },
    { annotations: { readOnlyHint: false } },
  );

  const showCamera = tool(
    "show_camera",
    "Show what a camera sees, on the HUD. Give the camera's entity id, for example " +
      "camera.voordeur. Use it whenever the user asks to see a camera, and whenever " +
      "something at the door is worth looking at rather than describing." + NEVER_NARRATE,
    {
      entity_id: z
        .string()
        .regex(/^camera\.[a-z0-9_]+$/, "must be a camera entity id, like camera.voordeur")
        .describe("Entity id of the camera"),
      alt: z.string().min(3).describe("Which camera this is, in Dutch, e.g. 'de voordeur'"),
      live: z
        .boolean()
        .default(false)
        .describe("True to keep refreshing the image, false for a single snapshot"),
      anchor: anchorField,
    },
    async (args) => {
      const still = home?.cameraStill?.(args.entity_id);
      if (still === undefined) return failed("There is no camera to show here.");
      try {
        const stored = await fetchAndStore(still.url, still.headers);
        show(
          {
            type: "image",
            url: stored.url,
            alt: args.alt,
            ...(args.live ? { refreshMs: 2000 } : {}),
          },
          undefined,
          args.anchor,
        );
        return ok(SHOWN);
      } catch (error) {
        if (error instanceof MediaFetchError) return failed(error.message);
        const reason = error instanceof Error ? error.message : String(error);
        return failed(`Could not reach the camera: ${reason}`);
      }
    },
    { annotations: { readOnlyHint: false, openWorldHint: true } },
  );

  const hasCameras = home !== null && home.capabilities.camera && home.cameraStill !== undefined;

  return createSdkMcpServer({
    name: "display",
    version: "1.0.0",
    tools: hasCameras
      ? [showImage, showPanel, showChart, showNote, showCamera, recentScreensTool, showAgain]
      : [showImage, showPanel, showChart, showNote, recentScreensTool, showAgain],
  });
}

/** Tool names to pre-approve so the display never prompts for permission. */
export const DISPLAY_TOOLS = ["mcp__display__*"];
