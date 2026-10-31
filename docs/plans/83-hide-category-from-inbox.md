# 83: Hide a category from the Inbox

## Request (verbatim)

> on the categories that we have, lets have the ability to make categories hide from inbox, meaning that emails that are those categories would not show in the inbox, like i can have a linkedin category and i want to not show this on the inbox, so it won't count towards the inbox and the unread filter, make this a simple and intuitive ui with a nice simple smooth animation

## What exists

- `Category` (`packages/core/src/types.ts`): id, name, color, position, autoApply. SQL `categories` table; IndexedDB `categories` rows (plain objects, no schema change needed for a new field).
- The Inbox is `VIEW_WHERE.inbox` (`t.in_inbox = 1`, SQL) / `VIEW_TEST.inbox` (IndexedDB), used by list pages (`listThreads`, keepIds included), scope pages and counts ("select all N"), and the counts (`inboxUnread`, `inboxUnreadByAccount`, `inboxWaiting*`). The Unread and Waiting quick filters are the Inbox with a filter; the Unread tab's number is `inboxUnread`; the Dock badge rides on it (plan 41).
- A category's list is `view: "all"` + `categoryId`; a category tab inside an account is that account's Inbox filtered by the category (plan 67).
- Notifications screen arrivals with `stillNew` (needs `inInbox`), from `arrivalRows` in each store.
- `categories.update` (RPC) patches name/color/position/autoApply and emits `categories`.
- Renderer: Settings → Categories (`categories-tab.tsx`), the sidebar's category rows (`sidebar.tsx`), `lib/categorize.ts` (optimistic add/move with `leaveView` and `reflowRemoval`, the fade-and-slide the list uses for archive).

## Design

### Model

- `Category.showInInbox: boolean` (default true). SQL migration v31: `ALTER TABLE categories ADD COLUMN show_in_inbox INTEGER NOT NULL DEFAULT 1`. IndexedDB: `show_in_inbox` on the row, missing reads as shown (`!== 0`), new rows write 1.
- `categories.update` takes `showInInbox`. Export/import carry it (`exportCategorySchema`, like autoApply).
- A thread is *hidden from the Inbox* when it is in at least one category with `showInInbox = false`. Hidden wins over shown (LinkedIn + Work, LinkedIn hidden: out of the Inbox). It is still in Inbox on the server: nothing is archived or moved; only Terno's Inbox view leaves it out.

### Where it applies

Only the plain Inbox: `view === "inbox"` with no `categoryId` and no `folder`.

- List pages, the Unread / Waiting / People / Attachments / Starred filters on it, and the kept rows (keepIds).
- Scope pages and scope counts (select all N in the Inbox acts only on what is shown).
- Counts: `inboxUnread`, `inboxUnreadByAccount`, `inboxWaiting`, `inboxWaitingByAccount` (so the sidebar's Inbox, the Unread tab, the account rows and the Dock badge all drop it).
- Notifications: `arrivalRows` reports `inInbox: false` for a thread in a hidden category at the time it is screened.
- Not: the category's own list and unread count (where the mail lives now), search (plan 64 searches everywhere), All Mail, Archive, folders.

SQL: when hidden categories exist (`SELECT id FROM categories WHERE show_in_inbox = 0`, a tiny table, read per query), the Inbox's WHERE gains `NOT EXISTS (SELECT 1 FROM thread_categories h WHERE h.thread_id = t.id AND h.category_id IN (…ids))`, a primary-key probe per candidate row. With none hidden, the SQL is unchanged (no cost, plans unchanged). IndexedDB: the same test over `thread_categories.by("fk_thread_id")`, skipped when none are hidden.

### Backend

`categories.update` with `showInInbox` set: after the update, `notifyChanged([])` (views): the renderer reloads the list and gets new counts (the Dock follows).

### UI

- **Sidebar**: right-click a category → a one-item context menu, a checkbox "Show in Inbox". A hidden category shows a small muted eye-off glyph after its name (aria: "Hidden from Inbox"), which fades in within `--motion`.
- **Settings → Categories**: in each category's editor, a "Show in Inbox" switch with the hint "Off: its mail stays out of the Inbox and the Inbox's unread count. It's still in this category." Keyboard-reachable path for everything the menu does.
- **Toggling** (`lib/categorize.ts`, `setShowInInbox`): once the backend has it (a local call), the category list updates; if you're looking at the plain Inbox and hiding, the loaded rows of that category leave with the existing fade-and-slide (`leaveView` → `reflowRemoval`; nothing when motion is reduced/off), and the selection moves on as with archive. Showing reloads the list (the backend's change event). Then a snack: "LinkedIn is hidden from the Inbox · Undo" / "LinkedIn shows in the Inbox again · Undo"; Undo (and z) sets the value it had. A refusal changes nothing and says why.
- **Filing into a hidden category while in the Inbox** (`addToCategory`, `moveToCategory`, `addScopeToCategory`): once filed, the rows leave the Inbox the same way.
- Strings in `en` and `es`.

