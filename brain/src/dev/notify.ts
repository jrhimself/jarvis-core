/**
 * What an attempt's ending reads like.
 *
 * Only the shapes: how the message is delivered, and over which channels, is
 * `notify.ts`'s business. Both endings worth carrying outlive the moment they
 * happen -- a review link opened on a phone hours later, and a failure someone
 * wants to read the output of -- so both are written as well as said.
 *
 * HTML, never Markdown: a capitalised `Markdown` is silently dropped by
 * Telegram with a 400, which is how notifications disappear without a trace.
 */

/** Escapes the three characters Telegram's HTML mode treats specially. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The message a finished small fix sends, as HTML. */
export function reviewMessage(task: {
  instruction: string;
  prUrl: string;
  summary: string;
  stat: string;
}): string {
  const lines = [
    "<b>JARVIS heeft een fix klaarstaan</b>",
    "",
    `<i>${escapeHtml(task.instruction)}</i>`,
    "",
    escapeHtml(task.summary),
  ];
  if (task.stat !== "") lines.push("", `<pre>${escapeHtml(task.stat)}</pre>`);
  lines.push("", `<a href="${escapeHtml(task.prUrl)}">Bekijk de pull request</a>`);
  return lines.join("\n");
}

/**
 * How much of a failing run is worth putting in a chat message.
 *
 * Telegram refuses anything over 4096 characters outright, and a refusal here
 * reads exactly like a fix that ended in silence -- which is the failure mode
 * this whole message exists to end. The last lines are the ones that say what
 * broke, so the cut is taken off the front.
 */
const LOG_LINES = 20;
const LOG_CHARS = 1200;

function excerpt(log: string): string {
  const lines = log.trimEnd().split("\n").slice(-LOG_LINES).join("\n");
  return lines.length <= LOG_CHARS ? lines : `…${lines.slice(-LOG_CHARS)}`;
}

/**
 * The message an attempt that produced nothing sends, as HTML.
 *
 * Sent the moment it happens rather than waiting to be asked. A small fix runs
 * for up to a quarter of an hour, and until this existed the difference between
 * "still working" and "fell over ten minutes ago" was invisible from the other
 * side of the house.
 */
export function failureMessage(task: {
  instruction: string;
  /** The sentence that says what went wrong, as it is stored on the task. */
  detail: string;
  /** Whether the guard stopped it rather than the attempt breaking. */
  abandoned?: boolean;
  /** The tail of the output that ended it, when there was one. */
  log?: string | null;
}): string {
  const lines = [
    task.abandoned === true
      ? "<b>JARVIS heeft een fix laten vallen</b>"
      : "<b>JARVIS' fix is mislukt</b>",
    "",
    `<i>${escapeHtml(task.instruction)}</i>`,
    "",
    escapeHtml(task.detail),
  ];
  const log = task.log ?? "";
  if (log.trim() !== "") lines.push("", `<pre>${escapeHtml(excerpt(log))}</pre>`);
  return lines.join("\n");
}

/**
 * The same thing in one spoken sentence.
 *
 * Deliberately without the output: the point of saying it out loud is that the
 * owner knows now, and the reason why is in the written notice and on the task.
 */
export function spokenFailure(task: { instruction: string; detail: string }): string {
  return `De fix voor "${task.instruction}" is er niet gekomen: ${task.detail}.`;
}
