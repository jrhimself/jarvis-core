/**
 * What JARVIS keeps, and what it does when that changes.
 *
 * The store is the one place where something is lost if it is wrong: a fact
 * overwritten without a snapshot cannot be recovered, and a subject that fails
 * to match its own upsert quietly becomes two facts that disagree. Those two
 * properties are most of what is checked here.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";

import { MemoryStore } from "../dist/memory/store.js";
import { tempDir, tempStore } from "./helpers.ts";

/** Runs a body against a store that cleans up after itself. */
function withStore(body: (store: MemoryStore) => void): void {
  const store = tempStore();
  try {
    body(store);
  } finally {
    store.close();
  }
}

test("a fact filed twice on the same subject is one fact", () => {
  withStore((store) => {
    const first = store.remember({ kind: "voorkeur", subject: "Koffie", body: "zwart" });
    const second = store.remember({ kind: "voorkeur", subject: "  koffie  ", body: "zwart met suiker" });

    assert.equal(second.id, first.id, "case and whitespace do not make a second subject");
    assert.equal(second.body, "zwart met suiker");
    assert.equal(store.counts().facts, 1);
  });
});

test("the same subject under a different kind is a different fact", () => {
  withStore((store) => {
    const preference = store.remember({ kind: "voorkeur", subject: "Sam", body: "drinkt thee" });
    const person = store.remember({ kind: "persoon", subject: "Sam", body: "woont mee in huis" });

    assert.notEqual(person.id, preference.id);
    assert.equal(store.counts().facts, 2);
  });
});

test("overwriting a fact keeps what it used to say", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "auto", body: "een stationwagen uit 2019" });
    store.remember({ kind: "feit", subject: "auto", body: "een stationwagen uit 2023", reason: "distilled" });

    const revisions = store.revisions(fact.id);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.body, "een stationwagen uit 2019");
    assert.equal(revisions[0]!.reason, "distilled");
    assert.equal(store.byId(fact.id)!.body, "een stationwagen uit 2023");
  });
});

test("writing the same words again is not a revision", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "auto", body: "een stationwagen" });
    store.remember({ kind: "feit", subject: "auto", body: "een stationwagen" });

    assert.equal(store.revisions(fact.id).length, 0);
  });
});

test("the words that are compared are the words that are stored", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "auto", body: "een stationwagen" });
    store.remember({ kind: "feit", subject: "auto", body: "  een stationwagen\n" });

    assert.equal(store.byId(fact.id)!.body, "een stationwagen");
    assert.equal(store.revisions(fact.id).length, 0, "whitespace is not a change worth filing");
  });
});

test("an update may raise the core flag but never lowers it by omission", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "adres", body: "thuis", core: true });
    assert.equal(fact.core, true);

    const again = store.remember({ kind: "feit", subject: "adres", body: "nog steeds thuis" });
    assert.equal(again.core, true, "an update that says nothing about core does not demote");

    assert.equal(store.setCore(fact.id, false)!.core, false, "demotion has its own call");
    assert.equal(store.setCore(9999, true), null, "a fact that is not there cannot be promoted");
  });
});

test("core facts keep the order they were written in, whatever is rewritten later", async () => {
  const store = tempStore();
  try {
    store.remember({ kind: "feit", subject: "een", body: "a", core: true });
    store.remember({ kind: "feit", subject: "twee", body: "b" });
    const third = store.remember({ kind: "feit", subject: "drie", body: "c", core: true });

    // Rewriting the newest core fact used to move it to the front of the block.
    // Ordering by last change reshuffled the system prompt for nothing, and past
    // the old limit of 25 it pushed whatever changed least out of the prompt
    // altogether -- which is how the residents stopped being mentioned.
    await setTimeout(5);
    store.setBody(third.id, "c, herzien", "rewritten");

    assert.deepEqual(
      store.core().map((fact) => fact.subject),
      ["een", "drie"],
    );
    assert.equal(store.counts().core, 2);
  } finally {
    store.close();
  }
});

test("a core larger than the old limit is served whole, not clipped to 25", () => {
  const store = tempStore();
  try {
    for (let n = 0; n < 30; n += 1) {
      store.remember({ kind: "feit", subject: `feit ${n}`, body: "iets", core: true });
    }

    const facts = store.core();
    assert.equal(facts.length, 30);
    assert.equal(facts[0].subject, "feit 0");
    assert.equal(facts[29].subject, "feit 29");
  } finally {
    store.close();
  }
});

