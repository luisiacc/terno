# Plan 229: actions on mail Gmail changed first

## Request (verbatim)

> Bug 3: local actions undone when a new Gmail label finishes creating
>
> What the recording shows. This was the installed 0.1.1 release with a fresh profile, a real Gmail account, just after its first sync (30 days) finished:
> 1. On a test conversation reached from a search, Terno did: mark unread, mark read, archive, all fine on screen. Then New label "Terno review" from the sidebar. The label took about 10 s to be created at Gmail; until then the Move to submenu didn't list it.
> 2. At about +128 s, in the same half second the label appeared, the test thread went back to **unread**: its dot returned and the menu flipped to "Mark as read".
> 3. Move to → Terno review was clicked at once. No "Moved" confirmation appeared, while the "Archived" notice was still showing.
> 4. Leaving the search, the thread was back at the top of the **Inbox**, unread. The label view stayed empty.
>
> So read, archive and label were all undone locally at the moment the label finished creating. The suspicion is that state read back from Gmail (a label or folder refresh, or a sync pass triggered by `createFolder`, `packages/backend/src/handlers.ts:1429`) overwrote local actions that hadn't been sent yet, or had been sent and not yet confirmed. Unconfirmed; no logs survived. […]
>
> Expected: an action the user takes is never undone by a sync or refresh. Pending actions win over server state until they're confirmed (AGENTS.md: "never lose the user's work"; undo is exact).
>
> Please: try to reproduce it with the e2e/dev server fakes: archive or read actions pending while a label or folder create completes, and the refresh that follows; find the cause with file:line evidence, and fix it under the same process as the other two, with a regression test; if you can't reproduce it, write down what you ruled out, and add diagnostics that would catch it next time.

## What happened (from the runner's log and the footage)

The runner's events (`run-2026-11-21T04-42-41/events.jsonl`, recording 2) put the steps in another order than remembered: **New label** was typed at 87–94 s, then the search, **unread** at 102 s, **read** at 107 s, **archive** at 111 s; the label appeared at ~127 s and Move to was clicked at once (~127.1 s, the menu is gone at 127.2). The dot and the Inbox count came back between 128.0 and 128.2 s. The conversation is two messages Terno sent itself: the test message (sent ~45 s, it arrived in the Inbox unread) and **the reply, sent at 85 s** ("Message sent" on screen).

So all three actions were taken while the label's creation held the account: a folder change waits for the account's running pass and then runs alone, the ops worker passing the account by and syncs waiting (`core.ts:2486-2577`, `runForAccount`). It took ~33 s. At 99 s the conversation shows read, not in the Inbox: Terno hadn't read back yet that Gmail had **delivered the reply to you, in the Inbox and unread** (Gmail does that with mail to yourself; the test message got the same at 45 s).

## Cause (reproduced in both stores; consistent with the recording, which kept no logs)

Two rules, each sound only while Terno's copy matches Gmail:

1. **A thread action reaches Gmail only for the messages whose local flag differs** (`packages/db/src/actions.ts:48-90` `plan`, `packages/idb/src/mail.ts:1053`). Archive targets the messages Terno has in the Inbox, Mark as read those it has unread. The reply was neither, as far as Terno knew, so neither action was ever sent for it.
2. **An unread still queued is cancelled outright by the read that follows it** (`packages/db/src/repos.ts:395-405`, `packages/idb/src/mail.ts:1714`), on the assumption that "the provider was never touched and still holds the original state". Here the original state at Gmail was unread.

When the label's creation ended, its pass (`folders.ts:165` `resync`) read the reply's labels: INBOX, UNREAD. No action of the person's was pending on it (none had targeted it), so the observation was rightly accepted, and the conversation was unread in the Inbox again. Gmail agreed: the reply was never archived or read there.

Not the cause (ruled out): the label list's write (`replaceFolders`, `packages/db/src/folders.ts:360`) touches no message; the flag protocol (`flag-protocol.ts`) refused observations for every message an action did target (an intent with pending ops, or a barrier newer than the pass's epoch), as the first test below shows for a message Terno had right.

