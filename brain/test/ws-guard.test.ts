/**
 * Who may open the HUD websocket.
 *
 * The dangerous client is a browser page on some other origin: it can point
 * the machine's own browser at this port, and the person looking at the page
 * never chose to. A script on the machine sends no Origin and has always been
 * able to connect, so the checks below are written to keep that working until
 * a token is actually configured.
 */

import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import {
  decideUpgrade,
  holdForAuth,
  normalizeOrigin,
  parseAllowedOrigins,
  readAuthFrame,
  revealsWsToken,
  sameToken,
  type GuardRequest,
  type WsGuardPolicy,
} from "../dist/ws-guard.js";
import { quietly } from "./helpers.ts";

const OPEN = { token: "", allowedOrigins: [] as readonly string[] };

function request(partial: {
  origin?: string;
  host?: string;
  referer?: string;
  forwarded?: string;
  forwardedHost?: string;
  forwardedProto?: string;
  url?: string;
  encrypted?: boolean;
}): GuardRequest {
  return {
    url: partial.url ?? "/ws",
    headers: {
      ...(partial.origin === undefined ? {} : { origin: partial.origin }),
      ...(partial.host === undefined ? {} : { host: partial.host }),
      ...(partial.referer === undefined ? {} : { referer: partial.referer }),
      ...(partial.forwarded === undefined ? {} : { forwarded: partial.forwarded }),
      ...(partial.forwardedHost === undefined ? {} : { "x-forwarded-host": partial.forwardedHost }),
      ...(partial.forwardedProto === undefined ? {} : { "x-forwarded-proto": partial.forwardedProto }),
    },
    socket: { encrypted: partial.encrypted === true },
  };
}

test("a browser on this host is accepted, and the default port is not part of the comparison", () => {
  const direct = decideUpgrade(
    request({ origin: "https://hud.example", host: "hud.example", encrypted: true }),
    OPEN,
  );
  const withPort = decideUpgrade(
    request({ origin: "https://hud.example", host: "hud.example:443", encrypted: true }),
    OPEN,
  );

  assert.deepEqual(direct, { accept: true, pendingAuth: false });
  assert.deepEqual(withPort, { accept: true, pendingAuth: false });
});

test("a browser on another origin is refused, token or not", () => {
  const foreign = request({ origin: "https://evil.example", host: "hud.example", encrypted: true });

  assert.deepEqual(decideUpgrade(foreign, OPEN), { accept: false, status: 403, reason: "Forbidden" });
  assert.deepEqual(decideUpgrade(foreign, { token: "s3cret", allowedOrigins: [] }), {
    accept: false,
    status: 403,
    reason: "Forbidden",
  });
  assert.deepEqual(
    decideUpgrade(
      request({
        origin: "https://evil.example",
        host: "hud.example",
        url: "/ws?token=s3cret",
        encrypted: true,
      }),
      { token: "s3cret", allowedOrigins: [] },
    ).accept,
    false,
    "a correct token does not buy a foreign page a session",
  );
});

test("an opaque origin is not this host", () => {
  const decision = decideUpgrade(
    request({ origin: "null", host: "hud.example", encrypted: true }),
    OPEN,
  );

  assert.equal(decision.accept, false);
});

test("a client that sends no Origin is accepted when no token is configured", () => {
  const decision = decideUpgrade(request({ host: "hud.example", encrypted: true }), OPEN);

  assert.deepEqual(decision, { accept: true, pendingAuth: false });
});

test("the same client has to present the token once one is configured", () => {
  const policy: WsGuardPolicy = { token: "s3cret", allowedOrigins: [] };
  const absent = decideUpgrade(request({ host: "hud.example", encrypted: true }), policy);
  const query = decideUpgrade(
    request({ host: "hud.example", url: "/ws?token=s3cret", encrypted: true }),
    policy,
  );
  const wrong = decideUpgrade(
    request({ host: "hud.example", url: "/ws?token=nope", encrypted: true }),
    policy,
  );
  const page = decideUpgrade(
    request({ origin: "https://hud.example", host: "hud.example", encrypted: true }),
    policy,
  );

  assert.deepEqual(absent, { accept: true, pendingAuth: true });
  assert.deepEqual(query, { accept: true, pendingAuth: false });
  assert.deepEqual(wrong, { accept: false, status: 401, reason: "Unauthorized" });
  assert.deepEqual(page, { accept: true, pendingAuth: true }, "the page brings the token on the first frame");
});

