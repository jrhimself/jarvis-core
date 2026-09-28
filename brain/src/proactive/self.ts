/**
 * The rules JARVIS runs over himself.
 *
 * Everything else in this directory watches the house. Nothing watched the
 * watcher: a nightly ingest that stopped running, a memory database that lost
 * half its facts, a socket that quietly closed -- all of them are invisible
 * from inside, because the symptom of a machine that has stopped noticing is
 * that it does not notice.
 *
 * Two families, deliberately generic rather than one check per worry:
 *
 *   heartbeat  a scheduled job that has not reported in on time, or whose last
 *              run failed. Every job stamps `heartbeats`; adding a job to
 *              `JOBS` is all it takes to have its absence noticed.
 *   invariant  something about JARVIS's own state that should hold and does
 *              not -- a count that fell, a unit that failed, a working copy
 *              that drifted from what was deployed.
 *
 * The split between `inspect` and `judge` is the same one the house rules make:
 * gathering touches the disk, the database and systemd and may fail at any
 * point, and judging is a pure function of what came back. A reading that could
 * not be taken is `null`, and every check treats `null` as no opinion. Silence
 * about something unmeasurable beats a finding that means "I could not look".
 */

import { execFile } from "node:child_process";
import { readdirSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

import { timeZone, usingHostZone } from "@jarvis/shared";

import type { Config } from "../config.js";
import { homeConfigured } from "../home/index.js";
import type { Finding } from "./rules.js";
import type { Heartbeat } from "./store.js";
import { heartbeats, metricAt, recordMetric } from "./store.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How far ahead an expiring credential is mentioned.
 *
 * A month is enough to renew anything by hand at a convenient moment, and short
 * enough that the warning is not something to learn to ignore for a year.
 */
const EXPIRY_WARN_DAYS = 30;

/** The group every finding about JARVIS himself is filed under. */
export const SELF_GROUP = "jarvis";

/** What systemd says about one timer. */
export interface TimerState {
  /** Whether the unit file is on this machine at all. */
  installed: boolean;
  /** Whether somebody decided this machine should run it. */
  enabled: boolean;
  /** Whether systemd will actually fire it. */
  armed: boolean;
}

/** A job that runs on a schedule and stamps `heartbeats` when it does. */
export interface Job {
  name: string;
  everyMs: number;
  what: string;
  /** The systemd timer that drives it, which is also how we know it is wanted. */
  timer: string;
  /**
   * Whether it only runs where there is a house.
   *
   * A job driven by a timer needs no such flag: an unenabled timer already says
   * this machine does not want it. The baselines are armed in-process instead,
   * so nothing but this would stop a houseless deployment reporting a nightly
   * rebuild that was never going to happen.
   */
  needsHouse?: boolean;
}

/**
 * What is expected to run, and how often.
 *
 * The interval is the schedule, not the tolerance -- see `LATE_FACTOR`. A job
 * missing from this list is not watched, so this is the list to add to rather
 * than a new check to write.
 */
export const JOBS: Job[] = [
  {
    name: "corpus",
    everyMs: DAY_MS,
    what: "the nightly pass over the owner's own notes",
    timer: "jarvis-corpus.timer",
  },
  {
    name: "backup",
    everyMs: DAY_MS,
    what: "the nightly copy of the memory database",
    timer: "jarvis-backup.timer",
  },
  {
    name: "baselines",
    everyMs: DAY_MS,
    what: "the nightly rebuild of the baselines",
    // Armed in this process rather than by a unit, so there is no timer to read
    // an intention off: it is expected wherever the proactive side is on and
    // there is a house to build baselines from.
    timer: "",
    needsHouse: true,
  },
  {
    name: "consolidate",
    everyMs: 7 * DAY_MS,
    what: "the weekly consolidation of memory",
    timer: "jarvis-consolidate.timer",
  },
];

/** The jobs a deployment with, or without, a house is expected to run. */
export function expectedJobs(hasHouse: boolean): Job[] {
  return hasHouse ? JOBS : JOBS.filter((job) => job.needsHouse !== true);
}

/**
 * How far past its schedule a job may be before it is called late.
 *
 * Half an interval, because the timers carry up to ten minutes of jitter and a
 * daily job that ran at four and then at five past four should not be a
 * finding. It does mean a daily job is silent for a day and a half before
 * anyone hears about it, which is the right trade for something that has never
 * been urgent within the hour.
 */
export const LATE_FACTOR = 1.5;

/**
 * The units this repository ships a timer for.
 *
 * Not a list of what must be running: `install-units.sh` deliberately enables
 * nothing, because which of these a machine should run is a decision. What is
 * checked is narrower and means something -- a timer that was installed and
 * enabled and has nevertheless stopped being armed. A machine that never
 * enabled the corpus timer has not got a fault; it has not got a corpus.
 */
export const SHIPPED_TIMERS = [
  "jarvis-corpus.timer",
  "jarvis-backup.timer",
  "jarvis-consolidate.timer",
  "jarvis-cert-renew.timer",
];

/**
 * How stale the newest observation may be before the feed counts as dead.
 *
 * A bucket is five minutes and is written when it closes, so fifteen minutes is
 * two missed closes: long enough that a slow tick or a restart is not a
 * finding, short enough that an evening of silence is not mistaken for a quiet
 * house. This is the check that would have caught the outage where the engine
 * logged that it had started and then never connected.
 */
export const OBSERVATION_STALE_MS = 15 * MINUTE_MS;

/** How long the notes may go without a single edit before the transfer is suspect. */
export const NOTES_STALE_MS = 7 * DAY_MS;

/** The share of a count that may disappear in a day before it is worth asking about. */
export const SHRINK_TOLERANCE = 0.1;

/** How full the disk may get. Below this, growth is not news. */
export const DISK_FULL = 0.85;

/** Resident memory beyond which the process is assumed to be leaking. */
export const RSS_LIMIT_BYTES = 1_600 * 1024 * 1024;

/** Restarts within a day that make a service a crash loop rather than a deploy. */
export const RESTARTS_PER_DAY = 3;

/** Counts compared against their own past, and how they are spoken about. */
const TRACKED = [
  { key: "facts", metric: "memory.facts", what: "facts in memory" },
  { key: "corpusFiles", metric: "memory.corpus_files", what: "notes ingested" },
  { key: "watchlist", metric: "proactive.watchlist", what: "entities watched" },
] as const;

type TrackedKey = (typeof TRACKED)[number]["key"];

/** Everything the self checks look at, with `null` for anything unreadable. */
export interface SelfReading {
  heartbeats: Map<string, Heartbeat>;
  jobs: Job[];
  /** How long this installation has been running, for judging what it has not yet done. */
  since: Date | null;
  /** Newest closed observation bucket, or null when nothing has been recorded. */
  newestObservation: Date | null;
  /** Newest modification time across the corpus directory. */
  newestNote: Date | null;
  counts: Record<TrackedKey, number | null>;
  /** The same counts a day ago, from `self_metrics`. */
  before: Record<TrackedKey, number | null>;
  /** Fraction of the disk holding the database that is in use. */
  diskUsed: number | null;
  rssBytes: number | null;
  /** Cumulative restarts of the brain unit, and what it was a day ago. */
  restarts: number | null;
  restartsBefore: number | null;
  /** Units systemd reports as failed. Empty is healthy, null is unknown. */
  failedUnits: string[] | null;
  /**
   * Every shipped timer, as this machine has it. Null when systemd would not say.
   *
   * A finding comes from the combination, never from the list: enabled and not
   * armed is broken, not enabled is a choice.
   */
  timers: Map<string, TimerState> | null;
  /** Whether the deployed working copy is clean and matches what was pushed. */
  git: { dirty: boolean; synced: boolean } | null;
  /** Configuration that should be set and is empty. */
  missingConfig: string[];
  /**
   * The zone every local hour is worked out in, and where it came from.
   *
   * Not a fault in itself -- a machine genuinely in UTC is entitled to say so.
   * It is a finding only when nothing named a zone *and* the machine answered
   * UTC, because that is overwhelmingly a container's default rather than a
   * decision, and a baseline built on it is quietly about the wrong hours.
   */
  timeZone: { zone: string; fromHost: boolean };
  /** Every credential with a written-down end, from `JARVIS_CREDENTIAL_EXPIRY`. */
  expiries: Expiry[];
}

/** One credential and the day it stops working; `null` when the date did not parse. */
export interface Expiry {
  name: string;
  /** Midnight UTC of the day it expires, or null for text that is not a date. */
  date: Date | null;
  /** What was written, for a finding about a typo. */
  raw: string;
}

/**
 * Reads `name=YYYY-MM-DD,name=YYYY-MM-DD`.
 *
 * An entry without a name is dropped; an entry with a name and a bad date is
 * kept with `date: null`, because the whole point of the setting is a warning,
 * and a typo that silently removes the warning is the one failure it must not
 * have.
 */
export function parseExpiries(raw: string): Expiry[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const at = part.indexOf("=");
      const name = (at === -1 ? part : part.slice(0, at)).trim();
      const value = at === -1 ? "" : part.slice(at + 1).trim();
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      let date: Date | null = null;
      if (match !== null) {
        const [, y, m, d] = match.map(Number) as [number, number, number, number];
        const candidate = new Date(Date.UTC(y, m - 1, d));
        // Date.UTC rolls 2027-02-31 over into March; that is a typo, not a date.
        if (candidate.getUTCMonth() === m - 1 && candidate.getUTCDate() === d) date = candidate;
      }
      return { name, date, raw: value };
    })
    .filter((expiry) => expiry.name !== "");
}

