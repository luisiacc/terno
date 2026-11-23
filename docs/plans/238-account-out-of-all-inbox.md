# Plan 238: keep an account out of the all-accounts Inbox

- **Status:** plan.
- **Builds on:** plan 83 (a category hidden from the Inbox), plan 86 (Gmail's tabs out of the Inbox: a per-account preference the Inbox's queries read), plan 106 (the account menu), plan 211 (per-account switches in Settings → Accounts).
- **Request (verbatim):** "lets have the ability to hide certain accounts from the unified inbox and that account doesn't count towards the total unread count"

## 1. What exists

- **The all-accounts Inbox** is `threads.list({ view: "inbox" })` with no `accountId`; an account's own Inbox passes its `accountId`. Both stores filter "the plain Inbox" (`plainInbox(p)`: view inbox, no category, folder or tab) through `InboxHiding` (SQLite `db/inbox-hiding.ts`, IndexedDB `idb/inbox-hidden.ts` + `inboxHiddenTest`): plan 83's hidden categories and plan 86's Gmail tabs. That hiding applies to **every** Inbox (an account's too), to Today (`db/today.ts`), facts and arrivals (notifications).
- **Counts** (`threads.counts`): `inboxUnread` (the total) and `inboxUnreadByAccount`, `inboxWaiting` and `inboxWaitingByAccount`. The total feeds the sidebar's Inbox row, the list's subtitle in the all-accounts Inbox (`thread-list.tsx` `Subtitle`), the Dock badge (`core/attention.ts` `badgeCount`, Inbox as first screen) and MCP's `unreadInbox`. Per account feeds the account rows and its own Inbox's subtitle.
- **The preference path** (plan 86's `separateTabs`, plan 211's `ai`/`feed`): `Account` + `AccountPatch` + `AccountPrefs` in `core/types.ts` (`patchesAccountPrefs`, `accountPrefs`, `withAccountPrefs`, stored in `provider_config`), the RPC schema of `accounts.update`, the handler (`b.notifyChanged([])` after `separateTabs` so lists, counts and the Dock follow), `lib/gmail-tabs.ts` `setSeparateTabs` (snack + Undo), `setAccounts` (drops a "select all N" of the Inbox when what it shows changes).
- **UI:** the account menu (`account-menu.tsx`), Settings → Accounts `AccountEditor`, the settings search index, the sidebar's account row (`NavItem`, which takes a `note` like the category row's `EyeOff`).

## 2. Design

### The rule

An account can be kept out of **the all-accounts Inbox**. Then:

- its threads aren't in that Inbox's list, its pages, filters (Unread, Waiting, …), kept rows, "select all N" scope or counts;
- its unread threads aren't in `inboxUnread` (the sidebar's Inbox row, the all-accounts subtitle, the Dock badge, MCP) and its waiting ones aren't in `inboxWaiting`;
- everything else about it is as before: its own row and its own Inbox (with their counts), its folders, focus (plan 108), search everywhere (plan 64), categories (cross-account lists), Starred / Sent / All Mail at the top, notifications (revision 6), What matters (it has its own switch, plan 211). The Inbox's top leaves it out too (revision 1).

### Data

