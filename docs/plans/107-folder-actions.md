# Plan 107: creating folders, and a folder's right-click menu

- **Status:** planned.
- **Builds on:** plan 106 (the account menu, `data-context-menu` + Shift+F10 on sidebar rows), plans 67/68 (an account's standard and own folders).
- **Request (verbatim):** "we also need to , on hover, show a icon on the far right , when the account is expanded,to add a folder, and laso each folder should have the ability to create subfolders so they'll need that hover too. folders right click menu should have: - export mailbox - mark as favorite (moves it sticky on top below the "Starred") - delete - rename maybe not on that order but those should be there"
- **Decisions asked (2026-11-01):**
  - **Export:** an `.mbox` rebuilt from the local copy. It's instant and offline; attachments never downloaded aren't in it.
  - **Delete:** deletes the folder and its mail, after a clear confirmation (on IMAP the server deletes the messages; on Gmail the mail stays).
  - **Favorites:** a favorite shows below Starred *and* stays under its account.

## 1. What exists

- **Folders (plan 68):** `Folder { accountId, key, path[], selectable }`.
  - **IMAP:** the key is the mailbox path. The path is split on the mailbox's own delimiter, and `INBOX.` is dropped. Folders come from the `LIST` of every sync pass (`customFolders`, `sink.setFolders`).
  - **Gmail:** the key is the label id (`Label_…`), and the path is the name split on "/". Labels are read from `/labels` (`readFolders` / `labelFolders`).
  - **Stores:** `folders.list / replace / rebuild` in both SQLite (`packages/db/src/folders.ts`) and IndexedDB (`packages/idb/src/folders.ts`). Membership (`thread_folders`) is derived: Gmail from `messages.gmail_labels`, IMAP from `message_locations.mailbox` matching a listed key.
  - **IMAP's sync cursor** (`accounts.provider_config.cursor`) is keyed by path: `mailboxes`, `resetPending`, `previewed`, `backfill.below`. A path the `LIST` no longer has is "vanished": its messages are looked for again, and their locations are dropped after a full pass. A rename therefore reads as delete + new folder: the new path is synced from scratch, and messages are re-identified.
- **No folder is ever changed:** no RPC or provider method creates, renames or deletes one. IMAP only ever creates role mailboxes (`ensureMailbox`); `MailProvider.execute` handles message ops only.
- **Direct provider calls from an RPC** follow `repairSentCopy` (`core.ts`): `lifetime` → `accountWrite` → `await this.provider(id)` → `assertCurrent`. A sync runs per account in `syncing` (one at a time).
- **Sidebar** (`sidebar.tsx`):
  - `AccountEntry` → `AccountMenu` (plan 106) → the account row. `AccountFolders` draws the standard rows (`nav-folder-<id>-<view>`), the Gmail tabs, and the own folders (`OwnFolderRow`, `nav-own-<id>-<key>`, inset by depth). Non-selectable groups are a `div` (`nav-own-group`).
  - `useFolderRows` builds `FolderRow { id, key, name, depth, selectable }` from paths; parents aren't kept.
  - Hover reveal elsewhere: the category section's "+" (`opacity-0 group-hover/section:opacity-100 focus-reveal:opacity-100`); controls over a row: `ReviewBadge`, `SignInMarker` with `reserveEnd`.
- **Settings:** `AppSettings` through `settings.update` (zod `settingsPatch`), persisted in `store.settings`.
- **Files:** a Blob and `<a download>`. The web downloads it; the desktop's main window shows Electron's save dialog (attachments do this today).
- **What a message keeps:** headers (`rfc_message_id`, `in_reply_to`, `references_json`, from/to/cc/bcc/reply-to, subject, date), `message_bodies(body_text, body_html)` (maybe partial), attachment metadata, and bytes only when captured (`attachment_assets`/`chunks`). `buildRawPortable` (`packages/mail/src/compose-portable.ts`) makes RFC 5322 from a `SendPayload`.

## 2. Design

### Creating: the hover "+"

- **Account row, open:** a "+" at the row's far right, shown on hover (the unread count is hidden while it shows). Its accessible name is "New folder in {account}". It's a sibling of the row's button (never nested), as `SignInMarker` is.
- **Own folder row:** the same "+" on hover, named "New folder in {folder}".
- **Standard rows** (Inbox, Sent…) get none: IMAP subfolders of the Inbox are rare, and Gmail has none.
- **Keyboard:** the "+" is `tabIndex=-1` (a long folder list doesn't double its tab stops). "New folder…" / "New subfolder…" are also items in the account and folder menus, which Shift+F10 opens (plan 106), so every create is keyboard-reachable.
- **Clicking "+":**
  - An inline field appears as a new row where the folder will be: the account's top level first, or the folder's first child, one step further in. It's the same shell as the account rename (plan 106), and the same field the category "+" uses.
  - Enter creates it, Esc cancels, and blur creates it if a name was typed, else cancels. Each field settles once.
  - While the backend answers, the row shows the name dimmed (`aria-busy`). On success the real row takes its place, keeps the focus, and the list scrolls to it. A failure removes the row, puts the text back in the field so it isn't lost, and the snack says why.
- **Names:**
  - The name is trimmed and must be non-empty and ≤ `FOLDER_NAME_MAX`.
  - It can't contain the account's hierarchy separator: "/" on Gmail; on IMAP the delimiter the server reported, which the backend checks.
  - It must be unique among its siblings, case-insensitively. Otherwise: "There's already a folder called “X” here."
  - The checks run in the field (the error shows under it, the text stays), and again on the backend.
- **Opening:** the account opens (`toggleAccount`) if it wasn't. A folder's children always show (folders don't collapse today), so the new row is visible.

### The folder menu (right-click, Shift+F10)

Own folder rows (selectable ones and groups) and the standard rows get a `FolderMenu` (`data-context-menu`, `folder-menu-<accountId>-<key>`):

| Item | Own folder | Group (\Noselect) | Standard row |
| --- | --- | --- | --- |
| New subfolder… | ✓ | ✓ | – |
| Rename | ✓ | ✓ | – |
| Add to favorites / Remove from favorites | ✓ | – | ✓ |
| Export mailbox… | ✓ | – | ✓ |
| — | | | |
| Delete folder… | ✓ | ✓ | – |

The account menu gains "New folder…" after Rename. Sentence case, as the other menus.

### Rename (in place)

- It works like the account's (plan 106): the field sits in the row, its text on the name's line. Enter saves, Esc cancels, and blur saves. The name is checked like a create's.
- **Gmail:** `PATCH /labels/{id}` with the new full name, and every sublabel ("Old/…" → "New/…") is patched too. Keys don't change. The store's paths are updated (`folders.replace` with the new list).
- **IMAP:** `RENAME` of the folder; the server moves its subfolders with it. The provider then, in this order:
  1. The store moves the subtree's locations to the new paths: `folders.rekey(accountId, moves)` rewrites `message_locations.mailbox`, `folder_backfill` and pending `folder_rebuilds` in both stores.
  2. The provider moves its cursor's entries for the subtree (`mailboxes`, `resetPending`, `previewed`, `backfill.below`), so the next pass syncs them incrementally. A server that changes UIDVALIDITY on rename is handled by the existing UIDVALIDITY reset.
  3. `folders.replace` lists the new paths; the rebuild job derives membership from the moved locations.
  - A crash between steps leaves a state the vanished-path reconciliation already handles: the folder is re-identified and nothing is lost.
- **Everywhere:**
  - A favorite keeps pointing at the folder: an IMAP rename moves its key.
  - The current view follows the new key if you're in it, and Back still works.
  - The row keeps the focus. A failure puts the old name back and the snack says why.

### Delete

- **Confirmation** (`ConfirmDialog`, lazy):
  - **IMAP:** "Delete “Clients” and the N messages in it?" The description: "Its subfolders and their mail go too. They're deleted on the server, for every app that uses this account. This can't be undone." N counts the subtree's messages, from the store.
  - **Gmail:** "Delete the label “Clients”?" The description: "Its sublabels go too. The mail stays in All Mail and in its other labels."
  - The confirm button reads "Delete folder" (destructive).
- **IMAP:** `DELETE` of the subtree, deepest first (some servers refuse a parent with children). A refusal stops the walk and says which folder couldn't go; the ones already deleted stay deleted, and the snack says so. Then `folders.replace` without them, and a sync pass. The vanished-path reconciliation drops their locations, and messages left with no location go. That is today's path for a folder deleted elsewhere, so the stores hold no new logic.
- **Gmail:** `DELETE /labels/{id}` for the label and each sublabel. Then `folders.replace` without them; membership goes with the listing.
- **Afterwards:**
  - A favorite of a deleted folder is removed.
  - If you're in it, you go to the account's Inbox.
  - The focus goes to the next row, or the account's row.
  - Snack: "Folder deleted".

### Favorites

- **Setting:** `AppSettings.favoriteFolders: { accountId: number; folder: string | null; view: AccountView | null }[]`. It holds an own folder (`folder` = key) or a standard row (`view` = inbox, sent…), at most 50, in the order added. It's validated by zod and kept by `settings.update`.
- **Where they show:** in the top group, right below Starred, in the same `NavItem` style. Each shows the folder's icon and name, with the unread count where the sidebar already has one (own folders: `folderUnread`; an account's Inbox: `inboxUnreadByAccount`).
  - With more than one account, a quiet account label follows the name (plan 23's `accountLabels`: muted, truncated, the full address as `title`).
  - Clicking navigates as the folder's own row does. The row is `aria-current` when you're there; the row under the account isn't both.
- **Each favorite has the same menu** (Remove from favorites included).
- **It stays under its account too.**
- **Cleanup:** removing an account drops its favorites. A favorite whose folder no longer exists (deleted elsewhere) isn't shown; it's dropped the next time favorites are saved.
- **No reordering:** drag to reorder is out of scope.

### Export mailbox…

- **Backend:** `folders.export({ accountId, folder | view, after?, limit })` returns `{ mbox: string, next: number | null, done, total, missingAttachments }` in pages of messages. Each page is sized by time (`SliceSizer`, ≤ ~1 MB of text), so no call blocks the event loop past the slicer's budget.
- **What's in it:** the folder's *messages*, not whole threads. On Gmail, messages whose labels hold the key; on IMAP, messages with a location in that mailbox. A standard row (Inbox, Sent…) uses the account's messages flagged in that place (`is_inbox`, `is_sent`, …), the same predicate its list uses. Trash and spam are excluded, except in their own rows. The order is by date.
- **Each message** is rebuilt with `buildRawPortable`:
  - stored headers (Message-ID, In-Reply-To, References, From, To, Cc, Reply-To, Date, Subject)
  - the text and HTML bodies
  - attachments whose bytes are on this computer
  - An attachment that isn't is left out, and a header `X-Terno-Missing-Attachment: <filename>` names it. The count is returned, so the snack can say "3 attachments weren't on this computer."
  - It's written in mboxrd form: a `From - <asctime date>` line, and `>`-quoting of `From ` lines.
- **Renderer:**
  - A loading snack shows progress ("Exporting Clients… 1,200 / 5,400") and can be cancelled.
  - The pages are collected as Blob parts; Blobs are spilled to disk by the browser and by Electron, so the renderer's heap holds one page at a time.
  - Then `<a download="Clients.mbox">`. The desktop shows its save dialog; the web downloads.
  - On success the snack says "Exported 5,400 messages" (plus the missing-attachments line).
- **Nothing leaves the machine:** the export reads only the local copy, and nothing goes to the network.

### Backend and providers

- **RPCs:**
  - `folders.create({ accountId, parent: string | null, name })` → `Folder`
  - `folders.rename({ accountId, key, name })` → `{ folders: Folder[]; moves: {from, to}[] }`
  - `folders.delete({ accountId, key })` → `{ deleted: string[] }`
  - `folders.count({ accountId, key })` → `{ messages }`, for the confirmation
  - `folders.export(…)`
- **Errors** are plain-English `L()` strings:
  - offline: "You're offline. Try again when you're connected."
  - the server refused: "{server} didn't allow this: {reason}"
  - a name that's taken, or invalid
- **Provider (optional methods):** `createFolder(parentKey, name)`, `renameFolder(key, name, store hooks)` and `deleteFolders(keys)`. They return the account's folder list after the change (IMAP: a fresh `LIST`; Gmail: `/labels`), so the store holds what the server says, not a prediction.
- **One at a time per account:** a folder change waits for the account's running sync to end and holds the next one until it has written the store. A `LIST` taken before the change can't undo it. A sync is kicked after.
- **Out of the hot path:** no new work in sync, lists or counts. Favorites are a settings read. The menus' content mounts only while open.

### Strings (en + es)

Every label, error, snack and confirmation above, under `folder.*`, in both locales.

## 3. Tests

- **Provider** (unit, with the IMAP test server / Gmail fetch fakes the mail package already uses):
  - IMAP create, nested create (with the delimiter), rename moving its cursor's subtree, and deleting a subtree deepest first, with a refusal midway.
  - Gmail label create and sublabel, rename patching sublabels, delete of label + sublabels.
- **Stores** (conformance, both): `folders.rekey` moves locations, backfill and rebuild rows; after `replace`, membership follows with no message re-read.
- **Backend:**
  - A folder change waits for a running sync, and a sync started meanwhile waits for it.
  - Favorites are rewritten on rename and delete, and dropped with their account.
  - Export pages are bounded by time, and the mbox is quoted (`>From `). Missing attachments are counted.
  - Gmail messages count by label; IMAP by location; standard rows by place.
- **Unit (web):** the name rules (separator, empty, length, siblings); favorites helpers.
- **e2e (`folder-actions.spec.ts`, `@design`):**
  - The "+" shows on hover of an open account and of a folder row, only then, and the count hides while it does.
  - Create top-level and nested (Enter, Esc, blur, a duplicate kept in the field with its error).
  - Rename in place, aligned, with Enter/Esc/blur.
  - Delete with the confirmation (IMAP and Gmail wording), Cancel, and the view leaving a deleted folder.
  - Favorites added and removed, shown below Starred, opened, and following a rename.
  - Export downloads an `.mbox` whose message count and quoting match.
  - Shift+F10 on a folder row opens its menu.
  - The menu and the field are axe-clean, light and dark.
- **Perf:** UI perf gates (sidebar render counts unchanged); one export perf case (5,000 messages: each page within the slicer's budget, both stores).
- **Screenshots:** the hover "+", the new-folder field, the menu and favorites, in light and dark, in every design.

## 4. Out of scope

- Moving a folder to another parent by drag.
- Reordering favorites.
- Collapsing a folder's children.
- A "+" on standard rows.
- Exporting an exact copy from the server.
- Importing an `.mbox`.
- Renaming, deleting or nesting standard folders.

## Revisions after the Codex review

Codex (plan critique, 12 points) checked the plan against the code. Changes:

1. **IMAP delete cleans up explicitly and durably.** The vanished-folder pass keeps orphans (`reconcile(…, keepOrphans = true)`), because a vanished folder may be a rename.
   - `deleteFolders` writes the deleted paths into the cursor (`deleted: Record<path, uidvalidity>`) after the server's `DELETE`, then saves.
   - The next sync pass, which the backend runs at once, reads each deleted path's locations and journals them (`unlocated`). It removes those locations and reconciles with `keepOrphans = false`: a message with a location elsewhere stays, and one that only lived there goes. A message under an unresolved hold (`locations.unresolved`) is left to the existing hold logic. Then the path is cleared.
   - A restart in between resumes from the cursor.
   - Tested with `imapkit` (backend integration), interruption included.
2. **One folder change per account, and nothing else that touches the provider.** Folder changes take an account gate (`folderChange: Map<accountId, Promise>`). While it's held:
   - A sync waits.
   - The ops worker skips the account; it's kicked when the gate opens.
   - `repairSentCopy` and body reads wait.
   - The change itself waits for a running sync and the account's op in flight.
   - Tests: a change during a sync, during an op, and two changes at once (the second waits; nothing interleaves).
3. **IMAP rename doesn't migrate state.** Points 3 and 4 showed that moving the cursor and locations in place needs composite backfill keys (`path:uidvalidity`), bounded resumable rewrites, and IndexedDB iterator invalidation. The sync already handles a renamed folder: it vanishes under its old path, appears under its new one, and its messages are re-identified by the existing path (Codex R1/R2 of plan 68).
   - After the server's `RENAME`, the backend writes the fresh `LIST`'s folders and kicks a sync.
   - The renamed folder's mail is re-read under its new name. That's one envelope fetch of the folder, and until it lands the folder shows "Syncing…" in its empty list, never "No mail".
   - Out of scope: carrying the cursor and locations over in place.
4. **No rekey in the stores** (follows from 3). `folder_backfill` isn't touched.
5. **Gmail works on the raw label catalog.** Every change first reads `/labels`, the exact names of every user label (hidden ones included). Sublabels are labels whose name starts with `Old/`. The new names are checked for collisions with *any* existing label before the first request.
   - A partial failure (some PATCH/DELETE done, one refused or timed out) re-reads `/labels`, writes what's true to the store, and says what didn't happen ("2 of 3 labels renamed. “X” couldn't be: …").
6. **Groups get no actions in this version.** Synthetic parents (`key: null`) and IMAP `\Noselect` parents keep rendering as today, as non-focusable `div`s. They get no "+", no menu and no rename or delete. Creating "under" one is done from its real child or the account. Out of scope until groups are focusable.
7. **The folder event carries renames.**
   - `folders` events gain an optional `renamed: { accountId, from, to }[]`, which the backend fills from the change it just made.
   - IMAP's `to` is computed from the fresh `LIST` (the parent's path + delimiter + name).
   - The renderer's `setFolders` applies the mapping before its missing-folder check: the current view, the back stack's entries and the favorites follow `to`, so the event never sends you to the Inbox. Favorites are also rewritten on the backend from the same mapping.
   - Tested with the event arriving before the RPC's answer.
8. **Focus hand-off, batching and ownership.**
   - Menu items that open an editor use the account menu's hand-off: no `finalFocus` back to the row.
   - `AccountFolders` keeps a pinned key (the pending create's parent, the row being renamed, the row just created) mounted like the focused one, beyond the first 250.
   - Focus moves to a result only if it's still on the field or on `body`; otherwise it stays where the user put it.
   - Tests: blur then navigate, a slow error, and creating beyond the first batch.
9. **The export streams, bounded.**
   - **Serializer:** an export-specific one (`packages/mail/src/mbox.ts`). It writes one message's parts in order: headers, then the text and HTML parts, then each attachment base64-encoded from its stored chunks. It emits ≤ 256 KB strings, so neither a page nor a message is ever whole in memory. It has no outgoing-size limits.
   - **Backend:** `folders.export` is a session: `start` returns `{ exportId, total }` and fixes the message list; `next` returns up to ~1 MB of text or ~15 ms of work, then `cancel`. Sessions expire after 60 s idle, and one runs per renderer.
   - **Desktop:** a save dialog first (`terno:export-begin` in main, with an atomic temp file), then each chunk is appended (`terno:export-write`), then `terno:export-end` renames the file into place. Cancel or an error deletes the temp file.
   - **Web:** `showSaveFilePicker` and a writable stream where the browser has it (Chromium). Otherwise Blob parts up to 512 MB, which the snack says before it starts, then `<a download>`.
   - Tests: a 40 MB attachment, a large total, and cancel cleanup (desktop smoke for the IPC).
10. **The export's contract.** The serializer writes:
    - Message-ID, In-Reply-To, References, From, To, Cc, Reply-To, Date, Subject and List-Id
    - `X-Terno-Missing-Attachment: <name>` for each attachment that isn't here
    - `X-Terno-Partial-Body: true` when the stored body is partial or missing
    - The end reports both counts ("3 attachments and 2 messages' full text weren't on this computer").
11. **The order is fixed at the start.** `start` resolves the folder's message ids once, sorted by `(date, id)`. That's ids only, bounded by the folder: 50k ids is 400 KB. Pages walk that list. A message deleted meanwhile is skipped; one added after `start` isn't in this export. Both stores. Tests: equal dates, and a deletion between pages.
12. **The backend validates against the server, not the display.**
    - IMAP: a fresh `LIST` gives the delimiter and the real parent path (with its `INBOX` prefix). The checks:
      - the name has no delimiter
      - the full path is ≤ `FOLDER_NAME_MAX` per segment
      - no sibling has the same name (case-insensitive, compared on the server's names)
      - the target isn't a role mailbox or INBOX, and is an own folder in that `LIST`
    - Gmail: the raw catalog, the same way, and a target must be a user label.
    - The UI checks only what it knows: empty, length, "/" on Gmail, and siblings shown. Everything else comes back as an error under the field.

## Codex code review, round 4

- #1 **An IMAP delete forgets only what's proven gone.** The cursor's deleted paths are forgotten after every folder of the pass has been read, never before, and wait (as vanished folders do) when a folder couldn't be read. A message a read met again (an envelope matching it in another folder, moved there by another app before the delete) isn't proven gone: it's journaled and held like a vanished folder's mail, keeping its id, its stored body and what's queued for it. Test: `folder-actions.int.test.ts`, Work → INBOX by another client, then Work deleted here.
- #2 **Deleting a folder renamed here before a pass read it** records where its mail is cached: the pending rename's old path and UIDVALIDITY (`deleted[path] = { from, uidvalidity }`, written before the DELETE, so a restart keeps it). The pass forgets that path's mail, with no holds left behind. Test: Work → Job, Job deleted, restart, pass.
- #3 **`folders.count` is sliced.** `count(accountId, keys, after, limit)` returns `{ messages, next }`. Each folder's places are counted first: a message counts in the first folder that places it. Then its threads: a thread that an earlier folder holds was already read there. Each thread's messages are read in index order, a stretch at a time, so each thread and message is looked at once, however many sublabels overlap. The backend loops with a `SliceSizer` and yields between slices. Conformance covers both stores and every slice size. The perf gate is 100 overlapping sublabels on one 50,000-message conversation. Before the fix, that was one call of 12.5 s on SQLite and 17.7 s on IndexedDB. Now it's 51 slices of at most 1,000 rows, each under a frame.
- #5 **An export start superseded while it sorts** checks again right before it registers, so only the newest session is kept.

## Codex code review, round 5

- #1 **A RENAME whose answer was lost is announced by the next pass.** The rename's durable record (`cursor.renamed`) also keeps the path the folder was listed under (`key`). A pass whose LIST shows the new path and not the old one hands those moves to `setFolders`; the backend's sink announces the ones the store still showed under the old key (`foldersRenamed` before `folders`, threads carried, favorites rewritten), as a change does. Test: `folder-actions.int.test.ts`, Work → Job with the answer lost, then a restart and a pass.
- #2 **A folder renamed here before a pass counts and exports its mail.** Its threads were carried to the new key, its locations weren't. The backend reads the pending rename's old paths (`renameAliases`) and adds them: to a delete's count as further keys (a message counts once, where it's first placed), and to an export's target as `aliases`, whose locations both stores read as the folder's. Tests: `folder-actions.int.test.ts` (count and export before the pass), and conformance in both stores.
- #3 **An mbox body is read a line at a time** by a moving regex, never split whole first (a 10 MB body was ~169 ms before its first piece). Test: `mbox.test.ts`, no string op sees more than a piece.
- #4 **IndexedDB's count walks a folder's places once across its slices**: a live walk of the mailbox index is kept between slices, by how far it has looked (a lost one is walked again past that, once). Perf gate: 50,000 places in slices of 100, 669 ms in all before, 9 ms now.
- #5 **An export whose page ends while its save panel or file opens leaves nothing behind.** Main watches the page before the panel and notes its generation; a page that ended meanwhile cancels after the panel, and a file whose open finishes after it is closed and deleted. Tests: `mbox-export.test.ts`, a reload during the open and a crash during the panel.

## Codex code review, round 6

- #1 **A folder deleted after its rename leaves a mailbox made again under its old name alone.** The cleanup read the path's UIDVALIDITY now, not the deletion record's, and reset the whole path: Work → Job, Work created again, Job deleted, and the next pass took the new Work's mail. It forgets the recorded UIDVALIDITY's places only, by message (`removeMany(…, { deleted })`, no hold), and the path's state only if it's that generation's. A UIDVALIDITY reset of the path to the new mailbox leaves the recorded generation's places for the deletion, which forgets them once every folder is read. Tests: `folder-actions.int.test.ts` (the new Work keeps its mail and identity across two passes, Job's goes), conformance in both stores.
- #2 **A renamed folder's old path made again counts and exports each folder's own mail.** A pending rename's alias is the old path and the UIDVALIDITY it recorded (`FolderGeneration`), taken while the new path is listed. The folder at the old path leaves those generations out (`except`). The stores read places a generation at a time: SQLite seeks each UIDVALIDITY by its index, and IndexedDB matches each location's. Tests: `folder-actions.int.test.ts` (Job counts and exports 1, the new Work 0), and conformance for counts and exports in both stores, however they're sliced.
- #3 (a focus finding in the UI) is fixed separately.
- #4 **An export reads a body a stretch at a time as it writes it.** `folderExport.messages` says which parts are stored, and `folderExport.body(id, part, at, size)` reads about 256 KB of one.
  - **SQLite** reads a byte range of the stored value, cut back to a whole character. A byte range costs the same wherever it starts (~5 ms for a 20 MB body), where a character range walks from the start (~23 ms at 19 MB). SQLite still loads the value inside itself for each read; only the range reaches JavaScript.
  - **IndexedDB** keeps a body as one record, so any read of it loads all of it, once, into the body cache. What a call visits and hands on is a slice.
  - **The serializer** encodes each stretch synchronously (an await per line had made exports slower), and pieces are now 128 KB.
  - Perf gate (`folder-export.perf.test.ts`), a 20 MB body read from a store opened afresh. Before: one read handed on 19.6 MB, with a 44 ms stall on SQLite. Now: at most 256 KB, and every stall within the 25 ms budget, in both stores.

## Codex code review, round 7

- #1 **A folder renamed here keeps its mail when its old name is made again before the next pass.** Work → Job, then Work created again: the new Work's UIDVALIDITY reset held the old Work's places, the rename's proof was withheld because Work was listed, Job skipped its mail and the record was dropped, so the mail had no place left. A reset of a path to a new generation now leaves the rename record's generation in place (and drops the path's state, so a folder read earlier in the pass knows it's another mailbox). The proof holds while the old path is gone *or* listed under another UIDVALIDITY, and the record's generation alone is forgotten once every folder is read (a UID Job didn't have is held). Test: `folder-actions.int.test.ts`, Job keeps the message with its id, place and body, nothing held, the new Work has its own, across two passes. It failed before: the message had no location.
- #2 **A folder deleted here and made again before the cleanup pass loses its old mail.** The deletion record went because the path was listed, without checking UIDVALIDITY. A listed path's record now goes only if STATUS shows the recorded UIDVALIDITY (the DELETE wasn't carried out). Under another one, the record stays: the reset leaves its generation to it, and the cleanup forgets only that generation, never the new mailbox's mail. A STATUS that fails leaves the record for a later pass, and a `\Noselect` path drops it as before. Test: `folder-actions.int.test.ts`, the old message goes with no hold, the new Work keeps its mail and identity across two passes. It failed before: the old message was held.
- #3 (a list paging finding) is fixed separately.

## Codex code review, round 8

Rounds 1–7 patched the IMAP rename and delete records case by case. Round 8 found three more cases of the same kind, so this round writes down the invariant, then checks every path against it.

**The invariant.** Every record, alias, membership carry, location cleanup and recovery is keyed by the mailbox *generation* (path + UIDVALIDITY).
- **When it's written:** a record's generation is the server's (STATUS), never the one cached for the path.
- **When it's applied:** it's checked against the LIST and STATUS again.
- **Never another generation:** a record never applies to another generation of the same path.
- **While a rename or delete is pending:** the path's listing leaves its generation out (`Folder.except`). Neither store derives membership from those places, whether by a thread's refresh, a location write or removal, or a rebuild. A count or export of the path leaves them out too, and a carry never moves another generation's threads.

What changed:

- #1 **A renamed folder's old name made again shows none of its mail.**
  - The provider lists each path with the generations a pending rename or delete took from it (`except`, read by STATUS for the paths those records name, a handful). The stores keep them: SQLite in `folders.except_json` (migration 41), IndexedDB on the folder row.
  - Every derivation leaves those places out: `refreshFolders` / `writeFolders`, `located` on upsert, move and remove, `removeMany`'s check for what's still there, and the rebuild's location walk. A location moving between generations moves the membership.
  - A listed folder whose `except` changes is rebuilt.
  - A rename's threads are carried before the list that shows it is stored, and its new key keeps them (`replace(…, carried)`), so a rebuild of the old path never runs before the carry has read its rows.
  - Tests: `folder-actions.int.test.ts` (Work, Job and its unread count before the pass, after a refresh of the thread, and after the pass), and conformance in both stores and on db-wasm (derivation, upsert across generations, `removeMany`, an `except` change, a reopen).
- #2 **A rename records the generation that moved.**
  - `renameFolder` reads each moving mailbox's UIDVALIDITY with STATUS. Its mail counts as cached only when the cursor's state for the path, or a pending rename's record, has that generation. A chained rename passes the proof on only on a match.
  - Otherwise the record names the generation with nothing cached (`stale`): it's announced, but the threads the store showed under the path aren't carried.
  - Test: Work → Job, Work made again and renamed to Other. Other counts and exports 0, Job counts 1, and after the pass Job keeps its message with no hold.
- #3 **A lost RENAME's recovery is announced even when the old name is made again.** The pass announces a move when the new path is listed and the old one is gone *or* its STATUS shows another generation than the record's. Test: the answer is lost, another app makes Work again with mail, a restart and a pass. `foldersRenamed` comes first, the favorite follows to Job, Job keeps the message, and Work has only its own.
- #4 **A stale save panel never aborts its replacement.** Each window numbers its export requests before the panel opens (`MboxFiles.ask`). A superseded `begin` aborts nothing, and is rejected again after its temp file opens (the file is deleted). Tests: `mbox-export.test.ts` and `mbox-files.test.ts`.
- #5 **IndexedDB's export and count read a big folder's members a run per call while its order builds.**
  - Each call reads 16,384 members into a sorted run, and the walk is kept between calls. While the members are still being read, a call answers with a pending cursor.
  - Perf: 300,000 members, at most 6 ms a call (38.9 ms before).

What the audit found and fixed:

- **A delete records the generation it deletes.** `deleteFolder` reads each path's UIDVALIDITY with STATUS before the first DELETE; before, it used the cursor's (Work → Job, then Work made again and deleted recorded Job's generation). Test: round 8 audit in `folder-actions.int.test.ts`.
- **The carry is generation-checked.** A folder another app renamed and made again, then renamed here, carried the other generation's threads. A `stale` move isn't carried. Test: the "another app renamed" case.
- **A record's cleanup touches only its own generation.**
  - `forgetMailbox` resets the whole path no longer. It forgets only its generation's places, and the path's state only when the state is that generation's.
  - Another generation still cached for a gone path goes through the vanished-folder pass (held, looked for again).
- **Counts and exports leave out a pending delete's generation too:** `renameAliases` reads `except` from the folder's listing, which the provider checked with STATUS.

Still as before (documented in plan 68): until the next pass, a refresh of a carried thread derives its folders from its places, which are still under the old path. The new key can drop it until that pass, which runs at once; the old path never shows it.

## Codex code review, round 9

- #1 **A folder is never made or renamed into a name the account would read as a standard one.** Role discovery takes a mailbox for the archive, sent, junk, trash or drafts by its name (`Archive`, `INBOX.Papelera`…) when no mailbox holds that role by its flag. Renaming Work to Archive on an account without one made it the archive: it left the own folders with no rename mapping, so the view fell back to the Inbox, the favorite was stranded and the row vanished. `planImapCreate` and `planImapRename` now refuse a destination path (the moved subtree's too) that a role's name hint matches, unless a selectable mailbox holds the role by its flag (`\Archive`…). A role held by name only is refused too: the first match in the server's LIST order wins, so a new "Archive" could take it from "Archives". The error says it in plain words (`errors.folder.reservedName`, en and es); nothing is sent. Nested, a name is only a name. Gmail labels have no such rule (`labelFolders` keeps every user label by id). The hints moved to `folder-changes.ts` (`ROLE_NAME_HINTS`), one list for both. Tests: `folder-changes.test.ts` and `folder-actions.int.test.ts` (imapkit: nothing reaches the server, Work stays); both failed before.
- #2 (a UI finding) is fixed separately.
- #3 **IndexedDB's export of a standard view walks a bounded stretch a call.** It looked for one account's threads in the store's global ascending ids, bounded by what matched: an empty account beside another's million threads walked them all in one call (57 ms). `viewStretch` looks at 16,384 ids a call and answers with where it stopped, matched or not. Perf gate (`idb.perf.test.ts`): 1,000,000 other threads, every call within a frame; before, one call. The ascending ids themselves are the store's kept "select all" order, built once for every list (not this export's cost). SQLite already seeks `threads_account_id`.
- #4 **An export's sort looks at the time inside its merges and while it writes.** It checked the time only after a whole merge, so the last merge of a big folder and `Float64Array.from` ran between two turns. The identity order, each merge and the result now go 4,096 places at a time, with a turn whenever the slice's 8 ms went. Perf gate (`folder-export.perf.test.ts`, the sort both stores share): 1,000,000 ids, longest stretch 62 ms before, ~8 ms now.

## Codex code review, round 10

- #1 **A lost RENAME whose old path STATUS can't read waits for a pass that can.** Work → Job with the answer lost, Work made again by another app, and the pass's STATUS of Work failing (SELECT working) dropped the record unannounced: Job was stored, so no later pass could announce it (the sink announces only what the store hasn't followed), and the view and favorite stayed on the new Work. Now a record whose new path is listed, whose old path is listed and selectable, and whose old path's generation STATUS couldn't read is *undecided*: the new path (and what's under it) isn't stored, neither path is read, and the pass is incomplete, so the record stays (the invariant: it's applied only once LIST and STATUS establish the generation). A rename whose change heard the server's answer is marked `answered` (it announced the move itself) and never held back. Test: `folder-actions.int.test.ts`, the first STATUS of Work fails; the favorite stays on Work, and the next pass announces `Work>Job` first, the favorite follows, Job keeps the message with no hold, Work has only its own. It failed before: no rename was announced.
- #2 **A space or tab ending a body stretch keeps its place.** A long line's start is encoded before its end is read; a space or tab ending that stretch went out as is, and when the newline came first in the next read, a MIME decoder dropped it as trailing whitespace. `QpLine` holds the last space or tab of a stretch that doesn't end the line, until the next stretch says whether the line goes on (encoded `=20`/`=09` if it ends there). Test: `mbox.test.ts`, a space and a tab each the last character of a read with the newline in the next, round-tripped through PostalMime. It failed before.
- #3 **IndexedDB keeps a long conversation's order across an export's and a count's slices.** `threadStretch` read and sorted all of a thread's message ids on every call (~55–70 ms at a million). A thread longer than the slice now has its ids read a run of 16,384 a call (`pending` until whole, the caller asking again from the same place), kept per store (a few threads) and seeked into by merging the runs' heads; a message in, out or moved to another thread (undo included) lets that thread's order go. Shared by the export's ids and a delete's count. Perf gate (`idb.perf.test.ts`, on a store of its own): 1,000,000 messages in one conversation, a message added halfway, export and count in slices of 2,000: before, every call 50–70 ms (22 s in all for the export); now at most ~5 ms a call, ~0.4 s in all, and the added message is exported. No store API changed.
- #4 **A favorite is checked and written alone among the account's folder-list writes.** `folders.favorite` read the folder list, then wrote settings: a rename or delete between them had its old key written back (and its answer overwrote the renderer's corrected favorites). `BackendCore.withFolderList` runs one at a time per account: a favorite's check and write, a change's stored list with the favorites that follow it, a sync pass's (a lost rename's recovery), and an account removal's favorites. Favorites don't wait for the provider, so they work offline as before. Test: `folder-actions.int.test.ts`, a favorite of Work whose list read comes before a rename to Job and whose write would come after: Job is the favorite. It failed before (Work).
- #5 (a UI finding) is fixed separately.

## Codex code review, round 11

- #1 **A favorite judges only its own account's favorites.** `folders.favorite` holds only its account's folder list, but pruned every account's favorites against one snapshot of all folders: another account's rename between the read and the write had its moved favorite (Job) dropped. The live check now reads the target account's folders once (for the check and the prune) and leaves every other account's favorites as they are. Test: `folder-actions.int.test.ts`, two accounts; the second's Work → Job lands while the first's favorite is between its read and its write; Job stays. It failed before (pruned).
- #2 **Every window hears the favorites the backend kept.** A new event, `favoriteFolders: FavoriteFolder[]`, goes out after every write of them: a favorite, a change's (rename, delete, a delete that failed midway), a sync pass's lost-rename recovery and an account's removal. `BackendCore.writeFavorites` runs those writes one at a time and announces each before the next, so a window never gets an older list after a newer one. The renderer applies it (`applyFavoriteFolders`, from `boot.ts`); the local updates stay (a rename's mapping and a delete's drop apply at once, the event confirms them). Tests: `folder-actions.int.test.ts`, a second window hears Work/Sub go when the server refuses Work after deleting Work/Sub; `apps/web/src/lib/folders.test.ts`, the list replaces this window's and boot listens for it. Both failed before. (`folders.test.ts` also stubs the document `page.ts` reads at import: it couldn't load since plan 98.)
- #3 **An account's removal holds its folder list until its row is gone.** The cleanup and `store.accounts.remove` run in one `withFolderList` turn: a favorite queued behind it finds the account gone (`NOT_FOUND`). Before, it could take the list between them and save a standard-view favorite for a removed account. Test: `folder-actions.int.test.ts`, a favorite asked for while the row is being removed; it failed before (saved).
- #4 **A forgotten mailbox's ids are gathered and sorted out a stretch at a time.** `forgetMailbox` mapped every place of the mailbox at once, then built a `Set` of what went and filtered the whole list (~72 ms at a million). `mailboxIds` collects the ids a page at a time with a turn between, and `sortForgotten` gathers what stays (`rest`) in the same sliced pass as what goes. Perf gate (`packages/mail/src/folders.perf.test.ts`): a million places, longest stall under 16 ms (the slicer's 15 ms budget); 64 ms before.

## Codex code review, round 12

- #1 **IndexedDB's kept walks take a row updated between slices once.** An update moves a row's key to the end of its live index, so a walk kept between slices meets it again. The audit of plan 107's kept `keysBy` walks:
  - **A long conversation's order** (`threadStretch`, the export's ids and a count's): a message updated after its run was read sat in two runs, so the export wrote it twice and the count counted it twice. The runs are now merged without repeats.
  - **A mailbox's places in a count**: three places in one-place slices counted four when the first was updated. The walk keeps which messages it counted (a `Set` of the folder's ids at most, let go with the walk).
  - **A folder's members** (`stretch`) were already merged without repeats; **the carry** and **the rebuild** insert only what's missing, so a second visit changes nothing.

  Tests: `packages/idb/src/folder-walks.test.ts` (a 17,000-message conversation exported and counted with its first message marked read between runs; three places counted in one-place slices with the first one's flags changed; the folder's members, as an audit). The first three failed before (`[1, 1, 2, …]`, 17,001, 4). Perf: the 50,000-place count is 16 ms in all (max 0.4 ms a slice), the million-message conversation's export and count at most ~4 ms a call.
- #2 **Favorites are numbered, and a window never applies an older list.** A window's `folders.favorite` answer could arrive after a newer `favoriteFolders` announcement (another window's favorite) and put the older list back. Each write of the favorites (`writeFavorites`) gets a revision (one past the last, or the clock's if that's higher, so it's never lower after a backend restart). The announcement and the answer both carry `{ favorites, revision }`. The renderer applies a list only when its revision is newer than the last it applied (`applyFavoriteFolders`, which `setFavorite` uses too). Test: `apps/web/src/lib/folders.test.ts`, revision 11 announced, then the call's answer with revision 10: the newer list stays. It failed before (the answer replaced it). Still as before: a whole-settings answer (`settings.update`) carries the favorites it read, as every other setting.
- #3 **A DELETE whose answer was lost takes its favorite on the next pass.** The pass that recovered the deletion forgot its mail but left its favorite, so a Work made again later came back a favorite.
  - The pass hands `setFolders` the deletions its LIST shows done (the path gone, or listed under another UIDVALIDITY) that nothing announced. Their favorites go in the same `withFolderList` turn as the list, through `writeFavorites`, so every window hears it, before the record is retired.
  - The record is then marked `answered`. A DELETE whose answer came is marked `answered` when the change returns, because the change's own favorites update covers it. So a recovery is announced once, and never takes the favorite of a folder made again and favorited here before the cleanup pass.
  - A change that throws midway marks nothing, so the pass announces every deletion it went through.

  Tests: `folder-actions.int.test.ts`. The lost-response DELETE now favorites Work and Keep. After the restart and pass, only Keep is a favorite and a second window hears `[Keep]`. Work made again and synced isn't a favorite. A new case covers an answered delete, then Work made again and favorited: the favorite stays through the cleanup pass. The first failed before (Work stayed); the second fails without the `answered` mark.

## Codex code review round 13

- #1 **A DELETE is acknowledged only after the backend kept its favorites.** `deleteFolder` marked its records `answered` before the LIST that ends the change. When that LIST failed, the change threw, the backend never removed the favorites, and the next pass skipped them as answered: a Work made again came back a favorite. The records are now marked by a new provider call, `deletionsFollowed(deleted)`, which the backend makes after `writeFavorites` has written the favorites that follow the change (a change that fails midway included). A change that fails before then leaves the records for the pass whose LIST shows them gone. A crash between the favorites' write and the mark only means the pass announces it again. Test: `folder-actions.int.test.ts`, the DELETE answered and the LIST after it failing. The next pass takes the favorite, and a Work made again and synced isn't a favorite. It failed before (Work stayed). The round 12 answered-delete case still passes through the new mark.
- #2 **IndexedDB's standard-view export reads the account's threads a run a call.** `viewStretch` seeked into the store's ascending thread ids (`scopes.threads`). Whenever they weren't kept (a store just opened, or after any thread came or went), one call collected and sorted every thread in the store. It now reads the account's own threads from its index (`fk_account_id`) 16,384 a call, each run sorted and kept between calls. A folder's members are read the same way while their order builds (`runStretch`, shared). A thread gone since its run was read is skipped. Round 9's bound still holds: an empty account beside another's million threads reads none of them (1 call, 0.2 ms; 62 calls before). Perf gate (`idb.perf.test.ts`, a store of its own): an Inbox export of a 1,000,000-thread account from a store just opened, then after 100 arrivals. Before, the first call took ~30 ms; now every call is under ~4 ms. The round 9 gate no longer warms the ids first.
- #3 (a UI finding) is fixed separately: the delete dialog no longer drops favorites locally; the revisioned `favoriteFolders` event decides.

## Codex code review round 14

- #1 **A RENAME is acknowledged only after the backend followed it.** `renameFolder` marked its records `answered` (round 10 #1) before the LIST that ends the change. When that LIST failed, nothing was announced, and a pass whose STATUS of a Work made again by another app failed took the record as answered: Job was stored unannounced, the record was later retired, and the view and favorite stayed on the new Work for good. The records are now marked by a new provider call, `renamesFollowed(renamed)`, which the backend makes once the list is stored, the move announced and the favorites written (as round 13's `deletionsFollowed`); only the records whose old path is the move's are marked. A change that fails before then leaves them unanswered, so round 10's hold applies. Test: `folder-actions.int.test.ts`, the RENAME answered and the LIST after it failing, Work made again, the pass's first STATUS of Work failing: the favorite waits on Work, and the next pass announces `Work>Job`, the favorite follows, Job keeps its message and Work has only its own. It failed before (no rename announced).
- #2 **A rename into a key another rename just vacated clears what was left there.** A carried key is never rebuilt, and the carry only adds rows: Work → Job, then Other → Work before a pass, showed the old Work's threads (now Job's) beside Other's until reconciliation. A new store call, `folders.clear(accountId, key, limit)`, takes up to `limit` of a key's rows (SQLite through `thread_folders_id`, IndexedDB from the folder index, as a rebuild's first phase), and `carryRenamed` runs it a slice at a time with a turn between for every move's new key (a `stale` move's too) before carrying and before the list is stored. Tests: `folder-actions.int.test.ts` (it failed before: Work showed both threads) and conformance in node SQLite, db-wasm and IndexedDB (the clear in slices of two, Work and Job and Work's unread count). Perf: `idb.perf.test.ts`'s carry case clears the carried key after it, every 500-row slice within a frame (~11 ms at most under load).
- #3 **A Cancel while an export starts stops the backend's work.** During `folders.exportStart` the renderer had no exportId, and `exportCancel` ended only open sessions, so a big mailbox went on being read and sorted after the snack said cancelled. `folders.exportStart` takes an optional `requestId`, made by the renderer (`<snack id>-<random>`); a cancel before the answer sends `exportCancel` with it. The backend drops that start's ticket (a cancel that comes before its start is remembered, 16 at most, and the start then reads nothing) and checks it between id reads and now after every turn of the sort, which throws `CANCELLED` there. An answer that comes anyway still has its session ended, as before. Tests: `folder-export.test.ts` (cancelled at the first id-read turn: one read; at the sort's first turn: no slice after it; cancelled before it began: no read) and `export-folder.test.ts` (Cancel during the start sends `exportCancel` with the start's `requestId`, then ends the session the late answer opened). Both failed before.

## Codex code review round 15

- #1 **A path's deletions are kept one per generation.** `cursor.deleted` held one record a path, so Work deleted, made again and deleted again before a cleanup pass overwrote the first generation's record: its mail was then held as a vanished folder's and stayed. A path's records are now a list, one per generation (`deletionsAt`, `setDeletionsAt`), each applied, settled and retired on its own: the pass's "shown gone" and `answered` marks, the check of a DELETE that wasn't carried out, the cleanup's `forgetMailbox`, `except` and a reset's check. A DELETE adds its record beside the others (one of the same generation is replaced), and a refused one takes back only its own. `deletionsFollowed` marks the path's every record (its favorites are the path's). A cursor written before (a record or a bare UIDVALIDITY a path) is read as a one-record list. Tests: `folder-actions.int.test.ts`, Work deleted, made again, deleted again; and the second DELETE refused (the first's mail goes with no hold, the new Work keeps its own). Both failed before (held). A third reads the old shape. **The audit of `cursor.renamed`:** a rename into a path that has a record needs that path gone from the server, so the older record's move is superseded: its mail goes through the deletion's record or the vanished-folder pass either way (the older record's forget needs the new path's state at its generation, which the new mailbox replaced), and announcing both moves onto one path would contradict. No change.
- #2 **A lost RENAME's recovery is decided by its record's acknowledgement.** The sink announced a move only when the store showed the old key and not the new: a stale listing of the new path (another app deleted Job, then Work → Job here with the answer lost) suppressed it for good. The provider now hands `setFolders` only the moves whose record isn't `answered`, and marks them `answered` once the sink has followed them. The backend announces and follows every one; it carries (clears the new key, then carries) only from a key it still shows (a move followed before a crash kept its mark from being written has none, and its new key's rows are already the carry's). Test: `folder-actions.int.test.ts`, Work and Job cached, Job deleted by another app, Work → Job with the answer lost: the pass announces `Work>Job` first, the favorite follows, and the next pass announces nothing. It failed before (`folders Job` first, the favorite left on Work). Still as before, and the same when another app does the whole swap: with imapkit, the moved mail isn't read under a path whose cached state is another generation in that pass (plan 68's vanished-folder holds).
- #3 **A standard view's stretch looks at a bounded number of gone threads.** `viewStretch`'s merge counted only live ids: an account's million threads deleted between calls were all looked at in the next one (~124 ms). `runStretch` stops after 4,096 rejected ids and answers where it stopped (`through`); `exportIds` goes on after it. Perf gate (`idb.perf.test.ts`, a store of its own): a 1,000,000-thread account's Inbox export, its threads deleted after the first stretch: every call within a frame (124 ms before).

## Codex code review round 16

- #1 **A folder renamed here keeps its mail through a thread update before the next pass.** Round 8 left it open: a rename carries the threads to the new key but not their places, so a refresh (marking one read) derived the thread's folders from places still under the old path and dropped the carried row: Job lost the mail and its unread count until the pass, and an export could miss it. The provider now lists the new path with the generation a pending rename moved to it (`Folder.aliases`: the old path and the recorded UIDVALIDITY; never a `stale` record, one whose new path isn't listed, or one whose old path still has that generation). Both stores keep them (SQLite in `folder_aliases`, migration 42, keyed by account, path and UIDVALIDITY; IndexedDB on the folder row, found by a partial in-memory index `aliased`), and every derivation reads them: `refreshFolders` / `writeFolders` (one primary-key probe a location, and in `writeFolders` none at all while no rename is pending) and the rebuild, which walks the folder's places and then each alias's. A change of aliases rebuilds nothing (the carry wrote those rows). The pass that retires the rename stores the list again without them (and without the generations left out for records it retired), so no alias outlives its record. Incremental location writes (`located`) don't read aliases: the old path isn't listed, so nothing there changes membership. Tests: conformance in node SQLite, db-wasm and IndexedDB (a refresh, another generation under the old path, a rebuild, a reopen, the retirement), and `folder-actions.int.test.ts` (Work → Job, one thread marked read before the pass: Job keeps both with unread 1, then after the pass, the alias gone, nothing held). Both failed before (the read thread left Job). Perf: `store.perf`, `idb.perf` (flag updates, folder cases) and `folder-export.perf` hold; the few timing failures under load fail the same without the change.
- #2 **A rename onto a stale favorite keeps one.** Work and Job favorited, Job deleted in another app, Work → Job here: `followFavoriteFolders` appended the moved favorite and then the unchanged stale one. Every resulting favorite is now kept once, whichever way it got there (a dropped twin counts as a change, so it's written). Test: `settings.test.ts`, both orders; it failed before (two Job favorites).
- #3 (List layout, Forward history) is fixed separately.

## Codex code review round 17

- #1 **An export's id walk reads again a thread merged behind it.** The ids are walked by thread id, ascending, and a merge keeps the lower id: once the walk passed thread 1, sync merging thread 2 into it took thread 2's messages (stored all along) out of the export. Both stores now log their merges (`ThreadMerges` in `@terno/store`: a sequence and the last 4,096 merges, in memory, recorded by `mergeThreads`); the cursor carries the sequence the walk saw (`FolderExportCursor.merges`). A merge since then of a thread at or past the walk into one at or before it (followed through later merges) sends the walk back to that thread, and a log that overflowed sends it to the start; IndexedDB also lets go of the stretch's kept runs, so a thread the merge made a member is there. The answer says `rewound`, and the backend keeps each id once from then on (a `Set` built a stretch at a time with a turn between). Slices stay bounded; a merge only costs the walk again from its thread. Tests: conformance in node SQLite, db-wasm and IndexedDB (an inbox and a label walked a thread a stretch, a reply to a1 and b2 merging b's thread into a's after the first stretch: a1, b1, b2 and c1 all there; a walk with no merge never goes back), `folder-export.test.ts` (the same through `folders.exportStart`: every message once), `thread-merges.test.ts` (chains and overflow). The conformance case failed before (b1 and b2 missing); the backend case fails without the dedupe (A1 twice).
- #2 **Counts and exports read a pending rename's aliases from the listed folder.** `renameAliases` rebuilt them from the cursor's raw `renamed` intents, trusting any whose new path was cached: Job cached, deleted in another app, then Work → Job saved its intent and the connection dropped before the RENAME was sent, so counting or exporting Job took Work's mail. It now reads `Folder.aliases` (round 16), which the provider derives only for a rename carried out (LIST and STATUS); the folders' `except` as before. Test: `folder-actions.int.test.ts`, that scenario: Job counts and exports its own 1, Work its own 1. It failed before (Job counted 2).
- #3 **Each IndexedDB count walks a mailbox's places on its own.** Kept place walks were keyed by the count's folders and position, so two counts of one mailbox took each other's, and the one that lost its walk replayed every place it had passed in one slice (its tenth slice at a limit of 500 walked 5,000 keys; quadratic overall). A count's walk now has an id of its own, given back in the cursor (`FolderCountCursor.walk`), kept by id (16, least recently used let go); a walk lost (a reload, too many counts) passes what it had counted again a slice at a time, counting none of it. Test: `folder-walks.test.ts`, two counts of 5,000 places interleaved at 500 a slice, then one whose walk is let go: every slice walks at most 501 keys and each count is exact. It failed before (1,000 in the second count's first slice).
- #4 (page history cycles) is fixed separately.

## Codex code review round 18

- #1 **A rename's new key has its aliases before its rows are carried.** The carry copied memberships a slice at a time with a turn between, and the new folder's aliases (round 16) were stored only with the listing after it: a thread marked read in another window during a turn was refreshed from places still under the old path, with no alias yet, and lost the row just carried. `replace` then skipped rebuilding the carried key, so Job lacked the thread and its unread count until a pass. `carryRenamed` now takes the change's listing and, after clearing the new key and before carrying, stores that key's aliases (`aliasAhead`: the list as stored, the new key added or its aliases set, kept from a rebuild as a carried key), under the folder-list lock and the account's write. The rest of the list (the old path, `except`) waits for the listing as before, so round 8's order holds. A sync pass's recovery carries the same way. Test: `folder-actions.int.test.ts`, Work → Job with a thread marked read at the carry's first turn: Job keeps both threads, unread 1. It failed before (one thread).
- #2 **IndexedDB keeps each export's walks while they're in use.** The member and view walks were kept by target, four at most, the least recently used let go, and the long-thread orders by thread, four at most: five exports interleaved (five accounts' Inboxes of more than 16,384 threads, or five conversations that long) each found its walk let go and read its first run again, and none finished. An export's walk is now its own (`FolderExportCursor.walk`, given back by IndexedDB; a count keeps its folder's), let go when the export is read to its end; a thread's order is let go when it's read to its end. Kept walks are let go only when idle 30 s (a cancelled export, a closed window) or past 64, the least recently used; the backend resolves one export a window at a time. Tests: `folder-walks.test.ts`, five exports interleaved a call each (Inboxes of 16,500 threads; conversations of 16,500 messages): all finish with every message. Both failed before (none finished). Perf: `idb.perf`, `store.perf`, `folder-export.perf`, `folders.perf` hold (two idb timing cases failing under load pass alone).

## Codex code review round 19

- #1 **A lost rename's recovery carries nothing into another mailbox under the new name.** The recovery checked that the new path was listed and the old generation gone, never which mailbox the new path was: Work → Job with the answer lost, then Job deleted and made again by another app, carried Work's threads and aliases into the new Job (counted and exported there while Job couldn't be read). A rename record now keeps the new path's UIDVALIDITY, read by STATUS right after the RENAME (`to`; one STATUS failing, or an answer lost, leaves the moved one's, which servers keep on RENAME). The pass reads the new path's generation too (`recordedGenerations`), and only a match gives the listing its alias and the move its carry (`arrived`); otherwise the move is announced `stale` and the new path is read afresh (re-identified, as any new folder). Test: `folder-actions.int.test.ts`, that scenario with Job unreadable during the pass: Job counts, exports and lists none of Work's mail, and after a pass that reads it has only its own. It failed before (Job had Work's thread).
- #2 **A folder count starts over when a merge moves mail behind it.** A slice past thread 1, then sync merging thread 2 into it, left thread 2's messages uncounted (its row gone, the walk past 1); with sublabels, a thread first counted in one label skipped as already counted in the next. The count cursor carries the merge sequence it saw (`FolderCountCursor.merges`, round 17's `ThreadMerges`); a merge since into a thread the count passed (a member of a folder whose rows it read, or of the current folder at or below where it reached: `mergedBehind`; a log that overflowed counts as one) starts the count over, the answer says `restarted`, and the backend drops what it had summed. Places are read by location, which a merge doesn't move. IndexedDB also lets go of the count's place walks and, on any merge, the current folder's member runs kept while its order builds (a merge can make a thread a member they lack). A restart costs the walk again only when a merge reaches a thread of these folders the count already passed. Tests: conformance in node SQLite, db-wasm and IndexedDB (one label and across two, a slice at a time, the merge after the first thread: 5 counted, and a count with no merge never restarts) and `thread-merges.test.ts`. The conformance case failed before (2 and 3 of 5).
- #3 **A demo IMAP-like folder's mail moves with its rename.** The demo renamed keys only: the mail stayed under the old path, so the new folder counted and exported nothing and a thread's refresh took it out. The demo's rename now does what a server's does: each place is written under the new path too (unlisted until the backend has carried the threads and stored the list, so nothing changes membership before), and the old places go once the backend followed the move (`renamesFollowed`). A deleted folder's places go the same way (`deletionsFollowed`), so a folder made again under its path is empty. The paths still to forget are kept in the provider's cursor and finished by a sync or the next change. Test: `folder-actions-demo.test.ts`, a populated Work (and Work/Sub) renamed to Job: count 3, exports 2 and 1, a thread marked read stays in Job with unread 1, a Work made again is empty, and Job/Sub deleted and made again is empty. It failed before (count 0).
- #4 **A demo label never takes a deleted one's id.** New Gmail-like ids came from the highest listed label, so deleting it and creating another gave the new one its id and the mail the demo keeps labelled with it. The provider keeps the highest number it ever gave in its cursor (saved before the create is answered), and `demoFolderChange` counts past it. Tests: `folder-actions-demo.test.ts` (Label_24 with a message, deleted, the next folder isn't Label_24 and is empty) and `folder-changes.test.ts`. The first failed before (Label_24 again).

## Codex code review round 20

- #1 **An export's end says what happened; a cancel during its rename is too late.** `end()` checked `aborted` and then awaited the rename: a Cancel then said "Export cancelled" while the rename went on and replaced the file the user picked. Once the rename begins the export is committing (`MboxFiles` `committing`): a cancel no longer applies (`abort` answers false, and IPC `terno:export-abort` with it), and `end` answers `saved`, `cancelled` (aborted before the rename, the file kept out of place) or `failed`, through `terno:export-end` as is. The renderer's sink close answers whether it saved: cancelled only when main kept the file out of place, else the success snack, even after a Cancel. Tests: `mbox-files.test.ts` (a cancel once the rename began: abort false, end saved, the new file in place), `mbox-export.test.ts` (end cancelled after an abort while it syncs; abort false and end saved during the rename), `export-folder.test.ts` (a Cancel during a save main reports saved says "Exported 2 messages"; one main reports cancelled says cancelled). All three failed before.
- #2, #3, #5 **A demo rename is a durable change, copied in slices and retired once followed.** Round 19's populated rename forgot old places with `locations.remove()`, which holds identities, so a second rename's copy skipped them (Work → Job → Other kept nothing); it let the old paths go before the backend stored the list that moved them (a rename cut short lost the old folder's mail); and it copied and cleaned up a whole folder in one stretch of the event loop (8 s for 20,000 messages). Redone as one mechanism, as the IMAP path's guarantees:
  - **Intent:** the demo keeps one change in its cursor before copying: the list it makes, each move's copy progress (the last UID copied, `copied`), the deleted paths (a delete's too).
  - **Copy:** a page of 200 places a write with a real turn between, the progress saved with each page. A new store call, `ImapLocationStore.upsertMany(mailbox, uidvalidity, places)`, writes a page as `upsert`s in one unit (SQLite one transaction, then the checkpoint catches up; IndexedDB one command): one transaction a place grew SQLite's WAL past 300 MB.
  - **Retire:** old paths go only when the backend acknowledges the listing (`renamesFollowed` / `deletionsFollowed`), a page at a time with `removeMany(…, { deleted: true })`: no identity held.
  - **Cut short:** the next sync takes the change to its end, as a server's rename would be (the copy finished, the list handed to `setFolders` with its moves, which the backend carries, announces and follows); a folder change before that follows it if the backend's list shows it, else gives it up (the old paths untouched, the copies dropped).
  - Tests: `folder-actions-demo.test.ts`: Work → Job → Other (count 3, exports 2 and 1, a thread marked read and a pass keep it, a third rename too); a rename whose copy fails midway, reopened: Work keeps its mail until the pass, which lists Job, announces both moves and moves every place; the same given up by a create: Work keeps 3, the new Job has none. All three failed before (counts 0, Work still listed). Conformance in node SQLite, db-wasm and IndexedDB (`upsertMany`: membership in a listed folder, a held message skipped, none for an unlisted path). Perf: `folder-actions-demo.perf.test.ts`, a 20,000-message demo folder renamed through the backend and a pass after: longest stall 14 ms (25 allowed), rename 0.7 s (8.2 s stall before).
- #4 (history mappings for inactive folders) is fixed separately.

## Codex code review round 21

- #1 **A deletion's cleanup pass looks at every mailbox the mail could be in.** It took a pass with nothing `incomplete` as proof every destination was read, but an ordinary pass reads neither Drafts nor the server's specials (Starred, Important…): mail another app moved from Work into Drafts before Work was deleted here was removed with its body and thread. While a deletion record waits, the pass also looks at every selectable mailbox the LIST has: each read unless STATUS says it's unchanged since it was read (a failure is `incomplete`, as a custom folder's), so a message met there is held, not removed. A LIST too long to walk (over `LISTED_MAX`) proves nothing: the deleted folder's mail is held as a vanished folder's (`forgetMailbox(…, "hold")`) and the record retired. Test: `folder-actions.int.test.ts`, a message moved from Work into a `\Drafts` mailbox before Work is deleted here keeps its id and body (held); the one only in Work goes. It failed before (the thread was gone).
- #2 **Removing or reconnecting an account during a folder change completes.** The change was registered with the account's lifetime (`accountWrite`), and teardown, which closes the provider and waits for that work, rethrew the interrupted CREATE's error (`folderError`), so the removal failed. A change that fails once its lifetime has ended now fails with the lifetime's reason (`assertCurrent`), which teardown expects; its durable writes still go through `account.write`. Test: `folders.test.ts`, an account removed while a CREATE waits on the server (the close fails it): the removal resolves and the account is gone. It failed before (the removal rejected with the CREATE's error).
- #5 **An export's headers are made line by line, in bounded pieces.** The whole header block was built synchronously, its subject encoded whole, and handed to `put()` as one string: a 100,000-character subject was a 336,000-character piece and 28 ms in one call. Headers are now generators: encoded words are made one at a time (a byte length from the code point, no encoder call a character), folded into lines, and the lines put into the pieces 16 KB at a time, so each `next()` does about a piece's work. An over-long ASCII word (over 900 characters) or name goes as encoded words (one after another carries its space inside), and a stored attachment's long or non-ASCII name as folded encoded words plus RFC 2231 continuations (`filename*0*=`…). Test: `mbox.test.ts`, a 100,000-character Unicode subject, a long name in To, a 100,000-character ASCII missing-attachment name and a long stored attachment name: every piece ≤ `MBOX_PIECE`, the encoding any one `next()` does ≤ `MBOX_PIECE`, continuation lines ≤ 78, and all of them round-trip through PostalMime. It failed before (716,010 characters encoded in one call).
- #3, #4 (page history) are fixed separately.

## Codex code review round 22

- #1 **An over-long identifier is left out, with a diagnostic.** Ingestion doesn't bound Message-ID, In-Reply-To, References, List-Id or Content-ID, and `angle()` wrote each whole: a 200,000-character Message-ID was one 200,017-character piece, past `MBOX_PIECE`. An identifier is written only up to `ID_MAX` (900 characters between its brackets, so its line stays within RFC 5322's 998; a real one is well under 250; one over 3,600 isn't even cleaned); a longer one is left out and named in `X-Terno-Omitted-Id: <header>`. References keeps the newest ids that fit `REFERENCES_MAX` (8 KB all told, one id a line at most), oldest first, the rest counted in `X-Terno-Omitted-References: <n>`. A stored attachment whose Content-ID is left out is written as an attachment, not inline (a reader takes an inline text part with no id for the body). Test: `mbox.test.ts`, 200,000-character Message-ID, In-Reply-To, List-Id, Content-ID and one reference among 600: every piece ≤ `MBOX_PIECE`, every line ≤ 998, the diagnostics, the newest references in order, the attachment kept; round-trips through PostalMime. It failed before (a 213,194-character piece).
- #2 **Folding keeps runs of spaces.** An ASCII subject or missing attachment's name was split into words and joined again with one space: `Invoice  42` came back `Invoice 42`. A word now carries the spaces before it but the one `header()` writes (which a fold turns into the line break's space), so unfolding gives the value back exactly. Test: `mbox.test.ts`, `Invoice  42` and a folded subject with double and triple spaces, and `annual  report.pdf` missing, read back exactly. It failed before (`Invoice 42`).
