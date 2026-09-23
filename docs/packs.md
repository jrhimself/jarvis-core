# Writing a pack

Everything JARVIS can do beyond talking, remembering and putting something on screen arrives as a
pack. Core carries none of them: `packs/` is filled by `npm run packs-sync` from a manifest, each
entry a repository of its own.

This page is the contract and the habits around it. [examples/pack](../examples/pack) is the same
thing as a directory you can copy, built and tested with the rest of the repository so it cannot
drift from the loader. `brain/src/packs/loader.ts` is the enforcement, and where the two disagree,
the loader wins.

---

## 1. The shape

```
pack.json            name, entry, one line of description
package.json         @jarvis/pack-<id>; not installed, but says what it assumes
tsconfig.json        references ../../shared
src/config.ts        what it reads from the environment
src/<thing>.ts       the logic, and the MCP server
src/index.ts         the wiring: configured(), create(), the persona paragraph
scripts/check.mjs    what a stranger runs to find out why it did not start
test/<thing>.test.ts the logic, tested
README.md            the variable table, the tools, and what it does when something is missing
CHANGELOG.md         semantic versioning, same as core
```

`pack.json`'s `name` **must** equal the directory name and `entry` must point at the built entry
point. A mismatch is refused rather than guessed at.

## 2. The two rules that hold in no type

Both are invisible to the compiler and both bite in production.

**Read `process.env`, never core's `Config`.** A pack that lives in its own repository cannot expect
its keys to be in core's configuration and should not want them there. Put every read in
`src/config.ts` behind one function, so the answer to "what does this pack need" is one file. Even
a variable core happens to have — `HA_URL`, `HA_TOKEN` — gets read by the pack itself, so the pack
runs the same way on a deployment whose core never heard of it.

**Depend only on what `brain` already depends on.** `packs/` is deliberately not an npm workspace: a
pack resolves upwards into core's `node_modules`, and putting it in the workspace list writes
private package names into the lockfile of a repository that may be public. Anything beyond the
Agent SDK, `zod` and `@jarvis/shared` means bringing your own `node_modules`.

## 3. `configured()` — the ordinary answer is false

Called before `create`. Read the environment and answer whether this machine has what the pack
needs. Returning false registers nothing, adds no paragraph, spends no tokens and says nothing in
the log — that is the correct outcome on most machines and it is not a failure.

Do not reach across the network here. `configured()` runs on every session for every installed
pack; a pack that pings its service to decide costs every session the slowest of them.

What it must not do is return true and then be useless. A pack that starts without its credentials
puts tools in front of the model, and a tool the model can see is a promise already made.

### `summary` and `needs` — so "off" can be acted on

Two optional fields on the pack object itself, next to `name`:

```ts
summary: "greets whoever is in the room",
needs: [{ env: "JARVIS_EXAMPLE_WHO", why: "the name to greet somebody by" }],
```

`configured()` answers yes or no, and no is not something anyone can act on. Core puts these two in
the prompt so the assistant can say *which* variable is empty and what it is for, instead of "that
pack is not configured" — or worse, inventing a plausible variable name. Core reads the environment
itself, so what it reports is measured; the pack only says which names to look at.

List every variable the pack reads, including ones it shares with core. `configured()` stays the
authority on whether the pack runs: the two may disagree in the direction of "every key is set and
it still says no", which core reports honestly as something that is not an environment variable.
Both fields are optional and a pack without them loses nothing but the explanation.

## 4. `create()` — what a half-configured pack contributes is half

Everything is returned from `create`, not declared as a constant, so the prompt describes the
assistant that actually started. The house with no calendars named registers no calendar server,
pre-approves no calendar tool and adds no paragraph about the agenda.

| field | what it is |
| --- | --- |
| `servers` | keyed by MCP server name; tool names are built from it as `mcp__<server>__<tool>` |
| `tools` | the tool-name patterns to pre-approve. Return a tool you did not list and it is registered and then refused, which reads from outside like a broken tool |
| `persona` | this pack's own paragraph of prompt: when to reach for these tools and how to speak about what comes back. Optional — prose written twice drifts, and the drift is invisible until the model follows the stale copy |
| `probes` | see §5 |
| `prompt` | a block of prompt the pack computes rather than writes. Resolved once at session start and allowed to be slow |
| `watch` | readings taken on a clock while a HUD is open; each names a server and tool so the figures land under the right subject |
| `desk` | standing HUD windows this pack keeps on the desk; see §4a |
| `delegate` | somewhere to hand work too big for the assistant. Core keeps the first offered |

