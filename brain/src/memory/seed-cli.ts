/**
 * Seeds the first few core facts, so a fresh memory is not entirely blank.
 *
 * Only what can be read from the house, plus the owner's name if the deployment
 * has given one, goes in here. Everything else — who belongs to whom, what the
 * household's habits are — JARVIS learns by being told, because a guess written
 * into memory is worse than an empty memory.
 *
 * Safe to run more than once: facts upsert on subject and kind.
 */

import { loadConfig } from "../config.js";
import { memory } from "./store.js";
import { locale } from "@jarvis/shared";

interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = memory(config.memoryPath);

  if (config.haUrl === "" || config.haToken === "") {
    console.error("Home Assistant is not configured; nothing to seed from.");
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${config.haUrl.replace(/\/+$/, "")}/api/states`, {
    headers: { Authorization: `Bearer ${config.haToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    console.error(`Home Assistant returned ${response.status}`);
    process.exitCode = 1;
    return;
  }

  const states = (await response.json()) as HaState[];
  const people = states
    .filter((s) => s.entity_id.startsWith("person."))
    .map((s) => {
      const name = s.attributes["friendly_name"];
      return typeof name === "string" && name !== "" ? name : s.entity_id.split(".")[1]!;
    })
    .sort((a, b) => a.localeCompare(b, locale()));

  if (people.length > 0) {
    store.remember({
      kind: "persoon",
      subject: "bewoners",
      body: `${people.join(" en ")} staan in Home Assistant als bewoners van dit huis.`,
      core: true,
      source: "jarvis",
      reason: "imported",
    });
  }

  // Who the assistant is talking to, if the deployment has said. Without a
  // name this is left out entirely rather than written as "the user": a core
  // fact is in every prompt, and one that says nothing is worse than none.
  const owner = config.owner;
  if (owner !== "") {
    store.remember({
      kind: "persoon",
      subject: owner,
      body: `${owner} is degene die je aanspreekt.`,
      core: true,
      source: "jarvis",
      reason: "imported",
    });
  }

  const counts = store.counts();
  console.log(`seeded; memory now holds ${counts.facts} facts (${counts.core} core)`);
}

await main();
