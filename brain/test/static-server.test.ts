/**
 * Serving the HUD.
 *
 * The HUD is reachable over Tailscale, so the file server is the one part of
 * this that faces anything. What matters is that a request cannot walk out of
 * the directory it is given, whichever way it is spelled.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createStaticHandler } from "../dist/static-server.js";
import { tempDir } from "./helpers.ts";

/** A file server over a temp directory, plus the secret sitting next to it. */
async function serving(): Promise<{
  get: (path: string, method?: string, redirect?: RequestRedirect) => Promise<Response>;
  close: () => Promise<void>;
}> {
  const base = tempDir();
  const root = join(base, "public");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>hud</h1>");
  writeFileSync(join(root, "app.js"), "export const x = 1;");
  writeFileSync(join(root, "sub", "index.html"), "<h1>sub</h1>");
  writeFileSync(join(base, "secret.txt"), "ha token");

  const handler = createStaticHandler(root);
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    get: (path, method = "GET", redirect = "follow") =>
      fetch(`http://127.0.0.1:${port}${path}`, { method, redirect }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("the root serves the HUD", async () => {
  const site = await serving();
  try {
    const response = await site.get("/");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(await response.text(), "<h1>hud</h1>");
  } finally {
    await site.close();
  }
});

test("a directory serves its index", async () => {
  const site = await serving();
  try {
    const response = await site.get("/sub/");
    assert.equal(await response.text(), "<h1>sub</h1>");
  } finally {
    await site.close();
  }
});

test("a directory without its slash is sent to it, so relative links resolve", async () => {
  const site = await serving();
  try {
    const response = await site.get("/sub?t=1", "GET", "manual");
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), "/sub/?t=1");
  } finally {
    await site.close();
  }
});

test("content types follow the extension", async () => {
  const site = await serving();
  try {
    const response = await site.get("/app.js");
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
  } finally {
    await site.close();
  }
});

test("a HEAD gives the headers and no body", async () => {
  const site = await serving();
  try {
    const response = await site.get("/index.html", "HEAD");

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), "12");
    assert.equal(await response.text(), "");
  } finally {
    await site.close();
  }
});

test("nothing may climb out of the root, however it is spelled", async () => {
  const site = await serving();
  try {
    for (const path of [
      "/../secret.txt",
      "/sub/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/..%2Fsecret.txt",
      "/....//secret.txt",
      "/%2e%2e%2f%2e%2e%2fetc/passwd",
    ]) {
      const response = await site.get(path);
      const body = await response.text();

      assert.ok(
        response.status === 400 || response.status === 404,
        `${path} answered ${response.status}`,
      );
      assert.ok(!body.includes("ha token"), `${path} leaked the file next to the root`);
    }
  } finally {
    await site.close();
  }
});

test("a null byte and a broken escape are refused", async () => {
  const site = await serving();
  try {
    assert.equal((await site.get("/index.html%00.png")).status, 400);
    assert.equal((await site.get("/%zz")).status, 400);
  } finally {
    await site.close();
  }
});

test("anything but a read is refused", async () => {
  const site = await serving();
  try {
    for (const method of ["POST", "PUT", "DELETE"]) {
      assert.equal((await site.get("/index.html", method)).status, 405);
    }
  } finally {
    await site.close();
  }
});

test("a file that is not there is a plain 404", async () => {
  const site = await serving();
  try {
    assert.equal((await site.get("/nope.js")).status, 404);
  } finally {
    await site.close();
  }
});
