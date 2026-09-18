/**
 * Running a command and getting its output back, with a deadline.
 *
 * `execFile` rather than `exec`: every argument here comes from something the user
 * said out loud, and a shell in between turns a spoken branch name into an
 * injection point. Nothing in this module ever builds a command string.
 */

import { execFile } from "node:child_process";

export interface Ran {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Output kept per stream, enough for a failing test run's tail. */
const MAX_BUFFER = 4 * 1024 * 1024;

export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Ran> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: MAX_BUFFER,
        env: options.env,
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resolve({ ok: error === null, code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

/** The last lines of a command's output, for a failure that has to be spoken about. */
export function tail(text: string, lines: number): string {
  const kept = text.trimEnd().split("\n").slice(-lines);
  return kept.join("\n");
}
