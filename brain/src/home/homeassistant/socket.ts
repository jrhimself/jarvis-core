/**
 * The brain's own connection to Home Assistant.
 *
 * Everything else here reads Home Assistant when a tool call asks for it: one
 * REST round trip, answered and forgotten. Noticing things needs the opposite —
 * a connection that stays open, reports what changed, and is still there in the
 * morning. That is a websocket, and this is the only one.
 *
 * Two callers share it. Watching (`entities`) needs a live feed; statistics
 * needs request/response. Both ride the same socket because Home Assistant
 * counts connections, not messages, and a second one would buy nothing.
 *
 * The `ws` package rather than Node's global WebSocket, which was the first
 * choice and turned out to have a ceiling: a statistics answer over about four
 * megabytes closes the connection with no error anyone can catch. Ten days of
 * every statistic a house keeps runs well past that. `ws` takes the same answer
 * in 577 ms once `maxPayload` is raised, and it is already a dependency here.
 */

import WebSocket from "ws";

import type { ConnectionHooks, StateChange } from "@jarvis/shared";

/**
 * Ceiling on a single message.
 *
 * Ten days of every statistic a modest house keeps is single-digit megabytes.
 * The margin is for a house growing, not for a query this size being normal —
 * the statistics client chunks so it never approaches this.
 */
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** How long to wait for `auth_ok` before treating the connection as failed. */
const AUTH_TIMEOUT_MS = 10_000;

/** How long a request may go unanswered before its promise rejects. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Silence longer than this means the connection is gone whatever TCP thinks. */
const PING_INTERVAL_MS = 30_000;

/** Backoff between reconnects: quick at first, then patient. Milliseconds. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];

/** A state as Home Assistant compresses it for `subscribe_entities`. */
interface CompressedState {
  /** The state itself. */
  s?: string;
  /** Attributes, in full on the first message and only when changed after. */
  a?: Record<string, unknown>;
  /** Last changed, as epoch seconds with a fraction. */
  lc?: number;
  /** Last updated; absent when it equals `lc`. */
  lu?: number;
}

interface EntitiesEvent {
  /** Entities added to the subscription, with their full state. */
  a?: Record<string, CompressedState>;
  /** Entities that changed, as a diff. */
  c?: Record<string, { "+"?: CompressedState; "-"?: Record<string, unknown> }>;
  /** Entities that disappeared. */
  r?: string[];
}

type Watcher = (change: StateChange) => void;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * A websocket to Home Assistant that reconnects on its own.
 *
 * The caller subscribes once and stays subscribed: after a reconnect the
 * subscription is re-established and every watched entity arrives again as an
 * `a` message, so a restart of Home Assistant shows up as a fresh full state
 * rather than as silence.
 */
export class HaSocket {
  readonly #url: string;
  readonly #token: string;

  #socket: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #closed = false;

  /** Entities the caller wants, and who to tell. Survives reconnects. */
  #watched: string[] = [];
  #watcher: Watcher | null = null;
  #subscriptionId: number | null = null;
  #subscribing = false;

  /** Last full state per entity, so a diff can be applied to something. */
  #latest = new Map<string, StateChange>();

  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #pingTimer: NodeJS.Timeout | null = null;

  /**
   * Resolves once Home Assistant has accepted the token, and stays resolved.
   *
   * It marks "this socket ever worked", not "this socket is up right now".
   * Re-arming it on every drop would mean a caller that happens to ask during a
   * reconnect waits for the backoff instead of getting an answer, and a caller
   * awaiting a connection that never returns waits forever. Whether the socket
   * is up at this instant is a question `#requestWithId` answers, immediately.
   */
  #ready: Promise<void>;
  #markReady: (() => void) | null = null;
  #failReady: ((error: Error) => void) | null = null;

  readonly #hooks: ConnectionHooks;
  #wasUp = false;

