# Plan 102: the account's right-click menu

- **Status:** planned.
- **Builds on:** `9d988d3b` (main). Follows plan 83's category menu, plan 67's account rows, plan 25's sign-in marker.
- **Request (verbatim):** "we need to improve the current multiple accounts abilities, we need a right click menu, for now i think we can have an edit button to edit the name, and it opens in-place something to edit the name of it, what do you think, would it be nice? are there other useful actions to have there?" Then, after the proposal (Rename in place plus seven actions): "yes lets do the 7 you suggested".

## 1. What exists

- **Sidebar account row:** `AccountEntry` (`apps/web/src/components/sidebar.tsx`, memoized) draws a `NavItem` (`nav-account-<id>`) that toggles the account's folders (plan 67), with the account's color dot, its name and, closed, its Inbox unread count. A `SignInMarker` (plan 25) sits over its right end when `syncState.authRequired`; it is a popover trigger whose `open` is local state.
- **Account editing** lives only in Settings → Accounts (`settings/accounts-tab.tsx`): `AccountItem` (a disclosure, closed by default) → `AccountEditor`: name, sender name, color (`ColorPicker`), signature, sync window, Gmail tabs, connection (`Reconnect`), remove (`ConfirmDialog` → `accounts.remove`). `updateAccount` calls `accounts.update` and writes the result with `setAccounts`.
- **Category menu (plan 83):** `CategoryMenu` wraps a row in a Base UI `ContextMenu`, sets `menuOpen` while open (the keyboard treats it as modal), and lazy-loads its delete dialog.
- **Keyboard:** `shift+f10` and `contextmenu` resolve globally to `list.menu`, which opens the *thread* menu, whatever has focus. A focused category row therefore gets the thread menu from the keyboard: the sidebar menus are pointer-only today.
- **Backend calls that already exist:** `accounts.update` (`displayName`, `color`, …), `sync.now({ accountId, reason: "user" })` (→ `retryNow`: recovers Google's policy, resumes parked ops, syncs the account), `accounts.reconnect` (through `signInAgain`), `accounts.remove`, and `threads.actScope` (a scope action applied in time slices, with progress events and one exact Undo; plan 12's "select all N").
- **Compose:** `openCompose("new")` uses `s.accountId ?? s.accounts[0]`: the sender follows the account you're in.
- **Settings:** `setApp({ dialog: "settings", settingsTab: "accounts" })` opens the tab; nothing opens one account in it.

## 2. Design

### The menu

Right-click on an account row (`nav-account-<id>`), or Shift+F10 or the context-menu key while that row has focus, opens `AccountMenu` (`components/account-menu.tsx`, `data-testid=account-menu-<id>`), as the category menu does:

| Item | Test id | Icon | Shown |
| --- | --- | --- | --- |
| New Message | `account-menu-compose` | `SquarePen` (as Compose) | always |
| Check for New Mail | `account-menu-sync` | `RefreshCw` | always |
| Mark All as Read | `account-menu-read-all` | `MailOpen` | always; disabled with no unread in its Inbox |
| Sign In Again… | `account-menu-sign-in` | `KeyRound` | only when the account needs sign-in |
| — | | | |
| Rename | `account-menu-rename` | `Pencil` | always |
| Color ▸ (submenu of radio items, one dot per color) | `account-menu-color`, `account-menu-color-<c>` | the account's dot | always |
| Account Settings… | `account-menu-settings` | `Settings2` | always |
| — | | | |
| Remove Account… | `account-menu-remove` | `Trash2` | always |

Title Case and "…" follow macOS menus (the category menu and the thread menu do the same in English; Spanish uses sentence case, as its other menus do). Items use the existing `ContextMenuItem` styles: icons from `@terno/ui/icons`, `1.15em`, muted until highlighted. Remove is a plain item (the confirmation is where it reads as destructive, as in plan 83).

### Each action

