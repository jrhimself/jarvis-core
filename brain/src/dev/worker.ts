/**
 * The agent that writes the change, kept on a short leash.
 *
 * It gets five tools -- read, write, edit, glob, grep -- and no shell. That is
 * the whole security argument for this module: the SDK confines the file tools
 * to the working directory it was started in, so a worker with no `Bash` can
 * reach nothing outside its own throwaway worktree. It cannot push, cannot
 * curl, cannot reach the delegate key sitting in `~/.ssh`. Everything that
 * touches git, the network or the service is done by the code around it, where
 * the rules are readable and tested.
 *
 * The session stays open between calls on purpose. When the suite fails the
 * output goes back into the same conversation rather than into a fresh one --
 * a worker that has just written the code knows why the test broke, and a new
 * one would have to read its way back to that.
 */

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

import { MAX_FILES, PROTECTED_PATHS, WORKER_MAX_TURNS } from "./guard.js";

/** What the worker is told about the house style before it starts. */
export function workerPrompt(): string {
  return [
    "You are extending JARVIS, a Dutch-speaking voice assistant, by changing his own",
    "TypeScript source. You are working in a throwaway git worktree; only the files here",
    "matter and nothing outside it is reachable.",
    "",
    "House style, which the reviewer will hold you to:",
    "- Code, comments, commit-worthy prose and documentation are in English. Only strings",
    "  the assistant speaks aloud are in Dutch.",
    "- Comments explain why, not what. Match the density and voice of the file you are in;",
    "  read a neighbouring module before writing a new one.",
    "- Every behavioural change gets a test in brain/test/, on Node's own test runner.",
    "  Tests import from dist, never from src.",
    "- Prefer extending an existing module over adding one.",
    "- node:sqlite rows have a null prototype; assert field by field, never deepEqual.",
    "",
    "Hard limits, enforced in code after you finish. Breaking one throws the whole",
    "attempt away, so stop and say so instead:",
    `- Never edit: ${PROTECTED_PATHS.join(", ")}`,
    `- Touch at most ${MAX_FILES} files.`,
    "- Never add a dependency; only what is already installed is available.",
    "",
    "Work in small steps and finish with a short paragraph in Dutch saying what you",
    "changed and what the user will notice, because that paragraph is read out loud.",
  ].join("\n");
}

export interface WorkerOptions {
  /** The worktree the worker may read and write. */
  cwd: string;
  /** Wall-clock budget for the whole attempt. */
  timeoutMs: number;
  /** Something worth showing while it works. */
  onActivity?: (label: string) => void;
}

/** A worker session. One per attempt; `close` ends the process behind it. */
export class DevWorker {
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;
  #stream: ReturnType<typeof query> | null = null;
  #abort = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #timedOut = false;

  constructor(private readonly options: WorkerOptions) {}

  /** True when the attempt was cut off by its own deadline. */
  get timedOut(): boolean {
    return this.#timedOut;
  }

  #start(): void {
    if (this.#stream !== null) return;

    this.#timer = setTimeout(() => {
      this.#timedOut = true;
      this.#abort.abort();
    }, this.options.timeoutMs);
    // A worker outliving nothing: the deadline must not hold the process open.
    this.#timer.unref?.();

    const self = this;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (self.#queue.length === 0) {
          if (self.#closed) return;
          await new Promise<void>((resolve) => {
            self.#wake = resolve;
          });
        }
        const next = self.#queue.shift();
        if (next !== undefined) yield next;
      }
    }

    this.#stream = query({
      prompt: input(),
      options: {
        model: "sonnet",
        systemPrompt: workerPrompt(),
        cwd: this.options.cwd,
        allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
        // No Bash, and no MCP servers. See the note at the top of the file.
        mcpServers: {},
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: WORKER_MAX_TURNS,
        abortController: this.#abort,
        settingSources: [],
      },
    });
  }

  #push(text: string): void {
    this.#queue.push({
      type: "user",
      session_id: "",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text }] },
    } as SDKUserMessage);
    this.#wake?.();
    this.#wake = null;
  }

  /**
   * Sends something to the worker and waits for it to finish answering.
   *
   * Returns what it said, or null when the attempt died -- aborted, out of
   * turns, or the process gone. The caller decides what that means; from here
   * a dead worker and a refusing one look the same and both end the attempt.
   */
  async ask(text: string): Promise<string | null> {
    this.#start();
    const stream = this.#stream;
    if (stream === null) return null;

    this.#push(text);
    let said = "";
    try {
      for await (const message of stream) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") said += block.text;
            if (block.type === "tool_use") this.options.onActivity?.(block.name);
          }
        }
        if (message.type === "result") {
          return message.subtype === "success" ? said.trim() : null;
        }
      }
    } catch (error) {
      console.error("dev worker failed:", error);
      return null;
    }
    return null;
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
    this.#wake = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (!this.#abort.signal.aborted) this.#abort.abort();
    this.#stream = null;
  }
}
