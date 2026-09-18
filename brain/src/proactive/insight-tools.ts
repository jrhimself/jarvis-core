/**
 * What JARVIS noticed while nobody was asking, offered back when somebody does.
 *
 * The watcher fills a table on a timer and says nothing. This is the one door out
 * of it, and it is a door somebody else has to open: "is er iets bijzonders?"
 * reaches this tool, an hour in which the house behaved reaches nothing at all.
 * Speaking first is a later step and needs a protocol change the HUD does not
 * have yet.
 *
 * Read-only, and cheap in the way that matters: no model is called to produce
 * these lines, because the rules already ran. A turn that never asks pays for
 * the tool description and nothing else, which is why the server is not even
 * registered unless the proactive side is switched on.
 *
 * The two states worth telling apart are "nothing is wrong" and "nothing has
 * been watched yet". A fresh database answers both with an empty table, and
 * reporting silence as health would be the first lie this subsystem tells.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { MemoryStore } from "../memory/store.js";
import type { OpenAnomaly } from "./detect.js";
import { openAnomalies } from "./detect.js";

const HOUR_MS = 3600_000;

/** How many rows the assistant is handed at most, ripe or not. */
const MAX_SHOWN = 12;

/**
 * What each rule is actually claiming, in the words a person would use.
 *
 * The rule names are terms of art from `rules.ts` and mean nothing out loud;
 * `detail` already names the entity and says by how much, so this only has to
 * say what kind of wrongness it is. `stuck` is deliberately vague about which
 * of the two it is: the rule covers a sensor that has not moved in a day and
 * one that has gone unavailable, and the detail says which.
 */
const RULE_LABEL: Record<string, string> = {
  deviation: "afwijkende meting",
  missing: "verwacht patroon bleef uit",
  stuck: "sensor stil of onbereikbaar",
  problem: "probleemmelding",
  heartbeat: "eigen taak liep niet",
  invariant: "eigen toestand klopt niet",
};

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Spoken-scale ages: "twee dagen", not "1 day, 19:04:11". */
function age(from: string, now: number): string {
  const hours = (now - new Date(from).getTime()) / HOUR_MS;
  if (hours < 1) return "net";
  if (hours < 48) return `${Math.round(hours)} uur`;
  return `${Math.round(hours / 24)} dagen`;
}

function line(anomaly: OpenAnomaly, now: number): string {
  const label = RULE_LABEL[anomaly.rule] ?? anomaly.rule;
  const where = anomaly.area === null ? "" : ` in ${anomaly.area}`;
  const held = age(anomaly.firstAt, now);
  const ripe = anomaly.ripe ? held : `${held}, nog niet bevestigd`;
  return `${label}${where}: ${anomaly.detail} (${ripe})`;
}

export const INSIGHT_SERVER_NAME = "insight";
export const INSIGHT_TOOLS = [`mcp__${INSIGHT_SERVER_NAME}__*`];

export function createInsightServer(store: MemoryStore) {
  const anomalies = tool(
    "anomalies",
    "What JARVIS noticed on his own: sensors that are stuck, readings far from " +
      "what this hour of the week normally looks like, problem sensors that are " +
      "active, and anything wrong with JARVIS himself — a nightly job that did " +
      "not run, a backup that failed, knowledge that stopped arriving. Use this " +
      "for 'is er iets bijzonders', 'valt je iets op', 'is alles normaal thuis' " +
      "and 'werkt alles bij jou nog'. Nothing here has been said out loud yet, " +
      "so treat it as new to the conversation.",
    {
      include: z
        .enum(["established", "all"])
        .default("established")
        .describe(
          "'established' is what has held long enough to be believed; 'all' " +
            "adds conditions that are still forming and may yet turn out to be nothing",
        ),
    },
    async (args) => {
      const db = store.proactiveConnection();
      const counts = store.proactiveCounts();

      // An empty table means one of two very different things. Said the wrong
      // way round it is a reassurance nobody checked.
      if (counts.observations === 0 || counts.baselines === 0) {
        return ok(
          "Ik let nog niet mee op het huis -- er is nog niets waargenomen of " +
            "nog geen beeld van wat normaal is. Ik kan hier dus niets over zeggen.",
        );
      }

      const now = Date.now();
      const open = openAnomalies(db);
      const wanted = args.include === "all" ? open : open.filter((anomaly) => anomaly.ripe);

      if (wanted.length === 0) {
        const forming = open.length - wanted.length;
        return ok(
          forming === 0
            ? "Niets bijzonders. Het huis doet wat het normaal doet."
            : `Niets dat vaststaat. ${forming} ding(en) hou ik nog in de gaten, te kort om iets van te zeggen.`,
        );
      }

      const shown = wanted.slice(0, MAX_SHOWN).map((anomaly) => line(anomaly, now));
      const rest = wanted.length > MAX_SHOWN ? `\n(nog ${wanted.length - MAX_SHOWN} meer)` : "";
      return ok(shown.join("\n") + rest);
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: INSIGHT_SERVER_NAME,
    version: "1.0.0",
    tools: [anomalies],
  });
}