1. **Rename (in place).** The row's label becomes a text field at the same place: same height (`--nav-h`), same left edge as the label (the dot stays), the name selected. It's a plain `<input>` styled like the row (no box, the text field's focus ring kept, per AGENTS.md). Enter or blur saves (`accounts.update({ displayName: trimmed })`). Esc cancels. An empty or unchanged value saves nothing and puts the old name back. While the save is in flight the row shows the new name (optimistic `setAccounts`), and a failure restores the old one and says why in a snack. After Enter or Esc, focus returns to the account row; after blur, it stays where the user clicked. The menu hands focus straight to the field with `finalFocus`, so it never flashes back to the row first. During renaming the row neither toggles nor navigates, and the folder count, chevron and sign-in marker stay where they are. `aria-label` = "Account name". No undo is needed: the old name is one rename away, and the Settings field has none either.
2. **Color.** A submenu of `ContextMenuRadioItem`s, one per `CATEGORY_COLORS`, each a `CategoryDot` plus the color's name (`COLOR_LABEL`, already translated), checked on the current one. Picking it saves optimistically through the same `updateAccount` (moved to `lib/accounts.ts`, so the sidebar and Settings share it).
3. **New Message.** `openCompose("new", null, 0, undefined, account.id)`: a new optional `from` replaces the default account for a new message only. It opens in the reader pane as ⌘N does, with this account as the sender.
4. **Check for New Mail.** `sync.now({ accountId, reason: "user" })`. The first-sync and connection pills already show work in progress. To show the click did something, the snack says "Checking <account> for new mail" (`account.menu.syncing`) and goes away by itself. A failed call says so ("Couldn't check <account>: <reason>").
5. **Mark All as Read.** Marks every unread thread in that account's Inbox read: `threads.actScope` with `{ kind: "view", view: "inbox", accountId, filter: "unread" }` and `markRead`, through the same path as "select all N" + Mark as read (`actScope` in `lib/actions.ts`, exported as `actOnScope(action, scope, count)`). That gives the progress snack, the slicer's time budget on the backend (no new hot path, and it holds at 50k+ because it is the existing scope action), exactly one Undo, and an optimistic patch of the loaded rows that the scope covers. The count in the title is the sidebar's `inboxUnreadByAccount[id]`. It is disabled at 0. No confirmation: Undo is the safety net, as in Mail, which also asks nothing.
6. **Sign In Again….** Opens that account's `SignInMarker` popover, the same panel as clicking the key. The marker's `open` moves to a tiny store (`useSignInMarker`, `{ open: number | null }`) so the menu can open it. The popover takes focus as it does today, and the menu's `finalFocus` is `false` for this item so focus doesn't go to the row and then jump into the popover.
7. **Account Settings….** `setApp({ dialog: "settings", settingsTab: "accounts", settingsAccount: id })`. `AccountsTab` opens that `AccountItem` (its disclosure expanded), scrolls it into view and focuses its toggle. `settingsAccount` is cleared when the dialog closes, so the next plain open of Settings opens nothing.
8. **Remove Account….** The same confirmation as Settings (`account.remove.title`, owner-aware description), extracted into `components/account-remove-dialog.tsx` and lazy-loaded by both the menu and Settings. The sidebar's existing focus hand-off for a removed account (focus to the row now in its place, or Add account) applies.

### Keyboard

`list.menu` gains one step: when focus is on an element inside `[data-context-menu]` (the account rows and, for free, the category rows), it dispatches a `contextmenu` event on that element at its left edge. That is the same thing `openMenuForSelection` does for a thread row. Otherwise it opens the thread menu as before. The resolver is unchanged; this is only the handler.

### Rendering and cost

- `AccountMenu` wraps the row, not the folders. The menu's content mounts only while open (Base UI), so closed menus cost a `ContextMenu` root per account. The sidebar's perf gates (`NavItem:below` render counts) must stay as they are.
- `AccountEntry` stays memoized. The menu needs the account's unread count (already a prop) and whether it is the owner (read inside the dialog, not the row).
- The remove dialog is a lazy chunk (as with categories). The menu itself is small and lives in the sidebar's chunk.
- No timers and no polling. Nothing runs until an item is chosen.

### Strings (en + es)

`account.menu.compose` "New Message" / "Mensaje nuevo"; `account.menu.sync` "Check for New Mail" / "Buscar correo nuevo"; `account.menu.syncing` "Checking {account} for new mail" / "Buscando correo nuevo en {account}"; `account.menu.syncFailed` "Couldn't check {account}: {error}" / "No se pudo revisar {account}: {error}"; `account.menu.readAll` "Mark All as Read" / "Marcar todo como leído"; `account.menu.signIn` "Sign In Again…" / "Volver a iniciar sesión…"; `account.menu.rename` "Rename" / "Cambiar nombre"; `account.menu.color` "Color" / "Color"; `account.menu.settings` "Account Settings…" / "Ajustes de la cuenta…"; `account.menu.remove` "Remove Account…" / "Eliminar cuenta…"; `account.rename.label` "Account name" / "Nombre de la cuenta"; `account.renameFailed` "Couldn't rename the account: {error}" / "No se pudo cambiar el nombre de la cuenta: {error}". Existing keys are reused where they say the same thing.

## 3. Tests

- **Unit:**
  - `account-menu` helpers: the Mark All as Read scope for an account, and its disabled state at 0.
  - `list.menu` routing: a focused `[data-context-menu]` element gets the `contextmenu` event; otherwise the thread menu opens.
  - `openCompose` with `from`: a new draft's account.
  - The rename commit rules: trim, empty or unchanged means no call, and a failure rolls back.
- **e2e (`apps/web/e2e/account-menu.spec.ts`):**
  - Right-click shows the items, and Sign In Again… appears only for an account that needs it.
  - **Rename:** Enter saves (backend row, sidebar, row labels of plan 23), Esc cancels, blur saves, empty restores, focus returns to the row, and the field is where the label was (its box against the label's, both densities).
  - **Color** changes the dot and the backend row.
  - **New Message** opens a draft whose From is that account, while in another account's view.
  - **Check for New Mail** calls `sync.now` with the account (a spy on the handler).
  - **Mark All as Read** reads that account's Inbox and nothing else (other accounts' unread untouched), the count goes to 0, and Undo puts it back. The item is disabled with no unread.
  - **Account Settings…** opens Settings on that account, expanded and focused.
  - **Remove Account…:** Cancel keeps the account; Remove removes it, and focus lands on the next row.
  - **Keyboard:** Tab to the row, then Shift+F10 opens its menu (and on a category row, the category menu). Arrows and Enter work.
  - The menu is axe-clean in light and dark.
- **Perf:** `pnpm test:ui-perf` sidebar gates (render counts unchanged).
- **Screenshots:** light and dark, the menu and the rename field, in all three designs → `/tmp/terno-scratch/account-menu-102/`.

## 4. Out of scope

- Reordering accounts (drag in the sidebar), pausing sync, and copy address.
- A rename shortcut (F2 or double-click). It can come later and use the same field.
- Mark All as Read on a whole folder or a category. This plan covers only the account's Inbox.

## Revisions after the Codex review

Codex (plan critique, 12 points) checked the plan against the code. Changes:

1. **Mark All as Read doesn't reuse `actScope`'s optimism.** `scopeRows` doesn't check account, view, hiding or tabs, so from another account's list it would have patched that list's rows. New `markAccountRead(account)` in `lib/actions.ts` shares the job, snack and Undo plumbing (`trackJob`, `registerUndo`, `undoActions`). It patches loaded rows only when the list on screen *is* an Inbox listing (unified, or this account's; no tab, category, folder or search). There it patches just this account's unread rows. Anywhere else it changes nothing until the reload that follows.
2. **Rows and selection.** Rows leave only when the list's own quick filter is Unread; otherwise they are marked read in place. The checked rows and "select all" scope are left alone (this isn't an action on the selection).
3. **Semantics stated and tested in both stores.** "This account's Inbox" is what its sidebar count counts: threads in its Inbox, minus categories hidden from the Inbox, minus Promotions/Social when it keeps Gmail tabs apart. Store tests in `packages/db` and `packages/idb` check that the scope's ids equal the count's threads with a hidden category and with `separateTabs` on and off, and that Undo puts every one back.
4. **Perf.** New 50k+ cases in both stores' perf suites: the unread-Inbox scope of a *sparse* account (no unread, and 10 unread) in a mailbox where another account has tens of thousands of unread threads. A page and the whole walk stay within the existing scope budgets. If they don't, the fix is an index, not a smaller page.
5. **Rename field is not nested in the button.** While renaming, `AccountEntry` draws a non-interactive shell with the row's geometry (the same classes as `NavItem`) holding the dot and the `<input>`. The sign-in marker stays a sibling. Axe runs on the editing state too.
6. **One commit per edit.** A `settled` ref ends the session before focus moves: Enter commits then focuses the row, Esc cancels then focuses the row, and the blur that follows does nothing. IME composition (`isComposing`) never commits. Keys in the field stop propagation, so the disclosure and global shortcuts never see them.
7. **Overlapping saves.** `lib/accounts.ts` `patchAccount(id, patch)` applies the patch optimistically and keeps a per-account, per-field generation. A response or a rollback writes a field only if no newer edit of that field started since. The other fields come from the response or events as now. A removed account is skipped. Unit tests cover overlap, failure after a newer success, and removal while saving.
8. **Keyboard menus marked explicitly.** Both `AccountMenu` and `CategoryMenu` render their trigger as a `<div data-context-menu>` wrapper. `list.menu` finds `document.activeElement.closest("[data-context-menu]")` and dispatches a bubbling, cancelable `contextmenu` from the focused row. The thread menu doesn't open then. e2e covers both rows and both keys.
9. **Remove's focus.** The menu remembers the account. On success, focus goes to the row now in its place, or to Add account, but only if focus is on `body` or inside the dialog that just closed (never after a deliberate move). Cancel and failure return focus to the account row. Tests cover keyboard and pointer, Cancel, failure, the last account, and a slow RPC.
10. **Sign In Again prepares like the marker.** The item runs the marker's preparation (`loadPanel()`, plus `prepareGoogle()` for Gmail on the web), then asks the marker to open. The popover focuses its first control once the panel has mounted (the panel's own initial focus), cold or warm.
11. **No stale marker state.** The request is a one-shot `{ id, nonce }` in a tiny store that the marker consumes on mount or change: it sets its local `open` and clears the request. Nothing global survives an account that signs in or is removed.
12. **Settings' focus goes through the dialog.** `settingsAccount` is read once by `AccountsTab` on mount (it expands that item) and handed to the dialog's initial focus (the same `switchFocus` path the dialog already uses), then cleared. A missing account falls back to the tab's default focus. Account events later never refocus.