test("a token query is decoded once, and a different length is simply wrong", () => {
  const policy: WsGuardPolicy = { token: "a+b/c=", allowedOrigins: [] };
  const encoded = decideUpgrade(
    request({ host: "hud.example", url: "/ws?token=a%2Bb%2Fc%3D", encrypted: true }),
    policy,
  );

  assert.deepEqual(encoded, { accept: true, pendingAuth: false });
  assert.equal(sameToken("short", "s3cret"), false);
  assert.equal(sameToken("s3cret", "s3cret"), true);
});

test("an allowlisted origin is accepted even though it is not this host", () => {
  const policy: WsGuardPolicy = { token: "", allowedOrigins: ["https://tablet.example:8443"] };
  const allowed = decideUpgrade(
    request({ origin: "https://tablet.example:8443", host: "hud.example", encrypted: true }),
    policy,
  );
  const neighbour = decideUpgrade(
    request({ origin: "https://other.example", host: "hud.example", encrypted: true }),
    policy,
  );

  assert.equal(allowed.accept, true);
  assert.equal(neighbour.accept, false);
});

test("a reverse proxy's public host counts as this server", () => {
  const viaHeader = decideUpgrade(
    request({
      origin: "https://hud.example",
      host: "127.0.0.1:8443",
      forwardedHost: "hud.example",
      forwardedProto: "https",
      encrypted: true,
    }),
    OPEN,
  );
  const viaForwarded = decideUpgrade(
    request({
      origin: "https://hud.example",
      host: "127.0.0.1:8443",
      forwarded: 'for=192.0.2.10;host="hud.example";proto=https',
      encrypted: true,
    }),
    OPEN,
  );
  const firstHop = decideUpgrade(
    request({
      origin: "https://hud.example",
      host: "127.0.0.1:8443",
      forwardedHost: "hud.example, proxy.internal",
      forwardedProto: "https, http",
      encrypted: true,
    }),
    OPEN,
  );
  const scheme = decideUpgrade(
    request({
      origin: "http://hud.example",
      host: "127.0.0.1:8443",
      forwardedHost: "hud.example",
      forwardedProto: "https",
      encrypted: true,
    }),
    OPEN,
  );

  assert.equal(viaHeader.accept, true);
  assert.equal(viaForwarded.accept, true);
  assert.equal(firstHop.accept, true);
  assert.equal(scheme.accept, false, "the public scheme is part of the origin");
});

test("an http page is not the https server it was loaded beside", () => {
  const decision = decideUpgrade(
    request({ origin: "http://hud.example", host: "hud.example", encrypted: true }),
    OPEN,
  );

  assert.equal(decision.accept, false);
});

test("the allowlist is a list of origins, and a typo is not an open gate", () => {
  const parsed = quietly(() => parseAllowedOrigins(" https://HUD.Example:443 , ,not-a-url, https://tablet.example "));

  assert.deepEqual(parsed, ["https://hud.example", "https://tablet.example"]);
  assert.equal(normalizeOrigin("null"), null);
  assert.equal(normalizeOrigin("javascript:alert(1)"), null);
});

test("the configuration response carries the token only back to this server", () => {
  const policy: WsGuardPolicy = { token: "s3cret", allowedOrigins: ["https://tablet.example"] };
  const page = request({ origin: "https://hud.example", host: "hud.example", encrypted: true });
  const refererOnly = request({
    referer: "https://hud.example/desk",
    host: "hud.example",
    encrypted: true,
  });
  const curl = request({ host: "hud.example", encrypted: true });
  const foreign = request({ origin: "https://evil.example", host: "hud.example", encrypted: true });
  const listed = request({ origin: "https://tablet.example", host: "hud.example", encrypted: true });

  assert.equal(revealsWsToken(page, policy), true);
  assert.equal(revealsWsToken(refererOnly, policy), true);
  assert.equal(revealsWsToken(curl, policy), false);
  assert.equal(revealsWsToken(foreign, policy), false);
  assert.equal(revealsWsToken(listed, policy), true);
  assert.equal(revealsWsToken(page, OPEN), false);
});

test("an auth frame is a token and nothing else", () => {
  assert.equal(readAuthFrame({ kind: "auth", token: "s3cret" }), "s3cret");
  assert.equal(readAuthFrame({ kind: "auth", token: "" }), null);
  assert.equal(readAuthFrame({ kind: "say", text: "hi", turnId: "t", token: "s3cret" }), null);
  assert.equal(readAuthFrame(null), null);
});

interface Guarded {
  port: number;
  close: () => Promise<void>;
}

