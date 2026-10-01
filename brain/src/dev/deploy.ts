/**
 * Asking to be restarted on newly merged code.
 *
 * The brain cannot do this itself and should not be able to. Its unit runs with
 * `NoNewPrivileges=yes`, so `sudo systemctl restart` would fail even if it were
 * attempted, and widening that to make self-deployment work would hand a
 * self-modifying process a general-purpose root path.
 *
 * So the brain writes a commit hash into a file and stops. A systemd path unit
 * notices the file and starts a root one-shot that fetches, checks the hash is
 * really on `origin/main`, runs the suite and restarts the service, rolling
 * back if any of that fails. The whole vocabulary across the boundary is a
 * forty-character string, or a pack's name and one, and the only thing it can
 * ask for is "run the code that is already merged".
 *
 * A pack is asked for separately because it is its own repository with its own
 * main: the running copy under `packs/<id>` is moved to the merged commit,
 * built, and the service restarted on it. Without that nothing a merged pack
 * pull request adds would ever reach this process.
 *
 * The answer comes back the same way, as a small JSON file, because by the time
 * the deploy finishes the process that asked for it no longer exists.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const REQUEST_FILE = "deploy-request";
export const RESULT_FILE = "deploy-result.json";

export interface DeployResult {
  /** The commit the deploy was asked to run. */
  sha: string;
  ok: boolean;
  /** Which step ended it: restarted, tests, fetch, ancestry... */
  step: string;
  /** When the root side finished, ISO. */
  at: string;
  detail: string;
}

/** Only a full hex commit hash crosses the boundary. */
export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * A pack is named by its directory under `packs/`, and the root side turns that
 * name into a path, so the shape is as much a boundary as the hash is.
 */
export function isPackId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);
}

async function request(
  dataDir: string,
  line: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await writeFile(join(dataDir, REQUEST_FILE), `${line}\n`, "utf8");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `Could not request the deploy: ${String(error)}` };
  }
}

export async function requestDeploy(
  dataDir: string,
  sha: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isCommitSha(sha)) {
    return { ok: false, error: "That is not a full commit hash." };
  }
  return request(dataDir, sha);
}

/** The same, for the running copy of one pack rather than for this repository. */
export async function requestPackDeploy(
  dataDir: string,
  pack: string,
  sha: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isPackId(pack)) {
    return { ok: false, error: "That is not a pack I can name." };
  }
  if (!isCommitSha(sha)) {
    return { ok: false, error: "That is not a full commit hash." };
  }
  return request(dataDir, `pack ${pack} ${sha}`);
}

/** Reads back what the root side made of the last request, if anything. */
export function readDeployResult(raw: string): DeployResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (typeof body.sha !== "string" || typeof body.step !== "string") return null;
  return {
    sha: body.sha,
    ok: body.ok === true,
    step: body.step,
    at: typeof body.at === "string" ? body.at : "",
    detail: typeof body.detail === "string" ? body.detail : "",
  };
}

export async function lastDeploy(dataDir: string): Promise<DeployResult | null> {
  const raw = await readFile(join(dataDir, RESULT_FILE), "utf8").catch(() => null);
  return raw === null ? null : readDeployResult(raw);
}
