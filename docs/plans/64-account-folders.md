# 64 · Accounts open into their folders

## Request

> also, when clicking on an account from a multiple accounts, it has to expand, to show its inside folders like custom folders created by gmail or by us, or its own spam/inbox/sent and other common folders, of course this needs to follow and have simple intuitive ux

Asked which layout to use, the user chose the **Apple Mail model**:
- The folders at the top of the sidebar always mean all accounts.
- Clicking an account opens its Inbox and expands its folders underneath, one account at a time.
- "All accounts" goes away.

On scope, the user agreed to two steps but wants both built in full now: "since the app has not launched, it needs to be fully built from now". This plan is step one, the layout and each account's standard folders. Plan 65 is step two: the account's own folders (Gmail labels and IMAP folders), synced, stored and listed in the same place.

## What exists

- The sidebar (`sidebar.tsx`) has three parts:
  - **Folders.** Inbox and Starred, then More (Sent, Archive, All, Spam, Trash; plans 21 and 40).
  - **Categories.**
  - **Accounts.** "All accounts", then each account.
- An account row sets an account filter (`navigate({ accountId, view })`). Every view, the folders and the categories are then scoped to that account. The list header shows "· Personal".
- Views are global predicates (`View`, `VIEWS` in core). `threads.list` takes `accountId`.
- Keyboard (`g i`, `g s`…) and the palette call `navigate({ view })`, which keeps the account filter.

## Design

### The rule

**What's at the top is all your mail; what's under an account is that account's.** Nothing is listed twice while it means the same thing.

### Folders and categories (top)

- Clicking a top folder goes to it for all accounts (`accountId: null`). It shows as selected only when no account is in scope.
- Clicking a category does the same: categories are cross-account (plan 02), so a category row clears the account. The List layout's category tabs keep their current behavior, because they filter the list you're in.

### Accounts