test("a rewrite files the old wording and trims the new one", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "auto", body: "een stationwagen" });

    const rewritten = store.setBody(fact.id, "  een stationwagen uit 2019  ", "folded")!;

    assert.equal(rewritten.body, "een stationwagen uit 2019");
    assert.equal(store.revisions(fact.id)[0]!.reason, "folded");
    assert.equal(store.setBody(9999, "iets"), null);
  });
});

test("a forgotten fact leaves its last words behind", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "oud", body: "iets ouds" });

    assert.equal(store.forget(fact.id), true);
    assert.equal(store.byId(fact.id), null);
    assert.equal(store.forget(fact.id), false, "twice is not an error, it is a no");

    const orphans = store.orphanRevisions();
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.body, "iets ouds");
    assert.equal(orphans[0]!.reason, "deleted");
  });
});

test("a fact that still exists is restored by rewriting it", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "auto", body: "een stationwagen uit 2019" });
    store.setBody(fact.id, "een kleine hatchback");

    const revision = store.revisions(fact.id)[0]!;
    const restored = store.restore(revision.id)!;

    assert.equal(restored.id, fact.id);
    assert.equal(restored.body, "een stationwagen uit 2019");
    assert.equal(store.revisions(fact.id).length, 2, "undoing is itself undoable");
    assert.equal(store.restore(9999), null);
  });
});

test("a deleted fact comes back, and its history follows it", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "oud", body: "eerste", core: true });
    store.setBody(fact.id, "tweede");
    store.forget(fact.id);

    const last = store.orphanRevisions()[0]!;
    const restored = store.restore(last.id)!;

    assert.notEqual(restored.id, fact.id, "a deleted fact comes back as a new row");
    assert.equal(restored.body, "tweede");
    assert.equal(restored.core, true, "and comes back as it was");
    assert.equal(store.revisions(restored.id).length, 2, "the history moved with it");
    assert.equal(store.orphanRevisions().length, 0, "and nothing is orphaned any more");
  });
});

test("a fact is found by a word out of its body, and ranked", () => {
  withStore((store) => {
    store.remember({ kind: "feit", subject: "wasmachine", body: "staat in de bijkeuken" });
    store.remember({ kind: "gewoonte", subject: "avond", body: "de wasmachine draait meestal na tienen" });

    const hits = store.search("wasmachine");
    assert.equal(hits.length, 2);

    assert.equal(store.search("bijkeuken")[0]!.subject, "wasmachine");
    assert.equal(store.search("bijkeu")[0]!.subject, "wasmachine", "a prefix is enough");
  });
});

test("a query of nothing but short words finds nothing rather than everything", () => {
  withStore((store) => {
    store.remember({ kind: "feit", subject: "wasmachine", body: "staat in de bijkeuken" });

    assert.deepEqual(store.search("in de"), []);
    assert.deepEqual(store.search("   "), []);
    assert.deepEqual(store.search('"wasmachine"*()').length, 1, "punctuation is not a syntax error");
  });
});

test("a fact rewritten is findable by its new words and not its old", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "auto", body: "een stationwagen" });
    store.setBody(fact.id, "een kleine hatchback");

    assert.equal(store.search("hatchback").length, 1, "the index follows the fact");
    assert.equal(store.search("stationwagen").length, 0);

    store.forget(fact.id);
    assert.equal(store.search("hatchback").length, 0, "and a deleted fact leaves the index");
  });
});

test("searching is not using, and recall says so separately", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "wasmachine", body: "in de bijkeuken" });

    store.search("wasmachine");
    assert.equal(store.byId(fact.id)!.hits, 0, "scrolling the panel is not the fact being used");

    store.markUsed([fact.id]);
    store.markUsed([fact.id]);
    const used = store.byId(fact.id)!;
    assert.equal(used.hits, 2);
    assert.notEqual(used.lastUsedAt, null);

    store.markUsed([]);
  });
});

test("what nothing has asked for is what consolidation gets to see", async () => {
  const store = tempStore();
  try {
    const cold = store.remember({ kind: "feit", subject: "koud", body: "nooit gevraagd" });
    const warm = store.remember({ kind: "feit", subject: "warm", body: "net gebruikt" });
    store.remember({ kind: "feit", subject: "kern", body: "altijd mee", core: true });

    // A cutoff between the writing and the using, so "used since" means something.
    await setTimeout(5);
    const cutoff = new Date().toISOString();
    await setTimeout(5);
    store.markUsed([warm.id]);

    assert.deepEqual(
      store.unusedSince(cutoff).map((fact) => fact.id),
      [cold.id],
      "a core fact is never up for review, and a used one is not stale",
    );
  } finally {
    store.close();
  }
});

