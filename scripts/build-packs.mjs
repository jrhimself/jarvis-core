/**
 * Builds the installed packs, if there are any.
 *
 * `packs/` holds packs that live outside this repository, each one a checkout
 * of its own. A fresh clone has none until `packs-sync` has run, so this exits
 * cleanly when there are none and forwards TypeScript's own exit code when
 * there are. The alternative, a `|| true` in the npm script, would swallow real
 * compile errors along with the absence.
 *
 * The directory is scanned rather than read from a list. A list would be a
 * second place to register a pack, and the one that is quietly forgotten: a
 * pack missing from it still loads at runtime, because the pack loader scans,
 * and only fails to be type-checked -- which is the kind of gap that surfaces
 * a release later.
 */

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const root = "packs";

const projects = existsSync(root)
  ? readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${root}/${entry.name}`)
      .filter((dir) => existsSync(`${dir}/tsconfig.json`))
      .sort()
  : [];

if (projects.length === 0) {
  console.log("build-packs: no packs installed, nothing to build");
  process.exit(0);
}

const built = spawnSync("npx", ["tsc", "--build", ...projects], { stdio: "inherit" });
process.exit(built.status ?? 1);