## Tests

- Store conformance (SQLite and IndexedDB, `packages/store/src/conformance`): with a hidden category, the Inbox page, the Unread filter page, keepIds, scope ids/counts and counts leave out its threads (and threads in it plus a shown one); the category's own list still has them; account Inbox likewise; showing it again restores everything; `showInInbox` round-trips through update/list.
- SQLite migration test: v31 adds the column with existing categories shown. Query-plan test: with none hidden the Inbox SQL is unchanged.
- Backend: `categories.update { showInInbox }` emits `changed` and counts; arrivals in a hidden category are not notified (attention).
- Import: `showInInbox: false` round-trips.
- Web unit: `setShowInInbox` takes the category's loaded rows out of the Inbox list (and only in the Inbox), undo restores; filing into a hidden category from the Inbox takes rows out.
- e2e (`apps/web/e2e`): right-click a category → Show in Inbox off: its rows leave the Inbox, the Inbox count drops, the eye-off shows, the category still lists them; the Settings switch does the same; Undo brings them back.

## Perf

- None hidden: identical SQL and code paths.
- Hidden: one PK probe (SQL) / one membership lookup (IndexedDB) per Inbox candidate. Perf test at 50k threads with a hidden category holding most of the Inbox: an Inbox page, an Unread page and counts stay within the existing gates.

## Out of scope

- Search's `in:inbox`.
- Hiding per account.
- A hidden category's tab in the List layout's strip gets no glyph (the sidebar and Settings carry it).

## Revisions after the Codex review

### Plan critique

1. *"Looking at the Inbox" needed more than `view === "inbox"`* (a search, a category tab, a folder, Revisar). `inPlainInbox` (state/app.ts) tests all of them; web unit test.
2. *A select-all of the Inbox survived a change of what it shows.* `setCategories` ends it when the hidden set changes and you're in the Inbox (here or from another window's `categories` event); web unit test.
3. *Bulk filing (`addScopeToCategory`) was missed.* It takes the loaded rows out too.
4. *IndexedDB's Waiting scope has its own path* (`waitingScope`). Covered, with a conformance test of the Waiting page, scope ids, scope count and counts.
5. *An optimistic removal could be undone by a refresh racing the update.* The toggle applies after the backend has it; nothing is optimistic.
6, 7. *Per-candidate cost in both stores, several hidden categories, counts.* Perf gates in both stores at 50k messages: the seed's largest category hidden, and two hidden categories holding 95% of the Inbox (see Perf).
8. *Import into a same-name category.* A category you already have keeps your settings; a new one comes with the file's (like autoApply).
9. *Undo must set a captured value.* It sets the value the category had; a retry is idempotent.
10. *A failure must keep your place.* Nothing changes before the backend answers, so a refusal changes nothing.

### Code review

1. *IndexedDB: the hidden test read each hidden category's member list (`ScopeIndex.category`), which any membership change makes the next Inbox read rebuild and sort whole* (20–29 ms at 50k). It now tests the thread's own memberships (`inboxHiddenTest`); the perf gate times every read right after a membership change.
2. *Filing into a hidden category took the rows out before the backend answered, so a refusal lost the selection and the reader.* The rows leave once it's filed (web unit test: a refusal keeps the rows and the open thread).

## Perf (measured)

SQLite (29,500 threads, 51k messages; budgets 5 ms): with the seed's largest category hidden, an Inbox page p95 0.6 ms, the unread page 0.5 ms, counts 3.7–4.1 ms (2.9 ms with nothing hidden). Two hidden categories holding 95% of the Inbox: pages 1.4 ms, unread 0.7 ms, select all 1.8 ms, counts within 1 ms of the same memberships shown (the per-category counts grow with what is filed). IndexedDB (28,400 threads): every read at 95% hidden 0.3–3 ms, the same right after a membership change (budget: a frame).