The missing "Moved": the move needs the backend's answer to show it (`apps/web/src/lib/folder-move.ts:49`), and the label view stayed empty, so no move reached Gmail. The runner clicked the item the instant it appeared (the submenu re-sorting as the label arrived); the footage can't tell a missed click from a move that never answered. Not reproduced; diagnostics below.

## Design

What a person does to a conversation is said to Gmail for the whole conversation, as Gmail's own `threads.modify` does ("applies to all messages in the thread"): Terno's copy of each message may be a step behind.

- **A Gmail conversation the action changes is named whole** (see the revisions for why only those). The planners already name the messages an action governs (`scope`, the set `reaffirmFlagIntent` reads: the latest for unread and star, the chosen ones for Move to Inbox and categories, all of the conversation otherwise; Not spam only its spam ones). For a Gmail account, a conversation in which the action changes at least one message now has every governed message of it in the provider op (`actionTargets`, `packages/store/src/action-targets.ts`, shared by both stores); the local write still changes only what differs, and Undo still journals only that (it puts back what Terno showed). A governed message whose flag already matched gets the same flag intent as the others (pending until the op settles, then a snapshot), so a read-back can't flip it while the action is on its way. Gmail label changes are idempotent: an archive of a message without INBOX changes nothing there. "Whole" means every message Terno has: a message Gmail holds that Terno hasn't downloaded isn't named (this isn't `threads.modify`). IMAP stays as it is: its ops move and flag known locations. Explicit messages (filters, on mail just read) stay as they are.
- **The newest read or star always goes.** The exact-opposite cancellation goes in both stores, for every provider (an IMAP flag can be a step behind as well); the older queued op is superseded by the newer one as any overlapping older op already is (`SUPERSEDABLE`). Toggling read twice before the worker runs now sends one request with the final state instead of none, which makes the server match whatever it held.
- **Diagnostics for the move.** `folder-move.ts` leaves breadcrumbs (counts only: plan 10/78) when a move starts, when it answers, and when it says nothing because the connection changed or the undo was taken, so a missing "Moved" can be told apart next time.

## Tests

- `gmail-catchup.int.test.ts` (SQLite and IndexedDB, fails without the fix; each half of the fix alone fails it too): a conversation of two, the first in the Inbox and read, the reply read and archived as Terno stored it; Gmail puts the reply in the Inbox, unread, without Terno knowing; while a label's creation is held, the person marks the conversation unread, read and archives it; through the creation, its pass and the ops held back it never shows unread or in the Inbox, Gmail hears exactly one read and one archive for both messages, and holds them so.
- The same file: the control case (a message Terno had right) stays read and archived through the same sequence (passes before and after: the protocol's witness).
- Conformance (`store.ts`, both stores): archive names a Gmail conversation whole and an IMAP one's changed messages, journals only what changed, and a repeat sends nothing; each action keeps its own reach (unread and star the latest, Move to Inbox the mail received, Not spam only its spam); undo of mixed read states leaves Gmail a read for the read ones and an unread for the one put back; read then unread supersedes (was: cancelled).
- Conformance (`durable-flag-intents.ts`, both stores): a message the action names without changing it is held like the others against a read from before the action, one while it's on its way and one from before it's confirmed, and is confirmed by a fresh read; an undo before it's sent puts back only what changed and leaves nothing pending; an unattempted inverse supersedes and holds until confirmed; a running predecessor and a newer read keep older observations refused until the newest settles.
- `repos.test.ts`: supersession, not cancellation.
- `folder-move.test.ts`: the breadcrumbs (asked, answered; another connection; a failure).

## Performance and quota

Only conversations the action changes are named whole, so a sweep over a view mostly done already (a category marked read) adds nothing for its conversations already read. For a conversation it changes, the op names its other governed messages too, its newest twenty at most (see the code review): more op targets and flag intents in the same sliced command, and, once the op settles, a confirmation read (`format=minimal`, 20 units) for each named message. For an ordinary conversation of a few messages that's about 1–3× the reads of today; a long conversation marked read with one unread message costs a read per message (50 messages: 1,000 units, about 12 s of pacing in the background, the first 900 units at once). Trash posts one request per message, as before. At Gmail, one `batchModify` takes 1,000 ids (50 units). Gates run: `scope.perf.test.ts` (Gmail accounts in its mailbox: archive a whole view and undo it, a category marked read), `reconcile.perf.test.ts`, `flag-reconcile.perf.test.ts` (IndexedDB), `store.perf.test.ts`, `idb.perf.test.ts`.

## Out of scope

- Why the label's creation took 33 s (it waited for a running pass, as plan 107 designed); holding ops and syncs during a folder change only widened the window.
- IMAP's locations (above), and messages Gmail holds that Terno hasn't downloaded.
- Filters (explicit messages, also when a body completes) and a filter's folder move: they name what changed, as before.
- A folder move's own label: a message Terno thinks is already under the label gets no addition if Gmail took the label off elsewhere (`folder-move.ts` `queueFolderMoves`).
- Move to Inbox's tab correction (`untabThreads`) picks messages by their local category, as before.
- Sweeps that leave out what's already done here before acting (a sentence's archive or read skips conversations Terno shows archived or read).

