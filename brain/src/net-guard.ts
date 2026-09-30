/**
 * Which addresses a model-chosen URL may reach.
 *
 * Everything else this assistant fetches is pointed at by configuration: a
 * house, a mailbox, a camera. A page to open or an image to look at is
 * different, because the address comes out of a conversation -- and so
 * ultimately out of whatever a web page put into it. An assistant that will
 * open any address will open the router's login page, the house's own API and
 * the cloud metadata endpoint of whatever it runs on, and read them aloud.
 *
 * So the address is checked as a host before anything connects, and again at
 * every redirect, since a public page can send the request anywhere. What this
 * cannot see is a public name that resolves to a private address; closing that
 * needs the resolver and is not attempted here.
 */

/** IPv4 ranges that are never a public web server, as [network, prefix length]. */
const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
];

/** Name endings that only ever mean somewhere on a local network. */
const LOCAL_SUFFIXES = [".local", ".lan", ".home", ".internal", ".localdomain", ".home.arpa", ".intranet"];

function v4Number(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inRange(value: number, network: string, prefix: number): boolean {
  const base = v4Number(network);
  if (base === null) return false;
  const size = 2 ** (32 - prefix);
  return value >= base && value < base + size;
}

/** Whether a host names somewhere that is not the public internet. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "") return true;

  const v4 = v4Number(host);
  if (v4 !== null) return PRIVATE_V4.some(([network, prefix]) => inRange(v4, network, prefix));

  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true;
    // An IPv4 address wearing an IPv6 coat is judged as the IPv4 it is.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    if (mapped?.[1] !== undefined) return isPrivateHost(mapped[1]);
    const first = Number.parseInt(host.split(":")[0] ?? "", 16);
    if (Number.isNaN(first)) return true;
    // fc00::/7 unique local, fe80::/10 link local.
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  // A single label is a name on somebody's own network, never a public site.
  return !host.includes(".");
}

export type PublicUrl = { ok: true; url: URL } | { ok: false; reason: string };

/** The URL, if it is an http(s) address on the public internet. */
export function checkPublicUrl(raw: string): PublicUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `not a usable address: ${raw}` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `only http and https addresses are opened, not ${url.protocol}` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "an address with a login in it is not opened" };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, reason: `${url.hostname} is on a private network, and only public addresses are opened` };
  }
  return { ok: true, url };
}

/** How many redirects a fetch follows before it gives up. */
const MAX_HOPS = 5;

/**
 * A fetch that follows redirects itself, so that each hop is checked.
 *
 * `redirect: "follow"` would let a public page hand the request to a private
 * address after the first check had passed.
 */
export async function fetchPublic(
  raw: string,
  init: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<Response> {
  let next = raw;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const checked = checkPublicUrl(next);
    if (!checked.ok) throw new Error(checked.reason);

    const response = await fetch(checked.url, {
      headers: init.headers ?? {},
      redirect: "manual",
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });

    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      next = new URL(location, checked.url).href;
      continue;
    }
    return response;
  }
  throw new Error("too many redirects");
}
