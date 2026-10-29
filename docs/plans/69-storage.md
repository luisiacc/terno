# 69 · Storage

## Request

> have a setting called 'storage' for the settings, where user can manage the space, we need to tell how muck disk space things are taking and we need to offer him to remove old messages, we can categorize it by archived, spam, normal messages with their sizes, lets have an intuitive ui there, do this in a worktree, when you finish, rebase and merge the worktree branch to main

Decisions made while planning (the user was not asked, so each one favors not losing mail):

- **Removing frees this device only.** Mail stays on the mail server. Terno deletes its local copy (rows, bodies, attachment bytes, search entries). Nothing is sent to the provider, so nothing is lost: the mail is still in Gmail or on the IMAP server.
- **What is never removed:** starred conversations, conversations the user replied in, conversations with a draft (a reply, or a forward of one of their messages), unsent local mail, and conversations with a queued or running action. This matches plan 63's "valued threads" rule, plus whatever is still in flight.
- **Whole conversations, by last activity.** "Older than 6 months" means the newest message is older than 6 months. Removing part of a conversation would leave a confusing half-thread.
- **Buckets follow the views the user already knows:** Inbox, Archive, Sent, Spam, Trash. "Normal messages" from the request is the Inbox. Sent is shown for its size but is never removable (every Sent conversation is one the user replied in).

## What exists

- **Settings → Data** (`data-tab.tsx`): backup export and import. On the web it also shows `StorageSection` (`web/storage-section.tsx`, lazy, web only): persistence, the browser's usage and quota, and the engine switch (OPFS SQLite or IndexedDB).
- **Thread flags** (`threads.in_inbox`, `in_trash`, `in_spam`, `has_sent`, `is_starred`) drive the views. The partial indexes in `migrations.ts` define them: archive is `in_inbox = 0 AND in_trash = 0 AND in_spam = 0`, spam is `in_spam = 1 AND in_trash = 0`.
- **`messages.size`** holds the provider's size: IMAP `RFC822.SIZE`, Gmail `sizeEstimate`. Reading it costs nothing. Measuring bodies with `length()` would read every body (gigabytes).
- **`deleteMessages`** (SQLite `ingest.ts`, IndexedDB `mail.ts`) is the provider-deletion path. It cascades locations, attachments and links (orphaned assets are then collected), search (the outbox triggers), op targets, folders, and recomputes or drops the threads.
- **Sync does not bring removed mail back.**
  - IMAP: incremental by `uidnext`. A UIDVALIDITY reset re-identifies only mail newer than the window (`imap.ts`, "only re-identify old mail").
  - Gmail: history fetches only *added* messages. Label changes on unknown ids are ignored. An expired history runs a full sync of the window.
  - So mail older than the account's sync window never returns. Removed mail inside the window can return only after a provider reset or an expired Gmail history, and it is still the user's own mail.
- **SQLite has no `auto_vacuum`.** Deleted pages go on the freelist and the file doesn't shrink.
- **Bulk patterns:** `SliceSizer` (`slicer.ts`), `b.yieldTurn()`, `progressReporter(b, jobId, total)` and `bulkProgress` events, `trackJob` in the renderer.

## Design

### Core (`packages/core/src/storage.ts`)

```ts
export const STORAGE_BUCKETS = ["inbox", "archive", "sent", "spam", "trash"] as const;
export const REMOVABLE_BUCKETS = ["inbox", "archive", "spam", "trash"] as const;
export const STORAGE_AGES = [30, 90, 180, 365, 730] as const; // days
export function storageBucket(t: { inInbox; inTrash; inSpam; hasSent }): StorageBucket
// trash > spam > inbox > sent (has_sent) > archive
export interface StorageThreadRow { id; bucket; lastDate; kept: boolean; messages; bytes }
export function removable(row, buckets, cutoff): boolean // bucket in buckets, !kept, lastDate < cutoff
export interface StorageReport {
  disk: { bytes: number; free: number } | null; // what the mailbox takes (free: reclaimable inside it)
  buckets: { bucket; threads; messages; bytes; removable: { threads; messages; bytes }[] /* per STORAGE_AGES */ }[];
  at: number;
}
```

`kept` = starred, replied (`has_sent`), drafted, local or unsent, or with pending ops. The store computes it, and the predicate is shared.

### Store (`MailStore.storage`, both adapters, conformance-tested)

- `threads(after, limit)` returns `StorageThreadRow[]`: thread ids above `after`, ascending, at most `limit`.
  - SQLite: `threads` by PK joined to `messages_thread`, `GROUP BY t.id`, `sum(m.size)`. A held message is a draft, has no provider id, or has a `local:` provider id.
  - Pending ops: `EXISTS` over `op_targets_msg` with `ops.state IN ('queued','running')`.
  - Draft-held threads: read once per call (`drafts.thread_id`, plus the threads of `in_reply_to_message_id` and `forward_of_message_id`; drafts are few).
  - IndexedDB: the in-memory tables, `messages.by("fk_thread_id")`, the same rules.
