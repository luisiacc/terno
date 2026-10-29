# 64 · Search everywhere, instantly

## Request

> remember we need to be able to search across all categories all inboxes including archived and spam at the same time, and the search needs to follow our super fast performance principles

Then, on the proposal to search everywhere by default (Trash included, with a quiet label):

> yes we will do that, lets remember again the performance must still be instant search

## What exists

- **The sidebar scopes every search.** `searchQuery` in `apps/web/src/state/list.ts:120` prefixes `in:<view>` unless the view is All Mail. `currentScope` also passes the selected account and category (`narrow`). Searching in Inbox therefore finds Inbox mail only, and searching inside a category finds that category only.
- **All Mail is not everything.**
  - `ResolvedSearch.view` defaults to `"all"` (`packages/core/src/search/resolve.ts:84`).
  - `all` excludes Spam and Trash in every engine:
    - SQLite: `VIEW_WHERE.all` (`packages/db/src/queries.ts:28`);
    - IndexedDB's exact scan: `VIEW_TEST` (`packages/idb/src/mail.ts:794`);
    - the instant index: `VIEW_FLAGS` (`packages/store/src/instant/engine.ts:53`);
    - the conformance oracle: `oracle.ts:48`, plus `view ?? "all"` at `oracle.ts:119`.
- **Leaving search.** `navigate()` (`state/app.ts:152`) clears the query, so a sidebar click leaves search.
- **Spam has no sender icons** (plan 22). `iconsAllowed(view, query)` turns icons off for the Spam view and for `in:spam` searches. The rows themselves don't say where they live: `ThreadSummary` has no place fields.
- **Callers that depend on today's default:**
  - categorize's query scope adds its own trash/spam exclusions (`QUERY_EXCLUSIONS`);
  - "select all N" on a search (`threads.actScope`) runs the same query the list shows;
  - MCP's `search_threads` calls `threads.search`.

## Design