/** Calendar days from today until `date`, both in UTC; negative once it has passed. */
function daysUntil(date: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((date.getTime() - today) / DAY_MS);
}

function finding(input: {
  fingerprint: string;
  rule: "heartbeat" | "invariant";
  subject: string;
  detail: string;
  observed?: number | null;
  expected?: number | null;
}): Finding {
  return {
    fingerprint: input.fingerprint,
    rule: input.rule,
    subject: input.subject,
    watchGroup: SELF_GROUP,
    area: null,
    observed: input.observed ?? null,
    expected: input.expected ?? null,
    deviation: null,
    detail: input.detail,
  };
}

/** Whole hours, for a sentence that reads like a person wrote it. */
function hoursAgo(then: Date, now: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / HOUR_MS);
}

/**
 * Whether this machine is expecting a job at all.
 *
 * Two ways to be expected, and either is enough. Its timer is enabled, so
 * somebody decided it should run; or it has reported at least once, so it
 * evidently does run however it is being driven. A machine with no corpus and
 * no corpus timer is not missing a nightly pass -- it has not got notes, which
 * is an ordinary way to run this.
 *
 * When systemd will not say anything at all, every job counts as wanted: that
 * is the old behaviour, and losing a real warning is worse than one that is
 * merely unwanted.
 */
