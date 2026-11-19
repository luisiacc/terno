# Plan 216: Remove on "Waiting on you", and its line in the reader

## The request

> the things that are 'waiting on you' i should be able to remove(removes it from the feed) and click 'done' on them

With a screenshot: What matters, "WAITING ON YOU 2", the second row (Lucas Fajardo Gutiérrez wrote back about "IusPro - Colombia", since Oct 21) open, the conversation in the reader beside it, and no Done, Later or Remove anywhere: not on the open row (plan 214: the open row at rest shows no controls), not in the reader.

Decisions taken for the owner (2026-11-18):

1. **Remove is "off What matters" only.** It doesn't touch the waiting fact: the Inbox's Waiting filter and count, Reply ready, search and the sidebar's Inbox badge are as they were. It leaves no Earlier line. It comes back when they write again. The reader's requests from that message are left alone (Done closes them; Remove doesn't). What matters' header count and Waiting on you's count drop it. Its snack names who wrote, with an exact Undo.
2. **Remove everywhere an item's Remove is:** the right-click menu, ⇧D and the palette. The row's hover controls stay Done · Later.
3. **The open waiting row's acts are in the reader, as every other item's.** When the feed's open row is a waiting row, the reader's card (the dated items' card, `thread-items.tsx`) says who is waiting and since when, with Done · Later · Remove. Only when the conversation is opened from that row; opened from the Inbox, nothing new.

## What exists

- **Plan 215's record** (`waiting_acts`, SQLite v74, IndexedDB 38; `packages/store/src/waiting-acts.ts`): one per message, `state` `done` or `later` (SQLite: `CHECK (state IN ('done', 'later'))`), `rev` moved on every write, the act walking the thread's facts again and refusing a stale revision, message or date; Undo restoring the whole previous record. Done is read by the facts (`FactContext.cleared`); Later by What matters alone (`waiting.rows` → the projection's `deferredUntil`). `waiting.rows(…, { messages: false })`, the count's read, reads nothing unless a deferral is ahead.
- **The feed** (`feed.tsx`): a waiting row has a task (`TodayTask` kind `waiting`), Done and Later on hover and focus, D and B. ⇧D on it is refused (`actOnKeyTarget`), the right-click menu and the palette leave Remove out for it, and `actOnTask` makes `dismiss` a no-op.
- **The reader's card** (`thread-items.tsx`, `useReaderItems`, `readerItems` in `lib/reader-items.ts`): the conversation's dated items and promises (`ReaderItem`, each an `ItemRef`), one on top (the feed's open row's, `useFeedTarget`; one chosen from the Also line; else the soonest), the rest on a quiet Also line; Done (outlined) · Later · Change… · Hand to… · Remove. A waiting row isn't an item: `useFeedTarget` returns nothing for it, so its conversation shows no card (or, if it has an item behind Coming up, that item's card, acting on the item).
- **Keys:** `keyTarget` (today-task.ts) acts on the reader's chosen item (`useReaderChoice.held`) when there is one, else the feed's row: for an open waiting row, D and B already act on its task.

## Design

### The record: a third state

`WaitingActState` gains `removed`: the same record, keyed by the waited-on message, through the same act, revision and Undo. It:

- isn't read by the facts (`cleared` is `done` only), so the conversation still waits everywhere but What matters;
- has no Earlier line (`donePage` is `done` only) and no moment (`moments` is `later` only);
- is read by What matters' rows: `WaitingRowFacts.removed` (present only when true, so plan 215's assertions hold), and the projection leaves a removed conversation out of every group and count;
- changes nothing of the reader's requests (`applyItems` does nothing for it; `unapplyItems` has nothing to undo for a removed record, made explicit: IndexedDB's `deferred_until === current.until` would otherwise match every request with no deferral, `null === null`), and `finish` treats a removed message as one with no record;
- goes with its message, and a newer message from them has no record: the row comes back by itself.

Any state may follow any other through the act (a deferred row under Coming up has Remove too; Remove replaces its Later, and Undo puts the Later back).

