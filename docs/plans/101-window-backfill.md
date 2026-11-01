# Plan 101: a wider sync window downloads the older mail

## Request (verbatim)

> if the user changes the 180 days in settings, does it start loading them in the background too?
> yes proceed to build that

## What exists

- **The window** (plan 79): `syncWindowDays` per account (`AccountPrefs`), else General's (default 180). `BackendCore.syncAccount` turns it into the sink's `windowStart` (now − days, so it slides forward daily) and `windowDays`.
- **Gmail** (`gmail-api.ts`): the cursor is `{ historyId }` once a full sync completed, or `{ historyId?, reconciliation }` during one. A reconciliation records its window as `intent` (`days:N`) and `after` (seconds); a resumed one with another intent is discarded and starts over, so **during the first sync a new window already applies**. After it completes, only history follows: **nothing ever reads older mail**.
- **IMAP** (`imap.ts`): per-mailbox `{ uidvalidity, uidnext, … }`. A mailbox read for the first time searches `SINCE windowStart`; after that only UIDs ≥ `uidnext` are new. The sweep reconciles known locations (`SEARCH ALL`) but never ingests unknown older ones: **widening never reaches older mail**.
- Each pass sets `syncState.syncedSince = windowStart` (IMAP) — the sliding start, not what is covered.
- `firstSyncing(a)` (status syncing, never synced) drives the "Downloading your mail" pill.

## Design

### What is covered