function wanted(job: Job, reading: SelfReading): boolean {
  if (reading.heartbeats.has(job.name)) return true;
  if (job.timer === "") return true;
  if (reading.timers === null) return true;

  const state = reading.timers.get(job.timer);
  return state === undefined || state.enabled;
}

/**
 * Jobs that are late, failed, or have never once reported.
 *
 * A job that has never reported is only a finding if this database is old
 * enough to have seen one: a fresh install would otherwise open four findings
 * on its first hour, and a rule that fires on a clean install is a rule people
 * learn to ignore.
 */
function jobs(reading: SelfReading, now: Date): Finding[] {
  const found: Finding[] = [];
  const since = reading.since;

  for (const job of reading.jobs) {
    if (!wanted(job, reading)) continue;
    const beat = reading.heartbeats.get(job.name);
    const allowed = job.everyMs * LATE_FACTOR;

    if (beat === undefined) {
      const running = since === null ? 0 : now.getTime() - since.getTime();
      if (running < allowed) continue;
      found.push(
        finding({
          fingerprint: `heartbeat:${job.name}`,
          rule: "heartbeat",
          subject: job.name,
          detail: `${job.what} has never reported having run`,
          expected: job.everyMs / HOUR_MS,
        }),
      );
      continue;
    }

    const okAt = beat.okAt === null ? null : new Date(beat.okAt);
    const late = okAt === null || now.getTime() - okAt.getTime() > allowed;
    if (!late && beat.ok) continue;

    const when =
      okAt === null ? "never worked" : `last worked ${hoursAgo(okAt, now)} hours ago`;
    const why = beat.ok ? "" : `; its last run failed: ${beat.detail}`;
    found.push(
      finding({
        fingerprint: `heartbeat:${job.name}`,
        rule: "heartbeat",
        subject: job.name,
        detail: `${job.what} ${when}${why}`,
        observed: okAt === null ? null : hoursAgo(okAt, now),
        expected: job.everyMs / HOUR_MS,
      }),
    );
  }

  return found;
}

