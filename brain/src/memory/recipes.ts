/**
 * What JARVIS has learned about answering his own recurring questions.
 *
 * The house card says which entities exist. It does not say which of two
 * thermometers upstairs answers "hoe warm is het boven", or that a question
 * about the dryer means its power sensor rather than the appliance entity that
 * reports a programme. That knowledge is discovered once per question, and then
 * discovered again next week.
 *
 * Every turn now records which tools it used and with what. This pass reads those
 * back, looks for question patterns that keep resolving to the same call, and
 * writes them down as short recipes that ride along in the system prompt. It runs
 * with the weekly consolidation: a recipe is only worth writing when a pattern has
 * actually repeated, and that takes days, not turns.
 *
 * Recipes are hints, not rules. A recipe that goes stale — an entity renamed, a
 * sensor gone — costs one wrong tool call, which the assistant recovers from the
 * same way it would from any miss. The whole set is replaced on every pass rather
 * than merged, so a pattern that stops recurring stops being suggested.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

import { recordUsage } from "./usage.js";
import { loadConfig, ownerName } from "../config.js";
import type { MemoryStore } from "./store.js";

/** How far back a pass looks. Shorter than that and nothing has repeated yet. */
const WINDOW_DAYS = 21;
/** Most recipes to keep. This rides in every system prompt, so it stays small. */
const MAX_RECIPES = 8;
/** Longest a single recipe may be, in characters. */
const MAX_LENGTH = 160;

const instructions = (owner: string) => `Je krijgt vragen die ${owner} aan de spraakassistent stelde, met de tools die de
assistent gebruikte om ze te beantwoorden. Je zoekt terugkerende patronen: soorten vragen die steeds
op dezelfde tool-aanroep uitkomen.

Een recept is alleen iets waard als het de volgende keer een zoekstap scheelt. Dus:
- alleen patronen die je meer dan één keer ziet
- alleen als de aanroep steeds dezelfde kant op wijst (dezelfde entiteit, dezelfde tool)
- geen recept voor iets dat al vanzelf spreekt uit de huislijst
- geen recept van een eenmalige vraag, hoe interessant ook

Schrijf elk recept als één regel Nederlands: het soort vraag, dan de aanroep.
Bijvoorbeeld: "hoe warm het boven is -> get_state(<de sensor die dat bleek te zijn>)".

Antwoord met JSON en niets anders: een array van objecten met de velden
pattern (het soort vraag, kort) en recipe (wat je dan aanroept, kort).
Zie je geen betrouwbaar patroon, antwoord dan met [].`;

interface Recipe {
  pattern: string;
  recipe: string;
}

function parseRecipes(text: string): Recipe[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Recipe => {
        if (typeof item !== "object" || item === null) return false;
        const value = item as Record<string, unknown>;
        return (
          typeof value["pattern"] === "string" &&
          value["pattern"].trim().length > 2 &&
          typeof value["recipe"] === "string" &&
          value["recipe"].trim().length > 2
        );
      })
      .slice(0, MAX_RECIPES)
      .map((item) => ({
        pattern: item.pattern.slice(0, MAX_LENGTH),
        recipe: item.recipe.slice(0, MAX_LENGTH),
      }));
  } catch {
    return [];
  }
}

/** The learned section of the system prompt, or "" while nothing is learned. */
export function recipesBlock(store: MemoryStore): string {
  const recipes = store.recipes();
  if (recipes.length === 0) return "";
  return [
    "Dit heb je zelf geleerd over hoe je vragen hier het snelst beantwoordt.",
    "Het zijn aanwijzingen, geen regels: klopt er iets niet meer, zoek het dan gewoon op.",
    ...recipes.map((r) => `- ${r.pattern}: ${r.recipe}`),
  ].join("\n");
}

let running = false;

/**
 * Learns recipes from the last few weeks of tool use. Returns how many it kept.
 *
 * Runs on the stronger model: telling a real pattern from two questions that
 * happened to touch the same sensor is the judgement this whole pass is for.
 */
export async function learnRecipes(store: MemoryStore, days = WINDOW_DAYS): Promise<number> {
  if (running) return 0;

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const turns = store.toolTurns(from);
  if (turns.length < 4) {
    console.log(`memory: too little tool use to learn recipes from (${turns.length} turns)`);
    return 0;
  }

  running = true;
  try {
    const listing = turns.map((t) => `Vraag: ${t.asked}\nTools: ${t.tools.join(" | ")}`).join("\n\n");
    const prompt = `Dit is de afgelopen ${days} dagen gevraagd, en dit gebruikte je:\n\n${listing}\n\nWelke recepten haal je hieruit?`;

    let answer = "";
    for await (const message of query({
      prompt,
      options: {
        model: "sonnet",
        systemPrompt: instructions(ownerName(loadConfig())),
        tools: [],
        allowedTools: [],
        settingSources: [],
        maxTurns: 1,
      },
    })) {
      recordUsage(store, message, "recipes");
      const value = message as { type?: string; message?: { content?: unknown } };
      if (value.type !== "assistant") continue;
      const content = value.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = block as { type?: string; text?: string };
        if (b.type === "text" && typeof b.text === "string") answer += b.text;
      }
    }

    const recipes = parseRecipes(answer);
    // Replaced wholesale: a pattern that stopped recurring should stop being
    // suggested, and merging would let an old recipe outlive the house it was
    // learned in.
    store.replaceRecipes(recipes);
    console.log(`memory: learned ${recipes.length} recipes from ${turns.length} turns`);
    return recipes.length;
  } catch (error) {
    console.error("memory: learning recipes failed:", error);
    return 0;
  } finally {
    running = false;
  }
}