- `AccountPrefs.unified?: boolean`, `Account.unified?: boolean`, `AccountPatch.unified?: boolean`; absent is on (plan 86's shape: on deletes the key, off writes `false`). `patchesAccountPrefs` and `accountPrefs` include it. Core helper `inAllInbox(account)` (`unified !== false`).
- `accounts.update` schema takes `unified: z.boolean().optional()`. The handler calls `b.notifyChanged([])` when it changes (lists reload, counts and the Dock follow), as for `separateTabs`.
- No migration: it lives in the provider config's JSON.

### Stores

A separate test from `InboxHiding`'s categories and tabs, because it applies only where no account is chosen:

- **SQLite:** `InboxHiding.accountsOff: readonly number[]` read in `inboxHiding()` from the same accounts read (`json_extract(provider_config, '$.unified') = 0`; one query over accounts for both tabs and this). `hidingSql(alias, h, all)` adds `${alias}.account_id NOT IN (…)` only when `all` (the scope has no `accountId`): `listSql` and `scopeFrom` pass `p.accountId === undefined`. Counts: `getCounts` keeps `byAccount` whole and leaves hidden accounts out of `inboxUnread`; `waitingCounts` likewise for `inboxWaiting`. Today, facts and arrivals call `hidingSql` without `all` and are unchanged.
- **IndexedDB:** `accountsOffInbox(db): Set<number> | null` beside `tabHiddenTest`; `inboxHiddenTest`'s list/scope callers (`mail.ts:1218`) add the account test when `p.accountId === undefined`; `getCounts` and `waitingCounts` as in SQLite.
- The account test is a column of the row the walk already reads (like the tab), so it costs no probe.

### Client

- `lib/gmail-tabs.ts` grows into the place for "what the Inbox shows by account": `setInAllInbox(accountId, on)` (the same shape as `setSeparateTabs`: `accounts.update`, `setAccounts`, a snack with Undo, failure snack `category.inboxFailed`). Renamed `lib/account-inbox.ts` only if that reads better once written; otherwise a sibling file.
- `setAccounts`: the "select all N" of the all-accounts Inbox is dropped when the set of hidden accounts changes (as for `separateTabs`).
- **Account menu:** a checkbox item "Show in all-accounts Inbox" (`account-menu-all-inbox`, icon `Inbox`), after Focus, with more than one account (with one, the Inbox is that account's). Not in the focused header's menu (focused, there's no all-accounts Inbox on screen).
- **Settings → Accounts:** a switch with the same label and a hint, after Separate Promotions and Social (both say what the Inbox shows), shown with more than one account or while it's off (so it can be turned back on). Search index entry `account.unified`.
- **Sidebar account row:** while hidden, an `EyeOff` note with the label "Hidden from the all-accounts Inbox" (the category row's look, `nav-account-hidden-<id>`).
- Nothing to teach with a tip: the menu item says what it does.

### i18n (en / es)

| key | en | es |
| --- | --- | --- |
| `account.allInbox` | Show in all-accounts Inbox | Mostrar en Entrada de todas las cuentas |
| `account.allInbox.hint` | Off: its mail stays under this account, out of the Inbox for all accounts and its unread count. | Desactivado: su correo queda bajo esta cuenta, fuera de Entrada de todas las cuentas y de su número de no leídos. |
| `account.allInbox.hidden` | {account} is out of the all-accounts Inbox | {account} queda fuera de Entrada de todas las cuentas |
| `account.allInbox.shown` | {account} shows in the all-accounts Inbox again | {account} vuelve a aparecer en Entrada de todas las cuentas |
| `account.allInbox.badge` | Hidden from the all-accounts Inbox | Oculta en Entrada de todas las cuentas |

## 3. Tests

- **Conformance** (`packages/store/src/conformance`, both stores, new `account-out-of-inbox.ts`): two accounts, B hidden: the all-accounts Inbox's pages, Unread filter, Waiting filter, kept rows, scope ids and scope count leave B out; B's own Inbox lists all of B; `inboxUnread` and `inboxWaiting` leave B out while `inboxUnreadByAccount[B]` / `inboxWaitingByAccount[B]` keep it; Today and arrivals unchanged; round-trips through `accounts.update` and survives a reopen; turning it back on restores everything. Combined with a hidden category and a separated Gmail tab.
- **core:** `withAccountPrefs` / `accountPrefs` / `patchesAccountPrefs` for `unified`.
- **Backend:** `accounts.update({ unified })` notifies a change (lists reload).
- **Web unit:** `onlyOnTop` with a hidden account; `setAccounts` drops the scope.
- **e2e** (`account-menu.spec.ts`, one scenario): menu → uncheck → B's rows leave the Inbox, the Inbox count drops, the account row shows the eye and keeps its count, B's own Inbox still lists them; Undo brings them back; Settings switch does the same; axe on the open menu in light and dark.
- **Perf** (`store.perf.test.ts`, both stores): an account holding 95% of the 50k Inbox hidden: first and next page, Unread filter page, scope count and counts within plan 83's budgets.

## 4. Out of scope

- Notifications per account (a separate switch if wanted).
- Hiding an account from Starred / Sent / All Mail at the top, or from categories.

## Revisions after the Codex review

1. **The Inbox's top** (`withTop`, state/list.ts:205: Pinned, due reminders, follow-ups on top) is fetched apart from the page. Hidden means hidden: in the all-accounts Inbox the top leaves out an account that's out of it (its own Inbox, Reminders and Follow-ups still have them). This replaces the reminders exception above, and `onlyOnTop` needs no change.
2. **The sidebar's `note`** renders only on rows without a disclosure (sidebar.tsx:257), and account rows have one. `NavItem` shows the note in the disclosure branch too, on the label line before the count; checked collapsed and open.
3. **A page in flight** when the hidden set changes could bring the account's rows back after the reload. `setAccounts` calls `noteEdit()` when the set of accounts out of the Inbox changes (the optimistic write and the backend's event both), so such a page asks again from where the list ends.
4. **The write goes through `patchAccount`** (field-aware pending edits), not plan 86's whole-account replacement: `AccountEdit` gains `unified`; Undo sets the value it had.
5. **Cost:** SQLite's `threads_inbox` holds date and id only, so the account test reads the row, like plan 86's tab test already does. The perf gate measures the hidden account holding the newest 95% (contiguous) and the all-hidden case, first and next pages, Unread filter, scope ids and count, counts. IndexedDB tests the account on the row the walk already read.
6. **Notifications:** plan 83's hidden categories and plan 86's tabs *do* stop notifications (they aren't Inbox mail at all). An account out of the all-accounts Inbox still has its own Inbox, so its mail still notifies: a deliberate difference, tested (arrivals unchanged by the account switch alone).
7. **Settings search** follows the control's rule (more than one account, or it's off): `FindContext` gains `accounts` (how many). Search words "unified, combined, all inboxes" in en and es.
8. **Keyboard:** e2e opens the menu with ⇧F10, toggles the item with the keyboard, checks `aria-checked` and that focus goes back to the account row; the Settings switch's name and hint.
9. **Gates:** typecheck, lint, the touched unit files, the conformance suite on both stores, the e2e spec, the store perf gate, then `pnpm test:all` (shared query code and the store contract). Screenshots light and dark of the menu, the row's mark and Settings. UI rating: the rated screens' fixtures hide no account, so nothing rated changes; not run (said in the report).

## Codex code review

1. **"Select all N" kept the Inbox's old total** after an account left it: `SelectAllBanner` cached the count by `listKey()`, which an account's switch doesn't change. The cache is keyed on `inboxShape.rev` too (bumped by `setAccounts` and `setCategories` whenever what the Inbox shows changes). e2e (`selection.spec.ts`): ⌘A after hiding offers the smaller number, and the full one again after showing it.
2. **A grouped notification for a hidden account opened an Inbox without its mail.** A new-mail notice now says its one account when all its mail is in one (`MailNotice.accountId`, through desktop main's `parseNotice`, the click, preload's `OpenTarget` and the page's own notifications); a click on an account out of the all-accounts Inbox opens that account's Inbox. Tests in core (`summarize`), desktop (`parseNotice`, the click) and the page (`openFromNotice`).
3. **Perf gates:** the IndexedDB gate also times the next page and `scopeIds` (revision 5's list). Not taken: a fixture of 50k Inbox threads. Both gates use the repo's shared 50k-message mailbox, as plan 83's do; its Inbox is about 6k threads, so a 30k Inbox walks about five times as far (SQLite ~10 ms for a first page whose newest 95% is hidden: worth an index on the account if that ever shows up).

### Round 2

1. **From the hidden account's Promotions or Social, a notice's click stayed on the tab** (the view and account already matched). The click leaves a Gmail tab, a folder, Reminders, Follow-ups and What matters too. Test in `notify.test.ts`.
2. **The tests stopped at each boundary.** The packaged notification smoke (`notify.smoke.ts`) now takes the IMAP account out of the all-accounts Inbox, receives mail from two people, clicks the notice and finds that account's Inbox with the mail: main's notice, the click, preload's relay and the page together.

`test:all` also showed two faults in this series' own tests, fixed: the SQLite gate moved threads between accounts and could repeat a provider thread id within one (each moved thread wears its own meanwhile), and the select-all e2e pressed ⌘A before the reload without the account's rows had landed.
