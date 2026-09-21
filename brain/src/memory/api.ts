/**
 * A small JSON API over the memory store, for the HUD's memory panel.
 *
 * Same shape as the media handler: a plain `node:http` function that returns
 * false when the request is not ours, so the server can fall through to the
 * static files. Nothing here is a framework route table — there are a handful of
 * endpoints and they fit in one file.
 *
 * What the panel is allowed to do is decided server-side by `memoryPanel`. In
 * "off" the memory routes answer 404, so a page that asks anyway learns
 * nothing; in "read" the writing routes answer 403.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Config } from "../config.js";
import type { Fact, MemoryStore } from "./store.js";
import { index } from "./tools.js";

/** Longest fact body the panel may write. Facts are single sentences. */
const MAX_BODY_LENGTH = 400;
/** Most facts a single listing returns. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;
/** Refuse request bodies larger than this outright; a patch is a few hundred bytes. */
const MAX_REQUEST_BYTES = 16 * 1024;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Reads the request body, refusing anything oversized. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new PayloadError("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class PayloadError extends Error {}

interface Patch {
  body?: string;
  core?: boolean;
}

/** Turns a raw request body into a patch, or returns the reason it is not one. */
function parsePatch(raw: string): Patch | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw === "" ? "null" : raw);
  } catch {
    return { error: "Body must be valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Body must be a JSON object" };
  }

  const input = parsed as Record<string, unknown>;
  const patch: Patch = {};

  if (input.body !== undefined) {
    if (typeof input.body !== "string") return { error: "body must be a string" };
    const trimmed = input.body.trim();
    if (trimmed === "") return { error: "body must not be empty" };
    if (trimmed.length > MAX_BODY_LENGTH) {
      return { error: `body must be at most ${MAX_BODY_LENGTH} characters` };
    }
    patch.body = trimmed;
  }

  if (input.core !== undefined) {
    if (typeof input.core !== "boolean") return { error: "core must be a boolean" };
    patch.core = input.core;
  }

  if (patch.body === undefined && patch.core === undefined) {
    return { error: "Nothing to update: expected body or core" };
  }
  return patch;
}

/** Parses a positive integer path segment. Returns null when it is not one. */
function parseId(segment: string): number | null {
  if (!/^\d+$/.test(segment)) return null;
  const id = Number(segment);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Start of a window, as the ISO instant the rows are stamped with. */
function since(days: number): string {
  const from = new Date();
  if (days === 0) {
    // Today means since local midnight, which is the day a person means.
    from.setHours(0, 0, 0, 0);
  } else {
    from.setTime(from.getTime() - days * 24 * 60 * 60 * 1000);
  }
  return from.toISOString();
}

/**
 * What the model has cost lately.
 *
 * Three windows because they answer different questions: today for "is something
 * running away with it", a week for the shape of normal use, a month for the
 * quota. Recent rows come along so a single slow turn can be looked at.
 */
function handleUsage(res: ServerResponse, store: MemoryStore, url: URL): void {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit !== null && /^\d+$/.test(rawLimit) ? Math.min(Number(rawLimit), MAX_LIMIT) : 20;

  sendJson(res, 200, {
    today: store.usageTotals(since(0)),
    week: store.usageTotals(since(7)),
    month: store.usageTotals(since(30)),
    recent: store.usageRecent(limit),
  });
}

function handleList(res: ServerResponse, store: MemoryStore, url: URL): void {
  const rawLimit = url.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;

  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      sendError(res, 400, "limit must be a positive whole number");
      return;
    }
    limit = Math.min(Number(rawLimit), MAX_LIMIT);
  }

  const query = (url.searchParams.get("query") ?? "").trim();
  const facts: Fact[] = query === "" ? store.all(limit) : store.search(query, limit);

  sendJson(res, 200, { facts, counts: store.counts() });
}

async function handlePatch(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  id: number,
): Promise<void> {
  const patch = parsePatch(await readBody(req));
  if ("error" in patch) {
    sendError(res, 400, patch.error);
    return;
  }

  const existing = store.byId(id);
  if (existing === null) {
    sendError(res, 404, `No fact with id ${id}`);
    return;
  }

  // Both writes address the fact by id, so a duplicate subject cannot misdirect
  // the update and a demotion keeps the id, the creation date and the hit count.
  let updated = existing;
  if (patch.body !== undefined && patch.body !== existing.body) {
    const result = store.setBody(id, patch.body);
    if (result === null) {
      sendError(res, 404, `No fact with id ${id}`);
      return;
    }
    // Rewriting a fact in the panel is the owner saying it was written down wrong.
    // The distiller reads these back, so the same mistake is not made twice.
    store.recordCorrection({ action: "rewritten", fact: existing, after: patch.body });
    updated = result;
  }
  if (patch.core !== undefined && patch.core !== existing.core) {
    const result = store.setCore(id, patch.core);
    if (result === null) {
      sendError(res, 404, `No fact with id ${id}`);
      return;
    }
    updated = result;
  }

  sendJson(res, 200, updated);
}