- An account row is a disclosure (`aria-expanded`, `aria-controls` its group). It shows the account's dot, its name and its inbox unread count.
- **Click a collapsed account:** it expands, any other account collapses, and you go to its Inbox (unless you're already in one of its folders).
- **Click an expanded account:** it collapses and you stay where you are. If you're in one of its folders, the account row now carries the selected fill, so you can still see where you are (the same idea as a hidden More folder staying visible while open, plan 40).
- **Under an open account,** indented: Inbox (with its unread count), Sent, Archive, Spam, Trash. Starred and All Mail stay at the top only: they're cross-account views, and listing them per account would add rows without adding a place to go. Each row is `navigate({ accountId, view })`.
- **The count moves:** while the account is open, its unread count shows on its Inbox, not on the account row, so it never appears twice.
- **Remembered:** the open account is saved (`terno:sidebar-account`) and restored on launch. Going to an account by other means (palette, a notification, a shortcut that scopes to it) opens it. An account that's removed simply closes.
- **Motion:** expanding uses the More group's 0fr→1fr rows at `--motion` (none when motion is reduced). Hidden rows are `inert`.
- "All accounts" is removed (the top folders are all accounts). With one account, the Accounts section still shows that account and its folders the same way.

### Keyboard and palette

- **`g i`, `g s`, `g t`, `g a`** and the palette's folder commands keep the scope you're in. In Personal's Sent, `g i` goes to Personal's Inbox; from the top folders, it goes to the all-accounts Inbox. A shortcut is "go to this folder here", and the sidebar highlights the row it went to.
- **The palette's account command** goes to that account's Inbox and opens the account.
- The palette also offers "All accounts": it goes to the all-accounts Inbox, so the old row's job stays reachable by keyboard.

### What a row shows as selected

At most one row in the sidebar is selected:
- the top folder, when no account is in scope;
- the category, when one is open;
- the account's child row, when its account is open;
- the account row, when its account is collapsed and you're inside it.

## Accessibility

- An account row is a button with `aria-expanded`. Its folders sit in a `role="group"` labelled "Personal folders".
- Every row stays reachable with Tab. Focus rings follow plan 54.
- If a focused child is hidden by collapsing, focus moves to the account row (the More group already does this).
- axe runs in light and dark with an account open.

## Tests

- **e2e (`account-folders.spec.ts`, `@design`):**
  - Click an account: it expands with its five folders, the list shows only that account's Inbox, and the header says "· Personal".
  - Click another account: the first one collapses.
  - Click the open account: it collapses and the view stays; the account row is then selected.
  - A child row (Sent) lists that account's sent mail and is the only selected row.
  - A top folder goes to all accounts and deselects the account's rows.
  - The count is on the Inbox child while open and on the row while collapsed.
  - Choosing a category clears the account.
  - `g i` keeps the scope.
  - The palette's account and "All accounts" commands.
  - The open account survives a reload.
  - Keyboard: Tab to the account, Enter toggles it, and `aria-expanded` follows.
  - axe in light and dark.
- **Existing tests:** tests that used "All accounts" now use a top folder (`account-label`, `categorize`, `sidebar-panels`).
- **Unit:** the scope rules for `navigate` (top folder, category, account child, shortcut) and the open-account store.
- **Visual:** light and dark, in macOS, Lumen and Atelier. Lumen and Atelier baselines that show the sidebar are updated.

## Perf

- No new queries: account child rows reuse `threads.list` with `accountId` and the per-account inbox counts that already exist.
- At most 5 extra rows are rendered, only for the open account.
- The UI-perf gate runs as usual.

## Out of scope (plan 65)

The account's own folders: Gmail labels and IMAP folders, listed under its standard folders.

## Revisions after the Codex review

1. **Starred and All Mail have no row under an account, so their shortcuts and palette commands go to the top ones** (all accounts). `g i`, `g t`, `g a` and Trash keep the scope, because the account lists those folders.
2. **List layout tabs filter the list you're in.** With an account in scope, a category tab keeps the account, and the account's Inbox row stays the selected one; the category row is selected only when no account is in scope.
3. **Category entry points:**
   - Everything that opens a category from the sidebar or the palette (the row, the review badge and review row, the palette's category command) clears the account.
   - Creating a category from the tab bar keeps the scope, like the tabs.
   - When a category is deleted, the fallback Inbox keeps the scope.
4. **Notifications keep opening the all-accounts Inbox.** That's an aggregate entry point. The earlier promise that a notification opens the account is dropped.
5. **Accounts that come and go:**
   - If the account in scope is removed, you go to the all-accounts Inbox.
   - A stored open account that no longer exists is ignored.
   - Adding an account changes nothing.
   - This is reconciled when the account list arrives (`setAccounts`).
6. **Opening an account is separate from navigating:**
   - Only an explicit "go to this account" (its row, the palette's account command) opens it.
   - Shortcuts and other navigation never change what's open. If the account in scope is collapsed, its row is the selected one.
   - At launch only the open account is restored, not the scope; the app still starts in the all-accounts Inbox.
   - Opening or closing an account leaves the selection and scroll position alone.
7. **Designs that greet** (`listHeader: "greeting"`) leave the account out of the Inbox's title, as they do today. The sidebar still shows the scope. The e2e test checks the "· Personal" suffix only where the design shows it.
8. **The sign-in marker stays with its row:** the row and marker get their own positioning wrapper, apart from the folder group. Opening sign-in neither navigates nor opens the account.
9. **Back/Forward and reload:** scope isn't in the URL today, and this plan doesn't change that. Restoring scope through history is out of scope.
10. **With one account,** its standard folders would be exactly the top ones, so it lists none. Its row isn't a disclosure until it has its own folders (plan 65); it stays a plain row that scopes to the account. Tests cover going from one account to two and back to one.
11. **Drag and drop:** account rows and their folder rows don't accept drops (moving to folders is a later feature). An e2e test checks that dropping on a category still works with an account open and the sidebar scrolled, and that account rows never become drop targets.
12. **Accessibility:**
    - The selected row gets `aria-current="page"`.
    - Group names are localized ("Personal folders" / "Carpetas de Personal").
    - Enter and Space toggle an account.
    - Hidden rows are `inert` and out of the Tab order.
    - Focus returns to the account row when its folders close on a focused child, and to the next row when a focused account is removed.
    - The seam test (`sidebar-panels.spec.ts:705`) now uses two adjacent rows under an open account: Inbox selected, Sent hovered.

## Code review

**Round 1.** Codex found three problems; each is fixed with a test that fails without the fix:
1. **Closed accounts mounted their five folder rows,** so N accounts cost 5N rows on every sidebar render. A closed account now mounts none; a closing one keeps its rows only through the slide (`CLOSING_MS`). Test: e2e checks how many folder rows are mounted as accounts open and close.
2. **The palette's account command did nothing from inside that account** (from its Sent, or from a search). It now always lands in its Inbox; only the account's row keeps you where you are when it opens. Tests: unit and e2e.
3. **Going from two accounts to one dropped keyboard focus** when a folder of the account that stays was focused, because its folders unmounted with nothing to hand focus to. Focus now goes to that account's row. Test: e2e.

**Round 2.** Codex found one more problem (an earlier attempt hit "model at capacity" and was rerun):
4. **Creating a category with the sidebar's "+" kept the account filter,** so the new category opened scoped to the account while its row wasn't selected. The sidebar's "+" now opens it for all accounts; the tab bar's "+" keeps the account, like the tabs. Tests: unit and e2e.

**Round 3.** Codex found one more problem (the first attempt hit "model at capacity" again and was rerun):
5. **A background account update could pull focus back to the sidebar.** The last focused account was remembered after focus left on purpose. Focus that leaves is now forgotten once the next frame shows the row is still in the page, and recovery runs only when rows actually went away (an account removed, or two accounts down to one). Test: e2e, with the account's IDs unchanged and an account update.
