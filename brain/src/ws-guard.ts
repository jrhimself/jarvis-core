/**
 * Who may open the HUD websocket.
 *
 * A browser page on any other origin can open a socket to a host the machine
 * can route to, and the page chooses the target — the person looking at it
 * does not. The Origin header is the browser's own statement of which page
 * did that, and a page cannot change it. So a browser is accepted only when
 * that origin is this server, or one a deployment has named.
 *
 * A script is not a browser and sends no Origin. Refusing it outright would
 * break the local clients that already talk to this port, so it stays
 * accepted until a deployment sets a shared token. With the token set, every
 * client has to present it: a browser is given it by `/api/config` on its own
 * origin, which a page on another origin cannot read, and a script is given
 * it by whoever runs it.
 */

import { timingSafeEqual } from "node:crypto";

/** How long a connection may sit open before presenting a token. */
export const AUTH_WAIT_MS = 5_000;

/** What the guard needs from configuration. An empty token means unset. */
export interface WsGuardPolicy {
  token: string;
  /** Origins already normalized by `parseAllowedOrigins`. */
  allowedOrigins: readonly string[];
}

/**
 * The slice of an upgrade request the decision reads.
 *
 * Narrower than `IncomingMessage` so a test can build one without a socket.
 * `socket.encrypted` is how an HTTPS server reports itself; a reverse proxy
 * that terminated TLS says so with `X-Forwarded-Proto` instead.
 */
export interface GuardRequest {
  url?: string;
  headers: {
    origin?: string | string[] | undefined;
    host?: string | string[] | undefined;
    referer?: string | string[] | undefined;
    forwarded?: string | string[] | undefined;
    "x-forwarded-host"?: string | string[] | undefined;
    "x-forwarded-proto"?: string | string[] | undefined;
  };
  /**
   * Anything with an `encrypted` flag. Typed loosely so a Node request, whose
   * socket is a `net.Socket` until TLS says otherwise, can be passed straight
   * through.
   */
  socket?: object;
}

export type UpgradeDecision =
  | { accept: true; pendingAuth: boolean }
  | { accept: false; status: 401 | 403; reason: string };

/** The methods `holdForAuth` uses. A `ws` socket satisfies them. */
export interface AuthSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, data?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  off(event: "message", listener: (data: unknown) => void): void;
  off(event: "close", listener: () => void): void;
}

/**
 * An origin a deployment wrote down, or null when the text is not one.
 *
 * `URL.origin` folds the default port and the host's case, so an allowlist
 * entry and a browser header meet in the same form.
 */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "null") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin;
}

/**
 * The extra origins from `JARVIS_WS_ALLOWED_ORIGINS`.
 *
 * A comma separates them. Anything that is not an http(s) origin is dropped
 * with a warning rather than failing the start: a typo should not take the
 * HUD down, and it should not be read as "allow everything" either.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const origin = normalizeOrigin(trimmed);
    if (origin === null) {
      console.warn(`JARVIS_WS_ALLOWED_ORIGINS: ignored an entry that is not an http(s) origin`);
      continue;
    }
    seen.add(origin);
  }
  return [...seen];
}

/** Compares without leaking where two tokens start to differ. */
export function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * The token on an `{kind:"auth"}` frame, or null when the message is not one.
 *
 * Empty is null on purpose: a frame that names no token has not authenticated,
 * and treating it as one would let a blank string through the length check.
 */
export function readAuthFrame(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Record<string, unknown>;
  if (value["kind"] !== "auth") return null;
  const token = value["token"];
  if (typeof token !== "string" || token === "") return null;
  return token;
}

/**
 * Whether this upgrade may proceed.
 *
 * Origin is decided first. A matching token does not make a foreign browser
 * welcome: the token's job is the client that sent no Origin, and a browser
 * that already failed the origin check must not get a different answer for
 * having guessed the secret. A wrong token in the query is a refusal; a
 * missing one is left to the first frame, so a script can keep the secret out
 * of the URL.
 */
export function decideUpgrade(req: GuardRequest, policy: WsGuardPolicy): UpgradeDecision {
  const stated = originHeader(req.headers.origin);
  if (stated !== null && !originPermitted(stated, req, policy)) {
    return { accept: false, status: 403, reason: "Forbidden" };
  }
  if (policy.token === "") return { accept: true, pendingAuth: false };

  const presented = tokenQuery(req.url);
  if (presented === null) return { accept: true, pendingAuth: true };
  if (sameToken(presented, policy.token)) return { accept: true, pendingAuth: false };
  return { accept: false, status: 401, reason: "Unauthorized" };
}

/**
 * Whether `/api/config` may include the websocket token.
 *
 * The HUD asks for it with an ordinary same-origin fetch, which carries
 * Origin. A page on another origin carries a different one and, separately,
 * cannot read the response. A client that sends no Origin — the curl that
 * prints configuration — is not handed the secret.
 */
