/**
 * Which statistics are worth asking about.
 *
 * Reading them is the adapter's job -- the two shapes, the chunking and the
 * websocket commands all live with Home Assistant. What stays here is the one
 * question the core has to answer for itself: of everything the house says it
 * keeps, which ids actually carry numbers.
 *
 * The types this works in are part of the house seam and are re-exported for
 * the callers that only ever wanted them from here.
 */

import type { HomeProvider, StatisticMeta } from "@jarvis/shared";

export type { StatisticMeta, StatisticPoint, StatisticShape } from "@jarvis/shared";

/**
 * The statistics that actually carry numbers, checked rather than assumed.
 *
 * Metadata outlives data: a sensor that was excluded from the recorder or an
 * integration that was removed leaves its entry behind, and a baseline built on
 * one of those is a baseline of nothing. A short window is enough and much
 * cheaper than the one a baseline needs -- anything still being recorded
 * produces a value within two days.
 *
 * A house that keeps no statistics at all reports none, which is the same
 * answer as a house whose statistics have all gone quiet, and is handled the
 * same way everywhere downstream.
 */
export async function withData(
  home: HomeProvider,
  metas: StatisticMeta[],
  hours = 48,
): Promise<StatisticMeta[]> {
  if (home.statistics === undefined || metas.length === 0) return [];

  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600_000);
  const series = await home.statistics(metas, start, end);
  return metas.filter((meta) => series.has(meta.statisticId));
}

/** Everything the house keeps statistics on, or nothing when it keeps none. */
export async function listStatistics(home: HomeProvider): Promise<StatisticMeta[]> {
  if (home.statisticIds === undefined) return [];
  return home.statisticIds();
}
