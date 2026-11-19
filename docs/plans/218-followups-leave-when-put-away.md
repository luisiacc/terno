# Plan 218: Follow-ups leave when their conversation is put away

## The request

> if i archive or delete someting in the 'follow-ups' list, it means i don't want it there, lets remove it from that list if i do that

> consequently, if they are arechived already another place, they also should not show on the 'followup list'

With a screenshot: the Follow-ups list (13 due), its second row (oswindorsey40, "Information on the upcoming meeting") open, the reader's card "oswindorsey40 hasn't replied in 14 days".

The owner's answer (2026-11-19), asked whether it stops only in the list or everywhere: **everywhere.** Archiving or deleting means you're done with it: the follow-up leaves the Follow-ups list, its count, the Inbox's top and What matters, and it doesn't nudge or notify. Moving the conversation back to the Inbox, Undo, or a new message from them brings it back. The owner accepted the cost: "send, archive, get nudged if they don't reply" no longer works on a conversation that had incoming mail.

This reverses plan 142 §"Moves" ("archive doesn't close it … the list keeps it").

## What exists

- **The list** (`FollowupWorker.threads`, `packages/backend/src/followups.ts`): every active row's conversation, one row a thread, already leaving out Trash and Spam by the summaries' `inTrash`/`inSpam` ("comes back with them"). The app's list is the view `all` (`navigate({ followups: true })`), so `staysInView` keeps a row there after Archive: the row stays, which is what the owner saw.
- **The snapshot** (`look()` → `followups.list` and the `followups` event): every active row. The windows build `byThread`, the sidebar's due count, the Inbox's top count and the reader's follow-up card from it (`applyFollowups`, `reader-items.ts`). `announce` leaves Trash and Spam out of the notice only.
- **What matters** (`TodayService.project`): promises from `store.followups.active()`, placed, then `projectRows` with `live(threadId)` (not Spam, not Trash; the count asks `store.today.liveAmong`). A merged item whose lead isn't live shows through a live member.
- **Archive's path** (`actOn` → `leaveTop` → `followups.endTop`): an `onTop` row becomes `seen`, its snapshot journaled in the action's `TopLeft` for Undo (`returnTop` → `putBack`).
- **Where a conversation is**: `threads.in_inbox`, `in_trash`, `in_spam` (SQLite) and the same fields on IndexedDB's thread records. Nothing says "has incoming mail"; messages carry `is_sent`, `is_draft`, by thread (`messages_thread`, IndexedDB `fk_thread_id`).

## Design

### "Put away"

A conversation is **put away** when it is in Trash or Spam, or it is **archived**: it has a message that isn't yours (`is_sent = 0`, not a draft) and none of its messages is in the Inbox (`in_inbox = 0`). A conversation of only your own sent mail was never in the Inbox, so it isn't archived by that rule: a wait on mail you sent stays.

One store read, both stores, in the conformance suite:

```ts
/** Plan 218: of these conversations, those put away: Trash, Spam, or archived (mail from someone else, none of it in the Inbox) */
putAway(threadIds: readonly number[]): Promise<Set<number>>;
```

on `FollowupStore`. SQLite: one statement over `json_each`, the `EXISTS` only for threads out of the Inbox (by `messages_thread`). IndexedDB: the thread record, then its messages by `fk_thread_id` only when it's out of the Inbox. It's asked about the active rows' threads only (≤ `FOLLOWUPS_ACTIVE_MAX`, deduplicated).

It's state, read live, never written: moving the conversation back to the Inbox, Undo, or new mail from them (which lands in the Inbox) brings the follow-up back with no extra code, and an archive in Gmail on another device counts the same as one in Terno.

### Where it applies

