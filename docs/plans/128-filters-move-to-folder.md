# 128: Filters that move new mail to a folder

Built on plan 127 (drag to a folder), which left this out on purpose.

## Request (verbatim)

> yes the offers should also move future mail

"The offers" are the lines of plan 127's snackbar after a drop on a folder: same sender and subject, sender, domain, list. Plan 127 made them one-time. Category offers already do both (plans 81, 84): "+ new mail".

## What exists

- **Filter actions** (`rules/schema.ts`): archive, trash, spam, markRead, star, addCategory, forward. `runFilterActions` in both stores runs them on a filter's newly claimed messages, inside `ingest`'s transaction, one filter at a time, before the classifier. `filters.applyChunk` runs them on existing mail ("Apply to existing mail").
- **`moveThreadsToFolder`** (plan 127, both stores): thread-wide, journaled for undo. Its `moveToFolder` + `archive` ops, the pending overlay on membership and the kept rule are what a filter needs too, at message level.
- **`SimilarFilters.ensureRule`** (plans 80, 90): reuse an identical filter, re-enable Terno's own, retarget Terno's filter for the same mail elsewhere, else create `auto: true`. Undo is `similar.undo`, compare-and-set.
- **Folder changes:** `change()` in `backend/folders.ts` and `followFavoriteFolders` follow renames and deletes for favorites.
- **Backups:** `import.ts` remaps category ids and maps `account` conditions by address (`accountEmails`, waiting in `pending` until the mailbox is connected).

## Design

### The action

`{ type: "moveToFolder", accountId, folder }`. A folder key means nothing without its account, so the action carries it, and it only ever acts on that account's mail. A rule without an `account` condition may match other accounts: its other actions run there and the move doesn't.

It's a **location action**: at most one of archive, trash, spam, moveToFolder in a rule (`filters.invalid.oneLocation`). A filter that also says "Delete" contradicts it; "Archive" is already part of it; two folders aren't a move.

### What it does to a message

