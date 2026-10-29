# 65 · An account's own folders

## Request

> also, when clicking on an account from a multiple accounts, it has to expand, to show its inside folders like custom folders created by gmail or by us, or its own spam/inbox/sent and other common folders, of course this needs to follow and have simple intuitive ux

Plan 64 shipped the layout and each account's standard folders. This is step two: the folders the account itself has.
- **Gmail:** the user's labels.
- **IMAP:** the folders on the server.

The user asked for both steps in full now ("since the app has not launched, it needs to be fully built from now").

## What exists

- **IMAP** (`packages/mail/src/imap.ts`):
  - `discoverRoles` runs one `LIST` and keeps only the role→path map, in memory.
  - `sync` walks inbox, sent, archive/all, junk and trash with `syncMailbox`. That routine is generic: it takes any path, keeps a UIDVALIDITY/UIDNEXT cursor per path and records `message_locations`.
  - A message's flags come from all its locations (`stateFromLocations`). A message that's only in a custom folder is "archived" (not in the inbox, not trash or spam).
- **Gmail** (`gmail-api.ts`):
  - Every message's `labelIds` are stored as `messages.gmail_labels` (JSON) on ingest and on every flag update (full sync, history, reconcile).
  - Nothing calls `/labels`, so user labels are only ids (`Label_12`) with no names.
- **Stores:** `recomputeThreads` (SQLite `packages/db/src/ingest.ts`, IndexedDB `packages/idb/src/mail.ts`) is the single place a thread's aggregates are folded from its messages, on every ingest, flag update, action and deletion.
- **Lists:**
  - `threads.list` takes `view`, `accountId`, `categoryId` and filters.
  - A category is a membership table joined to `threads` (`listSql` / `scopeFrom` in SQLite; a membership test on the walk in IndexedDB).
  - Selection scopes ("select all N") use the same parameters.
- **Plan 64:** the sidebar shows an open account's standard folders. With one account, the account lists none, since they'd be the top ones.

## Design

### What a folder is

```ts
// core
interface Folder {
  accountId: number;
  key: string; // IMAP: the mailbox path; Gmail: the label id
  name: string; // the leaf name shown ("Clients")
  path: string[]; // names from the top ("Work", "Clients") for nesting; IMAP by its delimiter, Gmail by "/"
}
```

- **Only folders that aren't standard ones are listed.**
  - **IMAP:** a mailbox that holds no role, is selectable (not `\Noselect` / `\NonExistent`), and isn't a Gmail-over-IMAP special (`\Flagged`, `\Important`).
  - **Gmail:** a label of `type: "user"` that isn't hidden from the label list (`labelListVisibility !== "labelHide"`).
  - Folders Terno creates are standard ones (Sent, Archive…), so they never show here.
  - "By us" in the request means the user's own folders. Terno categories stay a cross-account section (plan 02) and aren't folders.
- **Nesting** comes from the path.
  - A parent that isn't selectable (an IMAP `\Noselect` parent) is still shown, as a row that only groups its children; it's not a place to go.
  - A Gmail parent label is a label too.

### Sync

- **IMAP:**
  - The `LIST` that finds roles also yields the custom folders, so one command gives both. The list is handed to the store as `sink.setFolders(folders)` on every sync pass. Nothing is written when it hasn't changed (the store compares).
  - Each custom folder is synced with `syncMailbox`, like the role mailboxes, so its messages, locations and expunges are kept the same way. Moves between folders are seen as a location removed in one and added in another.
  - **Low resource:** before syncing a custom folder, `STATUS (UIDNEXT MESSAGES HIGHESTMODSEQ)` is asked. A folder whose three values match the cursor is skipped.
  - Without CONDSTORE (no `HIGHESTMODSEQ`), a folder is fully checked every fourth pass instead, plus on any UIDNEXT or MESSAGES change.
  - Role mailboxes keep their current behavior.
- **Gmail:**
  - `GET /labels` runs on a full sync, when a message arrives carrying a user label the store doesn't know, and at most every 15 minutes otherwise (renames, empty new labels). History doesn't report label changes.
  - Message membership is already in `gmail_labels`, so no extra message requests are made.
  - The web build uses the same Gmail provider, so it gets labels too.
- **What gets synced:** like every view, a folder shows the mail inside the sync window.

### Storage (both stores, the same rules)

- **`folders`** `(account_id, key, name, path_json, position)`, PK `(account_id, key)`. It's the list as the provider gave it, replaced per account by `setFolders`, and deleted with the account.
- **`thread_folders`** `(account_id, folder, thread_id, last_date, unread)`, PK `(thread_id, folder)`.
  - Indexes: `(account_id, folder, last_date DESC, thread_id DESC)` for pages, and a partial `(account_id, folder) WHERE unread = 1` for counts.
  - A thread is in a folder when one of its messages (not in trash or spam) carries the folder's key. `last_date` and `unread` are the thread's.
- **Membership** is folded in `recomputeThreads`, beside the other aggregates, from the thread's messages:
  - `gmail_labels` for Gmail;
  - `message_locations` (SQLite) or the provider store's locations (IndexedDB) for IMAP.
  - Only keys listed in `folders` count, so INBOX, system labels and role mailboxes never fill the table.
  - Accounts without folders skip the work: the set of accounts with folders is read once per call, like the facts context. The ingest perf gates hold.
- **`setFolders`:** for keys added, memberships are built from the account's messages (an indexed location lookup for IMAP, the account's labels for Gmail). For keys removed, memberships are deleted. A rename changes only the name.
- Location changes (IMAP moves, expunges) already lead to `updateFlags`. Thread recompute must run even when the flags are unchanged and only the locations moved. The conformance suite checks this.

### Reading

- **`threads.list`** and the selection scopes take `folder?: string`, which needs `accountId`.
  - SQLite pages walk `thread_folders` by its date index, then join `threads` (a folder of 30k threads pages without a sort).
  - IndexedDB walks its order with a membership test, the same shape as a category.
  - Quick filters apply as elsewhere.
  - The view under a folder is "all": no trash, no spam.
- **Counts** add `folderUnread: Record<"accountId:key", number>`: unread threads per folder, from the partial index (SQLite) or the memberships (IndexedDB). They're pushed with the other counts.
- **RPC:** `app.bootstrap` returns `folders`, and a `folders` event pushes the whole list when it changes. No new polling.

### Sidebar and navigation

- **Under an open account,** below its Inbox, Sent, Archive, Spam and Trash:
  - a hairline, then its folders, nested by indent (one step per level);
  - each with a folder icon, its name and an unread count when it has one.
