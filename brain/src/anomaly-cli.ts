/**
 * Looking at what JARVIS has noticed, and asking him to notice it again.
 *
 * The proactive side runs on timers and writes to tables. Without this there is
 * no way to see what is in them short of opening the database by hand, and no
 * way to try a change to a rule except by waiting an hour to find out.
 *
 * Usage:
 *   node dist/anomaly-cli.js                    what is open right now
 *   node dist/anomaly-cli.js baselines [match]  what the house normally does
 *   node dist/anomaly-cli.js backfill [days]    read the recorder into observations
 *   node dist/anomaly-cli.js build              rebuild the baselines now
 *   node dist/anomaly-cli.js dry-run [hours]    run the rules over the past, writing nothing
 *
 * `dry-run` is the one that earns its keep: it replays real hours through the
 * current rules and prints what they would have said, which is how the two
 * false positives were found in the first place.
 */

import { fileURLToPath } from "node:url";

import type { HomeProvider, StatisticPoint } from "@jarvis/shared";

import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { createHome } from "./home/index.js";
import { memory } from "./memory/store.js";
import { formatLocal } from "@jarvis/shared";
import { buildBaselines } from "./proactive/baselines.js";
import { openAnomalies, reconcile } from "./proactive/detect.js";
import { backfillHistory } from "./proactive/history.js";
import { evaluate, lastCompleteHour } from "./proactive/rules.js";
import type { Finding } from "./proactive/rules.js";
import { listStatistics, withData } from "./proactive/statistics.js";
import type { Watchlist } from "./proactive/watchlist.js";
import { describeWatchlist, resolveWatchlist } from "./proactive/watchlist.js";

const HOUR_MS = 3600_000;

/**
 * `loadConfig` resolves the memory path against the working directory, so a CLI
 * started from anywhere else quietly opens a second, empty database and reports
 * that the house has never done anything.
 */
process.chdir(fileURLToPath(new URL("..", import.meta.url)));

function local(iso: string): string {
  return formatLocal(new Date(iso), { dateStyle: "short", timeStyle: "short" });
}

function held(from: string, to: string): string {
  const hours = (new Date(to).getTime() - new Date(from).getTime()) / HOUR_MS;
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${hours.toFixed(0)}h`;
  return `${(hours / 24).toFixed(1)} days`;
}

interface Live {
  home: HomeProvider;
  watchlist: Watchlist;
  states: Map<string, string>;
}

/** Connects and resolves the watchlist, which every command but `status` needs. */
async function live(config: Config): Promise<Live> {
  const home = createHome(config);
  if (home === null) throw new Error("no house is configured in the environment");
  await home.connect();

  const watchlist = await resolveWatchlist(home, await withData(home, await listStatistics(home)));
  console.log(describeWatchlist(watchlist));

  const entities = await home.listEntities();
  return { home, watchlist, states: new Map(entities.map((entity) => [entity.id, entity.state])) };
}

function status(db: ReturnType<ReturnType<typeof memory>["proactiveConnection"]>): void {
  const counts = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM observations) AS observations,
         (SELECT count(*) FROM baselines) AS baselines,
         (SELECT count(DISTINCT subject) FROM baselines) AS subjects,
         (SELECT min(bucket) FROM observations) AS oldest,
         (SELECT max(built_at) FROM baselines) AS built`,
    )
    .get() as unknown as {
    observations: number;
    baselines: number;
    subjects: number;
    oldest: string | null;
    built: string | null;
  };

  console.log(
    `\n${counts.observations} observations since ${counts.oldest === null ? "never" : local(counts.oldest)}, ` +
      `${counts.baselines} baseline slots over ${counts.subjects} subjects` +
      (counts.built === null ? ", never built" : `, built ${local(counts.built)}`),
  );

  const open = openAnomalies(db);
  const ripe = open.filter((anomaly) => anomaly.ripe);
  console.log(`\n${open.length} open, ${ripe.length} of them established:\n`);
  if (open.length === 0) {
    console.log("  nothing is wrong, which is the point");
    return;
  }

  for (const anomaly of open) {
    console.log(
      `  ${anomaly.ripe ? "*" : " "} ${anomaly.rule.padEnd(9)} ${held(anomaly.firstAt, anomaly.lastAt).padStart(10)}  ` +
        `${anomaly.detail}`,
    );
  }

  const recent = db
    .prepare(
      `SELECT rule, detail, first_at, resolved_at FROM anomalies
       WHERE status = 'resolved' ORDER BY resolved_at DESC LIMIT 8`,
    )
    .all() as unknown as Array<{
    rule: string;
    detail: string;
    first_at: string;
    resolved_at: string;
  }>;
  if (recent.length === 0) return;

  console.log("\nrecently over:");
  for (const row of recent) {
    console.log(`    ${row.rule.padEnd(9)} ${local(row.resolved_at).padStart(16)}  ${row.detail}`);
  }
}

