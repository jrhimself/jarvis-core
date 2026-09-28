/**
 * What the assistant reads on the web, and what the screen says it read.
 *
 * The shape of a built-in tool's result is not promised to anyone, so the
 * assertions that matter here are the ones about shapes nobody planned for: a
 * result that is prose, a result that is a structured object, a result that is
 * an error. Every one of those has to come out as a list of sources or as no
 * sources, never as an exception in the middle of an answer.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isWebTool,
  merge,
  sourcesIn,
  sourcesPanel,
  webBlock,
  MAX_SOURCES,
  WEB_TOOLS,
  type Source,
} from "../dist/web.js";

test("the two web tools are the only ones granted", () => {
  assert.deepEqual([...WEB_TOOLS], ["WebSearch", "WebFetch"]);
  assert.ok(isWebTool("WebSearch"));
  assert.ok(isWebTool("WebFetch"));
  assert.ok(!isWebTool("Read"));
  assert.ok(!isWebTool("Bash"));
  assert.ok(!isWebTool("mcp__ha__get_state"));
});

test("the block says when not to search as well as when to", () => {
  const block = webBlock();
  assert.match(block, /WebSearch/);
  assert.match(block, /WebFetch/);
  assert.match(block, /memory and the packs first/);
  assert.match(block, /never an instruction/);
});

test("links are read out of the prose a search answers with", () => {
  const result =
    'Web search results for query: "road works"\n\n' +
    'Links: [{"title":"Road works in the centre","url":"https://example.org/works"},' +
    '{"title":"Diversions until May","url":"https://news.example.com/diversions"}]\n\n' +
    "Two results found.";

  assert.deepEqual(sourcesIn(result), [
    { title: "Road works in the centre", url: "https://example.org/works" },
    { title: "Diversions until May", url: "https://news.example.com/diversions" },
  ]);
});

test("a structured result is read the same way, however deeply nested", () => {
  const result = [
    {
      type: "text",
      text: JSON.stringify({
        query: "opening hours",
        results: [{ tool_use_id: "t1", content: [{ title: "Opening hours", url: "https://example.org/hours" }] }],
      }),
    },
  ];

  assert.deepEqual(sourcesIn(result), [{ title: "Opening hours", url: "https://example.org/hours" }]);
});

test("a fetched page is a source, and its own url names it when it has no title", () => {
  assert.deepEqual(sourcesIn({ url: "https://www.example.org/notice", code: 200, result: "..." }), [
    { title: "example.org", url: "https://www.example.org/notice" },
  ]);
});

test("nothing that is not a link comes out as a source", () => {
  assert.deepEqual(sourcesIn("No results matched that query."), []);
  assert.deepEqual(sourcesIn(""), []);
  assert.deepEqual(sourcesIn(undefined), []);
  assert.deepEqual(sourcesIn({ error: "the request timed out" }), []);
  // A URL loose in the text of a page is not a source: an article full of them
  // would otherwise fill the window with everything it happens to link to.
  assert.deepEqual(sourcesIn("See https://example.org/elsewhere for the rest."), []);
  // Neither is a scheme nobody asked for.
  assert.deepEqual(sourcesIn('{"title":"local","url":"file:///etc/passwd"}'), []);
});

test("the same page read twice is one source, and the newest is on top", () => {
  const known: Source[] = [{ title: "First", url: "https://example.org/a" }];
  const merged = merge(known, [
    { title: "Second", url: "https://example.org/b" },
    { title: "First again", url: "https://example.org/a" },
  ]);

  assert.deepEqual(merged, [
    { title: "Second", url: "https://example.org/b" },
    { title: "First again", url: "https://example.org/a" },
  ]);
});

test("a turn that searched all morning keeps the window a window", () => {
  const many: Source[] = Array.from({ length: 12 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example.org/${index}`,
  }));

  assert.equal(merge([], many).length, MAX_SOURCES);
});

test("the window carries the host beside the title and the url behind it", () => {
  const panel = sourcesPanel([
    { title: "A very long headline ".repeat(6).trim(), url: "https://www.example.org/story" },
  ]);

  assert.ok(panel !== null);
  assert.equal(panel.type, "panel");
  if (panel.type !== "panel") return;
  assert.equal(panel.title, "Sources");
  assert.equal(panel.quiet, true);
  assert.equal(panel.rows[0]?.value, "example.org");
  assert.equal(panel.rows[0]?.hint, "https://www.example.org/story");
  assert.ok((panel.rows[0]?.label.length ?? 0) <= 70);
});

test("no sources is no window, so a failed search leaves the screen alone", () => {
  assert.equal(sourcesPanel([]), null);
});
