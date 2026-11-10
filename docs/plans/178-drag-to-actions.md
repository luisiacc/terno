# 178: Drag mail onto Starred, Archive, Spam and Trash

## Request (verbatim)

> i thinks these items should allow an email or multiple selected emails to be dragged to them and it would make that action, archive,spam,trash,starred, it will just do that actio

The screenshot points at the sidebar's Starred, Archive, Spam and Trash rows (More open).

Decisions taken without asking, each reversible:

- **Every row of those four places takes a drop**: the top ones (all accounts), an account's own (its group, a focused account's sidebar) and favorites of them. An account's row takes only that account's mail, as its folders do (plan 127): dropping another account's mail there would act in an account the row doesn't name.
- **Starred stars, never unstars.** Dropping starred mail there changes nothing (the ✓ "Already here").
- **A drop is the action, exactly as the button or key does it**: the same `act()`, so the same optimistic leave, selection advance, snack, similar-mail offers (plan 63) and one exact Undo (z, ⌘Z, the snack's).
- **More stays as it is.** A target is what's on screen: with More closed, Archive, Spam and Trash take a drop only while shown anyway (the one you're in, a held one); no spring-loading (below, Out of scope).

## What exists

- **The drag** (`lib/drag.ts`, `lib/drag-install.ts`, plans 01, 24, 127): a pointer controller over measured target rects. A target is a `DropId`: a number is a category (`data-drop-target`), a string a `folderRef` (`data-drop-folder`). States `over`, `already` (✓) and `refused` (no highlight; a drop says why). Only the `NavItem`s whose state changes re-render (`useDropState`).
- **Facts read once** (plan 127): `factsOf(rows)` at drag start, so pointer moves never walk the rows.
- **Actions** (`lib/actions.ts`): `act(action, ids)` does everything a triage action does. In a search, `fitting()` keeps the rows an action fits (`placeActions`, plan 64); outside one, the view's rule.
- **What an action changes** (`packages/db/src/actions.ts`): `archive` only takes messages out of the Inbox (mail in Spam or Trash stays where it is), `spam` anything not already spam, `trash` anything not in Trash, `star` the latest message.

## Design

### Targets

A new pure module, `lib/action-drop.ts`, is the one place that knows this kind of target:

- `DROP_ACTIONS = { starred: "star", archive: "archive", spam: "spam", trash: "trash" }`: which view takes a drop, and the action it does.
- `actionRef(view, accountId | null)` → `"view:archive"` or `"view:archive:3"`. A prefix of its own: a `folderRef` is `"<accountId>:<key>"` and an IMAP folder may be called `archive`, so `viewRef`'s format would collide.
- `parseActionRef(ref)` → `{ view, accountId } | null`.

`NavItem` renders a string target as `data-drop-action` when `parseActionRef` reads it, else `data-drop-folder` as now. `measureTargets` reads the three attributes. `DropId` stays `number | string`; `drag-install` branches on `parseActionRef` before `parseFolderRef`.

Rows given a target: the four top rows (`folder()` in `Sidebar`), an account's `archive`, `spam`, `trash` (and in a focused account, `starred`) in `AccountFolders`, and view favorites in `FavoriteRows`.

### States, decided from facts read once

`actionFacts(rows)` at drag start (beside `factsOf`), per view:

- **fits**: the ids the action changes, by the row's place (`placeOf`): Starred the unstarred; Archive the ones in the Inbox (all `archive` changes); Spam any not in Spam (Trash's menu offers Spam too); Trash any not in Trash. Then narrowed as `act()` would (`fitting`: in a search, plan 64's rule). A row whose place isn't known (an older backend) fits: the backend decides.
- **already**: every row is there already (starred; archived; in Spam; in Trash).

The state of a target:

1. an account's row and any row of another account → `refused` ("Archive is in another account…", the folder's wording made general);
2. nothing fits and every row is already there → `already` (✓);
3. nothing fits otherwise → `refused`, with why. Archive (mail in Spam or Trash): "Only mail in the Inbox can be archived. Move it to the Inbox first." Spam, only in a search over Trash: "Mail in Trash can't be marked as spam from a search. Open Trash to do it.";
4. else `over`.

### The drop

`act(DROP_ACTIONS[view], fits)`: only the rows it fits, as a search's buttons do (the snack counts what changed). The ghost flies into the row's icon (`data-slot=nav-icon`, as for a folder). Nothing else is new: leave, selection, snack, offers and Undo are `act()`'s.

## Tests

- **Unit** (`lib/action-drop.test.ts`): ref round trip (and a folder named `archive` is not an action); `actionFacts` fits and already for each view over rows in each place, unknown place; states, including another account's row.
- **Unit** (`drag-install.test.ts`): an action target is measured with its ref, and the query asks for it.
- **E2E** (`apps/web/e2e/action-drop.spec.ts`, two pages of `scenario()`s): drag two checked rows onto Archive → both leave, the DB says archived, z brings both back; drag onto Starred → starred in place, ✓ when dragged again; Trash and Spam each move a row. An account's Trash refuses another account's row and says why, nothing changes; its own row onto its Archive, and onto a favorite of its Trash, works. Axe on the sidebar mid-drag isn't new (states exist).

## Performance

Facts are one pass over the dragged rows at drag start (≤ the loaded rows); a pointer move reads a precomputed state. No new subscriptions: rows don't re-render; the target rows re-render as categories' do. `dnd` perf gates unchanged.

## Out of scope

- **Spring-loaded More**: hovering "More" during a drag to open it. A follow-up if wanted.
- **Inbox, Sent, All Mail** as targets (Move to Inbox by drag): not asked.
- Dropping a selection of "all N" (`scope`): not draggable today, as for categories.

## Revisions after the Codex review

1. **Spam takes what's in Trash** (Trash's menu offers it; the backend marks it and keeps it in Trash). Only a search's narrowing can refuse it, and the words say so.
2. **A thread whose newest message is in Trash** may still read unstarred after Starred takes it: `star` marks the newest message, as the `s` key does. Kept for parity with the button; not new here.
3. **Facts are read again at the release** (`readFacts` on pointerup, before the controller re-tests the target), so a sync that changed a row mid-drag can't make a drop do an action already done, or replace a useful Undo with an empty one.
4. **A favorite and its account's row light up together** (same ref). Plan 127's folder favorites do the same; kept consistent, at most four `NavItem`s re-render.
5. **Closed More**: the targets follow what's on screen (inert rows aren't measured), including a held or current row; the decision above says so.
6. **The measuring test asserts the selector**: its fake ignored it, so a missing `[data-drop-action]` would have passed.
7. **E2E covers a working drop** on an account's row and on a favorite, not only a refusal.