test("several facts are looked up in one go, and none is none", () => {
  withStore((store) => {
    const first = store.remember({ kind: "feit", subject: "een", body: "a" });
    const second = store.remember({ kind: "feit", subject: "twee", body: "b" });

    assert.equal(store.byIds([first.id, second.id]).length, 2);
    assert.deepEqual(store.byIds([]), []);
    assert.equal(store.bySubject("EEN", "feit")!.id, first.id);
    assert.equal(store.bySubject("een", "persoon"), null);
  });
});

test("an embedding is stored beside the fact, and missing ones are findable", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "een", body: "a" });
    store.remember({ kind: "feit", subject: "twee", body: "b" });

    assert.equal(store.withoutVectors().length, 2);

    store.setVector(fact.id, new Uint8Array([1, 2, 3, 4]));

    assert.deepEqual(
      store.withoutVectors().map((candidate) => candidate.subject),
      ["twee"],
    );
    const vectors = store.vectors();
    assert.equal(vectors.length, 1);
    assert.deepEqual([...vectors[0]!.vec], [1, 2, 3, 4]);
  });
});

test("a conversation is remembered by what it was about", () => {
  withStore((store) => {
    store.recordSession({
      id: "s1",
      startedAt: "2026-08-11T19:00:00.000Z",
      endedAt: "2026-08-11T20:00:00.000Z",
      turns: 4,
      summary: "  over de wasmachine en de bijkeuken  ",
    });
    store.recordSession({
      id: "s2",
      startedAt: "2026-08-12T19:00:00.000Z",
      endedAt: "2026-08-12T20:00:00.000Z",
      turns: 2,
      summary: "over de auto",
    });

    assert.deepEqual(
      store.recentSessions().map((session) => session.id),
      ["s2", "s1"],
    );
    assert.equal(store.recentSessions()[1]!.summary, "over de wasmachine en de bijkeuken");

    assert.deepEqual(
      store.searchSessions("bijkeuken").map((session) => session.id),
      ["s1"],
    );
    assert.deepEqual(store.searchSessions("kernfusie"), []);
    assert.deepEqual(store.searchSessions("de"), [], "short words are not a search");
  });
});

test("a conversation recorded twice is updated, not duplicated", () => {
  withStore((store) => {
    const base = {
      id: "s1",
      startedAt: "2026-08-11T19:00:00.000Z",
      endedAt: "2026-08-11T20:00:00.000Z",
      turns: 4,
      summary: "over de wasmachine",
    };
    store.recordSession(base);
    store.recordSession({ ...base, turns: 9, summary: "over de bijkeuken" });

    const sessions = store.recentSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.turns, 9);
    assert.deepEqual(store.searchSessions("wasmachine"), [], "the old summary left the index too");
    assert.equal(store.searchSessions("bijkeuken").length, 1);
  });
});

test("turns wait to be distilled, per conversation", () => {
  withStore((store) => {
    const first = store.logTurn("s1", "hoe laat is het", "acht uur");
    const second = store.logTurn("s1", "en morgen", "ook acht uur");
    const loose = store.logTurn(null, "iets ouds", "van voor de sessies");

    assert.equal(store.counts().turns, 3);
    assert.deepEqual(store.pendingSessions(), [
      { sessionId: "s1", turns: 2 },
      { sessionId: null, turns: 1 },
    ]);
    assert.deepEqual(
      store.pendingTurnsFor("s1").map((turn) => turn.id),
      [first, second],
    );
    assert.deepEqual(
      store.pendingTurnsFor(null).map((turn) => turn.id),
      [loose],
    );

    store.markDistilled([first, second]);
    assert.deepEqual(store.pendingSessions(), [{ sessionId: null, turns: 1 }]);
    assert.deepEqual(
      store.pendingTurns().map((turn) => turn.id),
      [loose],
    );
    store.markDistilled([]);
  });
});

