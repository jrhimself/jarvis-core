/**
 * A bot that can be answered.
 *
 * The written channels in `notify.ts` are one-way: they hand a sentence to
 * something that delivers it and hear nothing back. That is the right shape for
 * telling somebody a fix has landed, and the wrong one for asking whether a
 * finding was worth having -- a question with no way to answer is a statement.
 *
 * So this is the other half: a chat the assistant both writes to and reads
 * from. Telegram, because it is the one messenger with a bot API that needs no
 * inbound port, no domain and no certificate -- a long poll from behind a
 * household NAT is the whole of the transport.
 *
 * Nothing here knows what a finding is. It sends text with buttons under it and
 * reports which button was pressed; deciding what the buttons mean belongs to
 * the caller.
 */

const API = "https://api.telegram.org";

/** How long a poll waits for something to happen before asking again. */
const POLL_SECONDS = 50;

/** And how long the request itself is given, with room for the answer. */
const POLL_TIMEOUT_MS = (POLL_SECONDS + 10) * 1000;

/** Everything else is a request that should already have finished. */
const CALL_TIMEOUT_MS = 15_000;

/** After a failed poll, before trying again. Long enough not to hammer a bot API. */
const RETRY_MS = 30_000;

/** One button: what it says, and what comes back when it is pressed. */
export interface Button {
  text: string;
  data: string;
}

/** A button press, as the caller cares about it. */
export interface Press {
  /** Answering this is what stops the sender's spinner. */
  queryId: string;
  /** The `data` of the button that was pressed. */
  data: string;
  /** The message the buttons were under, so it can be edited afterwards. */
  messageId: number;
  /** Who pressed it. */
  chatId: string;
}

/** Anything typed at the bot rather than pressed. */
export interface Said {
  chatId: string;
  text: string;
  messageId: number;
}

interface Update {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

/**
 * Talks to one bot.
 *
 * Every call swallows its own failure and says so in the return value. A house
 * that cannot reach Telegram for ten minutes is an ordinary evening on a
 * domestic connection, and none of it is worth taking a process down for.
 */
export class Telegram {
  readonly #token: string;
  #offset = 0;
  #polling = false;

  constructor(token: string) {
    this.#token = token;
  }

  async #call(method: string, body: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    const response = await fetch(`${API}/bot${this.#token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const answer = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!answer.ok) throw new Error(`${method}: ${answer.description ?? "refused"}`);
    return answer.result;
  }

  /**
   * Sends a message, with a row of buttons under it when there are any.
   *
   * Returns the message id, which is what makes the buttons removable later. A
   * failure returns null rather than throwing: the caller records what it sent,
   * and a record of a message that never arrived is worse than no record.
   */
  async send(chatId: string, html: string, buttons: Button[] = []): Promise<number | null> {
    try {
      const result = (await this.#call("sendMessage", {
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        ...(buttons.length > 0
          ? {
              reply_markup: {
                inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))],
              },
            }
          : {}),
      })) as { message_id: number };
      return result.message_id;
    } catch (error) {
      console.error("telegram: could not send:", error);
      return null;
    }
  }

  /**
   * Says the bot is writing, for the next five seconds.
   *
   * A question that takes half a minute to answer looks, without this, exactly
   * like one that never arrived.
   */
  async typing(chatId: string): Promise<void> {
    try {
      await this.#call("sendChatAction", { chat_id: chatId, action: "typing" });
    } catch {
      // A missing typing indicator is not worth a line in the log.
    }
  }

  /**
   * Stops the spinner on a pressed button, with a line of text on the answer.
   *
   * Telegram shows a pressed button as pending until this is called, so leaving
   * it out reads exactly like a bot that has stopped working.
   */
  async acknowledge(queryId: string, text: string): Promise<void> {
    try {
      await this.#call("answerCallbackQuery", { callback_query_id: queryId, text });
    } catch (error) {
      console.error("telegram: could not acknowledge a press:", error);
    }
  }

  /** Replaces a message's text and takes its buttons away. */
  async settle(chatId: string, messageId: number, html: string): Promise<void> {
    try {
      await this.#call("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
      });
    } catch (error) {
      console.error("telegram: could not settle a message:", error);
    }
  }

  /**
   * Reads updates until stopped.
   *
   * Long polling, so an answer arrives within a second of being pressed without
   * anything being asked for more than once a minute. The offset is the
   * acknowledgement: asking for `last + 1` is what tells Telegram the previous
   * batch was handled, so a crash mid-batch replays rather than loses.
   *
   * One poller per token. Telegram allows exactly one, and a second one racing
   * the first is a failure that shows up as messages that arrive sometimes.
   */
  listen(handlers: { pressed?: (press: Press) => Promise<void>; said?: (said: Said) => Promise<void> }): () => void {
    if (this.#polling) throw new Error("this bot is already being listened to");
    this.#polling = true;
    let stopped = false;

    const loop = async (): Promise<void> => {
      while (!stopped) {
        let updates: Update[] = [];
        try {
          updates = (await this.#call(
            "getUpdates",
            { offset: this.#offset, timeout: POLL_SECONDS, allowed_updates: ["message", "callback_query"] },
            POLL_TIMEOUT_MS,
          )) as Update[];
        } catch (error) {
          if (stopped) return;
          console.error("telegram: poll failed, retrying:", error);
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS).unref());
          continue;
        }

        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          try {
            await this.#handle(update, handlers);
          } catch (error) {
            console.error("telegram: could not handle an update:", error);
          }
        }
      }
    };

    void loop();

    return () => {
      stopped = true;
      this.#polling = false;
    };
  }

  async #handle(
    update: Update,
    handlers: { pressed?: (press: Press) => Promise<void>; said?: (said: Said) => Promise<void> },
  ): Promise<void> {
    const query = update.callback_query;
    if (query?.data !== undefined && query.message !== undefined && handlers.pressed !== undefined) {
      await handlers.pressed({
        queryId: query.id,
        data: query.data,
        messageId: query.message.message_id,
        chatId: String(query.message.chat.id),
      });
      return;
    }

    const message = update.message;
    if (message?.text !== undefined && handlers.said !== undefined) {
      await handlers.said({
        chatId: String(message.chat.id),
        text: message.text,
        messageId: message.message_id,
      });
    }
  }
}