**SQLite v75** widens the CHECK. A CHECK can't be altered: the table is rebuilt (`waiting_acts_v75`, rows copied, old dropped, renamed, both partial indexes recreated) plus a third partial index `waiting_acts_removed ON waiting_acts(message_id) WHERE state = 'removed'`. Shape only: the table holds one row per act the user made (hundreds at most), never the mailbox; `migrations.perf` covers it. **IndexedDB**: no CHECK, so no version change; the in-memory `removed` partial index is added to the table's spec (indexes are built at load), and `LOGICAL_SCHEMA` follows to 75 with a line in the schema's history.

**The count's read** (`rows(…, { messages: false })`): today it reads nothing unless a deferral is ahead. A removed record changes a row too, and removed records accumulate (one per Remove, kept until their message goes: pruning them would let a revision start again and an old Undo match a newer choice, plan 215's code review 1, #1). So it reads only the removed records that could matter: the removed partial index, each joined to its message's thread and date, kept when that thread is in the page at that date; the grouped resolution then runs over those threads only (still exact: two messages at one moment, the newest received is the waiting one). Nothing is read while no record is removed (one probe). IndexedDB walks its `removed` index the same way, as its deferrals already are.

### The backend

`today.waitingAct`'s `action` takes `remove` (RPC enum, still never MCP). It writes `state: 'removed'`; it doesn't announce the thread changed (nothing the Inbox shows moved) nor touch Reply ready; What matters reads again (`changed()`). Undo as now (the thread announced, harmless).

`project()` passes `removed` to the projection (`WaitingFact.removed`); `projectRows` skips a removed conversation before anything else, in the list and the count alike.

### The web

- `actOnTask` sends `dismiss` on a waiting task as `remove`. The snack: "Removed from What matters: {name}" / "Quitado de Lo importante: {name}" (`whatMatters.waiting.removed`, the dated item's words with who wrote in the task's place), with Undo; the row leaves as from Done (`leaveFeedRows`), the keys on to the next.
- ⇧D (`actOnKeyTarget`) is no longer refused on a waiting row; the right-click menu shows Remove (its note "The email stays", true here too) and the palette Remove for it. Hand to… and Change… stay an item's.

### The reader's card for an open waiting row

`readerItems` stays the items' model, and learns one thing: whether the feed's open row is this conversation's waiting row (`ReaderInput.waiting`). Then the waiting line leads the card, unless an item was chosen from the Also line (that one leads, as now, and the waiting line is the first on the Also line; choosing it gives the lead back). The items stay `others`. `ReaderItems.waiting` says where it is: `"top"`, `"also"` or `null`. A waiting conversation has no `ItemRef`, so it isn't made a `ReaderItem` (that would put a third case into Change…, Hand to…, the reader's held choice and the summary's dedupe, none of which apply to it).

The line's acts are the feed row's own: `useReaderItems` reads the open row (`useFeedWaiting(threadId)`: the row while it's open, this conversation's, with a waiting task) and the card's Done · Later · Remove call `actOnTodayRow(rowId, task, …)`, exactly what the row's hover controls, D, B, ⇧D, the menu and the palette call. So the keys and the card can't disagree: with the waiting line on top and nothing chosen, `keyTarget` already acts on the open row's task.

The card is the dated items' (the AI card's surface and inset, the sentence on its own line, the controls under it on its edge): Done outlined, Later with the same presets and Pick a date as the row's Later (`laterChoices` for a waiting task: anywhere ahead), Remove quiet. `ItemLater` takes its window, start and words as props instead of a `ReaderItem`, so both lines use it. The words: "Lucas Fajardo Gutiérrez is waiting on your reply · since Oct 21" (es "Lucas Fajardo Gutiérrez espera tu respuesta · desde 21 oct"), the when being the feed row's own (`todayWhen`: "since …", or "back …" for a row under Coming up). Its buttons are named "Done: Lucas…", "Later: Lucas…", "Remove from What matters: Lucas…".

The card draws once the reader's reads have answered (as now), so the line never swaps on arrival. Opened from the Inbox, from a history line or anywhere but the waiting row, nothing changes. Plan 214's rule (the open row at rest shows no controls) now holds for waiting rows too: their acts are in the reader.

## Tests

