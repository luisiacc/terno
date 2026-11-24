# 265: in a Gmail pass, new mail comes first, and no one message or backlog holds it back

## Request

The owner, after plan 262 (2026-11-24): "look for other possible issues that could cause email not getting fetched …
then fix them all, that is the most important part of an email client is to actually receive the email".

An audit of the Gmail sync then found four ways one message, or a backlog of other work, keeps new mail out of a pass.
This plan takes those in `packages/mail/src/gmail-api.ts` (with `packages/store/src/capture-repair.ts` and the quota in
`gmail-quota.ts` as context). Scheduling in `core.ts` (263), Google admission (264) and IMAP (266) are other plans.

## What exists (verified against the code at ba90b8f50)

1. **A message that always fails to process fails every pass.** `processingError` (gmail-api.ts:538) turns only the
   worker's `mime-limit-parts` into an `IncomingCaptureRefusal`, which `fetchFull` records as a blocked capture repair
   (the per-message repair of the W10 design: Settings lists it, Retry asks for it again) and goes on. Every other
   processing failure (`mime-limit-depth`, `-headers`, `-addresses`, `envelope-unavailable`, `input-limit`,
   `result-limit`, `worker-timeout`) is an `IncomingResourceError` that `fetchFull` throws: its siblings are aborted
   (`pass.abort()`), the batch it had buffered is dropped (`flush` runs only `if (!failure)`), and `incremental` never
   reaches `saveProgress` (:1447). The next pass reads the same history, downloads the same message, fails the same
   way: the account receives nothing while the message stays in Gmail. Confirmed. `mime-limit-depth` is the same
   parser verdict IMAP already turns into a `mime-depth` repair (imap.ts:1599), and `mime-depth` is already a valid
   `CaptureReason` in the store, the SQL CHECK and the UI copy (`capture.depth`).
