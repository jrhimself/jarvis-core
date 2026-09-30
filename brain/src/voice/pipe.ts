/**
 * A Python process that stays running, and the pipe the brain talks to it over.
 *
 * Two things here run a model too heavy to load per request -- Piper speaks, and
 * Whisper listens -- and both are a script that loads it once and then answers
 * jobs for as long as the brain lives. This is the part they share: starting the
 * process, waiting for it to say it is ready, sending one job at a time, giving
 * up on a job that hangs, and starting afresh after the process dies.
 *
 * The protocol is small. In, on stdin, one JSON object per line -- the job, with
 * an `id` added here. Out, on stdout, binary frames: a kind byte, the job's id
 * and the payload length as big-endian uint32, then the payload.
 *
 *     R  ready; the model is loaded
 *     A  data for the job (audio for Piper, the text heard for Whisper)
 *     D  the job is finished
 *     E  the job failed; the payload is the reason
 *
 * Anything meant for a human goes to stderr; stdout carries frames and nothing
 * else. One job is in flight at a time, so cancelling costs at most the one
 * being worked on.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface PipeSink {
  onData: (payload: Buffer) => void;
  onDone: () => void;
  onError: (reason: string) => void;
}

interface Job extends PipeSink {
  id: number;
  payload: Record<string, unknown>;
  cancelled: boolean;
}

export interface PipeOptions {
  command: string;
  args: string[];
  /** Prefix for what the process writes to stderr, so the log says whose it is. */
  label: string;
  /** Longest the process may take to load its model. */
  readyTimeoutMs: number;
  /** Longest one job may take; a hung process must not hold a turn. */
  jobTimeoutMs: number;
}

export class Pipe {
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #onReady: () => void = () => {};
  #buffer: Buffer = Buffer.alloc(0);
  #queue: Job[] = [];
  #active: Job | null = null;
  #timer: NodeJS.Timeout | null = null;
  #next = 1;

  constructor(private readonly options: PipeOptions) {}

  /** Resolves once the process is up with its model loaded; starts it if it is not. */
  ready(): Promise<void> {
    if (this.#ready !== null) return this.#ready;
    const ready = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, { stdio: ["pipe", "pipe", "pipe"] });
      this.#child = child;
      this.#buffer = Buffer.alloc(0);

      const timeout = setTimeout(() => {
        reject(new Error(`${this.options.label} did not start in time`));
        this.#die(`${this.options.label} did not start in time`);
      }, this.options.readyTimeoutMs);

      this.#onReady = () => {
        clearTimeout(timeout);
        resolve();
        this.#pump();
      };
      child.stdout.on("data", (data: Buffer) => this.#read(data));
      child.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text !== "") console.warn(`${this.options.label}: ${text}`);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
        this.#die(error.message);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`${this.options.label} exited (${code})`));
        this.#die(`${this.options.label} exited (${code})`);
      });
      // Writing to a process that has gone is reported on the pipe, and it is
      // reported again by `exit`; the second is the one that is acted on.
      child.stdin.on("error", () => {});
    });
    // A rejection nobody awaits yet -- the process died before anything asked --
    // is not an unhandled one: the next call starts a fresh process.
    ready.catch(() => {});
    this.#ready = ready;
    return ready;
  }

  /** Queues one job; data, then done or an error, arrive on `sink`. */
  request(payload: Record<string, unknown>, sink: PipeSink): { cancel: () => void } {
    const job: Job = { ...sink, id: this.#next++, payload, cancelled: false };
    this.#queue.push(job);
    this.#pump();
    return {
      cancel: () => {
        job.cancelled = true;
        // Not yet sent: nothing to wait for. Already sent: its frames are
        // dropped as they arrive, and the queue moves on at its done.
        const index = this.#queue.indexOf(job);
        if (index >= 0) this.#queue.splice(index, 1);
      },
    };
  }

  #pump(): void {
    if (this.#active !== null || this.#child === null) return;
    const job = this.#queue.shift();
    if (job === undefined) return;
    this.#active = job;
    this.#timer = setTimeout(
      () => this.#die(`${this.options.label} took too long over a job`),
      this.options.jobTimeoutMs,
    );
    this.#child.stdin.write(`${JSON.stringify({ id: job.id, ...job.payload })}\n`);
  }

  #read(data: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    // kind (1) + id (4) + length (4), then the payload.
    while (this.#buffer.length >= 9) {
      const length = this.#buffer.readUInt32BE(5);
      if (this.#buffer.length < 9 + length) return;
      const kind = String.fromCharCode(this.#buffer[0]!);
      const id = this.#buffer.readUInt32BE(1);
      const payload = this.#buffer.subarray(9, 9 + length);
      this.#buffer = this.#buffer.subarray(9 + length);
      this.#handle(kind, id, payload);
    }
  }

  #handle(kind: string, id: number, payload: Buffer): void {
    if (kind === "R") {
      this.#onReady();
      return;
    }
    const job = this.#active;
    if (job === null || job.id !== id) return;

    if (kind === "A") {
      if (!job.cancelled) job.onData(Buffer.from(payload));
      return;
    }
    if (kind === "D" || kind === "E") {
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#timer = null;
      this.#active = null;
      if (!job.cancelled) {
        if (kind === "D") job.onDone();
        else job.onError(payload.toString("utf8") || `${this.options.label} failed`);
      }
      this.#pump();
    }
  }

  /** The process is gone or stuck: fail what was waiting and let the next call start afresh. */
  #die(reason: string): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    if (child !== null) {
      child.removeAllListeners("exit");
      child.kill();
    }
    const waiting = [...(this.#active === null ? [] : [this.#active]), ...this.#queue];
    this.#active = null;
    this.#queue = [];
    for (const job of waiting) if (!job.cancelled) job.onError(reason);
  }

  stop(): void {
    this.#die(`${this.options.label} stopped`);
  }
}
