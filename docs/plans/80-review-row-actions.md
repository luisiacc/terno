# 80: Answer suggestions from the Review list's rows

## Request (verbatim)

> on the 'review' mode of a cateogory, each thread item in the list should have 2 buttons, not super prominent but there, one button to confirm they belong in that category, another button would be like the option we have to either make all from that sender to that category or the sender-subject combination, sender-subject 1st, so its a button with a menu, and those 2 options inside, make sure this is tested and works, look for possible edge cases as well.

Asked after: the menu's options file the mail there now **and** future mail (a filter); one Undo takes back both.

## What exists

- Review mode (`reviewCategoryId`): the sidebar's ✨ badge opens a category's pending suggestions (`categorize.suggestions`, one page of 200). A suggestion stops being pending when the thread is filed there (`pendingSuggestions` skips filed threads) or rejected.
- Accepting is `acceptSuggestion` → `addToCategory(source: "suggestion")`, from the reader's "Facturas?" chip and `y`. The category snackbar follows, with "All from X" (sender scope, existing mail only) and "Always → filter".
- Bulk filing: `categorize.apply { categoryId, scope }` (sender, domain, list, query scopes, both stores), undone by `categorize.undo { batchId }`.
- Plan 63's "similar" sweeps already know "same sender + exactly this subject" (`SimilarScope.subject`, `similarScopes` from the threads' root inbound messages) and create future-mail filters through `SimilarFilters` (reuse an identical filter, enable a disabled one, undo only while the filter is unchanged).
- Rows are listbox options: a control in one is a pointer target only (`CodeChip`, plan 72: `aria-hidden`, `data-row-control`, mousedown neither presses the row nor moves focus). Rows hold no Base UI primitives.

## Design

**Row controls (review mode only).** Two quiet ghost buttons at the end of the row's last line (the snippet line; the one line in compact/wide rows), muted until hovered, the row's own color when selected or checked:
1. **✓** `row-review-accept` (title "Belongs in Facturas"): `acceptSuggestion(thread.id, reviewCategoryId)`. The row leaves the Review list in the same frame (as archive does: the rest slide up, the selection moves on) and the usual category snackbar comes up with its undo.
2. **Always ▾** `row-review-always` (title "Always file in Facturas…"): opens one shared menu, rendered once by the list and anchored to the pressed button (rows stay cheap). Items, in order:
   - "Same subject from {name}" `review-always-subject`
   - "All from {name}" `review-always-sender`
   each with how many conversations it files now (lazy: asked for when the menu opens, a pulse while counting), and a hint line "And future mail". A scope with no sender (the user's own mail) or no subject is left out; nothing to offer shows "Nothing to file by" disabled.

   Choosing one: the rows of that scope that are loaded leave the Review list at once; the backend files every matching conversation (this one included) and saves the filter (from = X [and subject = Y] → add to category). A snack "Filed N in Facturas · And future mail" with Undo (and z). Undo takes the filter back first (only if unchanged since), then the batch; the rows come back on reload.

**Keyboard and screen readers.** The controls are pointer targets like the code chip (`aria-hidden`, `data-row-control`). The same three actions sit at the top of the thread menu (context menu, reachable by keyboard) in review mode: "Belongs in Facturas", "Always: same subject from X", "Always: all from X". `y`/`n` in review mode answer the reviewed category's suggestion (today: the reader's first chip, which may be another category).

**Backend.**
- `CategorizeScope` gains `{ kind: "subject"; email; subject }` (received mail from that sender whose normalized subject equals it), in both stores (SQL: the `messages_from` index plus `subject_norm`; IndexedDB: the `from` index, filtered).
- `similar.scopes(threadIds)` in both stores: `similarScopes` of the roots, without counting (factored out of `offers`).
- `categorize.alwaysOffers { categoryId, threadId }` → `{ senderName, offers: { scope, count, capped }[] }` (subject first, then sender; counts by `countScope`).
- `categorize.apply` takes an optional `filterName`: for a sender or subject scope it also ensures the filter `categoryRule(scope, categoryId)` through `SimilarFilters` (now taking any rule), and returns `filter { id, filterUndo } | null` and `filterFailed`. The mail stays filed if the filter fails (the snack says so).
- Undo: `similar.undo { undoId: null, filterUndo }` (filter), then `categorize.undo { batchId }`.

## Edge cases

