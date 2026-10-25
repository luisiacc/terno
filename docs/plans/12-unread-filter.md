# Plan 12: the unread filter

- **Status:** shipped (§10).
- **Builds on:** 2ac66d2.
- **Request:** "mac has this which i like, which is a filter to only see the unread threads, lets copy that feature" (a screenshot of Mail's list header: the three-line filter button beside "All Inboxes · 23.923 messages").

## 1. What Mail does

- A filter button in the list header. Off: a grey icon. On: the icon turns accent-blue and the subtitle under the mailbox name reads "Filtered by: Unread".
- ⌘L toggles it (View → Filter → Enable Message Filter).
- It is per mailbox: Inbox can be filtered while Archive isn't, and each keeps its state across launches.
- A message that becomes read while the filter is on (you opened it) stays in the list while it is selected, and disappears once the selection moves off it. Nothing jumps under the cursor.
- An empty filtered mailbox says so, with a way to turn the filter off.

## 2. What exists

- Search already understands `is:unread` / `es:noleido` (`core/search/parse.ts`), in both stores and in the instant engine.
- `threads.list` takes `{ view, accountId?, categoryId?, cursor?, limit }`. SQLite pages with `VIEW_WHERE` over the view's partial date index; IndexedDB walks the in-memory recency order (`ThreadOrder`) and tests each row.
- "Select all N" is a `ThreadScope` (`{ kind: "view", … }` or `{ kind: "search", query, … }`), counted by `threads.scopeCount` and resolved once by `resolveThreadScope` (store `scopeIds` pages for views, search pages for searches).
- The renderer's list (`state/list.ts`) reloads on every `changed` event, keeping as many rows as are loaded; selection is by id; actions patch rows optimistically (`lib/actions.ts`, `staysInView`).
- UI prefs that aren't settings live in `localStorage` (`terno:print`).

## 3. User-facing design

### The toggle

| Where | What |
|---|---|
| List header | A ghost icon button (lucide `ListFilter`) before the compose button. `aria-pressed`, `aria-label` "Filtrar por no leídos". Off: `text-muted-foreground`. On: `text-primary` (the accent). Tooltip "Mostrar solo no leídos ⌘L" / "Mostrar todo ⌘L". |
| Header subtitle | On: a second line under the title, `text-2xs text-muted-foreground`: "Filtrado por: No leídos · N" (N: the unread threads of this mailbox, es-MX grouping). In a search, no N (the result count is already beside the title). Off: no subtitle, the header is as today. |
| ⌘L (`list.toggleUnread`, `mod+l`) | Toggles the current mailbox. Resolves everywhere (also in a field, so the browser's ⌘L doesn't steal it), and the handler decides: nothing while a dialog is open or in "Revisar". |
| ⌘K palette | "Mostrar solo no leídos" or "Mostrar todo" (whichever applies), with ⌘L. |
| Shortcuts dialog | "Moverse" → "Solo no leídos". |
| Desktop menu | Ver → "Filtrar por no leídos" ⌘L, first in the menu, sent through the existing menu-command channel (the whitelist grows from the print commands to `MENU_COMMANDS`). |
| Empty state | `ListFilter` icon, "No hay conversaciones sin leer", and a "Quitar filtro" button (secondary, small). In a search: "Sin resultados sin leer" with the same button. |

"Revisar" (a category's pending suggestions) is a fixed list of up to 200 suggestions: no toggle there.

### Per mailbox

- The state is keyed by the mailbox: `view + accountId + categoryId` (`"inbox||"`, `"all||7"`, `"inbox|2|"`). A search inherits the state of the mailbox it searches in, like Mail.
- Persisted in `localStorage` (`terno:unread-filter`): the list of keys that are on, newest last, capped at 200. Read once at boot; a parse error means "all off".
- `navigate()` sets `unreadOnly` from the stored state of the destination.

### Stickiness

The open thread always stays in a filtered list until the selection moves off it:

- It becomes read (the 450 ms dwell, ⇧I, the reader): its row stays, now drawn as read.
- The filter is turned on while a read thread is open: that row stays too.
- When `selectedId` changes, a row that is read, filtered, and no longer the open thread leaves the list (with the existing reflow animation).
- Reloads (`changed` events) keep it: when the reloaded page doesn't have the open thread but the previous list did, it is put back at its place in (last_date, id) order, if that place is inside the loaded window. Its data comes from the thread cache when the reader has it (`threads.get`), so a star from elsewhere shows.
- It leaves anyway when it left the mailbox itself: the cached detail says it is no longer in the view (`inInbox`, trash, spam, category, account), checked when the reload happens and when the detail is refreshed.
- j/k: positions come from the list after the sticky row left, so `j` from a sticky row selects the row below and scrolls to its new index; `k` selects the row above.

### Actions in a filtered list

- `markRead` makes the targets leave the list (they no longer match), except the open thread, which stays sticky. Also in a filtered search (today nothing leaves a search optimistically).
- `markUnread`, `star`, `unstar`: as today.
- ⌘A checks the loaded rows, i.e. what is shown, including a sticky row.
- "Seleccionar las N conversaciones de «Entrada»": the scope carries `unreadOnly`, so N and the action are the unread threads only. The banner label adds " · No leídos". The optimistic patch of a scope action touches only the loaded rows that are unread (a sticky row isn't part of the scope).
- The scope selection's key is `listKey()`, which now includes `unreadOnly`: toggling ends a scope selection.
- Undo is unchanged: it restores exactly the messages the action changed, and the reload shows whatever is unread again.

## 4. API

- `ListParams.unreadOnly?: boolean`, `ScopeParams.unreadOnly?: boolean`.
- RPC: `threads.list` gains `unreadOnly`; `threadScope` gains `unreadOnly` on both kinds; `threads.search` gains `unreadOnly`.
- Search: the backend runs `withUnreadOnly(query)` from `core/search`: it returns `"is:unread " + query` (prepended, so the token the user is still typing stays the last, prefix-matched one), or `null` when the query already says `is:read` / `-is:unread` (AND of contradictions: an empty page, no store call). Cursors, query keys and the instant engine see an ordinary query.
- `threads.scopeCount` with `unreadOnly` gives the header's N.

## 5. Storage

### SQLite

- Migration v11: one partial index over the unread threads, carrying every column a view or an account narrows by, so the walk filters inside the index and fetches only the rows it returns:
  ```sql
  CREATE INDEX threads_unread ON threads(last_date DESC, id DESC, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE unread_count > 0;
  ```
- `listThreads` with `unreadOnly` adds `t.unread_count > 0` and pins `threads t INDEXED BY threads_unread` (a category view walks it and probes `thread_categories_c`).
- Measured on the 29,500-thread perf mailbox (node:sqlite, first page of 101):

  | case | today (planner's pick) | `threads_unread` pinned |
  |---|---|---|
  | archive, 20 old unread among 23k read, 6k unread in the inbox | 6.3 ms (walks `threads_archive`, a table read per row) | 0.21 ms |
  | largest category (5,366) | 1.5 ms (temp B-tree sort) | 0.37 ms |
  | an account's archive | 1.5 ms | 0.18 ms |
  | every thread unread, trash | 0.2 ms | 0.45 ms |

  Left to itself the planner picks a view index even with `threads_unread` present (the category and account cases stay at 1.5 ms), so the index is pinned.
- `scopeIds` / `scopeCount` add the predicate; the id-ordered page walk is unchanged (a page reads at most its rows plus the ones filtered out, like a view today). `SEARCH_SCHEMA_VERSION` stays 7: v11 doesn't touch what search indexes.

### IndexedDB

- `ThreadOrder` gets an optional row predicate. A second instance, `unreadOrder`, keeps only threads with `unread_count > 0`, in the same order. A row change re-places a thread when its date changes or when it crosses the predicate (read ↔ unread). `listThreads` walks `unreadOrder` when `unreadOnly`.
- `scopeThreadIds` tests `unread_count > 0` in its walk.
- The store's own consistency check (`debug`) also checks `unreadOrder` against the rows.
- No IndexedDB schema change: the order is in memory.

## 6. Performance

- SQLite gates (`perf.perf.test.ts` and `store.perf.test.ts`), 5 ms p95: the unread list of inbox, archive, all, an account, the largest category; a deep page; and the pathological case (few unread in the view, thousands elsewhere). The query-plan test asserts `threads_unread`.
- IndexedDB gate (`idb.perf.test.ts`): the unread list's pages over 28,400 threads, each page ≤ one frame; toggling read on 1,000 threads keeps `unreadOrder` incremental (no full re-sort per change).
- UI (`test:ui-perf`): ⌘L to the filtered list painted, p95 within the existing navigation budget; moving off a sticky row renders only the rows whose position changed (the render probe).

## 7. Tests

- **core:** `resolveKey` maps ⌘L (and Ctrl+L off Mac) to `list.toggleUnread`, also in a field; `withUnreadOnly` (prepends, keeps the prefix token, contradictions → null).
- **store conformance (both engines):** unread-only lists equal the oracle for every view, with account and category, across keyset pages; a thread that becomes read leaves, one that becomes unread enters at its place; `scopeIds`/`scopeCount` with `unreadOnly`.
- **db:** migration v11 from v10 creates the index; the plan pins it.
- **backend:** `threads.search` with `unreadOnly`, contradiction → empty; `actScope` on an unread view archives only the unread threads.
- **web unit:** the per-mailbox store (keys, cap, bad JSON); `state/list` sticky placement (inside/outside the window, left the view).
- **e2e (`unread-filter.spec.ts`):** toggle by button, ⌘L, palette; subtitle and N; persistence per mailbox across a reload (inbox on, archive off, a category on); stickiness (open an unread thread → dwell → still there → j → gone, the cursor on the next row; k likewise); a filtered search; ⌘A + archive and "select all N" + archive archive only the unread; undo; the empty state and "Quitar filtro"; axe on the header and the empty state, light and dark.
- **Visual:** element baselines of the header (on) and the empty state, light and dark. Full-page baselines change by the new icon in the header: updated deliberately, diffs inspected.
- **Desktop unit:** the Ver menu sends `list.toggleUnread`; the preload whitelist contains it.

## 8. Out of scope

Mail's other filter criteria (flagged, to me, with attachments) and a filter picker. The filter menu's "only unread" is the one criterion asked for; the button's design leaves room for a menu later.

## 9. Revisions after Codex

These override the sections above where they conflict. The review is in `/tmp/unica-scratch/plan-12-codex.txt` (10 points).

1. **One search narrowing for every consumer.** `withUnreadOnly` runs in the `threads.search` handler and in `resolveThreadScope` (counts, actions and category filing all resolve scopes there), so a filtered search scope never reaches a read thread. Contradiction is judged on the user's query alone: `is:read …` with the filter on is empty.
2. **Optimistic edits win over reloads already in flight.** `patchRows` bumps an edit counter. A reload or `loadMore` that started before an edit doesn't apply its (older) answer: a same-view reload starts over, a `loadMore` page is dropped (the scroll effect asks again). Before, a reload in flight could put an archived row back until the next change event; the filter makes that visible (a read row reappearing in "No leídos").
3. **Toggling keeps the selection**, and the sticky row stays while it is the open thread *or checked* (⇧J from a sticky row keeps both selected, like Mail). It leaves when it is neither.
4. **The sticky row is the store's answer, not the renderer's guess.** `threads.list` takes `keepId` (the open thread): the store returns it with the page, fresh, when it is still in the view (unread or not) and its place in (last_date, id) order falls inside that page's range. No detail-cache membership checks. A search keeps the row as shown (its terms don't change by reading it) until the selection moves; deep rows past the 500-row reload window are not kept (the same holds today for any open thread that deep).
5. **Scope membership in one place.** `scopeRows(items, scope)`: with `unreadOnly`, a scope's loaded rows are the unread ones. Row rendering (selected look), `targetRows` (star/read toggles), the optimistic patch of `actScope` and of `categories.addScope` all use it. A leaving scope action keeps the open thread when it is a sticky row outside the scope.
6. **Bounded scope pages.** v11 adds a second index for the id-ordered walks of "select all N": `threads_unread_id ON threads(id, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE unread_count > 0`. An unfiltered or category page is unchanged; an unread page walks only unread threads. Gates (both engines): empty and sparse unread views, deep pages, a cold `unreadOrder`, and 5,000 reads at once (the >64-change re-sort). The SQLite gate also runs on a 50k-thread mailbox (the perf mailbox grown with copies of its threads).
7. **Exactly once.** Key repeat is ignored for ⌘L. The HTML mail frames forward ⌘L like the print chords. On the desktop, a menu command arriving within 300 ms of the same command from a key is dropped (whichever path Electron takes for a handled accelerator, one press toggles once), verified in the dev app. The handler owns every guard (not ready, a dialog or menu open, Revisar, inert).
8. **Fresh counts.** The header's N is fetched with every reload of a filtered view (each `changed` event), in parallel with the page and dropped if a newer reload started; capped counts show "100 000+". In a search, the result count beside the title counts unread rows only.
9. **The filter is derived, not set by `navigate`.** App state holds `unreadFilters: ReadonlySet<string>` (the persisted keys); the effective flag is `unreadFilters.has(mailboxKey(state))`, so every way of changing mailbox (the sender search, the snackbar's search, boot) gets it. Storage reads and writes are in try/catch and the stored value is validated (an array of short strings).
10. **The empty state lives outside the listbox.** It is drawn over the (empty) listbox as a sibling, so "Quitar filtro" isn't inside `role=listbox`; after it, focus goes to the header's filter button. axe runs on it, light and dark.

## 10. As shipped

### Departures from the plan

- **The copy is English.** The product's source language changed to English while this was built (AGENTS.md); Spanish comes back through the translation pass. The new strings: "Filter by unread" (the button's name), "Show unread only" / "Show all" (tooltip and palette), "Filtered by: Unread · N", "Unread only" (shortcuts dialog), "Filter by Unread" (Ver menu), "No unread conversations" / "You’re all caught up.", "No unread results" / "Everything that matches has been read.", "Clear filter", and " · Unread" after a select-all label.
- **`keepIds`, not `keepId`.** The open thread and the checked ones are kept (revision 3), so the store takes up to 500 ids.
- **The list key keeps the query last**: `[view, account, category, review, unreadOnly, query]`. The UI perf gate for search reads the query from the end of `data-results-for`.
- **No "· 0".** With nothing unread, the subtitle reads "Filtered by: Unread" and the empty state says the rest.
- **A mailbox with nothing unread still shows the open thread.** Turning the filter on keeps the open read thread (revision 3), so the empty state appears once nothing is open, e.g. in a mailbox just navigated to with nothing in it.
- **IndexedDB keeps the unread ids ascending too** (after the Codex code review): the filtered select-all walk and the header count read only unread threads.
- **Full-page baselines.** With the default tolerance they still passed with the new icon; the six that show the list header unobscured were regenerated anyway, so the next diff starts from the real header.

### Desktop

A Playwright-driven ⌘L in the Electron dev build toggles once, and Ver → Filter by Unread toggles through the same dispatcher (`unread.smoke.ts`). CDP key events don't reach the native menu, so a menu echo of a real keystroke wasn't observed here; the renderer drops a menu command that arrives within 300 ms of the same command from a key, whichever way Electron routes it. A real OS keystroke needs accessibility permissions this machine's automation doesn't have.

### After the Codex code review (6 findings, all fixed)

1. Reading the open thread in a filtered list, with motion on, threw: the reflow got an empty id list and built an empty selector. Now nothing leaves and nothing slides. Regression: an e2e with motion on.
2. A refresh asked for while a thread was open could answer after the selection moved, and keep it. Read rows in a filtered answer are checked against who holds them now. Regression: a unit test with a held answer.
3. IndexedDB unread scopes walked every thread id (an empty view: 28,400 lookups for zero). The unread ids are kept ascending, by binary search per crossing. Gate: an empty view's count is under half the mailbox walk (measured: 0.06 ms against 0.64 ms).
4. A filtered search that matches nothing returned before stopping the search it superseded. Regression: a backend test with a slow scan.
5. The list key's new last element broke the search perf gate. The query is last again.
6. The UI perf budgets were missing. `test:ui-perf` gates ⌘L → list rendered at 100 ms (p95 ~13 ms) and the renders of moving off the kept row (21 for 21 mounted rows).

### Measured

- SQLite (`perf.perf.test.ts`, 29,500 threads, then 50,500): every filtered list, count and deep page between 0.1 and 0.8 ms p95; unread header counts at 50k with everything unread up to 2.7 ms; a whole unread select-all walk of 50k ids 11 ms (budget 15).
- IndexedDB (`idb.perf.test.ts`, 28,400 threads): a cold unread order 3 ms; the worst filtered page 0.5 ms; a page after 5,000 reads 3 ms; an unread count 0.06 to 0.7 ms.
- UI: ⌘L → the other list rendered p95 12.7 ms (budget 100).

### Verification

- **Screens**, 1440×900 @2x, light and dark: the header off, on (with its tooltip), and the empty state, inspected (scratch PNGs in `/tmp/unica-scratch/unread-12/`). The header's sidebar count and "Filtered by: Unread · N" agree.
- **Test runs** (rebased on `aaa789b`):
  - `pnpm test`: 1,536 + 392 (db-wasm).
  - `pnpm test:e2e`: 224, of which 15 in `unread-filter.spec.ts` (4 baselines). One unrelated test failed under the full run's load with "database is not open" (the ops worker outliving its fixture) and passes alone.
  - `pnpm test:web`: 26 of 27; the failure lists the diagnostics feature's `terno-diag` database in the web migration check.
  - `pnpm test:ui-perf`: 17/17.
  - `pnpm test:perf`: 106 of 107; `load.perf.test.ts`'s slow-disk case fails on this machine with or without the v11 indexes (checked by building without them).
  - Desktop: `unread.smoke.ts` on the dev build.
