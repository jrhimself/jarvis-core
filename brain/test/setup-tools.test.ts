/**
 * The tool that answers "how are you actually set up".
 *
 * The prompt already carries the record; the tool exists for the half the
 * prompt cannot have, which is whether the things it names answer right now.
 * So the properties worth holding are that the two cannot disagree, and that a
 * check which itself failed reads as a failure rather than as good news.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { describeDeployment, deploymentBlock, type Deployment } from "../dist/deployment.js";
import type { HealthCheck } from "../dist/health.js";
import { loadConfig } from "../dist/config.js";
import { createSetupServer } from "../dist/setup-tools.js";
import { tempDir, withEnv } from "./helpers.ts";

function record(): Deployment {
  return withEnv(
    { HA_URL: undefined, HA_TOKEN: undefined, ELEVENLABS_API_KEY: undefined },
    () => describeDeployment(loadConfig(), [], ["display", "memory", "setup"], true, tempDir()),
  );
}

/** Calls the one tool and hands back what it said. */
async function ask(
  deployment: Deployment,
  probe: () => Promise<readonly HealthCheck[]>,
): Promise<string> {
  const server = createSetupServer(deployment, probe);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.instance.connect(serverSide), client.connect(clientSide)]);
  try {
    const result = (await client.callTool({ name: "my_setup", arguments: {} })) as {
      content: Array<{ text?: string }>;
    };
    return result.content[0]?.text ?? "";
  } finally {
    await client.close();
  }
}

test("the tool answers with the same record the prompt carries", async () => {
  // The whole reason it takes the record rather than building one: two sources
  // for the same facts is two answers to the same question, eventually.
  const deployment = record();
  const said = await ask(deployment, async () => []);

  assert.ok(said.startsWith(deploymentBlock(deployment)));
});

test("a dependency that did not answer is reported as unreachable, loudly", async () => {
  const said = await ask(record(), async () => [
    { server: "memory", state: "ok", detail: "database antwoordt", ms: 2 },
    { server: "house", state: "down", detail: "connect ECONNREFUSED", ms: 41, pack: true },
  ]);

  assert.match(said, /memory: answered in 2ms -- database antwoordt/);
  assert.match(said, /house \(pack\): DID NOT ANSWER in 41ms -- connect ECONNREFUSED/);
  assert.match(said, /configured but unreachable, which is a different/);
});

test("a check that could not be run does not read as a healthy one", async () => {
  const said = await ask(record(), async () => {
    throw new Error("the store was closed");
  });

  assert.match(said, /The check itself failed, so nothing below was verified: the store was closed/);
});
