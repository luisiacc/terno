# Plan 169: Drag to reorder categories and accounts

## The request

The owner, verbatim:

> allow users to sort categories and email accounts in-place, must be smooth and simple, just by dragging, lets have a premium clean ui there

The screenshot points at the sidebar's Categories (Facturas, Clientes, Viajes, Lecturas, Desarrollo) and Accounts (Personal, Acme Studio, Freelance, iCloud).

## What exists

- **Order is stored already.** `categories.position` and `accounts.position` in both stores (`packages/db/src/repos.ts`, `packages/idb/src/mail.ts`); both lists are read `ORDER BY position, id` and new ones go last.
- **Categories can be reordered** through `categories.reorder { ids }` (`reorderCategories` in both stores: the given order, unlisted ones after, one unit; held by the store conformance suite), which the backend answers and broadcasts as `categories`. Its only caller is Settings → Categories' Move up / Move down (`move()` in `settings/categories-tab.tsx`: optimistic, back on failure with a snack).
- **Accounts can't be reordered.** No RPC, no store method; `accounts.update` patches names and preferences only. The order an account shows in is the order it was added.
- **The sidebar** (`components/sidebar.tsx`): category rows are `CategoryMenu` (a context-menu trigger rendering a `div.relative`) around a `NavItem`, after the "To sort" review row; account entries are `div[data-account-id]` (the row with its menu, then its folders when open), inside `accountsRef`. Rows are thread drop targets (`[data-drop-target]`, plan 01; `[data-drop-folder]`, plan 127).
- **The thread drag** (`lib/drag.ts`, `lib/drag-install.ts`): a pure controller, a DOM binding, a 4 px threshold, pointer capture, a click swallowed after a drag, Esc/blur/pointercancel cancel, `data-dragging` on the root for the grabbing cursor. It starts only on list rows.
- Motion: every transition reads `--motion-*`; `data-motion="off"` and reduced motion turn them off globally.

## Design

### The gesture

