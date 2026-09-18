/**
 * The one way in for a machine that has something to say.
 *
 * Everything else the brain hears arrives over a conversation or a poll: the
 * HUD's websocket, the Telegram long poll, the timers. A runner on another
 * machine has neither. It falls quiet at an unpredictable moment, and the only
 * two parties who know it happened are the shell hook that noticed and the
 * machine that has to decide what it means.
 *
 * Polling was the alternative and is worse in both directions: it asks about
 * slots that are not running, and it hears about the ones that are minutes
 * after the fact. So this is a doorbell -- one path, one method, one bearer
 * token -- and no reply worth waiting for. The verdict goes to Telegram; the
 * caller gets an acknowledgement and hangs up.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { RunnerReport } from "./runners.js";

/** A pane of terminal output and a brief; anything larger is not a report. */
const MAX_BYTES = 256 * 1024;

const PATH = "/runner/report";

/** Compares without leaking where two tokens start to differ. */
function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The bearer token on a request, or the empty string when there is none. */
function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? "";
}

/** Reads a request body, refusing anything oversized rather than buffering it. */
function body(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/** Whether a parsed body is the report it claims to be. */
export function readReport(payload: unknown): RunnerReport | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as { slot?: unknown; task?: unknown; tail?: unknown };
  const slot = value.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0) return null;
  if (typeof value.task !== "string" || typeof value.tail !== "string") return null;
  if (value.tail.trim() === "") return null;
  return { slot, task: value.task, tail: value.tail };
}

/**
 * Serves the doorbell, and says whether it took the request.
 *
 * An empty token leaves the route off altogether rather than open: a deployment
 * that never set one has no runners to hear from, and a 404 is the honest
 * answer to a path that does nothing here.
 */
export function serveRunnerReport(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  onReport: (report: RunnerReport) => void,
): boolean {
  const path = (req.url ?? "").split("?")[0];
  if (path !== PATH) return false;
  if (token === "") return false;

  if (req.method !== "POST") {
    res.writeHead(405, { allow: "POST" });
    res.end("Method not allowed");
    return true;
  }

  if (!sameToken(bearer(req), token)) {
    res.writeHead(401);
    res.end("Unauthorized");
    return true;
  }

  void body(req).then((text) => {
    if (text === null) {
      if (!res.headersSent) {
        res.writeHead(413);
        res.end("Too large");
      }
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      res.writeHead(400);
      res.end("Not JSON");
      return;
    }

    const report = readReport(payload);
    if (report === null) {
      res.writeHead(400);
      res.end("Not a report");
      return;
    }

    // Answered before the model is asked anything: judging takes seconds, and
    // the hook that rang this bell is holding up a finished turn until it hears
    // back.
    res.writeHead(202);
    res.end("Accepted");
    onReport(report);
  });

  return true;
}
