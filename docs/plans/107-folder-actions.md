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
