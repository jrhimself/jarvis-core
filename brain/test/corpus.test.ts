/**
 * Reading the owner's notes into memory without trampling what is already there.
 *
 * The model half is stubbed: what matters here is who owns a subject, what a
 * second pass costs, and what happens to a fact whose note is gone. Those are
 * the parts that can quietly destroy something.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { MemoryStore } from "../dist/memory/store.js";
import { factsPanel, renderRun } from "../dist/memory/tools.js";
import { panelOfDisplay } from "../dist/focus.js";
import {
  ingestCorpus,
  parseProposals,
  readNotes,
  withoutFrontmatter,
  type Distil,
  type Proposal,
} from "../dist/memory/corpus.js";
import { tempDir, tempStore } from "./helpers.ts";

// These assertions are about a house in one particular place, so they name it
// rather than inherit whatever zone the machine running them happens to have.
// That is the whole point of `JARVIS_TIMEZONE`: on a container it is UTC.
process.env["JARVIS_TIMEZONE"] = "Europe/Amsterdam";
process.env["JARVIS_LOCALE"] = "nl-NL";


/** A corpus directory with the given files in it. */
function corpus(files: Record<string, string>): string {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

/** A distillation that returns what it was told to, and counts the calls. */
function stub(byNote: Record<string, Proposal[]>): Distil & { calls: string[] } {
  const calls: string[] = [];
  const distil = async (note: { path: string }): Promise<Proposal[]> => {
    calls.push(note.path);
    return byNote[note.path] ?? [];
  };
  return Object.assign(distil, { calls });
}

/** Swallows the errors a failing pass is supposed to print. */
async function withoutComplaints<T>(body: () => Promise<T>): Promise<T> {
  const complain = console.error;
  console.error = () => {};
  try {
    return await body();
  } finally {
    console.error = complain;
  }
}

function withStore(body: (store: MemoryStore) => Promise<void>): Promise<void> {
  const store = tempStore();
  return body(store).finally(() => {
    store.close();
  });
}

test("the frontmatter block is not part of the note", () => {
  const text = "---\nname: dryer\ndescription: something\n---\n\nDe droger klemt.\n";
  assert.equal(withoutFrontmatter(text), "De droger klemt.\n");
});

test("a note without frontmatter is left whole", () => {
  assert.equal(withoutFrontmatter("De droger klemt.\n"), "De droger klemt.\n");
});

test("the index and the compression backups are not notes", () => {
  const dir = corpus({
    "MEMORY.md": "- [a](a.md)",
    "dryer.md": "de droger",
    "dryer.original.md": "de droger, ongecomprimeerd",
    "notes.txt": "geen markdown",
  });

  assert.deepEqual(
    readNotes(dir).map((note) => note.path),
    ["dryer.md"],
  );
});

test("proposals come back out of prose around the JSON", () => {
  const facts = parseProposals(
    'Hier zijn ze:\n[{"kind":"feit","subject":"droger","body":"De droger staat op zolder."}]\nKlaar.',
  );

  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.subject, "droger");
});

test("a proposal with an unknown kind is dropped, not guessed at", () => {
  const facts = parseProposals('[{"kind":"gedachte","subject":"droger","body":"Staat op zolder."}]');
  assert.equal(facts.length, 0);
});

test("an unchanged note is not read a second time", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "dryer.md": "De droger staat op zolder." });
    const distil = stub({
      "dryer.md": [{ kind: "feit", subject: "droger", body: "De droger staat op zolder." }],
    });

    const first = await ingestCorpus(store, dir, distil);
    assert.equal(first.read, 1);
    assert.equal(first.written, 1);

    const second = await ingestCorpus(store, dir, distil);
    assert.equal(second.read, 0, "the hash decides before the model is asked");
    assert.equal(second.written, 0);
    assert.deepEqual(distil.calls, ["dryer.md"]);
    assert.equal(store.counts().facts, 1);
  });
});

