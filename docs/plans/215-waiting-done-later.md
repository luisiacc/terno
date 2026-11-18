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