/** A count that lost more than it is allowed to in a day. */
function shrinkage(reading: SelfReading, tracked: (typeof TRACKED)[number]): Finding | null {
  const now = reading.counts[tracked.key];
  const before = reading.before[tracked.key];
  if (now === null || before === null || before === 0) return null;

  const lost = (before - now) / before;
  if (lost <= SHRINK_TOLERANCE) return null;

  return finding({
    fingerprint: `invariant:shrink:${tracked.key}`,
    rule: "invariant",
    subject: tracked.metric,
    detail:
      `${tracked.what} went from ${before} to ${now} in a day, ` +
      `a drop of ${Math.round(lost * 100)} per cent`,
    observed: now,
    expected: before,
  });
}

/** Everything JARVIS asserts about himself, over one hour. Pure. */
export function judge(reading: SelfReading, now: Date): Finding[] {
  const found: Finding[] = [...jobs(reading, now)];

  for (const tracked of TRACKED) {
    const shrank = shrinkage(reading, tracked);
    if (shrank !== null) found.push(shrank);
  }

  if (
    reading.newestObservation !== null &&
    now.getTime() - reading.newestObservation.getTime() > OBSERVATION_STALE_MS
  ) {
    const minutes = Math.floor(
      (now.getTime() - reading.newestObservation.getTime()) / MINUTE_MS,
    );
    found.push(
      finding({
        fingerprint: "invariant:observations",
        rule: "invariant",
        subject: "proactive.observations",
        detail: `nothing has been recorded about the house for ${minutes} minutes`,
        observed: minutes,
        expected: OBSERVATION_STALE_MS / MINUTE_MS,
      }),
    );
  }

  if (
    reading.newestNote !== null &&
    now.getTime() - reading.newestNote.getTime() > NOTES_STALE_MS
  ) {
    const days = Math.floor((now.getTime() - reading.newestNote.getTime()) / DAY_MS);
    found.push(
      finding({
        fingerprint: "invariant:notes",
        rule: "invariant",
        subject: "memory.corpus",
        detail: `no note has changed in ${days} days, so the copy may have stopped arriving`,
        observed: days,
        expected: NOTES_STALE_MS / DAY_MS,
      }),
    );
  }

  if (reading.diskUsed !== null && reading.diskUsed > DISK_FULL) {
    found.push(
      finding({
        fingerprint: "invariant:disk",
        rule: "invariant",
        subject: "host.disk",
        detail: `the disk is ${Math.round(reading.diskUsed * 100)} per cent full`,
        observed: Math.round(reading.diskUsed * 100),
        expected: Math.round(DISK_FULL * 100),
      }),
    );
  }

  if (reading.rssBytes !== null && reading.rssBytes > RSS_LIMIT_BYTES) {
    const mb = Math.round(reading.rssBytes / (1024 * 1024));
    found.push(
      finding({
        fingerprint: "invariant:rss",
        rule: "invariant",
        subject: "host.memory",
        detail: `the brain is holding ${mb} MB of memory`,
        observed: mb,
        expected: Math.round(RSS_LIMIT_BYTES / (1024 * 1024)),
      }),
    );
  }

  if (reading.restarts !== null && reading.restartsBefore !== null) {
    const extra = reading.restarts - reading.restartsBefore;
    if (extra > RESTARTS_PER_DAY) {
      found.push(
        finding({
          fingerprint: "invariant:restarts",
          rule: "invariant",
          subject: "host.brain",
          detail: `the brain restarted ${extra} times in a day`,
          observed: extra,
          expected: RESTARTS_PER_DAY,
        }),
      );
    }
  }

  if (reading.failedUnits !== null && reading.failedUnits.length > 0) {
    found.push(
      finding({
        fingerprint: "invariant:units",
        rule: "invariant",
        subject: "host.units",
        detail: `systemd reports ${reading.failedUnits.join(", ")} as failed`,
        observed: reading.failedUnits.length,
        expected: 0,
      }),
    );
  }

  // Enabled and not armed: somebody meant this to run and it will not. A timer
  // this machine never enabled is not mentioned, because not running it is an
  // answer and a rule that fires on a clean install is a rule people learn to
  // ignore.
  const broken =
    reading.timers === null
      ? []
      : [...reading.timers]
          .filter(([, state]) => state.installed && state.enabled && !state.armed)
          .map(([timer]) => timer);

  if (broken.length > 0) {
    found.push(
      finding({
        fingerprint: "invariant:timers",
        rule: "invariant",
        subject: "host.timers",
        detail: `${broken.join(", ")} is enabled but not armed, so what it runs will not run`,
        observed: broken.length,
        expected: 0,
      }),
    );
  }

  if (reading.git !== null && (reading.git.dirty || !reading.git.synced)) {
    const what = reading.git.dirty
      ? "the deployed working copy has uncommitted changes"
      : "the deployed commit is not the one that was pushed";
    found.push(
      finding({
        fingerprint: "invariant:git",
        rule: "invariant",
        subject: "host.deploy",
        detail: `${what}, so what is running is not what the repository says`,
      }),
    );
  }

  if (reading.timeZone.fromHost && reading.timeZone.zone === "UTC") {
    found.push(
      finding({
        fingerprint: "invariant:timezone",
        rule: "invariant",
        subject: "host.timezone",
        detail:
          "nothing named a time zone and this machine answers UTC, so every weekday " +
          "and hour is being reasoned about in UTC — set JARVIS_TIMEZONE, or set it " +
          "to UTC to say that is deliberate",
      }),
    );
  }

  for (const expiry of reading.expiries) {
    const fingerprint = `invariant:expiry:${expiry.name}`;
    if (expiry.date === null) {
      found.push(
        finding({
          fingerprint,
          rule: "invariant",
          subject: "host.credentials",
          detail:
            `the expiry of ${expiry.name} is written as "${expiry.raw}", which is not a ` +
            "YYYY-MM-DD date, so nothing will warn before it runs out",
        }),
      );
      continue;
    }
    const days = daysUntil(expiry.date, now);
    if (days > EXPIRY_WARN_DAYS) continue;
    const day = expiry.date.toISOString().slice(0, 10);
    found.push(
      finding({
        fingerprint,
        rule: "invariant",
        subject: "host.credentials",
        detail:
          days < 0
            ? `${expiry.name} expired on ${day}, ${-days} days ago; whatever depends on it has stopped working`
            : `${expiry.name} expires on ${day}, in ${days} days; renew it and update JARVIS_CREDENTIAL_EXPIRY`,
        observed: days,
        expected: EXPIRY_WARN_DAYS,
      }),
    );
  }

  if (reading.missingConfig.length > 0) {
    found.push(
      finding({
        fingerprint: "invariant:config",
        rule: "invariant",
        subject: "host.config",
        detail:
          `${reading.missingConfig.join(", ")} is not set, while the rest of that ` +
          "pair is — so something was half configured",
        observed: reading.missingConfig.length,
        expected: 0,
      }),
    );
  }

  return found;
}