- **With one account,** its row becomes a disclosure once it has folders, and it lists only those folders (its standard ones are the top ones).
- **Navigation:**
  - `navigate({ accountId, folder })` shows that folder.
  - The list title is the folder's name, with "· Personal" where the design shows it.
  - `listKey` and the app state carry `folder`.
  - A folder that disappears (deleted on the server) sends you to that account's Inbox, the same way a deleted category does.
- **Long lists:** an account with many folders scrolls in the sidebar like everything else. There's no second disclosure per parent in this step; Gmail shows its labels the same flat-nested way.
- **Search** from inside a folder searches everywhere, as it does from a category today. Searching inside a folder (`in:"Clients"`) is out of scope.
- **Drag and drop** onto folders, and moving to a folder, are out of scope. That's the next feature (an IMAP `MOVE` or a Gmail label change, with undo).

### Demo and e2e data

- The mock dataset gives two Gmail accounts some labels (one nested) and two IMAP accounts some folders.
- The seed writes `folders` and the messages' labels and locations. Dev and e2e show real trees, and e2e counts are real.

## Tests

- **Conformance** (`packages/store/src/conformance`, run against SQLite and IndexedDB):
  - `setFolders` adds, renames and removes.
  - Membership follows ingest, label changes, location moves with unchanged flags, trash and spam, deletion, and an account's removal.
  - Pages are in date order with the cursor, with and without a quick filter.
  - Selection scopes; `folderUnread`.
- **IMAP provider** (its test server):
  - Custom folders are listed (`\Noselect` parents included as groups, Gmail specials excluded) and synced.
  - A folder unchanged by `STATUS` is skipped; without CONDSTORE it's checked every fourth pass.
  - A move between folders is seen.
- **Gmail provider** (fetch stubbed):
  - `/labels` maps user labels, nested by "/", hidden ones left out.
  - It's asked on a full sync, on an unknown label, and at most every 15 minutes, never on every pass.
- **Perf:**
  - 50k threads with 20 folders: a folder page and the counts are within the list budgets in both stores.
  - Ingest with folders stays within the ingest budget.
  - Accounts without folders do no extra queries.
- **e2e:**
  - An open account shows its folders under its standard ones, nested, with unread counts.
  - A folder lists its threads, and reading one drops the count.
  - A folder that's removed sends you to the account's Inbox.
  - One account with folders becomes a disclosure.
  - Keyboard and axe in light and dark.
  - Lumen and Atelier baselines with folders.

## Out of scope

Moving or dragging to a folder, creating, renaming or deleting folders from Terno, `in:` search by folder, a per-parent disclosure, and syncing mail older than the sync window into a folder.

## Revisions after the Codex review

Codex made 12 points; they change the design as follows.

1. **IMAP refreshes its folder list on every pass.**
   - `LIST` runs every pass. The roles stay cached, but folders are read fresh.
   - **A new folder** is synced in the same pass.
   - **A folder that's gone**, at the end of the pass after every mailbox has been synced, loses its cursor entry, its `message_locations` (through the provider store, so membership follows in the same transaction) and its memberships. Then the touched messages are reconciled.
   - **A rename** is seen as a new path and a gone one. Because the new path syncs first, its messages are found by Message-ID and gain a location; they're never removed and fetched again.
2. **The STATUS skip compares UIDVALIDITY** along with UIDNEXT, MESSAGES and HIGHESTMODSEQ. A reset with otherwise identical values goes through `syncMailbox`. Tested.
3. **Membership is written in the same transaction as what decides it, never later.**
   - `refreshFolders(threadIds)` is its own function. It runs from `recomputeThreads`, which covers ingest, actions, trash and spam, read state and deletion.
   - It also runs from every location write in the provider store (`upsert`, `remove`, `resetMailbox`), in SQLite and IndexedDB, inside the same command.
   - And it runs from every write of `gmail_labels`: ingest and `updateFlags` in both stores, including updates that change only labels.
   - A failed pass therefore never leaves a location changed while its membership is stale, and actions that move messages (`execute`) are covered because they write locations through the same store. Conformance tests cover each path, including flags unchanged and only labels or locations moved.
4. **Membership doesn't depend on the folder list.**
   - Gmail membership is every user label id on a message (`Label_*`), whether or not `/labels` has been read yet. Messages that arrived before the first `/labels` are already in their folders, so nothing is backfilled.
   - The provider keeps the label ids it has seen in `/labels` (including hidden ones) in its cursor. A pass that meets a `Label_*` id it doesn't know asks `/labels` once (coalesced per pass), and it does the same after 15 minutes. Hidden labels are known but never listed, so they don't trigger requests again and again.
   - IMAP membership is the account's locations whose mailbox is a listed folder. A custom folder only gets locations once it's listed and synced, so nothing is backfilled there either.
5. **No account-wide rebuild remains** (see 4): `setFolders` only replaces the list, plus the cleanup of 1. Counts and the list are pushed through the existing events.
6. **Indexes:**
   - `(account_id, folder, thread_id)` for selection scopes, and `(account_id, folder, last_date DESC, thread_id DESC)` for pages.
   - A folder page starts from the membership index, filters included (no filter index pinned), and joins `threads`.
   - Query-plan tests cover pages, filtered pages and scopes.
7. **IndexedDB reads a folder from its memberships**, not from the global order:
   - Pages take the folder's members by index, sort them by date and page with the cursor. Sparse and empty folders never walk the mailbox.
   - Counts walk only the unread memberships (their own index).
   - Perf tests: an empty folder, a sparse one, a large one (30k), 20 overlapping labels, the last page, and repeated counts, in both stores.
8. **Search from a folder keeps the account and drops the folder.** It searches that account, like a search from its Inbox. Displayed results and "select all" use the same parameters, and clearing the search restores the folder and your place in it. Tested.
9. **Validation at the RPC boundary:**
   - `folder` requires `accountId`, can't be combined with `categoryId` or a review, and implies `view: "all"`. The list and bulk-action schemas both enforce this.
   - `keepIds` in both stores keeps a thread only while it's still in the folder.
   - Tests cover bulk actions on a folder and kept selections after a thread leaves the folder.
10. **Grouping-only parents:**
    - `Folder` gets `selectable: boolean`. A `\Noselect` parent is listed as `selectable: false`; a missing parent (a Gmail label "A/B" with no label "A") is drawn as a group row in the sidebar but isn't stored.
    - Group rows are never synced, never a place to go and never hold memberships. All three shapes are tested.
11. **Migration and seeds:**
    - SQLite gets migration 24.
    - IndexedDB gets its schema version, tables, indexes and the account cascade, and both tables load with the early set (the sidebar needs them at bootstrap).
    - `MockDataset` gets folders and per-message labels and locations, written by both seeders (SQLite `seed.ts`, IndexedDB `store.ts`) with account-id remapping.
    - Upgrade, reopen and seed-parity tests.
