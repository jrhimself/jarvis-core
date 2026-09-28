/**
 * Short-lived store for images the HUD is allowed to show.
 *
 * The browser never fetches a source directly. Everything is pulled here first —
 * with whatever credentials that source needs — and handed to the page as an
 * opaque path. That keeps the Home Assistant token server-side, and means the HUD
 * cannot be talked into fetching an arbitrary host by a stray tool argument.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/** How long a fetched image stays available to the page. */
const TTL_MS = 10 * 60 * 1000;
/** Refuse anything larger; a camera still is tens of kilobytes. */
const MAX_BYTES = 8 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

interface StoredMedia {
  bytes: Buffer;
  mimeType: string;
  expiresAt: number;
}

const store = new Map<string, StoredMedia>();

/** How long a stream link can be opened after it was handed out. */
const STREAM_TTL_MS = 10 * 60 * 1000;
/** How long one viewing of a stream lasts before the brain lets go of it. */
const STREAM_MAX_MS = 15 * 60 * 1000;

/**
 * A camera's moving picture, by reference: the page gets an opaque path, the
 * brain holds the source and its credentials, and nothing is fetched until
 * the page opens the path. Like a still, the token never reaches the browser.
 */
interface StoredStream {
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

const streams = new Map<string, StoredStream>();

function evictExpired(): void {
  const now = Date.now();
  for (const [id, item] of store) {
    if (item.expiresAt <= now) store.delete(id);
  }
  for (const [id, item] of streams) {
    if (item.expiresAt <= now) streams.delete(id);
  }
}

/** Stores bytes and returns the path the HUD should request. */
export function putMedia(bytes: Buffer, mimeType: string): string {
  evictExpired();
  const id = randomUUID().replaceAll("-", "");
  store.set(id, { bytes, mimeType, expiresAt: Date.now() + TTL_MS });
  return `/media/${id}`;
}

/** Registers a stream source and returns the path the HUD should open. */
export function putStream(source: string, headers: Record<string, string> = {}): string {
  const parsed = new URL(source);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MediaFetchError(`Only http and https sources are allowed, got ${parsed.protocol}`);
  }
  evictExpired();
  const id = randomUUID().replaceAll("-", "");
  streams.set(id, { url: parsed.href, headers, expiresAt: Date.now() + STREAM_TTL_MS });
  return `/media/live/${id}`;
}

export class MediaFetchError extends Error {}

/**
 * Fetches an image and stores it. Only http(s) sources are accepted — no file://
 * or data: — and the response must actually be an image.
 */
export async function fetchAndStore(
  source: string,
  headers: Record<string, string> = {},
): Promise<{ url: string; mimeType: string; bytes: number }> {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new MediaFetchError(`Not a usable address: ${source}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MediaFetchError(`Only http and https sources are allowed, got ${parsed.protocol}`);
  }

  const response = await fetch(parsed, {
    headers,
    signal: AbortSignal.timeout(10_000),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new MediaFetchError(`Source returned ${response.status} ${response.statusText}`);
  }

  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!ALLOWED_MIME.has(mimeType)) {
    throw new MediaFetchError(`Source is not an image (content-type: ${mimeType || "none"})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) {
    throw new MediaFetchError(`Image is too large: ${bytes.byteLength} bytes`);
  }

  return { url: putMedia(bytes, mimeType), mimeType, bytes: bytes.byteLength };
}

/**
 * Relays a stream to the page for as long as the page holds it open.
 *
 * The upstream request ends with the page's: a window that is closed stops
 * the camera being pulled. A viewing is capped as well, so a tab left open on
 * the door does not keep the brain streaming all night. Only an MJPEG answer
 * is passed on; anything else is a 502, and the page falls back to the still.
 */
async function serveStream(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  const item = streams.get(id);
  if (item === undefined || item.expiresAt <= Date.now()) {
    streams.delete(id);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const abort = new AbortController();
  const stop = (): void => abort.abort();
  res.on("close", stop);
  const cap = setTimeout(stop, STREAM_MAX_MS);
  try {
    const upstream = await fetch(item.url, { headers: item.headers, signal: abort.signal });
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.startsWith("multipart/x-mixed-replace") || upstream.body === null) {
      abort.abort();
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("No stream");
      return;
    }
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    if (req.method === "HEAD") {
      abort.abort();
      res.end();
      return;
    }
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((resolve) => res.once("drain", resolve));
    }
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end();
  } finally {
    clearTimeout(cap);
    res.off("close", stop);
  }
}

/** Serves a stored image or stream. Returns false when the request is not for /media. */
export function serveMedia(req: IncomingMessage, res: ServerResponse): boolean {
  const path = new URL(req.url ?? "/", "https://placeholder.invalid").pathname;
  if (!path.startsWith("/media/")) return false;

  if (path.startsWith("/media/live/")) {
    void serveStream(req, res, path.slice("/media/live/".length));
    return true;
  }

  const id = path.slice("/media/".length);
  const item = store.get(id);

  if (item === undefined || item.expiresAt <= Date.now()) {
    store.delete(id);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return true;
  }

  res.writeHead(200, {
    "content-type": item.mimeType,
    "content-length": item.bytes.byteLength,
    "cache-control": "no-store",
  });
  res.end(req.method === "HEAD" ? undefined : item.bytes);
  return true;
}