  constructor(haUrl: string, token: string, hooks: ConnectionHooks = {}) {
    this.#url = `${haUrl.replace(/^http/, "ws").replace(/\/+$/, "")}/api/websocket`;
    this.#token = token;
    this.#hooks = hooks;
    this.#ready = this.#freshReady();
  }

  #freshReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#markReady = resolve;
      this.#failReady = reject;
    });
  }

  /** Opens the connection and resolves once Home Assistant accepted the token. */
  async connect(): Promise<void> {
    if (this.#closed) throw new Error("this socket was closed");
    this.#open();
    await this.#ready;
  }

  #open(): void {
    if (this.#socket !== null || this.#closed) return;

    const socket = new WebSocket(this.#url, { maxPayload: MAX_PAYLOAD_BYTES });
    this.#socket = socket;
    this.#nextId = 1;

    const authTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }, AUTH_TIMEOUT_MS);

    socket.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      this.#handle(message, socket, authTimer);
    };

    socket.onclose = () => {
      clearTimeout(authTimer);
      this.#teardown(new Error("the connection to Home Assistant closed"));
      this.#scheduleReconnect();
    };

    // A socket error is always followed by a close, which is where the
    // reconnect lives. Swallowing it here keeps it off the unhandled path.
    socket.onerror = () => {};
  }

  #handle(message: Record<string, unknown>, socket: WebSocket, authTimer: NodeJS.Timeout): void {
    const type = message["type"];

    if (type === "auth_required") {
      socket.send(JSON.stringify({ type: "auth", access_token: this.#token }));
      return;
    }

    if (type === "auth_invalid") {
      clearTimeout(authTimer);
      // A rejected token will be rejected again in a second and in a minute.
      // Reconnecting on it would turn a typo into a login storm, and Home
      // Assistant bans the address that produces one.
      this.#closed = true;
      this.#failReady?.(new Error("Home Assistant rejected the token"));
      socket.close();
      return;
    }

    if (type === "auth_ok") {
      clearTimeout(authTimer);
      this.#attempt = 0;
      console.log("proactive: connected to Home Assistant");
      this.#markReady?.();
      this.#wasUp = true;
      this.#hooks.up?.();
      this.#startPinging();
      if (this.#watcher !== null) void this.#subscribe();
      return;
    }

    if (type === "result") {
      const id = Number(message["id"]);
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);

      if (message["success"] === true) {
        pending.resolve(message["result"]);
      } else {
        const error = message["error"] as { message?: string } | undefined;
        pending.reject(new Error(error?.message ?? "Home Assistant refused the request"));
      }
      return;
    }

    if (type === "event" && Number(message["id"]) === this.#subscriptionId) {
      this.#deliver(message["event"] as EntitiesEvent);
      return;
    }

    if (type === "pong") {
      const id = Number(message["id"]);
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
  }

  /** Turns a compressed add-or-diff into full states and hands them to the watcher. */
  #deliver(event: EntitiesEvent): void {
    if (this.#watcher === null) return;

    for (const [entityId, state] of Object.entries(event.a ?? {})) {
      const change: StateChange = {
        entityId,
        state: state.s ?? "",
        attributes: state.a ?? {},
        changedAt: new Date((state.lc ?? Date.now() / 1000) * 1000),
      };
      this.#latest.set(entityId, change);
      this.#watcher(change);
    }

    for (const [entityId, diff] of Object.entries(event.c ?? {})) {
      const previous = this.#latest.get(entityId);
      const added = diff["+"];
      if (added === undefined) continue;

      const change: StateChange = {
        entityId,
        state: added.s ?? previous?.state ?? "",
        attributes: { ...(previous?.attributes ?? {}), ...(added.a ?? {}) },
        changedAt:
          added.lc === undefined ? (previous?.changedAt ?? new Date()) : new Date(added.lc * 1000),
      };
      this.#latest.set(entityId, change);
      this.#watcher(change);
    }

    for (const entityId of event.r ?? []) this.#latest.delete(entityId);
  }

  /**
   * Watches a fixed set of entities.
   *
   * `subscribe_entities` rather than `subscribe_events` on `state_changed`:
   * Home Assistant does the filtering, and the difference is not small. Measured
   * on this installation, twenty seconds of house produced forty `state_changed`
   * events against four messages for a three-entity subscription — and the
   * subscription's payload is a diff rather than a full before-and-after state.
   */
  async watch(entityIds: string[], watcher: Watcher): Promise<void> {
    this.#watched = [...entityIds];
    this.#watcher = watcher;
    await this.#ready;
    await this.#subscribe();
  }

  /**
   * Establishes the subscription, at most once per connection.
   *
   * Both `watch()` and `auth_ok` want to do this, and on a first call that
   * arrives before authentication they both would. A second subscription is not
   * an error Home Assistant reports — it just delivers everything twice.
   */
  async #subscribe(): Promise<void> {
    if (this.#watched.length === 0) return;
    if (this.#subscribing || this.#subscriptionId !== null) return;

    this.#subscribing = true;
    try {
      const { id, result } = this.#requestWithId({
        type: "subscribe_entities",
        entity_ids: this.#watched,
      });
      // The id has to be recorded before the first event arrives, and events
      // start the moment Home Assistant handles the message.
      this.#subscriptionId = id;
      await result;
    } catch (error) {
      this.#subscriptionId = null;
      console.error("proactive: could not subscribe:", (error as Error).message);
    } finally {
      this.#subscribing = false;
    }
  }

  /** Sends a request and waits for its result. */
  async request<T>(payload: Record<string, unknown>): Promise<T> {
    await this.#ready;
    return (await this.#request(payload)) as T;
  }

  #request(payload: Record<string, unknown>): Promise<unknown> {
    return this.#requestWithId(payload).result;
  }

  /** The same, for the one caller that needs the id before the answer arrives. */
  #requestWithId(payload: Record<string, unknown>): { id: number; result: Promise<unknown> } {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return {
        id: -1,
        result: Promise.reject(new Error("not connected to Home Assistant")),
      };
    }

    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Home Assistant did not answer request ${id}`));
      }, REQUEST_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, ...payload }));
    });
    return { id, result };
  }

  /**
   * A ping every half minute.
   *
   * A websocket through a proxy can be dead for hours without either side
   * noticing: no FIN arrives, the socket stays open, and nothing is delivered.
   * A failed ping is the only thing that catches that, and dropping the socket
   * puts it back on the reconnect path.
   */
  #startPinging(): void {
    this.#stopPinging();
    this.#pingTimer = setInterval(() => {
      this.#request({ type: "ping" }).catch(() => {
        console.warn("proactive: no pong from Home Assistant, reconnecting");
        this.#socket?.close();
      });
    }, PING_INTERVAL_MS);
    this.#pingTimer.unref();
  }

  #stopPinging(): void {
    if (this.#pingTimer !== null) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
  }

  #teardown(reason: Error): void {
    this.#stopPinging();
    this.#socket = null;
    this.#subscriptionId = null;
    this.#subscribing = false;

    // Only when it was actually up. A failed reconnect attempt closes too, and
    // reporting that as a fresh outage would say the same thing every minute.
    if (this.#wasUp) {
      this.#wasUp = false;
      this.#hooks.down?.();
    }

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.#pending.clear();
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) return;

    const delay = BACKOFF_MS[Math.min(this.#attempt, BACKOFF_MS.length - 1)] ?? 60_000;
    this.#attempt += 1;
    console.warn(`proactive: reconnecting to Home Assistant in ${Math.round(delay / 1000)} s`);

    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#open();
    }, delay);
    this.#reconnectTimer.unref();
  }

  /** The last state seen for an entity, or null if it never reported one. */
  latest(entityId: string): StateChange | null {
    return this.#latest.get(entityId) ?? null;
  }

  close(): void {
    this.#closed = true;
    this.#stopPinging();
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.close();
    this.#socket = null;
  }
}
