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