/** How a fact used to read, newest wording first. */
function handleRevisions(res: ServerResponse, store: MemoryStore, id: number): void {
  if (store.byId(id) === null && store.revisions(id).length === 0) {
    sendError(res, 404, `No fact with id ${id}`);
    return;
  }
  sendJson(res, 200, { revisions: store.revisions(id) });
}

function handleRestore(res: ServerResponse, store: MemoryStore, revisionId: number): void {
  const restored = store.restore(revisionId);
  if (restored === null) {
    sendError(res, 404, `No revision with id ${revisionId}`);
    return;
  }
  // A restored wording is a different sentence, so its vector no longer matches.
  index(store, restored);
  sendJson(res, 200, restored);
}

function handleDelete(res: ServerResponse, store: MemoryStore, id: number): void {
  const existing = store.byId(id);
  if (existing === null || !store.forget(id)) {
    sendError(res, 404, `No fact with id ${id}`);
    return;
  }
  store.recordCorrection({ action: "deleted", fact: existing });
  sendJson(res, 200, { ok: true });
}

/**
 * Serves the memory API. Returns false when the request is not for /api, in
 * which case nothing has been written to the response.
 */
export function serveMemoryApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemoryStore,
  config: Config,
): boolean {
  const url = new URL(req.url ?? "/", "https://placeholder.invalid");
  const path = url.pathname.replace(/\/+$/, "");

  if (path === "/api/config") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "Method not allowed");
      return true;
    }
    sendJson(res, 200, {
      memoryPanel: config.memoryPanel,
      voiceTimbre: config.voiceTimbre,
      speechLang: config.speechLang,
    });
    return true;
  }

  if (path === "/api/usage") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 405, "Method not allowed");
      return true;
    }
    handleUsage(res, store, url);
    return true;
  }

  if (path !== "/api/memory" && !path.startsWith("/api/memory/")) return false;

  // In "off" the feature does not exist as far as the network is concerned.
  if (config.memoryPanel === "off") {
    sendError(res, 404, "Not found");
    return true;
  }

  const run = async (): Promise<void> => {
    if (path === "/api/memory") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "Method not allowed");
        return;
      }
      handleList(res, store, url);
      return;
    }

    const segment = path.slice("/api/memory/".length);

    // What is left of facts that no longer exist. They have no id to ask about,
    // so this cannot be a sub-route of one.
    if (segment === "deleted") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "Method not allowed");
        return;
      }
      sendJson(res, 200, { revisions: store.orphanRevisions() });
      return;
    }

    const revisions = /^(\d+)\/revisions$/.exec(segment);
    if (revisions !== null) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "Method not allowed");
        return;
      }
      handleRevisions(res, store, Number(revisions[1]));
      return;
    }

    const restore = /^revisions\/(\d+)\/restore$/.exec(segment);
    if (restore !== null) {
      if (req.method !== "POST") {
        sendError(res, 405, "Method not allowed");
        return;
      }
      if (config.memoryPanel === "read") {
        sendError(res, 403, "The memory panel is read-only");
        return;
      }
      handleRestore(res, store, Number(restore[1]));
      return;
    }

    if (segment.includes("/")) {
      sendError(res, 404, "Not found");
      return;
    }

    if (req.method !== "PATCH" && req.method !== "DELETE") {
      sendError(res, 405, "Method not allowed");
      return;
    }
    if (config.memoryPanel === "read") {
      sendError(res, 403, "The memory panel is read-only");
      return;
    }

    const id = parseId(segment);
    if (id === null) {
      sendError(res, 400, "Fact id must be a positive whole number");
      return;
    }

    if (req.method === "PATCH") {
      await handlePatch(req, res, store, id);
    } else {
      handleDelete(res, store, id);
    }
  };

  run().catch((error: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof PayloadError) {
      sendError(res, 413, error.message);
      return;
    }
    console.error("Memory API request failed:", error);
    sendError(res, 500, "Something went wrong");
  });

  return true;
}
