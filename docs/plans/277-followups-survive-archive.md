# Plan 277: Follow-ups survive Archive

- **Status:** plan.
- **Reverses:** plan 218's archive half. Trash and Spam keep hiding a conversation's follow-ups, as they did before plan 218 (plan 142 revision: "comes back with them").

## The request (verbatim)

> for followups, ok lets then return to track followup on archived threads too, they can dismiss them or delete them either way.

The owner's answer came from research on what people want from AI mail tools (2026-11-25): their biggest fear is that a commitment vanishes into an archived thread. "Send, archive, get nudged if they don't reply" is the workflow people expect. A follow-up the user doesn't want is ended by its own Dismiss (or Done), or by deleting the conversation.

## What exists (plan 218, `8fba1b263`)

- **The store:** `FollowupStore.putAway(threadIds)` reads a conversation as put away when it's in Trash or Spam, **or archived**: it has mail from someone else (by your addresses: `fromOthers`, which reads each conversation's senders) and none of it in the Inbox. `FollowupStore.closeArchived(threadIds, now)` closes the open rows of the conversations with only your mail (`dismissed`, `ARCHIVED_CLOSED`, off the top). SQLite (`packages/db/src/followups.ts`) and IndexedDB (`packages/idb/src/followups.ts`), in the conformance suite and the follow-ups perf gate.
- **The worker** (`packages/backend/src/followups.ts`): `shown`/`readAway` leave put-away rows out of the snapshot, list, count, Inbox's top and notice; `awayAmong` gives What matters the last look's set; `archived()` calls `closeArchived` and looks again.
- **The action** (`handlers.ts`): Archive calls `b.followups.archived(chunk)` and journals the closed rows for Undo.
- **What matters:** `placeItems(…, { away })` (core) and `changedItems` (backend `today.ts`) drop a put-away conversation's promises.
- **The app:** `staysInView` takes a row out of the Follow-ups list on Archive, Trash and Spam (`actions.ts`); `feedRowsLeaving` takes a row of your promises only out of What matters' feed on Archive (`feed-leave.ts`).

## Design

**Put away means Trash or Spam.** Nothing else changes about how a follow-up lives: an archived conversation's follow-up stays in the Follow-ups list, its count, the Inbox's top when it's due (plan 142's "comes back to the top of your Inbox"), What matters and the notice, until it's answered, kept, dismissed or deleted.

1. **The store.** `putAway` becomes `inTrashOrSpam(threadIds)`: one read of the threads' `in_trash` and `in_spam`, no message read. `fromOthers`, `closeArchived` and `ARCHIVED_CLOSED` go. Rows already closed with `archived` stay in history as dismissed (the UI reads no other meaning into that reason). No migration.
2. **The worker.** `shown`, `readAway`, `awayAmong` and `threads()` stay, reading `inTrashOrSpam`; their comments say Trash or Spam. `archived()` goes. The budgeted slices stay (cheap now, and the same shape).
3. **The action.** Archive no longer closes follow-ups. It still ends the Inbox's top through `leaveTop` (`ENDS_TOP`), as before plan 218: a due follow-up came back to the top, and archiving it from there says "I've seen it"; the row itself stays active, in the list and What matters.
4. **What matters.** `placeItems`' `away` and `changedItems` keep working off the worker's set, now Trash or Spam only. Comments updated.
5. **The app.** `staysInView` keeps a row in the Follow-ups list on Archive (Trash and Spam still take it out). `feedRowsLeaving` no longer takes promise rows out on Archive; a person waiting on your answer still leaves (that row is there because the mail is in the Inbox).

## Tests

Each plan 218 test changes to the new rule, at the lowest level that catches it:

- **Conformance** (both stores): `inTrashOrSpam` for Inbox, archived with their mail, sent-only, Trash, Spam, gone. The `closeArchived` cases go.
- **Backend** (`followups.test.ts`): an archived conversation, with their mail or only yours, keeps its follow-up in the snapshot and the list, and a due one is still announced; Trash and Spam still hide it and it's back with the conversation. The closing and look-race cases for `archived()` go; the race test on the look stays if it still guards `shown` (a look running while a Trash happens).
- **What matters** (`today.test.ts`, `today-projection.test.ts`): an archived conversation's promise stays in the list and the count; a Trash one doesn't.
- **App units** (`actions.test.ts`, `feed-leave.test.ts`): Archive keeps the Follow-ups row and the promise's feed row; Trash takes both out.
- **e2e** (`followups.spec.ts`): Archive from Follow-ups keeps the row and the count; Delete takes it out, Undo brings it back.
- The follow-ups perf gate measures `inTrashOrSpam` instead (thread reads only).

## Perf

Cheaper than today: the put-away read no longer reads messages, so the 50,000-message case in the perf gate goes away.

## Out of scope

- A setting for plan 218's behaviour.
- Reminders (plan 87): their own rules.
- Copy: the Follow-ups tip already says "If nobody answers, this conversation comes back to the top of your Inbox", which is true again for an archived one.

## Revisions after the Codex review

Codex's critique of the plan (10 points), and what changed:

1. **The Inbox's top after an archive** (point 1), stated: a follow-up that comes due after its conversation is archived comes back to the top of the Inbox, as plan 142 designed. Archiving a conversation while its follow-up is on the top ends the top (`leaveTop`, `seen`), as before plan 218; the follow-up stays in the list and What matters, and Undo puts the top back. An archive in Gmail or another app doesn't run `leaveTop`, so a row on the top stays there until the user acts on it there. Tested at the backend.
2. **The IndexedDB read is early** (point 5): `inTrashOrSpam` reads only `threads`, so it goes through `early()` like thread summaries, and the Follow-ups list no longer waits for the late tables.
3. **Rows plan 218 already closed** (point 4) stay dismissed: they're in history as any dismissed row, and the user can't tell them from a Dismiss. Nobody but the owner has such rows (no users yet). The in-memory Undo journals carry only pre-action snapshots, which the revision-checked restore puts back whatever the action did.
4. **Every path that archives or moves** (point 6): Archive anywhere (the Follow-ups list, the Inbox, What matters' Automated mail, typed and scoped actions) shares `actOn`, which no longer closes anything. A move to a folder or a hidden category no longer hides a follow-up either. Each path keeps its own `leaveTop` and Undo.
5. **What matters** (point 7): the Trash/Spam filter stays where it is in `placeItems` (after `withoutAnswered`, before grouping). The tests change to: an archived conversation's promise is a row and counts, and its Changed line shows; a Trash one is neither.
6. **The feed** (point 8): the unit test covers that Archive keeps a promise's row (Trash takes it out). The focus and Undo paths for Waiting on you are unchanged and keep their tests.
7. **The Follow-ups e2e** (point 9) waits for the conversation to leave the Inbox before it checks that the row and its count stayed.
8. **The perf gates** (point 10): the follow-ups gate keeps its 1,000 active rows and its 100-id slice, over thread reads only; the 50,000-message sender fixture goes. `today.perf.test.ts` runs as before.
9. **Kept as designed, rare** (points 2, 3): `endTop`'s early return before the worker's first look, and a notice in flight while the same conversation is archived off the top, are pre-plan-218 behaviour; the first needs the feature off or a cold start, the second an archive in the one turn before a claim.
