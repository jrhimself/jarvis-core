# Scaling a delegate pool

An investigation, not a change. The question asked was: how could the number of delegation slots
grow beyond a small fixed set, so more delegated jobs run side by side and idle runners are given
back when they finish?

Written from one working deployment whose delegate is an SSH channel to a second machine with three
slots. The shapes are general; the numbers are that deployment's, measured while two jobs were
running, and yours will differ.

The short answer is that the slot count was never the binding constraint, and that the second half
of the question is already built.

---

## 1. Where the number lives

Three places know about slots, and only one of them decides.

| where | what it holds | who enforces |
| --- | --- | --- |
| the far side's forced command | the list of slot numbers it will accept | **this one.** `spawn`, `tail`, `reply` and `kill` refuse any other number, and `list` prints only these |
| the delegate pack | a configured list, read from the environment once at startup | advisory: it intersects its list with what `list` printed |
| core | nothing | `Delegate.slots` is a field; the health line and the HUD board are derived from it |

Core is clean: there is no slot count anywhere in it. `composeBoard` makes one row per entry in
`delegate.slots`, and the health line reads `${free.length} of ${delegate.slots.length} slots free`.
Widening the pool needs no change here — *unless* the pool is to be elastic, which is §4.

Two consequences worth naming before any option:

- **The authoritative definition of the pool is an unversioned shell script** on the runner machine,
  with hand-made `.bak-<date>` copies beside it as its only history. Whatever the pool becomes, that
  script wants a repository — it is the far half of the pack's contract and it is the thing that
  actually sets the ceiling.
- **`Delegate.slots` is a snapshot.** The pack builds it in `create()` from the environment, so the
  set of slots is fixed for the lifetime of the service process.

## 2. What actually limits parallelism

Not the count. Memory, and it already over-promises.

Every delegated runner is started into **one shared cgroup** — a single slice with `MemoryMax=1400M`
and no swap. The cap is on the slice total, not per job. Measured with two jobs running:

```
slice            1222M of 1400M      86M available
  job A           542M
  job B           724M
```

A third job would be admitted by the slot list and then meet a cap with nothing left behind it. The
kernel picks the victim inside the slice, which need not be the newcomer: the likely outcome of
filling the third slot is a job that was nearly finished being killed. So the honest ceiling today is
**two**, and the configured three is a trap.

Where a job's memory goes, per runner:

| | |
| --- | --- |
| the agent CLI itself | 345–377M |
| MCP servers it inherits from the user-level configuration | 250–330M |

The second row is 40–45% of a runner and **none of it is used by a job whose work is a git
checkout.** It arrives because the pane inherits a user-level MCP configuration meant for
interactive sessions: one server is a Python process of 105–185M, one is *two* node processes
totalling ~155M, one is another Python process of ~61M, plus a tool wrapper.

The rest of the picture, so the options can be weighed honestly:

- The runner machine has 5 GB of RAM and **two cores**. Its swap is fully consumed. Another unit on
  the same machine holds the owner's own long-lived panes under a 3200M cap; 1400 + 3200 of 5120 is
  already most of it.
- The virtualisation host has 4 cores and 16 GB, of which ~3.3 GB is genuinely free, and it is
  several GB into swap. Guest memory is overcommitted by about a third, and one guest with a hard 6 GB
  reservation is the house's own hub — the one thing that must not fall over. Disk is not scarce.
- Host CPU is not currently the bottleneck (load well under one core of four). Two cores for three or
  more concurrent agent sessions plus a compiler will be.

## 3. What already works: giving a slot back

This half of the question is largely answered, which is worth knowing before building for it.

- **Slots are opened on demand.** `spawn` creates the session, `kill` destroys it. Between jobs a
  slot is nothing at all — there are no idle runners to spin down, only empty slots.
- **Closing is automatic, behind a two-key lock.** A slot is closed when the supervising model reads
  the screen as finished *and* the runner wrote its own `DONE:` line (`declaredDone` in
  `brain/src/dev/runners.ts`). Then the session goes, the job directory is removed, and anything
  unpushed is saved as patches for a fortnight first.
- **A quiet runner is looked in on** after 30 minutes (`QUIET_MS`), and a slot whose session has
  vanished is reported gone and forgotten, so a job cannot disappear unnoticed.
- **An ending the runner did not declare is offered, not taken.** A model-only verdict of
  "definitively stuck" gets Close and Keep-open buttons on purpose: that is the case where somebody
  may want to look before the pane is gone.

Three residual gaps, all small:

1. A job that finishes without writing its `DONE:` line waits for a human button.
2. A runner wedged but still redrawing its screen is never judged stuck by the quiet timer, because it
   is not quiet.