- **Press a category or account row and move it 4 px**: it lifts and follows the pointer, vertically only. Shorter than that is a click, as now; ⌘/⇧/⌃-click and right-click keep their meaning and never start a drag.
- **It stays in its group.** The row is clamped between the first and last place of its section: a category never lands among accounts, nor above "To sort".
- **Lifted look:** the row keeps its place in the column (same inset and content line, judged at rest), takes a solid `popover` fill, `shadow-menu` and its own rounded corners, and sits above its neighbours. Nothing else changes: no handle icon, no outline, no scale.
- **Neighbours slide** out of its way (`transform`, `duration-base`, `ease-motion`) as its middle passes theirs; the gap is always where it will land.
- **Release:** it settles into the gap (the same transition, from where it was to its place), the new order shows at once and is saved. A drop where it started changes nothing and saves nothing.
- **Esc, a lost pointer or a window blur** cancel: everything slides back.
- **An open account moves with its folders**, as one block; the slot math works on blocks of any height.
- **The click that ends a drag** is swallowed, so a drop never opens the category or toggles the account.
- **The sidebar scrolls** when the pointer holds near its top or bottom edge during a drag (the thread drag's edge and step).
- One category or one account: nothing to sort, no drag.
- A list that changes under a drag (a category added in another window, an account removed) cancels the drag; nothing is saved.
- The focused sidebar (plan 108, one account) has nothing to sort.

### The keyboard

- **⌥↑ / ⌥↓** on a focused category or account row moves it one place; focus stays on it. The rows carry `aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"` and the move is announced in a polite live region: "Facturas, 2 of 6". The keymap has nothing on ⌥↑/⌥↓; the row's handler takes the key before the document's.
- Settings → Categories' Move up / Move down stay; they call the same helper.

### Saving

- **`accounts.reorder { ids }`** (RPC contract, both stores' `accounts.reorder`, same semantics as categories: given order, unlisted ones after, one unit, unknown ids ignored), and the backend broadcasts `accounts` (with their sync state, `emitAccounts`).
- **`lib/reorder.ts`**: `reorderCategories(ids)` and `reorderAccounts(ids)`. Optimistic: the app's list changes at once; the backend's answer wins; the newest request's answer only (two quick drags never flicker back). On failure the list goes back to what it was and a snack says so: "Couldn't save the new order. It's back as it was."
- Every place that lists accounts or categories (pickers, the palette, From, Settings) follows the stored order already.

### Implementation

- **`lib/sortable.ts`**, pure and unit-tested: `slotOf(blocks, from, dy)` (where a block whose middle moved `dy` lands), `shiftsFor(blocks, from, to)` (each block's offset while the gap is at `to`), `clampDy(blocks, from, dy)`, `moved(list, from, to)`.
- **`lib/sortable-install.ts`** binds it to a container: one delegated `pointerdown` on the group; items are `[data-sort-id]`, a drag starts only on their `[data-sort-handle]` (the category or account `NavItem`, never a folder row, the "+" or the sign-in key). Measured once at the start (and again on scroll). During the drag it writes `style.transform` on the items directly: **no React render** while dragging. On drop it sets the new order through `lib/reorder.ts`, and in the layout pass of the reordered render (a FLIP) clears the neighbours' offsets with no transition and starts the dragged block's settle from where it was.
- **`useSortable(ref, ids, onMove)`** in the sidebar for the categories (a new wrapper `div[data-testid=nav-categories]` around their rows) and the accounts (`accountsRef`).
- `:root[data-sorting]`: the grabbing cursor and no text selection while dragging (beside `data-dragging`).
- New strings (`en`, `es`): the announcement, the failure snack.

## Tests

- **Unit** (`lib/sortable.test.ts`): slots for equal and unequal blocks, up and down, clamping at both ends, shifts, `moved`.
- **Store conformance**: `accounts.reorder` sets every position in one unit, keeps unlisted ones after, ignores unknown ids, survives a reopen (both stores).
- **Backend**: `accounts.reorder` broadcasts `accounts` in the new order.
- **Unit** (`lib/reorder.test.ts`): optimistic, newest answer wins, rollback with a snack.
- **e2e** (`apps/web/e2e/sidebar-reorder.spec.ts`, one page through `scenario()`): drag a category two places down (the order shows, persists in the store and after a reload, the click didn't open it); drag an account up past another, open; Esc mid-drag changes nothing; ⌥↑ on a focused category moves it and keeps focus; a drag never changes the view.
- Visual: screenshots of a lifted row, light and dark, macOS and Lumen.

## Performance

- No React render during a drag (imperative transforms on a dozen nodes); one render of the sidebar for the new order. No new listeners at rest beyond one `pointerdown` per group.
- No store work beyond a dozen position updates.

## Out of scope

- Reordering favourites, an account's folders, or the standard views.
- Undo for a reorder (dragging back is the undo).
- Touch long-press (desktop app; the pointer path works for a mouse and trackpad).

## Revisions after the Codex review

Twelve points against the plan; what changed:

1. **A reorder cleared a "select all".** `setAccounts` and `setCategories` compared the Gmail-tab and hidden-category ids in list order, so moving two of them read as a change of membership. Both compare sets now (`reorder.test.ts` holds it).
2. **Broadcasts could undo an optimistic order.** Every `accounts` and `categories` event now goes through `withPendingOrder`: while a reorder is on its way its order is shown, whatever the event says.
3. **Rollback restored a stale snapshot.** A failure now reorders the list *as it is now* (entities untouched: an account's edit on its way stays) by the last order the backend said it holds (events and answers both record it). Two failures in a row end on the stored order, never on the first failed one.
4. **A tall open account.** The slot rule is the leading edge past a neighbour's middle, not middle past middle: a 400 px block passes a 32 px row within the 32 px it can move. Unit-tested both ways.
5. **Layout moving under a drag.** The pointer's offset is taken against the group's own top, read each frame, so a scroll or More's held rows letting go above it move the measured blocks alike.
6. **A keyboard context menu mid-drag** (⇧F10) cancels the drag; Esc is taken in the capture phase before menus and the document.
7. **Tooltips** are hidden while sorting. **⌥↑ ⌥↓ are listed** in the shortcuts dialog (⌘/) under a new "Sidebar" section.
8. **Focus.** The focused row is remembered before a commit and given back in the settle (React re-inserts a moved row, which drops focus); the e2e moves an account down with the keyboard and checks it. Only the commit's own settle restores it, never a later answer.
9. **Render budgets.** The groups bind through stable ref callbacks (module-level for the categories, `useCallback([])` for the accounts), so a render never rebinds or cancels a drag. The e2e asserts no `NavItem` renders during a drag; the More, account-toggle and thread-drag perf gates pass.
10. **Thread drops** onto a moved category are in the e2e; pressing a folder row under an open account drags nothing (the handle is the account's own row).
11. **Every ending cleans up**: drop in place, Esc, pointer loss, blur, unmount: the lifted and settling marks and transforms go after the settle (at once with motion off), and a double-frame fallback settles if no render comes.
12. **The first account is the default sender** for a new message outside an account (`compose.ts`). That's intended: the account you put first is your main one. Existing drafts keep their account.

## What the Codex code review changed

Three findings, each fixed with a scenario in `sidebar-reorder.spec.ts` ("with motion") that fails without it:

1. **A drag started while the last one settled left that row lifted.** A new drag clears every row's lift as well as its settle.
2. **Scrolling with the pointer still let the row drift away from it.** While dragging, the sidebar's scroll and a resize of More's rows above schedule a frame that places the row again.
3. **A drop mid-slide made the neighbour jump.** Where each row is seen is recorded before the drag's transitions are taken away, so a neighbour still sliding settles from where it was.
