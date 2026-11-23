# Plan 236: What matters keeps a width of its own

- **Status:** shipped.
- **Builds on:** plan 21 (resizable panes), plan 210 (What matters' feed, a conversation opened beside it in Split).
- **Request (verbatim):** "we are sharing the last used width of the 'what matters' section when its has a panel open, with the width of the inbox thread list, lets not do this, the 'what matters' width should have its own width changes separate from the inboxes thread lists"

## 1. What exists

- `apps/web/src/lib/panes.ts` stores two widths on this device (`terno:panes`, `{ v: 1, sidebar, list }`) and writes each to a CSS variable on `<html>` (`--pane-sidebar`, `--pane-list`); `globals.css`' `app-panes` clamps them against the window.
- The middle column (`#app-list`) holds the mail list or, on What matters, the feed (`app.tsx`). In Split, with a conversation open beside the feed, the list's handle shows and drags `--pane-list`: the one width the mail list uses too. Widening the feed to read its sentences widens the Inbox's list.

## 2. Design

The column keeps one width per thing that fills it. `panes.ts` gains a `Column` (`"list" | "feed"`) and a third stored width, `feed`, beside `sidebar` and `list`:

- The handle stays the column's (`Pane` is still `"sidebar" | "list"`: one edge, one element). What changes is which stored width that edge reads and writes: `storedWidth("list")` and `commitWidth("list", …)` go to the column showing now.
- `showColumn(column)` makes a column current and writes its stored width (or none: the design's) to `--pane-list`. `app.tsx` calls it from a layout effect on `feed`, so the switch lands in the same commit as the view change, before paint: no frame at the other view's width. The module applies the list's width at load, as before.
- A drag holds the column it started on: if the view changes under it, it stores nothing and the new column's width stays.
- Stored as `{ v: 1, sidebar, list, feed }`: additive, so a stored value from before reads as it was (the feed at the design's width, which is where the owner wants it to start). All three at the default removes the key, as before.
- Unset, the feed's width is the design's list width, as it is today.
- The List layout has no list|reader edge, as before; nothing changes there.

No refactor needed: the store already keys widths by name; the feed is one more name, and the one place that knows which view fills the column (`app.tsx`) says so.

## 3. Tests

- `panes.test.ts`: `parsePanes` reads `feed` on its own (missing, out of range, valid); `savePanes` round-trips three widths and removes the key when all are default; `commitWidth("list")` stores to the current column, and `showColumn` writes the other column's width (and removes the variable for a default) without touching the stored values.
- `what-matters-feed.spec.ts`, in the reader-beside-the-feed test (one page): the feed widened by its handle leaves the Inbox's list at its width; the Inbox's list narrowed leaves the feed's; both after a reload.

## 4. Perf and resources

One more number in one localStorage key; one CSS variable write when the view changes. Nothing renders for it.

## 5. Out of scope

- A width per mailbox or per category: the mail list is one column, one width.
- The List layout's single pane.

## Revisions after the Codex review

Plan critique:
1. A drag's queued frame wrote the width even if the view changed before it ran, so it could paint the feed's width over the Inbox's until release. The frame now checks the drag still sets the width that shows (`pane-handle.tsx`), as the pointer moves and the release already did.
2. The edge was named "Resize message list" beside the feed. It now says "Resize “What matters”" there (es: "Cambiar el ancho de «Lo importante»"); `app.tsx` tells the handle what fills the column. The e2e checks both names.
3. The e2e checks the handle's `aria-valuenow` in each view, and the reload measures the view the app comes back on before navigating. The List layout has no list edge and its grid doesn't read `--pane-list`, so it isn't exercised again here.

Code review: no runtime bugs. Its one point, that the reload check doesn't prove the very first painted frame, is answered by the design (the switch is a layout effect, before paint) rather than a frame-capture test; the test's comment no longer claims more than it checks.

Also found while testing: coming back to What matters reopens the conversation that was open there, so the e2e puts it away (the reader's Close) before leaving the feed.
