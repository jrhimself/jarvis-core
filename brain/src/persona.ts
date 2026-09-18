/**
 * Who JARVIS is, and how he is allowed to talk.
 *
 * The text is not here. It lives in `config/persona.md`, which this repository
 * ignores, because who the assistant is and who it is talking to is the part
 * that belongs to a deployment rather than to the program: a name, a language,
 * a household's routines. `examples/persona.md` is a working one to copy.
 *
 * Every word of it is spoken out loud, so the constraints are about speech
 * rather than text: no markup a voice cannot pronounce, no lists, no preamble.
 * Length is the main lever -- a paragraph that reads fine takes fifteen seconds
 * to listen to.
 *
 * Ownership rule: the persona carries who JARVIS
 * is -- tone, speech, honesty, what he may talk about -- plus the routines that
 * span several packs, like a morning briefing, which no single pack can own.
 * What one pack's tools are for lives in that pack's own persona paragraph, and
 * how a single tool is used lives in its description. Anything
 * security-critical is enforced in code, never only in prose. Do not restate a
 * pack's paragraph in the persona: the flows were written down twice once, the
 * copies drifted apart, and drift between two prompts is invisible until the
 * model follows the stale one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the deployment's own persona lives, relative to the repository root. */
const PERSONA_FILE = join("config", "persona.md");

/**
 * What JARVIS says about himself when nobody has told him who he is.
 *
 * Deliberately short and deliberately honest. A first start with no persona
 * should produce an assistant that works and admits it has not been given a
 * character, not one that pretends to a household it knows nothing about.
 */
export const DEFAULT_PERSONA = `You are JARVIS, a voice assistant.

Everything you say is spoken aloud. Keep it to a sentence or two, with no
markdown, no lists and no preamble -- a paragraph that reads well takes fifteen
seconds to listen to. Say the fact first and the context after it, if at all.

You have a memory of this household: preferences, people, habits, and your own
earlier conclusions. Look something up when a question touches it, and write
down what will matter later. Never write down what a tool can simply be asked.

If you do not know something, say so in one sentence. Never invent a value, a
time or a status, and never claim something is running without having checked it
this conversation.

Nobody has given you a persona yet. It goes in config/persona.md, and there is
one to copy in examples/persona.md.`;

/** Strips HTML comments, so an example can carry guidance nobody pays for. */
export function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

function repoRoot(): string {
  // brain/dist/persona.js -> two directories up.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The character this deployment runs with, and whether it is its own. */
export interface Persona {
  /** The text the model is given. */
  text: string;
  /**
   * False when this is the built-in fallback.
   *
   * Carried beside the text because the assistant gets asked how it is set up,
   * and "you are talking to the default character" is one of the more useful
   * answers there is: an assistant given no household should not leave anyone
   * guessing why it knows nothing about theirs.
   */
  own: boolean;
}

/**
 * The persona this deployment runs with.
 *
 * Read once, at startup: an assistant whose character changed halfway through a
 * conversation would be a stranger answering the second question. A missing
 * file falls back with a warning, and so does an unreadable one -- a
 * permissions mistake should cost the character, not the ability to talk.
 */
export function loadPersona(root = repoRoot()): Persona {
  let raw: string;
  try {
    raw = readFileSync(join(root, PERSONA_FILE), "utf8");
  } catch {
    console.warn(`persona: no ${PERSONA_FILE}; using the built-in default`);
    return { text: DEFAULT_PERSONA, own: false };
  }

  const text = withoutComments(raw);
  if (text !== "") return { text, own: true };

  console.warn(`persona: ${PERSONA_FILE} is empty; using the built-in default`);
  return { text: DEFAULT_PERSONA, own: false };
}
