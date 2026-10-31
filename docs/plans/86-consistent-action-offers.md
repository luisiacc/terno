# 86: The same follow-up offers for every action, and a default for bulk mail

## Request (verbatim)

> also, when dragging something to another category, archiving, spamming, we need to be very consistent with always showing the same automations to do them, lets do what we do for moving to categories, lets be consistent with the snackbar we show below as well as with the items shown on the submenus on the right click context menu.
>
> also, when dragging something to another category, we should automatically also drag and creat a filter for the subject + sender combination, and of course we have the snackbar with the undo timer so they can go back, then the options continue to be like now, but we'll have to say it like 'Moving 47 emails with same sender and subject, then an option to also move all with that sender, then other options like the ones we currently have, then the last option is to move only this specific email, and it needs to be extremely clear like saying "No, only move this email". as we said, we need to be consistent doing this for other actions like marking as spam, now that i think about it, we should not do this by default when archiving, since archiving is more custom, so for archiving the default will be to archive only that email, and then on the undo snackbar we show the 'sender+subject' combo as the 1st option then the other options.

The adjustments the user agreed to:
1. The automatic sender + subject default applies only when the sender is automated (not a person) and the group holds more than the conversations moved.
2. Spam defaults to the whole sender (spammers vary subjects); sender + subject is the next option.
3. "No, only move this email" undoes exactly the extra conversations and the filter, and keeps the dragged ones where they were put.
4. Several conversations from different senders get no default; a shared sender and subject still does.
5. Automatic filters are reused, not piled up (plan 85).

Trash behaves like archive (only the email by default); the user didn't object to that proposal.

## What exists

- **After a move to a category** (drag, "Move to…", the context menu), the category snackbar (plans 13, 81) shows stacked offers:
  - 1: everything from the sender
  - 2: the domain
  - 3: the list
  - 4: words

  1–3 file the mail now and make a filter (`fileAlways`); 4 files once. There is no sender + subject offer.
- **After archive, trash or spam**, the similar snackbar (plan 63) shows a sideways strip of chips in the order sender, subject, domain, list. Spam sweeps also make a filter; archive and trash offer "Always" afterwards.
- **Right-click** has "Archive similar" and "Spam similar" submenus in the order sender, subject, domain, list, and an "All from X" submenu for categories. The orders, the labels and the layout differ between the two snackbars and the menus.

## Design

### 1. One offer list, one order, one look

The **offer list** is `orderOffers()` in `lib/offers.ts`. It's shared by both snackbars and every submenu, and always runs in this order:

1. **Same sender and subject:** "Same sender and subject" plus the subject's `#` template, muted (plan 84).
2. **Everything from <name>**
3. **Everything from @domain**
4. **This mailing list**
5. **Everything mentioning … (categories only):** a search over all mail with no single place to act on fits filing, not archiving or spam.

Each line has a number key, a label, a quiet "+ new mail" when it also makes a filter, and the count on the right.

The **number keys** follow the visible lines (1…n). `0` is "No, only …" (below), a new `snackbar.only` keybinding.

**Which lines show:**
- An offer that adds nothing beyond what's already done is hidden: the current `sameAsSender` and `visibleOffers` rules, plus "the default's own scope".
- When the default ran, the line it ran is not offered again. The title says it.

**One layout:** the similar snackbar takes the category snackbar's stacked layout. The shared pieces move to `components/offer-lines.tsx` (`OfferLine`, `OfferCount`, `OnlyLine`). The sideways `Strip` and `Chip` go, along with the similar snackbar's horizontal strip.

### 2. The defaults

| Action | Default | Then offered |
|---|---|---|
| Move to a category (drag, "Move to…", the menu) | **Sender + subject**, if automated and the group is larger than the targets; else only these | sender, domain, list, words |
| Spam | **The whole sender** | sender + subject, domain, list |
| Archive, Trash | **Only these** | sender + subject, sender, domain, list |

**"Automated"** means every target's `threads.person` is 0. The backend reports this as `automated` in the offers, so the renderer never guesses from rows that might not be loaded.

