# 90: Your filters and automatic filters

## Request (verbatim)

> in the filters section settings, we would need to separate the users custom filters, from the filters created automatically from us.

Agreed before this plan (point 5 of the review of the proposal):

> Avoid a pile-up of automatic filters. Dragging another "Tu pedido # está en camino" reuses the existing filter. And if you later move one of those emails out of the category, we offer to turn the filter off.

## What exists

- `Filter.source` is `manual | ai | learned` (SQL `CHECK`; IDB records). It says how the rule was written, not who decided to have it.
- `SimilarFilters.ensureRule` (plans 63, 80, 81) saves everything it creates as `manual`. Spam sweeps also set `learnedKey`. These filters are indistinguishable from the user's own in Settings → Filters, which is one flat list (`filters-tab.tsx`).
- `ensureRule` reuses an identical enabled rule and re-enables an identical disabled one. Moving the same sender + subject to a different category makes a second filter, so the next such mail lands in both categories.

## Design

### 1. An `auto` flag

- **Storage:** `Filter` gains `auto: boolean`.
  - **SQL:** migration v35 `ALTER TABLE filters ADD COLUMN auto INTEGER NOT NULL DEFAULT 0`. The `source` CHECK is untouched, so the table isn't rebuilt and its triggers and foreign keys stay as they are.
  - **IDB:** an optional field, read as `false` when absent.
- **Existing filters:** the migration marks `source = 'manual' AND learned_key IS NOT NULL` as auto. Only `SimilarFilters.ensure` ever wrote that combination (learning writes `learned`). IDB derives the same rule when the field is absent.
- **Saving:** `filters.save` takes an optional `auto`; the default is `false`, so anything the user saves is theirs. `SimilarFilters.ensureRule` saves `auto: true`.
- **Editing:** saving an auto filter from the builder with any change to its name or rule makes it `auto: false`, since the user has now chosen it. Turning it on or off from the list keeps it automatic.

### 2. Settings → Filters, in two groups

- **"Your filters"** (`filters.group.yours`): the existing group, with "New filter", for the `auto: false` filters.
- **"Created for you"** (`filters.group.auto`): the `auto: true` filters, under a one-line description: "Terno made these when you sorted mail. Edit one and it becomes yours." Each row works like today's rows (switch, edit, delete), plus "Turn all off" at the group's head when there is more than one.
- **When empty:** the automatic group is hidden.
- **Order:** both groups sort newest first, the same as today.
- **The filter dialog's sidebar list** shows the same two sections, with a small heading each.

### 3. Retargeting instead of piling up

- When `ensureRule` creates an **auto** category filter, it first looks for an auto filter whose conditions are the same (same `match`, conditions compared as `sameRule` compares them) and whose only action is `addCategory` to another category. If it finds one, it changes that filter's target instead of adding another, and the undo record puts the old target back.
- **The user's own filters (`auto: false`) are never changed.**
- The result reports `retargeted: { from: categoryId }` so the snackbar can say "Future mail moves to Facturas instead of Lecturas".

### 4. Offer to turn a filter off when mail leaves its category

- **Lookup:** a new RPC `filters.autoFor({ categoryId, threadIds ≤ 200 })` finds the enabled auto filters that add `categoryId` and whose rule matches any message of those threads. It uses `findRuleMatches` (SQL, `onlyMessageIds`) or `evaluateRule` (IDB), over at most 200 threads' messages.
- **When it's asked:** when the user takes threads out of a category:
  - the reader's category chip ×
  - the context menu's category toggle
  - a move to another category from a category view
- **The offer:** if a filter is found, the snack gains "Stop filing mail like this into Facturas" (the secondary action), which turns those filters off (`filters.save enabled: false`) with its own Undo.
- **Moves:** after a move, the retargeting in section 3 already covers it, so no offer is shown.

## Tests

- **db:** the migration marks only the manual+learnedKey filters; `filters.save` keeps `auto`.
- **Conformance (both stores):**
  - `auto` round-trips.
  - `ensureRule` retargets an auto filter and never a user filter.
  - Undo restores the old target.
  - `autoFor` finds a filter only for matching threads.
