/**
 * House Ops webhook payload shape and routing when the URL is configured.
 *
 * Detection is unchanged; this only covers how a ripe finding leaves Core.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OpenAnomaly } from "../dist/proactive/detect.js";
import type { Config } from "../dist/config.js";
import type { Sender } from "../dist/proactive/suggest.js";
import { offer } from "../dist/proactive/suggest.js";
import {
  buildAnomalyPayload,
  classify,
  optionalHints,
  plainMessage,
} from "../dist/proactive/house-ops-webhook.js";
import { proactiveDb } from "./helpers.ts";

process.env["JARVIS_TIMEZONE"] = "Europe/Amsterdam";
process.env["JARVIS_LOCALE"] = "en-GB";

const NOW = new Date("2026-08-11T18:00:00.000Z");

function anomaly(overrides: Partial<OpenAnomaly> = {}): OpenAnomaly {
  return {
    id: 1,
    fingerprint: "stuck:binary_sensor.hall",
    subject: "binary_sensor.hall",
    rule: "stuck",
    watchGroup: "motion",
    area: "Hall",
    firstAt: NOW.toISOString(),
    lastAt: NOW.toISOString(),
    buckets: 6,
    observed: null,
    expected: null,
    deviation: null,
    detail: "binary_sensor.hall has not changed in 24 hours",
    phrase: null,
    ripe: true,
    ...overrides,
  };
}

function settings(overrides: Partial<Config> = {}): Config {
  return {
    suggestChat: "42",
    suggestPerDay: 6,
    quietFrom: 21,
    quietTo: 7,
    houseOpsWebhookUrl: "",
    houseOpsWebhookKey: "",
    ...overrides,
  } as Config;
}

function recorder(): Sender & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send: async (_chatId, html) => {
      sent.push(html);
      return 101;
    },
    acknowledge: async () => {},
    settle: async () => {},
  };
}

function standing(
  db: ReturnType<typeof proactiveDb>,
  input: { subject?: string; rule?: string; group?: string; buckets?: number } = {},
): number {
  const result = db
    .prepare(
      `INSERT INTO anomalies (fingerprint, subject, rule, watch_group, area, first_at, last_at,
                              buckets, observed, expected, deviation, detail)
       VALUES (?, ?, ?, ?, 'Hall', ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      `${input.rule ?? "stuck"}:${input.subject ?? "binary_sensor.hall"}`,
      input.subject ?? "binary_sensor.hall",
      input.rule ?? "stuck",
      input.group ?? "motion",
      NOW.toISOString(),
      NOW.toISOString(),
      input.buckets ?? 6,
      "binary_sensor.hall has not changed in 24 hours",
    );
  return Number(result.lastInsertRowid);
}

test("payload names the rule, subject and sleep flag", () => {
  const payload = buildAnomalyPayload(anomaly(), 9, true, NOW);

  assert.equal(payload.type, "anomaly");
  assert.deepEqual(payload.entity_ids, ["binary_sensor.hall"]);
  assert.equal(payload.event, "stuck");
  assert.equal(payload.severity, "medium");
  assert.equal(payload.escalate, true, "quiet hours raise escalate");
  assert.equal(payload.timestamp, NOW.toISOString());
  assert.equal(payload.sleep, true);
  assert.equal(payload.suggestion_id, 9);
  assert.equal(payload.anomaly_id, 1);
  assert.match(payload.message, /stuck/);
  assert.match(plainMessage(anomaly({ phrase: null }), "en"), /has not changed/);
});

test("openings and problem rows are alerts that escalate", () => {
  const door = classify(anomaly({ watchGroup: "openings", rule: "missing" }), false);
  assert.equal(door.type, "alert");
  assert.equal(door.severity, "high");
  assert.equal(door.escalate, true);

  const problem = classify(anomaly({ rule: "problem", watchGroup: "problems" }), false);
  assert.equal(problem.type, "alert");
  assert.equal(problem.severity, "high");
});

test("camera and storage hints come from entity id shape only", () => {
  assert.deepEqual(optionalHints(anomaly({ subject: "camera.driveway" })), {
    camera_hint: "camera",
  });
  assert.deepEqual(optionalHints(anomaly({ subject: "sensor.disk_free" })), {
    nas_hint: "storage",
  });
  assert.deepEqual(optionalHints(anomaly()), {});
});

test("with HOUSE_OPS_WEBHOOK_URL set, Telegram is not used", async () => {
  const db = proactiveDb();
  standing(db);
  const bot = recorder();

  const posts: Array<{ url: string; headers: Headers; body: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    posts.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response("ok", { status: 200 });
  }) as typeof fetch;

  try {
    const report = await offer(
      db,
      bot,
      settings({
        houseOpsWebhookUrl: "https://example.test/hooks/house-ops",
        houseOpsWebhookKey: "test-key",
      }),
      NOW,
    );

    assert.equal(report.offered, 1);
    assert.equal(bot.sent.length, 0, "Telegram stays quiet when the webhook is configured");
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.url, "https://example.test/hooks/house-ops");
    assert.equal(posts[0]!.headers.get("authorization"), "Bearer test-key");
    const body = JSON.parse(posts[0]!.body) as { type: string; subject: string };
    assert.equal(body.type, "anomaly");
    assert.equal(body.subject, "binary_sensor.hall");

    const row = db.prepare("SELECT status, chat_id, message_id FROM suggestions").get() as {
      status: string;
      chat_id: string;
      message_id: number;
    };
    assert.equal(row.status, "delivered");
    assert.equal(row.chat_id, "house-ops-webhook");
    assert.equal(row.message_id, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("webhook unset keeps the previous Telegram path", async () => {
  const db = proactiveDb();
  standing(db);
  const bot = recorder();

  const report = await offer(db, bot, settings(), NOW);

  assert.equal(report.offered, 1);
  assert.equal(bot.sent.length, 1);
});

test("webhook failure falls back to Telegram only when escalate is set", async () => {
  const db = proactiveDb();
  standing(db, { rule: "problem", group: "problems", subject: "binary_sensor.leak" });
  const bot = recorder();

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 503 })) as typeof fetch;

  try {
    const report = await offer(
      db,
      bot,
      settings({ houseOpsWebhookUrl: "https://example.test/hooks/house-ops" }),
      NOW,
    );

    assert.equal(report.offered, 1);
    assert.equal(bot.sent.length, 1, "escalate rows may fall back to Telegram");
  } finally {
    globalThis.fetch = original;
  }
});

test("webhook failure without escalate does not Telegram", async () => {
  const db = proactiveDb();
  standing(db, { rule: "deviation", group: "temperature", buckets: 2 });
  const bot = recorder();

  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("no", { status: 503 })) as typeof fetch;

  try {
    // Outside quiet hours so sleep does not force escalate.
    const report = await offer(
      db,
      bot,
      settings({ houseOpsWebhookUrl: "https://example.test/hooks/house-ops" }),
      NOW,
    );

    assert.equal(report.offered, 0);
    assert.equal(bot.sent.length, 0);
    const row = db.prepare("SELECT status FROM suggestions").get() as { status: string };
    assert.equal(row.status, "undelivered");
  } finally {
    globalThis.fetch = original;
  }
});
