/**
 * Which clock and which language the assistant reasons in.
 *
 * Every date this program turns into a weekday, an hour or a spoken sentence is
 * a local one. A behavioural baseline is the clearest case: it asks what a
 * Tuesday evening usually looks like, and an evening is a thing that happens in
 * a place. Reasoning about it in UTC does not fail, which is exactly the
 * problem -- it produces a number that is quietly about a different hour.
 *
 * So the zone is configuration, and it has no built-in default: unset, the
 * machine's own zone is used and said out loud at startup. A container's clock
 * is usually UTC, which is a real answer for a machine and a wrong one for a
 * house, so `usingHostZone()` lets the self checks say so rather than leaving
 * somebody to find out from a baseline that never made sense.
 *
 * Read per call rather than captured at import: a formatter built while the
 * module loaded would freeze whatever the environment happened to be, which is
 * unhelpful in a test and wrong in a CLI that sets its own.
 */

/** The machine's own zone, resolved once. `UTC` when it will not say. */
const HOST_ZONE = ((): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

/** The language dates and numbers are written in. */
export function locale(): string {
  const set = process.env["JARVIS_LOCALE"];
  return set === undefined || set === "" ? "nl-NL" : set;
}

/** The zone every local hour, weekday and spoken time is worked out in. */
export function timeZone(): string {
  const set = process.env["JARVIS_TIMEZONE"];
  return set === undefined || set === "" ? HOST_ZONE : set;
}

/** Whether the zone came from the machine rather than from configuration. */
export function usingHostZone(): boolean {
  const set = process.env["JARVIS_TIMEZONE"];
  return set === undefined || set === "";
}

/**
 * A cached `Intl.DateTimeFormat`.
 *
 * Building one is expensive enough that the rollup and the baselines would
 * notice: they format a value per bucket, and there are thousands. The cache is
 * keyed on everything that can change the answer, so a test that moves the zone
 * gets a different formatter rather than a stale one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatter(
  options: Intl.DateTimeFormatOptions,
  overrideLocale?: string,
): Intl.DateTimeFormat {
  const useLocale = overrideLocale ?? locale();
  const zone = timeZone();
  const key = `${useLocale} ${zone} ${JSON.stringify(options)}`;

  let found = formatters.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat(useLocale, { timeZone: zone, ...options });
    formatters.set(key, found);
  }
  return found;
}

/** The same, for the places that only want a string back. */
export function formatLocal(at: Date, options: Intl.DateTimeFormatOptions): string {
  return formatter(options).format(at);
}
