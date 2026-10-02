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

import { locale, timeZone, usingHostZone, type HomeProvider } from "@jarvis/shared";

import { loadConfig } from "./config.js";
import { parseDoorWatch, startDoorWatch } from "./door.js";
import { createHome } from "./home/index.js";
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
import {
  consider,
  goneMessage,
  handleRunnerPress,
  handleRunnerReply,
  lookIn,
  sayStalled,
  supervise,
  type RunnerSeam,
} from "./dev/runners.js";
import { delegatedDevTasks, endDelegated, updateDevTask } from "./dev/store.js";
import { pullRequestIn, spokenReady } from "./dev/notify.js";
import { pullRequestTarget, rememberOffer } from "./dev/trial.js";
import { channelsFor, notify, spoken, type Channel, type Notice } from "./notify.js";
import { closeSharedBrowser } from "./browser.js";
import { runUnattended } from "./headless.js";
import { startScheduler } from "./scheduler.js";
import { escapeHtml } from "./dev/notify.js";
import { warmRecordedLines } from "./conversation.js";
import { voiceChoice } from "./voice/choice.js";
import { warmPiper } from "./voice/piper.js";
import { warmWhisper } from "./voice/whisper.js";
import { language } from "./language.js";
import { configurePlanStore, loadPlanUsage } from "./plan.js";
import { attachWebsocket } from "./ws.js";
import { healthWithBoard, lastHealth, publishHealth, runHealthChecks, specsFor } from "./health.js";
import { boardSource, boardWatched, forgetRunner, onBoard, refreshBoard, topicOf, useBoardSource } from "./dev/board.js";

/** How often every dependency is asked whether it still answers. */
/** How often delegated runners that went quiet are looked in on. */
const RUNNER_LOOK_MS = 10 * 60_000;

/** A job older than this that turns out to have stopped is tidied without a message. */
const RUNNER_NEWS_MS = 48 * 3_600_000;

const HEALTH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How often the runner board is rebuilt while a page is watching it.
 *
 * Every change this process makes rebuilds it at once; this is for the ones it
 * does not see -- a runner closed by hand at the other machine, a session that
 * died. One SSH login a minute, and none while no page is open.
 */
