/**
 * Websocket endpoint the HUD talks to.
 *
 * The socket is reachable only over the tailnet or the LAN, but the brain still
 * refuses anything that is not a well-formed message: the HUD is a browser page,
 * and browser pages get pointed at things.
 */

import type { Server as HttpsServer } from "node:https";

import { parseClientMessage, type ServerMessage, type PipelineStage } from "@jarvis/shared";
import { WebSocketServer, type WebSocket } from "ws";

import { packSummary } from "./agent.js";
import { mergeDeskSlots } from "./desk.js";
import { loadConfig } from "./config.js";
import { Conversation } from "./conversation.js";
import { interfaceLanguage, language } from "./language.js";
import { runHealthChecks, specsFor } from "./health.js";
import { screenGone } from "./screens.js";
import { addLiveSession } from "./live.js";
import { memory } from "./memory/store.js";
import { FocusGate, panelOfDisplay } from "./focus.js";
import { onPlanUsage, planUsage } from "./plan.js";
import { METRICS_INTERVAL_MS, readMetrics } from "./metrics.js";
import { tileFeed } from "./tiles.js";
import { brainVersion } from "./version.js";
import { Listener } from "./voice/scribe.js";

/**
 * How often a pack's standing readings are taken.
 *
 * A minute is what the agenda needs: an appointment stops being the next one
 * the moment it starts, and a panel that is a quarter of an hour behind on that
 * is worse than one that says nothing. It is also what the house's own calendar
 * cache holds, so a page open all day costs one request a minute and a second
 * page costs none.
 */
const WATCH_INTERVAL_MS = 60 * 1000;

/** Activity labels that belong to a stage other than the default one. */
function stageFor(label: string): PipelineStage {
  if (label.startsWith("mcp__")) return "tool";
  if (label.startsWith("memory")) return "memory";
  return "llm";
}

