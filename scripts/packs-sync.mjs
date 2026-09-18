/**
 * Clones, updates and builds the packs this deployment runs.
 *
 * Every pack lives in a repository of its own, so that it can be given away
 * without handing over everything else along with it -- and so that this one
 * carries no tools at all. The price is a reinstall becoming an afternoon of
 * remembering which repositories there were, and this script is what buys it
 * back: a manifest is the one place a pack is named, and everything else -- the
 * loader, the build -- discovers packs by scanning.
 *
 * Two manifests, read in this order. `examples/packs.json` is the one shipped
 * here: the packs core is built around, so that a fresh clone is not tool-less.
 * `config/packs.json` is the deployment's own, and an id in it replaces the
 * shipped entry rather than adding a second -- the same rule the loader used to
 * apply to a directory that shadowed a built-in pack, moved to where packs are
 * now named. Merged rather than replaced, because a deployment that lists one
 * pack of its own means to add one pack, not to stop updating the rest.
 *
 * Nothing here is allowed to throw work away. A checkout with uncommitted
 * changes, or one sitting on a different branch than the manifest asks for, is
 * reported and skipped rather than reset: the odds that it is somebody's
 * unfinished evening are far better than the odds that it is debris.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SHIPPED = "examples/packs.json";
const OWN = "config/packs.json";

/** An id becomes a directory name, so it may only look like one. */
const ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Where the loader looks, and therefore the only place worth cloning to.
 *
 * `path` exists for a pack whose directory is not named after its id, not for
 * one kept somewhere else: the loader scans `packs/` and nothing deeper or
 * elsewhere, so a checkout outside it would be fetched, fast-forwarded and
 * built on every sync while never loading. Silently.
 */
const INSTALLABLE = /^packs\/[a-z0-9][a-z0-9-]*$/;

function git(cwd, ...args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: run.status === 0,
    out: (run.stdout ?? "").trim(),
    err: (run.stderr ?? "").trim(),
  };
}

function report(id, state, detail) {
  console.log(`${state.padEnd(8)}${id}${detail === "" ? "" : `  ${detail}`}`);
}

/** The packs a manifest lists, or none when it is not there. Invalid is fatal. */
function read(path) {
  if (!existsSync(path)) return [];
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.error(`packs-sync: ${path} is not valid JSON: ${error.message}`);
    process.exit(1);
  }
  return Array.isArray(manifest.packs) ? manifest.packs : [];
}

const shipped = read(SHIPPED);
const own = read(OWN);

// Last one wins, which is what makes `config/packs.json` able to pin a shipped
// pack to a fork or a branch without having to restate the others.
const merged = new Map();
for (const entry of [...shipped, ...own]) merged.set(String(entry.id ?? ""), entry);
const entries = [...merged.values()];

const replaced = shipped.filter((entry) => own.some((mine) => mine.id === entry.id)).length;
console.log(
  `packs-sync: ${shipped.length} from ${SHIPPED}, ${own.length} from ${OWN}` +
    (replaced === 0 ? "" : ` (${replaced} replaced)`),
);

if (entries.length === 0) {
  console.log("packs-sync: no packs listed, nothing to sync");
  process.exit(0);
}

const built = [];
let failed = false;

for (const entry of entries) {
  const id = String(entry.id ?? "");
  if (!ID.test(id)) {
    console.error(`packs-sync: "${id}" is not a usable pack id`);
    failed = true;
    continue;
  }

  const repo = String(entry.repo ?? "");
  const ref = String(entry.ref ?? "main");
  // A pack is installed under its own id; `path` is for the rare checkout whose
  // directory has to be called something else.
  const path = String(entry.path ?? `packs/${id}`);
  if (!INSTALLABLE.test(path)) {
    report(id, "failed", `${path} is not a directory the loader scans`);
    failed = true;
    continue;
  }

  if (!existsSync(path)) {
    if (repo === "") {
      report(id, "missing", "no repo in the manifest and nothing on disk");
      failed = true;
      continue;
    }
    const cloned = git(".", "clone", "--quiet", "--branch", ref, repo, path);
    if (!cloned.ok) {
      report(id, "failed", cloned.err.split("\n")[0] ?? "clone failed");
      failed = true;
      continue;
    }
    report(id, "cloned", `${ref} into ${path}`);
    built.push(path);
    continue;
  }

  if (!existsSync(`${path}/.git`)) {
    report(id, "skipped", `${path} exists but is not a checkout`);
    built.push(path);
    continue;
  }

  const dirty = git(path, "status", "--porcelain");
  if (dirty.out !== "") {
    report(id, "skipped", "uncommitted changes, left alone");
    built.push(path);
    continue;
  }

  const branch = git(path, "rev-parse", "--abbrev-ref", "HEAD");
  if (branch.out !== ref) {
    report(id, "skipped", `on ${branch.out}, manifest asks for ${ref}`);
    built.push(path);
    continue;
  }

  const fetched = git(path, "fetch", "--quiet", "origin", ref);
  if (!fetched.ok) {
    report(id, "failed", fetched.err.split("\n")[0] ?? "fetch failed");
    failed = true;
    continue;
  }

  const before = git(path, "rev-parse", "HEAD").out;
  const remote = git(path, "rev-parse", "FETCH_HEAD").out;

  // A checkout carrying commits origin has not seen fast-forwards to itself, so
  // the merge below would report it as current and say nothing about the work
  // sitting there unpushed. Which is the one thing worth saying about it.
  if (before !== remote && git(path, "merge-base", "--is-ancestor", remote, before).ok) {
    report(id, "ahead", `${before.slice(0, 7)}, not pushed`);
    built.push(path);
    continue;
  }

  const merged = git(path, "merge", "--ff-only", "FETCH_HEAD");
  if (!merged.ok) {
    report(id, "skipped", "cannot fast-forward, left alone");
    built.push(path);
    continue;
  }

  const after = git(path, "rev-parse", "HEAD").out;
  report(id, after === before ? "current" : "updated", after.slice(0, 7));
  built.push(path);
}

// A directory that is not a TypeScript project is not a broken pack: build
// output left behind by a pack that has moved away looks exactly like this, and
// so does a pack written in plain JavaScript. Handing it to `tsc` turns either
// one into a failed sync that says nothing about what is actually wrong.
const projects = built.filter((path) => existsSync(`${path}/tsconfig.json`));

if (projects.length > 0) {
  console.log("");
  const compiled = spawnSync("npx", ["tsc", "--build", ...projects], { stdio: "inherit" });
  if (compiled.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