const BOARD_INTERVAL_MS = 60_000;

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
  // Send-only on purpose: no poller is ever opened on this token.
  const digestBot =
    config.digestToken !== "" && config.digestChat !== "" ? new Telegram(config.digestToken) : null;

  // What the runner supervisor can do over the delegate seam, which is the
  // pack's business rather than core's: close a slot, type into it, and mark
  // the job's record when the runner says it is done.
  const closeSlot = async (slot: number) => {
    const closed = await (await packSummary()).delegate.kill(slot);
    if (closed.ok) forgetRunner(slot);
    refreshBoard();
    return closed;
  };
  const runnerSeam: RunnerSeam = {
    reply: async (slot, text) => {
      const delegate = (await packSummary()).delegate;
      return delegate.reply === undefined
        ? { ok: false, error: "this delegate cannot pass a message to a runner" }
        : delegate.reply(slot, text);
    },
    consider: (report, question) => consider(store, report, question),
    finished: (slot, summary) => {
      const ended = endDelegated(store.devConnection(), slot, { state: "finished", detail: summary }, new Date());
      refreshBoard();
      // Out loud, to whichever screen is open: the chat has the whole message,
      // and this is the sentence that makes him go and read it.
      // A pull request whose repository is known can be tried before it is
      // merged, and the sentence offers that; the offer waits for the answer.
      if (ended !== null) {
        const tryable = pullRequestTarget(summary) !== null;
        const said = spokenReady(topicOf(ended), pullRequestIn(summary), tryable);
        if (tryable) rememberOffer(store.devConnection(), ended.id, said, new Date());
        void notify([spoken], { spoken: said }).catch((error: unknown) =>
          console.error("runners: could not say a job is done:", error),
        );
      }
    },
  };

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
        void supervise(store, bot, config.suggestChat, report, closeSlot, runnerSeam);
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
  // Loading a model takes seconds; the first sentence should not wait for it.
  if (config.voiceProvider === "piper") warmPiper(config);
  if (config.listenProvider === "whisper") warmWhisper(config);
  void warmRecordedLines().catch((error: unknown) => {
    console.warn("voice: could not record the opening lines:", error);
  });
  // The lines are kept per voice, so a voice that was just asked for has none
  // of them yet and the next silence would be filled live.
  voiceChoice().onChange((lang) => {
    void warmRecordedLines(lang).catch((error: unknown) =>
      console.warn("voice: could not record the lines in the new voice:", error),
    );
  });
  // A language nobody spoke before has no recorded lines yet; a switch asked
  // for in conversation needs them as much as the start does.
  language().onChange((lang) => {
    console.log(`language: switched to ${lang}`);
    void warmRecordedLines(lang).catch((error: unknown) =>
      console.warn("language: could not record the lines:", error),
    );
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

  // Jobs the assistant was asked to do later. Their results have no
  // conversation to land in, so they go where an unprompted message goes: to
  // the phone if there is a bot, to the webhook if there is one, and out loud
  // if a screen happens to be open.
  let stopScheduler: () => void = () => {};
  if (config.schedule) {
    const phone: Channel | null =
      bot === null
        ? null
        : {
            name: "telegram",
            deliver: async (notice: Notice) => {
              if (notice.written === undefined || notice.written === "") return false;
              await bot.send(config.suggestChat, escapeHtml(notice.written));
              return true;
            },
          };
    const reach = [...channelsFor(null, config), ...(phone === null ? [] : [phone])];
    if (reach.length === 1) {
      console.warn("schedule: no written channel is configured, so results can only be spoken");
    }
    stopScheduler = startScheduler({
      db: store.scheduleConnection(),
      run: (prompt, job) => runUnattended(prompt, `job-${job.id}-${Date.now()}`),
      deliver: async (job, text, kind) => {
        // A failure is for whoever runs the assistant, so it stays on the main bot; only a result
        // is a digest. A digest that could not be sent falls through rather than being lost.
        if (job.deliver === "digest" && kind === "result" && digestBot !== null) {
          if ((await digestBot.send(config.digestChat, escapeHtml(text))) !== null) return;
          console.error(`schedule: job ${job.id} (${job.name}): digest bot could not send, using the main channels`);
        }
        const short = text.length <= 300 && kind === "result" && job.deliver === "all";
        const notice: Notice =
          kind === "failure"
            ? { written: text }
            : { ...(short ? { spoken: text } : {}), written: text };
        await notify(reach, notice);
      },
    });
  }

  // The door, on its own connection and only when a deployment named one. The
  // observation layer holds a house too, but it holds it only from `observe`
  // upwards, and a camera that goes up by itself is worth having in a
  // deployment that watches nothing else.
  const doorWatches = parseDoorWatch(process.env["JARVIS_DOOR_WATCH"]);
  let doorHome: HomeProvider | null = null;
  let stopDoorWatch: () => void = () => {};
  if (doorWatches.length > 0) {
    doorHome = createHome(config);
    if (doorHome === null) {
      console.error("door watch: configured, but this deployment has no house to watch");
    } else {
      const house = doorHome;
      void house
        .connect()
        .then(() => startDoorWatch(house, doorWatches))
        .then((stop) => {
          stopDoorWatch = stop;
          console.log(`door watch: ${doorWatches.length} camera(s) armed`);
        })
        .catch((error: unknown) => console.error("door watch: could not start:", error));
    }
  }

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
      .then(publishHealth)
      .catch((error: unknown) => console.error("health checks failed:", error));
  };
  checkHealth();
  const healthTimer = setInterval(checkHealth, HEALTH_INTERVAL_MS);
  healthTimer.unref();

  // The runner board, and the delegate's health row kept in step with it: the
  // row is a count of free slots, and the board knows that count sooner.
  useBoardSource(boardSource(store.devConnection(), async () => (await packSummary()).delegate));
  onBoard((board) => {
    const checks = lastHealth();
    if (checks !== null) publishHealth(healthWithBoard(checks, board));
  });
  const boardTimer = setInterval(() => {
    if (boardWatched()) refreshBoard();
  }, BOARD_INTERVAL_MS);
  boardTimer.unref();

  let hangUp: (() => void) | null = null;

  if (bot !== null && chat !== null) {
    const db = store.proactiveConnection();
    hangUp = bot.listen({
      pressed: async (press) => {
        if (press.chatId !== config.suggestChat) return;
        // Closing a delegated slot travels back over the same seam the job left
        // by, which is the pack's business rather than core's.
        const closed = await handleRunnerPress(bot, closeSlot, press);
        if (closed) return;
        await handlePress(db, bot, press);
      },
      said: async (said) => {
        // A reply to a runner's question goes to that runner, not to the chat.
        if (said.chatId === config.suggestChat && (await handleRunnerReply(bot, runnerSeam.reply, said))) {
          return;
        }
        await chat.said(said);
      },
    });
    console.log("telegram: listening for answers and questions");
  }

  // Runners that went quiet without reporting are looked in on from here: one
  // stuck on a prompt never ends a turn, and one that died never reports.
  let lookTimer: NodeJS.Timeout | null = null;
  if (bot !== null) {
    const look = () => {
      const db = store.devConnection();
      const watched = delegatedDevTasks(db).map((task) => ({
        id: task.id,
        slot: task.slot ?? -1,
        task: task.instruction,
        since: Date.parse(task.createdAt),
        job: task.job,
      }));
      if (watched.length === 0) return;
      void packSummary()
        .then(async (packs) => {
          // Which job is in which slot, where the far side names them. One
          // question for the whole look: the answer is what tells a job that
          // ended from a job whose slot has been handed on.
          const seen = (await packs.delegate.occupancy?.()) ?? null;
          const running = new Map<number, string>(
            (seen ?? [])
              .filter((slot) => slot.busy && slot.job !== undefined)
              .map((slot) => [slot.slot, slot.job as string]),
          );
          await lookIn(
            watched,
            packs.delegate.slots,
            running,
            (slot, lines) => packs.delegate.tail(slot, lines),
            (report) => supervise(store, bot, config.suggestChat, report, closeSlot, runnerSeam),
            async (job, why) => {
              // By id, not by slot: a slot with a stale row and a running job
              // has two rows that say "delegated", and the one that is over is
              // not the newest of them.
              updateDevTask(
                db,
                job.id,
                {
                  state: "failed",
                  detail:
                    why === "taken"
                      ? "the runner was gone and its slot had been handed to another job"
                      : "the runner stopped without saying it was done",
                },
                new Date(),
              );
              // A slot that has been handed on belongs to somebody else's work
              // now, so neither its note nor its runner is this job's to touch.
              // A runner that died does still leave its job directory behind,
              // and closing the slot is what clears it.
              if (why === "stopped") {
                forgetRunner(job.slot);
                void closeSlot(job.slot).catch(() => undefined);
              }
              refreshBoard();
              // A job from weeks ago that nobody closed off is tidied quietly;
              // only one that was still news is worth a message.
              if (Date.now() - job.since < RUNNER_NEWS_MS) {
                await bot.send(config.suggestChat, goneMessage(job.slot, job.task));
              }
            },
            // A pane that has stopped moving is the owner's to look at: nothing
            // is closed and nothing is typed in without him, because a job that
            // is only slow would lose its work either way.
            async (job, stillFor) => {
              await sayStalled(bot, config.suggestChat, job, stillFor, runnerSeam);
            },
            Date.now(),
          );
        })
        .catch((error: unknown) => console.error("runners: could not look in:", error));
    };
    look();
    lookTimer = setInterval(look, RUNNER_LOOK_MS);
    lookTimer.unref();
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
    stopScheduler();
    void closeSharedBrowser();
    stopDoorWatch();
    doorHome?.close();
    if (lookTimer !== null) clearInterval(lookTimer);
    clearInterval(boardTimer);
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