test("only the turns that used a tool are worth learning a procedure from", () => {
  withStore((store) => {
    const withTools = store.logTurn("s1", "doe het licht uit", "gedaan");
    store.logTurn("s1", "hoe heet de hond", "Fikkie");
    store.recordToolCalls(withTools, [
      { name: "do", input: '{"entity_id":"light.woonkamer"}' },
      { name: "state", input: "x".repeat(500) },
    ]);
    store.recordToolCalls(withTools, []);

    const turns = store.toolTurns("2000-01-01T00:00:00.000Z");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.asked, "doe het licht uit");
    assert.equal(turns[0]!.tools.length, 2);
    assert.ok(turns[0]!.tools[1]!.length < 420, "an enormous argument is cut down");

    assert.deepEqual(store.toolTurns(new Date(Date.now() + 60_000).toISOString()), []);
  });
});

test("recipes are replaced wholesale, never merged", () => {
  withStore((store) => {
    store.replaceRecipes([{ pattern: "  licht uit  ", recipe: "  roep do aan  " }]);
    assert.equal(store.recipes()[0]!.pattern, "licht uit");
    assert.equal(store.recipes()[0]!.recipe, "roep do aan");

    store.replaceRecipes([{ pattern: "iets anders", recipe: "iets anders" }]);
    assert.equal(store.recipes().length, 1);
    assert.equal(store.recipes()[0]!.pattern, "iets anders");

    store.replaceRecipes([]);
    assert.deepEqual(store.recipes(), []);
  });
});

test("what the owner threw out is kept apart from what memory tidied up", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "auto", body: "een hatchback" });

    store.recordCorrection({ action: "rewritten", fact, after: "een stationwagen" });
    store.recordCorrection({ action: "deleted", fact });

    const corrections = store.recentCorrections();
    assert.equal(corrections.length, 2);
    assert.equal(corrections[0]!.action, "deleted", "newest first");
    assert.equal(corrections[0]!.after, null);
    assert.equal(corrections[1]!.before, "een hatchback");
    assert.equal(corrections[1]!.after, "een stationwagen");
  });
});

test("what the calls cost is totalled per kind", () => {
  withStore((store) => {
    const call = (kind: "turn" | "distil", costUsd: number, durationMs: number) =>
      store.recordUsage({
        kind,
        sessionId: "s1",
        model: "claude-opus-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheRead: 900,
        cacheWrite: 10,
        costUsd,
        durationMs,
        firstTextMs: durationMs / 2,
        toolCalls: 1,
      });

    call("turn", 0.01, 1000);
    call("turn", 0.02, 3000);
    call("turn", 0.03, 2000);
    call("distil", 0.005, 500);

    const totals = store.usageTotals("2000-01-01T00:00:00.000Z");
    assert.deepEqual(
      totals.map((total) => total.kind),
      ["turn", "distil"],
      "the expensive kind comes first",
    );

    const turns = totals[0]!;
    assert.equal(turns.calls, 3);
    assert.equal(turns.inputTokens, 300);
    assert.equal(turns.cacheRead, 2700);
    assert.ok(Math.abs(turns.costUsd - 0.06) < 1e-9);
    assert.equal(turns.medianMs, 2000, "the middle call, not the average");
    assert.equal(turns.medianFirstTextMs, 1000);

    assert.deepEqual(store.usageTotals(new Date(Date.now() + 60_000).toISOString()), []);
  });
});

test("a median over an even number of calls averages the middle pair", () => {
  withStore((store) => {
    for (const durationMs of [1000, 2000, 3000, 6000]) {
      store.recordUsage({
        kind: "turn",
        sessionId: null,
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        durationMs,
        firstTextMs: null,
        toolCalls: 0,
      });
    }

    const totals = store.usageTotals("2000-01-01T00:00:00.000Z");
    assert.equal(totals[0]!.medianMs, 2500);
    assert.equal(totals[0]!.medianFirstTextMs, null, "nothing timed is not zero");
  });
});

test("a backup is a file, and a working database", () => {
  withStore((store) => {
    store.remember({ kind: "feit", subject: "auto", body: "een stationwagen" });
    const path = join(tempDir(), "nested", "backup.db");

    store.backupTo(path);

    assert.ok(existsSync(path), "the directory is made if it is not there");

    const copy = new MemoryStore(path);
    try {
      assert.equal(copy.search("stationwagen").length, 1, "the index came along");
      assert.equal(copy.counts().facts, 1);
    } finally {
      copy.close();
    }
  });
});

