# Plan 234: counts that didn't change don't wake the window

- **Status:** in progress (built; Codex code review next).
- **Builds on:** plan 231 (the error trails that showed it), plan 41 (the Dock's number), plans 158/159 (the learned-rule offer).
- **Request (verbatim):** "whats that about asking for learnud rule suggestions" → "yes plan and build it" (the fix proposed: send counts only when they actually differ).

## 1. What exists

- The backend sends `counts` whenever one of 12 callers says counts may have moved (`countsChanged()` / `emitCounts()` in `packages/backend/src/core.ts`): an ingest slice, What matters' list read again, a reminder, an AI reader's item… It sends at most every 200 ms, with a trailing push so the last state always arrives. It sends even when the numbers are the same.
- The window takes every push as new state (`apps/web/src/rpc/reconnect.ts`): `setApp({ counts })` with a fresh object. Everything that reads `counts` renders again: the sidebar, the list's header, the Dock (which already ignores a repeated number, `attention.test.ts`). The Inbox's `LearnedSource` (`components/learned-banner.tsx`) asks the backend for `learning.proposals` on every new object.
- The owner's error trails (plan 231) show `learning.proposals` every ≈ 12 s for 11 minutes after a launch, and every ≈ 0.7 s during a sync. Nothing in the inbox changed. Each call is cheap (0–3 ms), but idle isn't idle, and the trail's 100 crumbs fill with it.

## 2. Where the check goes, and why not in the backend

Deduplicating in the backend (send only when different from the last push) is the obvious place, but it breaks a contract. The window edits counts **optimistically** (`lib/categorize.ts`: `bumpUnread`, `bumpSuggestions`) and relies on the backend's next push to confirm or correct them ("the backend's counts event confirms it"). If the optimistic guess was wrong and the real numbers didn't move, a backend that stays quiet would leave the wrong number on screen until something else changed.

So the window decides, at its one entry point for pushed counts:

- It keeps the last counts the backend sent.
- A push equal to them is dropped **only while the window's counts are still that very object**. When the window has edited its counts since (an optimistic bump, a `counts.get` answer), the push is applied, so a confirmation or correction always lands.
- The ordering counter that protects a reattach's `counts.get` from overwriting a newer push still moves for every push, dropped or not.

Equality is `sameCounts(a, b)` beside `EMPTY_COUNTS` in `state/app.ts`: every key of both, numbers and null compared directly, the records compared key by key. Counts are a few small records (accounts, categories, folders, tabs), so the check is a few hundred comparisons at most, far below the render it saves.

The backend's push itself stays: computing counts is what costs (≈ 2 ms), and that happens in both designs. What this saves is everything after the push: the window's renders and the learned-offer round trip.

## 3. Tests

`apps/web/src/rpc/reconnect.test.ts` (unit, a memory transport, the real client):
- An identical push leaves the state's counts the same object (no render) and doesn't ask `learning.proposals`… In this harness it's checked on the state's identity, which is what every `useApp((s) => s.counts)` reader and `LearnedSource`'s effect depend on.
- After an optimistic edit (`setApp` with a new object), an identical push is applied: the backend's number replaces the guess.
- A different push is applied.
- The existing ordering test keeps passing: a push that arrives while a reattach's `counts.get` is in flight still wins.

`sameCounts`: equal and unequal on every field kind (a number, a null, a missing optional record, one key more or less in a record).

## 4. Perf and resources

One comparison per push in the renderer. It removes, while nothing changes: every `counts` reader's render, and the `learning.proposals` request with its query of 60 days of learned actions.

## 5. Out of scope

- `LearnedSource` still uses counts as its stand-in trigger. Offers really depend on the actions the user takes, so a better trigger is a later look. With this plan it fires only when counts really change.
- Why What matters' readers call `countsChanged()` when nothing moved: harmless once the window ignores the repeat.

## 6. Revisions after the Codex review (plan critique)

Eight points. What changed:

- **The check compares with what the window shows, not with the last push** (point 8). `publishCounts(counts)` publishes only when a number differs from the window's counts. An optimistic guess the backend confirms stays as it is (nothing to render). One it doesn't confirm is corrected by the backend's numbers, even unchanged ones. No "last push" to keep, so a dropped push can't leave a stale reference behind (point 2).
- **Every authoritative write goes through it** (point 4): the push, the reattach's `counts.get`, the list's day-part `counts.get` and categorize's two recoveries. Boot and the import keep publishing as they are (once each, together with the categories they bring).
- **The learned-rule offer gets its own trigger** (point 1). Archiving a read conversation can move no count while it crosses an offer's threshold, and dismissing, accepting or deleting a learned filter changes the offers with no count either. Until now those refreshes rode on a counts push that carried nothing new. The backend now emits **`learningChanged`** (to windows and dev tools, never MCP) when `threads.act` keeps a signal from the user's window, and on `learning.accept`, `learning.dismiss` and `filters.delete`. `LearnedSource` asks again on that event as well as on counts that really changed.
- **Ordering** (point 3): the revision counter moves for every push, including one with nothing new, so a reattach's older answer never overwrites it. Tested.
- **`sameCounts` is tested on every field of `Counts`** (point 6): one field moved at a time, both ways round, plus absent against null against 0, a key added or gone, and key order.
- Not taken: separate bootstrap tests (point 7). Boot publishes once, before any push, and the comparison needs no state of its own. A late `counts.get` overtaking a newer push on the direct readers (point 5) predates this plan and is unchanged.

## 7. Tests run

- Unit: `state/counts.test.ts` (new), `rpc/reconnect*.test.ts`, and `backend.test.ts`, which gains two tests: `learningChanged` on a kept action that moves no count (not on markRead, not on a dev tool's action), and on accept, filter delete and dismiss.
- E2E (all designs): `inbox-scan`, `filters`, `list-layout`. In `inbox-scan`, the offer's dismissal used to arrive through a list refresh plus a throttled counts push. It now comes from its own event, so the test listens for that, and un-dismissing (a database edit) emits it.
- **A finding in that test.** With the offer gone sooner, "the mail on screen doesn't move" failed about once in 12 runs, in a different design each time (the first row 32 px up). Recording the first row in every animation frame showed no painted frame where it moved: the scroll offset and the rows change together. The failing reads came from Playwright's `evaluate` running between React's commit and the virtual list's re-measure, which runs before paint. The test now reads after two frames, as it already did at the list's end. 24 out of 24 across the six designs, and 76 passed across the three specs.