test("a rewritten note rewrites its fact rather than adding one", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "dryer.md": "De droger staat op zolder." });
    await ingestCorpus(
      store,
      dir,
      stub({ "dryer.md": [{ kind: "feit", subject: "droger", body: "Staat op zolder." }] }),
    );

    writeFileSync(join(dir, "dryer.md"), "De droger staat in de bijkeuken.");
    const report = await ingestCorpus(
      store,
      dir,
      stub({ "dryer.md": [{ kind: "feit", subject: "droger", body: "Staat in de bijkeuken." }] }),
    );

    assert.equal(report.read, 1);
    assert.equal(store.counts().facts, 1);
    assert.equal(store.bySubject("droger", "feit")?.body, "Staat in de bijkeuken.");
  });
});

test("a subject a seed already owns is left alone", async () => {
  await withStore(async (store) => {
    const seeded = store.remember({
      kind: "feit",
      subject: "droger",
      body: "Zorgvuldig met de hand geformuleerd.",
    });

    const dir = corpus({ "dryer.md": "De droger staat op zolder." });
    const report = await ingestCorpus(
      store,
      dir,
      stub({ "dryer.md": [{ kind: "feit", subject: "Droger", body: "Iets uit een notitie." }] }),
    );

    assert.equal(report.skipped, 1);
    assert.equal(report.written, 0);
    assert.equal(
      store.byId(seeded.id)?.body,
      "Zorgvuldig met de hand geformuleerd.",
      "the curated wording survives",
    );
  });
});

test("a fact a note stops saying is retired", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "house.md": "Twee dingen." });
    await ingestCorpus(
      store,
      dir,
      stub({
        "house.md": [
          { kind: "feit", subject: "zolderdeur", body: "Klemt." },
          { kind: "feit", subject: "droger", body: "Staat op zolder." },
        ],
      }),
    );
    assert.equal(store.counts().facts, 2);

    writeFileSync(join(dir, "house.md"), "Nog één ding.");
    const report = await ingestCorpus(
      store,
      dir,
      stub({ "house.md": [{ kind: "feit", subject: "droger", body: "Staat op zolder." }] }),
    );

    assert.equal(report.retired, 1);
    assert.equal(store.bySubject("zolderdeur", "feit"), null);
    assert.notEqual(store.bySubject("droger", "feit"), null);
  });
});

test("a deleted note takes its facts with it", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "dryer.md": "De droger staat op zolder." });
    await ingestCorpus(
      store,
      dir,
      stub({ "dryer.md": [{ kind: "feit", subject: "droger", body: "Staat op zolder." }] }),
    );

    rmSync(join(dir, "dryer.md"));
    const report = await ingestCorpus(store, dir, stub({}));

    assert.equal(report.gone, 1);
    assert.equal(report.retired, 1);
    assert.equal(store.counts().facts, 0);
    assert.deepEqual(store.corpusPaths(), []);
  });
});

test("a fact two notes agree on outlives one of them", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "a.md": "eerste", "b.md": "tweede" });
    const both: Proposal[] = [{ kind: "feit", subject: "droger", body: "Staat op zolder." }];
    await ingestCorpus(store, dir, stub({ "a.md": both, "b.md": both }));
    assert.equal(store.counts().facts, 1, "the same subject is one fact");

    rmSync(join(dir, "a.md"));
    const report = await ingestCorpus(store, dir, stub({}));

    assert.equal(report.gone, 1);
    assert.equal(report.retired, 0, "b.md still says it");
    assert.notEqual(store.bySubject("droger", "feit"), null);
  });
});

test("a run of failures stops the pass instead of burning the corpus", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "a.md": "een", "b.md": "twee", "c.md": "drie", "d.md": "vier" });
    const tried: string[] = [];
    const failing: Distil = async (note) => {
      tried.push(note.path);
      throw new Error("quota");
    };

    const report = await withoutComplaints(() => ingestCorpus(store, dir, failing));

    assert.equal(report.failed, 3);
    assert.equal(tried.length, 3, "the fourth note is not even tried");
    assert.equal(store.corpusPaths().length, 0, "a note that failed keeps its old hash");
  });
});

