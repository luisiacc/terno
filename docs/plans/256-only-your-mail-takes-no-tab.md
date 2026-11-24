# 256: a conversation of only your own mail is offered no Gmail tab

## Request (verbatim)

From the recording of the Google OAuth demo video (2026-11-23):

> ## Bug 2: Promotions ↔ Primary moves never show in Gmail
> Moving the test conversation to Promotions (plan 86's category actions, `CATEGORY_ACTIONS`/`CATEGORY_LABELS` in gmail-api.ts) did nothing visible either way:
> - Terno's own Promotions view never listed it.
> - Gmail never showed it under Promotions.

After the investigation, the owner chose:

> lets do 1 for bug 2

(Option 1: don't offer the move for such a conversation; the menu needs a thread fact saying so, in both stores.)

## What happened

The test conversation was two messages the owner sent to themselves (both `is_sent`, both in the Inbox). Plan 86's rule is that **your own mail never decides a tab**: `threadTab` (`packages/core/src/tabs.ts`) skips sent, draft and own-address mail, and the category action's `plan()` (`packages/db/src/actions.ts`, and IndexedDB's `mail.ts`) moves only mail that isn't sent or a draft. So `toPromotions` on this conversation changed no message, queued no op (the profile's queue holds none) and left the tab at 0. Yet the row menu offered "Move to Promotions", the row slid out of the Inbox and the snack said "Moved to Promotions". The Gmail path itself is right (`gmail-ops.test.ts`: `toPromotions` adds `CATEGORY_PROMOTIONS`, removes the rest).

## What exists

- `threads.tab` (SQLite v37, IndexedDB `tab` on the row): 0 Primary, 1 Promotions, 2 Social, folded in `recomputeThreads` (`packages/db/src/ingest.ts`, `packages/idb/src/mail.ts`) only for Inbox threads, and rewritten by the tabs backfill (`tabs.ts` in both stores) when what's yours changes (`requestTabRefresh`).
- The row menu (`apps/web/src/components/thread-menu.tsx`): `tabbable` (every row a Gmail account that keeps tabs apart, in the Inbox, not Trash/Spam) and `intoTab(tab)` (some row isn't in that tab yet) decide whether "Move to Promotions/Social" shows. Nothing else in the app starts a tab move (no shortcut or palette command).
- `ThreadSummary` carries `tab` only when non-zero, to keep rows small.

## Design

### The fact

A thread is **only yours** when it's in the Inbox and none of its Inbox mail is someone else's: no message that `threadTab` would count (in the Inbox, not Trash or Spam, not sent, not a draft, not from your own addresses). Such a thread can't be in a tab, whatever its categories, so no tab move can take it anywhere.

- Core: `threadTabState(messages, own) → { tab, onlyYours }`, one pass (the loop `threadTab` already makes; Primary's early return also means "not only yours"). `threadTab` stays as its `.tab` for the callers and tests that want only that.
- SQLite: migration v78 `ALTER TABLE threads ADD COLUMN only_yours INTEGER NOT NULL DEFAULT 0` (shape only, O(1)), and it asks for a tab refresh: the backfill's `{"phase":"threads","after":0}` when there's a Gmail account, restarting a pass already in its threads phase (its progress row is the one row it rewrites, said in `rewrites`), so existing Inbox threads get the fact in the backfill's own background slices. Until a thread is reached it reads 0: the menu offers the move as before, the old behaviour.
- IndexedDB: `only_yours` on the row (missing reads 0); `LOGICAL_SCHEMA` 78, and a mailbox from before 78 asks for the same refresh on open (as v37 started the backfill).
- `requestTabRefresh` (both stores) restarts a pass already in its threads phase instead of letting it finish: what it passed would keep the old addresses' tab and fact. A pass still in its messages phase goes on (its threads phase starts at the beginning).
- Written beside `tab` everywhere `tab` is: `recomputeThreads` (both stores; 0 outside the Inbox, as `tab`) and the backfill's `writeTab` (both stores; it only changes a row whose tab or fact changed).
- `ThreadSummary.onlyYours?: true`, present only when set (like `tab`).

### The menu

`intoTab(tab)` offers a move only if some row isn't in that tab **and isn't only yours**. A selection of only-yours rows gets neither Promotions nor Social; a mixed selection still gets them, and the move acts on the others only: an only-yours row stays in the Inbox and isn't counted in the snack. "Move to ▸" stays enabled when the account has folders, and is disabled (as today) when it has no folder and no move left.

A "select all N" scope is unchanged: it offers a tab move only from another tab, whose threads aren't only yours by definition.

### Not changed

- Plan 86's rule itself (your mail never decides a tab), the action's `plan()`, the Gmail op.
- No new copy: nothing new is said; the item just isn't offered.

## Tests

- core `tabs.test.ts`: `threadTabState` says only yours for sent-only, draft-only and own-address Inbox mail; not for a Primary or tabbed message of someone else's; trashed/spam/archived others' mail doesn't count.
- db: recompute writes `only_yours` (a sent-to-self thread → 1; a reply from someone else arrives → 0; archived → 0); the backfill's threads phase writes it; migration v78 adds the column and asks for the refresh (`migrations.test.ts`), `migration-rule` stays clean.
- idb: the same recompute and backfill cases; a mailbox opened from logical schema 77 asks for the refresh.
- summaries carry `onlyYours` in both stores (the store conformance suite, so both engines run it).
- db and idb: a mailbox from before v78 / schema 78 gets the fact from the refresh, with no pass under way and with a threads pass already past every thread; a refresh asked during a threads pass restarts it, one in its messages phase goes on.
- e2e `gmail-tabs.spec.ts`: a Gmail conversation of only your own mail in the Inbox: its menu's "Move to ▸" keeps the account's labels and has no Promotions or Social; picked with a stranger's conversation, Move to Promotions moves only that one (one conversation said, one op naming only its message), the note stays.

## Perf

One more integer written in the same `UPDATE`/row update `recomputeThreads` already makes; the fact comes from the loop that computes the tab. The migration is an `ADD COLUMN` with a constant default (`migrations.perf.test.ts` holds). The refresh runs in the existing tabs backfill slices, Inbox Gmail threads only. Summaries gain one column read and an optional boolean.

## Out of scope

- Changing plan 86's rule so your own mail can be moved into a tab (option 3, the owner's call; not chosen).
- The recording runner's submenu click (bug 1: the runner's slow diagonal glide closed "Move to ▸" before its click; no Terno change).

## Revisions after the Codex review (plan critique)

Codex read the plan and the first draft (`/tmp/terno-scratch/p256/critique.out`). Taken:

1. *A mixed selection moved and counted the only-yours row.* The menu's Promotions and Social act on the picked conversations a tab can take (`runTab`); the e2e checks the note stays and the snack counts one.
2. *An existing backfill cursor would skip the rows behind it.* The v78 step restarts a threads-phase pass (its progress row is declared in `rewrites`); IndexedDB's open does the same through `requestTabRefresh`. Both upgrade tests run with a pass already past every thread.
3. *An alias learned during a threads pass left the rows it passed stale* (true of `tab` since plan 86, and now of the fact). `requestTabRefresh` restarts a threads pass; a messages-phase one goes on. Unit test in SQLite.
4. *The shipped-migration hash and the thread rows' `SELECT *` comparisons.* v78's hash added; the v14, v37, v74 and v73 thread comparisons expect `only_yours: 0`. (Those tests, and 11 others in `migrations.test.ts`, already failed at HEAD before this change: a separate issue.)
5. *No e2e.* Added (above).

Not taken:

- *The category planner relabels an own-address message that isn't marked sent.* Plan 86's action rule, unchanged here: the menu no longer offers the move where it can't place the conversation, which is this plan's scope.
- *The backfill's list refresh leaves a cached reader summary stale.* At worst the menu offers the move as before until the next read; not worth a new notification path.
- *The backfill reads a whole conversation before checking its budget; IndexedDB reads every thread key once per pass.* Plan 86's bounds, unchanged; the pass now also runs once after the upgrade, Inbox Gmail threads only.
- *Gate the fact on Gmail.* The fact is about the mail, not the provider, and only Gmail rows use it (the menu's `tabbable` needs an account that keeps tabs apart); an IMAP row having it is harmless.
