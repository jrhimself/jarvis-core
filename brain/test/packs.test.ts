/**
 * The pack loader, and the four ways it is allowed to be disappointed.
 *
 * A worktree has no packs, a fresh checkout has none until `packs-sync` has run,
 * someone's pack throws on the way in, and someone else's is simply not
 * configured on this machine. All four end the same way: the assistant starts, with the tools it
 * does have. That property is the whole reason the loader exists, so it is
 * worth more than one test.
 */

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { PackContext } from "@jarvis/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { forgetVerdicts, noteServer, serverIsDown } from "../dist/health.js";
import { discover, loadPacks, notRunning, withToolTimeout } from "../dist/packs/loader.js";
import { quietly, quietlyAsync, tempDir } from "./helpers.ts";

/** A pack on disk, written as the JavaScript the loader will actually import. */
function writePack(
  root: string,
  name: string,
  body: string,
  manifest: Record<string, unknown> = {},
): string {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "pack.json"),
    JSON.stringify({ name, entry: "index.js", ...manifest }),
  );
  writeFileSync(join(directory, "index.js"), body);
  return directory;
}

/** A pack that registers one server and says where it came from. */
function simplePack(name: string, origin: string, configured = true): string {
  return `export default {
    name: ${JSON.stringify(name)},
    configured: () => ${configured ? "true" : "false"},
    create: () => ({
      servers: { ${JSON.stringify(name)}: { from: ${JSON.stringify(origin)} } },
      tools: [\`mcp__\${${JSON.stringify(name)}}__*\`],
      persona: ${JSON.stringify(`${name} from ${origin}`)},
    }),
  };`;
}

function context(): PackContext {
  return {
    store: null,
    config: {},
    display: () => "id",
    home: null,
    turn: () => null,
  };
}

test("a packs directory that does not exist is not a problem", async () => {
  const result = await loadPacks(join(tempDir(), "nothing-here"), context());

  assert.deepEqual(result.servers, {});
  assert.deepEqual(result.tools, []);
  assert.deepEqual(result.persona, []);
  assert.deepEqual(result.reports, []);
});

test("an empty packs directory is not a problem either", async () => {
  // This is every worktree and every fresh checkout: no pack is in this
  // repository, so the scan finding nothing is the ordinary case and must not
  // be reported as a failure, or the log stops being worth reading.
  const result = await loadPacks(tempDir(), context());
  assert.deepEqual(result.servers, {});
});

test("a directory with no manifest is reported, but not as a broken pack", async () => {
  // Left-behind build output is the case that started all this: it occupies the
  // name of a pack that is gone, so anyone reading `packs/` sees the capability
  // as installed. It is not a failure -- nothing threw -- but it must be sayable.
  const root = tempDir();
  mkdirSync(join(root, "node_modules", "left-behind"), { recursive: true });

  const result = await loadPacks(root, context());

  assert.deepEqual(result.reports, [{ name: "node_modules", state: "unrecognised", reason: "no pack.json" }]);
  assert.equal(
    result.reports.some((report) => report.state === "broken"),
    false,
    "build output is not a broken pack",
  );
});

test("every directory under packs is a pack, whoever wrote it", async () => {
  // There is no first-party half any more: a pack this project publishes and a
  // pack the deployment wrote sit side by side under the same root, and neither
  // is looked up in a list before it is allowed to load.
  const root = tempDir();
  writePack(root, "weather", simplePack("weather", "shipped"));
  writePack(root, "greenhouse", simplePack("greenhouse", "somebody"));

  const found = await discover(root);

  assert.deepEqual(
    found.packs.map((entry) => entry.pack.name).sort(),
    ["greenhouse", "weather"],
  );
  assert.deepEqual(found.broken, []);
});

test("a pack that throws on the way in costs only itself", async () => {
  const root = tempDir();
  writePack(root, "fine", simplePack("fine", "core"));
  writePack(root, "broken", "throw new Error('no');");
  writePack(root, "empty", "export default 42;");

  const result = await quietlyAsync(() => loadPacks(root, context()));

  assert.deepEqual(Object.keys(result.servers), ["fine"], "the healthy pack still starts");
  assert.deepEqual(
    notRunning(result.reports)
      .map((entry) => `${entry.name}:${entry.state}`)
      .sort(),
    ["broken:broken", "empty:broken"],
  );
});

test("a pack that is not configured is skipped, and says so plainly", async () => {
  const root = tempDir();
  writePack(root, "mail", simplePack("mail", "core", false));

  const result = await loadPacks(root, context());

  assert.deepEqual(Object.keys(result.servers), []);
  assert.deepEqual(result.reports, [{ name: "mail", state: "off", reason: "not configured" }]);
});