12. **Bounds and privacy:**
    - `/labels` goes through the bounded JSON path (a byte limit and validation of each field; at most 10,000 labels, names capped at 225 characters, Gmail's own limit).
    - IMAP `LIST` results are capped the same way.
    - Folder names never appear in errors or logs; a malformed catalog fails with a fixed message.
    - Tests check oversized and malformed catalogs, and a synthetic privacy marker in folder names never shows up in errors or diagnostics.

## What changed while building it

- **Gmail's label list is read outside `sync()`.** A new optional provider step, `folders(sink)`, runs after a pass that worked:
  - It reads `/labels` when it was never read this launch, after 15 quiet minutes, or when the pass met a user label it didn't have.
  - The catalog lives in memory, so it costs one read per account per launch.
  - The sync's own requests and its history checkpoint are exactly as before, so the Gmail suites that pin request traces and checkpoints stay as they were.
  - A provider failure in this step waits for the next pass; a sign-in to redo (`ProviderAuthError`) and a store failure don't.
- **`sink.setFolders` is optional on `SyncSink`.** The backend's sink always has it; bare test sinks don't need it.
- **SQLite membership is folded in `recomputeThreads`.** It reads a thread's user labels with its messages (`instr(gmail_labels, 'Label_')`, so other labels are never parsed), reads the locations of accounts that list folders and the existing memberships in one batch read each, and writes only the differences.
  - Location writes refresh set at a time.
  - Ingest throughput (paired against the same reference commit, same load): 0.895× vs 0.915× for plan 64; CPU 0.819× vs 0.825× (under 1%), with real membership work in this dataset.
  - The ingest gate already fails on `main` (≈0.91×, the storage work before this plan).
- **IndexedDB caches each folder's members by id and by date** (`ScopeIndex`), dropped when a membership changes or a membership's date moves. Pages binary-search their cursor; select all seeks.
- **Measured at 29.5k threads (SQLite) and 28.4k threads (IndexedDB):**
  - A folder of 8.9k threads pages in 0.38 ms p95 (SQLite) and at most 0.24 ms (IndexedDB).
  - Sparse, empty, deep and unread-filtered pages are all under 0.5 ms.
  - A select-all page of 2,000 ids takes 0.86 ms; a folder's count takes 2.1 ms (SQLite) and 0.96 ms (IndexedDB).
  - Sidebar counts are unchanged at the median (3.03 ms vs 3.04 ms).
- **UI:** opening and closing an account renders only that account's rows (`AccountEntry` is memoized, and where you are is passed only to the account you're in). The UI-perf gate checks frames, long frames and render counts.
- **Demo data:** folders are placed from a hash after generation, so the dataset's random stream and every other value stay as they were (the legacy fingerprint test drops only the new fields).
- **i18n:** the contract's folder rules use catalog messages (`errors.folder.*`, English and Spanish).

## Code review

**Round 1.** Codex found nine problems; each is fixed with a test that fails without the fix:
1. **A rename dropped cached mail older than the sync window.** The new path searched only inside the window, then the old path's locations went, so older messages became orphans. Now a folder seen for the first time is read whole once: mail already stored gains its location, and mail it doesn't know is fetched only inside the window. Tests: an IMAP rename after the window shrinks, and an old message copied into a new folder.
2. **A rename duplicated mail without a Message-ID.** The fingerprint matcher saw the old location still live and made a second copy. Now messages located in folders that vanished this pass can be re-attached; the vanished folders' locations go only after every folder has synced. Test: message ids, thread ids and categories survive a rename.
3. **The web store's backfill wasn't durable.** Schema 24 was recorded before the backfill ran. Now `foldersPending` goes in with the upgrade and comes off only when the memberships are saved; a failure (or a close) resumes on the next open. Test: a forced failure, then a reopen.
4. **Unlisting or hiding a populated label rebuilt its memberships synchronously** (≈364 ms at 50k threads). Now changing the list never rewrites Gmail memberships, and unlisting rewrites nothing at all. Every read goes through the list (an unlisted folder reads as empty), and only a newly listed IMAP folder's own threads are rewritten. Gate: unlisting and relisting a folder of 8.9k threads takes 0.03 ms.
5. **The IMAP listing was quadratic** (10k parents over 10k folders ≈ 2 s). The LIST is bounded first, and parents are found through one set of ancestors. Test: that case in under 500 ms; a parent always before its children.
6. **Kept threads in a filtered folder walked the whole folder** (9–11 ms). They're now looked up by key and tested for membership. Gate: 500 kept threads in 4.5 ms p95.
7. **A folder list's DOM was unbounded.** An open account mounts 250 of its own folders, and a quiet "N more folders" row reveals 250 more at a time (`sidebar.moreOwnFolders`, in English and Spanish). Test: 2,000 folders.
8. **Nesting relied on the listed order**, so "A", "AA", "A/Z" put Z under AA. The sidebar now builds a tree with each level in name order, and both providers sort one path level at a time. Tests: unit for the rows and for IMAP.
9. **A folder's quick filter was dropped after a reload for long paths** (stored keys were capped at 64 characters). The cap is now 1,100. Test: a round trip with a long IMAP path.

**Round 2.** Codex found eight more problems; each is fixed with a test that fails without the fix:
1. **A rename whose new path couldn't be opened deleted the old folder's mail.** The failure was skipped and the cleanup ran anyway. A pass where any folder failed to sync now leaves vanished folders' locations for the next pass. Test: the new path refused once (a forced `NO`), then a pass that works.
2. **A rename lost one of two messages that share a Message-ID and an envelope.** The second was stored under a collision key with the old path. Before a collision key is made, `resetCandidate` (with an optional `rfcMessageId`, in both stores) now looks among the vanished folders' messages for the envelope. Test: both ids survive.
3. **The sender-icon guard read the query from slot 5 of the list key,** which is the folder in a folder's key. It now reads the last element, so leaving Spam from a folder never lets spam senders' icons load. Test: unit.
4. **Kept threads in the web store could come from another account** with a folder of the same key. They're now tested against the folder's account. Test: conformance, in both stores.
5. **A UIDVALIDITY reset of a big custom folder refolded every thread at once.** A reset now drops the folder's memberships as they are (an IMAP folder's membership is its locations there), and SQLite deletes in slices of 1,000 rows with a yield between them. Gate: longest stall during a reset of 16k messages ≤ 16 ms.
6. **The category snackbar's "View" left a folder without its account,** and the list then failed validation. `setApp` now keeps the rule itself: any write that leaves a folder without its account, with a category or outside "all" leaves the folder. Test: unit.
7. **Every counts update re-rendered all of the open account's folder rows.** Each account's slice of the counts stays the same object while its numbers do, only the open account gets one, and its own folder rows are memoized. Gate: with 300 folders, an unchanged update renders no folder row; one folder's change renders that row, plus the five standard rows at most.
8. **A role mailbox in another case hid a folder** ("Sent" vs "sent"). Paths now compare exactly; only INBOX is case-insensitive. Test: unit.

