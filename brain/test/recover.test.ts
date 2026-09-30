/**
 * Recovering a page that would not load.
 *
 * Most of what is tested is the refusal to be fooled: the routes that answer
 * 200 with something that is not the page.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { apiHints, genuine, htmlToText, recoverPage, renderRecovery } from "../dist/recover.js";

const ARTICLE = `<html><head><title>The real story</title><script>var x=1</script></head><body>
  <h1>The real story</h1>${"<p>A paragraph with words in it, long enough to count as content.</p>".repeat(12)}
</body></html>`;

test("html is reduced to its words", () => {
  const { title, text } = htmlToText("<html><head><title> A &amp; B </title><style>p{}</style></head><body><p>One</p><p>Two &lt;3</p></body></html>");
  assert.equal(title, "A & B");
  assert.equal(text, "One\nTwo <3");
});

test("interstitials, redirect stubs and thin pages are not the page", () => {
  assert.equal(genuine("<title>Just a moment...</title><body>" + "x ".repeat(500), "news.example").ok, false);
  assert.equal(genuine("<title>Google Search</title><body>" + "x ".repeat(500), "news.example").ok, false);
  const stub = '<html><head><meta http-equiv="refresh" content="0; url=https://news.example/a"></head><body>Redirecting</body></html>';
  const verdict = genuine(stub, "news.example");
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok ? "" : verdict.why, /back to the blocked address/);
  assert.equal(genuine("<title>Ok</title><body>short", "news.example").ok, false);
  assert.equal(genuine(ARTICLE, "news.example").ok, true);
});

function fetcher(routes: Record<string, { status: number; body: string } | Error>) {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (url: string) => {
      asked.push(url);
      const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
      if (hit === undefined) return { status: 404, body: "" };
      if (hit[1] instanceof Error) throw hit[1];
      return hit[1];
    },
  };
}

test("the Wayback copy comes first, dated, and archive.today is not asked", async () => {
  const deps = fetcher({
    "https://archive.org/wayback/available": {
      status: 200,
      body: JSON.stringify({ archived_snapshots: { closest: { available: true, url: "http://web.archive.org/web/20260301120000/https://news.example/a", timestamp: "20260301120000" } } }),
    },
    "https://web.archive.org/web/": { status: 200, body: ARTICLE },
  });

  const result = await recoverPage("https://news.example/a", deps);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.found.route, "wayback");
  assert.equal(result.found.capturedAt, "2026-03-01 12:00 UTC");
  assert.equal(result.found.provenance, "snapshot");
  assert.equal(deps.asked.some((url) => url.includes("archive.ph")), false);
  const told = renderRecovery(result, false);
  assert.match(told, /archived copy, not the live page/);
  assert.match(told, /captured: 2026-03-01/);
});

test("a copy that is an impostor is skipped for the next route", async () => {
  const deps = fetcher({
    "https://archive.org/wayback/available": { status: 200, body: JSON.stringify({ archived_snapshots: {} }) },
    "https://archive.ph/": { status: 200, body: "<title>Attention Required</title>" + "x ".repeat(600) },
    "https://archive.md/": { status: 429, body: "<html>rate limited" },
    "https://archive.li/": new Error("timed out"),
    "https://archive.is/": { status: 200, body: ARTICLE },
  });

  const result = await recoverPage("https://news.example/a", deps);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.found.route, "archive.today");
  assert.equal(result.found.capturedAt, null);
  assert.deepEqual(
    result.tried.map((line) => line.split(":")[0]),
    ["wayback", "archive.ph", "archive.md", "archive.li"],
  );
});

test("when nothing works the answer says what was tried and where else to look", async () => {
  const result = await recoverPage("https://news.example/2026/story", fetcher({}));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.hints.includes("https://news.example/feed"));
  assert.ok(result.hints.includes("https://news.example/2026/story.json"));

  assert.match(renderRecovery(result, true), /browser tool can open the live page/);
  assert.match(renderRecovery(result, false), /say plainly that the page could not be read/);
});

test("a private address is not looked up anywhere", async () => {
  const deps = fetcher({});
  const result = await recoverPage("http://192.168.1.5/page", deps);
  assert.equal(result.ok, false);
  assert.deepEqual(deps.asked, []);
});

test("hints for a bare host do not invent a page path", () => {
  assert.deepEqual(apiHints(new URL("https://news.example/")), [
    "https://news.example/feed",
    "https://news.example/rss",
    "https://news.example/feed.xml",
    "https://news.example/sitemap.xml",
  ]);
});
