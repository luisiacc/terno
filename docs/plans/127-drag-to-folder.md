# 127: Drag mail onto an account's folders

## Request (verbatim)

> we need to be able to drag emails to folders inside an account, this removes them from the inbox and we need the logic of doing it with similar emails, by default only the one moved in moves, then we do the suggestions like we do with movingto categories.
>
> if its in a folder and also in a category that shows on the inbox, then it stays on the inbox

The attached screenshot points at an open account's own folders (Familia, Recibos).

Decisions taken without asking, each reversible:

- **One-time offers.** The offers move what's there now. They make no filter: no filter action can move mail to a folder today, and adding one is a feature of its own (below, Out of scope). Plan 128 added it: the lines now catch new mail too.
- **"Stays" is decided at the drop.** A thread is kept in the Inbox when, at the drop, it's in a category shown there and in none hidden (plan 83: hidden wins). Filing a thread already in a folder into a shown category doesn't bring it back, as filing an archived one doesn't today.
- **A move leaves the Inbox and the folder you're looking at.** Other folders and labels stay. That's what Gmail's own "Move to" does, and a label someone set elsewhere is never stripped silently.

## What exists

- **The drag** (`lib/drag.ts`, `lib/drag-install.ts`, plan 01): a pointer controller over `[data-drop-target]` rects, numeric category ids only. Only the two `NavItem`s whose state changes re-render.
- **Folders** (plans 68, 107): IMAP mailboxes keyed by path, Gmail labels keyed by `Label_*`. Membership is `thread_folders`, derived in the transaction of whatever decides it: Gmail from `messages.gmail_labels`, IMAP from `message_locations`. `refreshFolders`/`writeFolders` rewrite it from those, so a row written by hand is lost at the thread's next recompute.
- **No op changes a message's folder.** `archive` is a provider op (IMAP: INBOX → Archive; Gmail: remove `INBOX`). `moveLocations` (IMAP) moves or copies with identity holds and UID mapping. Ops in the `location` group run in order per message (`NOT_BLOCKED`).
- **Undo** (`UndoJournal`, `threads.undo`): per-message `MessageState`; `restoreMessages` queues the ops that take them back (`moveToInbox`, `archive`…).
- **Offers** (plans 63, 91): `offers.forAction`, `similar.resolvePage` (bounded walks of the indexes), `OfferLine`, `orderOffers`, `chainUndo`, `snackbarControls` (keys 1–4, z, Esc). `similar-snackbar.tsx` grows the plain snack in place (`growSnack`).
- **A kept rule's other half** (plan 83): `show_in_inbox` on categories; the Inbox leaves out threads in a hidden one.
- **IMAP `moveToInbox`** moves *every* location except INBOX and Sent to INBOX. With one copy that's right; with a copy in a folder it empties the folder.

## Design

### The drop