export function revealsWsToken(req: GuardRequest, policy: WsGuardPolicy): boolean {
  if (policy.token === "") return false;
  const stated = originHeader(req.headers.origin) ?? refererOrigin(req.headers.referer);
  if (stated === null) return false;
  return originPermitted(stated, req, policy);
}

/**
 * Holds a socket shut until its first frame authenticates.
 *
 * Nothing is sent before that: the session that follows this is what pushes
 * the panels, and pushing them to a socket that has not authenticated yet
 * would make the token decorative. `waitMs` is the production wait; tests
 * pass a shorter one.
 */
export function holdForAuth(
  socket: AuthSocket,
  expected: string,
  onAuthorized: () => void,
  waitMs: number = AUTH_WAIT_MS,
): void {
  let settled = false;

  const finish = (ok: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.off("message", onMessage);
    socket.off("close", onClose);
    if (ok) {
      onAuthorized();
      return;
    }
    if (socket.readyState === socket.OPEN) socket.close(1008, "Unauthorized");
  };

  const onMessage = (raw: unknown): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(textOf(raw));
    } catch {
      finish(false);
      return;
    }
    const token = readAuthFrame(parsed);
    if (token !== null && sameToken(token, expected)) finish(true);
    else finish(false);
  };

  const onClose = (): void => finish(false);

  const timer = setTimeout(() => finish(false), waitMs);
  if (typeof timer.unref === "function") timer.unref();
  socket.on("message", onMessage);
  socket.on("close", onClose);
}

/** The Origin header when the client sent one, including one this guard rejects. */
function originHeader(value: string | string[] | undefined): string | null {
  const raw = headerText(value).trim();
  if (raw === "") return null;
  return raw;
}

/** Where a same-origin fetch says it came from, when it sent no Origin. */
function refererOrigin(value: string | string[] | undefined): string | null {
  const raw = headerText(value).trim();
  if (raw === "") return null;
  return normalizeOrigin(raw);
}

function originPermitted(stated: string, req: GuardRequest, policy: WsGuardPolicy): boolean {
  const origin = normalizeOrigin(stated);
  if (origin === null) return false;
  if (policy.allowedOrigins.includes(origin)) return true;
  return candidateOrigins(req).includes(origin);
}

/**
 * The origins this request can honestly claim to be.
 *
 * The Host header is the browser's, and a page cannot set it. A reverse proxy
 * that dials the brain under a different name puts the public host in
 * `X-Forwarded-Host` (or the `host` parameter of `Forwarded`) and the public
 * scheme in `X-Forwarded-Proto`. Both are consulted, and so is Host itself, so
 * a proxy that rewrites neither still matches. The first forwarded value is
 * the one the client presented; a chain appends behind it.
 */
function candidateOrigins(req: GuardRequest): string[] {
  const forwarded = forwardedFields(req);
  const scheme = publicScheme(req, forwarded.proto);
  const hosts = [forwarded.host, firstHeader(req.headers["x-forwarded-host"]), firstHeader(req.headers.host)];
  const origins: string[] = [];
  for (const host of hosts) {
    if (host === "") continue;
    const origin = originOf(scheme, host);
    if (origin !== null && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

function socketEncrypted(socket: object | undefined): boolean {
  return socket !== undefined && "encrypted" in socket && (socket as { encrypted?: boolean }).encrypted === true;
}

function publicScheme(req: GuardRequest, forwardedProto: string): "http" | "https" {
  for (const candidate of [forwardedProto, firstHeader(req.headers["x-forwarded-proto"])]) {
    const proto = candidate.split(",")[0]?.trim().toLowerCase() ?? "";
    if (proto === "http" || proto === "https") return proto;
  }
  return socketEncrypted(req.socket) ? "https" : "http";
}

function originOf(scheme: "http" | "https", host: string): string | null {
  try {
    return new URL(`${scheme}://${host}`).origin;
  } catch {
    return null;
  }
}

/** `host` and `proto` from the first element of a `Forwarded` header. */
function forwardedFields(req: GuardRequest): { host: string; proto: string } {
  const first = headerText(req.headers.forwarded).split(",")[0] ?? "";
  let host = "";
  let proto = "";
  for (const part of first.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = unquote(part.slice(eq + 1).trim());
    if (key === "host" && host === "") host = value;
    if (key === "proto" && proto === "") proto = value;
  }
  return { host, proto };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  return value;
}

/** The `token` query parameter, or null when the URL does not carry one. */
function tokenQuery(url: string | undefined): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "/", "https://placeholder.invalid");
  } catch {
    return null;
  }
  if (!parsed.searchParams.has("token")) return null;
  return parsed.searchParams.get("token") ?? "";
}

function firstHeader(value: string | string[] | undefined): string {
  return headerText(value).split(",")[0]?.trim() ?? "";
}

function headerText(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(",");
  return value ?? "";
}

function textOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw.filter((part) => part instanceof Buffer)).toString("utf8");
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return "";
}