1. **The worker's snapshot** (`look`): the rows of put-away conversations are left out of what's emitted and returned. The windows' list, due count, Inbox's top, reader card and What-matters reader items read only the snapshot, so they follow. The worker's own bookkeeping (`this.ids`, `closeAnswered`, `makeDue`, `nextDue`) keeps every row, so `touched()` still looks again when the conversation comes back, and a reply that arrived meanwhile still closes the wait.
2. **The notice** (`announce`): only shown rows are claimed and said. A promise due while put away is said if it's back within the notice window, as a Trash one is today.
3. **The list and the Inbox's top** (`threads`): the put-away set replaces the `inTrash`/`inSpam` check.
4. **What matters** (`project`): a promise entry counts as live only when its conversation isn't put away (`ProjectionFacts.away`, read once for the promises' threads, in the list and the count alike). Dated items and Waiting on you are untouched: they aren't follow-ups. The existing lead/member fallback keeps a merged item showing through a live dated member.

### Archive on a conversation with no incoming mail

Archiving a conversation of only your own mail changes nothing the rule reads, so the follow-up would stay: the first request's case (Archive in the Follow-ups list on a sent-only conversation). So `actOn`'s archive also **closes** the open follow-ups of the conversations it archived that have no incoming mail (`state: dismissed`, `closedReason: "archived"`, `inboxState: none`), before `leaveTop`, its snapshots in the same `TopLeft` (Undo puts them back exactly; Trash and Spam need no close: the rule hides them). History lists such a promise as dismissed, as any other.

A new store write: `followups.closeArchived(threadIds, now): Promise<FollowupSnapshot[]>`: open/due rows of those threads with no message that isn't yours; one transaction.

### The app

`staysInView` learns the Follow-ups list: Archive, Trash and Spam take the row out at once (the optimistic path, as the Inbox does), and the snapshot that follows agrees.

## Tests

- **Conformance** (`packages/store/src/conformance/followups.ts`, both stores): `putAway` for inbox, archived-with-incoming, sent-only out of the Inbox, Trash, Spam, gone; `closeArchived` closes only sent-only threads' open rows and returns their snapshots; `restore` of them puts them back.
- **Backend** (`followups` tests): the snapshot leaves out an archived conversation's row and returns it when it's back in the Inbox; `threads()` likewise; a due promise on an archived thread isn't notified; `threads.act` archive of a sent-only thread closes its row and `threads.undo` brings it back.
- **What matters** (projection unit test): a promise whose thread is away doesn't place a row nor count; a merged item shows through its live dated member.
- **e2e** (`followups.spec.ts`): Archive in the Follow-ups list takes the row out and the count down; Undo brings it back.

## Perf

`look()` runs at most once a second while anything is active; `putAway` is one indexed read over ≤ 1,000 threads (most in the Inbox, no message read). What matters' count adds the same read for the promises' threads. The follow-ups perf gate (`conformance/followups-perf.ts`) covers `putAway` at the active bound.

## Out of scope

