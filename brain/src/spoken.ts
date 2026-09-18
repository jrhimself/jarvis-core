/**
 * Dashes, taken out of speech as it streams.
 *
 * The model writes the way it reads, and what it reads is full of the dash
 * that joins two clauses: "your own build failed yesterday -- those two want
 * something from you". On a page that is a style; out loud it is nothing, the
 * voice skips it or pauses oddly, and on the transcript it is the one mark
 * that says a machine wrote this. Asking the persona not to helps some of the
 * time. This does it every time.
 *
 * The answer arrives a few words per chunk, and a dash with its spaces can be
 * split across two of them, so this is a filter with a memory rather than a
 * regular expression: whatever at the end of a chunk could still turn out to be
 * the start of a dash is held back until the next chunk says what it was. A
 * held-back space costs nothing -- the next chunk is milliseconds behind -- and
 * `flush` returns it when the answer is over.
 *
 * What is a dash here: an em dash anywhere, and an en dash or one or two
 * hyphens between spaces. A hyphen inside a word (e-mail, to-do) and an en
 * dash inside a range (9–17) stay. A dash after a full stop, colon or comma is
 * simply dropped, because the pause is already there; anywhere else it becomes
 * a comma, which is what a person would have said.
 */

const DASH = /\s*—\s*|\s+–\s+|\s+-{1,2}\s+/g;

/** Whatever at the end of a chunk could still become a dash with its spaces. */
const UNSETTLED = /[\s—–-]+$/;

/** The mark before a dash that already carries the pause. */
const PAUSED = /[.!?:;,]/;

export class SpokenText {
  /** Text not yet handed on, because its meaning depends on what follows. */
  #held = "";
  /** The last character handed on, to see whether a dash follows a pause. */
  #last = "";

  /** The next chunk of the answer; returns what can be said of it now. */
  push(chunk: string): string {
    const text = this.#held + chunk;
    const unsettled = UNSETTLED.exec(text);
    const settled = unsettled === null ? text : text.slice(0, unsettled.index);
    this.#held = unsettled === null ? "" : unsettled[0];
    return this.#emit(settled);
  }

  /** The answer is over: whatever was held back, as it stands. */
  flush(): string {
    const rest = this.#held;
    this.#held = "";
    return this.#emit(rest);
  }

  #emit(text: string): string {
    if (text === "") return "";
    const out = text.replace(DASH, (_match, offset: number, whole: string) => {
      const before = offset === 0 ? this.#last : whole[offset - 1] ?? "";
      return PAUSED.test(before) ? " " : ", ";
    });
    this.#last = out.slice(-1);
    return out;
  }
}
