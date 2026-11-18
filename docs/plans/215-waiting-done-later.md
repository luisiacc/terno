# Plan 215: Done and Later on "Waiting on you"

## The request

> when you finish that, i need to be able to mark as done or move for later the things that are 'waiting on you' like this one, that he said something but i don't plan to respond, so i need something to mark those as done

The owner's answers (2026-11-17):

- **Done is "no reply needed", everywhere.** It leaves What matters, the Inbox's Waiting filter and its count, and Reply ready stops preparing a reply. It comes back if they write again.
- **Done shows under Earlier** ("Done today"), as dated items and promises do. A third history source is acceptable.
- **Later sits under Coming up** ("back Fri"), as a dated item put off does, and returns to Waiting on you at its time.

Plan 214's two rating rounds named the same gap in nine of ten reports: 48 of 54 rows had no Done or Later.

## What exists

- **The fact.** `waiting_since` on `threads` is the date of the conversation's newest visible message when that message is inbound, from a person, addressed to you (not Cc only), and not answered by a message of yours (`decide`, `packages/core/src/people.ts`, through `FactContext.answered`). Both stores recompute it on ingest, on a send and in the background facts slice (`packages/db/src/facts.ts`, `packages/idb/src/facts.ts`). Everything that says "waiting" reads it: the Inbox's Waiting filter and its count (`queries.ts` `waitingSql`, `waitingCounts`), search docs, Reply ready's eligibility (`backend/src/replies.ts`, `web/src/lib/replies.ts`), and What matters' waiting rows (`waitingPage` → `stillWaiting` → the projection's `waiting` facts).
- **What matters' acts** (`TodayService.act`/`undo`, `dated.act`/`followups.act`): Done, Remove and Later on dated items and promises, revision-checked, with Undo snapshots in memory. A waiting row has no task (`FeedRow.task` undefined; `taskOf` returns null for `kind: "waiting"`), so the feed draws no controls and D and B do nothing on it.
- **Earlier** (`historyPage`) merges dated items' and promises' closings by `(closed_at, id)` with `HistorySource` 0..3 (dated and promise, a closing and a Changed line each).

## Design

### Done: a cleared message, read by the fact

"No reply needed" is the same thing as "answered", said by hand. `FactContext` gains `cleared(messageId)`: you marked this message as needing no reply. `decide` treats a cleared newest message as it treats an answered one: `waitingSince` is null. A newer message from them isn't cleared, so the conversation waits again by itself. Because the dismissal lives in the fact, every reader of `waiting_since` agrees with no change of its own: the Inbox filter and its count, search, Reply ready, the sidebar badge and the morning notice, What matters.

The record is per message, so thread merges and splits don't touch it, and it goes when its message does:

```sql
CREATE TABLE waiting_acts (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('done', 'later')),
  until INTEGER,          -- Later's moment
  at INTEGER NOT NULL     -- when it was done or put off
);
CREATE INDEX waiting_acts_done ON waiting_acts(at, message_id) WHERE state = 'done';
CREATE INDEX waiting_acts_thread ON waiting_acts(thread_id);
```

SQLite migration v74 (shape only: an empty table and its indexes). IndexedDB: a new store with the same indexes (`IDB_VERSION` 38). `clearDated` (Clear AI data) never touches it: it's the user's choice, not the reader's.

**Done** (`today.act` on a waiting row) writes `{ state: 'done' }` for the message `waiting_since` points at (the conversation's newest inbound message, read in the same transaction), then recomputes that thread's facts in the same write (`waiting_since` goes null, `search_dirty` marked). It is revision-checked against the waiting message: if a newer message has come since the row was drawn, nothing is written and the act says so (the row is now about the new message). **Undo** deletes the record and recomputes the facts, so the row comes back exactly as it was.

### Later: a deferral, read by What matters only

Later writes `{ state: 'later', until }` for the same message. It doesn't change the fact (the conversation still waits for your reply, so the Inbox's Waiting filter keeps it and Reply ready still prepares one). What matters reads it: `waitingPage`'s facts carry `deferredUntil` for a waiting conversation whose waiting message is deferred, and the projection places that row under Coming up on `until`'s day, quietly, saying "back Fri" (`whatMatters.back`), out of the counts. `nextTodayChange` takes the deferrals' moments, so the clock (`armClock`) brings the row back to Waiting on you at its time. A newer message isn't deferred, so the conversation waits again at once. Later's presets and Pick a date are the dated items' (`laterWindow` with no item day).

Done on a deferred row replaces the deferral (the same message, one record). Later on a row done meanwhile is refused as stale.

### The feed

- `TodayTask` gains `{ kind: "waiting", threadId, messageId, revision }`, where `revision` is the waiting message's id at draw time. `taskOf` builds it from the waiting row's facts. Every two-way ternary over `TodayTask` (`seenOfTask`, `othersOfTask`, `changeOfTask`) handles it explicitly.
- The row gets Done and Later like any task (hover, focus, keys D and B). Remove (⇧D), Change… and Hand to… don't apply: the right-click menu and the palette show Done and Later only for it.
- The snack: "Done: {name}" / "Hecho: {name}", and "Later: {name}, back {when}" / "Más tarde: {name}, vuelve {when}", each with Undo. The row leaves as a dated item's does (`leaveFeedRows`), and the keys go on to the next row.
- A deferred row under Coming up has its own Done and Later (Done clears it; Later moves it).

### Earlier

A third history source, the `done` records within `DATED_CLOSED_KEEP_MS`, by `(at, message_id)` (`waiting_acts_done`). `HistorySource` grows to 0..5 (dated, promise, waiting; each with its Changed slot), and the source arithmetic (`sourceOf = src % 2`, the zod `historyKey` literals) is rewritten for three tables. `TodayHistoryItem.item` takes a waiting ref. A conversation with an open row or held by the selection has no line, as now. The line: the sentence the row had ("Tomas Santarcieri wrote back about “…”."), quiet, and "Done {day}" in its column. Opening it opens the conversation; it has no controls.

## Tests

- **Core:** `decide` with a cleared newest message (null), a newer message after a cleared one (waiting again), cleared plus answered; the projection placing a deferred waiting row under Coming up with "back", out of the counts, and back in Waiting on you after `until`; `nextTodayChange` with a deferral; `historyOrder`/`historyAfter` across three sources.
- **Stores** (conformance, both): the act writes and its Undo; the fact recomputed in the same write; the Inbox Waiting filter and its count, `waitingPage` and search agreeing after Done; a newer message bringing the conversation back; the record gone with its message; Later's deferral read by `waitingPage` and not by the Inbox filter; the closed page by `at`; v74 and the IndexedDB upgrade (an upgrade test as the mutes' and nothing-asked's).
- **Backend:** `today.act` Done, Later, Undo on a waiting row; a stale act refused after a newer message; Reply ready not preparing after Done; the history page with all three sources, paging across equal moments.
- **Web:** `taskOf` for a waiting row; the menus offering Done and Later only; the snack's words in en and es; D and B on a waiting row.
- **E2E** (`what-matters-feed.spec.ts`): hover a waiting row, Done, it leaves with its snack and lands under Earlier, Undo brings it back; Later to tomorrow puts it under Coming up with "back", and the header's count drops; the Inbox's Waiting filter no longer lists a Done conversation.
- **Perf:** `decide` adds one primary-key lookup for the newest message only; `waitingPage` adds one lookup per waiting conversation it already reads (bounded by `NEEDS_WALK`); the history's third source is an indexed range. The Today perf gate and `load.perf.test.ts` at 50k, both stores. `pnpm test:all` (a migration and the store contract change).

## Out of scope

- The reader's line for a waiting conversation (it has none today).
- Bulk Done on several waiting rows.
- Dragging feed rows to categories and folders, and the 40/60 split beside the reader: the build queue's next two.

## Revisions after the Codex review

Codex's critique (twelve points, all taken). Where the design above and this section disagree, this section holds.

1. **The waiting message is the fact's, not a date.** `decide` returns the message it judged (`ThreadFacts.waitingMessageId`, computed, not stored). The act names the thread and the `waiting_since` it saw; in its transaction the store recomputes the thread's facts (the bounded newest-first walk, point 12) and acts on the message `decide` picked, refusing as stale if the fact's date isn't the one seen. Ties and drafts, failed sends and own-address mail are `decide`'s, as everywhere.
2. **A real revision.** `waiting_acts` gains `rev INTEGER NOT NULL`. A waiting task carries the record's rev as drawn (0: none). Every write checks it (absent counts as 0) and bumps it, so two windows can't overwrite each other's choice.
3. **Undo restores the whole previous record** (none, or Later with its moment), only while the current rev is the one the act wrote, and recomputes the facts in the same transaction. A stale Undo says so (`STALE`), unlike `undoAct`'s silent false today.
4. **No `thread_id` column.** The record is the message's: its thread is `messages.thread_id`, which follows merges and moves. History and Undo resolve the conversation through it.
5. **Deferrals have their own read.** `waiting_acts_later ON waiting_acts(until, message_id) WHERE state = 'later'`: the projection's Coming up rows and `armClock` read the deferrals directly (bounded), never through `waitingPage`'s window or `NEEDS_WALK`. At its moment a deferral ends: the conversation comes back only if it still waits by the usual rules (`waitingPage`); otherwise nothing shows, and the expired record is pruned with the closed ones.
6. **Reply ready stops.** Done cancels a preparation running for that conversation, and both stores' `finishReply` refuses to store a reply for a conversation that no longer waits (`waiting_since` null), whatever the source stamp says. The renderer's Reply ready already hides when the conversation stops waiting; a test holds it.
7. **The reader can't bring it back.** When the dated reader finishes a message you marked Done, its ask and respond items are stored closed (`dismissed`, reason `user`), so the same request doesn't reappear as a task; a Later on it puts them off to the same moment. Other kinds (an event, a bill) are untouched. Both stores, in `finish`.
8. **Earlier's gate per source.** Waiting closings follow the What matters switch (`gate.feed`), as waiting rows do, not the readers' gate.
9. **Earlier's words are kept at Done.** The record stores who and the subject (bounded, 200 characters each) and whether they wrote back, so the line says what the row said then; the sentence is formatted through i18n when shown.
10. **Sources 0–3 stay; waiting Done is 4**, with an explicit source mapping (no `% 2`). A waiting history line's ref is its own type, apart from `ItemRef`; its identity is `waiting-done:<message>`, and a held `waiting:<thread>` row maps to it explicitly. Paging is tested at equal moments after every source, Changed lines included.
11. **IndexedDB's closed order** (`ClosedOrder`) is generalized to a key and a moment, so the waiting record's `(at, message_id)` pages as the closed tables do, and the message cascade is registered in `FOREIGN_KEYS`.
12. **A facts-only refresh.** Done and Undo refresh that thread's `person` and `waiting_since` alone, through the same `factContext` and the bounded newest-first walk, marking search dirty in the same transaction; never the whole-thread recompute. IndexedDB gets a bounded equivalent (its `factsOf` reads the whole thread today). A test with a long conversation.

## Built

As the revisions say, with these decisions:

- **The fact.** `FactContext.cleared(message)` is asked by `decide` last, only of a newest message that would otherwise wait (one primary-key lookup). `waitingFactsNewestFirst` returns the facts with the message they judged waiting (`WaitingFacts.waitingMessageId`, never stored); `threadFacts` and `threadFactsNewestFirst` are unchanged. Both stores' `factContext` read `waiting_acts`; SQLite's looks the table up once a context (legacy fixtures write mail at their own schema version).
- **The table.** `waiting_acts` (SQLite v74, IndexedDB 38): `message_id` (primary key, cascading with its message), `state`, `until`, `at`, `rev`, `who`, `subject`, `wrote`; partial indexes `waiting_acts_done (at, message_id)` and `waiting_acts_later (until, message_id)`. IndexedDB's store has the same partial indexes in memory, the cascade in `FOREIGN_KEYS`, and `ClosedOrder` now takes a table's moment and key columns (`closedOrders.waiting`).
- **The act** (`store.today.waiting.act`) names the thread, the waiting date, the waiting message and the record's revision as drawn (`TodayWhy.reply`); in one transaction it walks the facts again (bounded) and refuses unless all four still hold. Done writes the record and clears `waiting_since` (marking search on SQLite; IndexedDB's outbox sees the row). Undo restores the whole previous record and refreshes the facts, or says STALE. The backend keeps the snapshots (`w<n>`, 50 at most), announces the thread changed (`notifyChanged`: the Inbox's Waiting filter and count, the reader) and, after Done, reads Reply ready's eligibility again (`holdingUp`), which stops a preparation underway.
- **Later** is read through the rows themselves: `store.today.waiting.rows(threads, now, { messages })` gives each waiting conversation's waiting message (the list's, one seek a row), its record's revision and Later's moment while it's ahead; the count asks only for the deferrals (nothing is read while none is ahead). The projection draws a deferred conversation under Coming up on its moment's day with "back …" and leaves it out of Waiting on you and the counts; the clock (`store.today.waiting.moments`, the soonest 500) brings it back. A deferral is never pruned (Codex code review 1, #1). **Deviation from revision 5:** the Coming up rows come from Waiting on you's own walk (`waitingPage`), not a read of their own, so the Inbox's hiding, the mutes and Needs you's rules hold for them too and no cap can let one through (Codex code review 1, #6, #7); a conversation put off and older than the newest `NEEDS_WALK` waiting has no Coming up row (it never had a waiting row either).
- **The dated reader** (both stores' `finish`, and the act itself for what it read before): a request (`ask`, `respond`) read from a message marked Done is stored closed, `dismissed` with reason `waiting` (`WAITING_CLOSED`), not `user` as revision 7 says: Earlier's waiting line says it, so the request has no "Removed" line of its own. Later puts off the requests not put off to a moment of the user's own. What an act changes is in its snapshot (each item's revision moves); Undo puts exactly those back, revisions too, and what the reader stored since as the restored record would have had it.
- **Reply ready**: both stores' `finishReply` refuse a conversation whose `waiting_since` is null; the backend won't bring a dismissed or used reply back for one (`undismiss`, `restore`); the renderer's Reply ready goes when the open conversation stops waiting.
- **Earlier**: source 4, `waiting-done:<message>` lines, by `(at, message_id)`, within `DATED_CLOSED_KEEP_MS`, by What matters' own switch (`gate.feed`); none while the conversation waits again or its row is held. `HistorySource` is 0–4 with an explicit source mapping; the line's words are the record's ("Tomas Santarcieri wrote back about “…”.", "Done today").
- **The feed**: `TodayTask` has a `waiting` kind (thread, waiting date, message, revision, who wrote); `ItemTask` is the other two, what Change… and Hand to… take. A waiting row has Done and Later on hover and focus (the Ledger's controls), D and B; ⇧D, ⇧B and ⇧F leave it alone; the right-click menu and the palette offer Done and Later only. The snack: "Done: {name}" / "Hecho: {name}", "Later: {name}, back {when}" / "Más tarde: {name}, vuelve {when}" (`whatMatters.waiting.*`), with Undo.

## Codex code review

Round 1 (eight findings, all fixed, each with a regression test that fails without the fix):

1. An old Undo could erase a newer choice once a Later over was pruned and the revision started again: deferrals are never pruned now (the clock's prune is gone).
2. A newer message at the same moment could be marked Done from a row drawn for the older one, and a deferral or revision attached to it: the row names its waiting message, the act refuses another, and `rows` resolves the message, never a date (conformance: "a message at the same moment is its own").
3. A request the reader stored before the act didn't follow it: `followItems` now applies the first Done or Later too, and its Undo reverses it (conformance).
4. A deferred conversation and the reader's request put off with it were two Coming up rows: a deferred row isn't drawn beside an item of its conversation placed anywhere (core).
5. Undo of a dismissed Reply ready after Done brought it back: the backend refuses `undismiss` and `restore` for a conversation that no longer waits (backend).
6. Deferred rows ignored the Inbox's hiding: they come from Waiting on you's walk now (backend: filed in a hidden category, neither row).
7. A 500 cap let the 501st deferral show in Waiting on you: no cap on what's left out (the same change).
8. IndexedDB's Done walked the whole conversation twice: once now (the act writes the cleared facts it already knows). Its in-memory O(thread) scan stays, as IndexedDB's ingest and Needs you's walk already scan a thread; an ordered per-thread index would be a refactor of the store beyond this plan.

Round 2 (six findings, all fixed with regression tests):

1. Undo cleared a deferral the user had chosen for the request themselves, at the same moment: an act's snapshot lists the items it changed, and Undo restores only those (conformance).
2. A Later changed a request without moving its revision, so another window's stale act on it went through: each changed item's revision moves, and Undo puts it back exactly (conformance).
3. A failed send of yours at the same moment as their message was taken as the row's message: the resolution reads received mail only (conformance, a failed send at that moment).
4. A cached Reply ready could reach a window after Done: the backend reads eligibility again after the key's wait, and the renderer shows none for a conversation it sees no longer waiting (web unit).
5. Reply restoration raced Done: both stores refuse to make a reply ready for a conversation that no longer waits, in the transition itself (conformance).
6. A merged row's other members escaped the deferred row's suppression: every member's conversation counts (core).