- **Only mail that reached the Inbox, on arrival.** New mail in `INBOX`, not a draft, not sent, not in Trash or Spam. Mail that first appears in another folder, or in Archive, was already put somewhere by a person or a server rule: moving it would be a surprise, and on IMAP would add a copy. "Apply to existing mail" is an explicit request, so it takes everything a sweep would (not Trash or Spam, not drafts, not sent).
- **Per message, as every other filter action is.** A new message matching the rule moves; an older message of the conversation still in the Inbox stays, as with a filter's archive. Nothing someone else wrote moves because of who wrote this one.
- **Kept in the Inbox (plan 127's rule):** thread in the Inbox, in a category shown there, in none hidden → it's copied/labelled into the folder and stays in the Inbox.
- **Decided last.** The categories that decide "kept" come from other filters and from the classifier, both in the same transaction and in no useful order. So a filter's move is collected during `runFilterActions` and runs after the classifier, as the last thing `ingest` does. The classifier's later AI pass (`uncertain`) isn't waited for: like plan 127, it's decided once.
- **Ops:** the same `moveToFolder { folder, from: null, keepInbox }` then `archive` as a drop, with the same pending overlay on membership. A failure ends up in Archive with the op's error, as a drop's does; a filter failing also doesn't stop ingest.
- **Two filters to two folders:** both apply, in filter order: a message ends up in both (the second finds no Inbox copy and copies). A trash or spam filter on the same message wins: the deferred move finds it in Trash or Spam and does nothing.
- **A claim is a claim:** the message is claimed whether it moved or not (another account's, a gone folder's), so nothing re-files it later. A user moving it out isn't fought.

### A folder that isn't there

`moveMessagesToFolder` checks the folder is listed and selectable, once per collected move (revision 1: an account with none listed yet is trusted). If not, it does nothing, logs a warning, and the mail stays in the Inbox: never lost, never a failing op per message.

- **Renamed in Terno or announced by the server** (`renamed` in `change()` and wherever `followFavoriteFolders` is called): filters follow, compare-and-set, `keepApplications`. Gmail's label keys don't change on rename.
- **Deleted in Terno or announced, or its account removed:** the filter is turned off (a filter is at least one action, and a disabled one tells the user something happened). The builder shows it as gone.
- **Gone elsewhere, not announced:** nothing is written. It does nothing until the folder is back; the builder shows it as gone.

### The offers

- **`folders.moveScope`** takes `filterName` and, like `categorize.apply`, saves the filter first (`SimilarFilters.ensureRule`) so mail arriving during the sweep is caught. Result gains `filter: { id, filterUndo, retargeted: { from: key } | null } | null` and `filterFailed`. A failure names `{ undoId, filterUndo }` in its details.
- **The rule:** `folderRule(scope, accountId, folder)` in core: the scope's conditions, `account is accountId`, the action. The condition keeps hits, previews and "Apply" to the mail the action can touch, and shows in Settings.
- **`ensureRule`:** `targetOf` generalizes from a category id to a target key (`cat:3`, `folder:1:Recibos`), comparing only same kinds: a category filter and a folder filter for the same mail are two different things and both stand (a thread can be in both, plan 127's own rule). So "Uber → A" then a line for "Uber → B" retargets rather than doubles. The sender-wide cleanup (plan 91 R9) reads through the account condition, same account only. `Ensured` gains `retargetedFolder`.
- **The snackbar:**
  - Lines say **"+ new mail"** (`OfferLine future`), and a line with nothing left now shows no count.
  - Which lines show becomes the categories' rule, not the archive's: sender always; subject when it has more; domain and list when they have more and differ from the sender's count. `filingOffers` in `lib/offers.ts`, used by both snackbars. So a drop on a folder nearly always grows the offers.
  - Done: "Moved 23 to Recibos · Uber" as today. Nothing to move now: "New mail from Uber moves to Recibos". A note for a retarget ("New mail like this goes to Recibos now, not Facturas") and for a filter that failed (`offers.default.noFilter`, a warning).
  - **Undo:** `similar.undo { undoId, filterUndo }`, filter first, chained to the drop. Idempotent on retry (`similarFilters.undo` forgets what it did; `undoActs` puts back).
  - The tooltip says it: "Moves {scope} to {folder}, now and when new mail arrives."

### Settings

The builder's "then" row gains a folder select beside the category one (`action-folder-select`): "No folder", then the selectable folders, by account when there's more than one, with the same exclusivity as archive/trash/spam. A folder that isn't listed shows as "Folder not found" and the row says what to do. Under the select, when the rule has no account condition: "Only mail in {account} moves." `filters.save` refuses a **newly added** folder that isn't listed; an old one that went away doesn't block renaming the filter.

### Elsewhere

- **Backups:** an action's account maps by address, as `account` conditions do (waits in `pending`). Folder keys are the server's, so they survive; a missing one just does nothing.
- **AI generation:** not offered (the wire schema doesn't include it). An agent over MCP may save one; the tool's description says so.
- **Filter names:** "Uber → Recibos" isn't rewritten on rename, as a category filter's isn't today.

## Out of scope

- "Stop filing mail like this" (plan 90) when mail leaves a folder.
- Plan 91's automated default (moving the rest by itself). The default stays: only the dropped mail moves.
- AI writing folder rules.
- Reminders ending when a filter moves mail on arrival: a filter's archive doesn't end them either.

## Tests

- **Core:** the schema refuses folder + archive/trash/spam and two folders; `folderRule`; `sameRule` tells folders apart.
- **Store conformance (SQLite native, WASM, IndexedDB):** new mail on a Gmail-like and an IMAP-like account: op queued, in the folder at once, out of the Inbox; kept when a filter *later in the order* files it in a shown category; hidden wins; another account's mail untouched; archived/foldered mail not moved at ingest; sent not moved; trash filter wins; folder not listed does nothing, mail in the Inbox, claim stays; `applyChunk` moves archived mail, skips sent.
- **`SimilarFilters`:** folder retarget; category and folder filters coexist; sender cleanup stays within account and kind; undo.
- **Backend/IMAP integration:** a message arriving at the server ends in the folder and not in INBOX; a kept one in both; `moveScope` saves the filter, undo removes it and restores the sweep; filter failure keeps the sweep; rename follows; delete turns off; import maps the account.
- **Web unit:** `filingOffers` keeps the categories' behaviour; the snack's outcome messages.
- **e2e:** in `folder-drop.spec.ts`, `@design`: a line shows "+ new mail"; after it, new mail from that sender lands in the folder and not the Inbox; z brings all back and the filter's gone; Settings lists it under "Created for you"; the builder picks a folder.

## Performance and resources

- Ingest pays nothing unless a filter with this action matched. The folder list is read once per collected move. Case in the ingest perf gate: 500 new messages, one rule moving them all.
- `folders.moveScope`'s offers and sweep are plan 127's; the filter is one more save.
- Nothing while idle.

## Revisions after the Codex review (plan)

Eight points. Four change the design, three are recorded and left, one was wrong.

1. **An empty folder catalog isn't "folder gone".** Gmail's first small sync can run before folders are listed, and a restored filter would claim mail and do nothing for good. The folder check only refuses when the account has folders listed and this isn't one; with none listed the key is trusted (a stale one fails as an op).
2. **Bodies arrive in their own transaction.** IMAP inserts mail without bodies, so body filters and the classifier run again from `setBody`. The collected moves flush after the classifier there too, and at the end of `applyChunk`.
3. **Who was in the Inbox is read before any filter runs.** The first move's archive (or an ordinary archive filter) clears `in_inbox`, so checking at the flush would skip the second folder and depend on order. `applyFiltersTo` reads it once, only if an enabled filter has this action, and the flush only rejects Trash and Spam.
4. **A filter's collected moves respect its savepoint.** Each filter collects into its own list, published once its savepoint commits: a later action failing doesn't leave a move behind. Each move at the flush has a savepoint of its own and is caught and logged: it never aborts an ingest.
5. **Wrong: "a move during its own sync clears read and star".** `mappedMove` writes empty flags for every IMAP move today (a filter's archive included), and `observeLocations` reads them from the server before deriving state. Nothing here changes that path.
6. **Left, known edge: a rename while a move is queued.** The op still names the old path, so it fails with the folder-gone error and the mail stays in Archive. Folder changes hold the queue while they run, so this needs a rename in that exact window; drops have the same edge. Not lost.
7. **Left, known edge: rename inside the Undo's ten seconds.** `SimilarFilters.undo` compares states, so the renamed filter stays and shows in Settings. Harmless.
8. **Left, not from this change: a filter waiting in `import:pending` isn't in the next backup.** True of every filter that names an account today.
