/**
 * Shared scaffolding for the tests.
 *
 * Tests import from `dist` rather than `src`, because the sources use NodeNext
 * `.js` specifiers that Node's type stripping does not rewrite. So `npm test`
 * builds first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  HistoryPoint,
  HomeCapabilities,
  HomeEntity,
  HomeProvider,
  StatisticMeta,
  StatisticPoint,
} from "@jarvis/shared";

import { MemoryStore } from "../dist/memory/store.js";
import { migrateDev } from "../dist/dev/store.js";
import { migrateProactive } from "../dist/proactive/store.js";

const created: string[] = [];

process.on("exit", () => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  created.push(dir);
  return dir;
}

/** A memory database on disk, thrown away when the process ends. */
export function tempStore(): MemoryStore {
  return new MemoryStore(join(tempDir(), "memory.db"));
}

/** Just the proactive tables, in memory — no facts, no file. */
export function proactiveDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateProactive(db);
  return db;
}

/** Just the self-development table, in memory. */
export function devDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrateDev(db);
  return db;
}

/** Runs a body with the environment set to exactly these variables. */
export function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const before = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(vars)) {
    before.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return body();
  } finally {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Swallows console output for a call that is expected to warn. */
export function quietly<T>(body: () => T): T {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return body();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

/** The same, for a body that must finish before the console comes back. */
export async function quietlyAsync<T>(body: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await body();
  } finally {
    console.warn = warn;
    console.log = log;
  }
}

/** What a fake house is told to contain. Anything unsaid gets a neutral default. */
export interface FakeHomeInput {
  entities?: Array<Partial<HomeEntity> & { id: string }>;
  /** Past states per entity id. Omitted means the house keeps no history. */
  history?: Map<string, HistoryPoint[]>;
  /** What statistics exist. Omitted means the house keeps none. */
  statisticIds?: StatisticMeta[];
  /** Hourly values per statistic id, for whatever window is asked for. */
  statistics?: Map<string, StatisticPoint[]>;
  /** Overrides for the capabilities the input implies. */
  capabilities?: Partial<HomeCapabilities>;
}

/**
 * A house that is exactly what the test says it is.
 *
 * The optional members are present only when the matching capability is, which
 * is the property the core has to cope with: a provider that reports
 * `history: false` does not have a `history` method to call, and code that
 * checks the flag but calls the method anyway fails here rather than in
 * somebody's living room.
 */
export function fakeHome(input: FakeHomeInput = {}): HomeProvider {
  const entities: HomeEntity[] = (input.entities ?? []).map((entity) => ({
    name: entity.id,
    state: "off",
    attributes: {},
    area: null,
    platform: null,
    deviceClass: null,
    disabled: false,
    category: null,
    ...entity,
  }));

  const capabilities: HomeCapabilities = {
    history: input.history !== undefined,
    statistics: input.statisticIds !== undefined || input.statistics !== undefined,
    camera: true,
    calendar: false,
    ...input.capabilities,
  };

  const home: HomeProvider = {
    capabilities,
    connect: async () => {},
    close: () => {},
    listEntities: async () => entities,
    getState: async (id) => entities.find((entity) => entity.id === id) ?? null,
    invoke: async () => {},
    subscribe: async () => {},
    latest: () => null,
  };

  if (capabilities.history) {
    home.history = async (ids) =>
      new Map([...(input.history ?? new Map())].filter(([id]) => ids.includes(id)));
  }

  if (capabilities.statistics) {
    home.statisticIds = async () => input.statisticIds ?? [];
    home.statistics = async (metas) =>
      new Map(
        [...(input.statistics ?? new Map())].filter(([id]) =>
          metas.some((meta) => meta.statisticId === id),
        ),
      );
  }

  if (capabilities.camera) {
    home.cameraStill = (id) => ({
      url: `https://house.invalid/camera/${id}`,
      headers: { Authorization: "Bearer test" },
    });
  }

  return home;
}