- Nothing new to file (every match already filed): no batch; the filter alone, undone alone.
- An identical filter already on: reused, undo leaves it.
- The category is deleted while the menu is open: NOT_FOUND, plain error snack.
- Threads the user once took out of the category stay out (scope exclusion), as for every bulk scope.
- Subjects: exact match after normalization (`Re:` differs), the root inbound message's subject, ≤ 500 chars (else no subject offer).
- Own mail as the root: no offers.
- Spam/trash are never filed (scope exclusion).
- A failure partway: the batch that committed is still undone by Undo.
- The menu's thread leaves the list (another device, a sync) while it's open: the menu closes.
- Review list empty after the last answer: the empty state, focus kept on the list.

## Tests

- Core: `categoryRule` for sender and subject.
- Store conformance (SQLite and IndexedDB): subject scope resolves/counts only that sender's exact subject, excludes own/sent/trash/spam/filed/removed; `similar.scopes`.
- Backend: `categorize.alwaysOffers` order and counts; `categorize.apply` with `filterName` files and creates the rule, reuses an identical filter; `similar.undo` + `categorize.undo` restore both; filter failure keeps the mail filed.
- Web unit: review `y` answers the reviewed category.
- e2e (`review-row-actions.spec.ts`): buttons only in review mode; ✓ files and the row leaves; Always → subject files the matching rows only and the filter exists; Always → all from; Undo restores rows and removes the filter; the thread menu's items; axe clean light/dark; pressing the controls doesn't open the thread.

## Perf

Rows: two spans, only when `review` (one boolean per row, the same for all). The menu is one instance per list, its counts asked for only when opened. The subject scope walks the sender's index like the sender scope (capped count). No change on non-review lists (ui-perf gates).

## Out of scope

Domain and list "always" scopes; rejecting from the row (the reader's ×).

## Revisions after the Codex review (plan)

1. *Loaded rows can't tell which other threads a scope matches* (a row's sender is the last one; the scope matches any received message). Only the answered row leaves at once; the rest leave when the list reloads after the backend filed them.
2. *`acceptSuggestion` neither removes the row nor moves the selection.* One review-answer path (`answerReview`) for the row's ✓, the thread menu and `y`/`n` in review mode: the row leaves (selection moves on, as archive), then accept/reject; a failure reloads the list (the row comes back).
3. *`categorize.apply` loses its batch when a later slice fails.* It now catches and returns `{ batchId }` in the error's details (as `categories.removeSender` does); the snack offers Undo for what committed. Backend regression with a failing slice.
4. *A capped count isn't bounded work.* The subject scope walks the same sender bucket as the existing sender scope (which the snackbar already counts on every filing). Perf tests for a dominant sender with a rare subject, both stores, hold the count under budget.
5. *Thread menu with several checked threads.* The review items show only for a single target (no multi-selection).
6. *The shared menu's focus and shortcuts.* It sets `menuOpen` while open (shortcuts suppressed), focuses its first item, closes on Escape/outside, and gives focus back to the list; if its row leaves the list, it closes. e2e covers Escape, focus and that `j` doesn't move the list while open.
7. *Empty list focus.* The existing policy holds (focus moves on when the list is empty); no review exception.
8. *Filter intent.* An explicit `always: true` on `categorize.apply`; without it nothing changes for existing callers.
9. *Own mail.* Offers come from the root inbound message (the first received one): a thread the user started with a reply in it has offers; only a thread with no received mail has none (tested).
10. *Undo when the filter's undo fails.* The batch is undone regardless; a part that failed stays for the retry (each part runs once). Tested both ways.

## Revisions after the Codex code review

1. *Mail arriving while a large "always" filing ran could be missed* (the filter was saved after the set was fixed and filed). The filter is now ensured first; a failure partway carries `{ batchId, filterUndo }`, and the renderer's Undo takes back both (backend: the partial-failure test now finds the filter made and undoes it; web unit: an error with only `filterUndo` still offers Undo).
2. *`from equals` matched a display name made to look like the address.* A from condition that is `equals` a full address now compares the address only, in core's evaluator and the SQL compiler alike. That also hardens every sender filter Terno already made (snackbar, plan 63). Regression tests: core `rules.test.ts`, and a conformance test (both stores) where a spoofed display name no longer matches; the 120-rule oracle still agrees.
3. *A long subject made the filter name exceed the 120-character cap*, so the RPC refused it. `filterNameOf` shortens the sender/subject part and keeps "→ category" at the end (web unit test).
4. *Closing the menu could take focus from where the user moved it.* `finalFocus` leaves focus that is outside the menu alone (as the thread menu does); a press outside, which Base UI restores no focus for, hands focus back to the list (e2e: Escape and an outside click both leave the list focused). The menu stays modal like the thread menu (non-modal menus' focus guards fail axe).

Also found while testing: undoing a filing left the suggestion it answered marked accepted, so it never came back to Review. `undoBatchPart` (both stores) now makes such a suggestion pending again (conformance test).