export function attachWebsocket(server: HttpsServer, path = "/ws"): WebSocketServer {
  const config = loadConfig();
  const wss = new WebSocketServer({ server, path });

  wss.on("connection", (socket: WebSocket) => {
    const send = (message: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    // The context panel, fed by the figures the packs put on their own answers.
    // Nothing is asked of any pack and nothing is asked of the model: the tiles
    // ride along on results this process already sees.
    // Lights the matching standing desk panel when a turn talks about it.
    // Briefing and ordinary answers both raise focus; the gate de-dupes.
    const focus = new FocusGate(send);

    // Declared before the tile sink so the sink can ask whether a turn is open
    // without reading a binding that does not exist yet.
    let conversation!: Conversation;

    const noteFacts = tileFeed((source, topic, tiles) => {
      send({ kind: "tiles", source, topic: topic.id, topicLabel: topic.label, tiles });
      // Standing watchers also flow through here; only light a panel while a
      // turn is actually being answered, not on the once-a-minute refresh.
      if (conversation.busy) focus.focus(topic.id);
    });

    conversation = new Conversation(
      {
        onText: (turnId, text, opening) =>
          send({ kind: "text", turnId, text, ...(opening === true ? { opening: true } : {}) }),
        onActivity: (turnId, label) =>
          send({ kind: "activity", turnId, label, stage: stageFor(label) }),
        onToolResult: noteFacts,
        onDisplay: (turnId, id, payload, dismiss, cue) => {
          send({ kind: "display", turnId, id, payload, dismiss, cue });
          const panel = panelOfDisplay(payload);
          if (panel !== null) focus.focus(panel, cue);
        },
        onVoice: (turnId, available, reason, lang, fx) =>
          send({
            kind: "voice",
            turnId,
            available,
            ...(reason === undefined ? {} : { reason }),
            ...(lang === undefined ? {} : { lang }),
            ...(fx === undefined ? {} : { fx }),
          }),
        onAudio: (turnId, seq, data, alignment) =>
          send(alignment === undefined
            ? { kind: "audio", turnId, seq, data }
            : { kind: "audio", turnId, seq, data, alignment }),
        onAudioDone: (turnId) => send({ kind: "audio_done", turnId }),
        onSection: (_turnId, topic, chars) => focus.section(topic, chars),
        onDone: (turnId, durationMs, expectsReply, briefing) => {
          send({ kind: "done", turnId, durationMs, expectsReply, ...(briefing === true ? { briefing: true } : {}) });
          focus.unfocus();
        },
        onError: (turnId, message) => {
          send({ kind: "error", turnId, message });
          focus.unfocus();
        },
      },
      { idleMs: config.sessionIdleMs, maxTurns: config.sessionMaxTurns },
    );

    // One microphone per connection, opened on demand and closed with it.
    let listener: Listener | null = null;

    // What lets the brain speak between questions. Registered for as long as
    // the page is open and forgotten with it, so a line meant for a HUD that
    // closed an hour ago goes nowhere rather than into a dead socket.
    const forgetLiveSession = addLiveSession((text) => send({ kind: "announce", text }));

    send({ kind: "ready", sessionId: null, version: brainVersion() });

    // Standing desk windows: core defaults plus whatever started packs declared.
    void packSummary()
      .then((packs) => {
        const slots = mergeDeskSlots(packs.desk);
        send({
          kind: "desk",
          slots: slots.map((slot) => ({
            topic: slot.topic,
            label: slot.label,
            ...(slot.briefing === true ? { briefing: true } : {}),
          })),
        });
      })
      .catch((error: unknown) => console.error("desk slots failed:", error));

    // The plan's pill: what is known now, and every change after.
    const known = planUsage();
    if (known !== null) send({ kind: "usage", usage: known });
    const forgetPlan = onPlanUsage((usage) => send({ kind: "usage", usage }));

    // The language switch: where it stands, and every flip after, whichever
    // page flipped it.
    send({ kind: "lang", lang: language().current });
    const forgetLang = language().onChange((lang) => send({ kind: "lang", lang }));
    // The screen's own language, which only changes when somebody asks for it.
    send({ kind: "ui_lang", lang: interfaceLanguage().current });
    const forgetScreenLang = interfaceLanguage().onChange((lang) => send({ kind: "ui_lang", lang }));

    // Ask every dependency whether it actually answers, and tell the HUD.
    // "ready" alone only ever proved the websocket; a dead bridge or an
    // expired mail token should be visible before the first question, not
    // during it.
    void packSummary()
      .then((packs) =>
        runHealthChecks(
          specsFor(config, memory(config.memoryPath), Object.keys(packs.servers), packs.probes, packs.delegate),
        ),
      )
      .then((checks) => send({ kind: "health", checks }))
      .catch((error: unknown) => console.error("health checks failed:", error));

    // The readings that go stale while they are on screen. They arrive by the
    // same path a tool's own figures do -- same shape, same subject, same
    // de-duplication -- so an unchanged agenda changes nothing on the panel and
    // a new "next up" lands as news, gold and all, without anyone asking.
    const takeReadings = async (): Promise<void> => {
      const packs = await packSummary();
      for (const watcher of packs.watch) {
        try {
          const tiles = await watcher.read();
          if (tiles.length === 0) continue;
          noteFacts(`mcp__${watcher.server}__${watcher.tool}`, JSON.stringify({ facts: tiles }));
        } catch {
          // Nothing new was learned. The panel keeps what it had.
        }
      }
    };
    const watchTimer = setInterval(() => {
      void takeReadings();
    }, WATCH_INTERVAL_MS);
    watchTimer.unref();

    // Real numbers for the HUD's own panel, now and every few seconds after.
    // The panel used to animate invented ones; a page that is open all day is
    // cheap to keep honest, since none of this leaves the process.
    const sendMetrics = (): void =>
      send({ kind: "metrics", metrics: readMetrics(config.memoryPath) });
    sendMetrics();
    const metricsTimer = setInterval(sendMetrics, METRICS_INTERVAL_MS);
    metricsTimer.unref();

    // The page is open long before anyone speaks; start the agent now so the
    // first question does not wait for it.
    conversation.warm();

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        send({ kind: "error", message: "Unreadable message." });
        return;
      }

      const message = parseClientMessage(parsed);
      if (message === null) {
        send({ kind: "error", message: "Unknown message." });
        return;
      }

      if (message.kind === "say") {
        void conversation.say(message.turnId, message.text, message.lang);
        return;
      }

      if (message.kind === "set_lang") {
        // Logged, and the lines for it recorded, by the listener in index.ts.
        language().set(message.lang);
        return;
      }

      if (message.kind === "cancel") {
        conversation.cancel(message.turnId);
        focus.unfocus();
        return;
      }

      if (message.kind === "display_closed") {
        // Nothing is answered: the screen is reporting, not asking. What it buys
        // is that the next question about "that overview" can be answered from
        // the log rather than by fetching it again.
        screenGone(message.id, message.reason);
        return;
      }

      if (message.kind === "listen_start") {
        if (config.elevenLabsKey === "") {
          send({ kind: "listen", available: false, reason: "de transcriptie is niet ingesteld" });
          return;
        }
        listener?.close();
        let announced = false;
        const announce = () => {
          if (announced) return;
          announced = true;
          send({ kind: "listen", available: true });
        };
        listener = new Listener(config, {
          onPartial: (text) => {
            announce();
            send({ kind: "transcript", text, final: false });
          },
          onFinal: (text) => {
            announce();
            send({ kind: "transcript", text, final: true });
          },
          onError: (reason) => {
            // Only useful before the first result: once text is arriving the
            // browser cannot take over without losing what was already said.
            if (!announced) send({ kind: "listen", available: false, reason });
            listener?.close();
            listener = null;
          },
        }, language().current);
        return;
      }

      if (message.kind === "listen_audio") {
        listener?.push(message.data);
        return;
      }

      if (message.kind === "listen_stop") {
        // Ask for the settled text before hanging up. The listener closes itself
        // once the committed transcript arrives; the timer covers the case where
        // it never does.
        listener?.commit();
        const closing = listener;
        listener = null;
        setTimeout(() => closing?.close(), 4000);
        return;
      }

      void conversation.handleUtterance(message.turnId, message.text);
    });

    const teardown = (): void => {
      clearInterval(metricsTimer);
      clearInterval(watchTimer);
      forgetLiveSession();
      forgetPlan();
      forgetLang();
      forgetScreenLang();
      listener?.close();
      conversation.close();
    };

    socket.on("close", teardown);
    socket.on("error", (error) => {
      console.error("websocket error:", error);
      teardown();
    });
  });

  return wss;
}
