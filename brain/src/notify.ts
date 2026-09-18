/**
 * Telling someone something without having been asked.
 *
 * There are two different jobs here and they used to be one. Saying it out loud
 * reaches whoever is in the room right now and is gone the moment it is said.
 * Writing it down reaches a phone hours later and can be read twice -- which is
 * what a review link and the tail of a failing test run are for.
 *
 * So a notice is both, and the channels are a list rather than a hard-coded
 * pair. The spoken channel is always there; it needs nothing but a HUD that
 * happens to be open, and delivers nothing when there is not one. The written
 * channels need somewhere to send to -- a house that can carry a message, or a
 * URL that accepts one -- and simply are not in the list otherwise.
 *
 * A channel that fails is reported and swallowed. This is the machinery that
 * says "the fix fell over"; it must never itself become the thing that fell
 * over.
 */

import type { HomeProvider } from "@jarvis/shared";

import { speakUnprompted } from "./live.js";

/** How long the house gets to accept a message before it is given up on. */
const DELIVERY_TIMEOUT_MS = 15_000;

/** Something worth saying without being asked. */
export interface Notice {
  /**
   * One sentence, spoken. Says what happened and where to read the rest.
   *
   * Omitted for a notice that is worth keeping but not worth interrupting for.
   * A pull request waiting to be reviewed is one of those: it is read when
   * there is time for it, and speaking it out loud would be an interruption
   * about something that can wait.
   */
  spoken?: string;
  /** The long form, as the written channel's own light HTML. Omitted when there is no more. */
  written?: string;
}

/** Somewhere a notice can go. */
export interface Channel {
  /** For the log, when delivery fails. */
  readonly name: string;
  /** Delivers what it can of this notice. False when it did not arrive. */
  deliver(notice: Notice): Promise<boolean>;
}

/** Out loud, to whichever HUD is listening. Delivers nothing when none is. */
export const spoken: Channel = {
  name: "spoken",
  deliver: async (notice) =>
    notice.spoken !== undefined && notice.spoken !== "" && speakUnprompted(notice.spoken),
};

/**
 * Written, through the house's own messaging.
 *
 * Which service drives the entity is configuration, not a constant. The default
 * is `notify.send_message`, the generic one every notify entity answers, so a
 * deployment that names an entity and nothing else works. A deployment whose
 * messaging wants more -- a parse mode, a topic, a priority -- names its own
 * service and puts the arguments alongside.
 *
 * The message rides at the top level rather than nested in `data`, which is
 * what the modern services expect. Whatever markup the notice carries is the
 * business of whatever is configured here; core does not know the dialect.
 */
export function written(
  home: HomeProvider,
  entity: string,
  service: string,
  extra: Record<string, unknown> = {},
): Channel {
  return {
    name: "written",
    deliver: async (notice) => {
      if (notice.written === undefined || notice.written === "") return false;
      await home.invoke(entity, service, { message: notice.written, ...extra });
      return true;
    },
  };
}

/** `{{json}}` is the notice as a quoted JSON string; `{{text}}` is it raw. */
export function renderBody(template: string, text: string): string {
  return template
    .replaceAll("{{json}}", JSON.stringify(text))
    .replaceAll("{{text}}", text);
}

/**
 * Written, without a house.
 *
 * The route above goes through the house, which is no use to a deployment that
 * has none -- and a machine with no house is a case this project claims to
 * support. So the second written channel is a plain POST: enough for a bot API,
 * a push service, a chat webhook, or anything else that accepts one.
 *
 * The body is a template rather than a fixed shape, because every one of those
 * wants a different field. A status outside 2xx is a failure, so a webhook that
 * quietly rejects still reports.
 */
export function webhook(options: {
  url: string;
  body: string;
  contentType: string;
  headers: Record<string, string>;
}): Channel {
  return {
    name: "webhook",
    deliver: async (notice) => {
      if (notice.written === undefined || notice.written === "") return false;

      const response = await fetch(options.url, {
        method: "POST",
        headers: { "content-type": options.contentType, ...options.headers },
        body: renderBody(options.body, notice.written),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`webhook answered ${response.status}`);
      return true;
    },
  };
}

/** What the two written channels need to know. */
export interface NotifyConfig {
  notifyEntity: string;
  notifyService: string;
  notifyData: Record<string, unknown>;
  notifyWebhook: string;
  notifyWebhookBody: string;
  notifyWebhookContentType: string;
  notifyWebhookHeaders: Record<string, string>;
}

/**
 * Every channel this deployment has.
 *
 * The spoken one is always there. The house route needs both a house and an
 * entity to send to; the webhook needs neither. Configuring both is allowed and
 * sends to both. Configuring none leaves the spoken channel alone, which is a
 * working assistant that says things once rather than a broken one.
 */
export function channelsFor(home: HomeProvider | null, config: NotifyConfig): Channel[] {
  const channels: Channel[] = [spoken];

  if (home !== null && config.notifyEntity !== "") {
    channels.push(written(home, config.notifyEntity, config.notifyService, config.notifyData));
  }
  if (config.notifyWebhook !== "") {
    channels.push(
      webhook({
        url: config.notifyWebhook,
        body: config.notifyWebhookBody,
        contentType: config.notifyWebhookContentType,
        headers: config.notifyWebhookHeaders,
      }),
    );
  }
  return channels;
}

/**
 * Delivers a notice everywhere it will go.
 *
 * Every channel is tried, and one refusing does not stop the next: the spoken
 * sentence is the one that matters most and is also the one most likely to find
 * nobody there.
 */
export async function notify(channels: readonly Channel[], notice: Notice): Promise<void> {
  await Promise.all(
    channels.map(async (channel) => {
      try {
        await withTimeout(channel.deliver(notice), DELIVERY_TIMEOUT_MS);
      } catch (error) {
        console.error(`notify: the ${channel.name} channel failed:`, error);
      }
    }),
  );
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`gave up after ${ms} ms`));
      }, ms);
      timer.unref();
    }),
  ]);
}
