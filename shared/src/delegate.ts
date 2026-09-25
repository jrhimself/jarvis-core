/**
 * Handing a job on to something that can do more than JARVIS can.
 *
 * The self-development machinery decides for itself whether a request is a
 * small fix -- a few files, an acceptance check, a pull request -- or something
 * bigger. What happens to the bigger half is not core's business. One
 * deployment hands it to a coding agent on another machine over an SSH channel
 * pinned to a forced command; another might use a queue, a ticket, or nothing
 * at all.
 *
 * `NO_DELEGATE` is the default, and it is a real answer rather than a stub. A
 * verdict of "too big" with nowhere to send it ends the way a capability gap
 * already ends: written down, and said out loud. That is worse than having a
 * runner and much better than an assistant that quietly attempts a rewrite it
 * was told not to.
 */

/** What is being handed on, and why JARVIS is not doing it himself. */
export interface DelegatedTask {
  /** What the user asked for, in their own words where possible. */
  instruction: string;
  /** Why this is not a small fix. Travels with the job so the far side knows. */
  reason: string;
}

/** Where a handed-on job ended up, or why it did not. */
export type Delegated =
  | { ok: true; slot: number }
  | { ok: false; error: string };

/** What a runner is showing right now. */
export type RunnerOutput = { ok: true; text: string } | { ok: false; error: string };

/** Whether a slot could be given back. */
export type Closed = { ok: true } | { ok: false; error: string };

/**
 * Somewhere to send work that is too big to do here.
 *
 * `slots` are the places a job can land, named by number because that is what
 * the user hears: "slot vier is bezig" is a sentence, "the second delegation
 * target" is not. An implementation with a single destination reports `[1]`.
 */
export interface Delegate {
  /** Whether anything can actually be handed on. False for `NO_DELEGATE`. */
  readonly available: boolean;

  /** Every slot this delegate has, whether busy or not. */
  readonly slots: readonly number[];

  /** Which slots are idle, or null when the far side could not be reached. */
  free(): Promise<number[] | null>;

  /**
   * Whether the far side answers, for the health panel.
   *
   * Resolves with what answered and throws with why it did not, like any
   * probe. Optional: a delegate without it is asked through `free()`, which
   * can say that the far side is gone but not why -- and "why" is the part
   * that decides whether to wait or to go and fix a setting. A channel that
   * nobody asks after is a channel whose failure is found by the one request
   * that needed it, which is the worst moment to find it.
   */
  check?(): Promise<string>;

  /** Hands the job on. Resolves with the slot it landed in. */
  send(task: DelegatedTask): Promise<Delegated>;

  /** The last few lines of what a slot is doing. */
  tail(slot: number, lines: number): Promise<RunnerOutput>;

  /**
   * Gives a slot back once its job is over.
   *
   * There are only ever a couple of them, and a runner nobody closed holds one
   * for as long as the machine stays up. Whether a job is over is not something
   * this seam can tell, so the decision stays with the caller and this is only
   * the door.
   */
  kill(slot: number): Promise<Closed>;
}

/** The default: nothing to hand work to, and honest about it. */
export const NO_DELEGATE: Delegate = {
  available: false,
  slots: [],
  free: async () => [],
  send: async () => ({ ok: false, error: "Er is niets om dit aan door te geven." }),
  tail: async () => ({ ok: false, error: "Er draait hier geen runner." }),
  kill: async () => ({ ok: false, error: "Er draait hier geen runner." }),
};
