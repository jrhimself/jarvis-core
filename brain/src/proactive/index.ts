/**
 * The one place the proactive side is switched on.
 *
 * Everything JARVIS does on his own hangs off this function, so that `off`
 * is not a matter of each piece remembering to check a flag. Nothing is
 * imported, no socket is opened and no timer is armed until the mode says so;
 * with the default the service does exactly what it did before any of this
 * existed.
 */

import type { DatabaseSync } from "node:sqlite";

import type { HomeProvider } from "@jarvis/shared";

import type { Config } from "../config.js";
import { proactiveAtLeast } from "../config.js";
import { Telegram } from "../telegram.js";
import { offer } from "./suggest.js";
import { createHome } from "../home/index.js";
import type { MemoryStore } from "../memory/store.js";
import { buildBaselines, untilNextLocal } from "./baselines.js";
import { detect, introspect, untilMinutePastHour } from "./detect.js";
import { backfillHistory } from "./history.js";
import { Rollup } from "./rollup.js";
import { beat } from "./store.js";
import { listStatistics, withData } from "./statistics.js";
import type { Watchlist } from "./watchlist.js";
import { describeWatchlist, resolveWatchlist } from "./watchlist.js";

/**
 * How often the rollup is asked whether a bucket has ended.
 *
 * Shorter than a bucket and not a divisor of it, because nothing here depends
 * on the tick being punctual: a bucket is closed at its own boundary whenever
 * the tick gets round to it, so being a minute late costs a minute of latency
 * and nothing in the numbers.
 */
const TICK_MS = 60_000;

/**
 * When the baselines are rebuilt.
 *
 * Ten to four in the morning: after the small hours have finished being
 * unusual, and before anyone is awake to be told about them. Local time, so it
 * stays at ten to four when the clocks move.
 */
const BUILD_HOUR = 3;
const BUILD_MINUTE = 50;

/**
 * How far past the hour the rules are run.
 *
 * Home Assistant writes an hourly statistic a little after the hour it
 * describes. Asking on the stroke of the hour gets nothing back, which reads
 * exactly like a sensor with nothing to say.
 */
const DETECT_MINUTE = 6;

/**
 * Rebuilds the baselines and says so, without letting a bad night stop the
 * next one. A baseline that fails to build leaves yesterday's in place, which
 * is a day stale rather than absent.
 */
