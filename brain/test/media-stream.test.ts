/**
 * The camera stream relay, against a local server playing the camera.
 *
 * What matters: the page gets the moving picture through an opaque path with
 * the credential left on the brain's side, anything that is not MJPEG is
 * refused rather than passed on, and closing the page lets go of the source.
 */

import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { putStream, serveMedia } from "../dist/media.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** A brain that serves nothing but /media. */
async function brain(): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    if (!serveMedia(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  const port = await listen(server);
  return { port, close: () => server.close() };
}

test("a stream path relays the camera's MJPEG, credential kept on the brain", async () => {
  let seenAuth = "";
  let upstreamClosed = false;
  const camera = createServer((req, res) => {
    seenAuth = req.headers.authorization ?? "";
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    res.write("--frame\r\ncontent-type: image/jpeg\r\n\r\nFRAME1\r\n");
    req.on("close", () => { upstreamClosed = true; });
  });
  const camPort = await listen(camera);
  const hub = await brain();
  try {
    const path = putStream(`http://127.0.0.1:${camPort}/stream`, { Authorization: "Bearer secret" });
    assert.match(path, /^\/media\/live\/[0-9a-f]{32}$/);

    const got = await new Promise<{ type: string; first: string; close: () => void }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: hub.port, path }, (res) => {
        res.once("data", (chunk: Buffer) =>
          resolve({ type: String(res.headers["content-type"]), first: chunk.toString(), close: () => req.destroy() }),
        );
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(got.type, "multipart/x-mixed-replace; boundary=frame");
    assert.match(got.first, /FRAME1/);
    assert.equal(seenAuth, "Bearer secret");

    got.close();
    for (let i = 0; i < 50 && !upstreamClosed; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(upstreamClosed, true, "closing the page lets go of the camera");
  } finally {
    hub.close();
    camera.closeAllConnections();
    camera.close();
  }
});

test("a source that is not a stream is refused, and an unknown path is not found", async () => {
  const camera = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>login</html>");
  });
  const camPort = await listen(camera);
  const hub = await brain();
  try {
    const path = putStream(`http://127.0.0.1:${camPort}/`);
    const refused = await fetch(`http://127.0.0.1:${hub.port}${path}`);
    assert.equal(refused.status, 502);
    await refused.arrayBuffer();

    const missing = await fetch(`http://127.0.0.1:${hub.port}/media/live/${"0".repeat(32)}`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  } finally {
    hub.close();
    camera.close();
  }
});

test("only http and https sources become streams", () => {
  assert.throws(() => putStream("file:///etc/passwd"), /Only http and https/);
});
