/**
 * What JARVIS watches, and why.
 *
 * This file is the answer to "why is he looking at that". Every group carries
 * its own reason, because a watchlist that is only a list of entity ids becomes
 * unmaintainable the moment someone asks whether something still belongs on it.
 *
 * Nothing is named individually. Entity ids get renamed, replaced and
 * re-integrated often enough that a hand-written list would be wrong within the
 * month; groups are resolved against the registry at startup instead, so a new
 * window sensor joins on its own and a removed one leaves.
 */

import type { HomeEntity, HomeProvider, StatisticMeta } from "@jarvis/shared";

/** An entity as the registry and the state machine together describe it. */
export interface WatchCandidate {
  entityId: string;
  domain: string;
  deviceClass: string | null;
  /** Which integration provides it — the most reliable thing to select on. */
  platform: string | null;
  area: string | null;
}

/** A reason to watch a set of entities through the live state feed. */
export interface StateGroup {
  id: string;
  reason: string;
  matches: (candidate: WatchCandidate) => boolean;
  /**
   * Whether a state counts as the thing happening.
   *
   * The group is the only place that knows. `on` means a door is open and a
   * smoke alarm is going off; for a person it is `home`, and for an air
   * conditioner it is any mode that is not `off`. Everything downstream works
   * in fractions of an hour spent active, and it can only do that because this
   * question is answered here rather than in the rollup.
   */
  active: (state: string) => boolean;
}

/** A reason to watch a set of long-term statistics. */
export interface StatisticGroup {
  id: string;
  reason: string;
  matches: (meta: StatisticMeta) => boolean;
}

/**
 * Integrations kept off the watchlist entirely, whatever they report.
 *
 * Selecting on `device_class` alone is how a house ends up watching a car: a
 * vehicle integration reports doors and windows like any other, and every one of
 * them reads unavailable while the car sleeps, which any rule about a sensor that
 * stopped reporting would find every night. Outdoor cameras are the other usual
 * case -- rain on a lens is motion.
 *
 * Which integrations those are is a property of a house, not of this program, so
 * the list is `JARVIS_WATCH_IGNORE_PLATFORMS`: platform names as the entity
 * registry spells them, comma-separated. Empty means watch everything.
 */
export function ignoredPlatforms(): Set<string> {
  const raw = process.env["JARVIS_WATCH_IGNORE_PLATFORMS"] ?? "";
  return new Set(
    raw
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
  );
}

const isBinary = (c: WatchCandidate, ...classes: string[]) =>
  c.domain === "binary_sensor" && c.deviceClass !== null && classes.includes(c.deviceClass);

/** A binary sensor is doing its thing when it reads `on`, and only then. */
const isOn = (state: string) => state === "on";

/**
 * What the live feed watches.
 *
 * Behaviour, not measurement: things that go on and off, arrive and leave. The
 * numbers come from statistics instead, where an hour is already summarised.
 */
export const STATE_GROUPS: StateGroup[] = [
  {
    id: "motion",
    reason:
      "Where someone is, and at what time of day. The backbone of every behavioural " +
      "baseline — an evening with no movement upstairs is only strange if the usual " +
      "evening has some.",
    matches: (c) => isBinary(c, "motion", "occupancy", "presence"),
    active: isOn,
  },
  {
    id: "openings",
    reason:
      "Doors and windows. A window open at three in the morning in February is worth " +
      "a remark; the same window open on a July afternoon is not, and only a baseline " +
      "over time can tell those apart.",
    matches: (c) => isBinary(c, "door", "window", "garage_door", "opening"),
    active: isOn,
  },
  {
    id: "safety",
    reason:
      "Smoke, and water where it should not be. Rare enough to have no useful baseline, " +
      "which is exactly why they are watched: the rule for these is that they fired at all.",
    matches: (c) => isBinary(c, "smoke", "gas", "moisture", "carbon_monoxide"),
    active: isOn,
  },
  {
    id: "problems",
    reason:
      "The problem-class sensors an integration already maintains. Free signal: " +
      "somebody else decided what counts as wrong, and JARVIS only has to notice it is set.",
    matches: (c) => isBinary(c, "problem"),
    active: isOn,
  },
  {
    id: "presence",
    reason:
      "Who is home. Half the suggestions worth making depend on it, and every rule " +
      "that waits for an empty house needs it.",
    matches: (c) => c.domain === "person" || c.domain === "device_tracker",
    // A named zone is not home: being somewhere else is not being here.
    active: (state) => state === "home",
  },
  {
    id: "climate",
    reason:
      "Heating and cooling, and what they are set to. A unit left running in an " +
      "empty room is the kind of thing nobody notices for a week.",
    matches: (c) => c.domain === "climate",
    // The state of a climate entity is its mode, and every mode but `off` is
    // the unit doing something. `unavailable` is not running.
    active: (state) => state !== "off" && state !== "unavailable" && state !== "unknown",
  },
];

