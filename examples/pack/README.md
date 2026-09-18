# The example pack

The smallest pack the loader will start: one setting, one tool, one paragraph of prompt, and no
dependency on anything outside the process. It is here to be copied. Nothing in the repository
loads it — `packs/` is what gets scanned, and this is not in it.

```
cp -r examples/pack packs/greeter          # pick your own id
$EDITOR packs/greeter/pack.json            # "name" must equal the directory name
export JARVIS_EXAMPLE_WHO="Ada"
npx tsc --build packs/greeter
sudo systemctl restart jarvis-brain        # packs are read once, at startup
```

`node brain/dist/prompt-size-cli.js`, with the environment loaded, prints one `packs:` line per
pack that started and one line per pack that did not, with the reason. That is the only place
that says so out loud; startup does not log it.

## What the contract actually is

`brain/src/packs/loader.ts` is the whole of it, comments included, and
[docs/packs.md](../../docs/packs.md) is it as prose, with the habits around it and a checklist to
build against. In short:

| Piece | Rule |
| --- | --- |
| `pack.json` | `name` **must** equal the directory name, and `entry` points at the built entry point. A mismatch is refused rather than guessed at. |
| default export | An object whose `name` is that same name, with `configured()` and `create()`. |
| `configured(context)` | Does this machine have what the pack needs? Read the environment and answer. Returning false is the ordinary case and is silent — no log, no paragraph, no tools. |
| `create(context)` | Returns `{ servers, tools, persona?, probes?, prompt?, delegate? }`. Called once per session. |
| `answer(say, facts)` | What every tool returns: the sentence the assistant phrases its reply from, and the same reading labelled for the HUD's context panel. Built from what the tool just worked out, so the panel costs nothing and can never disagree with what was said. No facts leaves the panel as it was. |
| `context.display(payload, dismiss?, anchor?)` | A window of the pack's own: a panel, a chart, an image or a line of text, for a reading too big to be a tile. The anchor is a word the answer is about to contain, and the window is held back until JARVIS says it, so it lands under the sentence it belongs to instead of two sentences early. Built in the same function as the answer, for the same reason the facts are. |
| server names | One namespace across all packs. The second pack to claim a name is skipped, so that one pack's tools can never quietly replace another's. |
| failure | A pack that throws while loading or being created is dropped with a line in the log, and the others start. A tool call that never returns is answered on the pack's behalf after 60 seconds. |

Two rules do not appear in any type and will still bite:

- **Read `process.env`, never core's `Config`.** A pack that lives in its own repository cannot
  expect its keys to be in core's configuration, and should not want them there. `src/config.ts`
  here is the whole pattern.
- **Depend only on what `brain` already depends on.** `packs/` is deliberately not an npm
  workspace: a pack resolves upwards into core's `node_modules`, and putting it in the workspace
  list writes private package names into the lockfile of a repository that may be public. Anything
  further than the Agent SDK, `zod` and `@jarvis/shared` means bringing your own `node_modules`.

## The shape of the directory

```
pack.json            name, entry, one line of description
package.json         @jarvis/pack-<id>; not installed, but says what it assumes
tsconfig.json        references ../../shared — two levels up from packs/<id> and from here
src/config.ts        what it reads from the environment
src/greet.ts         the logic, the MCP server, the facts on the answer, the window
src/index.ts         the wiring: configured(), create(), context.display, the persona
test/greet.test.ts   the logic, tested
```

`src/index.ts` is untestable by design and stays small for that reason. A pack's own `npm test`
runs `node --test` over the source without building, and Node's type stripping does not rewrite
`./config.js` into `./config.ts` — so a module that imports a *value* from a sibling cannot be
reached from a test. Keep the sibling imports type-only and pass values in as arguments, which is
what `greet.ts` does.

## Turning it into a repository of its own

A pack is given away by being its own repository, cloned into `packs/<id>` by `npm run packs-sync`
from an entry in `config/packs.json`:

```json
{ "packs": [{ "id": "greeter", "repo": "https://github.com/you/jarvis-pack-greeter.git", "ref": "main" }] }
```

The conventions the existing packs follow: repository `jarvis-pack-<id>`, package name
`@jarvis/pack-<id>`, its own `CHANGELOG.md` and semantic versioning, and a README with a table of
every environment variable and whether it is required.

Before the first push, and again before making it public, point core's leak check at it:

```
./scripts/check-no-house-facts.sh --path packs/greeter
```

Core scans a pack no further than asserting it is untracked here, a pack has no denylist of its
own, and most have no CI. That check is the only thing standing between a hard-coded entity id and
a public repository.
