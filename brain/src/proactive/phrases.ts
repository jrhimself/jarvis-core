/**
 * The same finding, in the language of whoever reads it.
 *
 * A rule writes one English sentence and always has: that sentence is the
 * record, it goes in the database, the log and the tools, and English is the
 * language this repository is written in. But the record and the message are
 * not the same thing. The record is read by whoever maintains this; the message
 * is read by somebody in a house, on a phone, and they should not have to read
 * a second language to find out that a window sensor has stopped answering.
 *
 * So a rule says its sentence twice: once as prose, and once as a key with the
 * values pulled out. The prose is what gets stored. The key is what makes
 * another language possible, and the delivery layer picks between them.
 *
 * A language nothing has been written for falls back to the stored prose, and
 * so does a key that was added to a rule and not to this table. Both failures
 * end in an English sentence rather than a missing one, which is the only
 * acceptable way for a translation to break.
 */

/** A sentence not yet made: which one, and what goes in the gaps. */
export interface Phrase {
  key: string;
  args: Record<string, string | number>;
}

/** Sentences per key, per language. `{name}` is filled from the args. */
const SENTENCES: Record<string, Record<string, string>> = {
  "deviation.reading": {
    en: "{subject} read {reading}, against a usual {usual} for this hour (z {z})",
    nl: "{subject} las {reading}, tegen normaal {usual} voor dit uur (z {z})",
  },
  "missing.quiet": {
    en: "{subject} is usually active for {percent}% of this hour and was not active at all",
    nl: "{subject} is dit uur normaal {percent}% van de tijd actief en was helemaal niet actief",
  },
  "stuck.dead": {
    en: "{subject} is reporting {state} and has no reading to give",
    nl: "{subject} meldt {state} en heeft geen waarde te geven",
  },
  "stuck.frozen": {
    en:
      "{subject} normally changes about {changes} times a day and has not changed " +
      "in {hours} hours (it reads {state})",
    nl:
      "{subject} verandert normaal zo'n {changes} keer per dag en is al {hours} uur " +
      "niet veranderd (hij staat op {state})",
  },
  "problem.active": {
    en: "{subject} is reporting a problem",
    nl: "{subject} meldt een storing",
  },
};

/** What each rule is called, for the line above the sentence. */
const RULES: Record<string, Record<string, string>> = {
  deviation: { en: "deviation", nl: "afwijking" },
  missing: { en: "missing", nl: "uitgebleven" },
  stuck: { en: "stuck", nl: "vastgelopen" },
  problem: { en: "problem", nl: "storing" },
  heartbeat: { en: "heartbeat", nl: "hartslag" },
  invariant: { en: "invariant", nl: "aanname" },
};

/** The handful of words the delivery layer says in its own voice. */
const WORDS: Record<string, Record<string, string>> = {
  "held.first": { en: "first hour", nl: "eerste uur" },
  "held.hours": { en: "held for {hours} hours", nl: "staat al {hours} uur" },
  "button.right": { en: "Right", nl: "Klopt" },
  "button.noise": { en: "Noise", nl: "Ruis" },
  "button.later": { en: "Later", nl: "Later" },
  "said.right": { en: "you said: Right", nl: "je zei: Klopt" },
  "said.noise": { en: "you said: Noise", nl: "je zei: Ruis" },
  "said.later": { en: "you said: Later", nl: "je zei: Later" },
  "ack.right": { en: "Noted -- worth telling you.", nl: "Genoteerd — dit was het waard." },
  "ack.noise": { en: "Noted -- not worth telling you.", nl: "Genoteerd — dit was het niet waard." },
  "ack.later": { en: "Put away for {days} days.", nl: "{days} dagen weggelegd." },
  "ack.gone": { en: "That one is no longer on file.", nl: "Die staat niet meer op de lijst." },
};

function fill(template: string, args: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in args ? String(args[name]) : whole,
  );
}

function lookup(
  table: Record<string, Record<string, string>>,
  key: string,
  language: string,
): string | null {
  const entry = table[key];
  if (entry === undefined) return null;
  return entry[language] ?? entry["en"] ?? null;
}

/**
 * The sentence for a phrase, or the stored prose when there is not one.
 *
 * `fallback` is the English the rule already wrote, so a key this table has
 * never heard of still says something true.
 */
export function say(
  phrase: Phrase | null | undefined,
  language: string,
  fallback: string,
): string {
  if (phrase === null || phrase === undefined) return fallback;
  const template = lookup(SENTENCES, phrase.key, language);
  return template === null ? fallback : fill(template, phrase.args);
}

/** What to call a rule in this language. Unknown rules keep their own name. */
export function ruleName(rule: string, language: string): string {
  return lookup(RULES, rule, language) ?? rule;
}

/** One of the delivery layer's own words. */
export function word(
  key: string,
  language: string,
  args: Record<string, string | number> = {},
): string {
  const template = lookup(WORDS, key, language);
  return template === null ? key : fill(template, args);
}

/**
 * The language to write in: the first half of the configured locale.
 *
 * Derived rather than configured separately. A deployment that has said its
 * house speaks Dutch has already said which language its messages are in, and a
 * second setting that could disagree with the first is a bug waiting for a
 * quiet evening.
 */
export function languageOf(locale: string): string {
  const tag = locale.split("-")[0]?.toLowerCase() ?? "";
  return tag === "" ? "en" : tag;
}
