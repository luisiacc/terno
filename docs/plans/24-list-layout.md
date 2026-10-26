# Plan 24: the List layout (Gmail-style, with category tabs)

- **Status:** planned. Implementation starts after plan 21 merges.
- **Builds on:** `402470a` (main after plan 18), and on plan 21 (resizable sidebar and list panels, sidebar "More"), which is in flight. Section 2.4 is the contract with it.
- **Numbering:** 17 and 21–23 are taken by running work, so this is 24.
- **Request (verbatim, sent with a screenshot of Gmail's list view and its category tabs):** "lets also have in settings the aiblity for users to have a view like this one here … which is more gmail-like, with the list of things, and when you open them, instead of opening to the side it like navigates to the email and the mail becomes the current view, so users can have that view, when that view is opened, we need the categories shown on top like it does here very nicely."
- **Already decided with the user:**
  - It is a setting: a Layout choice of **Split** (today's layout) or **List**.
  - In List, the thread list is full width. Opening a thread navigates to it, and the conversation becomes the main view. Esc or ⌘[ goes back to the list, restoring the scroll position, the selection and focus.
  - In List, category tabs run along the top of the list: All, Unread, the user's categories with counts, and a "+" that creates a category.
  - Dragging threads onto a tab moves them to that category. This is an exclusive move; adding a thread to several categories happens only through the right-click menu.

## 1. What exists

- **The shell** (`apps/web/src/app.tsx`) is a fixed three-column grid: `grid-cols-[var(--sidebar-w)_minmax(var(--list-min),var(--list-max))_minmax(0,1fr)]`.
  - Column 1 is `<Sidebar/>`.
  - Column 2 holds `<ThreadList/>` and `<SnackDock/>`.
  - Column 3 is `<main>`, which shows one of three things inside a `PaneBoundary` keyed by `selectedId`: `SelectionBar` (two or more threads checked, or a scope), `NewMessage` (while composing), or `Reader`.
  - The grid widths come from the design's `layout` tokens (`sidebar`, `listMin`, `listMax`, written as CSS variables by `gen:designs`).
  - There is no router: the page never calls `history.pushState` and nothing reads `location.hash`. `location.search` is read only for `?storage=`, `?mailbox=` and the demo flags (`web/connect.ts`, `rpc/connection.ts`).
- **App state** (`state/app.ts`, zustand) holds `view`, `accountId`, `categoryId`, `reviewCategoryId`, `query`, `listFilters`, `selectedId` (the cursor, which is also the open thread), `checked`, `anchorId`, `scope`, `compose` and `dialog`.
  - `readerOpen: boolean` exists and is set to `true` in five places (`keyboard.ts` move and `list.open`, `select.ts` `pressRow`/`releaseRow`, `thread-menu.tsx`, `drafts-strip.tsx`), but **nothing reads it**. This plan gives it a meaning.
  - `navigate()` resets the query, the selection and the scope.
- **The list** (`state/list.ts`): `reloadList()` runs whenever the view, account, category, review or query changes (a `useApp.subscribe`).
  - A new list selects its first row (`setApp({ selectedId: page.items[0] })`) unless `keepSelection` is passed.
  - `listKey()` is `[view, account, category, review, filter, query]`.
- **The thread list** (`components/thread-list.tsx`):
  - The `Header` shows a title in one of three kinds (title, display, greeting) and holds the search (a field, or a button that opens one).
  - Quick filters are either the filter button with "Filtered by" (the `menu` variant) or Lumen's chips (the `chips` variant: All, Unread, Attachments, Starred).
  - Below the header come the banners, the select-all banner and the drafts strip, then a TanStack virtualized `role=listbox` (`aria-activedescendant` is set imperatively; the listbox is not focusable).
  - Row height comes from `design.rows[density]`, and changing it re-measures in a layout effect.
  - `registerDesignAnchor` keeps the first visible row across a design switch.
  - `listScroller.scrollToIndex` is how j/k scroll the list.
  - `installDragController(listbox)` binds drag-to-category.
- **The row** (`thread-row.tsx`) has three layouts (`classic`, `avatar`, `large-avatar`). At compact density every layout already draws a single line (from · count · subject — snippet · marks · date). A row opens on **mousedown** (`pressRow`); `releaseRow` on click only collapses a multi-selection.
- **The reader** (`reader.tsx`):
  - A 52 px toolbar (organize, mark, respond and print groups), then a scroller with content capped at `--reader-max` and padded by `--reader-pad-x`.
  - `ReaderHeader` has three variants (`classic`, `chips-display`, `sender-card`).
  - Inline reply goes through `DraftSlot`, keyed by thread.
  - Mounting the reader on a thread calls `scheduleMarkRead` (a 450 ms dwell); unmounting calls `cancelMarkRead`.
- **The keyboard** (`lib/keyboard.ts`, and the pure resolver in `packages/core/src/keybindings/resolve.ts`):
  - j/k/↑/↓ move the cursor, and Enter/o run `list.open`.
  - Esc runs `reader.close`, which today only clears the checked rows.
  - e, #, !, s, u, l, v, r, a, f, c, `/`, ⌘K and the `g` sequences do what they say.
  - One document-level handler; desktop menu commands go through the same `HANDLERS`.
  - `TOGGLES` drops the desktop menu's echo of a key the renderer has just handled.
  - The mail iframe is same-origin and sandboxed; it forwards ⌘P and ⌘L to the page (`forwardPrintKey`, `forwardUnreadKey` in `mail-body.tsx`) because keys pressed inside a frame never reach the document.
- **Actions** (`lib/actions.ts` `act`, `lib/categorize.ts` `leaveView`): an action that removes the open thread from the view moves the cursor to the next thread (Superhuman-style), all optimistically.
- **Categories:**
  - The sidebar lists them in `categories` order, with unread counts (`counts.categoryUnread`), a Revisar sub-row or badge, and a `+` that creates one inline (`categories.create` with the next color, then `navigate({ categoryId })`, and `snack.error` on failure).
  - A category list is `navigate({ categoryId })`, which means view `"all"` plus that category, keyed `all||<id>`.
  - Sidebar items are `[data-drop-target=<id>]`. `drag-install.ts` measures every `[data-drop-target]` at drag start, **clipped to the sidebar's `[data-drop-scroll]` rect**, and on drop flies the ghost to the first `[data-drop-target=<id>] [data-slot=category-dot]`. A drop calls `moveToCategory(…, { source: "dnd" })`, which is exclusive and offers the categorization snackbar.
  - `useDropState(id)` is a per-target selector, so a target change re-renders only the items involved.
- **Counts** (`Counts`) are computed by the store and pushed by the backend as a throttled `counts` event (`core.ts` `sendCounts`):
  - SQLite: `threads_unread_inbox` (a partial index on `account_id`) answers inbox unread per account; `thread_categories_c` joined with `threads` answers category total and unread, excluding trash and spam.
  - IndexedDB computes the same over its in-memory tables.
  - The sidebar reads them. No new query is needed for the tabs.
- **Quick filters** (`lib/unread-filter.ts`) are remembered per mailbox (`view|account|category`) across launches. ⌘L toggles unread. A search inherits the filter of the mailbox it searches.
- **The docked snackbar** (plan 13) lives inside the list column, absolutely positioned 8 px from its edges. While it shows, its measured inset becomes the virtualizer's `paddingEnd`/`scrollPaddingEnd`. Plan 13 anticipated this plan: "a future [layout] would mount the dock in its main pane".
- **Composing** (plan 16):
  - Replies, reply-all and forwards open inline in the conversation (`DraftSlot`).
  - A new message (`c`) takes the reader pane (`NewMessage`). Esc leaves it (autosaved, and kept in the drafts strip). `installComposeFollowsSelection` leaves it when the selection moves.
- **Designs** (plan 15, `packages/ui/src/designs`): macOS, Atelier and Lumen differ structurally through `DesignVariants`:

  | Variant | macOS | Atelier | Lumen |
  |---|---|---|---|
  | compose | list-header | sidebar-outline | sidebar-pill |
  | listHeader | title | display | greeting |
  | search | field | field | button |
  | quickFilters | menu | menu | chips |
  | row | classic | avatar | large-avatar |
  | categoryReview | sub-rows | inline-badge | inline-badge |
  | readerHeader | classic | chips-display | sender-card |
  | replyAction | icons | icons | pill |

  `variant()` makes a new value a compile error until every map handles it. `designs.spec.ts` checks that roles, names, test ids and shortcuts are shared, and flows tagged `@design` run in all three Playwright projects.
- **Settings** go through `AppSettings` (`core/rpc/contract.ts`), `settingsPatchSchema`, `DEFAULT_SETTINGS` (`backend/settings.ts`) and the export/import `GENERAL_KEYS` (`backend/import.ts`). Density is in General → List.
  - Appearance is cached in `localStorage["terno:appearance"]`; `public/theme.js` paints `data-design` and the theme before React, and `useAppearance` seeds itself from what theme.js painted.
- **Desktop:**
  - `will-navigate` blocks anything that isn't `app://`.
  - `did-start-navigation` reconnects the backend port only when `!isInPlace`, so same-document history changes are already harmless.
  - Menu commands are allowlisted in `print-commands.ts` (`MENU_COMMANDS`).
  - There is no mouse back/forward handling (Electron emits `app-command` only on Windows and Linux; on macOS the extra buttons reach the page as `mouseup` with `button` 3 or 4).
- **Plan 21** (in flight) makes the sidebar and list widths draggable and persistent, and puts Sent, Archive, All Mail, Spam and Trash behind "More". Assumed shape: two grid variables (`--sidebar-w`, `--list-w`) fed from persisted values, and two handles (sidebar|list and list|reader).

## 2. Design

### 2.1 The setting

- Add `layout: "split" | "list"` to `AppSettings`.
  - The default is `"split"`, so nothing changes for anyone who doesn't opt in.
  - Add it to `settingsPatchSchema`, `DEFAULT_SETTINGS` and `GENERAL_KEYS` (it travels in exports).
- **Settings → General → List** gets a **Layout** row above Density: a two-option segmented control (`ToggleGroup`, radio semantics) labelled "Split" and "List", each with a tiny glyph (two panes, one pane). Hint: "Split shows the conversation next to the list. List gives the list the full width and opens a conversation in its place."
- **First paint:** the appearance cache gains `layout`. theme.js sets `data-layout` on `<html>`, and `useAppearance` seeds `layout` from it, so a List user never sees a Split frame at launch (the same mechanism as `data-design`).
- **Live switch:** changing the setting applies immediately, using the design-switch anchor mechanism (`captureDesignAnchors` runs before the change and restores after it) so the first visible row stays put.
  - **Split → List** lands on the list page, with the open thread as the cursor (in view).
  - **List → Split** closes the page (§2.3) and shows the cursor in the reader.
- **Command palette:** two entries, "Use List layout" and "Use Split layout" (only the other one shows).

### 2.2 The shell in List layout

```
┌ sidebar (--sidebar-w) ┬───────────── content (minmax(0, 1fr)) ─────────────┐
│                       │  list page:   header · tabs · banners · listbox     │
│                       │  thread page: Reader (same component), full width   │
│                       │  compose page: NewMessage, full width               │
│                       │  SnackDock (bottom-left of the content cell)        │
└───────────────────────┴─────────────────────────────────────────────────────┘
```

- **Grid:** `grid-cols-[var(--sidebar-w)_minmax(0,1fr)]`. The content cell is `relative` and holds two layers:
  - **The list section**, always mounted. While another page is up it gets `inert`, `visibility: hidden` and `data-covered`. It is never `display: none` and never unmounted:
    - its scroller keeps its `scrollTop` and its size, so the virtualizer keeps its range, measurements and mounted rows
    - rows keep receiving live updates, so Back shows the true state
    - `inert` takes it out of the focus order and the accessibility tree
  - **The page layer** (`absolute inset-0`), rendered only while the page is `thread` or `compose`: `<PaneBoundary area="reader">` around `Reader` or `NewMessage`. The Reader is not mounted on the list page, so the cursor never starts the mark-read dwell.
- **Which page is showing** is derived, not stored separately:
  - `compose !== null` → compose page
  - else `readerOpen && selectedId !== null` → thread page
  - else the list page
  - `readerOpen` is only meaningful in List; Split keeps ignoring it.
- **Who sets `readerOpen`:**
  - **Opens:** a plain click on a row (§2.6), Enter/o (`list.open`), the context menu's Open, opening a draft from the drafts strip, and r/a/f from the list page (R3).
  - **Doesn't open:** j/k on the list page (`move()` stops setting it), ⇧/⌘-click, `x`, and the list's auto-selection of the first row.
  - **Closes:** `navigate()` (the sidebar, the tabs, `g` sequences, the palette), `setCategories` when the open category disappears, Esc and Back.
- **Bulk selection** (two or more checked, or a scope): there is no side pane to show `SelectionBar` in, so it renders as a compact toolbar row between the tab strip and the rows, with the same actions, test ids and shortcuts. It is a `variant="toolbar"` of the same component. The tabs stay visible, because a selection is usually what gets dragged onto them.
- **The docked snackbar** moves to the content cell in List, so it shows on every page. It is anchored bottom-left and capped at `min(100% - 1rem, 30rem)` wide, which keeps it a quiet strip rather than a full-width bar. Its inset still pads the virtualizer, and in List it also pads the reader's and composer's scrollers, so their last lines can always scroll clear of it.
- **New heavy UI:** none. The tab strip is small and lives in the entry chunk. The settings row lives in the lazy settings chunk.

### 2.3 Navigation state and history

There is one module, `apps/web/src/lib/page-history.ts`. Its pure core takes injected `history` and `location` objects so it can be unit-tested; it is bound once in `App`, and only in List.

- **The rule:** the page is app state, and the history only mirrors it. A `useApp.subscribe` watches the derived page and the open thread id. A `popstate` listener maps an entry back onto app state.
- **The stack:** the base entry is the list, and at most **one** Terno entry sits above it (a thread or compose page). Entries carry `history.state = { terno: 1, page: "thread", id, token }`. `token` is a random per-document value, so the module knows which entries it pushed.
- **Transitions:**

  | From → to | History |
  |---|---|
  | list → thread | `pushState({page:"thread", id}, "", "#/thread/<id>")` |
  | list → compose | `pushState({page:"compose"}, "", "#/compose")` |
  | thread → thread (j/k, an action's advance) | `replaceState`, **trailing-debounced 300 ms**. Holding j at key repeat would otherwise trip the browsers' history-call throttle: Safari throws `SecurityError` after 100 calls in 30 s, and Chrome starts throttling. |
  | thread or compose → list, by Esc, ⌘[, the Back button, `navigate()`, an action, or a layout switch | if the top entry is ours: `history.back()`, with `expectPop` set so the resulting `popstate` is absorbed. Otherwise `replaceState(base, "", "#/")`. |
  | popstate to an entry without `page` (Back) | `readerOpen: false`, or `leaveNewDraft()` on the compose page, then restore focus (§2.5) |
  | popstate to `{page:"thread", id}` (Forward) | `selectedId: id, readerOpen: true`. A thread that no longer exists shows the reader's existing "This conversation is no longer available" state, with Back. |
  | popstate to `{page:"compose"}` (Forward) | the draft is in the drafts strip, so this lands on the list (`replaceState` to the base) |

- **Back and forward inputs:**
  - **Keys:** two new commands, `nav.back` (`mod+[`) and `nav.forward` (`mod+]`). Both are in `TOGGLES`: one per press, and the desktop menu's echo is dropped. Otherwise ⌘[ would go back twice on desktop, once from the renderer and once from the menu accelerator.
  - **Esc:** `reader.close` goes back when a page is up in List; otherwise it clears the checked rows, as today. An inline draft keeps its own Esc (the editable context hides the global binding), so the first Esc collapses the draft and the second goes back.
  - **Desktop:** View menu items "Back" (⌘[) and "Forward" (⌘]) send `nav.back` and `nav.forward`, added to `MENU_COMMANDS`. The accelerators also work while focus is inside a mail frame.
  - **Web:** the browser's own Back and Forward (toolbar, ⌘[ in Chrome and Safari, mouse buttons, trackpad swipe) fire `popstate`, and that is all we need. The keydown handler calls `preventDefault` on ⌘[ so the browser doesn't also navigate; an e2e test asserts exactly one step.
  - **Mouse buttons on desktop:** a capture-phase `mouseup` listener runs only when `window.ternoDesktop` is defined and maps `button === 3` to back and `button === 4` to forward, calling `preventDefault`. It is also attached inside mail frames, next to `forwardPrintKey`. On the web the browser handles these buttons natively, so the listener isn't installed there (no double back).
  - **In mail frames:** Esc, ⌘[ and ⌘] are forwarded like ⌘L (a `forwardNavKey` next to `forwardUnreadKey`).
- **Deep links and reload:**
  - On the web, the hash never reaches the server or the service worker. On desktop it is an in-page navigation, so `will-navigate` doesn't fire and `did-start-navigation` reports `isInPlace` (no reconnect).
  - **At boot in List**, `#/thread/<id>` (`id` is a positive integer, validated):
    1. `replaceState(base, "", "#/")`.
    2. Select the id.
    3. `pushState` the thread entry.
    4. The first `reloadList()` runs with `keepSelection`, so the list's own auto-selection doesn't overwrite the id.

    So ⌘R or a web reload on a conversation comes back to it, and Back still lands on the list. `#/compose` at boot lands on the list (the draft is in the strip).
  - **At boot in Split**, a deep link selects the thread and the hash is then cleared. Split creates no entries.
  - The id is a local row id. It names no mail content, and the link means nothing on another device (§3).
  - `switchStorage`'s `location.replace` keeps `location.hash`, since it rewrites only the query.
- **Split is unchanged:** no entries, no hash; `nav.back` and `nav.forward` do nothing.

### 2.4 Panel widths with plan 21 (resizable panels)

- **Sidebar:** plan 21's sidebar width (`--sidebar-w`, persisted) and its sidebar|list handle apply in List exactly as in Split. It is one shared value, so switching layouts never moves the sidebar edge.
- **List width:** List doesn't use plan 21's list width (`--list-w`) or its list|reader handle.
  - The handle isn't rendered. Its separator element is skipped, so there is no dead focus stop.
  - The list column is `minmax(0, 1fr)`.
  - The persisted list width is neither read nor written while in List, so switching back to Split restores exactly the width the user dragged.
- **Thread and compose pages** take the whole content cell. Their content stays at the design's `--reader-max` (760–860 px), centered with `--reader-pad-x`. Reading width is a typographic choice, not a panel width.
- **Clamps:** plan 21's minimum widths for the list and reader don't apply in List. The window minimum (980 px on desktop) minus the widest sidebar plan 21 allows still leaves the content cell at least 640 px wide on desktop.
- **Integration:** if plan 21 lands with other variable or handle names, implementation step 1 adapts to them. The rule this plan fixes is "List reads only the sidebar width".

### 2.5 Focus, scroll and selection across pages

- **Opening a thread:**
  - Record `returnFocus = document.activeElement` if it is inside the list section and isn't `body`.
  - Focus the reader's subject heading (`h2`, `tabIndex=-1`, focused with `preventScroll`), so a screen reader reads the subject first and j/k, e and r keep working (the handler is document-level).
  - A newly opened compose page focuses its To field, as today.
- **Going back:**
  1. Clear `data-covered` and `inert` in the same commit.
  2. In the next frame, focus `returnFocus` if it is still connected and visible. Otherwise focus the listbox, which gets `tabIndex=-1` in both layouts so it can take focus programmatically without joining the tab order. `aria-activedescendant` already points at the cursor, so a screen reader announces the row.
- **Scroll:** nothing to restore. The scroller never lost its offset (§2.2). If j/k moved the cursor while reading, `listScroller.scrollToIndex` kept the cursor in view underneath (align auto), so Back shows it without a jump. An e2e test asserts `scrollTop` is identical when the cursor didn't move.
- **Selection:**
  - `checked` is cleared by a plain click, as today; Back doesn't change it.
  - The cursor is the last thread read.
- **Actions from the thread page:** an action that takes the open thread out of the list returns to the list, with the cursor on the next thread (`act`/`leaveView` have already moved it). This covers e, #, !, v to another category, and dropping it from a filtered list. It matches Gmail's default and keeps the snack visible beside the row it is about. z undoes and stays on the list.

  Actions that keep the thread (s, u, l, a reply sent) stay on the page.

  u (mark unread) also goes back. Mail and Gmail both treat "mark unread" from a conversation as "done reading it for now", and staying on the page would immediately re-arm the 450 ms read dwell. This is one rule in `act`'s List branch.
- **Search:** `/` or ⌘F from a page goes back first, then focuses the search field, so the field is never focused inside an inert section.

### 2.6 Opening a row in List

- `pressRow` (mousedown) moves the cursor and handles modifiers exactly as today, **but doesn't open in List**. Opening on mousedown would show the thread page under a drag that is just starting.
- **The click** (`releaseRow`) opens: a plain primary click with no drag in between sets `readerOpen: true`. The drag controller does **not** suppress the click that follows a drag today, so it gains a one-shot click suppressor (R8).
- Double-click needs nothing extra: the first click opens.
- **Middle-click and ⌘-click** keep their meanings (⌘-click toggles). There is no "open in new window" (§3).

### 2.7 Category tabs

- **Where:** the last row of the list header, in List only, when the list is the inbox (any account) or a category list, with no search query and not in Revisar. Elsewhere (Sent, Archive, Starred, Trash, Spam, All Mail, search results, Revisar) the header is as today. The tabs choose a slice of the inbox, and those lists have nothing to slice.
- **The tabs**, in order:

  | Tab | Selected when | Click does | Count shown |
  |---|---|---|---|
  | All | view inbox, no category, filter ≠ unread | `openTab("all")` | none |
  | Unread | view inbox, no category, filter = unread | `openTab("unread")` | inbox unread (`inboxUnread`, or `inboxUnreadByAccount[accountId]`) |
  | each category, in sidebar order | `categoryId === c.id` | `openTab(c.id)` | `categoryUnread[c.id]` when > 0 |

  The strip ends with "More ▾" (only when something overflows) and "+".

- **`openTab`** (`lib/tabs.ts`) is one `setApp`, so there is one list reload:
  - **All:** `navigate({ view: "inbox" })`, and the inbox mailbox's filter is cleared.
  - **Unread:** `navigate({ view: "inbox" })`, with the inbox mailbox's filter set to `"unread"` in the same patch (`withFilter` + `saveListFilters`).
  - **A category:** `navigate({ categoryId })`, the same destination as the sidebar item. The account scope is kept, as with the sidebar.
- **How the tabs relate to the sidebar and the quick filters** (one source of truth, no duplicate controls):
  - **Tabs and sidebar** are two views of the same app state (`view`, `categoryId`, `listFilters`), so they always agree: clicking either highlights both. The sidebar keeps its Categories section because it does things the tabs don't: it reaches a category from Sent or Archive, where tabs are hidden; it holds Revisar; it has the rename, color and delete context menu; and it accepts drops for categories that overflow the strip.
  - **Tabs and quick filters:** in List, Lumen's quick-filter chips are replaced by the tab strip, because All and Unread are the same choice. Every design shows the `menu` variant's filter button and "Filtered by" line instead, which refines any list (Attachments, Starred, or Unread inside a category) where tabs can't. ⌘L is unchanged: on the inbox it flips between the All and Unread tabs, and on a category it filters that list, shown by the "Filtered by" line. In code this is one derived value, `effectiveQuickFilters = layout === "list" ? "menu" : design.variants.quickFilters`.
- **Counts:**
  - They come from the existing `counts` state (index-backed in both stores, §1, pushed as a throttled event). There is no new RPC and no per-tab query.
  - Each tab reads its own number through a per-tab selector, so a count change re-renders only that tab.
  - Formatting matches the sidebar (`formatNumber`, tabular figures).
  - Category counts are account-wide in the sidebar and stay so here (§3).
- **"+"** opens a small popover anchored to it, holding a "Category name" field:
  - Enter creates the category with the next color, then navigates to it, so its tab is selected.
  - Esc or clicking outside cancels, and focus returns to "+".
  - Errors use the same `snack.error` as the sidebar. The sidebar's create logic moves to `lib/categories.ts` `createCategory(name)` and both callers use it.
- **Overflow at narrow widths:**
  - The strip is one row. All and Unread are pinned. Categories fill the remaining space in order, then "More ▾" holds the rest, then "+".
  - The selected category is never hidden: if it would overflow, it takes the last visible slot and the category that was there moves into More.
  - The fit is a pure function, `fitTabs(widths, available, selectedIndex, moreWidth, plusWidth) → { visible, overflow }` (unit-tested).
  - Widths come from an `aria-hidden` mirror row holding every label and count, measured by one `ResizeObserver` on the strip plus one on the mirror. This catches resizes, font loads, design switches and count changes. There is no polling and nothing per frame.
  - **More ▾** is a `DropdownMenu` of `menuitemradio`s (the selected one checked), with counts. Picking one calls `openTab`.
  - Below the width of the pinned tabs plus More and "+", which only a very narrow web window reaches, the strip scrolls horizontally and its edge fades with a mask.
- **Drag and drop onto tabs:**
  - Category tabs carry `data-drop-target={c.id}` and `useDropState(c.id)`, so a drop is the same exclusive `moveToCategory(…, { source: "dnd" })` with the same snackbar. The over and "already here" states use the sidebar's tokens.
  - All, Unread, More and "+" aren't targets.
  - **`drag-install.ts` changes** (with unit tests):
    1. `measureTargets` clips each target to its **own** nearest `[data-drop-scroll]` ancestor, or the viewport if it has none, instead of always clipping to the sidebar's. Today a tab above the sidebar's nav would be clipped away.
    2. `hitTest` returns the hit rect (with its element), not just the category id, and `flyGhost` flies to the dot of the element actually hit, not to the first `[data-drop-target=<id>]` (which would be the sidebar's).
    3. Two elements with the same id (the tab and its sidebar item) both show "over". That is intended, and it costs at most four item renders per target change (the perf gate's budget becomes "items per target change ≤ 4").

### 2.8 Rows at full width

- A list hundreds of pixels wider than today's column would show today's stacked rows with lots of empty space on the right. In List, when the scroller is at least **720 px** wide (16 px hysteresis, measured by a `ResizeObserver`), rows use the **wide** arrangement:
  - one line: avatar (if the design has one) · from (a fixed column, `clamp(9rem, 18%, 14rem)`, so subjects line up as in Gmail) · count · subject — snippet (flex, truncated) · draft · marks · date
  - it is today's compact arrangement with an aligned "from" column, so all three layouts keep their character (classic has no avatar and keeps its hairline; avatar and large-avatar keep their avatars and unread treatment)
- **Heights:** the design type gains `rows.wide`, the comfortable-density height of a wide row (macOS 44, Atelier 52, Lumen 56), and `avatar.rowWide` (0, 26, 32). Compact density uses `rows.compact` and `avatar.rowCompact`, as today. The type forces every design to decide these values (§2.10).
- **Switching** between wide and stacked (a resize across 720 px) changes `height`, which runs the existing re-measure layout effect. The first visible row is kept with the same capture-and-restore code as `registerDesignAnchor`, factored so the resize path can call it.
- Roles, ids, handlers, `data-testid`s and the per-row selectors don't change. A row still re-renders only when its own state changes.

### 2.9 Reply and compose on the thread page

- **The reader is the same component.** The thread page adds a **Back** button at the start of the toolbar (ChevronLeft, `no-drag`), named "Back to {mailbox}" (for example "Back to Inbox" or "Back to Invoices"), with a tooltip showing Esc.
- At the end of the toolbar, two quiet buttons: **Newer** and **Older** (ChevronUp and ChevronDown, with tooltips for k and j). Their loading and disabled rules are in R10.
- r, a and f open the inline draft at the end of the conversation, as in Split (`DraftSlot` is keyed by thread, autosaves, and can be undone exactly). Sending keeps the page, and the sent message appears in the conversation.
- **c (new message) opens the compose page.** `NewMessage`, at full width with the same capped column, pushes `#/compose`.
  - Esc in the composer (`leave(key, true)`) closes the page through the history rule (§2.3). The draft is autosaved and stays in the drafts strip.
  - Back does the same through `leaveNewDraft()`.
  - Sending returns to the list.
  - `installComposeFollowsSelection` is unchanged, so opening a thread from the drafts strip replaces the compose page with the thread page (`replaceState`).
- Opening a draft from the drafts strip opens its thread page with that draft shown inline (`draftShown`), as today.

### 2.10 Per-design variants

- **A new variant, `categoryTabs: "underline" | "pill"`**, in `designs/types.ts`:
  - **macOS: `underline`.** 13 px `type-nav` labels in `--muted-foreground`; the selected one in `--foreground` at the strong weight, with a 2 px `--primary` indicator on the strip's bottom hairline. Counts follow the label in muted tabular figures. The tab height is `--nav-height`.
  - **Atelier: `underline`.** The same structure with Atelier's tokens: Instrument Sans `type-nav`, the indicator in `--foreground` (ink), radius from the ladder. The serif stays in the title above.
  - **Lumen: `pill`.** Its chips' look carried over (`rounded-full`, `bg-muted`, selected `bg-primary text-primary-foreground`, `h-7`), with counts inside the pill. This replaces the chip row, so Lumen's header keeps its rhythm.
  - Roles, names, test ids (`list-tabs`, `list-tab-all`, `list-tab-unread`, `list-tab-<id>`, `list-tabs-more`, `list-tabs-new`) and keyboard behavior are identical in all designs. `designs.spec.ts` gains the tab strip in its shared-parts check.
- **New design values** that every design must set: `rows.wide`, `avatar.rowWide` (§2.8). They are generated into CSS by `gen:designs`.
- **Unchanged variants:** `listHeader` (the greeting reads well across a full width), `search`, `row` (each gets its wide arrangement), `readerHeader` and `replyAction` (the page is the same reader).
- **Rules from AGENTS.md:** no colors or durations in a design (token references only); text only on pairs in `CONTRAST_PAIRS`; sizes and radii only from the scale and ladder (`source-scan.test.ts`).

### 2.11 Motion (within `--motion`, ≤ 100 ms)

- **Opening a page:** the page layer fades in from `opacity 0` with a 4 px `translateX` at `--motion-base`. Under `data-motion=off` (the motion setting at 0, or reduced motion) it appears instantly.
- **Back:** instant, with no exit animation. An exit animation would hold focus and the list behind it, and the list is already painted underneath.
- **j/k on the thread page:** no animation. Navigation never animates (an existing rule: the reader's star button is keyed by thread for the same reason).
- **Tabs:** the underline indicator slides between tabs at `--motion-fast` (Base UI's `Tabs.Indicator` with CSS variables). The pill background changes color with the existing chip transition. A drop's "over" state uses the sidebar's existing scale and ring.
- **Layout switch:** one frame with transitions off, the same `data-theme-switching` treatment as a design switch.

## 3. Out of scope

- History entries for mailbox changes, searches or tabs. Back and Forward move only between the list and a page.
- Deep links that carry the mailbox, links shareable across devices or profiles, `mailto:` handling, and opening a thread in a new window.
- Trackpad swipe gestures on desktop (the BrowserWindow `swipe` event).
- Gmail's per-row checkboxes and hover actions, and a reading pane inside List (below or beside the list).
- Inbox-only category tabs (Gmail's partitioned inbox, where Promotions is only inbox mail) and account-scoped category counts. Tabs show what the sidebar shows (§2.7).
- Dropping onto categories hidden in "More ▾" (spring-loaded menus). The sidebar takes those drops.
- Reordering tabs, hiding categories from the strip, and per-tab shortcuts (⌘1…⌘9).
- An "after archiving, open the next conversation" preference. List goes back to the list (§2.5).
- A one-column narrow layout for Split.

## 4. Strings (en and es together; `t()` everywhere)

| Key | en | es |
|---|---|---|
| `settings.general.layout` | Layout | Disposición |
| `settings.general.layout.hint` | Split shows the conversation next to the list. List gives the list the full width and opens a conversation in its place. | Dividida muestra la conversación junto a la lista. Lista ocupa todo el ancho y abre la conversación en su lugar. |
| `settings.general.layout.split` | Split | Dividida |
| `settings.general.layout.list` | List | Lista |
| `list.tabs.label` | Inbox sections | Secciones de la bandeja |
| `list.tabs.unreadCount` | {name}, {count} unread | {name}, {count} sin leer |
| `list.tabs.more` | More | Más |
| `list.tabs.moreLabel` | {count} more categories | {count} categorías más |
| `reader.back` | Back to {mailbox} | Volver a {mailbox} |
| `reader.newer` | Newer conversation | Conversación más reciente |
| `reader.older` | Older conversation | Conversación anterior |
| `shortcuts.back` | Back to the list | Volver a la lista |
| `shortcuts.forward` | Go forward | Avanzar |
| `menu.back` | Back | Atrás |
| `menu.forward` | Forward | Adelante |
| `palette.layout.list` | Use List layout | Usar la disposición en lista |
| `palette.layout.split` | Use Split layout | Usar la disposición dividida |

- **Reused keys:** `list.filter.all` and `list.filter.unread` (the All and Unread tabs), `sidebar.newCategory` and `sidebar.categoryName` (the "+" button and its field), `sidebar.alreadyHere` (the drop state).
- **Shortcuts dialog:** under Navigate, `reader.close` is shown as "Back to the list / Deselect".
- The type check fails if either locale misses a key.

## 5. Accessibility

- **The tab strip:**
  - Base UI `Tabs` gives `role=tablist` (named "Inbox sections") and `role=tab` with `aria-selected`.
  - Roving tabindex: ←/→ move, Home/End jump, and activation is automatic. A list reload is cheap and the latest answer wins (`reloadList` seq).
  - Each tab's `aria-controls` points at the list's `role=tabpanel` wrapper, which exists only while tabs show and is labelled by the selected tab.
  - Counts are in the accessible name ("Invoices, 3 unread"). The visible number is `aria-hidden`.
  - "More ▾" (`aria-haspopup=menu`, named "N more categories") and "+" are buttons after the tablist, not tabs.
  - ↓ from a focused tab is still `list.next` (the document handler).
- **Pages:**
  - Opening focuses the subject heading. Back restores focus (§2.5).
  - The covered list is `inert`, so no hidden control can be reached.
  - The Back button has a visible tooltip and an accessible name that says where it goes.
- **The selection toolbar** is a `role=toolbar` with the same named buttons as `SelectionBar`.
- **Checks:** axe-clean in light and dark, in all three designs, on the list page with tabs, the thread page and the compose page. AA contrast for the tab text, its count and the indicator against the pane (pairs in `CONTRAST_PAIRS`; the contrast suite covers them).
- **Reduced motion:** no transitions (§2.11).

## 6. Tests

### Unit (vitest)

- **`page-history`**, driven by a fake `history` and `location`:
  - push on open; debounced replace on j/k (holding j for 3 s issues at most one call per 300 ms)
  - `back()` plus an absorbed `popstate` on Esc and on `navigate`
  - `replaceState` when the top entry isn't ours
  - Forward reopens; a Forward to compose lands on the list
  - parsing a deep link at boot (valid id, garbage, negative, huge) and the boot sequence (base, then push, then `keepSelection`)
  - no history calls at all in Split
- **The resolver:** `mod+[` → `nav.back`, `mod+]` → `nav.forward`. Esc's precedence: snackbar, then editable, then `reader.close`.
- **`fitTabs`:** everything fits; overflow; the selected category kept visible; nothing but the pinned tabs fits; RTL-neutral (widths only).
- **`openTab`:** All, Unread and a category each produce one `setApp`, with the right `listFilters` and the same mailbox key as the sidebar.
- **`drag-install`:** per-container clipping (a target outside the sidebar is not clipped by it); `flyGhost` picks the element actually hit.
- **Settings:** `layout` default, patch validation, export/import round-trip (`GENERAL_KEYS`), and the appearance cache and `theme.js` `data-layout`, including invalid values falling back to split.
- **`act` in List:** an action that removes the open thread, and u, return to the list with the cursor on the next thread; s and l stay on the page.
- **Rows:** the wide arrangement past 720 px and the hysteresis.

### e2e (`apps/web/e2e/list-layout.spec.ts`)

The core flows are tagged `@design`, so they run in macOS, Atelier and Lumen.

- Switching to List in Settings → full-width list with tabs; switching back → Split, with the list width plan 21 persisted unchanged.
- **Click opens the thread page; Esc returns:**
  - `scrollTop` is identical (scrolled 300 rows deep first)
  - the cursor row is the same and is `aria-selected`
  - focus is on the listbox, or on the control that had it
- ⌘[ goes back and ⌘] reopens. On the web: `page.goBack()` and `page.goForward()` do the same. Pressing ⌘[ moves exactly one step.
- **Mouse back:** a `mouseup` with `button: 3` goes back on desktop (in the packaged smoke) and is not double-handled on the web.
- Holding j on the thread page moves through threads, then one Back returns to the list with the cursor (now further down) in view.
- e on the thread page → back on the list, cursor on the next thread, snack in the dock; z restores the thread and stays on the list.
- r on the thread page → inline draft, typed into, autosaved; Esc collapses the draft and a second Esc goes back. c → compose page; Esc → list, with the draft in the strip.
- **Deep link:** reloading on `#/thread/<id>` comes back to that thread, and Back lands on the list.
- **Tabs:**
  - All / Unread / category selection matches the sidebar highlight.
  - The Unread tab equals ⌘L on the inbox.
  - Counts drop after reading a thread (counts event).
  - "+" creates a category, navigates to it, and Esc returns focus to "+".
  - The tabs are hidden in Sent and in a search.
- **Drag a row onto a tab:**
  - The thread ends up in that category only, even if it was in two before.
  - The snackbar is offered.
  - The ghost flies to the tab's dot.
  - Dropping a thread on the category it is already only in → "already here", no change.
- **Overflow:** at a narrow viewport, More holds the rest; selecting a category from More puts it in the visible slot; the keyboard reaches everything.
- **Selection toolbar:** with two threads checked, the toolbar shows under the strip (the tabs stay), and its actions work.
- **Visual baselines,** light and dark, per design: the list page with tabs, the thread page, the compose page. Look at them.
- **axe**, in light and dark, on the three pages.
- **The whole existing suite** still passes in Split (the default): Split's behavior doesn't change.

### UI perf (`apps/web/e2e/perf.spec.ts`, per design)

- **Opening a thread** (cached detail): keypress or click → first frame showing the reader ≤ 50 ms.
- **Back:** list painted ≤ 50 ms, with:
  - the **same listbox element** (an identity check through a `WeakRef` on `window`, so no remount)
  - `ThreadList` renders ≤ 1 per transition (a new `renderProbe("ThreadList")`)
  - `ThreadRow` renders ≤ 2 per open and back (the cursor's old and new rows)
  - the mounted rows are the same set before and after, and bounded by visible rows plus overscan (virtualization intact)
  - `scrollTop` unchanged
  - measured with 2,000 threads loaded and scrolled deep
  - **an injected-regression twin:** the same measurement with the list keyed by page (forcing a remount) must fail the gate
- **Holding j on the thread page** at key-repeat rate: every frame ≤ 50 ms, and at most one history call per 300 ms.
- **Switching tabs:** commit within a frame; rows re-render only for the new list.
- **Dragging onto tabs:** the existing drag gates with the tabs present: drag start within a frame, no row renders, ≤ 4 target items rendered per target change.
- **Wide rows:** the sustained-j and continuous-scroll gates also run in List at 1,400 px, per design and density.

### Desktop

`pnpm dist:mac` and `test:smoke`, in List:

- the View menu's Back sends `nav.back` once (no echo)
- mouse button 4 (`button: 3`) goes back
- ⌘R on a thread page reconnects once and comes back to the thread (the hash survives, `isInPlace` is not misread)
- `will-navigate` is not triggered by the hash

## 7. Performance and resources

- **No backend change.** Tab counts reuse the throttled `counts` event (index-backed in SQLite; IndexedDB as today). Queries at 50k+ threads are unchanged.
- **No polling and no timers at idle.** The one debounce (`replaceState`) runs only while j/k is moving and clears itself. The two `ResizeObserver`s fire only on resize.
- **The covered list costs nothing per frame.** It is `visibility: hidden` and doesn't paint. It isn't laid out again unless the window resizes or rows change, it doesn't scroll, and its rows render only on their own data changes.
- **Memory:** one extra mounted surface at most: the reader, which Split already keeps mounted all the time.
- **Bundle:** the tab strip and `page-history` add a few KB to the entry chunk. The settings row is in the lazy settings chunk. Nothing heavy loads before List is turned on.

## 8. Implementation order (atomic commits)

1. Rebase on plan 21. The List grid uses its sidebar variable, and its list handle is skipped in List (§2.4).
2. The setting: contract, schema, defaults, import keys, appearance cache, `theme.js` `data-layout`, the General → List row, en/es strings.
3. The shell: the List grid; the always-mounted list section with `inert`/`data-covered`; the page layer; the derived page; the `readerOpen` writers and `navigate()`; opening on click in List (§2.6); the dock in the content cell.
4. `page-history`: push, replace, back, deep links and boot; `nav.back`/`nav.forward`; the menu items; mouse buttons on desktop; frame key forwarding.
5. Focus, scroll and the action rules (§2.5); Back, Newer and Older in the reader toolbar; the compose page.
6. Wide rows: the `rows.wide` and `avatar.rowWide` design values, the wide arrangement, the resize path keeping the anchor.
7. Tabs: the `categoryTabs` variant, `openTab`, counts, "+" with the shared `createCategory`, overflow with `fitTabs`, the effective quick filters.
8. Drag onto tabs: per-container clipping, the fly target.
9. The selection toolbar variant.
10. e2e, visual baselines (light and dark, three designs), axe, UI perf gates, the desktop smoke.

## Revisions after the Codex review

Codex (`codex exec -s read-only`) was asked for at most 12 concrete points against the code. It made 12, and all 12 hold up against the code. Each revision below overrides the section it names.

- **R1. Leaving the composer reopened the previous thread.**
  - The problem: `leaveNewDraft()` and a successful send (`compose.ts` `send`) clear only `compose`, and `readerOpen` survives. With the derived page, thread → compose → Esc would show the thread again.
  - The revision:
    - A single `closePage()` in List clears `compose` and `readerOpen` in one `setApp`.
    - Esc, Back, send and discard all go through it, and autosave is unchanged.
    - **c from the thread page** *replaces* the thread entry with `#/compose` instead of pushing on top of it, so the stack stays base plus one, and leaving the composer always lands on the list.
  - Tests: Esc, Back, send and discard from a compose page that was opened from a thread page.
- **R2. A hidden bulk selection could be acted on from the reader.**
  - The problem: `list.open` sets only `readerOpen`, while `currentTargets()` prefers the checked rows and the scope. Split avoids this because `SelectionBar` replaces the reader.
  - The revision: in List, every explicit open (Enter/o, click, the menu's Open, r/a/f) clears `checked` and `scope` in the same patch, as a plain click already does. The thread page therefore never has a hidden selection, and its actions target exactly the open thread.
  - Test: check 3 rows, press Enter, press e → only the cursor's thread is archived.
- **R3. r/a/f on the list page created an invisible draft.**
  - The problem: `openCompose("reply" | "replyAll" | "forward")` opens the inline draft without opening the conversation.
  - The revision: on the list page these first open the cursor's thread page (push), then run `openCompose`. Its existing `intent` counter cancels a stale open, and explicit `draftFocus` puts the caret in the draft.
  - Tests: all three shortcuts, with and without an existing draft on the thread.
- **R4. A background refresh shrank a deep list under the page.**
  - The problem: `reloadList({ keepSelection })` caps a same-view refresh at 500 rows (`state/list.ts`), and every `changed` event triggers one (`boot.ts`). A list loaded 2,000 rows deep would shrink while you read, clamp `scrollTop` and lose the cursor's row.
  - The revision:
    - **While the list is covered**, `changed`-driven refreshes are deferred: one dirty flag, no list work while a page is up, which also fits "low resources". Optimistic row patches from actions still apply.
    - **On Back,** if the list is dirty, one refresh runs. It refetches the loaded window in pages of at most 500, chained by cursor, swaps it in once, and restores the anchor (the first visible row's id and its offset) with the code factored out of `registerDesignAnchor` (§2.8).
    - Split keeps today's behavior.
  - Tests: Back after the read dwell, and after unrelated incoming mail, with the cursor beyond row 500 → same row at the same offset.
- **R5. The history needed ordering rules.**
  - The problem: `history.back()` is asynchronous, so a reopen before its `popstate` arrived, or a late debounced replace, could write to the wrong entry.
  - The revision: `page-history` is a serialized state machine with states `idle` and `traversing(gen)`:
    - **Before any push or back,** a pending replace is flushed synchronously if it is still for the current top entry, else cancelled. Closing cancels it.
    - **While traversing,** a push request is queued and runs on the matching `popstate`. A 500 ms fallback catches a `popstate` that never arrives (Electron with no previous entry) and treats the traversal as done.
    - **A `popstate` that doesn't match** the expected generation is treated as user navigation.
  - Tests: open → Esc → open before `popstate`; Back pressed repeatedly; j → Back → Forward within 300 ms.
- **R6. Forward entries weren't scoped to their list or storage.**
  - The revision: entry state is `{ terno: 1, page, id, token, list: listKey(), mailbox: mailboxName() }`.
    - A Forward (or a boot deep link) whose `list` differs from the current list, or whose `mailbox` differs from the current one, is dropped: the entry is replaced by the base and the app stays on the list. Boot deep links carry only the id; they are honored only when the hash was written by this mailbox. The hash becomes `#/thread/<id>`, and the mailbox is checked through `history.state`, which survives a reload.
    - `switchStorage` now **clears** the thread hash. The plan said it was kept, but on another store the same id names other mail.
  - Tests: Back → change mailbox → Forward stays on the list; a storage switch drops the hash.
- **R7. List would auto-open the first thread at boot.**
  - The problem: `readerOpen` defaults to `true`, and the first list load selects row 0.
  - The revision: `readerOpen` defaults to `false`, which Split ignores. Only a validated deep link opens a page at boot, and it is applied before the first `reloadList` (with `keepSelection`).
  - Tests: cached and backend-confirmed List settings, with an empty hash, an invalid hash and a foreign-mailbox hash → the list page, no `threads.get`, no read dwell.
- **R8. Drag follow-ups.**
  - The problem: the plan wrongly claimed the drag controller suppresses the click after a drag (`onUp` only calls `ctl.up`). Also, `hitTest` returned only a category id, so with duplicate targets the plan couldn't tell which element was hit.
  - The revision:
    - After a drag ends (drop or cancel), a one-shot capture `click` listener on `window` swallows the next click and removes itself on the next frame.
    - `hitTest` returns the rect, and the rect carries its element. `target()` and `drop()` pass it through, so the "over" highlight and the fly-to-dot use the element actually under the pointer. The sidebar item and the tab for the same category still both show "over", which keeps the item-render budget at 4.
  - Tests: a cancelled drag doesn't open the row; a drop back over the rows doesn't open; moving between the sidebar item and the tab of the same category.
- **R9. Focus on open.**
  - The problem: the subject heading doesn't exist while the reader shows its skeleton, and focusing it later could steal focus from an explicitly focused draft.
  - The revision: focus goes to the reader `section` (`tabIndex=-1`, `aria-labelledby` the subject), which exists from the first frame, through skeleton, loaded and gone states. When a `draftFocus` request is part of the open (R3, the drafts strip), the section isn't focused and the draft takes focus. Back before the load completes restores focus as usual.
  - Tests: a slow load (delayed `threads.get`), and Back before it completes.
- **R10. Newer and Older, and j at the end of the list.**
  - The problem: `move()` clamps at the last loaded row, and pagination comes from the virtualizer's range effect, which doesn't run while the list is covered.
  - The revision: one `step(delta)` serves j/k and Newer/Older.
    - At the last loaded row, with `nextCursor` set, it awaits `loadMore()` and then moves. While loading, Older shows a busy state (`aria-busy`). A failed load leaves the cursor where it is and shows `snack.error`.
    - Older is disabled when the list is complete and the cursor is last; Newer is disabled at row 0.
    - A thread not in the loaded list (a deep link, a draft's thread) disables both buttons, and j/k do nothing until Back.
  - Tests: crossing a page boundary from the thread page; navigating from an id that isn't in the loaded list.
- **R11. Measuring tab overflow, and drag targets on a scrolled strip.**
  - The problem: a container `ResizeObserver` misses a label or count changing width inside a container whose size doesn't change.
  - The revision:
    - The mirror is an intrinsically sized (`width: max-content`) `aria-hidden` row, and one `ResizeObserver` observes **each mirror item** (at most about 30 nodes; it fires only when an item's size changes). That covers counts, locale, late font loads and design switches.
    - Drag geometry is re-measured on `scroll` of any `[data-drop-scroll]` container (the narrow-width tab strip is one) and when the visible/overflow split changes during a drag.
  - Test: a fixed-width strip whose labels and counts change.
- **R12. Conversation work for threads nobody opened.**
  - The problem: `move()` prefetches two neighbors, `extendSelection()` prefetches one, and `boot.ts` force-loads the selected thread on every `changed` event, page or no page.
  - The revision: in List, these run only while the thread page is up. On the list page the cursor is just a row: no `threads.get`, no prefetch, and `changed` only invalidates. Split is unchanged.
  - Tests: RPC counts show that j/k on the list page and background changes issue no `threads.get` until a thread is opened.