`create` is called once per session, not per turn, so a cache — or a pending confirmation — lives
happily in the closure and dies with the conversation.

**Server names are one namespace across all packs.** The second pack to claim a name is skipped, so
one pack's tools can never quietly replace another's.

## 4a. Standing desk windows

Packs add overview windows on the HUD desk through `desk` on what `create` returns:

```ts
desk: [
  { topic: "house", label: "Huis" },
  { topic: "mail", label: "Mail", briefing: true },
],
```

Each slot is a standing window: it survives the next question and a page reload, and a newer
reading of the same subject replaces its contents. Core ships five overview slots (weather,
agenda, mail, work, notes); pack slots are merged on after them.

`briefing` defaults to **false**. Leave it off when the pack only wants a window on the desk; set
`briefing: true` when the morning briefing should cover that subject. A pack that redeclares a
core topic wins for that topic's label and briefing flag, so a house can rename a heading or take
a subject out of the briefing without editing core.

## 5. `probes` — a tick you have not earned is worse than no line

Keyed by server name. A probe resolves with a short line saying what answered, and throws with the
reason when it did not. The same function may be given for several servers: things behind one
daemon stand or fall together, and a dead daemon should cost one timeout rather than one per
server.

A server with no probe is reported healthy without being asked. That is right for a server that
talks to nothing outside the process and **wrong for everything else** — silence about a dependency
reads as health.

## 6. `answer()` — what a tool returns, and the context panel

Every tool of every pack returns the same envelope: a sentence to say, and the figures behind it
already labelled.

```ts
import { answer } from "@jarvis/shared";

return answer("vandaag: bewolkt, 12 tot 22 graden, 55% kans op neerslag", [
  { label: "Today", value: "12–22 °C" },
  { label: "Rain", value: "55 %", on: true },
]);
```

The assistant reads `say` and phrases the answer out of it. Core reads `facts` and puts them in the
HUD's Context panel, as a block of their own under the subject the tool is about — the weather, the
mail, the agenda. **No tool call is spent, no second fetch happens and the model decides nothing**
— the answer was already travelling back through the brain, and a figure the model was asked to
repeat is a figure it can get wrong.

A fact is a label, an already-formatted value carrying its unit, and an optional `on` for something
lit, running or waiting. Six fit; the rest are dropped. Build them from what the tool just worked
out, in the same function, so the panel can never disagree with what was said out loud.

Rules, all of them learned from the panel of invented numbers this replaced:

- **Facts come off an answer, never out of a separate call.** There is nothing to cache and nothing
  to time out. If a tool has no figures to hand, it has no facts.
- **No facts is a real answer.** `answer(say)` with nothing after it leaves the panel exactly as it
  was. So does a tool that failed: `{ content, isError: true }` carries nothing, and a failure
  should not blank the screen — nothing new was learned.
- **A block stays up until the same subject is read again.** "What are we talking about" does not
  stop being true between two questions, and a different subject is a different block rather than a
  replacement. The sheet is trimmed to the height of its column -- blocks come off the bottom as
  new ones arrive at the top -- and outlives the page.
- **A block goes up on the word, not on the answer.** The panel holds new figures back until their
  subject is actually spoken, and puts up whatever is still waiting when the answer ends — the same
  timing a window gets, and for the same reason.
- The same figures twice in a turn are sent once, per subject.

**Put facts on every tool whose answer has figures in it.** This is not optional polish: the panel
is the only part of the screen that says what this deployment is currently looking at, and a pack
that skips it is a pack whose work never shows up there.

A pack that returns plain `{ content: [...] }` still works exactly as before. It just never fills
the panel.

### A window of your own, timed to the sentence

Six tiles are a glance. When a tool read something that is a *list* — the mails, tomorrow's
appointments, the open pull requests — put it on the screen itself:

```ts
context.display(
  { type: "panel", title: "Mail", rows: mails.map((m) => ({ label: m.from, value: m.subject })) },
  undefined,
  "mail",
);
```

