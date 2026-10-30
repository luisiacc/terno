# 76: Everything from X → Out of a category

## Request (verbatim)

> for the 'everything from X' contact, when they are inside a cateogory, one of the options inside should be to take them OUT of that category.

## What exists

- The thread menu's "Everything from X" submenu (`thread-menu.tsx`) files the sender's mail into a category (`categorize.apply`, sender scope, with undo).
- Taking threads out is `categories.removeThreads` (a user removal: a strong negative example, an auto decision reverted). It has no scope form.

## Design

- Below the "To C" items, after a separator: "Out of C" for each category the right-clicked thread(s) are in (test id `menu-sender-out-<id>`).
- New RPC `categories.removeSender { categoryId, email } → { batchId, removed }`. The backend fixes the set once, with the same search as "Search mail from X" (`from:<email>`, inside the category, through `resolveThreadScope`'s keyset pages), and refuses a capped scope.
- The removal is a *leave move* (`beginMove({ …, leave: true })`, both stores): the move journal machinery, with the slice taking out only the rows of `to` and adding nothing. Each row (origin, time, batch), example and decision is journaled, training records a removal example per thread (as a user removal), threads left with no category go back to the background, and `categorize.undo` on the batch restores everything exactly. It is crash-resumable like any move.
- The renderer patches the loaded rows from that sender at once and shows "Removing from C…" → "N removed from C · Undo". The z token is registered at the click (it waits for the batch), so a later action keeps z.

## Tests

- Store conformance (SQLite and IndexedDB): a leave takes rows out of one category only, records removal examples, and its undo restores memberships (filter and bulk origins, batch) and examples exactly.
- Backend (`categorize.test.ts`): only that sender's threads leave that category; other categories and senders stay; the undo gives back the exact rows, examples and model; an empty second run has no batch; a gone category is NOT_FOUND; a failure partway still names its batch and its undo restores everything.
- Web unit (`categorize.test.ts`): z right after the click undoes it once the batch is known; an action taken meanwhile keeps z; a partial failure's snack offers Undo.
- e2e (`categorize.spec.ts`): the item appears only for categories the mail is in; removal, the reader's badge goes, Undo restores every membership.

## Perf

The search is the existing indexed `from:` search (exact-sender index) and the removal runs through the slicer; nothing new on a hot path.

## Out of scope

- Domain and list scopes ("Everything from @domain → Out of").

## Revisions after the Codex review

1. *A failure partway lost Undo for the slices already done.* The removal is now a journaled move: the error carries `{ batchId }`, the snack offers Undo, and `categorize.undo` finishes the move, then takes it all back (backend regression with a failing training trigger).
2. *Undo re-filed the threads as the user's own (changed origins, examples and decisions).* Replaced by the leave move's exact undo (conformance test in both stores, backend test comparing rows, examples and the model).
3. *The z token was registered only after the RPC, so a slow removal took z from a newer action.* It is now registered at the click on a deferred batch, as `act` does (web unit tests).

### Round 2

1. *Background deltas were sent by the apply, so a crash between apply and training lost them* (the snapshot's examples fingerprint still matched, and a resume replays only training). A leave now sends them from `trainMoveSlice` in both stores (backend regression: apply alone leaves the model untouched; the resumed training sends them).
2. *`categorize.undo` on an expired move returned zero counts, so the snack said "Undone".* It now refuses with "This move can no longer be undone.", which fixes drag-and-drop moves too (`move.test.ts`).
