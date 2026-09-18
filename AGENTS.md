# Working in this repository

Notes for a coding agent, human or otherwise. Short on purpose; the reasoning behind most of it is
in [README.md](README.md) and [docs/operations.md](docs/operations.md).

## The six private paths

A checkout that is actually running an assistant holds six things that belong to that deployment
and not to this project. Git does not carry any of them:

| path | what it is |
| --- | --- |
| the env file | credentials; systemd reads it from outside the repository |
| `config/persona.md` | who the assistant is and who it is talking to |
| `config/seeds/*.json` | the first facts it was given |
| `config/packs.json` | which packs this deployment runs, and where they come from |
| `data/` | the memory database, its backups and the corpus |
| `packs/` | every pack this deployment runs — each a checkout of its own, nested and ignored |

`examples/pack` is the exception that proves the last row: it is a pack in shape, tracked here and
loaded nowhere, kept building so that the contract it demonstrates cannot drift from the loader.

Three rules follow, and all three matter more than they look:

1. **Never run `git clean -x`.** All six are ignored, which is exactly what `-x` removes. Use
   `git clean -fd`. There is no undo and no error message: the service restarts with an empty
   database and a default persona, and says so politely.
2. **Never track anything under them.** `git add -f`, `git mv` into one of them, or a new file
   under `config/` will publish it — an ignore rule stops being consulted once git knows about a
   file. `scripts/check-no-house-facts.sh` fails on a tracked file there, which is the backstop,
   not the plan.
3. **Never read one to answer a question about the code.** They describe a household. Nothing in
   this repository is allowed to depend on their contents, so nothing about the code needs them.

## Before every commit

```bash
npm run build && npm test        # the whole suite, node --test, no framework
npm run test:types               # the test tsconfigs
./scripts/check-no-house-facts.sh
```

The last one is the publication gate. It scans tracked files for the shapes that identify one
household — an address, a hostname, a home directory, a mailbox, a credential — and never prints
what it matched, so a failing run in a public log still gives nothing away. The household's own
words live in `.denylist.local`, which is ignored here; without that file the check still runs its
structural half and says how many private patterns it loaded.

There is a `no-house-facts: allow` marker for lines that must contain what they contain. It is for
structural rules only. If you reach for it to wave through a name, the answer is to remove the name.

## Writing a pack

[docs/packs.md](docs/packs.md) before you start, and its checklist before you open the pull
request. It is where the rules that no type enforces live — env-only configuration, the dependency
ceiling, a probe for anything across the network, and `answer(say, facts)` from every tool whose
answer has figures in it.

## Before publishing a pack

A pack is a repository of its own, and the check above deliberately looks no further into
`packs/` than asserting it is untracked here. That leaves it guarded on neither side, and a
pack is the thing most likely to be given away. Point the same check at it:

```bash
./scripts/check-no-house-facts.sh --path packs/<pack>
```

The denylist stays here and is read from beside the script, so the check travels and the words do
not. Run it before the first push of a pack repository and before making one public.

## Shape of the thing

- npm workspaces. `brain/` is the service, `hud/` the browser front end, `shared/` the types and
  seams. The capabilities are packs, and no pack is in this repository: `packs/` is filled by
  `npm run packs-sync` from the manifests and is not a workspace.
- Nothing above the `HomeProvider` seam in `shared/src/home.ts` may know what a home is connected
  to. Home Assistant lives in one pack and nowhere else.
- A pack owns its own tools, health probes and persona paragraph, and reads what it needs from
  `process.env` rather than from core's `Config` — that is what makes it installable elsewhere.
- Tests import from `dist`, so `npm test` builds first. TypeScript is strict; there is no `any`
  anywhere on purpose.
- Node 22.18 or later. Not merely 22, and not 22.13 either: `node:sqlite` needs a flag
  before 22.13, and `npm test` runs the TypeScript directly, which needs the type stripping
  that is only unflagged from 22.18. Below it every test file fails to load.

## What is enforced in code, not in prose

Do not weaken these to make something pass. If one is in your way, that is the finding.

- The spoken two-turn confirmation for anything physical: `control.ts` in the `hass` pack, which is a
  repository of its own. `PROTECTED_PATHS` covers all of `packs/` so a small fix cannot reach it.
- The self-development guard: `brain/src/dev/guard.ts`, including its own `PROTECTED_PATHS`, the
  four-file ceiling and the daily limit.
- The deploy path: `scripts/`, `deploy/`, `.github/`, and every `package.json`.

## Writing

Everything in this repository is English, including comments and commit messages. Comments say why,
not what; the surrounding files are the style guide. A comment that explains a decision is worth
keeping, one that narrates the line below it is not.