- **Unit:**
  - The builder's save flips `auto` only when something changed (a `filters-dialog` test).
  - The list toggle keeps `auto` (`filters-tab`).
- **e2e (`filters.spec.ts`):** a filter made from the snackbar shows under "Created for you"; editing it moves it to "Your filters".
- **e2e (`categories.spec.ts`):** removing a filed thread from its category offers "Stop filing…", which turns the filter off.

## Perf

- **`autoFor`:** at most 200 threads' messages × the auto filters that target the category. It runs once, after the user acts, and never on idle.
- **`ensureRule`:** already lists filters; nothing new is stored.

## Out of scope

- Expiring unused auto filters automatically.
- Merging two of the user's own filters.

## Revisions after the Codex review (plan)

1. **The backfill is partial, on purpose:** only manual filters with a `learned_key` are marked auto. Category and subject filters made before v35 stay under "Your filters", because their origin can't be proven.
2. **`auto` on save:** it defaults to `false` only when a filter is inserted. An update keeps the stored value unless `auto` is passed. The builder passes `auto: false` only when the name or the rule changed.
3. **Reuse rules:** `ensureRule` reuses an identical enabled filter of either owner without changing it. It re-enables only an identical disabled **auto** filter; a disabled user filter is never touched (a new auto one is made). An exact match wins over a retarget candidate, and the newest candidate is retargeted.
4. **Undo journal variants:** the undo journal gains `retargeted` and `disabled` entries. Each holds the full prior state (name, enabled, rule, auto) and the state it left. It restores only when the current state still equals what it left.
5. **Claims survive a retarget:** a retarget keeps the filter's `filter_applications` (`keepApplications`). Old mail is never re-filed into the new target, and an undo finds the claims as they were. A user's edit still clears them, as today.
6. **Race-safe writes:** every automatic write is compare-and-set. `filters.save` takes `expect` (name, enabled, rule, auto), checked in the store's transaction, and a mismatch is CANCELLED. Settings edits made meanwhile win.
7. **Rule comparison** is op-aware (plan 89, revision 2).
8. **After moves:** the stop-filing offer shows after any removal or move, unless that operation's default retargeted those very filters.
9. **Bounded `autoFor`:** it runs on the threads' root inbound messages only (one per thread, ≤ 200), which is what sender and subject rules decide on. Each filter stops testing at its first match.
10. **A removal snack:** taking threads out of a category shows "Removed from Facturas", which it didn't before. The offer joins it only while that snack is current. An undo removal (`reason: "undo"`) asks nothing.
11. **`filters.setEnabled`:** a narrow `filters.setEnabled({ ids, enabled })` with compare-and-set and a journaled undo (`filterUndo`) is used by "Stop filing…" and "Turn all off".
12. **Backup and restore:** export, pending imports and restore carry `auto`; it is absent, meaning false, in older backups.

## What the Codex code review changed

- **A partial failure keeps its undo:** the filter writes are journaled as they commit. A compare-and-set conflict skips that filter (the edit wins). Any other failure rethrows with the undo of what already committed (`filterUndo` in its details), and `categorize.apply` and `similar.apply` pass it on.
- **Undo never deletes an edited filter:** undo deletes a filter it made only if the filter is unchanged (`filters.delete(id, expect)`, checked in the store's transaction in both stores), so a user's edit made in between survives.
- **Conflict cleanup on reuse:** reusing an enabled sender filter still turns off that sender's automatic subject filters that file elsewhere.
- **Moves offer to stop filing (revision 8):** a move records the categories it took mail out of (`Filed.left`). Once the default settles, the category snackbar offers "Stop filing mail like this into Lecturas" when one of Terno's filters fills that category, except for the filter it just retargeted.

Tests: `similar-filters.test.ts` (failure after a commit, edit between read and delete, reuse cleanup), and the e2e for the move's stop line.

Deviations from the plan:
- "Turn all off" has its Undo in the Settings group itself, since the dock is under the dialog.
- The filter lists keep their stored order (position), not newest first.
