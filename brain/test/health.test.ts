/**
 * The health checks, driven with hand-written probes.
 *
 * No network here: what is tested is the wiring around the probes -- one call
 * per shared dependency, the verdict copied to every server that names it, a
 * failure that stays contained to its own row, and a server with no probe
 * reported as in-process rather than silently missing.
 *
 * The specs come from the packs in the running system, so what these tests
 * build is what a pack would hand over. There is no longer a list here of which
 * servers exist, deliberately: that list was a copy of every pack's own
 * `configured` rule, and the copy is what drifted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  forgetVerdicts,
  runHealthChecks,
  serverIsDown,
  specsFor,
  type Probe,
  type ServerSpec,
} from "../dist/health.js";

function byServer(checks: Awaited<ReturnType<typeof runHealthChecks>>) {
  return new Map(checks.map((check) => [check.server, check]));
}

test("a server with no probe is in-process, not missing", async () => {
  const checks = await runHealthChecks([{ server: "display", probe: null }]);

  assert.deepEqual(checks, [{ server: "display", state: "ok", detail: "in-process" }]);
});

test("each server carries what its own probe answered", async () => {
  const specs: ServerSpec[] = [
    { server: "display", probe: null },
    { server: "memory", probe: async () => "database answers" },
    { server: "weather", probe: async () => "verwachting opgehaald" },
  ];

  const checks = byServer(await runHealthChecks(specs));

  assert.equal(checks.get("memory")?.state, "ok");
  assert.equal(checks.get("memory")?.detail, "database answers");
  assert.equal(checks.get("weather")?.detail, "verwachting opgehaald");
  assert.equal(typeof checks.get("weather")?.ms, "number", "a probed row is timed");
  assert.equal(checks.get("display")?.ms, undefined, "an in-process row is not");
});

test("a shared probe runs once, not once per server", async () => {
  // Three servers behind one daemon. A daemon that is down must cost one
  // timeout, not three, and the way that is arranged is that they share the
  // function.
  let calls = 0;
  const bridge: Probe = async () => {
    calls += 1;
    return "the bridge answers";
  };

  const checks = byServer(
    await runHealthChecks([
      { server: "status", probe: bridge },
      { server: "code", probe: bridge },
      { server: "terminal", probe: bridge },
    ]),
  );

  assert.equal(calls, 1);
  for (const server of ["status", "code", "terminal"]) {
    assert.equal(checks.get(server)?.detail, "the bridge answers");
  }
});

test("a dependency that is down takes its own servers and nothing else", async () => {
  const bridge: Probe = async () => {
    throw new Error("ECONNREFUSED");
  };

  const checks = byServer(
    await runHealthChecks([
      { server: "status", probe: bridge },
      { server: "code", probe: bridge },
      { server: "ha", probe: async () => "Home Assistant answers" },
      { server: "memory", probe: async () => "database answers" },
    ]),
  );

  assert.equal(checks.get("status")?.state, "down");
  assert.equal(checks.get("status")?.detail, "ECONNREFUSED");
  assert.equal(checks.get("code")?.state, "down", "it stands or falls with the bridge");
  assert.equal(checks.get("ha")?.state, "ok");
  assert.equal(checks.get("memory")?.state, "ok");
});

test("a probe that throws something that is not an Error still says something", async () => {
  const checks = await runHealthChecks([
    {
      server: "odd",
      probe: async () => {
        throw "no";
      },
    },
  ]);

  assert.equal(checks[0]?.state, "down");
  assert.equal(checks[0]?.detail, "no");
});

test("what a pack does not run does not appear at all", () => {
  // Not an "off" row. A deployment that was never configured for the mail is
  // not a deployment with something wrong with it, and a panel that lists what
  // is switched off reads as a list of faults.
  const store = { all: () => [], proactiveCounts: () => ({ observations: 0 }) } as never;
  const config = { proactive: "off" } as never;

  const specs = specsFor(config, store, ["ha", "control"], {
    ha: async () => "Home Assistant answers",
  });

  assert.deepEqual(
    specs.map((spec) => spec.server),
    ["display", "memory", "ha", "control"],
  );
  assert.equal(specs[3]?.probe, null, "a pack server with no probe is in-process");
});

test("a row says whether a pack put it there", async () => {
  // The HUD's tour answers "what can you do here" out of this list, and core's
  // own rows are not an answer to it: an install that reaches nothing still
  // has a display and a memory.
  const store = { all: () => [], proactiveCounts: () => ({ observations: 0 }) } as never;
  const config = { proactive: "off" } as never;

  const checks = byServer(
    await runHealthChecks(
      specsFor(config, store, ["ha", "control"], {
        ha: async () => {
          throw new Error("no");
        },
      }),
    ),
  );

  assert.equal(checks.get("display")?.pack, undefined);
  assert.equal(checks.get("memory")?.pack, undefined);
  assert.equal(checks.get("ha")?.pack, true, "a pack row says so even when its probe failed");
  assert.equal(checks.get("control")?.pack, true, "and when it has no probe at all");
});

test("the insight row appears only once there is something to look at", () => {
  const store = { all: () => [], proactiveCounts: () => ({ observations: 12 }) } as never;

  const off = specsFor({ proactive: "off" } as never, store, [], {});
  assert.equal(
    off.some((spec) => spec.server === "insight"),
    false,
  );

  const watching = specsFor({ proactive: "observe" } as never, store, [], {});
  assert.equal(
    watching.some((spec) => spec.server === "insight"),
    true,
  );
});

test("core's own rows are probed against the real store, not assumed", async () => {
  let asked = 0;
  const store = {
    all: () => {
      asked += 1;
      return [];
    },
    proactiveCounts: () => ({ observations: 12 }),
  } as never;

  const checks = byServer(
    await runHealthChecks(specsFor({ proactive: "observe" } as never, store, [], {})),
  );

  assert.equal(asked, 1, "the memory probe runs a real query");
  assert.equal(checks.get("memory")?.state, "ok");
  assert.equal(checks.get("insight")?.detail, "12 observations");
});

test("what the probes found is remembered, so a tool call need not find out again", async () => {
  forgetVerdicts();
  const alive: Probe = async () => "answers";
  const dead: Probe = async () => {
    throw new Error("connection refused");
  };

  await runHealthChecks([
    { server: "up", probe: alive, pack: true },
    { server: "down", probe: dead, pack: true },
    { server: "display", probe: null },
  ]);

  assert.equal(serverIsDown("down"), true);
  assert.equal(serverIsDown("up"), false);
  assert.equal(serverIsDown("display"), false, "in-process rows are never down");
  assert.equal(serverIsDown("never-probed"), false, "an unknown server is given the benefit");
  forgetVerdicts();
});