const exec = promisify(execFile);

/**
 * Runs a command and returns its output, or null if anything at all goes wrong.
 *
 * Null rather than a thrown error because every caller means "if this can be
 * read, read it": `systemctl` does not exist in the test environment and git
 * does not exist in a tarball deploy, and neither absence is a finding.
 */
async function ask(command: string, args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await exec(command, args, { timeout: 5_000, cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The newest modification time anywhere under a directory. */
function newestUnder(dir: string): Date | null {
  let newest = 0;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const at = statSync(full).mtimeMs;
      if (at > newest) newest = at;
    }
  };

  try {
    walk(dir);
  } catch {
    return null;
  }
  return newest === 0 ? null : new Date(newest);
}

function count(db: DatabaseSync, sql: string): number | null {
  try {
    return Number((db.prepare(sql).get() as unknown as { n: number }).n);
  } catch {
    return null;
  }
}

/**
 * The state of every timer this repository ships, as this machine has it.
 *
 * Three answers, and the distinction is the whole point. `enabled` says somebody
 * decided this machine should run it; `armed` says systemd currently will.
 * A timer that is enabled but not armed is a fault. One that was never enabled
 * is a decision, and silence is the correct response to a decision.
 */
async function timerStates(): Promise<Map<string, TimerState> | null> {
  const states = new Map<string, TimerState>();

  for (const timer of SHIPPED_TIMERS) {
    const read = await ask("systemctl", [
      "show",
      timer,
      "-p",
      "ActiveState",
      "-p",
      "UnitFileState",
      "-p",
      "LoadState",
      "--value",
    ]);
    if (read === null) return null;

    const [active = "", unitFile = "", load = ""] = read.split("\n").map((line) => line.trim());
    states.set(timer, {
      // A unit systemd does not know about is not installed, whatever else it says.
      installed: load !== "not-found" && load !== "",
      enabled: unitFile === "enabled" || unitFile === "enabled-runtime" || unitFile === "static",
      armed: active === "active",
    });
  }
  return states;
}

async function deployState(cwd: string): Promise<{ dirty: boolean; synced: boolean } | null> {
  const dirty = await ask("git", ["status", "--porcelain", "--untracked-files=no"], cwd);
  if (dirty === null) return null;

  const head = await ask("git", ["rev-parse", "HEAD"], cwd);
  const pushed = await ask("git", ["rev-parse", "origin/main"], cwd);

  return {
    dirty: dirty !== "",
    // Unknown counts as synced: a checkout without a remote is a development
    // copy, not a deploy that drifted.
    synced: head === null || pushed === null || head === pushed,
  };
}

/**
 * Configuration that is half-done, which is different from configuration that
 * is absent.
 *
 * Nothing here is required to start, and the README says so: no house and no
 * voice are both working deployments that simply offer less. What is a fault is
 * a pair where one half was set and the other was not -- a URL with no token
 * reads as somebody who meant to have a house and does not, and that is worth
 * saying out loud rather than discovering when a tool call fails.
 */
function missingConfig(config: Config): string[] {
  const pairs: Array<[string, string, string, string]> = [
    ["HA_URL", config.haUrl, "HA_TOKEN", config.haToken],
    ["ELEVENLABS_API_KEY", config.elevenLabsKey, "JARVIS_VOICE_ID", config.voiceId],
    ["JARVIS_GITHUB_REPO", config.devGitHubRepo, "GITHUB_TOKEN_JARVIS", config.devGitHubToken],
  ];

  const half: string[] = [];
  for (const [leftName, left, rightName, right] of pairs) {
    if (left !== "" && right === "") half.push(rightName);
    if (right !== "" && left === "") half.push(leftName);
  }
  return half;
}

/**
 * Takes every reading, writes the ones worth a history, and returns the lot.
 *
 * The metrics are written here rather than by whatever changes them, because a
 * count is compared against its own past and the past has to be recorded by
 * something that runs on a clock. An hourly sample and fourteen days of
 * retention is a few thousand rows.
 */
export async function inspect(
  db: DatabaseSync,
  config: Config,
  watchlistSize: number | null,
  now = new Date(),
): Promise<SelfReading> {
  const bucket = db
    .prepare("SELECT MAX(bucket) AS at, MIN(bucket) AS oldest FROM observations")
    .get() as unknown as { at: string | null; oldest: string | null } | undefined;

  // How long this has been running, from the two things that record time
  // passing. The observations are the older of the two on a house, and on a
  // deployment with none there are never any -- which would leave every job
  // permanently too young to be called late. The metrics below tick hourly
  // regardless; they are pruned to a window wider than the most generous
  // tolerance any job has, so a job that never ran is still noticed.
  const metric = db.prepare("SELECT MIN(at) AS oldest FROM self_metrics").get() as unknown as
    | { oldest: string | null }
    | undefined;
  const started = [bucket?.oldest, metric?.oldest]
    .filter((value): value is string => value != null)
    .sort();

  const facts = count(db, "SELECT count(*) AS n FROM facts");
  const corpusFiles = count(db, "SELECT count(*) AS n FROM corpus_files");

  let diskUsed: number | null = null;
  try {
    const fs = statfsSync(config.memoryPath);
    const total = Number(fs.blocks);
    diskUsed = total === 0 ? null : 1 - Number(fs.bavail) / total;
  } catch {
    diskUsed = null;
  }

  const restartsRaw = await ask("systemctl", [
    "show",
    "jarvis-brain.service",
    "-p",
    "NRestarts",
    "--value",
  ]);
  const restarts = restartsRaw === null || restartsRaw === "" ? null : Number(restartsRaw);

  const failedRaw = await ask("systemctl", [
    "list-units",
    "--failed",
    "--plain",
    "--no-legend",
    "--no-pager",
  ]);
  const failedUnits =
    failedRaw === null
      ? null
      : failedRaw
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[0] ?? "")
          .filter((unit) => unit !== "");

  const rssBytes = process.memoryUsage.rss();

  const counts: Record<TrackedKey, number | null> = {
    facts,
    corpusFiles,
    watchlist: watchlistSize,
  };

  const yesterday = new Date(now.getTime() - DAY_MS);
  const before: Record<TrackedKey, number | null> = {
    facts: null,
    corpusFiles: null,
    watchlist: null,
  };

  for (const tracked of TRACKED) {
    before[tracked.key] = metricAt(db, tracked.metric, yesterday);
    const value = counts[tracked.key];
    if (value !== null) recordMetric(db, tracked.metric, value, now);
  }

  const restartsBefore = metricAt(db, "host.restarts", yesterday);
  if (restarts !== null) recordMetric(db, "host.restarts", restarts, now);
  recordMetric(db, "host.rss_mb", Math.round(rssBytes / (1024 * 1024)), now);

  return {
    heartbeats: heartbeats(db),
    jobs: expectedJobs(homeConfigured(config)),
    since: started[0] === undefined ? null : new Date(started[0]),
    newestObservation: bucket?.at == null ? null : new Date(bucket.at),
    newestNote: newestUnder(config.corpusDir),
    counts,
    before,
    diskUsed,
    rssBytes,
    restarts,
    restartsBefore,
    failedUnits,
    timers: await timerStates(),
    git: await deployState(process.cwd()),
    missingConfig: missingConfig(config),
    timeZone: { zone: timeZone(), fromHost: usingHostZone() },
    // Partial configs exist in tests and older callers; no setting is no check.
    expiries: parseExpiries(config.credentialExpiry ?? ""),
  };
}
