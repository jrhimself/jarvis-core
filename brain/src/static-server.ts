/**
 * Minimal static file server for the HUD.
 *
 * Deliberately dependency-free: the HUD is a handful of files served to a single
 * household, so a framework would be more moving parts than the job needs.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/**
 * Resolves a request URL to a path inside `root`, or null when the request
 * tries to escape the root directory.
 */
function resolveWithinRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }

  if (decoded.includes("\0")) return null;

  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const candidate = join(root, relative);

  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createStaticHandler(root: string) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method not allowed");
      return;
    }

    const urlPath = new URL(req.url ?? "/", "https://placeholder.invalid").pathname;
    const resolved = resolveWithinRoot(root, urlPath === "/" ? "/index.html" : urlPath);
    if (resolved === null) {
      send(res, 400, "Bad request");
      return;
    }

    let target = resolved;
    try {
      const info = await stat(target);
      if (info.isDirectory()) target = join(target, "index.html");
    } catch {
      send(res, 404, "Not found");
      return;
    }

    let size: number;
    try {
      const info = await stat(target);
      if (!info.isFile()) {
        send(res, 404, "Not found");
        return;
      }
      size = info.size;
    } catch {
      send(res, 404, "Not found");
      return;
    }

    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      "content-length": size,
      // The HUD is iterated on constantly; stale caches cost more than the bytes.
      "cache-control": "no-cache",
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = createReadStream(target);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
}