test("a pack cannot take a server name another pack already has", async () => {
  const root = tempDir();
  // Both claim the server name "house"; the first one keeps it.
  writePack(
    root,
    "a-house",
    `export default { name: "a-house", configured: () => true,
       create: () => ({ servers: { house: { from: "a" } }, tools: [] }) };`,
  );
  writePack(
    root,
    "b-house",
    `export default { name: "b-house", configured: () => true,
       create: () => ({ servers: { house: { from: "b" } }, tools: [] }) };`,
  );

  const result = await loadPacks(root, context());

  assert.deepEqual(result.servers["house"], { from: "a" });
  // The second pack ran; only the server it could not have was refused, which
  // is neither "started" nor "skipped" and used to be reported as both.
  const second = result.reports.find((report) => report.name === "b-house");
  assert.equal(second?.state, "started");
  assert.match(second?.problems?.[0] ?? "", /already registered/);
});

test("a manifest that names a different pack than its directory is refused", async () => {
  const root = tempDir();
  writePack(root, "weather", simplePack("weather", "core"), { name: "somethingelse" });

  const result = await quietlyAsync(() => loadPacks(root, context()));
  const refused = notRunning(result.reports);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.state, "broken");
  assert.match(refused[0]!.reason ?? "", /directory/);
});

test("the persona and the tools come only from the packs that started", async () => {
  const root = tempDir();
  writePack(root, "on", simplePack("on", "core", true));
  writePack(root, "off", simplePack("off", "core", false));

  const result = await loadPacks(root, context());

  assert.deepEqual(result.persona, ["on from core"]);
  assert.equal(
    result.tools.some((pattern) => pattern.includes("off")),
    false,
    "an unconfigured pack pre-approves nothing",
  );
});

test("a pack may compute a block of prompt instead of writing one", async () => {
  const root = tempDir();
  writePack(
    root,
    "house",
    `export default { name: "house", configured: () => true,
       create: () => ({ servers: {}, tools: [], prompt: async () => "twelve hundred things" }) };`,
  );

  const result = await loadPacks(root, context());
  assert.equal(result.blocks.length, 1);
  assert.equal(await result.blocks[0]!(), "twelve hundred things");
});

test("quietly is not hiding a failure here", () => {
  // Guards the tests above: if `quietly` ever stopped restoring the console,
  // every later test would go silent and this one would notice first.
  const said: string[] = [];
  const log = console.log;
  console.log = (line: string) => said.push(line);
  quietly(() => {
    console.log("swallowed");
  });
  console.log("heard");
  console.log = log;
  assert.deepEqual(said, ["heard"]);
});

test("a tool call that never comes back is answered for", async () => {
  // The pack's own handler hangs for ever. What the caller must see is a tool
  // that failed, with the instruction to leave the part out, rather than a turn
  // that never ends -- or a briefing that reports someone else's outage.
  const server = new McpServer({ name: "hangs", version: "1.0.0" });
  server.registerTool(
    "wait",
    { description: "never answers", inputSchema: {} },
    () => new Promise(() => {}),
  );
  withToolTimeout(server, "hangs", 50);

  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  try {
    const result = (await client.callTool({ name: "wait", arguments: {} })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /hangs is unreachable/);
    assert.match(result.content[0]?.text ?? "", /do not mention it/);
  } finally {
    await client.close();
  }
});

test("a server the probes found dead is refused without being asked", async () => {
  // The dependency behind this pack is gone, and the probes already know. The
  // handler must not run at all: what it costs is the wait, and the wait is
  // what makes a greeting take half a minute when three of these are down.
  forgetVerdicts();
  let ran = 0;
  const server = new McpServer({ name: "gone", version: "1.0.0" });
  server.registerTool("ask", { description: "would answer", inputSchema: {} }, () => {
    ran += 1;
    return { content: [{ type: "text" as const, text: "hello" }] };
  });
  withToolTimeout(server, "gone", 50);
  noteServer("gone", "down");

  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  try {
    const result = (await client.callTool({ name: "ask", arguments: {} })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    assert.equal(ran, 0, "the pack's handler never runs");
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /unreachable/);
    assert.match(result.content[0]?.text ?? "", /do not mention it/);
  } finally {
    forgetVerdicts();
    await client.close();
  }
});

test("a server that answers is recorded as up, whatever the probes last thought", async () => {
  // Recovery has to be free. Nothing re-probes between turns on demand, so the
  // answer itself is the evidence, and the next call goes straight through.
  forgetVerdicts();
  const server = new McpServer({ name: "back", version: "1.0.0" });
  server.registerTool("ask", { description: "answers", inputSchema: {} }, () => ({
    content: [{ type: "text" as const, text: "hello" }],
  }));
  withToolTimeout(server, "back", 50);

  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  try {
    await client.callTool({ name: "ask", arguments: {} });
    assert.equal(serverIsDown("back"), false);
  } finally {
    forgetVerdicts();
    await client.close();
  }
});

test("a tool that answers in time is left alone", async () => {
  const server = new McpServer({ name: "quick", version: "1.0.0" });
  server.registerTool("now", { description: "answers", inputSchema: {} }, () => ({
    content: [{ type: "text" as const, text: "here" }],
  }));
  withToolTimeout(server, "quick", 5_000);

  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  try {
    const result = (await client.callTool({ name: "now", arguments: {} })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    assert.notEqual(result.isError, true);
    assert.equal(result.content[0]?.text, "here");
  } finally {
    await client.close();
  }
});