2. **A full repair journal fails the batch.** `blockCapture` (store/capture-repair.ts:60) refuses a new row past 1,000
   rows or 1 MiB with `UNAVAILABLE capture.capacity`; in `fetchFull` that escapes `await sink.blockCapture(...)` and
   fails the pass like (1). Confirmed. The W10 design chose this backpressure on purpose ("at capacity retain
   checkpoint … never evict unresolved work"), and the cap itself stays; what it shouldn't do is keep *other* mail
   out.
3. **The whole flag backlog runs before history.** `sync()` awaits `reconcileFlags(sink)` (:1591) before loading the
   cursor; it drains every pending flag snapshot, 50 at a time, one `format=minimal` GET each (20 units). At the
   paced 85 units/s that is 4.25 a second: 10,000 snapshots (one "select all → archive") hold the first history read
   back ~39 minutes. Confirmed.
4. **A long catch-up holds back what arrives during it.** `incremental` (:1354) reads all of history, then downloads
   every addition (oldest first), the summary-only ids, and relabels every changed message, before saving the cursor.
   1,000 additions are ~12 minutes at the paced quota (60 units each), 5,000 label changes ~20 minutes, and nothing
   that arrives meanwhile is read until the next pass. Confirmed. The first sync already looks at history between
   chunks (`peekArrivals`, plan 102); the incremental path has no such look.

## Design

The rule throughout: the history cursor is saved only when every change in history up to it is applied, or durably
owned elsewhere (a stored message, a capture repair row). Nothing here advances a cursor past a message that is
neither stored nor recorded.

### 1. Deterministic refusals: a repair, or held without stopping the rest

- `mime-limit-depth` becomes an `IncomingCaptureRefusal("mime-depth")`, recorded exactly like `mime-parts` (the same
  parser verdict IMAP records). No store or UI change: the reason exists.
- The other message-specific failures (`mime-limit-headers`, `mime-limit-addresses`, `envelope-unavailable`,
  `input-limit`/an over-limit body, `result-limit`, `worker-timeout`) have no repair reason; adding one is a change to
  `capture_repairs`' CHECK (a table rebuild in SQLite) and the store contract: **deferred** (Out of scope). Instead
  they are **held**: on the arrival paths (`incremental`, the first sync's `peekArrivals`) the message is skipped for
  this pass, its siblings and every later batch go on, and the pass ends with that error *without saving the cursor*
  (the history position before the message). The next pass tries it again (a transient one, a timeout under load,
  succeeds then), and the account shows the error meanwhile, as today. Systemic failures (`worker-unavailable`,
  `-fault`, `-busy`, `-closed`, network, quota, sign-in, cancellation) still abort the batch: they would fail every
  sibling too.
- When `fetchFull` fails anyway, the messages it had already downloaded and buffered are stored first (unless the pass
  was cancelled, reset or the failure was the store's own), so the next pass doesn't download them again.

### 2. A full repair journal holds the message, not the pass

A `blockCapture` the store refuses for capacity (`UNAVAILABLE`, `capture.capacity`) is held the same way
on the arrival paths: the message is neither stored nor acknowledged, the cursor stays before it, everything else is
stored, and the pass ends with the capacity error ("Message repair capacity reached …", already in the catalog).
Elsewhere (first-sync enumeration, backfill, attachment capture, the repair retry) it throws as today: those don't
deliver arrivals, and their pages must not be saved past the message. Cost: while the journal stays full, each pass
downloads that one message again (bounded by the messages refused), which the owner fixes by retrying or removing
repairs, as the message already says.

### 3. A bounded share of the flag backlog, then history

`reconcileFlags` keeps its place before history (see Revisions: after history, a snapshot acknowledged during the
pass is read under the pass's old epoch and refused by plan 38's rule 6, a wasted read for every message acted on
during a pass) but gets a time share (`FLAG_SNAPSHOTS_MS` = 30 s, ~125 GETs at the paced quota). Out of it with more
pages left, it asks for another pass (`again()`, a second later) and keeps its place (`afterMessageId` and the
captured `throughMessageId`) in the provider's memory, so the next pass goes on from there rather than re-reading rows
an unfinished op still holds. A finished traversal forgets the place; a restart starts it over (bounded, as now). New
mail waits at most one share, not the whole backlog.

The automatic retry of pending capture repairs (a page of them) moves after history, with `hold`: one its own content
fails again stays pending and no longer keeps the pass from history. The retry the person just asked for still goes
first.

### 4. Incremental: newest first, with a look at history between steps

`incremental` keeps one queue of work per kind and runs it as steps of at most 50, in this order of priority:
additions (live mail, **newest first**), summary-only ids (plan 260), label rereads. After every step, if
`ARRIVALS_EVERY_MS` (60 s, as the first sync's chunk) has passed since the last look, it reads history again from the
latest position it holds and merges what it finds: new additions go to the front of the queue (they are taken next),
changed ids go back on the reread queue (a message changed again after its reread is read again), deletions join the
deletion set, untyped ids the summary queue. Deletions are applied last, as now, and the cursor saved is the latest
position merged, once every queue is empty. A look that finds history gone (404) or too long stops looking for the
rest of the pass (the cursor then stays at the last position merged; what the failed look named is the next pass's).
Looks stop once the pass has merged `HISTORY_TOTAL_REFS` × 2 references (memory stays bounded); the first read keeps
its own bounds (404 → full sync, overflow → reconciliation) unchanged.

A pass that fails midway saves nothing, as now; the next one skips what was stored (`messageByProviderId`).

## Tests (packages/mail, unit; each fails on the old code)

- `gmail-arrivals-first.test.ts` (new):
  - a `mime-limit-depth` message becomes a `mime-depth` repair, its siblings are stored and the cursor advances.
  - a `mime-limit-headers` message in an incremental pass of 120 additions: the other 119 are stored (newest first),
    the cursor is not saved, the pass rejects with the processing error; the next pass, the message now fine, stores
    it and saves the cursor.
  - a `blockCapture` refused for capacity: the other additions are stored, no cursor, the capacity error.
  - a systemic `worker-unavailable` still aborts the batch (no further downloads).
  - flags: with the share exhausted after the first page, history is read next, `again()` is called, and the next pass
    continues from the next page; a finished traversal starts over.
  - a pending repair that fails again is retried after history: the arrival is stored and the cursor saved.
  - a sibling's 503 after two downloads: those two are stored.
  - incremental: with 120 additions and the clock past `ARRIVALS_EVERY_MS` after the first step, a look reads history
    from the latest id; an addition it finds is downloaded before the older ones still queued; the cursor saved is the
    look's id. A look answering 404 stops looking and saves the first read's id.
  - a label change seen in a look for a message already reread this pass is read again.

## Performance and resources

No new timers, no polling: the look is one `/history` read (2 units) at most once a minute of a pass that is already
running. Memory: queues hold ids already bounded by the references merged (≤ 2 × `HISTORY_TOTAL_REFS`). Store lookups
per id are unchanged (one `messageByProviderId` per id, yielding every 50). `gmail-history.perf.test.ts` (2,000
references expanded within the slice budget, 2,000 lookups) stays green; a perf assertion is added that a 10,000
addition queue's bookkeeping (newest-first picking, merging a look) stays within the control slice budget.

## Out of scope

- New capture-repair reasons (`mime-headers`, `mime-addresses`, `too-large`, …) so those messages become repairs
  instead of held errors: needs a `capture_repairs` CHECK change (a SQLite table rebuild), store-contract and UI copy
  (en/es) work. Reported.
- A "transient, owed" repair state that lets the cursor advance past a message that keeps timing out: a store
  contract change. Reported.
- Making first-sync enumeration and backfill skip a held message: their page tokens can't be saved past it.
- A held message's protection lasts as long as its history does: if history expires (404) or overflows while it is
  held, the recovery lists the account's window again; one inside it stops that listing at its page (strict, as
  before; looks at new mail still run each pass), one outside it (an old-dated typed addition) isn't read, as for any
  recovery. Durable ownership of held ids (the "owed" state above) is what closes this. Reported.
- A pass that ends in a held error doesn't honour `again()` (core schedules continuations only after a successful
  pass): the flag share and a first sync's next chunk continue at the next poll.

## Revisions after the Codex review

The plan critique (12 points) and what changed:

1. Completion contract: only the arrival paths (`incremental`, `peekArrivals`, the repair retry) pass `hold`;
   enumeration, backfill and attachment capture stay strict. A peek that held something doesn't save its position, so
   a `refreshFrom` taken from it stays before the message. An eviction that wins over `blockCapture` is the plan 69
   rule as before (the person removed that message).
2. Held ids across history expiry: recorded as a limit (Out of scope), not fixed: it needs durable ownership.
3. Only the capacity refusal is held; `STALE`, fences and store failures from `blockCapture` fail the pass (tested).
   The post-write `check()` is outside the catch. A salvage `flush` runs only when admission settled without a store
   failure, and never on a cancelled or reset pass.
4. Deletions a look finds retire their repairs as they are merged, before that look's additions are downloaded.
5. Flags no longer move after history (see 7), and a held error is thrown only at the pass's end, after flags,
   repairs and attachment capture.
6. `again()` after a failed pass: recorded (Out of scope); the place is kept in memory, so the next poll continues.
7. Plan 38's epoch: this is why flags stay before history. Moved after it, the existing
   `flag-observation.int.test.ts` showed the cost (a snapshot acknowledged during the pass read and refused in the same
   pass, then again in the next). A lower-id obligation behind a paused traversal is read when the traversal next
   starts over (within the backlog's passes).
8. A malformed snapshot in a share is reported by that pass (its pass fails, as before); its row stays pending.
9. A look is merged only after its last page; a failed look merges nothing and leaves the position where it was.
10. Deletions found by a look are checked when a queued addition, summary id or reread is taken; a label change found
    after a message's reread queues it again (tested); additions are taken from the newest history record back.
11. Bounds: one look per `ARRIVALS_EVERY_MS` of work, each bounded as a history read is (100 pages, 10,000
    references); looks stop past twice a pass's references.
12. The automatic repair retry moves after history with `hold` (tested).

## What the Codex code review changed

Self-review first: a hold from the retry the person just asked for (it goes before history) kept the history cursor
back every pass. Holds are now counted, and `incremental` and `peekArrivals` save no progress only past their own
(tested).

The review (10 findings; no path found that saves a cursor, peek, page or backfill past an unstored, unrecorded
message):

1. Fixed: a held message's error is thrown before a malformed flag snapshot's (the hold is what keeps the cursor
   back, and its error says what to do). Tested.
2. Declined (rare): a message held by a peek and stored by the catch-up later in the same pass still reports its error
   for that pass; the next pass is clean.
3. Declined: siblings stored after a repair-row conflict (`STALE`) are valid mail; storing them is right.
4. Declined (pre-existing, unchanged admission chain): a queued flush after `reset()` writes mail already downloaded
   and fenced by the sink's own checks.
5. Fixed: a reread's 404 joins the deletions without retiring its repair row; a look's deletion of it now still
   retires it before that look's additions (repair retirement tracked apart from deletion). Tested.
6. Noted: the flag share is checked per page; at the paced quota a page of 50 is ~12 s.
7. Fixed: an arrivals step looks at most 500 candidates, stored ones included, so a replay of stored mail still looks
   between steps. Tested.
8. Fixed: a look that would take the pass past twice a pass's references is left whole for the next pass (looking
   stops). Covered by the perf gate below.
9. Fixed: the reread test returns different labels and checks both reached the sink before the cursor save.
10. Fixed: the perf gate merges a 10,000-addition look (20,000 lookups) within the slice budget, and leaves a third
    look past the budget unmerged.