/** A socket that applies the same decision the brain does, and then stops. */
async function guarded(policy: WsGuardPolicy): Promise<Guarded> {
  const server = createServer();
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, done) => {
      const decision = decideUpgrade(info.req as GuardRequest, policy);
      if (!decision.accept) {
        done(false, decision.status, decision.reason);
        return;
      }
      done(true);
    },
  });
  wss.on("connection", (socket, req) => {
    const decision = decideUpgrade(req as GuardRequest, policy);
    if (!decision.accept) {
      socket.close(1008);
      return;
    }
    if (decision.pendingAuth) {
      holdForAuth(socket, policy.token, () => socket.send("ready"), 300);
      return;
    }
    socket.send("ready");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

interface Opened {
  ws: WebSocket;
  /** The next message, including one that arrived before the caller asked. */
  next: () => Promise<string>;
  closed: Promise<number>;
}

function clientOptions(headers?: Record<string, string>): { origin?: string; headers: Record<string, string> } {
  const rest: Record<string, string> = {};
  let origin: string | undefined;
  if (headers !== undefined) {
    for (const [key, value] of Object.entries(headers)) {
      if (key === "origin") origin = value;
      else rest[key] = value;
    }
  }
  return { origin, headers: rest };
}

/**
 * A client that is already listening when the handshake completes.
 *
 * The server pushes its first message from the connection handler, which is
 * before the `open` event this function returns on. Subscribing afterwards
 * misses it, and the test waits forever.
 */
function opened(url: string, headers?: Record<string, string>): Promise<Opened> {
  const ws = new WebSocket(url, clientOptions(headers));
  const queue: string[] = [];
  const waiters: Array<(text: string) => void> = [];
  ws.on("message", (raw) => {
    const text = raw.toString();
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(text);
    else queue.push(text);
  });
  const closed = once(ws, "close").then(([code]) => code as number);
  const next = (): Promise<string> => {
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`no handshake for ${url}`));
    }, 2000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve({ ws, next, closed });
    });
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      res.resume();
      ws.terminate();
      reject(new Error(`status ${res.statusCode ?? 0}`));
    });
    ws.on("error", () => {
      // A refused handshake emits this as well as unexpected-response.
    });
  });
}

function statusOf(url: string, headers?: Record<string, string>): Promise<number> {
  const ws = new WebSocket(url, clientOptions(headers));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("handshake hung"));
    }, 2000);
    ws.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
      resolve(status);
    });
    ws.once("open", () => {
      clearTimeout(timer);
      ws.terminate();
      reject(new Error("the handshake was accepted"));
    });
    ws.on("error", () => {
      // Follows unexpected-response. The status above is the result.
    });
  });
}

async function untilClose(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("the handshake refuses a foreign browser and accepts this host", async () => {
  const site = await guarded(OPEN);
  try {
    const refused = await statusOf(`ws://127.0.0.1:${site.port}/ws`, { origin: "https://evil.example" });
    assert.equal(refused, 403);

    const client = await opened(`ws://127.0.0.1:${site.port}/ws`, {
      origin: `http://127.0.0.1:${site.port}`,
    });
    assert.equal(await client.next(), "ready");
    client.ws.close();
  } finally {
    await site.close();
  }
});

test("a proxy that names the public host is this server on the wire", async () => {
  const site = await guarded(OPEN);
  try {
    const client = await opened(`ws://127.0.0.1:${site.port}/ws`, {
      origin: "https://hud.example",
      "x-forwarded-host": "hud.example",
      "x-forwarded-proto": "https",
    });
    assert.equal(await client.next(), "ready");
    client.ws.close();
  } finally {
    await site.close();
  }
});

test("a token on the query or the first frame is accepted, and a wrong one is not", async () => {
  const policy: WsGuardPolicy = { token: "s3cret", allowedOrigins: [] };
  const site = await guarded(policy);
  try {
    assert.equal(await statusOf(`ws://127.0.0.1:${site.port}/ws?token=nope`), 401);

    const queried = await opened(`ws://127.0.0.1:${site.port}/ws?token=${encodeURIComponent("s3cret")}`);
    assert.equal(await queried.next(), "ready");
    queried.ws.close();

    const framed = await opened(`ws://127.0.0.1:${site.port}/ws`);
    framed.ws.send(JSON.stringify({ kind: "auth", token: "s3cret" }));
    assert.equal(await framed.next(), "ready");
    framed.ws.close();

    const wrong = await opened(`ws://127.0.0.1:${site.port}/ws`);
    wrong.ws.send(JSON.stringify({ kind: "say", text: "hi", turnId: "t" }));
    assert.equal(await wrong.closed, 1008);
  } finally {
    await site.close();
  }
});

test("a socket that never presents the token is closed", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (socket) => holdForAuth(socket, "s3cret", () => assert.fail("authorized"), 40));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const client = await opened(`ws://127.0.0.1:${port}/ws`);
    assert.equal(await client.closed, 1008);
  } finally {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await untilClose(server);
  }
});