**Round 3.** Codex found three more problems; each is fixed with a test that fails without the fix:
1. **A UIDVALIDITY reset that failed part-way deleted the folder's mail.** Its locations were already gone when the error was skipped, and reconciliation then removed what wasn't found again. A pass where any folder failed now keeps orphans (flags still reconcile); the next pass re-identifies them. Test: a forced `NO` on the search after the reset.
2. **The web upgrade's backfill ran as one command over the whole mailbox** (≈119 ms at 50k threads). It now runs in slices of 1,000 threads per command with a yield between, and `foldersPending` comes off only after the last slice. Test: 2,500 labeled threads take three or more slices, none larger than 1,000.
3. **A folder named `__proto__` broke the IMAP cursor:** its checkpoint landed on the object's prototype and was never saved. The cursor's mailbox map now has no prototype. Test: the checkpoint is saved, and the next quiet pass skips the folder.

**Round 4.** Codex found five more problems; each is fixed with a test that fails without the fix:
1. **SQLite counts scanned every unread membership** (≈115 ms with 50k unread threads in 20 labels). Migration 24 now keeps a `folder_unread` tally per folder, maintained by triggers on the memberships' own inserts, deletes and unread changes (cascades included), so counts read one row per folder. Tests: a 300-step random sequence (ingest, reads, trash, label moves, deletion, an account's removal) always matches a recount; gate: counts with 590k overlapping memberships take 3.5 ms p95.
2. **A failed reset could leave a ghost message forever:** one the server deleted was kept by the failed pass and never looked at again. The orphans a failed pass keeps now go into the IMAP cursor (`orphans`, bounded), and the next complete pass reconciles them. Test: after a failed reset, the deleted message goes and the other stays.
3. **Rename recovery was quadratic** (every lookup passed the whole candidate set). An `AdoptIndex` of the vanished folders' envelopes (`envelopes()` in both provider stores) is built once per pass and consumed as copies are found. Test: 25,000 twin pairs, each taken once, in linear time.
4. **Two folders whose 225-character names matched overwrote each other in the sidebar tree.** The second is now its own row. Test: unit.
5. **A label list that failed to store stopped retries for 15 minutes.** The cache now moves only after the list is stored. Test: a refused write is retried on the next pass.

