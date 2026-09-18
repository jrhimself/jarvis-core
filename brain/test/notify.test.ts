/**
 * Where an unprompted notice goes.
 *
 * Two things are worth holding still. Which channels a configuration produces --
 * because "no house" and "no webhook" are ordinary states and neither may turn
 * into a broken assistant -- and that neither written route hard-codes one
 * service or one message shape, which is what made this configurable in the
 * first place.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { channelsFor, renderBody, webhook, written, type NotifyConfig } from "../dist/notify.js";

const bare: NotifyConfig = {
  notifyEntity: "",
  notifyService: "notify.send_message",
  notifyData: {},
  notifyWebhook: "",
  notifyWebhookBody: '{"text":{{json}}}',
  notifyWebhookContentType: "application/json",
  notifyWebhookHeaders: {},
};

/** A house that records what it was asked to do and nothing else. */
function fakeHome(): { calls: Array<{ id: string; action: string; args: unknown }> } & Record<string, unknown> {
  const calls: Array<{ id: string; action: string; args: unknown }> = [];
  return {
    calls,
    invoke: async (id: string, action: string, args: unknown) => {
      calls.push({ id, action, args });
    },
  } as never;
}

test("with nothing configured only the spoken channel exists", () => {
  const channels = channelsFor(null, bare);

  assert.deepEqual(channels.map((channel) => channel.name), ["spoken"]);
});

test("an entity without a house is not a written channel", () => {
  const channels = channelsFor(null, { ...bare, notifyEntity: "notify.somewhere" });

  assert.deepEqual(channels.map((channel) => channel.name), ["spoken"]);
});

test("a webhook needs no house at all", () => {
  const channels = channelsFor(null, { ...bare, notifyWebhook: "https://example.com/hook" });

  assert.deepEqual(channels.map((channel) => channel.name), ["spoken", "webhook"]);
});

test("both written routes may be configured at once", () => {
  const channels = channelsFor(fakeHome() as never, {
    ...bare,
    notifyEntity: "notify.somewhere",
    notifyWebhook: "https://example.com/hook",
  });

  assert.deepEqual(channels.map((channel) => channel.name), ["spoken", "written", "webhook"]);
});

test("the house route calls the configured service, not a fixed one", async () => {
  const home = fakeHome();
  const channel = written(home as never, "notify.somewhere", "notify.send_message");

  assert.equal(await channel.deliver({ written: "hello" }), true);
  assert.deepEqual(home.calls, [
    { id: "notify.somewhere", action: "notify.send_message", args: { message: "hello" } },
  ]);
});

test("extra service arguments ride alongside the message", async () => {
  const home = fakeHome();
  const channel = written(home as never, "notify.somewhere", "some_bot.send_message", {
    parse_mode: "html",
  });

  await channel.deliver({ written: "<b>hello</b>" });

  assert.deepEqual(home.calls[0]!.args, { message: "<b>hello</b>", parse_mode: "html" });
});

test("a notice with nothing written does not reach either route", async () => {
  const home = fakeHome();
  const channel = written(home as never, "notify.somewhere", "notify.send_message");

  assert.equal(await channel.deliver({ spoken: "out loud" }), false);
  assert.equal(home.calls.length, 0);
});

test("the body template quotes what has to be quoted, and leaves raw what does not", () => {
  assert.equal(renderBody('{"text":{{json}}}', 'a "quoted" line'), '{"text":"a \\"quoted\\" line"}');
  assert.equal(renderBody("{{text}}", "plain body"), "plain body");
});

test("a webhook that answers badly is a failure, not a delivery", async () => {
  const realFetch = globalThis.fetch;
  const seen: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response("no", { status: 500 });
  }) as typeof fetch;

  try {
    const channel = webhook({
      url: "https://example.com/hook",
      body: "{{text}}",
      contentType: "text/plain",
      headers: { authorization: "Bearer x" },
    });

    await assert.rejects(() => channel.deliver({ written: "hello" }), /answered 500/);
    assert.equal(seen[0]!.url, "https://example.com/hook");
    assert.equal(seen[0]!.init.body, "hello");
    assert.deepEqual(seen[0]!.init.headers, {
      "content-type": "text/plain",
      authorization: "Bearer x",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
