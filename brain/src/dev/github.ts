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
  /** Its title, which is also the subject of the squash commit. */
  title: string;
  /** The branch it would merge, as the head repository names it. */
  branch: string;
  /** Where that branch lives, `owner/name`, so a fork's branch is left alone. */
  headRepo: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** GitHub's own verdict: clean, blocked, dirty, unstable... */
  mergeable_state: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The same token pointed at another repository.
 *
 * A pull request is not always in the assistant's own source -- a pack is a
 * repository of its own -- and reaching one is the same calls against another
 * name. Whether the token is allowed there is GitHub's answer to give.
 */
export function inRepo(config: GitHubConfig, repo: string): GitHubConfig {
  return { repo, token: config.token };
}

async function request(
  config: GitHubConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Result<unknown>> {
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
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string"
        ? (body as { message: string }).message
        : `${response.status}`;
    return { ok: false, error: `GitHub answered ${response.status}: ${message}` };
  }
  return { ok: true, value: body };
}

async function call(
  config: GitHubConfig,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Result<Record<string, unknown>>> {
  const got = await request(config, path, init);
  if (!got.ok) return got;
  return typeof got.value === "object" && got.value !== null && !Array.isArray(got.value)
    ? { ok: true, value: got.value as Record<string, unknown> }
    : { ok: false, error: "GitHub returned something I could not read." };
}

/** Shapes a pull-request payload without asserting the whole of GitHub's schema. */
export function readPullRequest(body: Record<string, unknown>): PullRequest | null {
  const number = Number(body.number);
  const url = body.html_url;
  if (!Number.isInteger(number) || typeof url !== "string") return null;
  const head = (typeof body.head === "object" && body.head !== null ? body.head : {}) as Record<string, unknown>;
  const headRepo = (typeof head.repo === "object" && head.repo !== null ? head.repo : {}) as Record<string, unknown>;
  return {
    number,
    url,
    title: typeof body.title === "string" ? body.title : "",
    branch: typeof head.ref === "string" ? head.ref : "",
    headRepo: typeof headRepo.full_name === "string" ? headRepo.full_name : "",
    state: body.state === "closed" ? "closed" : "open",
    merged: body.merged === true,
    draft: body.draft === true,
    mergeable_state: typeof body.mergeable_state === "string" ? body.mergeable_state : null,
  };
}

/**
 * The open pull requests on one repository, most recently touched first.
 *
 * `mergeable_state` is not filled in here -- GitHub works it out per pull
 * request, on the single-request call -- so a candidate picked from this list is
 * fetched again before anything is said about whether it can be merged.
 */
export async function listPullRequests(config: GitHubConfig, limit = 20): Promise<Result<PullRequest[]>> {
  const got = await request(
    config,
    `/repos/${config.repo}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`,
  );
  if (!got.ok) return got;
  if (!Array.isArray(got.value)) return { ok: false, error: "GitHub returned something I could not read." };
  const shaped = got.value
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map(readPullRequest)
    .filter((pull): pull is PullRequest => pull !== null);
  return { ok: true, value: shaped };
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
    const message = typeof merged.value.message === "string" ? merged.value.message : "it did not say why";
    return { ok: false, error: `GitHub refused the merge: ${message}` };
  }
  return { ok: true, value: sha };
}

/** Deletes the merged branch. A failure here is cosmetic and is not raised. */
export async function deleteBranch(config: GitHubConfig, branch: string): Promise<void> {
  await call(config, `/repos/${config.repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "DELETE",
  });
}
