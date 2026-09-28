/**
 * What the runners are doing, for the screen.
 *
 * The health panel used to be the only place a runner showed up, as one line
 * that said how many slots were free. That line was measured when the page
 * connected and never again, so two jobs could start and the panel would go on
 * saying every slot was idle. The owner looked at "3 of 3 slots free" while two
 * runners were writing code, and had no way to tell from the screen that
 * anything was running at all -- let alone what.
 *
 * The board is one row per delegation slot: whether the far side says it is
 * busy, which job this process handed it, and what the last look at its screen
 * made of it. It is rebuilt whenever one of those can have changed -- a job
 * handed on, dropped or ended, a runner's report judged -- and on a clock for
 * everything else, and every open page hears the new one.
 *
 * Module state, like the plan pill in `plan.ts`: there is one set of slots per
 * process, and the pages come and go.
 */

import type { DatabaseSync } from "node:sqlite";

import type { Delegate, RunnerBoard, RunnerRow } from "@jarvis/shared";

import { delegatedDevTasks, type DevTask } from "./store.js";

/** What the last judged screen of a slot meant, and when it was judged. */
export interface RunnerNote {
  state: "working" | "asking" | "done";
  /** The question or the summary; absent while it is simply working. */
  text?: string;
  /** Epoch milliseconds. */
  at: number;
}

const notes = new Map<number, RunnerNote>();

/** Remembers what a runner's screen was judged to mean. */
export function noteRunner(slot: number, note: RunnerNote): void {
  notes.set(slot, note);
  refreshBoard();
}

/** Forgets a slot's note once its job is over, so the next job starts blank. */
export function forgetRunner(slot: number): void {
  notes.delete(slot);
}

/**
 * The topic of a job, short enough for one line.
 *
 * A gap's name is the ability being learned and says it best
 * ("search-the-full-mail-history-beyond" reads as a subject once the dashes go);
 * a job the owner asked for has only its instruction, whose first line is the
 * request itself.
 */
export function topicOf(task: Pick<DevTask, "gap" | "instruction">): string {
  if (task.gap !== null && task.gap !== undefined && task.gap.trim() !== "") {
    const words = task.gap.replace(/-+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  const first = task.instruction.split("\n")[0]?.replace(/\s+/g, " ").trim() ?? "";
  const bare = first.replace(/^Give JARVIS the ability to\s+/i, "").replace(/,? so that he does it himself.*$/i, "");
  const text = bare.charAt(0).toUpperCase() + bare.slice(1);
  return text.length <= 80 ? text : `${text.slice(0, 77).trimEnd()}...`;
}

/**
 * A job as the end-of-turn check is shown it: the topic, and what made it
 * come up when the job says so. The reason is the part a correction contradicts
 * ("the message on the marketplace" against "it is an e-mail thread"), so a
 * topic alone is not enough to judge by.
 */
export function jobLine(task: Pick<DevTask, "gap" | "instruction">): string {
  const why = /What made this come up:\s*(.+)/.exec(task.instruction)?.[1]?.trim() ?? "";
  const cause = why.length <= 240 ? why : `${why.slice(0, 237).trimEnd()}...`;
  return cause === "" ? topicOf(task) : `${topicOf(task)} -- because: ${cause}`;
}

/**
 * The board, from what the far side says and what this process knows.
 *
 * Pure, so what the screen shows can be tested without a runner: `free` is the
 * delegate's answer (null when it could not be reached), `jobs` the delegated
 * rows, `notes` the judged screens.
 */
export function composeBoard(
  slots: readonly number[],
  free: readonly number[] | null,
  jobs: readonly DevTask[],
  known: ReadonlyMap<number, RunnerNote>,
): RunnerBoard {
  const runners: RunnerRow[] = slots.map((slot) => {
    // A slot is reused; the newest job handed to it is the one it runs.
    const job = [...jobs].reverse().find((task) => task.slot === slot) ?? null;
    const note = job === null ? undefined : known.get(slot);
    return {
      slot,
      busy: free === null ? null : !free.includes(slot),
      ...(job === null
        ? {}
        : {
            job: {
              id: job.id,
              topic: topicOf(job),
              since: job.createdAt,
              ...(job.gap ? { learning: true } : {}),
            },
          }),
      ...(note === undefined
        ? {}
        : { note: { state: note.state, at: new Date(note.at).toISOString(), ...(note.text ? { text: note.text } : {}) } }),
    };
  });
  return { reachable: free !== null, runners };
}

/** Where the board comes from; set once the packs have loaded. */
type Source = () => Promise<RunnerBoard | null>;
let source: Source | null = null;

let last: RunnerBoard | null = null;
const listeners = new Set<(board: RunnerBoard) => void>();

/** Builds a source from the database and the delegate. */
export function boardSource(db: DatabaseSync, delegate: () => Promise<Delegate>): Source {
  return async () => {
    const d = await delegate();
    if (!d.available || d.slots.length === 0) return null;
    return composeBoard(d.slots, await d.free(), delegatedDevTasks(db), notes);
  };
}

export function useBoardSource(next: Source): void {
  source = next;
  refreshBoard();
}

/** The board as last built, for a page that just connected. */
export function lastBoard(): RunnerBoard | null {
  return last;
}

/** Pages watching the board, counted apart from the process's own listeners. */
let pages = 0;

/** Whether any page is open, so nobody pays for a board nobody sees. */
export function boardWatched(): boolean {
  return pages > 0;
}

/**
 * Every new board, until the returned function is called.
 *
 * `page` marks a listener that is a screen: the clock that rebuilds the board
 * only runs while one of those is open.
 */
export function onBoard(listener: (board: RunnerBoard) => void, page = false): () => void {
  listeners.add(listener);
  if (page) pages += 1;
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    listeners.delete(listener);
    if (page) pages -= 1;
  };
}

let building: Promise<void> | null = null;
let again = false;

/**
 * Rebuilds the board and tells every page.
 *
 * Never throws and never runs twice at once: a burst of changes -- a job handed
 * on and judged in the same second -- becomes one rebuild now and one after it,
 * so the last change is always the one on screen.
 */
export function refreshBoard(): void {
  if (source === null) return;
  if (building !== null) {
    again = true;
    return;
  }
  const read = source;
  building = (async () => {
    try {
      const board = await read();
      if (board === null) return;
      last = board;
      for (const listener of listeners) listener(board);
    } catch (error: unknown) {
      console.error("runners: could not build the board:", error);
    } finally {
      building = null;
      if (again) {
        again = false;
        refreshBoard();
      }
    }
  })();
}

/**
 * The health row's sentence, brought up to date by a newer board.
 *
 * The delegate's own probe says how many slots are free, and says it once every
 * few minutes; the board knows sooner. Only the count is replaced, so whatever
 * else the probe said -- which machine, for one -- stays as the pack wrote it.
 */
export function withBoard(detail: string, board: RunnerBoard): string {
  const idle = board.runners.filter((row) => row.busy === false).length;
  return detail.replace(/^\d+ of \d+ slots free/, `${idle} of ${board.runners.length} slots free`);
}