test("a checkpoint on a store nobody else is holding succeeds", () => {
  withStore((store) => {
    store.remember({ kind: "feit", subject: "auto", body: "een stationwagen" });
    assert.equal(store.checkpoint(), false, "false means nothing was in the way");
  });
});

test("the proactive tables live in the same database", () => {
  withStore((store) => {
    const counts = store.proactiveCounts();

    assert.equal(counts.observations, 0);
    assert.equal(counts.baselines, 0);
    store.proactiveConnection().exec("SELECT count(*) FROM anomalies");
  });
});

test("priming moves the freshness date but never the hit counter", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "zolderdeur", body: "klemt" });
    assert.equal(fact.hits, 0);
    assert.equal(fact.lastUsedAt, null);

    // Primed: the fact rode along as a hint. Nobody knows whether it was used,
    // so the "opgezocht" signal consolidation reads must not move.
    store.markPrimed([fact.id]);
    const primed = store.byId(fact.id)!;
    assert.equal(primed.hits, 0, "a hint is not a lookup");
    assert.notEqual(primed.lastUsedAt, null, "but the fact no longer looks abandoned");

    // Recalled: the assistant asked for it. Both move.
    store.markUsed([fact.id]);
    const used = store.byId(fact.id)!;
    assert.equal(used.hits, 1);
    assert.notEqual(used.lastUsedAt, null);
  });
});

test("a setting reads back, overwrites, and is null when never set", () => {
  withStore((store) => {
    assert.equal(store.setting("briefing.last"), null);
    store.setSetting("briefing.last", "2026-08-26T04:00:00.000Z");
    assert.equal(store.setting("briefing.last"), "2026-08-26T04:00:00.000Z");
    store.setSetting("briefing.last", "2026-08-27T04:30:00.000Z");
    assert.equal(store.setting("briefing.last"), "2026-08-27T04:30:00.000Z");
  });
});

test("nightly passes are kept in order, newest first", () => {
  withStore((store) => {
    const run = (at: string, written: number) => ({
      at,
      scanned: 149,
      read: written === 0 ? 0 : 3,
      written,
      skipped: 0,
      retired: 0,
      gone: 0,
      failed: 0,
      factsBefore: 600,
      factsAfter: 600 + written,
    });
    store.recordCorpusRun(run("2026-08-25T02:01:23.000Z", 0));
    store.recordCorpusRun(run("2026-08-26T02:07:23.000Z", 12));
    store.recordCorpusRun(run("2026-08-24T02:12:59.000Z", 23));

    const runs = store.corpusRuns();
    assert.deepEqual(
      runs.map((entry) => entry.at),
      ["2026-08-26T02:07:23.000Z", "2026-08-25T02:01:23.000Z", "2026-08-24T02:12:59.000Z"],
    );
    assert.equal(runs[0].written, 12);
    assert.equal(runs[0].factsAfter, 612);

    assert.equal(store.corpusRunsSince("2026-08-25T00:00:00.000Z").length, 2);
    assert.equal(store.corpusRuns(1).length, 1, "the limit is honoured");
  });
});

test("a pass recorded twice for the same moment replaces itself", () => {
  withStore((store) => {
    const at = "2026-08-26T02:07:23.000Z";
    const base = {
      at,
      scanned: 149,
      read: 1,
      written: 4,
      skipped: 0,
      retired: 0,
      gone: 0,
      failed: 0,
      factsBefore: 600,
      factsAfter: 604,
    };
    store.recordCorpusRun(base);
    store.recordCorpusRun({ ...base, written: 6, factsAfter: 606 });

    const runs = store.corpusRuns();
    assert.equal(runs.length, 1, "a re-run does not double the week's totals");
    assert.equal(runs[0].written, 6);
    assert.equal(runs[0].factsAfter, 606);
  });
});

test("the notes a pass read are found by the moment they were read", () => {
  withStore((store) => {
    const fact = store.remember({ kind: "feit", subject: "Zolder", body: "niemand komt er" });
    store.recordCorpusFile("jarvis_state.md", "aaa", [fact.id]);

    const all = store.corpusFilesSince("");
    assert.equal(all.length, 1);
    assert.equal(all[0].path, "jarvis_state.md");

    const later = new Date(Date.now() + 60_000).toISOString();
    assert.equal(store.corpusFilesSince(later).length, 0, "a note read before the cutoff is not new");
  });
});