- **Store conformance** (both engines, `conformance/waiting-acts.ts`): Remove leaves the fact (the Inbox's filter and count, search) as it was, is read by its row (`removed`) in the list's and the count's reads, has no Earlier line or moment, leaves the reader's requests (open and put off) exactly as they were, and Undo puts back none or the Later it replaced, the requests' revisions untouched; a newer message isn't removed; the count reads a removed record only at its own message (a stale one, and a message at the same moment, aren't); Done after Remove and Remove after Later at their revisions; `finish` on a removed message stores its requests open.
- **Migrations:** v75 keeps v74's rows and accepts `removed`; `migrations-shipped` gains v75's line; the IndexedDB `removed` index on a mailbox written at 38.
- **Core:** the projection leaves a removed conversation out of every group and the counts.
- **Backend:** `today.waitingAct` with `remove`: the list and the count drop the row, the Inbox's Waiting count doesn't move, no thread announced; its Undo.
- **Web unit:** `waitingSaid` for Remove (en, es); `readerItems` with a waiting target (leads; an item chosen leads and the waiting line is on the Also line; no items); the reader's line words.
- **E2E** (`what-matters-feed.spec.ts`, plan 215's scenario page): Remove from the right-click menu (snack, row gone, header count down, the Inbox's Waiting still lists it, z back); ⇧D on the open waiting row; the open waiting row's card in the reader (line, Done · Later · Remove, Remove and its Undo, Later to tomorrow from it, Done from it); axe in light and dark. `today.spec.ts`'s "⇧D left alone on a waiting row" step goes (now covered here).
- **Visual:** screenshots of the open waiting row with the reader's card, and of the right-click menu on a waiting row, light and dark.

## Perf

- The list: `rows` adds one column to its join (no new read).
- The count: one probe of the removed index while none is removed (none today); with removed records, a range of that index and a primary-key lookup a record, then the grouped resolution for the matching threads only. The Today perf gate (`today.perf.test.ts`) runs a mailbox with removed records in it; its numbers are reported with the base's (its SQLite busy turn was already 61.7–62.8 ms against 60 ms before this plan).
- The reader: one more zustand selector on the open row; no read.
- v75 rebuilds a table of the user's acts only: `migrations.perf` at 50k.

## Out of scope

- The card for a waiting conversation opened from the Inbox (no feed row is open there): it could follow later, reading the conversation's waiting message itself.
- Bulk Remove of several waiting rows.
- A request the reader reads later from a removed message is stored open, as from any message (Remove leaves the reader's requests alone, by decision 1). Worth the owner's look if it reads as the row coming back.
- Dragging feed rows to categories and folders; the 40/60 split beside the reader (the build queue).

## Revisions after the Codex review

Codex's critique (eleven points). Where the design above and this section disagree, this section holds.

1. **Undo of a Remove that replaced a Later puts the Later's effect back.** A request the reader stored while the row was removed is stored with no deferral; when Undo restores the Later, those requests (open, never changed, revision 0, no deferral) are put off to its moment again, as an Undo already does for requests stored since a Done or a Later. Conformance: Later → Remove → the reader stores a request → Undo, and Undo again.
2. **The reader's choice is scoped by the open row itself.** `chosen` is kept for the feed's open row's identity (the waiting row's id, else its items' keys), so opening another row of the conversation never keeps a choice made under the waiting row. Choosing the waiting line from Also is its own operation: it clears the choice and the reader's Later menu.
3. **The keys follow what the card shows.** `readerItems` says whether its top came from the choice (`chose`), and `useReaderItems` holds that item for the keys and the palette whenever it does (not only when the chosen key is the group's lead), so D and ⇧D never fall back to the waiting row while the card shows a chosen item. Unit test with a chosen member of a merged pair.
4. **The card's Later is for the task it was drawn for.** The waiting line's Later (its menu and its picker) is keyed by the task's message and revision: a newer message or another window's choice remounts it, closing anything open, so an old menu can't act on a new message (the act is revision-checked besides).
5. **B and the palette's Later** open the feed row's own Later, as they do for a dated item open from the feed (unchanged; the reader's Later is the button's). Kept: one rule for every open row; noted here rather than changed for one kind.
6. **Focus after an act from the card.** The card's buttons go when its row leaves; a keyboard user's focus would fall to the page. An act from the card (Done, Remove, a Later moment) puts the keys on the feed's row that is open or holds the place after it (`keysOnTo`), for the dated items' line too (the same card). E2E checks the focused element after Remove from the card.
7. **Remove suppresses the waiting row only.** The projection skips the removed conversation's waiting row; its items (Coming up's, a Plan) and a due reminder of yours show as they would with no waiting row (a reminder you set is yours to see). The design's "every group" means the waiting row in every group (Waiting on you, or Coming up for a deferred one). Core test with a due reminder: list and count agree.
8. **Transitions only while the conversation waits.** The act is refused unless its message still waits (as now): Done → Remove or Done → Later is STALE; Done is reopened only by its Undo. Remove after Later, Later or Done after Remove (at their revisions, while waiting) hold.
9. **The count's read is bounded by the page.** The removed records are read at most one more than the page's conversations (`LIMIT`); past that, the grouped resolution runs over the page (the list's read, bounded by `NEEDS_WALK`) instead. IndexedDB likewise. The Today perf gate gains thousands of obsolete removals (records whose message no longer waits) in its waiting scenario, both engines.
10. **v75's rebuild at size.** `migrations.perf` fills `waiting_acts` with a record per received message of the 57,000-conversation mailbox (far past any real history) before v75 runs, and v75 stays under its 1 s step. v74 is untouched (frozen); the rebuild copies rows without reading or writing anything else.
11. **Two windows and Undo.** Conformance: a stale Done or Later after another window's Remove is refused; an old Remove's Undo after a newer choice is refused; Remove follows its message when its conversation is merged. Web: when the open waiting row is removed elsewhere, the feed holds it as words (no task); the card then shows nothing for it, and the keys are left alone on it (never moved to a sibling item).

## Built

As the revisions say, with these decisions:

- **The record.** `WaitingActState` is `done | later | removed`. SQLite v75 rebuilds `waiting_acts` with the wider CHECK and adds `waiting_acts_removed (message_id) WHERE state = 'removed'`; IndexedDB has a `removed` partial index in memory and no version change (`LOGICAL_SCHEMA` 75). `waiting.rows` gives `removed: true` on a removed row (the key absent otherwise). The count's read on SQLite: with no deferral ahead, the removed records (at most one past the page's size) joined to their message's thread and date, then the grouped resolution for the matching threads; past the page's size, the page's own grouped read. On IndexedDB it walks the `removed` index lazily, each a key lookup, the thread walked only for a record at a page conversation's waiting date (code review, #3: no page-wide fallback).
- **Undo** of a Remove that replaced a Later puts the requests the reader stored meanwhile off to the Later's moment at revision 0, as the reader would have stored them under it, so the Later's own Undo takes them back too (code review, #2).
- **The backend** maps `remove` to `removed`; a Remove only re-reads What matters (`changed()`): no thread announced, Reply ready untouched.
- **The web.** `actOnTask` sends `dismiss` on a waiting task as `remove` ("Removed from What matters: {name}" / "Quitado de Lo importante: {name}"); ⇧D, the right-click menu (Remove with "The email stays") and the palette offer it. The reader: `useFeedWaiting` (the open row while it's this conversation's waiting row), `readerItems({ waiting })` (`waiting: "top" | "also"`, `chose`), and in `thread-items.tsx` the card split into `ItemLine` and `WaitingLine` on the same layout constants, `ItemLater` taking its words and window. "Lucas Fajardo Gutiérrez is waiting on your reply · since 8:30 AM" (`whatMatters.waiting.line`, es "… espera tu respuesta · …"), the when being the feed row's own (`todayWhen`).
- **Focus.** Revision 6 is done by the line itself, not the button (`useKeysWhenGone`): a line that unmounts while it, or its Later's menu or picker, holds the focus, or after the focus fell to the page, leaves the keys on the feed's open row (or its place), once its portals have gone; never while focus was moved elsewhere on purpose, and only in What matters (code review, #4 and round 2). And an Undo that puts the open row back brings back the keys the act had moved on to the next row (`restoreFeedRow`, code review #1), for every act that leaves the feed, the row's own Done too.
- **Deviation:** revision 5 as written (B and the palette's Later open the feed row's menu for an open waiting row, as for a dated item open from the feed).

## Codex code review

Round 1 (four findings, all fixed, each with a regression test that fails without the fix):

1. Undo after the card's Remove reopened the row while the keys stayed on the next one, so D acted on that one: the keys come back with the open row (web unit, `feed-leave.test.ts`; the e2e's ⇧D after the Undo no longer refocuses by hand).
2. Later, Remove, a request read, Undo, Undo left the request put off: put back at revision 0 (conformance, both engines).
3. IndexedDB's count, past the page's size of Removes, walked every page conversation: it walks the removed records alone (the Today gate holds 4,000 Removes, 3,000 stale).
4. Focus recovery ran two frames after the act, before a line that goes once the reply comes: it runs when the line unmounts (component test).

Round 2 (one finding, fixed with a component test): the Later menu's item held the focus when the line went (a portal outside it): its portals count as the line's, and the recovery waits for them to go.

## Tests run

- Typecheck (`pnpm typecheck`, in `test:all`) and `oxlint --deny-warnings`: clean.
- Unit, named: conformance on both engines (`store.conformance`, `idb.conformance`: 1,552 pass; plan 216's 6 a store), `migrations`, `migrations-shipped`, IndexedDB's `waiting-acts-upgrade`, `idb.uncertain-upgrade`, `idb.folders-upgrade`; core `today-projection` (50); backend `today` (plans 215 and 216's 11); web `dated`, `today-task`, `reader-items`, `thread-items-change`, `feed-leave`, `feed-focus`, `state/today`: all pass.
- E2E (`E2E_PORT=5716`): `what-matters-feed`, `today`, `hand-to`, `what-matters-change`, `what-matters-mute`: 41 of 42; `today.spec.ts:648` (the known flaky one) failed once in the crowd and passed alone four times.
- Perf: `migrations.perf` with a `waiting_acts` row for every received message of the 57,000-conversation mailbox: v75 176 ms (1 s budget). The Today gate: IndexedDB passes every scenario (its new one, 4,000 Removes, 3,000 stale: list p95 12.1 ms, count 7.5, 2.2 added, longest turn 29.4). SQLite's new scenario holds its budget (list 57–58 ms, count 45–47, 9–12 added, longest turn 74 of 120); its `spread` scenario's longest turn is 61.9–64.6 ms against 60, as plan 215 measured before this plan (61.7–62.8: the scenario has no waiting record; this plan adds one probe of an empty index to its count).
- `pnpm test:all` (`E2E_PORT=5716`, `WEB_PORT=5726`; 1,441 s, the machine shared, load 10 to 14 at its start): lint, build, typecheck pass; db-wasm and ui-perf flaky (failed only the crowded first pass). Failing, none from this change: `apps/site/src/render.test.ts`, `web.spec.ts:533`, `visual.spec.ts` and `resign-in.spec.ts:312` screenshot comparisons (all four fail on plan 215's base too); the packaged `ai-rating.smoke.ts:13` (the AI stub doesn't know the dated reader's prompt: nothing here touches it; not checked on the base); startup's `mailbox.smoke.ts:121` (covered under load; passes alone); perf's `folders-migration`, `workloads` dated reads (5.2 of 5 ms), `reconcile` and `perf.perf` navigation stalls under load, and the Today gate above.
- Visual: the open waiting row with the reader's card, and the right-click menu on a waiting row, light and dark (`WM_216_SHOTS`).

Seen, not this plan's: an open row's who is cut ("Lucas Fajard…") while its button holds the focus, the room for Done and Later kept though they're hidden at rest (plan 214's `ROOM` on `has-focus-reveal`).

## After landing: the open row's who whole

The "seen, not this plan's" cut above had a plainer cause than focus: `ROOM` kept the controls' room on `group-has-[[aria-expanded=true]]`, meant for Later's open menu, and the row's own open button carries `aria-expanded=true` while it's open. So every open row cut who ("Lucas Fajard…") though its controls were hidden. The room is now kept for `wm-later`'s open menu only; the open row makes room under the pointer, as its controls show. The feed spec checks the open row's second line has no end padding at rest, and measures the line against Done with the pointer on the open row. Codex review: no findings.
