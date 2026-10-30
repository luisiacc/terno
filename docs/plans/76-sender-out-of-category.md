# 76: Everything from X → Out of a category

## Request (verbatim)

> for the 'everything from X' contact, when they are inside a cateogory, one of the options inside should be to take them OUT of that category.

## What exists

- The thread menu's "Everything from X" submenu (`thread-menu.tsx`) files the sender's mail into a category (`categorize.apply`, sender scope, with undo).
- Taking threads out is `categories.removeThreads` (a user removal: a strong negative example, an auto decision reverted). It has no scope form.

## Design

- Below the "To C" items, after a separator: "Out of C" for each category the right-clicked thread(s) are in (test id `menu-sender-out-<id>`).
- New RPC `categories.removeSender { categoryId, email } → { removed: number[] }`. The backend fixes the set once, with the same search as "Search mail from X" (`from:<email>`, inside the category, through `resolveThreadScope`'s keyset pages), refuses a capped scope, and removes in budgeted slices as `categories.removeThreads` does (reason "user", so the engine learns it).
- The renderer patches the loaded rows from that sender at once, shows "Removing from C…" → "N removed from C · Undo". Undo (button or z) files the returned ids back as the user's own add (`categories.addThreads`, picker), in chunks of 5,000.

## Tests

- Backend (`categorize.test.ts`): only that sender's threads leave that category; other categories and senders stay; negatives recorded; an empty second run; a gone category is NOT_FOUND.
- e2e (`categorize.spec.ts`): the item appears only for categories the mail is in; removal, the reader's badge goes, Undo restores every membership.

## Perf

The search is the existing indexed `from:` search (exact-sender index) and the removal runs through the slicer; nothing new on a hot path.

## Out of scope

- Domain and list scopes ("Everything from @domain → Out of").
- An exact undo: the re-add records the threads as the user's own filing (positive examples) even when they had been filed by a filter or auto. A removal batch journal would make it exact; not worth it for this action yet.
