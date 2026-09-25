/**
 * Entry point for the brain service.
 *
 * TLS is not optional here: browsers hand out microphone access on secure
 * origins only, so the certificate is what makes the voice interface possible at
 * all. The static HUD, the media store, the memory API and the websocket all
 * land on this one server.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";

import { locale, timeZone, usingHostZone } from "@jarvis/shared";

import { loadConfig } from "./config.js";
import { startCheckpointing } from "./memory/checkpoint.js";
import { warmEmbeddings } from "./memory/embedding.js";
import { serveMedia } from "./media.js";
import { serveMemoryApi } from "./memory/api.js";
import { memory } from "./memory/store.js";
import { distilPending } from "./memory/distiller.js";
import { backfill } from "./memory/tools.js";
import { startProactive } from "./proactive/index.js";
import { createStaticHandler } from "./static-server.js";
import { Chat } from "./chat.js";
import { Telegram } from "./telegram.js";
import { handlePress } from "./proactive/suggest.js";
import { packSummary } from "./agent.js";
import { serveRunnerReport } from "./dev/report-endpoint.js";
import { handleRunnerPress, supervise } from "./dev/runners.js";
import { warmRecordedLines } from "./conversation.js";
import { configurePlanStore, loadPlanUsage } from "./plan.js";
import { attachWebsocket } from "./ws.js";
import { runHealthChecks, specsFor } from "./health.js";

/** How often every dependency is asked whether it still answers. */
const HEALTH_INTERVAL_MS = 5 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();

  // Last known plan usage, so a cold websocket still has numbers for the pill
  // before any turn has refreshed them this process.
  configurePlanStore(config.dataDir);
  loadPlanUsage();

  let cert: Buffer;
  let key: Buffer;
  try {
    [cert, key] = await Promise.all([
      readFile(join(config.certDir, config.certFile)),
      readFile(join(config.certDir, config.keyFile)),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `Could not read the TLS certificate from ${config.certDir}: ${reason}\n` +
        `Put a certificate and key there as ${config.certFile} and ${config.keyFile}. ` +
        "Any issuer will do -- Let's Encrypt over DNS-01, mkcert on a LAN, or " +
        "`tailscale cert` on a tailnet. Without one the browser will not hand over the microphone.",
    );
    process.exitCode = 1;
    return;
  }

  const serveStatic = createStaticHandler(config.hudDir);
  const store = memory(config.memoryPath);

  // The bot is two things at once: findings go out through it, and questions
  // come back in. Telegram allows exactly one poller per token, so the ear is
  // opened here rather than inside either half -- a second one racing the first
  // shows up as messages that arrive sometimes.
  //
  // The client itself is stateless over HTTP, so the sending half elsewhere
  // holds its own; only this one listens.
  const listening = config.suggestToken !== "" && config.suggestChat !== "";
  const bot = listening ? new Telegram(config.suggestToken) : null;
  const chat = bot === null ? null : new Chat(bot, config.suggestChat);

  const server = createServer({ cert, key }, (req, res) => {
    // Images the assistant fetched come from memory, not from disk.
    if (serveMedia(req, res)) return;

    // What JARVIS remembers, for the HUD's memory panel.
    if (serveMemoryApi(req, res, store, config)) return;

    // A runner elsewhere, saying it has fallen quiet. Judging what that means
    // costs a model call, so it happens after the caller has been let go.
    if (
      serveRunnerReport(req, res, config.runnerToken, (report) => {
        if (bot === null) return;
        void supervise(store, bot, config.suggestChat, report, async (slot) =>
          (await packSummary()).delegate.kill(slot),
        );
      })
    ) {
      return;
    }

    serveStatic(req, res).catch((error: unknown) => {
      console.error("Request failed:", error);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  attachWebsocket(server);

  // The lines that fill a silence, spoken once by the configured voice and
  // kept, so a slow turn is acknowledged from disk rather than from a socket.
  void warmRecordedLines().catch((error: unknown) => {
    console.warn("voice: could not record the opening lines:", error);
  });

  // Loading the model and indexing older facts takes a few seconds; neither
  // should hold up the server, and both are ready long before anyone speaks.
  void warmEmbeddings()
    .then(() => backfill(store))
    .catch((error: unknown) => console.error("could not prepare embeddings:", error));

  // Conversations that were open when the service last stopped never got their
  // ending, and with it their distillation. Nothing is waiting on this.
  void distilPending(store).catch((error: unknown) =>
    console.error("could not distil what was left over:", error),
  );

  startCheckpointing(store, config.memoryPath);
  const stopProactive = startProactive(config, store);

  // The probes used to run only when a browser connected, which is the one
  // moment their verdict is least needed: the tool calls that pay for a dead
  // dependency come from a turn, and a turn can arrive over Telegram with no
  // browser open for days. Running them on a clock keeps the verdicts fresh
  // enough for `serverIsDown` to be worth consulting, and answers recover on
  // their own when whatever was down comes back.
  const checkHealth = (): void => {
    void packSummary()
      .then((packs) =>
        runHealthChecks(specsFor(config, store, Object.keys(packs.servers), packs.probes, packs.delegate)),
      )
      .catch((error: unknown) => console.error("health checks failed:", error));
  };
  checkHealth();
  const healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
  healthTimer.unref();

  let hangUp: (() => void) | null = null;

  if (bot !== null && chat !== null) {
    const db = store.proactiveConnection();
    hangUp = bot.listen({
      pressed: async (press) => {
        if (press.chatId !== config.suggestChat) return;
        // Closing a delegated slot travels back over the same seam the job left
        // by, which is the pack's business rather than core's.
        const closed = await handleRunnerPress(
          bot,
          async (slot) => (await packSummary()).delegate.kill(slot),
          press,
        );
        if (closed) return;
        await handlePress(db, bot, press);
      },
      said: async (said) => {
        await chat.said(said);
      },
    });
    console.log("telegram: listening for answers and questions");
  }

  server.listen(config.port, () => {
    console.log(
      `jarvis brain: serving the HUD from ${config.hudDir} on port ${config.port}, websocket on /ws`,
    );
    // Said out loud on every start, because getting this wrong is silent: the
    // assistant works, and only its idea of a Tuesday evening is off.
    console.log(
      `jarvis brain: reasoning in ${timeZone()} (${locale()})` +
        (usingHostZone() ? " — from this machine, not from JARVIS_TIMEZONE" : ""),
    );
  });

  const shutdown = (signal: string) => {
    console.log(`jarvis brain: ${signal} received, shutting down`);
    stopProactive();
    hangUp?.();
    chat?.close();
    server.close(() => process.exit(0));
    // Open websockets and the SQLite handle keep the loop alive, and systemd
    // should not wait ninety seconds for a service that has nothing left to do.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
