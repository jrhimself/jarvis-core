/**
 * Pull requests on the repository this runs from, over the REST API.
 *
 * Not `gh`, and not the deploy key. The deploy key can push a branch and
 * nothing else -- opening or merging a pull request is the REST API and needs a
 * user token -- and `gh` on a given machine may well be signed in as somebody
 * other than the account this repository should be touched with. A fine-grained
 * token scoped to this one repository, with contents and pull-requests write and
 * nothing more, is the smallest thing that does the job.
 *
 * Every call is explicit about failure. A pull request that silently did not
 * open is worse than one that failed loudly: JARVIS would say a change is
 * waiting for him and there would be nothing there.
 */

const API = "https://api.github.com";

/** GitHub is not slow, and a hanging call here blocks a spoken answer. */
const TIMEOUT_MS = 20_000;

export interface GitHubConfig {
  /** owner/name, as the forge spells it. */
  repo: string;
  /** Fine-grained token with contents:write and pull_requests:write. */
  token: string;
}

export interface PullRequest {
  number: number;
  url: string;
  state: "open" | "closed";
  merged: boolean;
  /** GitHub's own verdict: clean, blocked, dirty, unstable... */
  mergeable_state: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call(
  config: GitHubConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Result<Record<string, unknown>>> {
  const response = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jarvis-brain",
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error: unknown) => {
    console.error(`github unreachable (${path}):`, error);
    return null;
  });

  if (response === null) return { ok: false, error: "GitHub cannot be reached." };
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : `${response.status}`;
    return { ok: false, error: `GitHub gaf ${response.status}: ${message}` };
  }
  return { ok: true, value: body };
}

/** Shapes a pull-request payload without asserting the whole of GitHub's schema. */
export function readPullRequest(body: Record<string, unknown>): PullRequest | null {
  const number = Number(body.number);
  const url = body.html_url;
  if (!Number.isInteger(number) || typeof url !== "string") return null;
  return {
    number,
    url,
    state: body.state === "closed" ? "closed" : "open",
    merged: body.merged === true,
    mergeable_state: typeof body.mergeable_state === "string" ? body.mergeable_state : null,
  };
}

export async function openPullRequest(
  config: GitHubConfig,
  pr: { title: string; branch: string; body: string },
): Promise<Result<PullRequest>> {
  const created = await call(config, `/repos/${config.repo}/pulls`, {
    method: "POST",
    body: { title: pr.title, head: pr.branch, base: "main", body: pr.body },
  });
  if (!created.ok) return created;
  const shaped = readPullRequest(created.value);
  return shaped === null
    ? { ok: false, error: "GitHub returned a pull request I could not read." }
    : { ok: true, value: shaped };
}

export async function getPullRequest(
  config: GitHubConfig,
  number: number,
): Promise<Result<PullRequest>> {
  const got = await call(config, `/repos/${config.repo}/pulls/${number}`);
  if (!got.ok) return got;
  const shaped = readPullRequest(got.value);
  return shaped === null
    ? { ok: false, error: "GitHub returned a pull request I could not read." }
    : { ok: true, value: shaped };
}

/**
 * Squash-merges a pull request and returns the commit that landed on main.
 *
 * Squash rather than merge: a worker's intermediate commits are its thinking
 * out loud, and `main` here is read by a person looking for when something
 * changed.
 */
export async function mergePullRequest(
  config: GitHubConfig,
  number: number,
  title: string,
): Promise<Result<string>> {
  const merged = await call(config, `/repos/${config.repo}/pulls/${number}/merge`, {
    method: "PUT",
    body: { merge_method: "squash", commit_title: `${title} (#${number})` },
  });
  if (!merged.ok) return merged;
  const sha = merged.value.sha;
  if (merged.value.merged !== true || typeof sha !== "string") {
    const message = typeof merged.value.message === "string" ? merged.value.message : "onbekend";
    return { ok: false, error: `GitHub weigerde de merge: ${message}` };
  }
  return { ok: true, value: sha };
}

/** Deletes the merged branch. A failure here is cosmetic and is not raised. */
export async function deleteBranch(config: GitHubConfig, branch: string): Promise<void> {
  await call(config, `/repos/${config.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "DELETE",
  });
}