async function build(home: HomeProvider, db: DatabaseSync, watchlist: Watchlist): Promise<void> {
  try {
    const report = await buildBaselines(home, db, watchlist);
    const line =
      `baselines for ${report.behavioural} behaviours and ${report.numeric} statistics, ` +
      `${report.slots} slots, ${report.pruned} old observations dropped`;
    console.log(`proactive: ${line}`);
    beat(db, "baselines", true, line);
  } catch (error) {
    console.error("proactive: could not build baselines:", error);
    beat(db, "baselines", false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Runs the checks JARVIS makes on himself.
 *
 * Deliberately outside `look`, and outside the house entirely: the house pass
 * needs a socket that answers, and an evening when it does not is precisely
 * when this pass has something to say. A deployment with no house at all runs
 * it on the same hour -- the backups, the notes and the memory are still its
 * own to lose.
 *
 * `watchlistSize` is null when there is nothing watching to count, which the
 * checks read as no opinion rather than as a count of zero.
 */
async function checkSelf(
  db: DatabaseSync,
  config: Config,
  watchlistSize: number | null,
): Promise<void> {
  try {
    const report = await introspect(db, config, watchlistSize);
    if (report.opened > 0 || report.resolved > 0) {
      console.log(`proactive: about himself, ${report.opened} opened, ${report.resolved} resolved`);
    }
  } catch (error) {
    console.error("proactive: could not check himself:", error);
  }
}

/**
 * Runs the rules over the hour that just ended.
 *
 * Silent unless something changed. An hour in which the same three conditions
 * still hold is an hour worth no log line at all -- the point of the whole
 * exercise is that a house behaving normally says nothing.
 */
async function look(
  home: HomeProvider,
  db: DatabaseSync,
  watchlist: Watchlist,
  rollup: Rollup | null,
  speak: ((db: DatabaseSync) => Promise<void>) | null,
): Promise<void> {
  if (rollup === null) return;
  try {
    const report = await detect(home, db, watchlist, rollup.snapshot());
    if (report.opened > 0 || report.resolved > 0 || report.suppressed > 0) {
      console.log(
        `proactive: ${report.opened} opened, ${report.resolved} resolved, ` +
          `${report.suppressed} held back, ${report.ripe} standing`,
      );
    }
  } catch (error) {
    console.error("proactive: could not run the rules:", error);
  }

  // Separately, and after: a rule that threw should not cost the findings that
  // were already standing their chance of being asked about.
  if (speak === null) return;
  try {
    await speak(db);
  } catch (error) {
    console.error("proactive: could not offer what was found:", error);
  }
}

/** What one startup produced, once and before any timer is armed. */
export interface Observation {
  watchlist: Watchlist;
  rollup: Rollup;
}

/**
 * Everything that happens once, in the order it has to happen in.
 *
 * Separate from `startProactive` because this is the part that has to survive a
 * house that cannot do very much. A provider without history or statistics runs
 * every line below: `listStatistics` gives nothing, so no numeric baseline is
 * ever asked for, and `backfillHistory` returns no rows rather than throwing.
 * What comes out is a smaller watchlist that is nonetheless a valid one, and an
 * assistant that learns the same things a fortnight later instead of tonight.
 */
export async function beginObserving(
  home: HomeProvider,
  db: DatabaseSync,
  now = Date.now(),
): Promise<Observation> {
  // Resolved at startup rather than read from a file, so a sensor added this
  // morning is watched from the next restart without anyone editing anything.
  // The cost is one pass over the registry and a 48-hour statistics probe, both
  // of which happen while nobody is talking to him yet.
  const statistics = await withData(home, await listStatistics(home));
  const watchlist = await resolveWatchlist(home, statistics);
  console.log(`proactive: ${describeWatchlist(watchlist)}`);

  const rollup = new Rollup(db, watchlist.entities, now);
  await home.subscribe(
    watchlist.entities.map((entity) => entity.entityId),
    (change) => {
      rollup.observe(change, Date.now());
    },
  );

  // The recorder's ten days, read once. Idempotent, so a restart costs a second
  // and writes almost nothing; it is not worth remembering whether it has been
  // done.
  const filled = await backfillHistory(home, db, watchlist.entities);
  console.log(
    `proactive: backfilled ${filled.rows} rows from ${filled.from?.toISOString() ?? "nowhere"}`,
  );

  return { watchlist, rollup };
}

/**
 * Starts whatever the configured mode allows. Returns a function that stops it
 * again, so a shutdown does not have to know what was started.
 */
export function startProactive(config: Config, store: MemoryStore): () => void {
  if (!proactiveAtLeast(config.proactive, "observe")) return () => {};

  let rollup: Rollup | null = null;
  let nightly: NodeJS.Timeout | null = null;
  let hourly: NodeJS.Timeout | null = null;
  // Asking needs somewhere to send: Telegram, the House Ops webhook, or both.
  // Without either, everything below still runs and writes its findings down;
  // what stops is the asking. The listening half is not started here: one
  // poller per token, and the token has two users.
  const canSuggest = proactiveAtLeast(config.proactive, "suggest");
  const canTelegram =
    canSuggest && config.suggestToken !== "" && config.suggestChat !== "";
  const canWebhook = canSuggest && (config.houseOpsWebhookUrl ?? "") !== "";
  const bot = canTelegram ? new Telegram(config.suggestToken) : null;

  const speak =
    !canTelegram && !canWebhook
      ? null
      : async (db: DatabaseSync): Promise<void> => {
          const said = await offer(db, bot, config);
          if (said.offered > 0 || said.held > 0) {
            console.log(`proactive: ${said.offered} offered, ${said.held} kept back`);
          }
        };

  const home = createHome(config, {
    down: () => rollup?.pause(Date.now()),
    up: () => rollup?.resume(Date.now()),
  });

  // Watching needs something to watch, so a deployment with no house loses the
  // house pass entirely. What it does not lose is the pass JARVIS makes over
  // himself: the backups, the notes, the memory and the machine are his to lose
  // whether or not anything in the building talks to him, and a houseless
  // install that silently stopped backing itself up is exactly the failure
  // these checks exist for.
  if (home === null) {
    console.warn("proactive: no house is configured, nothing will be observed");

    const db = store.proactiveConnection();
    void checkSelf(db, config, null);

    const selfAgain = (): void => {
      hourly = setTimeout(() => {
        void checkSelf(db, config, null).finally(selfAgain);
      }, untilMinutePastHour(DETECT_MINUTE));
      hourly.unref();
    };
    selfAgain();

    console.log(`proactive: ${config.proactive}, himself only`);
    return () => {
      if (hourly !== null) clearTimeout(hourly);
    };
  }

  const tick = setInterval(() => {
    try {
      rollup?.advanceTo(Date.now());
    } catch (error) {
      console.error("proactive: could not close a bucket:", error);
    }
  }, TICK_MS);
  tick.unref();

  void (async () => {
    await home.connect();

    const db = store.proactiveConnection();

    const observation = await beginObserving(home, db);
    const watchlist = observation.watchlist;
    rollup = observation.rollup;

    // Once now, so a fresh process is not blind until four in the morning.
    await build(home, db, watchlist);

    const buildAgain = (): void => {
      nightly = setTimeout(() => {
        void build(home, db, watchlist).finally(buildAgain);
      }, untilNextLocal(BUILD_HOUR, BUILD_MINUTE));
      nightly.unref();
    };
    buildAgain();

    const watchlistSize = watchlist.entities.length + watchlist.statistics.length;

    // Once at startup as well as hourly: a process that has just come up after
    // a night of being down is the most likely moment for a job to be overdue.
    await checkSelf(db, config, watchlistSize);

    const detectAgain = (): void => {
      hourly = setTimeout(() => {
        void look(home, db, watchlist, rollup, speak)
          .then(() => checkSelf(db, config, watchlistSize))
          .finally(detectAgain);
      }, untilMinutePastHour(DETECT_MINUTE));
      hourly.unref();
    };
    detectAgain();
  })().catch((error: unknown) => {
    console.error("proactive: could not start observing:", error);
  });

  console.log(`proactive: ${config.proactive}`);

  return () => {
    clearInterval(tick);
    if (nightly !== null) clearTimeout(nightly);
    if (hourly !== null) clearTimeout(hourly);
    try {
      // Whatever the current bucket has is worth keeping; the next process adds
      // to the same row rather than replacing it.
      rollup?.flush(Date.now());
    } catch (error) {
      console.error("proactive: could not write the last bucket:", error);
    }
    home.close();
  };
}
