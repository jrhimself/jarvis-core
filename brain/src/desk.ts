/**
 * Standing desk windows on the HUD.
 *
 * Core ships the five subjects of the morning overview. Packs add more through
 * `PackSetup.desk`, and say per slot whether the briefing should cover them.
 * A new pack that only wants a window on the desk leaves `briefing` off.
 */

import type { PackDeskSlot } from "@jarvis/shared";

/** The built-in overview, until packs say otherwise for the same topic. */
export const CORE_DESK: readonly PackDeskSlot[] = [
  { topic: "weather", label: "Weer", briefing: true },
  { topic: "agenda", label: "Agenda", briefing: true },
  { topic: "mail", label: "Mail", briefing: true },
  { topic: "work", label: "Pull requests", briefing: true },
  { topic: "notes", label: "Notities", briefing: true },
];

/**
 * Core defaults first, then pack slots. A pack that redeclares a topic wins
 * (label and briefing flag), so a house can rename "Work" or take notes out of
 * the briefing without editing core.
 */
export function mergeDeskSlots(fromPacks: readonly PackDeskSlot[]): PackDeskSlot[] {
  const byTopic = new Map<string, PackDeskSlot>();
  for (const slot of CORE_DESK) byTopic.set(slot.topic, { ...slot });
  for (const slot of fromPacks) {
    const topic = slot.topic.trim();
    if (topic === "") continue;
    const label = slot.label.trim() || topic;
    byTopic.set(topic, {
      topic,
      label,
      ...(slot.briefing === true ? { briefing: true } : {}),
    });
  }
  return [...byTopic.values()];
}

/** Prompt line naming which desk subjects the morning briefing covers. */
export function deskBriefingBlock(slots: readonly PackDeskSlot[]): string {
  const names = slots.filter((s) => s.briefing === true).map((s) => s.label);
  if (names.length === 0) return "";
  return (
    "Standing desk. These subjects stay on screen between questions. " +
    "The morning briefing covers: " +
    names.join(", ") +
    ". Other desk windows are shown when asked about, not in that round."
  );
}