**When the default runs:**
- The default is computed with the offers (one call: `offers.forAction`, below) right after the action itself succeeds. It runs only while the action's undo is still `ready`; a `z` pressed first means it never starts.
- **For a move:** `categorize.apply { scope: subject, always: true, move: true }` moves the rest of the group (exclusive, journaled like a drag) and ensures the auto filter (plan 85: reused or retargeted).
- **For spam:** `similar.apply { scope: sender }` sweeps the rest and makes the filter, as the sender chip does today.

### 3. What the snackbar says

**Title.** With a default, the title says what happened in full:
- "Moved 47 emails with the same sender and subject to Facturas" (`offers.default.move`)
- "Marked 52 emails from Mercado Libre as spam" (`offers.default.spam`)

The note under it reads "Future ones too" (`offers.default.future`), and "Future ones move to Facturas instead of Lecturas" when the filter was retargeted. Without a default, the title is today's ("Moved to Facturas", "Archived").

**While the default runs**, the title reads "Moving 47 emails with the same sender and subject to Facturas…" with the progress pulse, and the offers are disabled until it settles.

**The last line, after the offers:**
- `0  No, only move this email`, or `No, only move these 3 emails` (`offers.only.move`), and the spam equivalents.
- It's styled as a plain line, never destructive red, and is clearly a choice.
- It undoes the default's sweep and its filter (the `filterUndo`), keeps the targets where the action put them, then shows the plain title. The undo token is replaced by the action's own undo, so `z` still takes back the move itself.

**Undo and z** take back everything: the default, then the action, then any offer run after it. This is the `original` chain `applySimilar` uses today, generalized as `chainUndo(original, next)` in `lib/offers.ts`.

**An offer pressed after a default** runs on top of it. For example, "Everything from Mercado Libre" after the subject default moves the rest of the sender's mail. Undo still unwinds every part.

### 4. Backend

- **`offers.forAction({ threadIds ≤ 200, action: "archive" | "trash" | "spam" | { category: id } })`** returns `{ senderName, automated, offers: SimilarOffer[] }`:
  - For the place actions it wraps `similar.offers`.
  - For a category, the counts are `categorize.countScope` per scope, including the subject scope, which `quickActions` didn't have.
  - `automated` comes from `threads.person`.
- **`categorize.quickActions`** keeps the words, with the subject scope added.
- **`categorize.apply`** gains `move?: boolean`. With it, the resolved ids go through `beginMove`/`finishMove` (source `"snackbar"`, `addedBy "bulk"`) instead of `categories.add`. The result is the same `{ batchId, added, filter }`, and `categorize.undo` already undoes a move batch exactly. The excluded set follows the scope's existing exclusions; the targets are already in the category, so the resolve's "not yet in the category" skips them.
- **Same scope, everywhere:** the spam default uses `similar.apply` unchanged; the sender scope, its filter and undo are exactly today's.

### 5. Right-click menus

- **Archive, Spam and Trash** each get a submenu: "Archive…", "Mark as spam…", "Delete…". It lists:
  - "Only this email" (or "these N"), first: the plain action
  - then the offers in the same order, with the same labels and counts as the snackbar
- **The menu as a whole:**
  - The top-level Archive, Spam and Delete items stay, so one click still does the default.
  - For spam, the default is the whole sender, so the plain "Mark as spam" item runs the same default as the `!` key.
- **"Move to"** → a category runs the same default and snackbar as a drag (it already goes through `moveToCategory`).
- **The category submenu's "All from X"** is replaced by the same offer list for that category: "Same sender and subject", "Everything from X", domain, list. Its "Remove from category" part (plan 77) stays.

### 6. Where each piece lives

- **`lib/offers.ts`:** `orderOffers`, `chainUndo`, `runDefault`, and labels (moving from `lib/similar.ts` `scopeLabel`).
- **`components/category-snackbar.tsx`:** keeps the words line and filing. Its header, offer lines and only-line come from `offer-lines.tsx`.
- **`components/similar-snackbar.tsx`:** the same header and lines for archive, trash and spam.
- **`lib/actions.ts`:** `act()` asks for offers for spam before the snack, so the default can run. Archive and trash grow the snack as today.