- `remove(threadIds, buckets, cutoff)` is one unit. It re-reads those rows, keeps only the ones `removable()` passes *now* (something starred, replied, drafted or queued meanwhile stays), and runs `deleteMessages` on their messages. It returns `{ touched, threads, messages, bytes }`.
- `footprint()` returns `{ bytes, free } | null`.
  - SQLite: `page_count × page_size`, and `freelist_count × page_size`.
  - IndexedDB: `navigator.storage.estimate().usage` when present, else null; free is 0 because the browser compacts.
- `compact(pages)` (SQLite only) runs `PRAGMA incremental_vacuum(pages)` when `auto_vacuum = INCREMENTAL` and returns `{ more }`. Otherwise it returns `{ more: false, pendingRestart: true }` (see below).

### Reclaiming disk (SQLite)

- A new database sets `PRAGMA auto_vacuum = INCREMENTAL` before its first migration. After a removal, the backend runs `compact` in slices (`b.yieldTurn()` between them) until the freelist is empty. The file shrinks without blocking.
- An existing database (`auto_vacuum = NONE`) cannot switch without a `VACUUM`, which blocks for seconds. A removal therefore records `storage.compactOnOpen`. The next time the store opens, after migrations and before it serves, it runs `PRAGMA auto_vacuum = INCREMENTAL; VACUUM;` once and clears the flag. The UI says "Terno finishes freeing this space the next time it opens". After that, removals shrink the file at once.
- Only an explicit removal sets the flag, so no launch is ever slowed for a user who didn't ask.

### Backend (`packages/backend/src/storage.ts`, handlers)

- `storage.report` reads `threads()` in `SliceSizer` slices with `yieldTurn` between them. It folds the rows into buckets × ages (cumulative: older than 30 days includes older than 90 days) and adds `footprint()`. The cost is O(threads). There are no reads until the tab opens, and nothing is cached or polled.
- `storage.remove({ buckets, olderThanDays ∈ STORAGE_AGES, jobId })`:
  - resolves candidates with the same slices (the predicate in TS);
  - removes them in `SliceSizer` slices through `store.storage.remove`, with `notifyChanged(touched)`, counts, and `bulkProgress`;
  - then compacts.

  It returns `{ threads, messages, bytes, compact: "done" | "onRestart" | "none" }`. One removal runs at a time; a second one gets `BUSY`.
- The RPC contract gets both methods (`timeoutMs: 300_000` for remove).

### UI: Settings → Storage (new tab, `HardDrive` icon, after Data)

1. **Usage.** A large figure ("1.2 GB") with "used by Terno on this Mac" ("…in this browser" on the web). Under it is a single 8 px rounded bar with one segment per bucket plus "Other", where Other is the footprint minus the buckets (search index, drafts, app data; shown only when positive). Each segment's color comes from category tokens (`bg-cat-*`). A legend list follows, one row per bucket: dot, name, "1,234 conversations", and the size right-aligned and tabular. While the report loads, the rows show skeletons with the same height, so nothing jumps. `aria` names the bar as an image with a text summary.
2. **Free up space.** A group with:
   - a row "Remove conversations older than" with a `Select` (1 month, 3 months, 6 months, 1 year, 2 years; default 1 year);
   - a checkbox row for each removable bucket, its hint showing "312 conversations · 84 MB" for the chosen age (Spam and Trash are checked by default, Inbox and Archive are not);
   - footer: "Starred conversations, ones you replied to and ones with a draft are kept. Removed mail stays on your mail server: Terno only deletes its copy on this Mac.";
   - a destructive-outline button "Remove 1,546 conversations (122 MB)…", disabled when nothing is selected or there is nothing to remove.

   The button opens a `ConfirmDialog` that names exactly what goes. While it runs, the button shows the `bulkProgress` percentage and the controls are disabled. When it is done, a snack says "Removed 1,546 conversations · freed about 122 MB" and the report reloads.
3. **Pending compaction** (desktop, old databases): a note row "About 300 MB is freed the next time Terno opens."
4. The web-only `StorageSection` (persistence, engine) moves from Data to the bottom of Storage.

