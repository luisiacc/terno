# Plan 108: focus on one account

- **Status:** done (see "Codex code review").
- **Builds on:** plans 67/68 (an account's folders under its row), 105 (folder counts), 106 (the account menu), 107 (folder actions, favorites), 64 (search everywhere).
- **Request (verbatim):** "focus mode for an inbox, in the right click menu, have ‘focus this inbox’ which puts the email of the inbox at the top, with a backarrow to go back to the unified inbox view, in this focus view all folders and subfolders of that inbox show, like ‘inbox, sent, archive, etc… plus any custom folders"
- **Decisions (2026-11-01), after the grooming proposal:**
  1. **Search while focused** looks in the focused account only, with a quiet "Search all accounts" to widen it.
  2. **The back arrow** always goes to the all-accounts Inbox (not back to where you were before focusing).
  3. **Categories** are hidden from the sidebar while focused; the List layout's category tabs still show a category within the account.
  4. **Anything that takes you to another account or to all of them** (a notification, the palette, a shortcut to a cross-account place) leaves focus and goes there.
  - The menu label wasn't chosen; it uses the request's word: "Focus on this account" (English menus are sentence case in the catalog).

## 1. What exists

- **Sidebar** (`apps/web/src/components/sidebar.tsx`): Inbox and Starred, favorites (plan 107), More (Reminders, Sent, Archive, All Mail, Spam, Trash), Categories, Accounts. An open account (`useOpenAccount`, `terno:sidebar-account`) shows `AccountFolders`: `ACCOUNT_VIEWS` (inbox, sent, archive, spam, trash), Gmail's Promotions and Social (plan 86), a separator, and its own folders (`OwnFolderRow`, batches of 250, focus recovery, create/rename fields). Starred and All Mail are only at the top (plan 67: cross-account).
- **Scope:** `AppState.accountId`. `navigate()` keeps it unless told; `goToFolder()` (shortcuts, palette) keeps it for `ACCOUNT_VIEWS` and clears it for Starred and All Mail. `keepFolderValid` / `keepRemindersValid` normalize every `setApp` write.
- **Search** (`state/list.ts` `currentScope`): `{ kind: "search", query }`, everywhere, whatever the sidebar's account (plan 64). The scope already takes `accountId` (`threadScope` in `core/rpc/contract.ts`; `threads.search` passes it to both stores). `listKey()` includes `accountId`.
- **Notifications** (`lib/notify.ts` `openFromNotice`) go to the all-accounts Inbox. A notice carries only a thread id.
- **Account menu** (`account-menu.tsx`, plan 106): right-click or ⇧F10 on a row inside `[data-context-menu]`.
- **Compose** uses `s.accountId` as the sender: inside an account, it's that account's.

## 2. Design

### State

- `AppState.soloAccountId: number | null`: the focused account (code says *solo* so it never reads as keyboard focus).
- **Invariant, kept in `setApp`** (a `keepSoloValid` step beside `keepFolderValid`): while focused, `accountId === soloAccountId`. Any write that leaves the account (another account, `accountId: null`, Reminders, a cross-account category, Revisar) ends focus in the same write. So every way out (decision 4) is one rule, not a check at each call site.
- **Entering** (`focusAccount(id)` in `lib/account-folders.ts`): that account's Inbox, unless you're already in one of its places (then you stay where you are; see the revisions, #2).
- **Leaving** (`leaveFocus()`): `navigate({ view: "inbox", accountId: null })` (decision 2); the invariant clears focus.
- **Remembered** on this device (`terno:sidebar-solo`), like the open account. At boot, once accounts are known: a remembered account that still exists, with more than one account, is focused again on its Inbox; otherwise the key is dropped. `reconcileAccounts`: the focused account removed → back to all accounts (already happens: it navigates to `accountId: null`).
- With one account, focus is never offered; if accounts drop to one while focused, focus stays (it's harmless and the user chose it).

### Ways in

- **Account menu:** "Focus on this account" (`account-menu-focus`, icon `Focus`), after "Check for new mail" group's end, before Rename. Hidden with one account, and in the focused header's own menu (which has "Show all accounts" instead, `account-menu-unfocus`).
- **Palette:** "Focus on {account}" for each account (`palette-focus-<id>`), with more than one account. The palette's existing "All accounts" leaves focus.

### The sidebar while focused

Compose stays where the design puts it. The `<nav>` then holds, in this order:

1. **Back row** (`solo-back`): a full-width quiet row like More: `ArrowLeft` in the icon column, "All accounts" on the label line, muted. `aria-label` "Back to all accounts"; tooltip with the same words.
2. **Title** (`solo-title`): the account's dot in the icon column, its name (`type-nav-strong`) on the label line, its address under it (`text-xs`, muted, truncated). Not a control. Right-click on the back row or the title opens the account menu (both inside one `AccountMenu` trigger, so ⇧F10 on the back row opens it). Rename puts the name field there (`RenameRow`, focus returning to the back row). The sign-in marker sits at the title's end when the account needs it.
3. **Its folders, flush** (`AccountFolders` with `solo`): no inset at depth 0; Inbox, Starred, Sent, Archive, All Mail, Spam, Trash (`SOLO_VIEWS`, the top's order), then Promotions and Social, with the same counts as under the account (Inbox, Archive, Spam). Starred and All Mail here are `navigate({ accountId, view })` (the stores already list them per account).
4. **Its favorites** (plan 107) are not repeated: every one of them is already a row here.
5. **"Folders" section title** (`solo-folders`) with the hover "+" (`solo-add-folder`, like Categories' "+"; the menu's "New folder" stays the keyboard's way), then its own folders: depth 0 flush, each level after it in the existing `INSET` steps (depth 1 = `pl-7`, as under an account). Empty: the title alone, so the first folder can be made.
6. Nothing else: no top folders, More, Categories, other accounts or Add account. Reminders stays reachable by `g r` and the palette (and leaves focus: it's cross-account).

Motion: none of its own. The sidebar swaps content in one frame (a slide here would move every row twice); the More and account disclosure transitions stay as they are.

### Scope while focused

- **Shortcuts and palette folders:** `goToFolder` keeps the account for every view while focused (`g s` → its Starred).
- **Search** (decision 1): `currentScope()` adds `accountId: soloAccountId` to a search; `listKey()` already varies with `accountId`, so leaving focus mid-search reloads (add the solo id to the key only for a search, so other keys stay as they are).
- **The list header** while searching focused: the account suffix ("Search · Personal") and a quiet link button "Search all accounts" (`solo-search-all`) by the stats; it leaves focus and keeps the query (one write: `soloAccountId: null` → the list's key changes → it reloads everywhere). Since leaving keeps `accountId`, the normal sidebar then shows you inside that account.
- **Select all N** of a focused search uses the same scope (it's `currentScope()`).
- **Notifications** (decision 4): unchanged; they go to the all-accounts Inbox, which leaves focus.

### Keyboard focus and accessibility

- Entering from the menu: keyboard focus goes to the back row (the account row it came from is gone). From the palette, it goes back where it was, as for the palette's other go-to commands.
- Leaving with the back row: focus goes to the account's row in the normal sidebar (its `nav-account-<id>`), else the top Inbox.
- `<nav aria-label>` while focused: "{account} mailboxes"; the folders group keeps its label.
- Focus rings per plan 54; axe in light and dark.

## 3. i18n (en / es)

| key | en | es |
| --- | --- | --- |
| `account.menu.focus` | Focus on this account | Centrarse en esta cuenta |
| `account.menu.unfocus` | Show all accounts | Ver todas las cuentas |
| `sidebar.solo.back` | Back to all accounts | Volver a todas las cuentas |
| `sidebar.solo.nav` | {account} mailboxes | Buzones de {account} |
| `sidebar.solo.folders` | Folders | Carpetas |
| `palette.focusAccount` | Focus on {account} | Centrarse en {account} |
| `list.search.allAccounts` | Search all accounts | Buscar en todas las cuentas |
| `list.search.placeholderIn` | Search {account} | Buscar en {account} |

The back row's visible label reuses `sidebar.allAccounts`.

## 4. Tests

- **Unit (`account-folders` / app state):** the invariant (another account, `accountId: null`, Reminders, a cross-account category, a review end focus; a category tab, a folder, a Gmail tab inside it don't); `focusAccount` lands on the Inbox or stays inside; `goToFolder("starred")` keeps the account while focused; remembered and restored, dropped for a removed account or a single one; `currentScope()` scopes a search to the account only while focused.
- **e2e (`account-focus.spec.ts`, `@design`):** the menu item focuses; the sidebar shows back row, title, the seven views, tabs, Folders and own folders (nested), and nothing of the others; Starred and All Mail list only that account; `g s` stays; search finds only the account's mail, "Search all accounts" widens it and the normal sidebar returns; the back arrow goes to the all-accounts Inbox with focus on the account row; the palette's "Focus on …" and "All accounts"; reload keeps focus; one account: no menu item; axe light and dark.
- **Visual:** screenshots in light and dark (Lumen and Atelier) looked at for alignment.
- **Perf:** the sidebar render gates (`pnpm test:ui-perf` sidebar specs) unchanged; focused, the sidebar mounts fewer rows.

## 5. Perf and resources

No new sync, storage, queries or counts: every list and count used already exists per account. No timers. Normal mode renders as before (one extra selector in `Sidebar`).

## 6. Out of scope

- An account switcher in the header; focusing several accounts at once; muting other accounts' notifications while focused.
- Notifications of the focused account keeping focus (a notice has no account id; a follow-up could add one).

## Revisions after the Codex review

Eleven points; what each changed:

1. **Leaving focus mid-search must reload.** The list's reload subscription compares fields one by one, so a key change alone reloads nothing. It now also compares "searching focused" before and after (and clears a "select all N" there, as for any other list).
2. **"Already inside"** for entering is not plan 67's `inside()` (it leaves out Starred and All Mail): any place of that account stays (a view, a folder, a Gmail tab, a category in it, a search: which then narrows to it); Reminders and Revisar aren't the account's, so they go to its Inbox.
3. **The focused sidebar doesn't depend on the open account:** it builds the account's folder rows and passes its counts itself, open or not. The remembered disclosure is left as it was; leaving shows the normal sidebar as it was.
4. **Favorites:** `favoriteHere` (which keeps the account's copy of a favorite from also showing as selected) applies only to the normal sidebar; focused, the row for where you are is always selected.
5. **Category tabs:** a tab inside an account is that category in the account (view "all", as today), not a filter of its Inbox; the plan's wording was wrong. No change in behavior.
6. **Focus recovery** that went to the account's row (Esc on a new top folder, the focused folder deleted, a rename ended) goes to the back row when focused (`homeRow`).
7. **Menu and palette:** the menu's items use its `away` hand-off (the closing menu doesn't put focus back on a row that's going), then focus the back row (entering) or the account's row (leaving). The palette moves no focus: closing hands it back where it was (the list), as its other go-to commands do. The account menu sets `menuOpen` false if it unmounts while open, so shortcuts never stay blocked.
8. **Indents:** one `insetOf(depth, solo)` for folder rows, rename and create fields, grouping rows and "N more folders".
9. **Remembering:** written by a subscription to `soloAccountId`, so every way out (the back arrow, a notification, a category, Reminders, the account removed) clears it. Restored in the boot's ready write, before history (`bootPage`) and the first list load.
10. **`account:` inside a focused search** intersects with the account, so `account:other` finds nothing; "Search all accounts" is the way out. Both stores already cover a search with `accountId` (`store/conformance/search.ts`, including an `account:` operator), and "select all N" uses the same scope (`backend/src/scope.ts` passes `accountId`).
11. **"Search all accounts"** is `no-drag` (the list header is a window drag region), a real button with its name, and shown whenever a focused search is on screen (not only once stats arrive).

## Codex code review

### Round 1

Six findings, all fixed, each with a test in `e2e/account-focus.spec.ts` that fails without its fix:

1. **(P1) Focusing another account kept the last one's folder rows** (`useFolderRows` cached by the folder list alone): its folder names under the new account's title, and a click or rename aimed at the new account with the old one's keys. The focused sidebar is keyed by its account, and the hook never returns rows built for another account.
2. **A folder's menu open when a notification left focus** unmounted with `menuOpen` still true, so shortcuts stayed blocked. `FolderMenu` clears it on unmount, as `AccountMenu` does. (A test hook, `openFromNotice`, makes the notification's click from the page.)
3. **List layout: focusing while a search's conversation was open** narrowed the list under it and replaced the conversation on screen. The page subscription treats a change of a focused search's scope as another list, so the conversation closes back to the list.
4. **The palette's search said "in all accounts"** while focused; it now says "Search for “…” in {account}" (`palette.searchIn`, en and es).
5. **"Search all accounts" dropped keyboard focus** (the button goes as it widens the search); focus goes to the search field.
6. **Creating or renaming a folder while focused changed the normal sidebar's open account**; the open account is left alone when the edit is in the focused one.

### Round 2

Two findings, both fixed with a test that fails without the fix; the review stopped here (the bounded rounds).

1. **Focusing from a search there kept the selection** (checked rows, the cursor) of threads from other accounts that the narrowed search no longer shows, so Archive or Delete could still act on them. Focusing that narrows a search starts the selection again (`account-focus.test.ts`).
2. **The two sidebars share one scroll:** entering from a scrolled sidebar could hide the back row, and leaving could focus an account row out of view. Focused starts at its top; leaving puts back the normal sidebar's scroll, and the focus moves without `preventScroll`, so its row is in view (e2e at a 420 px window).

## Tests run

- Unit: `lib/account-focus.test.ts` and the rest of `src/lib` and `src/state` (four failures, all unrelated: two fail the same way on main, two were timing under load and pass alone).
- e2e, every design: account-focus, account-folders, account-own-folders, account-menu, folder-actions, palette, search-everywhere, list-layout, notifications, i18n (332 passed). `designs.spec.ts` has 6 failures that fail the same way on main.
- UI perf: the account toggle, folder counts, sidebar drag and search typing gates pass. Wrapping the normal sidebar in a conditional made the React Compiler memoize it as one block (6 category/account rows rendered per account toggle against a budget of 2); the normal body is built unconditionally, as before.
- `no-hardcoded.test.ts` in `@terno/ui` fails on main as well (`folder-rows.tsx:151`, not touched here).