test("a failure in between does not stop a pass that is working", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "a.md": "een", "b.md": "twee", "c.md": "drie" });
    const facts: Proposal[] = [{ kind: "feit", subject: "droger", body: "Staat op zolder." }];
    const flaky: Distil = async (note) => {
      if (note.path === "b.md") throw new Error("hiccup");
      return facts;
    };

    const report = await withoutComplaints(() => ingestCorpus(store, dir, flaky));

    assert.equal(report.failed, 1);
    assert.equal(report.read, 2);
    assert.deepEqual(store.corpusPaths(), ["a.md", "c.md"]);
  });
});

test("what a retired fact used to say is still recoverable", async () => {
  await withStore(async (store) => {
    const dir = corpus({ "dryer.md": "De droger staat op zolder." });
    await ingestCorpus(
      store,
      dir,
      stub({ "dryer.md": [{ kind: "feit", subject: "droger", body: "Staat op zolder." }] }),
    );
    const id = store.bySubject("droger", "feit")!.id;

    rmSync(join(dir, "dryer.md"));
    await ingestCorpus(store, dir, stub({}));

    const revisions = store.revisions(id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]?.body, "Staat op zolder.");
  });
});

test("a night that changed nothing reads differently from one that did", () => {
  const base = {
    at: "2026-08-26T02:07:23.000Z",
    scanned: 149,
    read: 0,
    written: 0,
    skipped: 0,
    retired: 0,
    gone: 0,
    failed: 0,
    factsBefore: 628,
    factsAfter: 628,
  };

  const quiet = renderRun(base);
  assert.match(quiet, /niets veranderd/);
  assert.match(quiet, /628 feiten/);
  assert.doesNotMatch(quiet, /→/, "an unchanged count is not worth an arrow");

  const busy = renderRun({ ...base, read: 6, written: 23, retired: 10, factsAfter: 641 });
  assert.match(busy, /6 gelezen/);
  assert.match(busy, /23 feiten bij/);
  assert.match(busy, /10 vervallen/);
  assert.match(busy, /628 → 641 feiten/);

  assert.match(renderRun({ ...base, failed: 2 }), /2 mislukt/);
});

test("a pass is dated in Amsterdam, not in the container's UTC", () => {
  // 02:07 UTC in August is 04:07 at home; a briefing that says two in the
  // morning is describing a night that did not happen.
  assert.match(renderRun({
    at: "2026-08-26T02:07:23.000Z",
    scanned: 149, read: 0, written: 0, skipped: 0, retired: 0, gone: 0, failed: 0,
    factsBefore: 628, factsAfter: 628,
  }), /04:07/);
});

test("the Facts window says per night what was added and what was removed", () => {
  const night = {
    at: "2026-09-25T02:07:00.000Z",
    scanned: 150, read: 6, written: 28, skipped: 0, retired: 16, gone: 0, failed: 0,
    factsBefore: 812, factsAfter: 824,
  };
  const still = { ...night, at: "2026-09-24T02:07:00.000Z", read: 0, written: 0, retired: 0, factsAfter: 812 };

  const panel = factsPanel([night, still]);
  assert.ok(panel !== null && panel.type === "panel");
  assert.equal(panel.title, "Facts");
  assert.deepEqual(panel.figure, { value: 28, label: "16 removed" });
  assert.match(panel.rows[0]!.value, /\+28 added/);
  assert.match(panel.rows[0]!.value, /16 removed/);
  assert.equal(panel.rows[0]!.hint, "824 facts");
  assert.equal(panel.rows[1]!.value, "no change");
  // The window opens on the notes section marker; a title that stopped
  // mapping to that topic would leave it shut.
  assert.equal(panelOfDisplay(panel), "notes");

  assert.equal(factsPanel([still]), null, "a quiet night puts nothing on screen");
  assert.equal(factsPanel([]), null);
});