The third argument is the anchor: a word JARVIS is about to say about this. The window is held back
until he says it, so the mail appears as he starts on the mail and not two sentences earlier while
he is still on the weather. Leave it out and the window appears where the sentence had got to when
the tool was called, which is right for an answer about one thing and wrong for a briefing that
walks through five.

An anchor is matched case-insensitively against the answer as it is spoken, on its first occurrence.
Pick a word that is certain to be said and belongs to nothing else in that answer: `"mail"`,
`"agenda"`, `"pull requests"`. A word that never comes is not lost — the window goes up when the
answer ends.

Windows stack: the newest is read at full size and the ones before it shrink into a row beneath,
four in view at most. A briefing therefore ends with the morning laid out side by side, which is the
point of showing it at all.

Same discipline as the panel: build it from what the tool just read, in the same function. A window
the model was asked to fill is a window that can disagree with what was said out loud.

## 7. Failure

- A pack that throws while loading or being created is dropped with a line in the log; the others
  start.
- A tool call that never returns is answered on the pack's behalf after 60 seconds.
- `prompt()` that fails should return what it can rather than throw. A session that will not start
  is worse than a prompt with one section missing.

Startup does not log which packs started. `node brain/dist/prompt-size-cli.js`, with the
environment loaded, prints one `packs:` line per pack that started and one per pack that did not,
with the reason. That is the only place that says so out loud.

## 8. Tests

A pack's `npm test` runs `node --test` over the source without building, and Node's type stripping
does not rewrite `./config.js` into `./config.ts`. So a module that imports a **value** from a
sibling cannot be reached from a test. Keep sibling imports type-only and pass values in as
arguments; `src/index.ts` is untestable by design for exactly this reason and stays small to suit.

Run `tsc -p test/tsconfig.json` too. It is the check nobody remembers and the one that catches a
fact whose `value` is a number.

## 9. README — the part that is actually the product

An adopter has the README and nothing else, so it is also the specification the pack is judged
against. It must carry:

- a table of every environment variable, with a **required: yes / no / for which part** column.
  Every variable the code reads is in it; anything in it the code never reads is a bug in the
  documentation
- the tools, by name, and what each returns
- what the pack does when something is missing — which half still works, and what the user sees
- the installation steps, in the order a stranger runs them, and working as written

`scripts/check.mjs` is the same information as a program: run by a stranger whose pack did not
start, it says which variable is missing, readably, without a stack trace.

## 10. Before the first push, and again before going public

```
./scripts/check-no-house-facts.sh --path packs/<id>
```

Core scans a pack no further than asserting it is untracked here. A pack has no denylist of its own
and most have no CI, so that check is the only thing standing between a hard-coded entity id and a
public repository. A target entity belongs in an environment variable, never in source.

## 11. Turning it into a repository of its own

Repository `jarvis-pack-<id>`, package `@jarvis/pack-<id>`, its own `CHANGELOG.md` and semantic
versioning. Installed by an entry in `config/packs.json`:

```json
{ "packs": [{ "id": "greeter", "repo": "https://github.com/you/jarvis-pack-greeter.git", "ref": "main" }] }
```

Packs are read once, at startup: `sudo systemctl restart jarvis-brain` after installing one.

## 12. The checklist

- [ ] `pack.json` name equals the directory name
- [ ] every setting read from `process.env` in `src/config.ts`
- [ ] nothing depended on that `brain` does not already depend on
- [ ] `configured()` reads the environment only, and is false when the pack would be useless
- [ ] `needs` names every variable read, each with the half sentence that says what it is for
- [ ] every tool returned is listed in `tools`
- [ ] a probe for every server that talks to anything outside the process
- [ ] **`answer(say, facts)` from every tool whose answer has figures in it**, built from what that
      tool just worked out
- [ ] `persona` says when to reach for the tools, and does not repeat what the tools say
- [ ] tests pass, and `tsc -p test/tsconfig.json` is clean
- [ ] README variable table matches what the code reads, both directions
- [ ] `scripts/check.mjs` explains a failure to start without a stack trace
- [ ] `check-no-house-facts.sh --path packs/<id>` is clean