**Round 5.** Codex found five more problems; each is fixed with a test that fails without the fix:
1. **An interrupted reset could still lose ID-less twins older than the window:** on the retry, the reset's candidates were gone. The candidates of a reset now go into the cursor (`resetPending`, per mailbox) and are merged back on a retry, until that mailbox syncs. Test: two ID-less twins survive a failed reset and the next pass.
2. **A message without a Message-ID moved to a folder that syncs first got a new identity**, losing its thread and categories (role mailboxes could do this too). Each pass now sweeps every mailbox for what the server expunged (and flags it changed) before any new mail is identified, so the moved message finds its old location gone. Quiet custom folders still skip both steps through STATUS. Test: an ID-less, categorized message moved from Z to A keeps its message, thread and category.
3. **Relisting a populated IMAP folder rebuilt its memberships in one transaction** (≈163 ms at 50k threads). Relisting now records a job (`folder_rebuilds`, in both stores). `folders.rebuild(limit)` runs a slice per call (the old rows first, then locations in UID order), each slice saved with its progress, and the backend drains jobs with yields after a list change and at start. Tests: a rebuild sliced two rows at a time that survives a reopen mid-way; gate: relisting a 16k-message folder takes 0.11 ms, rebuild slices 3 ms at the median.
4. **Recovery stayed quadratic for one big bucket of identical envelopes** (`shift()`). Buckets now keep a head offset. Test: 50,000 identical envelopes consumed in linear time.
5. **In the List layout, another folder of the same account didn't close a page over the list.** The page's "another list" check (and the search field's) now include the folder. Tests: unit (a folder-only change) and e2e.

**Round 6.** Codex found four more problems; each is fixed with a test that fails without the fix:
1. **A reset's candidates weren't durable before its locations went**, so a disconnect right after the reset lost them. The cursor is now saved with `resetPending` before any location is deleted. Test: the connection drops on the reset's search, the retry too; the next sync still finds both ID-less twins.
2. **The checkpoint could acknowledge flag changes nobody read**: it was taken at identification, after the sweep had read the flags. A mailbox we already had is now acknowledged as its sweep saw it (count and mod-sequence when the sweep began), and a failed sweep acknowledges nothing, so the next pass looks again. Test: a failed sweep, then a pass that reads the flag change it missed.
3. **The web store's rebuild slices rescanned and resorted the whole folder.** The order is now sorted once per job and each slice seeks into it. Gate: rebuild of 6.8k locations, every slice within a frame (7.1 ms at the longest).
4. **Parent groups drawn twice under different folders (A/X/Y, B/X/Z) shared a React key**, which could leave a stale row after a change. Every row now has an identity from its full path. Test: unit.

**Round 7.** (The first attempt hit "model at capacity" and was rerun.) Codex found four more problems; each is fixed with a test that fails without the fix:
1. **A UIDVALIDITY reset lost a Message-ID twin older than the window:** reset matching only knew ID-less mail.
2. **Reset recovery was quadratic** (the whole candidate set per message). Resets now build the same consumable envelope index as renames (`AdoptIndex`, candidates oldest first), for ID-less mail and Message-ID twins alike. Test: both twins survive a reset; the index's linear tests cover the scale.
3. **The web store kept a cancelled rebuild's cached order**, so a relisting reused a stale snapshot. The cache is dropped whenever a job is cancelled or replaced. Test: conformance (unlist mid-rebuild, a location added, relist).
4. **The folder you're in could bypass the 250-row cap** if a rename sorted it last. Past the batches shown, it's now drawn alone after them. Test: e2e, 2,000 folders with the active one renamed last, 251 rows.

**Round 8.** Codex found three more problems; each is fixed with a test that fails without the fix:
1. **Two identical ID-less messages moved between folders lost the second's identity.** The sweep had unlocated them, and only the first was recognised. What a sweep unlocates is now an envelope index too, consulted wherever a moved, renamed or reset message could be recognised (`takeAny`). Tests: twins moved into an existing folder, and into a new folder with mail older than the window, keep their messages, threads and category.
2. **A disconnect between the sweep and identification left a ghost message**, since the sweep had already deleted its location. A sweep now writes what it unlocates into the cursor (`unlocated`) before deleting anything. The next pass reconciles those messages (and can still recognise them), and the journal is cleared once reconciled. Test: the identification fetch drops; the next sync removes the expunged message.
3. **The web store's rebuild deletion phase read every remaining membership per slice.** It now reads the index only up to the slice's limit. The backend's slice is 250 rows (within a frame in IndexedDB, where each slice is a commit). Gate (now seeded with rows a past listing left): 6.8k locations in 44 slices, 12.1 ms at the longest.

**Round 9.** Codex found six more problems; each is fixed with a test that fails without the fix. The first three share one structural fix:
- Every step that unlocates mail (a sweep, a reset, a vanished folder's cleanup) now writes the messages into the cursor's journal (`unlocated`) before deleting any location, and the journal is cleared only after reconciliation.
- Orphans are deleted only in a **full** pass, one that read every folder (no STATUS skip) and failed nowhere. Any other pass keeps them and makes the next pass full (`fullCheck`), so a deletion waits at most one pass.

1. **A message moved into a folder STATUS had just skipped was deleted, then recreated.** Test: the move between the two STATUS calls keeps the message, its thread and its category.
2. **A crash after a vanished folder's cleanup left ghosts.** Covered by the journal.
3. **A reset that finished, then another that failed, lost what the first had found deleted.** Covered by the journal. Test: the deleted message goes on later passes and the others stay.
4. **The web upgrade's slices counted threads, not memberships** (20 overlapping labels: 32 ms per slice). A command now takes batches of 50 threads until 8 ms have passed, then yields. Test: batches of at most 50 threads, over many commands.
5. **Renaming a label dropped keyboard focus,** because rows were keyed by their display path. A folder row is now keyed by its provider key. Test: e2e, a focused label renamed keeps the focus.
6. **Shortened parent names could merge two IMAP hierarchies.** IMAP names are now whole: a path is at most 1,000 characters, and Gmail's own limit stays 225. Test: unit, two 226-character parents with children.

The existing deletion test now shows the full-pass rule: a deleted folder's message goes on the pass after (the first pass skipped a quiet folder).

**Round 10.** Codex found four more problems; each is fixed with a test that fails without the fix:
1. **A message moved out of a folder that was then deleted, all between syncs, lost its identity:** the destination never saw the vanished folder's index. The index is now built before any identification and given to every destination (role mailboxes and known folders too). Test: an ID-less message moved Z→A, Z deleted, keeps its message, thread and category.
2. **A full-pass retry forgot twin candidates** a partial pass had kept as orphans (the journal was cleared). Kept orphans now feed the recovery index along with the journal. Test: identical ID-less twins moved into a folder STATUS had just skipped keep both identities.
3. **Location recovery refolded the whole thread per location** (quadratic in a long conversation). Location writes now change membership incrementally in both stores: a new location adds its thread's row, and one that goes takes it only if no other message of the thread is still there. Gate: 5,000 locations of one conversation back one by one in 403 ms in all.
4. **A focused folder renamed past the 250 rows shown dropped focus.** The folder with the keyboard's focus is now drawn like the active one. Test: e2e, 300 folders.

**Round 11.** Codex found six more problems; each is fixed with a test that fails without the fix:
1. **A reset folder lost the identity of a twin moved out of it to another folder between syncs.** The reset's old locations went before the destination looked for them. The sweep now journals what a reset drops, and one recovery index (vanished folders, the journal, kept orphans, pending resets) serves every mailbox in the pass. Test: two ID-less twins, one moved to B and its folder's UIDVALIDITY reset, keep both ids and threads.
2. **An expunge of a long conversation checked membership per message.** `removeMany(messageIds, mailbox)` in both stores drops a slice of locations at a time and checks each thread once a slice, yielding between slices. Gate: 5,000 messages of one conversation expunged at once, longest stall within a frame (5.8 ms).
3. **Rebuild phase 1 refolded each batch's whole threads** (a 5,000-message conversation re-read per slice). Phase 0 already took the folder's old rows, so phase 1 now only inserts the batch's threads (`INSERT OR IGNORE … RETURNING` in SQLite, a membership check in IndexedDB). Gate: that conversation's folder relisted, longest slice ≤ 4 ms (0.4 ms; 17 ms before).
4. **A deep catalog bypassed the sidebar's bound:** 10,000 paths of 100 levels drew a million rows. At most eight levels are drawn (deeper names join the last one, with "/"), and a closed account builds no rows at all. Test: the depth cap, and 10,000 × 100 levels within budget.
5. **"Unread" in a big, all-read folder walked the whole folder.** SQLite pages through a partial index of unread memberships (`thread_folders_unread_date`); IndexedDB walks the folder's unread bucket. Gates at 50,000 threads, everything read: SQLite ≤ 1 ms (0.03; 4.7 before), IndexedDB ≤ 0.25 ms (0.00; 0.8 before).
6. **Revealing more folders by keyboard lost the position.** "N more folders" now focuses the first folder it reveals. Test: e2e, Enter on it focuses folder 501.

Also: the SQLite folder gates now run with the checkpoint worker, as desktop does. Its stalls of about 14 ms came from in-thread WAL autocheckpoints, which desktop never runs on the writer's thread; with the worker the longest rebuild slice is 1.3 ms.

**Round 12.** Codex found four more problems; each is fixed with a test that fails without the fix:
1. **A folder reset after its sweep, before it was read, lost an ID-less twin's identity.** The reset's messages weren't in the recovery index already built. They're added to it now, before identification. Test: two Message-ID twins older than the window, the folder's UIDVALIDITY reset between its sweep and its read, keep both ids and threads.
2. **An IndexedDB rebuild could bring back a membership whose location had gone.** Phase 1 reads the folder's UID order once per job; a location removed between slices was still inserted. Each location is now checked before its insert. Test (conformance, both stores): a location removed mid-rebuild.
3. **Building the recovery index stalled the event loop:** 50,000 candidates sorted and indexed in one go (about 25 ms). The index is now built a slice of 1,000 at a time (envelopes read per slice), with a yield between slices, and every bucket stays oldest first; a candidate added later is put in its place. Tests: the longest stall across 50,000 candidates under 10 ms (25 ms in one slice), and order with late additions.
4. **IndexedDB re-sorted a folder's unread members on every Unread page.** The order is now kept across reads, and a few changes (read, unread, newer mail) are placed by binary search; more than 64 rebuild it on the next read. Tests: exact order through every kind of change (conformance), and in a folder that's all unread, the worst page after the first ≤ 0.5 ms (0.23; 4.9 before).

**Round 13.** Codex found three more problems; each is fixed with a test that fails without the fix (or a gate that fails before it):
1. **A reset could re-add an identity already claimed this pass:** with the first of two ID-less twins moved out of a folder that's then reset, the folder's own read listed both again, and its remaining twin took the moved one's identity; the other was deleted in reconcile. The recovery index now remembers what was taken or found by its own key, and never takes them as candidates again. Test: that move and reset keep both ids, threads and categories.
2. **The SQLite upgrade wrote every Gmail membership in the migration's one transaction** (50,000 conversations with 20 labels each: about a million rows, 3.6 s). The migration now writes a durable job (`folder_backfill`, a thread id to resume after) that the folder runner drains a slice of `limit / 10` threads at a time, beside any memberships a sync wrote meanwhile. The runner now lets the WAL checkpoint catch up between slices (`store.settle()`, as the other bulk writers do). Gate (`folders-migration.perf.test.ts`): open and migrate in 19 ms, every backfill slice within a frame (p50 3.6 ms, worst 10.7 ms), every membership there at the end.
3. **Late candidates made the index quadratic again:** each older addition scanned back and spliced the bucket. They now wait per bucket and are merged once a slice (a sort and a linear merge). Test: 25,000 older candidates added to a bucket of 25,000 in under 200 ms, longest stall under 10 ms, oldest first.

**Round 14.** Codex found four more problems; each is fixed with a test or gate that fails without the fix:
1. **A backfill slice bounded threads, not their messages:** one conversation of 50,000 messages with 20 labels was a million rows in one slice. The backfill now walks messages by id (`after_message_id`), `limit / 5` messages a slice, each adding its own labels to its thread (a label is a membership if any message carries it). Gate: the v24 upgrade with a 50,000-message conversation, worst slice 8.8 ms (385 ms before).
2. **Opening an account built its whole tree at once** (10,000 folders a hundred levels deep: about 60 ms in the renderer), and an account once opened rebuilt on every change while closed. `useFolderRows` builds only while the account is open: the first step (4 ms) runs before the paint, so a usual catalog is there at once, and a huge one goes on a task at a time, its last rows shown meanwhile; `folderRowSteps` yields every 256 folders and every 1,024 rows. Tests: no step over 8 ms on that catalog; a closed account's rows don't change with the folders, and reopened they do; a huge catalog takes several tasks.
3. **A rename rewrote the whole catalog.** Both stores now diff by key: a new folder goes after the others, a changed one is updated in place, a gone one is deleted, and a list in another order is no change (the order is the sidebar's to draw). Gates, 10,000 folders 20 levels deep, one renamed: SQLite 20 ms (60 before; within the backend's two-frame stall budget, as reading and comparing 5 MB of paths is most of it), IndexedDB 8 ms (194 before). Conformance: reorder, rename, add and remove.
4. **Late candidates still merged whole buckets** (200,000 waiting and 200,000 more: about a second, 20 ms stalls). Each add is now its own sorted run, and a take is the oldest of the runs' heads, so nothing waiting is copied or moved; the ids are sorted as a typed array, without a `Set`. Test: that case in under a second in all, longest stall under 10 ms, every candidate taken once and oldest first.

**Round 15.** Codex found three more problems; each is fixed with a test that fails without the fix:
1. **A journal cut at its limit left messages with no place and no record:** 150,000 expunged while another folder was skipped kept 100,000 orphans; the rest, their journal cleared, were never reconciled. A cut now marks the cursor (`overflow`, and `fullCheck`), and the next pass that reads every folder looks for every message of the account with no location, 5,000 ids at a time (`ImapLocationStore.unlocated`, a window of keys in both stores), and reconciles them. The limits stay (the cursor is bounded). Tests: the journals at a limit of 2, five expunged while a folder is skipped, and the next full pass leaves no message without a place (three before); conformance for `unlocated`.
2. **The web upgrade's batches were bounded by threads, not messages:** `refreshFolders` read a 50,000-message conversation whole. It now goes by message, as SQLite's does: the labelled messages' ids once, then batches of 50 messages adding their labels to their threads. Test: that conversation upgrades in batches of at most 50 messages, each a small part of a frame.
3. **The /labels limit refused a catalog Gmail allows:** 7,000 CJK names of 225 characters are about 5 MB. The limit is now derived from the catalog bounds (10,100 labels of 225 characters at six bytes each as JSON, plus 512 for the rest: about 18 MB). Test: 10,000 CJK names, raw and escaped, are read whole; an answer over the limit is still refused unread.

Also: the stall timings these rounds added to unit tests (the recovery index, the sidebar's steps) failed on a loaded machine; they're now in the perf project (`adopt.perf.test.ts`, `account-folders.perf.test.ts`), which runs alone, with the correctness assertions left in the unit tests.

**Round 16.** Codex found two more problems; each is fixed with a test that fails without the fix:
1. **A cut journal was scanned only after identification:** ID-less twins moved past the limit while their destination was skipped were new messages in it, and the scan then deleted their originals. The scan for messages with no location now runs before any mail is identified, and what it finds goes into the recovery index (and, in a full pass, to reconcile). Test: five ID-less twins moved into a skipped folder with the journals at a limit of 2 keep their ids, threads and category.
2. **A big level of the sidebar's tree was one sort:** 10,000 names of 225 characters sharing a long prefix took 30 to 85 ms. A level of more than 64 is now merge-sorted in steps of a thousand comparisons. Gates: that catalog, no step over 8 ms (35 before); a unit test holds the order equal to a plain sort's.

**Round 17.** Codex found two more problems; each is fixed with a test or gate that fails without the fix:
1. **The providers sorted their catalogs on the backend's loop** (10,000 labels of 225 characters sharing a prefix: 50 ms, every pass for IMAP). The sidebar draws by name, in steps, so the providers no longer sort: a list is in the server's order (`paths.ts` is gone), and a long name is never upper-cased only to be compared with INBOX. Gate (`packages/mail/src/folders.perf.test.ts`): either catalog in under 8 ms (49 before); the order tests now hold the server's order.
2. **The web upgrade's backfill published nothing:** a folder opened while it ran stayed partial until something else refreshed. The backfill now goes through `folders.rebuild`, a batch of 50 labelled messages a slice once no folder job is left, returning the threads it touched, so the backend's runner sends `changed` and the counts as it goes; the mark comes off when the last batch is saved. Tests: the backend on a legacy web mailbox publishes every backfilled thread and lists and counts them; the store's upgrade tests drive `rebuild` as the runner does.

**Round 18.** Codex found two more problems; each is fixed with a test that fails without the fix:
1. **An ID-less message moved after its folder's sweep, before its destination was read, became a new message:** its stored twin was still placed in the old folder, so it looked like a copy, and the next pass deleted the original (thread and categories with it). Such a message is now held back (`Ambiguous`) until every folder is read; then one lock and one search per source mailbox tell it apart: if the stored message's places are all gone from the server, it moved, keeping its identity; otherwise it's a copy. A source mailbox no longer listed holds nothing; one that can't be read fails the pass. Its folder's UIDNEXT isn't acknowledged past a held-back message until it's told apart, so a pass that stops first reads it again. Test: a lone ID-less message moved from Z to A on A's second lock keeps its id, thread and category (the existing test that keeps ID-less copies in different folders apart still holds).
2. **An aborted web backfill batch was skipped for good:** the position moved before the transaction committed. It now moves after the command resolves, so a rolled-back batch is done again. Test: the second batch's membership write fails; a retry in the same store and a reopen both show all three memberships (two before).

**Round 19.** Codex found three more problems in round 18's telling apart; each is fixed with a test that fails without the fix:
1. **An ID-less twin appended to the same folder took the first one's place:** only places in other folders were looked at, so none meant "moved", and the new UID overwrote the old. Every place of a candidate counts now, another UID in the same folder too. Test: two identical ID-less messages appended one after the other are two messages, the first keeping its own UID.
2. **A held-back message older than the window was skipped before it was told apart** (a folder read whole only re-identifies old mail), and its original was deleted later. It's held back like any other; only a copy of it is left unfetched. Test: an old ID-less message moved into a folder seen for the first time, after its folder's sweep, keeps its identity.
3. **Only the twin under the plain key was a candidate:** one under a suffixed key that moved late looked like a copy of the other. The candidates are now every stored ID-less message with the envelope, under any key (`ImapLocationStore.twins`: SQLite by `messages_date`, IndexedDB by the sender's bucket, at most 50), and the oldest one with no place left on the server is the one that moved. Tests: the suffixed twin moved late keeps its id, thread and category; conformance for `twins`.

**Round 20.** Codex found three more problems in telling ID-less twins apart; each is fixed with a test or gate that fails without the fix:
1. **With the plain-key twin deleted, a surviving twin moved late became a new message:** the twin lookup ran only when a row under the plain key existed. Now any ID-less message not found otherwise looks for twins under any key, and with some it's held back and told apart like the rest, before the window decides anything. Tests: the plain-key twin deleted, the other moved late into a new folder, inside and outside the window, keeps its id, thread and category.
2. **The candidates were cut at 50.** They're now every twin, read once a pass in pages of 500 and shared by every message held back with that envelope; telling them apart takes each envelope's twins with no place left in order, so it stays linear. Test: of 55 stored twins, the last moved late keeps its identity.
3. **The lookup scanned a date's (or a sender's) every message.** A partial index of exactly the envelope (`messages_twins` on account, sender, date, size and subject for ID-less messages; an IndexedDB `twins` bucket) finds only the twins. Gates (`twins.perf.test.ts`, both stores): 250 lookups among 50,000 ID-less messages of one sender, date and size, SQLite 2.6 ms (1,529 before), IndexedDB 0.2 ms.

**Round 21.** Codex found three more problems in round 20's code; each is fixed with a test or gate that fails without the fix:
1. **Two held-back copies in two folders could be one message:** held back with no plain-key row, both kept the plain key, and the store merged them. A message held back that way now gets a key of its own place, as a copy found next to a plain-key row already did. Test: with the plain-key twin gone, identical copies appended to two folders are two messages (one before).
2. **Gathering the candidates copied each shared list once per held-back message** (5,000 by 5,000: 25 million entries). `distinctCandidates` visits each envelope's list once. Gate: that case in under 10 ms (665 before).
3. **IndexedDB paged twins by scanning and sorting the whole bucket each page.** The bucket's ids are sorted once and kept while it's unchanged, each page a binary-search seek; a page naming a row gone since then sorts again. Gates (both stores): 50,000 twins of one envelope paged 500 at a time, SQLite 12 ms, IndexedDB 2 ms (212 before).

**Round 22.** Codex found one medium and two low problems; each is fixed with a test that fails without the fix:
1. **A move told apart wrote its new place after removing the old ones:** a stop in between left the message placeless and unrecorded, and if it was then deleted where it went, nothing ever reconciled it. The new place is written first now, then the old ones go. Test: writing the new place fails once and the message is deleted there before the retry; no message is left without a place (one before).
2. **A focused folder the server took away left focus on the document.** The sidebar remembers the focused folder and its position; when a list change takes it away and focus fell to the document, the folder now in its place takes it, or the account's row when none is left (focus that left on purpose, told apart a frame later, is never pulled back). Test: e2e, the focused folder removed, then all of them.
3. **Unread tallies kept zero rows forever,** and had no cascade from the account. A tally that reaches zero is deleted by the decrementing triggers, and `folder_unread` and `folder_rebuilds` cascade from their account. Tests: the tally suite now requires exactly the folders with unread mail (zero rows fail it); 200 labels churned through leave none, and removing the account leaves none.

**Round 23.** Codex found one high and one low problem; each is fixed with a test that fails without the fix:
1. **A folder whose read failed part-way, with a message held back in it, was acknowledged past what it read:** telling the held-back message apart moved the folder's UIDNEXT on, so the messages after it were never fetched. A folder's held-back messages are handed over only once its read completes; one that fails keeps its old cursor and is read again. Test: A's FETCH fails after the held-back copy; the next passes import the message after it (none before) and the copy.
2. **With one account, its last own folder taken away while focused left focus on the document:** the whole group goes with it, so the group's own recovery never ran. The account's entry notes focus inside its folders and hands it to the account's row when the group goes. Test: e2e, one account, its folders removed while one is focused.

**Round 24.** Codex found three medium problems; each is fixed with a test that fails without the fix:
1. **A folder that became a `\Noselect` parent kept its mail forever:** it wasn't read, yet counted as listed, so its locations never went. Only listed, existing, selectable mailboxes are places mail can be now (for vanished folders and for telling held-back messages apart); a `\Noselect` one is still drawn as a group. Test: a folder deleted while it has children loses its mail, its child's stays, and it's listed as a group.
2. **Telling late moves apart removed their old places one at a time,** each one looking at the conversation again. The old places are gathered per mailbox and go through `removeMany` (sliced, with yields: its gate is round 11's) once the new places are written. Test: 30 twins moved late, no single removal in the pass, identities kept.
3. **A folder holding back more messages than an argument list takes threw** (`Math.min(...)`, `push(...)` with 150,000). Both are loops now (`heldUidnext`). Test: 500,000 held back.

**Round 25.** Codex found one high problem; it's fixed with a test that fails without the fix:
1. **Of two messages sharing a Message-ID and envelope, moving the second merged it into the first:** its destination found the first under the plain key and attached it (it had no place there), and the moved one, unlocated, was deleted. When the plain-key message is still placed elsewhere and the recovery index holds a twin with that Message-ID and envelope that lost its place, the twin is the one that moved. Test: the second of two such messages in Z moved to A; both keep their ids, threads and places (one was lost before).

**Round 26.** Codex found one high and one medium problem; each is fixed with a test or gate that fails without the fix:
1. **Round 25's case with the move after the sweep still merged Message-ID twins:** neither was in the recovery index, so the destination took the plain-key one. A message whose Message-ID has twins (the same envelope stored more than once), with the plain-key one placed elsewhere and not here, is now held back like ID-less twins and told apart once every folder is read; as a copy it's the same message in one more folder (`attachTo`). `twins` looks a Message-ID's up by `messages_rfc` / the `rfc` bucket. Tests: the second of two such messages moved after the sweeps keeps its id and places; conformance for the Message-ID lookup.
2. **"Waiting" walked a folder older than its window whole.** SQLite bounds the membership index's date range by the cutoff, and IndexedDB stops its date walk there. Gates: a folder of 8,900 threads all older than the window, SQLite 0.03 ms (3.1 before), IndexedDB 0.00 ms (1.1 before).

**Round 27.** Codex found two high and one medium problem in round 26's Message-ID twins; each is fixed with a test or gate that fails without the fix:
1. **Two copies held back in one folder both took the plain-key message's place there,** the second overwriting the first's UID. A copy gains the stored message's place only if it has none in that folder yet (counting ones given in the same pass); any other copy is a message of its own, under a key of its place. Test: two copies of a Message-ID with twins appended to A are both tracked.
2. **A twin moved late into the folder already holding the plain-key one wasn't held back** (only folders without it were), so it became a new message and its original was deleted. It's held back there too. Test: the plain-key twin in A, the other moved from Z into A after the sweeps; both keep their ids and places.
3. **A Message-ID's twins were found by scanning everything carrying it** (a reused one: 50,000). `messages_rfc` now indexes the Message-ID with the envelope (the old index was its prefix; rebuilding it is most of the v24 upgrade now, 191 ms at 50,000 conversations, within its 1,000 ms gate); IndexedDB splits a Message-ID's bucket by envelope once, while it's unchanged, and each page seeks. Gates: 250 lookups with a reused Message-ID, SQLite 2.3 ms (1,483 before), IndexedDB 0.25 ms (735); 50,000 such twins paged, IndexedDB 1.9 ms (363).

**Round 28.** Codex found two high and one medium problem; each is fixed with a test that fails without the fix:
1. **A twin moved late and another copy arriving beside it shared one place:** the move's place wasn't counted as given, so the copy took the same message's place too and its UID overwrote the move's. Every place given in the pass is counted. Test: the plain-key twin moved into A after the sweeps while another copy arrives there; both A UIDs are tracked, identities kept.
2. **A Message-ID twin whose plain-key one was deleted lost its identity when it moved:** the recovery by envelope and the twin lookup ran only for ID-less mail when no plain-key row existed. Both run with the Message-ID now. Tests: the survivor moved between passes, and moved into a new folder outside the window, keeps its id, thread and category.
3. **The IndexedDB twin cache was kept while its bucket's size held,** so one out and another in left it stale. It's kept while the bucket's revision holds: any write, insert or delete of a message in it moves the revision on. Test (conformance, both stores): one out, another in, for Message-ID and ID-less twins.

**Round 29.** Codex found one medium problem and reported nothing else; it's fixed with a test that fails without the fix:
1. **A copy of a Message-ID twin whose plain-key one was deleted became a second message** (or, older than the window in a new folder, wasn't shown at all): held back with no plain-key row, it had no stored message to gain the place. A Message-ID's copy is the same message in one more folder: the plain-key one if there is one, else the first of its twins with no place in that folder, gains it (once a folder). Tests: the survivor copied into a known folder, and into a new one outside the window, is one message in both.

**Round 30.** Codex found one medium problem; it's fixed with a gate that fails without the fix:
1. **Telling 5,000 held-back copies apart was quadratic** (each searched 5,000 twins from the start: about a second, the event loop held). What each held-back message is, is now planned by a pure function (`planTellApart`) in one linear pass, a cursor per envelope and folder for the next twin with no place there; the plan is then written with a yield every 500 writes. Gate: 5,000 copies of a Message-ID with 5,000 placed twins planned in under 20 ms (589 when each copy searched from the start); the IMAP suite holds the behaviour.

**Round 31.** Codex found one medium problem and reported nothing else; it's fixed with a gate:
1. **Planning what held-back messages are still ran in one go** (150,000 copies: about 80 ms). `planSteps` yields every thousand messages or candidates, and the backend drives it 4 ms a turn before the sliced writes. Gate: 150,000 copies, 99% of steps under 2 ms and none over a frame (a step now and then is a collection, or the given-places set growing past a power of two).

**Round 32.** Codex found two medium problems; each is fixed with a test or gate that fails without the fix:
1. **Getting ready to tell held-back messages apart still held the loop** (their candidates, places and mailboxes: about 50 ms for 150,000, a resolved await giving no turn). `gatherPlaces` reads 500 places at a time and gives the loop a turn every 4 ms of work. Gate: 150,000 held-back messages sharing 150,000 twins, longest stall under a frame (39 ms without the turns).
2. **The IndexedDB twin cache's revisions kept a key for every message ever changed.** Only buckets looked up are followed now, at most 10,000; past that all are let go at once with a new generation in every revision, so no kept order is ever taken as current. Test: 2,000 messages in and out leave one bucket followed (2,000 before), 12,000 lookups at most 10,000, and a bucket changed after being let go reads exact.

**Round 33.** Codex found one medium problem and reported nothing else; it's fixed with a gate that fails without the fix:
1. **Looking up the copies just written held the loop** (50,000 reads behind resolved promises: 78 ms). `storedIds` looks them up giving the loop a turn every 4 ms, for held-back copies and a folder's fresh mail alike; the writes of a told-apart plan use the same breather. Gate: 50,000 copies looked up again, longest stall under a frame (65 ms without the turns).

**Round 34.** Codex found one high and one medium problem; each is fixed with a test or gate that fails without the fix:
1. **The pass's twin groups went stale once new mail was written:** a Message-ID duplicate written in one folder and moved on before the next was read wasn't among the groups kept, so the next folder attached it to the original, and the duplicate was deleted later. Each fresh message's twin key is kept with it, and once written it joins its envelope's kept group (shared by any message held back with it). Test: a duplicate written in A and moved to B as B is read stays its own message, placed in B.
2. **Expunging a long conversation was still quadratic:** each slice's check of the thread's membership read its removed part again (150,000 messages: 3.5 s, 52 ms stalls). The locations go a slice at a time first, then each thread's membership is decided once, a page of 1,000 of its messages a turn from where the last ended (SQLite by `messages_thread`, IndexedDB 2,000 keys a read). Gate (`expunge.perf.test.ts`, load-aware): that conversation expunged in 0.7 s, the longest stall 3 to 8 ms.