- Moving to a folder or filing into a category hidden from the Inbox: the rule covers them where they take the conversation out of the Inbox (Gmail labels do; Terno's hidden categories keep `in_inbox`), with no close.
- The Reminders list (plan 87): its own rules.
- A setting for the old behaviour.

## Revisions after the Codex review

Codex's critique of the plan (11 points), and what changed:

1. **"Archived" by your addresses, not `is_sent`** (point 9). `is_sent` follows Gmail's SENT label and IMAP's Sent folder, so one of your own messages filed elsewhere would read as someone else's. A message is someone else's when its sender isn't one of your addresses (`addressKey` against the accounts and own correspondents, as the follow-ups reader decides), and not a draft, Spam or Trash.
2. **What matters reads the worker's set, not the store** (point 11). The count runs on every mailbox change, as often as every 200 ms. The worker keeps the put-away set from its last look (`FollowupWorker.putAway`) and its emit already makes What matters read again, so the count adds no read. The list (`threads`) still reads it fresh. The SQLite read takes each conversation's senders once (`DISTINCT thread_id, from_email`), so a long thread costs its people, not its messages. The perf gate adds ten conversations of a hundred messages of yours, all out of the Inbox.
3. **IndexedDB's late tables** (point 10): `putAway` is a `read`, so it waits for messages as every message read does. The worker's look already waits for them (`closeAnswered` is a command), so the first snapshot is no later than before.
4. **Hidden before placement, after `withoutAnswered`** (points 5, 6). `placeItems` takes `away`: a put-away promise still answers its request (the conversation was put away whole, so the request doesn't come back alone), then it leaves before grouping, so it's no lead, member, `with`, Also line or event attendance. A merged item keeps its canonical id with its dated member leading.
5. **Earlier's "Changed" lines** (point 7) leave out open promises whose conversation is put away.
6. **What matters' feed** (point 8): `feedRowsLeaving` takes out on Archive a row whose members are all promises. A row merged with a bill or request stays, since its dated member leads it after.
7. **The sent-only close and its Undo** (point 3): `archived()` gets the ids asked for, not the ones the mail action changed (a sent-only archive changes no message). Its snapshots alone make the action's Undo. It closes first, setting `inboxState: none`, so `endTop` after it touches none of those rows and no row has two snapshots. Tests cover the exact restore and the no-op archive.
8. **Kept as designed, stated:**
   - A sent-only conversation's follow-up closed by Archive comes back only by Undo. It was never in the Inbox, so there is no moving it back (point 1).
   - A promise there isn't reopened by later mail. A wait is closed by their reply anyway.
   - An archive in the seconds before the reader has read a just-sent, sent-only message leaves the follow-up it then finds (point 2). The window is small and the row can be dismissed.
   - Undo past the active bound (point 4) is plan 142's, as for every Undo of a follow-up.

## What was built

As designed, with the revisions above. The store contract gains `putAway` and `closeArchived` (SQLite and IndexedDB, in the conformance suite), the worker hides put-away rows from its snapshot, list and notices and closes sent-only ones on Archive, What matters places no promise of a put-away conversation, and the app takes the row out at once in the Follow-ups list and in What matters' feed.

## Codex code review

**Round 1** (4 findings, all fixed, each with a regression test that fails without it):

1. An older look finishing after an archive could publish and announce the row it closed. Looks now run one at a time, in order (a call while one runs shares the next). `claimNotice` refuses a closed row in both stores. The notice re-reads what's put away just before claiming.
2. `archived()` skipped the store when the worker hadn't looked (off at start). It now always asks the store.
3. What matters, which starts before the follow-ups worker, read an empty put-away set. Its first read now waits for the worker's first look, and reads the store itself only if that fails.
4. The put-away read over long sent-only conversations exceeded the slice budget. The worker reads in `runBudgeted` slices. The perf gate grows to 50,000 messages (1,000 conversations of 50 of your own) and gates a slice of 100: SQLite 1.8 ms, IndexedDB 1.1 ms; all 1,000 at once 17 ms and 7 ms.

**Round 2** (2 findings, left as very rare; the review rounds stop here):

- An archive of a conversation with incoming mail in the one turn between the notice's last put-away read and its claim can still let that one notice through. It needs a due promise not yet said, and an archive in that turn.
- One conversation of tens of thousands of your own messages makes a single read longer than a slice. Gmail threads stop at 100 messages; an IMAP thread that long with an open follow-up isn't a workload we have.

## Tests run

- Conformance, both stores: `putAway`, `closeArchived` and exact restore, `claimNotice` refusing a closed row.
- Backend (`followups.test.ts`, `today.test.ts`): a sent-only archive closes and Undo restores exactly; an archive that changes no message still has its Undo; archived elsewhere, deleted, back in the Inbox; the look race; archive before any look; What matters' list and count, and before the first look.
- Core (`today-projection.test.ts`): no row, member or count; an answered request stays answered; a merged item keeps its id.
- Web units (`actions.test.ts`, `feed-leave.test.ts`); e2e `followups.spec.ts` (every design) and `what-matters-feed.spec.ts`.
- Typecheck, lint; the follow-ups perf gate on both stores.
- `today.perf.test.ts`: IndexedDB passes. SQLite's "longest busy" is over its 60 ms on the base as well (61.4 and 62.4 ms on two runs of the base, 60.1 ms with this change). Its fixture's incoming mail is now in the Inbox, since otherwise every promise there would be put away.