function baselines(
  db: ReturnType<ReturnType<typeof memory>["proactiveConnection"]>,
  match: string | undefined,
): void {
  const rows = db
    .prepare(
      `SELECT subject, shape, weekday, hour, centre, spread, samples FROM baselines
       WHERE subject LIKE ? ORDER BY subject, weekday, hour`,
    )
    .all(`%${match ?? ""}%`) as unknown as Array<{
    subject: string;
    shape: string;
    weekday: number;
    hour: number;
    centre: number;
    spread: number;
    samples: number;
  }>;

  if (rows.length === 0) {
    console.log(`\nno baselines matching ${match ?? "anything"}`);
    return;
  }

  // A subject at a time, one line per weekday, so the shape of a week is
  // visible rather than merely present.
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const bySubject = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = bySubject.get(row.subject);
    if (list === undefined) bySubject.set(row.subject, [row]);
    else list.push(row);
  }

  for (const [subject, slots] of bySubject) {
    const shape = slots[0]?.shape ?? "";
    const samples = Math.max(...slots.map((slot) => slot.samples));
    console.log(`\n${subject}  (${shape}, up to ${samples} samples a slot)`);
    console.log(`      ${Array.from({ length: 24 }, (_, hour) => String(hour).padStart(5)).join("")}`);
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const line = Array.from({ length: 24 }, (_, hour) => {
        const slot = slots.find((row) => row.weekday === weekday && row.hour === hour);
        if (slot === undefined) return "    ·";
        return (shape === "behavioural" ? (slot.centre * 100).toFixed(0) : slot.centre.toFixed(1)).padStart(5);
      }).join("");
      console.log(`  ${days[weekday]} ${line}`);
    }
  }
  if (rows[0]?.shape === "behavioural") console.log("\n(percent of the hour the thing was on)");
}

/** Replays real hours through the current rules without writing anything. */
async function dryRun(
  db: ReturnType<ReturnType<typeof memory>["proactiveConnection"]>,
  { home, watchlist, states }: Live,
  hours: number,
): Promise<void> {
  const last = lastCompleteHour(new Date());
  const first = new Date(last.getTime() - (hours - 1) * HOUR_MS);

  const byHour = new Map<number, Map<string, number>>();
  if (watchlist.statistics.length > 0 && home.statistics !== undefined) {
    const series = await home.statistics(
      watchlist.statistics.map((watched) => watched.meta),
      first,
      new Date(last.getTime() + HOUR_MS),
    );
    for (const [statisticId, points] of series) {
      for (const point of points) {
        const key = point.at.getTime();
        let slot = byHour.get(key);
        if (slot === undefined) {
          slot = new Map();
          byHour.set(key, slot);
        }
        slot.set(statisticId, point.value);
      }
    }
  }

  const seen = new Map<string, { count: number; detail: string; rule: string }>();
  let total = 0;
  for (let i = 0; i < hours; i += 1) {
    const hour = new Date(first.getTime() + i * HOUR_MS);
    const findings: Finding[] = evaluate(db, watchlist, {
      hour,
      states,
      statistics: byHour.get(hour.getTime()) ?? new Map(),
    });
    total += findings.length;
    for (const finding of findings) {
      const before = seen.get(finding.fingerprint);
      seen.set(finding.fingerprint, {
        count: (before?.count ?? 0) + 1,
        detail: finding.detail,
        rule: finding.rule,
      });
    }
  }

  console.log(
    `\n${hours} hours from ${local(first.toISOString())}: ` +
      `${total} findings describing ${seen.size} conditions\n`,
  );
  for (const [fingerprint, entry] of [...seen].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${String(entry.count).padStart(3)}h  ${entry.rule.padEnd(9)} ${fingerprint}`);
    console.log(`        ${entry.detail}`);
  }

  // The rules are pure, so this wrote nothing; say so, because a dry run that
  // quietly was not one is the worst kind of tool.
  console.log("\nnothing was written.");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const argument = process.argv[3];
  const config = loadConfig();
  const store = memory(config.memoryPath);
  const db = store.proactiveConnection();

  let connection: Live | null = null;
  try {
    switch (command) {
      case "status":
        status(db);
        break;

      case "baselines":
        baselines(db, argument);
        break;

      case "backfill": {
        connection = await live(config);
        const days = Number(argument ?? "10");
        const filled = await backfillHistory(
          connection.home,
          db,
          connection.watchlist.entities,
          Number.isFinite(days) ? days : 10,
        );
        console.log(
          `\n${filled.rows} rows written, reaching back to ` +
            `${filled.from === null ? "nowhere" : local(filled.from.toISOString())}`,
        );
        break;
      }

      case "build": {
        connection = await live(config);
        const report = await buildBaselines(connection.home, db, connection.watchlist);
        console.log(
          `\n${report.slots} slots over ${report.behavioural} behaviours and ` +
            `${report.numeric} statistics; ${report.pruned} old observations dropped`,
        );
        break;
      }

      case "dry-run": {
        connection = await live(config);
        const hours = Number(argument ?? "48");
        await dryRun(db, connection, Number.isFinite(hours) ? Math.max(1, hours) : 48);
        break;
      }

      // Deliberately not a command anyone can reach by accident: it writes.
      case "detect": {
        connection = await live(config);
        const hour = lastCompleteHour(new Date());
        const series: Map<string, StatisticPoint[]> =
          (await connection.home.statistics?.(
            connection.watchlist.statistics.map((watched) => watched.meta),
            hour,
            new Date(hour.getTime() + 2 * HOUR_MS),
          )) ?? new Map();
        const statistics = new Map<string, number>();
        for (const [statisticId, points] of series) {
          const point = points.find((candidate) => candidate.at.getTime() === hour.getTime());
          if (point !== undefined) statistics.set(statisticId, point.value);
        }
        const findings = evaluate(db, connection.watchlist, {
          hour,
          states: connection.states,
          statistics,
        });
        const report = reconcile(db, findings, new Date());
        console.log(`\n${JSON.stringify(report)}`);
        break;
      }

      default:
        console.error(`unknown command: ${command}`);
        process.exitCode = 1;
    }
  } finally {
    connection?.home.close();
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error("anomalies:", error);
  process.exitCode = 1;
});