- **Targets:** own, selectable folder rows under an open account, and favorites of own folders. `NavItem` carries `dropTarget: number | string`: a number is a category (`data-drop-target`), a string is `folderRef(accountId, key)` (`data-drop-folder`). `measureTargets` reads both. Non-selectable groups aren't targets.
- **States:** `over`; `already` (you're in that folder: the existing ✓); new `refused`, when any dragged row is another account's or in Trash or Spam. A refused target gets no highlight and a muted name. Dropping there changes nothing and says why ("These conversations are in another account" / "Move them out of Trash or Spam first").
- **The ghost** flies into the folder's icon (`data-slot=nav-icon`), as it does into a category's dot.
- Rows behave as an archive's do, by view: they leave the Inbox (unless kept) and the folder they left; they stay in All Mail, Sent, Starred, a category's list and a search, patched. The selection moves on, List's page closes.

### The move (store: `threads.moveToFolder`, both stores, one transaction per slice)

Input: `{ threadIds, accountId, folder, from: key | null, now }`. A thread of another account, or a target whose folder isn't listed, is refused by the backend.

For each thread:

1. **Kept?** In the Inbox, in at least one category shown there, in none hidden.
2. **Which messages:** not draft, not trash, not spam, not already in the folder. On IMAP, received ones; a thread of only sent mail, all of them. Gmail labels every one, as Gmail's conversation-wide labels do.
3. **Gmail, locally:** the folder's key goes in `gmail_labels`, `from`'s comes out.
4. **Ops, in order:** `moveToFolder { folder, from, keepInbox }` for the kept and for the rest (two ops), then the existing `archive` path for the threads not kept: same flags, intents and undo as any archive. On IMAP that `archive` finds no INBOX copy left and does nothing; on Gmail it removes `INBOX`. A permanently failed move (the folder went elsewhere) therefore leaves the thread in Archive, never lost, with the op's error snack.

`moveToFolder` and `leaveFolder` join the `location` group, so they run in order with `archive` and `moveToInbox` on the same messages.

**Membership shows at once.** While a `moveToFolder` op is queued or running, its folder counts as a membership of its messages' threads, in `refreshFolders` and `writeFolders` in both stores. No new table: it's read from `ops`/`op_targets`, behind a one-row existence test on `ops_ready`, so the common case costs one probe. A failed op stops counting: settling one refreshes its threads. This covers IMAP (no location until the server answers) and Gmail (a stale label read during the window).

### Provider ops

`moveToFolder { folder, from, keepInbox }`, per message:

| | Provider does |
|---|---|
| Gmail | add `folder`; remove `from` if set |
| IMAP, `keepInbox` | `from` copy → MOVE to the folder; else COPY from INBOX (or its first location). The INBOX copy stays |
| IMAP, not kept | **sources** = its copies in INBOX, `from`, the Archive role. MOVE the first; delete the others. Already in the folder: delete all the sources. No source: COPY from its first location (Sent, All Mail, another folder) |

`leaveFolder { folder, back }` (Undo):

| | Provider does |
|---|---|
| Gmail | remove `folder`; add `back` if set |
| IMAP | `back` set: MOVE to it. Else: another copy exists → delete this one; it's the only copy → MOVE to Archive |

The last copy of a message is never deleted. A folder that vanished from the server fails the op with Terno's words. The demo provider writes the same locations.

**IMAP `moveToInbox` narrows:** role copies (Archive, Trash, Junk, All Mail) first; own folders only when it has no role copy. A copy kept in a folder therefore survives an archive's undo.

### Undo

`threads.moveToFolder` returns what it did: `before` (MessageState, for the archive part) and `{ added: messageIds, left: messageIds }`. The journal holds them with the undo id, beside `endedReminders`. `threads.undo` restores `before` (queues `moveToInbox`), then `threads.leaveFolder` (Gmail's labels back, `leaveFolder` ops after it). Retried whole on failure, as today; idempotent. Due reminders end as an archive's do, only for threads that left the Inbox.

### Offers

- **Default: nothing else moves.** Plan 91's automated sender + subject default doesn't run here.
- **`offers.forAction`** takes `{ folder: { accountId, key } }`; the counts are what each scope would still change: threads of that account, not in Trash or Spam, not in the folder. Starred and replied threads aren't skipped: filing isn't disposal (as with categories). Same bounded walk (`OFFER_SCAN`), same caps.
- **`folders.moveScope { accountId, folder, from, scope, jobId }`** resolves through `similar.resolvePage` (a new place test beside the archive/trash/spam ones), then slices with progress; refused past `SCOPE_CAP`. Partial failures keep their undo (as `similar.apply`).
- **The snackbar** (`folder-snackbar.tsx`, lazy): the plain snack "Moved to Recibos" with Undo grows in place into `OfferLine`s, in `orderOffers`' order. Lines with nothing to do hide (`visibleOffers`' archive rule). Keys 1–4, z, Esc through `snackbarControls`. No "+ new mail", no "No, only…", no words line.
- **When something stayed**, a note says so: "Stays in the Inbox: Facturas shows there."
- **A line** runs `applyFolderScope`: progress, then "Moved 23 from Uber to Recibos · Undo", where Undo takes back the sweep and the drop (`chainUndo`).

### Keyboard

A drag has no keyboard path, so the thread menu's **Move to ▸** gains the targets' account's folders below the categories (`menu-move-folder-<key>`), when every target is in one account. Mounted only while open; at most the 250 the sidebar shows first. Same `moveToFolder`, same snackbar.

### Strings

`folder.move.*` in `en` and `es`.

## Out of scope

- A filter action that moves new mail to a folder ("+ new mail", Always). It needs the rule schema, both evaluators, the builder, AI generation, and following renames and deletes.
- Opening a closed account by holding a drag over it.
- Standard rows (Inbox, Archive…) as drop targets, and dragging a folder.
- Dropping Trash or Spam rows on a folder.
- "Select all N": drags are off there today; the menu's item too.
- The category picker (`v`) and the palette listing folders.

## Tests

- **Controller:** string targets; `refused` never drops and calls `refused`; `over`/`already` as before.
- **Store conformance (SQLite native, WASM, IndexedDB):** Gmail labels added and `from` removed; membership at once; kept vs not (shown, hidden, shown + hidden); sent and drafts; another account refused; the pending membership survives a recompute and goes on failure; `leaveFolder` restores exactly; a page of the folder's place test; offers count only what would change.
- **Provider:** IMAP (`imapkit`, as `folder-actions.int.test.ts`): move from INBOX, copy when kept, two sources, already there, Sent-only copy, undo for each, the last copy never deleted, `moveToInbox` keeps a folder's copy. Gmail: `batchModify` bodies.
- **Backend:** one undo restores all of it (reminders too); a sweep's partial failure keeps its undo; a capped scope is refused; no learning signal.
- **Web unit:** which rows leave by view, kept rows stay, drop state by rows.
- **e2e (`folder-drop.spec.ts`, `@design`), on the seed's Gmail-like and IMAP-like accounts:** drop leaves the Inbox and shows in the folder; only the dragged one moves; an offer line moves the rest; z undoes all of it; a shown category's thread stays in the Inbox and the note says so; another account's folder refuses; from one folder to another; the menu path by keyboard; axe clean in light and dark; a mid-drag screenshot.

## Performance and resources

- `writeFolders`/`refreshFolders`: one existence probe per batch; the lookup runs only while a move is pending. `ingest.perf` and `actions` gates hold.
- Offers and sweeps reuse the bounded walks; a case in `offers.perf.test.ts` at 50k threads, both stores.
- A drag reads rows only when the target changes state; rows don't re-render (`test:ui-perf`).
- Nothing while idle. The snackbar and its offers load on the first drop.

## Revisions after the Codex review (plan)

The read-only critique made 10 points. Nine change the design; the design above stands except where said here.

1. **No move without a UID map.** A COPY or MOVE whose answer has no usable COPYUID leaves an identity hold nothing can recover (`adopt` won't take an owned hold or a message with other locations). The ops require UIDPLUS before changing anything and otherwise fail with the existing "can't safely move" message. A copy whose answer still has no map releases its hold: the source is untouched.
2. **Removing a surplus copy doesn't hold the message.** A copy is deleted only when the message has another location, through `removeMany(…, { deleted: true })`, with `admission.expected` kept current.
3. **One source per message, so undo is exact.** "MOVE the first, delete the others" is gone. A message moves from one place: `from`, else INBOX, else Archive; anything else is a COPY. A second copy in INBOX is left to the `archive` op that follows, whose inverse is `moveToInbox`. So `{ fromInbox, fromFolder, added, leftOnly }` describes every case. `leaveFolder` runs before the undo's `moveToInbox`, and `moveToInbox` moves role copies first, an own folder's only when the message has neither a role copy nor an INBOX copy, and only one.
4. **An unknown outcome** (a lost answer) stops counting as pending, and the IMAP identity rules hold what follows, as for any IMAP move. The next sync pass finds the message where it is. Kept as it is for every other location op; noted here.
5. **Gmail labels are written when the op succeeds, not at the drop.** Until then the pending op is what membership reads. A failed move then has nothing to take back, and a stale label read during the window can't remove it.
6. **Pending ops are replayed per message, in order.** While a move or leave is on its way, membership of the threads it touches is each message's labels and locations with the ops applied in `seq` order: the destination in, the source out. A → B → C shows only C. An undo shows at once. It's the last step of `refreshFolders` and `writeFolders`, in both stores.
7. **"Already" means the list you're dragging from.** Dropping on the folder you're looking at does nothing. Anywhere else the store decides per message, so a partly filed conversation is completed and one still in the Inbox leaves it.
8. **Kept as designed:** the archive part stays thread-wide, as any archive's is. A draft with `in_inbox` is as rare as it is today, and skipping it would leave the thread in the Inbox.
9. **Drags read rows once.** What the dragged rows are (their accounts, anything in Trash or Spam) is computed at drag start; `refuses` is a lookup, so pointer moves don't walk the payload. The backend checks again.
10. **A partial index for pending moves.** `ops_folder_moves` (migration 47; an in-memory `folder_moves` index in IndexedDB) holds only unsettled `moveToFolder`/`leaveFolder` ops, so with a large unrelated backlog the probe stays one read. Perf gate with a backlog.

## What the Codex code review changed

Round 1 (`f363b27a..ef2e5266`) found five issues. Each is fixed with a test checked to fail without the fix.

1. **An Archive copy was lost on undo.** Mail in Archive and a folder, filed into another, moved out of Archive while the journal called it an added copy; undo then deleted the new copy and Archive stayed empty. Archive's copy now moves only when it's the message's one copy. Test: `folder-move.int.test.ts`, kept, archived, filed, undone.
2. **A refused undo had already changed mail.** With the reminders full, the undo took the mail out of the folder before reminders refused it. Reminders go first; nothing changes on a refusal, and a retry works. Test: `folder-move.int.test.ts`.
3. **A row could leave a list while its thread stayed in that folder.** A sent-only conversation in A that later got a reply kept its own copy in A when moved to B. A thread's copies in the folder it leaves all move, yours too. Test: conformance, both stores.
4. **A bulk move that failed partway lost its Undo.** The failure snack ignored what committed. It now offers an Undo of the earlier calls and the slices the backend names. Test: `folder-move.test.ts`.
5. **An unknown outcome left the folder claiming the mail.** A lost answer stopped counting as pending but nothing recomputed. It recomputes and the lists follow. Test: conformance, both stores.

Round 2 (`f363b27a..` with round 1's fixes) found one issue, fixed with a test that fails without it: **a search from inside a folder was read as that folder's list.** Search keeps the folder in the state but lists everywhere, so a result dropped on that folder showed "already" and did nothing, the menu disabled it, and a drop on another folder took the thread out of the one you'd searched from. `listingFolder` and `sourceFolder` now read the query too. Test: `folder-rules.test.ts`. The review stopped here: this round's only finding was this one small fix.

A wider run after the rebase caught what the targeted runs had missed, none of it in a shipped path: the probe forced an index that a schema before v47 doesn't have, so the fixtures that drive today's ingest over an old mailbox failed. A real upgrade migrates first, but a missing index shouldn't fail a write: `folderOpsPending` falls back to a plain read. Test: `folder-move.test.ts`. Two tests were also behind the code: `capture-repair-upgrade`'s rewind didn't drop the new index, and `drag-install`'s fake document only answered the old selector.

## Known edge cases (left on purpose)

- **A move that fails for good leaves the thread in Archive,** with the op's error snack: the archive that follows it still runs. Nothing is lost, and the folder doesn't claim it. On a server without UIDPLUS every move fails this way; such servers are rare, and the message says what to do.
- **A lost answer (`unknown`)** shows only what's known until the next sync pass finds where the message is, as for any IMAP move.
- **A copy of a message moved from Sent, All Mail or another folder stays there:** the move adds one in the destination (Archive's moves only when it's the message's one copy).
- **Undo while a sync is reading labels:** a Gmail read from before the op settled can show the old labels until the next history event; it heals itself.

## Verification

Unit, conformance (SQLite native, WASM, IndexedDB), IMAP integration against imapkit, `folder-drop.spec.ts` in all four designs (twice each), the related specs (`dnd`, `similar`, `account-own-folders`, `folder-actions`), the UI perf gates, web conformance, and light and dark screenshots looked at.

`offers.perf.test.ts`: offers after a drop on a folder 8.3 ms p95 (budget 16); a line moving one account's mail from a sender: 783 ms, stall 18.9 ms (budget 50), list p95 1.6 ms. Its pattern-filter heap comparison fails, the same way on the commit this branched from (`f363b27a`: +54.5 MB against a limit of +49.4 MB): not from this change.
