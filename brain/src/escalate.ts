/**
 * When one turn deserves a stronger model than the rest of the conversation.
 *
 * Almost every question here is a lookup -- a temperature, a state, a time --
 * and on those the small model is not a compromise but the better answer: the
 * reply is spoken, and a second of silence is worth more than a cleverer
 * sentence. What the small model is bad at is the other kind of turn, the one
 * where the first attempt fails and somebody has to decide what to try next.
 * That turn is rare, nobody is waiting on it in the same way, and it is exactly
 * the turn worth paying for.
 *
 * So the model is not chosen by subject but by evidence, and only evidence the
 * program can see for itself: a tool came back in error, or the turn has
 * started building something. Both are language-free, which matters -- a list
 * of trigger words would be a fourth place where the deployment's language
 * leaks into the program, and it would miss "dat werkt niet" while firing on a
 * question about why the sky is blue.
 *
 * The switch happens mid-turn. The SDK applies a new model to the response
 * after the current one, so a turn that fails on its first tool call is
 * finished by the stronger model without the user having asked twice.
 */

/** What a session runs on, and what it may be raised to. */
export interface EscalationPolicy {
  /** Model every turn starts on. */
  base: string;
  /** Model a failing or building turn is raised to. Empty switches this off. */
  raised: string;
  /**
   * Tool-name prefixes that mean this turn is building rather than answering.
   *
   * A prefix rather than a list of names: the tools of one server are added to
   * and renamed, and a policy that has to be edited every time one is would
   * quietly stop covering the thing it was written for.
   */
  heavyPrefixes: readonly string[];
}

/** A model change worth making, with the reason it is being made. */
export interface ModelSwitch {
  model: string;
  /** Short, for the log; nobody reads this out loud. */
  why: string;
}

/**
 * One conversation's model choice, driven by what its turns run into.
 *
 * Kept apart from the session it belongs to so it can be exercised without an
 * agent, a network or a model: the interesting behaviour here is a small state
 * machine, and a state machine tested through a live conversation is a state
 * machine tested once a week.
 */
export class Escalation {
  readonly #policy: EscalationPolicy;
  /** Whether the turn in progress has already been raised. */
  #raised = false;
  /** Whether the turn in progress hit an error. */
  #failed = false;
  /** Whether the turn before this one hit an error. */
  #lastFailed = false;

  constructor(policy: EscalationPolicy) {
    this.#policy = policy;
  }

  /** False when no raising is configured, which makes every method a no-op. */
  get enabled(): boolean {
    return this.#policy.raised !== "" && this.#policy.raised !== this.#policy.base;
  }

  /** Whether the turn in progress is running on the stronger model. */
  get raised(): boolean {
    return this.#raised;
  }

  /**
   * The model this turn should open on.
   *
   * A turn that follows a failed one starts raised: "why did that not work" is
   * asked in the next turn, not in the one that broke, and starting it on the
   * model that just failed to get anywhere wastes the one attempt the user is
   * still watching. Anything else returns to the base model -- and returns
   * nothing at all when it is already there, because a needless switch costs a
   * round trip and, on some providers, the prompt cache with it.
   */
  startTurn(): ModelSwitch | null {
    if (!this.enabled) return null;

    const wasRaised = this.#raised;
    this.#raised = false;
    this.#failed = false;

    if (this.#lastFailed) {
      this.#raised = true;
      return { model: this.#policy.raised, why: "the previous turn ran into an error" };
    }
    return wasRaised ? { model: this.#policy.base, why: "back to the usual model" } : null;
  }

  /** A tool came back in error: the rest of this turn is the expensive kind. */
  onToolError(): ModelSwitch | null {
    if (!this.enabled) return null;
    this.#failed = true;
    if (this.#raised) return null;
    this.#raised = true;
    return { model: this.#policy.raised, why: "a tool failed" };
  }

  /** A tool was used; heavy ones raise the turn before they have failed at all. */
  onTool(name: string): ModelSwitch | null {
    if (!this.enabled || this.#raised) return null;
    if (!this.#policy.heavyPrefixes.some((prefix) => name.startsWith(prefix))) return null;
    this.#raised = true;
    return { model: this.#policy.raised, why: "building work" };
  }

  /**
   * Closes the turn, remembering only whether it failed.
   *
   * One turn of memory rather than a mood: a session that raised itself
   * permanently after a single bad tool call would spend the rest of the
   * conversation answering "what time is it" on the expensive model.
   */
  endTurn(): void {
    this.#lastFailed = this.#failed;
    this.#failed = false;
  }
}
