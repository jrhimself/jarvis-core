/**
 * Looking at a picture: what is fetched, from where, and what is refused.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { LookError, seeCamera, seeUrl } from "../dist/vision.js";
import { fakeHome } from "./helpers.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function answer(body: Buffer | string, type: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": type, ...headers } });
}

test("a camera is looked through the house, with the house's credentials", async () => {
  let seen: { url: string; headers: unknown } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(input), headers: init?.headers };
    return answer(PNG, "image/png");
  }) as typeof fetch;

  const result = await seeCamera(fakeHome(), "camera.front");

  assert.equal(result.mimeType, "image/png");
  assert.deepEqual(result.bytes, PNG);
  assert.equal(seen!.url, "https://house.invalid/camera/camera.front");
});

test("a camera that answers with something else is not a picture", async () => {
  globalThis.fetch = (async () => answer("<html>", "text/html")) as typeof fetch;
  await assert.rejects(seeCamera(fakeHome(), "camera.front"), /not an image/);

  globalThis.fetch = (async () => answer("", "text/plain", 503)) as typeof fetch;
  await assert.rejects(seeCamera(fakeHome(), "camera.front"), /answered 503/);
});

test("an address on a private network is never fetched", async () => {
  let fetched = false;
  globalThis.fetch = (async () => {
    fetched = true;
    return answer(PNG, "image/png");
  }) as typeof fetch;

  await assert.rejects(seeUrl("http://192.168.1.1/snapshot.png"), LookError);
  await assert.rejects(seeUrl("http://169.254.169.254/latest/meta-data"), LookError);
  assert.equal(fetched, false);
});

test("a redirect from a public address to a private one is stopped at the hop", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(null, { status: 302, headers: { location: "http://192.168.1.10/secret.png" } });
  }) as typeof fetch;

  await assert.rejects(seeUrl("https://example.com/cat.png"), /private network/);
  assert.deepEqual(calls, ["https://example.com/cat.png"]);
});

test("a public picture is returned, and a redirect between public hosts is followed", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n += 1;
    return n === 1
      ? new Response(null, { status: 301, headers: { location: "https://cdn.example.com/cat.png" } })
      : answer(PNG, "image/png; charset=binary");
  }) as typeof fetch;

  const result = await seeUrl("https://example.com/cat.png");
  assert.equal(result.mimeType, "image/png");
  assert.equal(n, 2);
});

test("a picture that is too large is refused", async () => {
  globalThis.fetch = (async () => answer(Buffer.alloc(5 * 1024 * 1024), "image/jpeg")) as typeof fetch;
  await assert.rejects(seeUrl("https://example.com/huge.jpg"), /too large/);
});