1. **A search-only scope, `anywhere`.** `SearchView = View | "anywhere"`, and `ResolvedSearch.view` defaults to it.
   - Each engine gets one more entry:
     - SQLite `VIEW_WHERE.anywhere = "1"`, which walks `threads_order`, an index that already exists;
     - IndexedDB `VIEW_TEST.anywhere = () => true`;
     - instant `VIEW_FLAGS.anywhere = [0, 0]`;
     - the oracle likewise.
   - `View` itself (the sidebar's) is unchanged. `in:all` keeps meaning All Mail (no Spam or Trash), and `in:inbox` and the others still narrow.
   - `in:anywhere`, `in:everywhere` and Spanish `en:todas` are accepted, so agents and the "select all" scope can say it explicitly.
2. **The renderer searches everywhere.** `currentScope()` sends the query as typed: no `in:` prefix, no sidebar account or category. A typed `account:`, `category:` or `in:` still narrows it. The list filter (Unread and the others) still applies.
3. **Rows say where they live.**
   - `ThreadSummary` gains `inSpam?` and `inTrash?`, read from the thread row in both stores' summaries.
   - In any list, a row in Spam or Trash shows a quiet "Spam" or "Trash" tag next to its date: muted text, not a pill.
   - The optimistic patch sets these flags on spam, trash, not spam and move to Inbox, so a row that stays in the results is re-tagged at once.
4. **No icons for spam rows, anywhere.** A row with `inSpam` never asks for a sender icon, whatever the view or query. This keeps plan 22's promise once spam can appear in an ordinary search.
5. **Copy.** The search field already says "Search all your accounts". Strings for the two tags and the new `in:` aliases go in `en` and `es`.

### Performance: instant is the requirement

Widening the scope must not regress any search budget.

- **The instant index** filters by a flags mask. `anywhere` is the empty mask, the cheapest filter it has.
- **SQLite's free-text and sender strategies** already join the hits to `threads`. `anywhere` drops a predicate.
- **The chronological walk** (operators only, such as `is:unread` or `has:attachment`) uses `threads_order`, which holds Spam and Trash too. That's at most the few percent more rows they add.
- **IndexedDB's exact scan** loses a test per thread.

The existing search gates run at 50k+ (`perf.perf.test.ts`, `store.perf.test.ts`, `instant.perf.test.ts`, `idb.perf.test.ts`, web-perf), and they will now measure `anywhere` because it is the default. A new gate in each store compares `anywhere` with `all` on the same queries (free text, sender, operators only, an empty result) at 50k, so the widening is pinned at no more than all's budget.

## Tests

- **Core:** parse (`in:anywhere`, its aliases, `in:all` unchanged), and resolve's default.
- **Conformance, both stores and every engine against the oracle:**
  - a default search finds Inbox, Archive, Spam and Trash mail;
  - `in:all` excludes Spam and Trash;
  - `in:spam` stays exact;
  - summaries carry `inSpam` and `inTrash`;
  - the instant index agrees with exact search.
- **Web unit:** `currentScope` sends the query untouched, with no view and no sidebar narrowing. The optimistic patch re-tags rows.
- **e2e** (`search-everywhere.spec.ts`, `@design`):
  - in Inbox, searching finds an archived, a spammed and a trashed thread, each in one result list, tagged;
  - no sender icon request is made for the spam row;
  - a sidebar click leaves the search;
  - marking a result as spam re-tags it in place;
  - the tags are axe-clean in light and dark.
- **Perf:** the gates above, plus web-perf's search-as-you-type budget unchanged.

## Out of scope

- A scope bar ("This mailbox / Everywhere"). Typing `in:inbox` does that. A one-click narrowing can follow if it's missed.
- Search inside a category's review view ("Revisar"), which keeps its own list.

## Revisions after the Codex review

All 12 points are taken. The biggest change: **instant is proved, not argued.**

1. **Gates at 50k+ threads, with absolute budgets.**
   - A new search gate seeds at least 50k threads (multi-message, at least 100k messages), with a Spam- and Trash-heavy variant (20% of threads in each).
   - Every query has an absolute budget: p95 within one frame (16 ms) for a first page in SQLite and the instant index, and within the same budget as `all` today.
   - `anywhere` against `all` is reported, never the only check.
2. **SQLite's materializing strategies are gated where they hurt:** common prefixes, a dominant sender, broad `before:`, date ranges, and big hit sets thinned by thread filters. Query plans are asserted, and any query that misses its budget gets a better strategy.
3. **The chronological walk gets the cases that hurt it:** rare and empty intersections (`is:unread has:attachment` over Spam/Trash-heavy data), deep cursors, and `EXPLAIN QUERY PLAN` assertions for `anywhere`.
4. **IndexedDB's exact fallback is measured end to end**, with the instant index off, unavailable and catching up.
   - Thread-only predicates (operators only) skip enumerating messages.
   - The gate covers sender, date and empty-result searches.
   - The exact fallback is held to "never blocks a frame" (sliced) plus a completion budget. Instant is the instant index's promise, and its availability is part of the test.
5. **The instant index gets gates for its expensive paths:** cold and warm sender and date sets, dense prefixes, the phrase fallback, rare thread filters, and filtered empty results. Each gets an absolute budget, and any path that misses is fixed.
6. **"Select all N" on an everywhere search gets gates:** `scopeCount` and `actScope` on large results, in both stores.
7. **The heading and account labels follow the effective scope.**
   - While searching, the list's heading says "Search" rather than the sidebar mailbox or category.
   - Account labels show whenever results can span accounts (any search with more than one account).
   - Test: a search started inside one account and one category.
8. **Actions follow the rows' places, not the sidebar.**
   - In a search, the thread menu and the selection bar offer what each selected row's place allows:
     - Restore for Trash, Not spam for Spam, Move to Inbox for archived rows;
     - for a mixed selection, the union, each acting only where it applies.
   - Tests: searches started from Inbox, Spam and Trash.
9. **The optimistic patch follows the stores' aggregate semantics.**
   - Spam sets `inSpam` (and clears `inTrash`).
   - Trash sets `inTrash`.
   - Not spam and Move to Inbox clear both.
   - Anything else leaves the flags alone.
   - Icons never turn on optimistically: a row that is or was spam stays icon-less until the backend's refreshed row says it isn't spam.
   - Tests: spam then trash, trashed spam then Not spam, undo, failure, bulk.
10. **Caller contracts are explicit:**
    - the renderer's search and "search mail from X" search everywhere;
    - `scopeCount` and `actScope` follow the list's query;
    - categorize's query scopes keep their trash/spam exclusions (tested in both stores);
    - MCP `search_emails` says it searches everywhere, and each result carries `inSpam` and `inTrash`.
11. **Privacy tests cover transitions.** These have no icon requests:
    - a spam row (cached icon included);
    - rows kept on screen while the list navigates;
    - optimistic spam;
    - undo.

    Searching fetches no remote content. Opening a spam result keeps plan 37's per-message consent and `always` behavior.
12. **The tag's layout and accessibility.**
    - Precedence: the place tag goes before the account label. In narrow and compact rows the account label truncates first, then the tag.
    - Selected and checked rows use the account label's contrast treatment.
    - The row's accessible name includes the place ("in Spam").
    - Screenshots: compact, comfortable and wide rows, en/es, light/dark, in every design. Screen-reader output is asserted, not only axe.

## What the measurements found

At 57k threads and 100.6k messages (`search-everywhere.perf.test.ts` in `db` and `idb`; machine load average 9–27 from other sessions):

- **The instant index**, the path every search takes once it's current:
  - every query within its budgets, everywhere and `in:all` alike, as seeded and Spam/Trash-heavy;
  - prefix "pro": 0.06 ms;
  - store keystrokes ≤ 5 ms.
  - Its date-only path was the one at its budget (0.85–1.0 ms). It is now one tight pass over the dates: 0.5–0.6 ms.
- **SQLite's FTS path** (while the index catches up): every case is within 25 ms except broad prefixes ("pro": 24–27 ms). Those are the same in either scope; their cost is the hit count at twice today's gate size. The gate here is 35 ms, scaled to the mailbox. `perf.perf.test.ts` keeps 25 ms at 29.5k threads.
- **Searching everywhere is never meaningfully slower than `in:all`,** and is often faster: one predicate fewer, and the walk over `threads_order` instead of a partial index.
- **"Select all N" over broad searches:** 1–53 ms.
- **The web's index cap (open decision).**
  - At this size the instant index needs about 123 MiB. The web's cap is 96 MiB (`WEB_SEARCH_MEMORY`), so on the web the index turns itself off at about 95k messages, and search falls back to the exact scan:
    - operators, sender and dates: 13–124 ms;
    - free text: 3.5–6.7 s.
  - The scan never stalls a frame (largest stall 15 ms), but it isn't instant.
  - With room for the index, every web search everywhere takes ≤ 0.6 ms.
  - Raising the cap trades memory for instant search on large mailboxes. This is the user's call; the IndexedDB gate measures with room for the index until it's made.

## What the Codex code review changed

Round 1 (`7e933d19..a4f677c3`) found five issues. Four are fixed, each with a test that fails without the fix. The fifth is the open decision on the web's index cap.

1. **Trashed spam could get a sender icon.**
   - Cause: a thread's `inSpam` is an aggregate that turns false once every message is trashed.
   - Fix: summaries carry `hasSpam` (some message is spam, wherever it lives now). Rows and the reader (`iconsFor`) refuse icons on `inSpam || hasSpam`.
   - Found on the way: **the reader had this leak before plan 64.** Opening trashed spam from Trash asked for its icon. The e2e caught it as a request to the spammer's site.
   - Tests: conformance (trashed spam is `hasSpam`), and e2e (trash a spam result, search again, open it: no request, 20 runs in a row).
2. **(Open) The IndexedDB instant gate measures with room for the index.** The shipping 96 MiB web cap turns the index off at about 95k messages. That's the user's call (see "The web's index cap" above). The exact-scan gate runs at the shipping configuration.
3. **A mixed selection in a search lost place-specific actions.** `placeActions` offers each action for the rows it fits, and acts on those only: Restore the trashed rows, Not spam the spam, Archive what's in the Inbox. Both the menu and the selection bar use it. A "select all N" scope keeps the view's actions; the backend's per-message actions are idempotent. Tests: `places.test.ts`, and an e2e where Restore on an Inbox+Trash selection restores only the trashed row.
4. **The optimistic patch contradicted the stores.** The patch now follows `db/actions.ts`: trash keeps the spam flag, spam keeps a trashed thread in Trash, and Not spam keeps it in Trash. Tests: `places-patch.test.ts`, covering spam on Trash, trash on Spam, Not spam and Move to Inbox on trashed spam.
5. **The exact scan had no completion budget.** It now has one per query class:
   - operators, a sender, dates or a subject: ≤ 500 ms (measured 14–238 ms);
   - free text: ≤ 10 s (measured about 3 s);
   - plus the frame-stall gate.
