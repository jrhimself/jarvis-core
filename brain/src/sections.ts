/**
 * Section markers, taken out of the answer as it streams.
 *
 * A briefing covers five subjects in one run of speech, and the desk opens the
 * window for each as he gets to it. Telling that from the words does not work:
 * a pull request is called "notes", a mail mentions a review, and the weather
 * is "rain, 16 degrees" without the word weather in it. So the model marks
 * where each part begins -- `⟦agenda⟧On the agenda: ...` -- and the marker is
 * the answer to "when".
 *
 * The marker never reaches the voice, the page or a chat. What goes on instead
 * is where it stood, counted in the text that does go on: the same count the
 * HUD keeps against the audio's alignment, so the window opens on the first
 * syllable of its part.
 *
 * Like the dash filter this runs on a stream: a marker can arrive split over
 * two chunks, so an unfinished one is held back until its closing bracket.
 */

export const SECTION_OPEN = "⟦";
export const SECTION_CLOSE = "⟧";

/** A desk topic id: what `PackDeskSlot.topic` holds. */
const TOPIC = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** A whole marker, whatever is inside it. */
const MARKER = /⟦([^⟦⟧]{0,40})⟧/g;

/** Longer than this, an opening bracket was not the start of a marker. */
const MAX_HELD = 48;

export interface SectionMark {
  /** The desk topic the part is about. */
  topic: string;
  /** Where the part begins, in the text returned by the same call. */
  at: number;
}

export interface SectionPass {
  text: string;
  marks: SectionMark[];
}

export class SectionMarks {
  /** An opening bracket and what followed it, waiting for the close. */
  #held = "";
  /** The last character handed on, to see whether a marker stands between spaces. */
  #last = "";
  /** A marker ended a chunk after a space: a space opening the next one goes with it. */
  #eatSpace = false;

  /** The next chunk of the answer: what can be passed on, and the marks in it. */
  push(chunk: string): SectionPass {
    let text = this.#held + chunk;
    this.#held = "";
    const open = text.lastIndexOf(SECTION_OPEN);
    if (open >= 0 && !text.includes(SECTION_CLOSE, open) && text.length - open <= MAX_HELD) {
      this.#held = text.slice(open);
      text = text.slice(0, open);
    }
    return this.#emit(text);
  }

  /** The answer is over: whatever was held back, as it stands. */
  flush(): SectionPass {
    const rest = this.#held;
    this.#held = "";
    return this.#emit(rest);
  }

  #emit(text: string): SectionPass {
    const marks: SectionMark[] = [];
    let out = "";
    let from = 0;
    if (this.#eatSpace && text !== "") {
      if (text[0] === " ") from = 1;
      this.#eatSpace = false;
    }
    MARKER.lastIndex = 0;
    for (let m = MARKER.exec(text); m !== null; m = MARKER.exec(text)) {
      out += text.slice(from, m.index);
      from = m.index + m[0].length;
      // A marker between two spaces would leave both: one goes with it.
      const before = out === "" ? this.#last : out.slice(-1);
      const spaced = before === "" || /\s/.test(before);
      if (spaced && text[from] === " ") from += 1;
      else if (spaced && from === text.length) this.#eatSpace = true;
      // Something bracketed that is not a topic is dropped all the same: a
      // bracket read out loud is worse than a window that does not open.
      const topic = (m[1] ?? "").trim().toLowerCase();
      if (TOPIC.test(topic)) marks.push({ topic, at: out.length });
    }
    out += text.slice(from);
    if (out !== "") this.#last = out.slice(-1);
    return { text: out, marks };
  }
}

/**
 * The prompt paragraph that asks for the markers, naming every desk topic.
 *
 * Asked for every answer about a desk subject, not only the briefing: "what is
 * on my agenda" opens the agenda on its first word the same way. Each part also
 * opens by naming its subject: without that a briefing ran from "Rain today" to
 * a meeting at half past eight with nothing said in between, and the window was
 * the only sign the subject had changed.
 */
export function sectionMarkBlock(topics: readonly string[]): string {
  const valid = topics.filter((t) => TOPIC.test(t));
  if (valid.length === 0) return "";
  const list = valid.map((t) => `${SECTION_OPEN}${t}${SECTION_CLOSE}`).join(", ");
  return (
    "Desk markers. When an answer talks about one of the desk subjects -- the briefing above " +
    `all -- begin the part about each subject with its marker: ${list}. Put it directly ` +
    "before the first word of that part, once per part, and only there: never inside a " +
    "sentence, never for a subject only mentioned in passing. Right after the marker, name " +
    "the subject in a short lead-in before its first item -- \"The weather:\", \"On the " +
    "agenda:\", \"On mail:\", \"On the pull requests:\", \"From your notes:\", in the language " +
    "of the answer -- so which part this is can be heard, not only seen. The markers are " +
    "taken out before anything is said, shown or sent, so never mention or explain them."
  );
}
