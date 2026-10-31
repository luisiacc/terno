# 86: Promotions and Social out of the Inbox

## Request (verbatim)

> does gmail has a way already of identifiying promotions and things like that that we can reuse? or is there an easy way to identify promotion emails without ai?

> how can we integrate this into the product, i mean i wouldn't want to show these in the inbox at all, but i don't really have a place to put them

> i'd say promotions and social by default, and also categories are currently a unified inbox, what if they want to look them up , what if we automatically hide them from the unified inbox, then show them here [screenshot: an open account's folders, the arrow below Trash] on google accounts below the last items they can look them up there, they do not show on the unified inbox

> yes for imap we wouldn't do this at all, also do make a note on the outlook integration plan , if they have something like gmail, to do it for them too

## What exists

- **Gmail sorts every message into a tab** and says so in its labels: `CATEGORY_PERSONAL` (Primary), `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL`, `CATEGORY_UPDATES`, `CATEGORY_FORUMS`. We store every message's `labelIds` as `messages.gmail_labels` (JSON) on ingest and on every flag update (full sync, history, reconcile). Removing a category label (or adding `CATEGORY_PERSONAL`) moves a message to Primary in Gmail.
- **The labels are already read:** `automatedLevel` (`packages/core/src/people.ts`) and `importance` (`attention.ts`) treat Promotions/Social/Forums as machines; nothing changes where mail is shown.
- **Plan 83** leaves a hidden category's threads out of the plain Inbox (`plainInbox`, `shownInInbox`, `hiddenCategories` in `packages/db/src/queries.ts`; `inbox-hidden.ts` in IndexedDB): pages, filters, keepIds, scopes, counts (`inboxUnread*`, `inboxWaiting*`, Dock) and notifications (`arrivalRows` reports `inInbox: false`). With nothing hidden, the SQL is unchanged.
- **Plans 67/68:** an open account lists Inbox, Sent, Archive, Spam, Trash, then a hairline and its own folders (`folders` + `thread_folders`, folded in `recomputeThreads`, `folderUnread` counts, `navigate({ accountId, folder })`, `threads.list { folder }`). Only keys listed in `folders` get memberships. Gmail's `setFolders` comes from `/labels` (`type: "user"` only).
- **Gmail ops:** `LABEL_OPS` in `gmail-api.ts` maps an op kind to `batchModify` add/remove labels.
- **IMAP** has no tabs: out of scope for good (the user's call). **Outlook** isn't integrated yet; the note is in `docs/research/outlook-reliability-checklist.md`.

## Design

### The rule

For a Gmail account with tabs on (the default): **a conversation in the Promotions or Social tab is not in the Inbox**, neither the unified one nor the account's. It lives under the account, below Trash, in **Promotions** and **Social**. Gmail decides what goes where; Terno never classifies Gmail mail itself.

### Which tab a thread is in

A thread is in a tab when it's in the Inbox and **every** message of it that's in the Inbox and not yours carries a tab label (Promotions or Social); its tab is the one its newest such message carries.

- Conservative on purpose: one Primary message (a person replying in a promotion's thread, a receipt Gmail put in Primary) and the conversation is in the Inbox. Hiding wrongly loses mail; showing wrongly costs a glance.
- A message without any `CATEGORY_*` label (older mail, a draft, local sends) is Primary.
- Updates and Forums stay in the Inbox (receipts, alerts, threads people want to see).

### Storage (both stores)

- The tab is a thread aggregate, folded in `recomputeThreads` beside the others: `threads.tab` (SQLite migration v34: `ALTER TABLE threads ADD COLUMN tab INTEGER NOT NULL DEFAULT 0`; 0 Primary, 1 Promotions, 2 Social). IndexedDB: `tab` on the row, missing reads 0.
- Computed for every Gmail account, whatever the setting (the setting only decides visibility; see revision 7). The set of Gmail accounts is read once per recompute call, like the facts context; IMAP threads never pay for it.
- Migration backfill: threads of Gmail accounts are recomputed for `tab` in slices after open (the existing time-sliced backfill path), not in the migration transaction. Until a thread is done it reads 0 (shown): the safe direction.
- Index: partial `threads_tab_date ON threads(account_id, tab, last_date DESC, id DESC) WHERE in_inbox = 1 AND tab > 0` for the two lists and their unread counts. Tabs are a small part of most inboxes' thread count but most of their arrivals; the index is only over those rows.

### Reading

- **The Inbox:** `VIEW_WHERE.inbox` stays `t.in_inbox = 1` (the partial indexes match it textually). When any account has tabs on, the plain Inbox (`plainInbox`) adds `t.tab = 0`, beside plan 83's `NOT EXISTS`. It applies to pages, filters, keepIds, scopes, scope counts, `inboxUnread*`, `inboxWaiting*` and `arrivalRows`, through the same seams plan 83 added (one predicate, not a second set of call sites). An account Inbox (`view: "inbox", accountId`) also leaves tabs out: it's the account's Primary, as in Gmail.
- **A tab's list:** `threads.list { view: "inbox", accountId, tab: "promotions" | "social" }`; selection scopes take `tab` too. SQLite walks `threads_tab_date`; IndexedDB walks the account's Inbox order testing `tab`. Quick filters apply as elsewhere.
- **Counts:** `tabUnread: Record<"accountId:tab", number>`, pushed with the other counts.
- **Not affected:** search (plan 64 searches everywhere), Starred, Archive, All Mail, categories, an account's label folders.
- **Notifications:** an arrival in a tab is not news (`inInbox: false` from `arrivalRows`).

### Moving between the Inbox and a tab

Corrections go to Gmail, so Gmail learns and every device agrees:

- **Move to Inbox** (from Promotions or Social; the reader and row action, the context menu, `m i`): new op `toPrimary`: `batchModify` add `CATEGORY_PERSONAL`, remove `CATEGORY_PROMOTIONS`, `CATEGORY_SOCIAL` on the thread's messages. Applied locally at once (labels and `tab` recomputed), the row leaves with the archive fade-and-slide, snack "Moved to Inbox · Undo".
- **Move to Promotions / Move to Social** (context menu on an Inbox thread of a Gmail account): `toTab` with the label to add, removing the others.
- **Undo** restores each message's exact previous category labels (captured at the action, like plan 77's exact undo), through the same op path.
- Archive, delete, spam, read/unread from a tab work as everywhere.
- "Everything from X → Inbox / Promotions" is out of scope (Gmail's own filters do it; a later plan).

### Sidebar

- Under an open **Gmail** account, after Trash and before the hairline and its labels: **Promotions** (tag icon) and **Social** (people icon), each with its unread count in the muted style the account's folders use. `navigate({ accountId, view: "inbox", tab })`; the list title is "Promotions · Personal". Keyboard and screen readers as the other rows.
- With a single Gmail account, the account's disclosure lists them (plan 68's single-account rule).
- `g p` / `g o` are not added (shortcuts stay scarce); the palette gets "Go to Promotions" / "Go to Social" for the account in scope.

### Setting

Settings → Accounts → (a Gmail account): **"Separate Promotions and Social"**, on by default, hint: "On: they stay out of the Inbox and its unread count, under this account." Stored as `AccountPrefs.separateTabs` (missing = on). Turning it off brings the rows back to the Inbox at once (visibility, not data; revision 7), removes the two rows, and shows a snack with Undo.

### First run after the update

Existing users get it on, like new ones: after the backfill, if an account's Inbox lost threads to tabs, one snack: "Promotions and Social now live under Personal · Show in Inbox" (the action turns the setting off). Once per account.

### Demo and e2e data

The mock data gives Gmail accounts promotion and social senders with the labels, a mixed thread (a person replying to a promotion), and an IMAP account with bulk mail (never tabbed).

## Tests

- **Core:** the tab rule: all-tab thread, mixed thread (Primary wins), Promotions + Social (newest wins), unlabeled messages, own messages ignored, out-of-Inbox threads 0.
- **Conformance (SQLite and IndexedDB):** `tab` follows ingest, label changes from history, local ops and their undo; the Inbox (unified and account) pages, filters, keepIds, scopes, scope counts and counts leave tabs out; a tab's list and `tabUnread`; plan 83's hidden categories and tabs together; the setting off restores everything; IMAP threads untouched.
- **SQLite:** migration v34 adds the column (0); query-plan tests: with no tabbed account the Inbox SQL is unchanged; a tab page walks `threads_tab_date`.
- **Gmail provider:** `toPrimary` / `toTab` send the right `batchModify` bodies; undo restores the exact labels.
- **Backend:** arrivals in a tab aren't notified; the first-run snack fires once per account.
- **Web unit:** Move to Inbox takes the row out of the tab list and undo brings it back; the setting toggles the rows.
- **e2e** (`apps/web/e2e`): an open Gmail account lists Promotions and Social after Trash, an IMAP account doesn't; a promotion is absent from the unified and account Inbox and their counts, present in Promotions and in search; Move to Inbox brings it to the Inbox, Undo returns it; the setting off brings them all back. Light and dark screenshots of the sidebar.

## Perf

- No Gmail account with tabs on: identical SQL and code paths.
- With tabs: `t.tab = 0` is a column test on rows the Inbox already reads; a tab's page walks its own partial index. Perf test at 50k threads with 60% of the Inbox in tabs: Inbox page, Unread page, counts and a tab page within the existing gates, both stores.
- Recompute: one pass over the thread's messages it already reads; ingest perf gates hold.

## Out of scope

- IMAP (never), Outlook (noted for its integration).
- Updates and Forums tabs.
- "Everything from X → Inbox / Promotions", Gmail filters.
- Auto-archiving old promotions.
- `in:promotions` in search.

## Revisions after the Codex review

### Plan critique

1. *SQLite's recompute reads `FACT_COLUMNS`, which folds Promotions, Social and Forums into one value.* `recomputeThreads` gets its own compact projection, `msg_tab` (0 none/Primary, 1 Promotions, 2 Social, 3 other category), computed from `gmail_labels` in SQL. The facts classifier is unchanged. Test: a Forums-only thread stays in the Inbox, and a Social thread is Social.
2. *The tab rule needed the Inbox aggregate's exclusions.* Eligible messages are those that count toward `in_inbox`: in the Inbox, not trash, not spam, not a draft, not sent, and not from one of the account's normalized own addresses. With no eligible message the thread is Primary. "Newest" is `(date, id)`, like the other aggregates. Tests cover mixed trash/spam, own-only threads and equal dates.
3. *A tab list satisfies `plainInbox`, so it would exclude itself.* `plainInbox` (SQLite) and `hiddenFor` (IndexedDB) also require `tab === undefined`. A tab list, its keepIds and its scopes bypass both the tab exclusion and plan 83's hidden categories, so a categorized promotion is still reachable in Promotions.
4. *The index plan needed explicit SQL.* A tab page is `threads t INDEXED BY threads_tab_date` with `t.in_inbox = 1 AND t.tab > 0 AND t.account_id = ? AND t.tab = ?` written out. Its filtered pages (Unread, Waiting…) keep the same index and test the filter on rows. Paged scopes walk `threads_tab_id (account_id, tab, id) WHERE in_inbox = 1 AND tab > 0`. Unread counts use `threads_tab_unread (account_id, tab) WHERE in_inbox = 1 AND tab > 0 AND unread_count > 0`. Query-plan tests cover the unfiltered page, the filtered page, the scope and the count.
5. *IndexedDB has no per-account Inbox order; a sparse tab would scan the mailbox.* A `by_tab` index on `[account_id, tab, last_date, id]` is kept by the thread write path, like plan 68's folder memberships. Tab pages and counts walk only it. Gates: an empty tab, a sparse tab (10 threads among 50k), the last page after an arrival, and 60% density.
6. *The facts backfill never recomputes threads.* A durable tab job runs in each store (SQLite: a `tab_backfill` cursor row; IndexedDB: a marker like the folder upgrade). The slicer runs it, resumes from its cursor after a restart, and records completion. Each slice is bounded by messages read (a 5k-message conversation is spread over several slices: its partial counts are kept on the job row until the thread is done). Until done a thread reads 0 (shown).
7. *Turning the setting off must take effect at once.* `tab` is computed for every Gmail account whatever the setting. The setting only decides visibility: the Inbox predicate is `(t.tab = 0 OR t.account_id IN (…accounts with tabs off))`, or just `t.tab = 0` when every tabbed account has it on, and nothing is added when there is no Gmail account. Toggling therefore needs no backfill, and off→on→Undo is instant. The preference is `AccountPrefs.separateTabs` (missing = on), patched through `AccountPatch` and `accounts.update`, whose handler now also emits `changed([])` and counts when the preference changes.
8. *Exact undo needs per-message category snapshots.* `MessageState` gains `category` (the message's `CATEGORY_*` label, or none). The stores snapshot and restore it beside read, star and location. A new op kind `setCategory { label }` (validated against the five category labels) replaces the static `LABEL_OPS` entries. The Gmail executor groups target messages by identical add/remove deltas (remove the current category, add the target), so undo restores each message's previous label exactly, including Updates, Forums or none, and never touches unrelated labels.
9. *A stale history or reconcile can overwrite a correction.* `category` joins `operationFlagFields`, so a pending, running or failed-retrying `setCategory` owns the field the way a pending archive owns location. An observation of `gmail_labels` committed while the op owns the field keeps the intended category. Tests: a history response fetched before the correction but committed after it, plus the same across a restart.
10. *Tabbed threads still have `inInbox: true`, so "Move to Inbox" never shows.* `placeActions` treats `tab > 0` (with separation on for its account) as "not in the Inbox" for `toInbox`. `toInbox` routes each thread by its state: tabbed Gmail threads get `setCategory PERSONAL`, archived ones `moveToInbox`, and a thread that is both gets both in one action and one undo. A mixed Gmail/IMAP selection is split per account, and IMAP threads never receive `setCategory`. "Move to Promotions/Social" is offered only when every selected thread is in a Gmail account. `staysInView` in a tab list drops rows whose tab changes. This applies to the reader, row menu, palette, `m i` and bulk selections.
11. *Navigation needs `tab` throughout.* `tab` is added to `navigate`, `listKey`, `state/list.ts` (keys, scopes, RPC params, reload triggers), `page.ts`'s list identity and search restoration, and is cleared by ordinary navigation. The RPC `threads.list` and scope schemas accept `tab` only with a Gmail `accountId`, `view: "inbox"` and no folder or category (errors in `en` and `es`). Turning the setting off ends a select-all in that account's Inbox or tabs (plan 83's precedent) and sends an open tab to its account's Inbox.
12. *A lone Gmail account with no labels has no disclosure.* Tabs that are on count toward the disclosure (`many || hasOwn || hasTabs`). The active row is exact: in Promotions, the account's Inbox row is not selected. When a focused tab row disappears (setting off), focus moves to the account's Inbox row. Tests cover a single Gmail account with zero labels, including turning the setting off while a tab row has focus.

## Implementation notes

- **Category as a flag field.** Each message carries `category` (null: not Gmail; 0 none, 1 Primary, 2 Promotions, 3 Social, 4 Updates, 5 Forums), and the flag protocol treats it like read, star and place. A move is an ordinary thread action (`toPrimary`, `toPromotions`, `toSocial`; undo also uses `toUpdates`, `toForums` and `toNoCategory`), so the existing ownership, retry, snapshot and undo machinery covers revisions 8 and 9. There is no separate category intent store, and Gmail gets one `batchModify` per kind (add the category, remove the other four).
- **Undo.** Only a category move snapshots the category. An archive's undo never touches a category Gmail changed in the meantime.
- **Tab rule.** Eligible messages are those that count toward `in_inbox`, are not sent or drafts, and are not from your own addresses (once the facts know them; until then only sent mail counts as yours, which errs toward showing). One Primary message keeps the conversation in the Inbox; newest is `(date, id)`.
- **SQLite (v34).** Adds `messages.category`, `threads.tab`, and three partial indexes: `threads_tab_date` and `threads_tab_id` for a tab's pages and scopes, and `threads_unread_tab` for its counts. The existing `threads_unread_inbox` index is unchanged. The Inbox predicate is `t.tab = 0`, or `(t.tab = 0 OR t.account_id IN (…off))`, and is added only when some Gmail account separates its tabs.
- **IndexedDB (logical schema 34).** Threads get `tab` and `tab_unread` hash indexes. A tab's page is a top-N walk of its own bucket (plan 68's `selectFolderPage` shape); its count is the bucket's size.
- **Backfill (deviation from revision 6).** Both stores keep a `tabs_backfill` progress row, run in two phases (message categories by id window, then Inbox threads' tabs by id window) and resume after a restart. A slice reports what it read, so the sizer adapts. A single very large thread is read whole in one slice (as every ingest already does); there are no partial per-thread counts.
- **UI.** The app state gains `gmailTab`, alongside plan 68's `folder`. List keys add `"~promotions"`, and quick-filter keys `|~promotions`. In a tab, Move to Inbox becomes `toPrimary` (the selection bar, the reader, the context menu and a select-all scope all route it). Rows of accounts that keep their tabs apart get "Move to Promotions/Social". The Lumen greeting no longer replaces a tab's title.
- **Demo data.** Gmail mail from others carries `CATEGORY_PERSONAL`; promo threads carry `CATEGORY_PROMOTIONS`. Social has no demo mail; the conformance tests cover it.
- **No first-run snack (deviation).** The one-time "Promotions and Social now live under…" notice was dropped. Terno hasn't launched, so there are no existing users to tell, and on a fresh mailbox the sidebar rows and the setting say it. A notice shown on every first load also took the snack dock from whatever the user did next.
- **Pre-existing failures (unrelated, failing on the base commit too).** In IndexedDB: the physical-upgrade tests in `cached-refresh`, `imap-identity` and `idb.uncertain-upgrade`. In the backend: `store-boundary` and the i18n scan (both flag `w02-action-fixture.ts`), `gmail-cooldown` and `imap-idle-foreground`.

### Code review (Codex)

1. *Undo was split: on a mix of tabbed and other rows, Move to Inbox ran two actions with two undos.* Move to Inbox is now one store command in both stores: `moveToInbox` also moves the threads' Promotions/Social messages to Primary (`untabThreads`) when their account keeps tabs apart. It returns one merged snapshot (`mergeBefore`: the place as the move found it, the category as the untab found it), so there is one snack and one exact undo. Web unit test: one call, one undo.
2. *An archived promotion moved to the Inbox went straight back to Promotions.* Fixed by the same change (conformance: archive, then Move to Inbox, lands it in the Inbox; undo restores both place and category).
3. *A tab went stale when an address became yours.* A rescan of what's yours (`startRescan`), and the facts first learning your addresses, ask the tabs backfill for another threads pass (`requestTabRefresh`), in both stores. It runs in its own slices, woken with the facts' runner. (A first version refreshed tabs inline in the facts passes; the facts backfill gate caught its longest stall at 35 ms against 32.) Conformance test: a promotion from an alias you then send from returns to the Inbox.
4. *Backfill slices weren't bounded by messages.* The threads phase now stops once a slice has read its share of messages, mid-window, and saves its cursor. Both stores have a test with 3-message conversations and 2-message slices. One conversation is still read whole, as every ingest already does.
5. *In the List layout, All/Unread in a tab changed the account Inbox's filter.* `openTab` keeps `gmailTab`. Unit test.
6. *A focused tab row that went away dropped focus to the document.* Focus moves to the account's Inbox row (or the account row). e2e.
7. *A tab's subtitle showed the account Inbox's unread count.* It now uses `tabUnread`. e2e, in the designs that show a subtitle.

Perf (found by the gate): with tabs, the 50k counts went over budget (5.7 ms p95 against 5 ms). `getCounts` now reads the hiding once, takes the Inbox's and every tab's unread counts from one walk of `threads_unread_tab` (when no category is hidden), and the waiting count uses a covering `threads_waiting_inbox_tab` (v34). The gate reruns at 2.9–3.8 ms p95. A new store gate, 60% of the Inbox in Promotions plus a sparse Social at 50k threads, measures Inbox pages at 0.6 ms, counts at 2.5 ms and tab pages under 1.3 ms (p95).