/**
 * What the nightly statistics pass watches.
 *
 * Energy and temperature only. The other unit classes measured here — signal
 * strength, disk space, page counts — describe machines rather than the house,
 * and whatever already watches those machines is a better place for them.
 */
export const STATISTIC_GROUPS: StatisticGroup[] = [
  {
    id: "energy",
    reason:
      "What the house used, per hour. The one number where a deviation reliably means " +
      "something physical happened: an appliance left on, a heater that should not be running.",
    matches: (meta) => meta.unitClass === "energy" && meta.shape === "total",
  },
  {
    id: "temperature",
    reason:
      "Room temperatures. Slow, well-behaved, and strongly patterned by hour and weekday, " +
      "which makes them the best test of whether a baseline is working at all.",
    matches: (meta) => meta.unitClass === "temperature",
  },
];

/** One entity on the watchlist, with the group that put it there. */
export interface WatchedEntity {
  entityId: string;
  group: string;
  area: string | null;
}

/** One statistic on the watchlist, with the group that put it there. */
export interface WatchedStatistic {
  meta: StatisticMeta;
  group: string;
}

export interface Watchlist {
  entities: WatchedEntity[];
  statistics: WatchedStatistic[];
}

/**
 * Turns the groups into the concrete entities and statistics to observe.
 *
 * Reads the registry rather than guessing from entity ids: which integration
 * owns an entity is the difference between a motion sensor on the landing and a
 * camera pointed at the street, and nothing in the entity id says which one it
 * is.
 */
export async function resolveWatchlist(
  home: HomeProvider,
  statistics: StatisticMeta[],
): Promise<Watchlist> {
  const entities: WatchedEntity[] = [];
  const ignored = ignoredPlatforms();

  for (const entity of await home.listEntities()) {
    // Only `config` is dropped, not every categorised entity. Skipping
    // `diagnostic` as well looked reasonable and removed the entire watchlist
    // worth having: problem sensors are diagnostic, and so is every device
    // tracker a phone provides. Diagnostic means "not the primary control for
    // this device", which is exactly what a signal looks like.
    if (entity.disabled || entity.category === "config") continue;
    if (entity.platform !== null && ignored.has(entity.platform)) continue;

    const candidate = candidateOf(entity);
    const group = STATE_GROUPS.find((candidateGroup) => candidateGroup.matches(candidate));
    if (group === undefined) continue;

    entities.push({ entityId: candidate.entityId, group: group.id, area: candidate.area });
  }

  // Statistics are a capability, not a given. A house that keeps none leaves
  // this empty and the numeric half of every baseline simply never fills --
  // which is a JARVIS that notices behaviour but not consumption, rather than
  // one that fails to start.
  const watchedStatistics: WatchedStatistic[] = [];
  for (const meta of statistics) {
    const group = STATISTIC_GROUPS.find((candidateGroup) => candidateGroup.matches(meta));
    if (group !== undefined) watchedStatistics.push({ meta, group: group.id });
  }

  return { entities, statistics: watchedStatistics };
}

/** What the groups select on, out of what the house reports. */
function candidateOf(entity: HomeEntity): WatchCandidate {
  return {
    entityId: entity.id,
    domain: entity.id.split(".")[0] ?? "",
    deviceClass: entity.deviceClass,
    platform: entity.platform,
    area: entity.area,
  };
}

/** How the watchlist reads in a log line or a CLI. */
export function describeWatchlist(watchlist: Watchlist): string {
  const count = (items: Array<{ group: string }>) => {
    const tally = new Map<string, number>();
    for (const item of items) tally.set(item.group, (tally.get(item.group) ?? 0) + 1);
    return [...tally].map(([group, n]) => `${group} ${n}`).join(", ");
  };

  return [
    `watching ${watchlist.entities.length} entities (${count(watchlist.entities)})`,
    `and ${watchlist.statistics.length} statistics (${count(watchlist.statistics)})`,
  ].join(" ");
}