- Sizes use `Intl.NumberFormat` units (`formatBytes` in `lib/format.ts`, in the app's locale). Every string is in `en` and `es`.
- Keyboard: every control is in the Tab order, with focus rings only on Tab (focus-visible). The checkbox rows use `<label for>`.

## Tests

- **core:** `storageBucket` precedence; `removable`; the report fold (cumulative ages).
- **store conformance (both adapters):**
  - `threads()` paging, buckets, bytes and kept reasons (starred, replied, draft reply, draft forward of a message in the thread, local, queued op);
  - `remove()` deletes only eligible threads, re-checks at commit (starred meanwhile → kept), leaves search, counts and folders consistent (`debug.verify`), and frees assets;
  - `footprint()` shape.
- **db:**
  - a new database is `auto_vacuum = INCREMENTAL` and `compact` shrinks `page_count`;
  - an old database with `storage.compactOnOpen` is vacuumed on open, and the flag is cleared.
- **backend:** `storage.report` totals; `storage.remove` progress, `changed` events, `BUSY`, and the compaction outcome.
- **e2e** (`apps/web/e2e/storage.spec.ts`):
  - open Settings → Storage; the usage and buckets are shown;
  - pick an age and buckets; the button's count matches the hints;
  - confirm; the snack appears, and the removed threads are gone from Spam;
  - axe in light and dark. Screenshots in light and dark, looked at.
- **perf:** `storage.perf.test.ts` (db and idb): a report over 50k threads with sliced reads, every slice under the budget; removing 10k threads in slices.

## Perf and resources

- Nothing runs until the tab opens. The report is one pass over threads in budgeted slices; no polling, and no cache kept after the tab closes.
- `remove` deletes in budgeted slices. Compaction is sliced (incremental) or deferred to the next open.
- The tab and the UI are lazy and stay out of the entry chunk (the settings dialog already is).

## Out of scope

- Deleting mail on the server (emptying Trash or Spam on the provider).
- Automatic retention (removing old mail on a schedule).
- Per-account breakdown (the report is global; possible later as a filter).

## Revisions after the Codex review

1. **Removed mail coming back.**
   - Ordinary sync only brings back mail that changed on the server: an IMAP move gives it a new UID, and a new Gmail message is added. That is intended and documented ("if you move it in another app, it downloads again").
   - The real race is a sync pass that fetched a message before it was removed and ingests it after. While a removal runs, and until every affected account finishes a pass that *started* after it, the backend keeps the removed provider ids (bounded, in memory) and the pass's `ingest` drops them.
2. **The server copy.** Threads of an account that never finished a sync (`lastSyncAt` null), or that needs a new sign-in, are kept: their local state may hold mail the server doesn't have yet. The copy says the mail server keeps its own copy, which holds for everything the store has a provider id for. Mail deleted on the server while offline is mail the user deleted, and the next sync would remove it anyway.
3. **Attachment bytes.**
   - `remove` expires the orphan grace of the assets it unpinned, and only those. Shared assets are still pinned, and draft Undo grace is untouched.
   - A new `storage.collect(now)` runs one `cleanupAssets` unit (eight chunks) for any account with an expired orphan. The backend loops it with turns between units, and compaction runs after that.
4. **Unsettled flag state.** A thread is also kept while any of its messages has a `message_flag_intents` row with `pending_count > 0` or `needs_snapshot = 1`, or an op in `queued`, `running` or `unknown`.
5. **Huge threads.**
   - Deletion is bounded by messages, not threads. `storage.remove({ threadIds, …, maxMessages })` re-checks every thread, deletes at most `maxMessages` of the eligible threads' messages (oldest first, so `last_date` and eligibility hold), and returns `remaining`. A 50k-message thread takes several units, and the slicer sizes them in messages.
   - Interruption is safe: what remains is still old and eligible, and the next run finishes it.
   - The report's per-thread aggregate is one indexed aggregate per thread, measured by the slicer.
6. **IndexedDB paging** uses the store's sorted thread-id scope (`c.scopes.threads`, `seekAfter`), as `scopeThreadIds` does. It doesn't scan or sort per call, and it counts with `count()`/`keysBy` without materializing rows.
7. **The IndexedDB boundary.** Removal and collection are `command()`s with strict durability (outbox, persistence, rollback, instant-index notify). A reopen test covers it.
8. **`VACUUM` on open** runs only on the desktop (Node driver), only after a removal asked for it, and only with free disk ≥ 1.2 × (database + WAL), checked with `statfs`.
   - It runs with `temp_store = FILE`, outside any transaction, after migrations. A failure is caught, the database opens as it was, and the outcome is recorded (`storage.compact` = `{ state: "failed" }`) so it's never retried in a loop.
   - OPFS SQLite never runs `VACUUM`. Its old databases report reusable free space.
   - New databases (both drivers) are `auto_vacuum = INCREMENTAL` from creation.
9. **Compaction:**
   - `PRAGMA incremental_vacuum(n)` through `exec` (stepped to completion on both drivers), in a loop until `freelist_count` stops falling;
   - then `settle()`, so the checkpoint truncates;
   - a test checks the physical file size after the checkpoint.
10. **Sizes are estimates of the mail** (the provider's size) and say so ("about"). The measured footprint is shown separately, as the headline. "Other" isn't derived by subtraction. The snack reports conversations removed, and the report reloads to show the measured footprint after.
11. **Engine switch.** The web engine switch is disabled while a removal runs (shared state). A switch that happens anyway (another tab) is harmless: every unit is atomic, and an interrupted removal is partial and resumable. The pending-compaction note shows for any SQLite engine with free pages.