## Revisions after the Codex review

Codex read the plan against the code (twelve points):

1. The diagnosis is a reproduced mechanism consistent with the recording, not the recording's own logs (none survived): said so above.
2. "Whole conversation" isn't `threads.modify`: a message Gmail holds that Terno hasn't downloaded isn't named. Said so.
3. Each action keeps its reach: built on the planners' own `scope` (latest for unread and star, mail received for Move to Inbox, chosen ones for categories), Not spam only its spam ones (it adds INBOX). Conformance test over a mixed conversation, both stores.
4. Races for messages named without changing: conformance tests for a read from before the action, one while it's on its way and one from before it's confirmed; and a running predecessor with a newer read.
5. The cancellation goes for IMAP too: accepted (one request on a quick toggle; an IMAP flag can be behind as well); the durable-intent tests that expected no op now expect supersession.
6. Explicit-message callers (filters, at ingest or when a body completes, and a filter's folder move) keep naming only what changed: out of scope, written down.
7. A folder move's label targeting has the same kind of hole: out of scope, written down.
8. Move to Inbox's tab correction: out of scope, written down.
9. Undo with changed and unchanged messages: conformance test (only the journaled one is put back, the ops are archive for both then Move to Inbox for the one, nothing stays pending).
10. Sweeps that skip what's done here: out of scope, written down.
11. and 12. Cost: the first design named every governed message of every conversation acted on, which would have sent a sweep's already-done conversations and a confirmation read for each of their messages. Narrowed: only a conversation the action changes is named whole (a no-op action stays a reaffirmed intent, unsent, as the parked-work design has it). The reproduction now also asserts no transient rollback and Gmail's exact requests. The cost is written down above.


## Codex code review

Two findings, each fixed with a test that fails without it:

1. **Trash named messages already in Trash.** Each Trash is its own request, and one answering 404 (a message Gmail has since deleted for good) stops the rest, so a live reply after six old deleted ones was never trashed. Trash names only what isn't in Trash here, as before. Conformance test (both stores).
2. **Twenty long conversations went over the event loop's budget.** The backend acts on a selection of up to 20 conversations in one command; 20 conversations of 100 messages with one unread each named 2,000 messages, each with its flag intents: ~100 ms against ~18 ms before. A conversation's unchanged messages are now named up to its newest twenty (`UNCHANGED_NAMED`), where your own reply just delivered and a change made elsewhere land; older ones only when the action changes them, as before. The same act is ~33 ms. The op row is also read once per op, not once per target, in both stores' `enqueueOp`. New perf gates in both stores (`action-targets.perf.test.ts`: that act within 50 ms, 420 messages named) and a conformance test of the cap.