## Tests

- **Unit:**
  - `orderOffers` gives one order for every action.
  - `chainUndo` undoes the default, then the action, and "only" undoes just the default.
  - Visibility rules: the default's own scope is hidden; an offer adding nothing beyond what's done is hidden.
- **backend:**
  - `categorize.apply move` journals and undoes exactly.
  - `offers.forAction` reports `automated` and the subject count.
  - The default's scope excludes the targets.
- **e2e:**
  - **`dnd.spec.ts`:**
    - Dragging an automated sender's mail with a larger group moves the group.
    - The title says the count.
    - A filter exists under "Created for you".
    - "No, only move this email" brings the others back and deletes the filter, while the dragged email stays.
    - `z` undoes everything.
    - Dragging a person's mail moves only it.
  - **`similar.spec.ts`:**
    - Spam with one sender sweeps the sender and offers sender + subject, domain and list, then "No, only mark this email as spam".
    - Archive archives one email and offers sender + subject first.
    - The right-click submenus list the same lines in the same order as the snackbar (labels and counts compared).
  - **`snack.spec.ts`:** `0` runs "only"; 1…n follow the visible lines.
- **Every snackbar state** gets light and dark screenshots, plus the axe check.

## Perf

- **One extra call** per action (`offers.forAction`), capped at 200 targets and bounded per sender like today's offers. The default's sweep is sliced and yields like today's sweeps.
- **No new timers;** the snackbar's countdown is unchanged.
- **`load.perf.test.ts`** gets a case: a default move of a 2,000-thread group, with interactive latency under the existing gate.

## Out of scope

- Words for archive, trash or spam.
- Defaults for "Add to category" (additive toggles) and accepted suggestions.

## Revisions after the Codex review (plan)

1. **Undo unwinds newest first:** later offers, then the default, then the action. Each step is marked done, so a retry after a failure skips what already came back.
2. **The menu's "Only this email"** runs `act(action, ids, { automation: "none" })`: no default, no offers.
3. **Narrower after a default, the default is replaced.** It's undone (sweep, and its filter if it made one), then the chosen scope runs. "Sender + subject" after the spam sender default is one case. Wider offers (domain, list, and sender after a subject default) run on top; for categories, the default's own filter is taken back first, so the wider filter replaces it. A filter that existed before the action is never touched, and the line notes it.
4. **Stale defaults:** each action gets a generation. The default starts only if its snack is still the dock's current snack and its undo is still the global one.
5. **Bounded counts (accepted, measured):** category counts keep their existing per-scope cost. `categorize.perf.test.ts` measures a dominant sender (plan 84, revision 9).
6. **Counts:** offers report `additional`, the eligible threads beyond the targets. The default runs when `additional ≥ 1`, and titles use the counts the mutation actually returned. The copy says "emails", as the user worded it, in both en and es.
7. **Move scopes:** with `move: true`, the resolve excludes the targets and the threads that are only in the destination already. Threads in the destination plus another category are included: they leave the other one.
8. **Move batches:** `categorize.apply move` keeps the batch id from `beginMove`, returns it on any failure in its details, and reports what it changed from the move journal (`moveOutcome`).
9. **Overlapping automatic filters:** an auto category filter for a sender scope disables (with undo) that sender's auto subject filters that file elsewhere. An exact match is retargeted (plan 85). A subject filter under a broader sender filter to another category stays additive; that case is documented as out of scope.
10. **Mail the filter catches during the undo window:** like plans 80 and 81, mail the new filter files while the snackbar is up (seconds) stays filed after "only" or Undo. The filter is undone first, so this window is as short as the undo itself. It is documented, not journaled.
11. **Screen readers:** the default's completion and "only" update the snack's spoken message (`patchSnack` with `spoken`), so screen readers hear "Moved 47 emails…". Progress stays silent.
12. **Order of work:** plans 84 and 85 are implemented first. The defaults are gated on their cross-store tests.