Each provider keeps in its cursor the oldest moment its mail is complete from: `covered` (epoch ms).
- Set when a first full read completes: Gmail from its reconciliation's `after`; IMAP from the `windowStart` of the pass that first read the account's mailboxes.
- An existing cursor without it (accounts synced before this plan) takes the current `windowStart` the first time it is seen (nothing older was read; the cursor is written so it doesn't slide).
- Narrowing the window changes nothing (nothing is deleted; `covered` stays).

### When it runs

A pass whose `windowStart` is more than a day before `covered` (a widening; the daily slide only moves `windowStart` forward) has a **backfill** to do: the span `[windowStart, covered)`. It runs after the pass's normal work (new mail first, always), resumes across passes, restarts and network loss from its saved progress, and on completion moves `covered` to the span's start. A further widening while one runs extends it (the new span starts at the new `windowStart`, ends at the old `covered`; progress inside the old span is kept only if its start is unchanged, else the span restarts — it skips what's stored either way).

### Gmail

- Cursor: `{ historyId, covered?, backfill?: { after, before, next?, pages } }` (seconds, like `after`). Every save carries `covered`/`backfill` (one merge point in `saveProgress`), including reconciliations and history saves.
- Each pass with a backfill: list `after:<after> before:<before>` (`includeSpamTrash`, 500 a page, newest first), download what isn't stored (`fetchFull`: paced by plan 62's quota, live: false, so no notifications), save `next` after each page. The same bounds as a reconciliation (`LIST_PAGES_MAX`, continuation tokens). History keeps every backfilled message current afterwards.
- A history expiry/overflow (a full reconciliation) keeps `covered`: its refresh re-reads every stored message, the older ones included.

### IMAP

- Cursor: `covered?` and `backfill?: { since, before, done: string[] }` (ms; `done`: mailboxes finished).
- Each pass with a backfill, after the regular mailboxes: for each mailbox with state not in `done`, `SEARCH SINCE <since> BEFORE <before>` (day granularity, overlap is harmless) limited to UIDs below its `uidnext`, then the same identification as a first read (`syncMailbox`'s pipeline, factored to take a UID list), ingested with `live: false`, never moving `uidnext`. A message it must hold back (identity unproven) leaves the mailbox not done; the next pass tries it again. All done → `covered = since`.

### Status and UI

- `AccountSyncState.backfillSince: number | null` (new, optional): set while a backfill runs (the span's start), cleared when done. The pill shows **"Downloading older mail"** with the window's words ("The last year, newest first") when an account backfills and isn't first-syncing.
- Changing a window (General or an account's) starts a sync of the affected accounts at once, so the backfill begins without waiting for the poll.
- Settings: under the window field, a quiet line when it grows: "Older mail downloads in the background." (en/es).

## Tests

- Gmail (unit, provider harness): a completed cursor without `covered` records it; a widening lists `after/before`, downloads only unstored ids, saves progress, resumes after an abort from `next`, finishes by moving `covered`; a narrowing does nothing; the daily slide never starts one; saves during a backfill (history) keep it.
- IMAP (int, ImapKit): older messages beyond the first window exist in INBOX and a custom folder; widening ingests them (`live: false`: no arrivals), `uidnext` unchanged, completion moves `covered`; a pass cut in the middle resumes with the finished folders skipped.
- Backend: changing `syncWindowDays` syncs the account; `backfillSince` drives the pill (e2e: light/dark screenshot).
- Perf: a backfill page is the same per-message work as a first sync (no new hot path); idle accounts do nothing extra (one comparison per pass).

## Out of scope

- Deleting mail when the window narrows (storage has its own limits, plan 69).
- Per-folder windows; progress numbers.

## Revisions after the Codex review

The critique (12 points) replaced "covered" inference with an explicit request:

1. **A request, recorded when the window widens** (points 1–3, 11). `accounts.update` and `settings.update` compare each affected account's *effective* window before and after (an override, an override removed, General for the accounts that inherit it). A widening stores `AccountPrefs.backfill = { since: now − newDays, until: now − oldDays }` (exact ms bounds, merged with a pending one as their union) through the store's transactional prefs patch, then starts that account's sync without awaiting it (never inside the settings chain). No legacy inference, no sliding comparison, 180→181 fills its day. The renderer can't set it (the RPC schema has no such field).
2. **Bounded chunks** (point 4). A pass does its normal work first, then at most ~30 s of backfill (whole batches of 50; a page's continuation saved only once the page is done), then tells the core more remains (`sink.backfillMore`): the core starts another pass a second after this one ends. New mail and its notifications are never more than a chunk behind. Done: `sink.backfillDone(request)` clears the request if it is still that one.
3. **Old mail is a first sync's old mail** (point 8): ingested with `live: false` (no arrivals, no notifications), filters and the categorizer apply exactly as they do to a first sync's mail. Nothing new is invented for it.
4. **IMAP** (points 5, 6, 9): progress per `path:uidvalidity` (a reset or recreated mailbox starts over; its regular read already uses the wider window), UIDs below `uidnext` taken newest first in chunks of 250 and ingested per chunk, the chunk's lowest UID saved as progress. A message held back for identity isn't retried by the backfill (the regular passes own identity); it never blocks completion. A mailbox that fails is retried next chunk; one that vanished is no longer required.
5. **Storage removal** (point 7): a removal (plan 69) clears the accounts' backfill requests: what the user removes isn't fetched back. A later widening is a new request.
6. **Gmail cursor** (point 10): `backfill: { since, until, after, before, next?, pages }` parsed field by field like a reconciliation (bounded, its own request's bounds; anything else is dropped and the backfill restarts its listing), carried by every save (`saveProgress` merges the current one). Seconds in the query, ms in the request.
7. **Pill** (point 12): "Downloading older mail" while an account has a request and is neither in error, offline, nor waiting for a sign-in; the first sync's pill wins when both apply. `syncedSince` is out of scope (unchanged).

## What the Codex code review changed

Seven findings, each fixed with a regression test that fails without it:

1. **A completion could erase a wider request recorded meanwhile** (read, compare, clear in separate steps). Now `AccountPatch.backfill` is an intent applied inside the store's own update transaction (SQLite and IndexedDB): `clearIf` the exact request.
2. **Two widenings at once could lose a span** (read pending, write union). Now `merge` unions inside that same transaction.
3. **A folder whose backfill read was refused was marked done.** It is retried by later regular passes (`BACKFILL_FOLDER_TRIES` = 3), never marked done while it can still be read.
4. **Held messages had no retry.** One `introduced` set serves the whole run (twins across folders resolve as in a first sync), and what identity holds back is saved and tried once more at the end of the run.
5. **A flag changed between the sweep and the backfill's read could be swallowed.** What the run touches is reconciled like any pass's.
6. **Gmail's page limit claimed the span was done.** The listing starts over instead (stored messages are skipped).
7. **`accounts.update` answered with the account from before the request**, hiding the pill. It answers with the account as it is now.

Tests: `gmail-backfill.test.ts` (span query, no notices, chunk budget and resume, first sync overlap, foreign progress dropped, page limit), `imap-backfill.int.test.ts` (every folder, `uidnext` untouched, no notices, narrowing, storage removal cancels, refused folder retried, twins, a flag change staged mid-backfill), `backfill-requests.test.ts` (General vs override, 180→181, union and clearIf, concurrent widenings, the RPC reply), `window-backfill.spec.ts` (the pill in light and dark, axe), `settings-edits.test.ts` (a widening starts a pass).