3. Nothing reaps a slot's state files if the session dies and the brain never asks about it, other
   than the next `spawn` into that slot, which cleans up after its predecessor.

## 4. Options

### A — Make a runner cheaper rather than making more of them

Start the pane with its MCP configuration emptied and pinned (`--strict-mcp-config` together with an
empty `--mcp-config`), so a delegated job gets the agent and nothing else. On the measurements above
a job falls from 540–725M to roughly 350–380M, and the existing cap then holds **three to four jobs
where it holds two.** One line in the forced command; no new code, no new seam, no new hardware.

Against it: a job whose work genuinely needs to talk to the house loses that reach. The fix is to make
it opt-in — a flag on `spawn` that selects a richer configuration — rather than to keep paying for it
on every job.

Note what is *not* available here: a fully bare mode would cut more, but it also disables hooks, and
the runner's Stop hook is the entire reporting path back to the assistant. That option is closed.

### B — Move the cap from the pool to the job

Give each job its own scope cap under a capped parent, instead of one cap shared by all of them. A
greedy job then dies alone rather than taking its neighbour with it.

This is not a capacity increase: the parent cap still decides how many fit. It is a correctness fix
for the hazard in §2, and it should be done whatever else is decided. Without a parent cap it is the
opposite of safe — six jobs each allowed 1400M is 8400M of promises against 5120M of RAM.

### C — An elastic pool with admission control on the far side

Stop hard-coding the list. Have `list` compute its answer: report a slot as free only while the pool
has measured room for another job, and report slots up to a configured maximum rather than a fixed
three. The pool becomes a ceiling plus a live gate, and "all delegation slots are busy" starts to
mean "there is no room" — which is the truth today, and the lie the fixed list currently tells.

This is the option that answers the question as asked. Its cost is a seam:

- `Delegate.slots` is a static field read once at startup, and it feeds the health line and one HUD
  board row per slot. An elastic pool makes it either a method or a stale number. The board already
  recomputes its own text from the rows it got (`board.ts` rewrites `N of M slots free`), so the HUD
  is closer to ready than the type is.
- The pack would stop clamping to a hand-written list and take the far side's answer as authoritative.
  That is the right direction anyway — the far side is the machine being protected, and the comment at
  the top of the pack's `ssh.ts` already argues that the rule belongs there.
- Refusals get harder to explain. `chooseSlot` currently distinguishes "all busy" from "the far side
  has never heard of these slots"; a third case appears, "there is room for no more right now", and it
  needs its own sentence or the owner is told to wait for something that is not coming.

### D — More capacity: a bigger or a second runner machine

Real headroom, and it would also separate the owner's own panes from delegated jobs so a job can never
hurt them again. But the prerequisite is physical memory on the host, not configuration: ~3.3 GB free
with the house's hub holding a hard 6 GB reservation means raising the runner guest's allowance is a
one-line command whose risk lands on the hub.

A second machine also costs more than it looks on the brain's side: a slot number is the whole address
in `tail`, `reply` and `kill`, so a pool spread over two hosts needs a slot number that encodes its
host. And core takes one delegate, from the first pack that offers one — two hosts means one pack that
knows about both, not two packs.

### E — A queue instead of more slots

Today a job that arrives with everything busy is refused, and the owner is told. A queue would let it
wait and start when something frees: a `queued` state beside `delegated` and `awaiting`, drained by the
timer that already looks in on quiet runners.

This gets more work done per day without one extra byte of memory, and if the real complaint is
"my request was refused" it is the cheapest honest answer. Against it: what the assistant promises out
loud changes from "runner 12 has it" to "it is third in line"; a queue nobody drains because a runner
is wedged is a silent backlog, so it needs a visible depth and an expiry.

## 5. Recommendation

In this order. The first two are worth doing before any decision about the rest.

1. **B, the cap half.** Per-job caps under a capped parent. Today's three-slot list over a shared cap
   is a hazard that has already been paid for twice at whole-machine level; the fix does not depend on
   any of the other choices.
2. **A.** Empty the MCP configuration for delegated panes. On the measurements this turns two
   concurrent jobs into three or four inside the existing cap — it delivers what was asked for with one
   line and no new failure modes. Measure a job again afterwards, because step 3 should be sized from
   the real per-job cost rather than today's inflated one.
3. **C, afterwards and knowingly.** This is the change that touches a published seam in core, so it is
   worth doing once, with the true per-job figure in hand.
4. **E only if refusals are what actually hurt.** It is orthogonal to all of the above; count the
   refusals first.
5. **D when the host grows.** Until then a second runner guest moves risk onto the house's hub, which
   is the wrong place for it.

And regardless of which is chosen: put the forced command in a repository. It is the file that defines
the pool, it is the file every option above edits, and it currently has no history and no review.
