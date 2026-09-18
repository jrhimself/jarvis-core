/**
 * Saying something while a turn is still fetching.
 *
 * A question that needs seven tool calls says nothing at all until the first of
 * them is back, and from the other side of the room that is indistinguishable
 * from not having been heard. The assistant is asked in its own prompt to speak
 * before it reaches for anything, and does -- some of the time: first word at
 * 1.6 seconds on one turn and 10.3 on the next, on the same question in the
 * same words, and not at all when the same thing was asked as a request rather
 * than as a greeting. An acknowledgement that only sometimes arrives is worse
 * than none, so this one is not the model's to decide.
 *
 * What it is not: a progress report. One line, once per turn, and only while
 * the answer has not started. Everything here is about where that boundary is,
 * because the obvious two are both wrong. The question is too early -- an
 * answer three seconds later needs no preamble. Any word at all is too late:
 * "Goedemorgen." arrived at 1.6 seconds and was followed by twenty-two seconds
 * of silence, and twelve characters are not an answer.
 *
 * The boundary that holds is the first word said *about* what a tool came back
 * with. Before it, whatever the assistant has said is an opening, and an
 * opening followed by silence is the case this exists for. After it, the answer
 * is being given and the pauses in it are the answer's own.
 *
 * No timer of its own: the caller owns the clock, so this stays a state machine
 * that can be tested by calling it.
 *
 * Which line is said is random, except that it is never the one said last. Two
 * turns in a row that open with the same words sound like a recording, and with
 * three lines to choose from that happened one time in three.
 */

/** The line the previous turn opened with, whichever conversation it was in. */
let lastLine: string | null = null;

/** One turn's opening, from the question to the first word of the answer. */
export class Opening {
  /** A tool has answered, so the next words out are the answer itself. */
  #told = false;
  /** Those words arrived. Nothing is filled after this. */
  #answering = false;
  /** A line has been spoken. One per turn. */
  #filled = false;

  constructor(
    private readonly lines: readonly string[],
    /** How long a silence may last before it is filled. Zero switches this off. */
    readonly afterMs: number,
  ) {}

  /** Whether this deployment fills a silence at all. */
  get enabled(): boolean {
    return this.afterMs > 0 && this.lines.length > 0;
  }

  /** Whether the clock is still worth running. */
  get waiting(): boolean {
    return this.enabled && !this.#filled && !this.#answering;
  }

  /** A tool came back. */
  told(): void {
    this.#told = true;
  }

  /**
   * The assistant said something.
   *
   * Returns whether the clock should be restarted from this word: it should
   * while the assistant is still only greeting, because a greeting buys the
   * same silence the question did, and it should not once the answer has begun.
   */
  said(): boolean {
    if (this.#told) this.#answering = true;
    return this.waiting;
  }

  /**
   * The silence has lasted long enough. Returns what to say, or null when
   * there is nothing to say any more -- the answer started, or a line already
   * went out while the clock was running.
   */
  due(): string | null {
    if (!this.waiting) return null;
    this.#filled = true;
    const fresh = this.lines.filter((line) => line !== lastLine);
    const choices = fresh.length > 0 ? fresh : this.lines;
    const line = choices[Math.floor(Math.random() * choices.length)] ?? null;
    lastLine = line;
    return line;
  }
}
