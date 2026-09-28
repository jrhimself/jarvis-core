/**
 * Saying something out loud that nobody asked for.
 *
 * Everything else here speaks inside a turn: someone says something, the HUD opens
 * a turn, the answer and its audio ride back on that turn's id, and the page
 * drops anything that belongs to a turn it does not know. That is the right
 * default -- a browser page should not be made to speak by whatever arrives on
 * its socket -- but it leaves the brain mute between questions, and a fix that
 * fell over ten minutes after it was started has nobody to tell.
 *
 * So this is the one exception, and it is deliberately thin: the brain asks an
 * open HUD to speak a line, and the HUD starts a turn of its own for it, the
 * same way the greeting on arrival does. No audio crosses this path, no turn id
 * is invented on the server, and a page that is not listening simply is not
 * there.
 */

import type { DisplayDismiss, DisplayPayload } from "@jarvis/shared";

/** An open HUD, as far as this module cares. */
export interface LiveSession {
  /** Say a line out loud, in a turn the HUD opens for it. */
  say: (text: string) => void;
  /** Put a window on screen that belongs to no turn. */
  show: (id: string, payload: DisplayPayload, dismiss: DisplayDismiss) => void;
}

/**
 * The sessions currently connected, oldest first.
 *
 * A `Set` keeps insertion order, which is the only ordering that matters here:
 * the newest connection is the page somebody is actually in front of. The tablet in
 * the hall and the laptop in the office should not answer him in chorus.
 */
const sessions = new Set<LiveSession>();

/** Registers an open HUD and hands back the way to forget it. */
export function addLiveSession(session: LiveSession): () => void {
  sessions.add(session);
  return () => {
    sessions.delete(session);
  };
}

/**
 * Asks the most recently opened HUD to say a line.
 *
 * Returns whether anyone was there to hear it, so a caller that also writes to
 * Telegram can tell the difference between "said and sent" and "sent only".
 */
export function speakUnprompted(text: string): boolean {
  const spoken = text.trim();
  if (spoken === "") return false;

  const newest = [...sessions].at(-1);
  if (newest === undefined) return false;

  try {
    newest.say(spoken);
  } catch (error: unknown) {
    // A socket that died between the check and the write is not this caller's
    // problem: the message it carries also went to Telegram.
    console.error("could not speak to the HUD:", error);
    return false;
  }
  return true;
}

/**
 * Puts a window on the most recently opened HUD, unasked.
 *
 * The same one-page rule as speech: the newest connection is the screen
 * somebody is in front of. Reusing an id replaces the card in place, which is
 * what makes a second ring within the minute look like the same window rather
 * than a pile of them.
 */
export function showUnprompted(
  id: string,
  payload: DisplayPayload,
  dismiss: DisplayDismiss,
): boolean {
  const newest = [...sessions].at(-1);
  if (newest === undefined) return false;

  try {
    newest.show(id, payload, dismiss);
  } catch (error: unknown) {
    console.error("could not show anything on the HUD:", error);
    return false;
  }
  return true;
}

/** How many HUDs are open. Exists for the tests and for a health line. */
export function liveSessionCount(): number {
  return sessions.size;
}
