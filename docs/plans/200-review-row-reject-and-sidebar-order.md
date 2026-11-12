# 200 — Review rows say "not this category"; the switcher in the sidebar's order

- **Status**: built
- **Severity**: MEDIUM (a missing answer on screen)
- **Estimated scope**: `apps/web/src/components/review-actions.tsx`, `apps/web/src/lib/review.ts`, `apps/web/src/components/review-switcher.tsx`, `apps/web/src/components/sidebar.tsx`, `apps/web/src/components/thread-menu.tsx`, i18n (en, es), tests

## The request (verbatim)

> here we need a way for the user to say that they don't want to put it in the category, we don't have that, we need like an "X" button, it should look nice and simple.
>
> also we need to show the same order here in the 'sort categories' as on the sidebar

(The screenshot: Review ("Sort into categories") on Lecturas; each row shows "✓ Add to Lecturas" and "Add similar ▾"; the switcher's menu lists Lecturas 31, Facturas 23, Clientes 14 while the sidebar lists Facturas, Clientes, Viajes, Lecturas, Desarrollo.)

## What exists

- A Review row's answers (plan 80, plan 158): `ReviewControls` draws the pills inside the row (an option can't hold a button, so they're `aria-hidden` spans), and `ReviewButtons` lays clear, real buttons over them from outside the listbox, measured per row slot (`[data-review-slot] > *`, by position: accept, always). Hover and focus light the pill under the button (`data-hover`, `data-focus`).
- "Not this category" exists only as `n` (`answerReview(id, category, false)`: `rejectSuggestion`, a negative training example, the row leaves, a failure brings it back) and the reader's suggestion chip's ×. Nothing on the row, nothing in the thread menu.
- `reviewTotals` lists categories with suggestions, **most waiting first**; the switcher shows that order (the one in view at 0 put first). The sidebar's "To sort" opens the category with the most (`pending[0]`), and plan 192's emptied Review goes on to the one with the most (`nextToSort`).

## Design

1. **The ×.** A third answer on every Review row, after "Add similar ▾": BoardUI's close button (`close-button.tsx`), size `sm` (24 px: the pills' height), its field wash and muted glyph, deepening on hover as everywhere else. Drawn in the row with `closeButtonVariants` (a span, as the pills are), its hover and focus states as `data-hover` / Tab's ring like the pills'; the real button over it is `CloseButton` itself (clear, as the others), named "Not {category}" (`review.reject`, es "No es {category}"), its tooltip the same. It answers `answerReview(id, category, false)`: exactly `n`. Accept and reject the two answers, Add similar the third; the × last, where a dismiss sits, quieter than both pills so "Add to" stays the primary.
2. **The thread menu** on a Review row gets the same answer under "Add to {category}": "Not {category}" (icon X), so every way that says yes also says no.
3. **Order.** `reviewTotals` keeps the sidebar's order (the categories' own order: what the sidebar draws and the user reorders). The switcher lists exactly that, the one in view at 0 in its own place, not first. Which category to *start* with stays the one with the most waiting (the sidebar's "To sort", plan 192's going on): `mostWaiting(pending)` (the first of the most, so ties go by the sidebar's order).

## Tests

- Unit (`review.test.ts`): `reviewTotals` in the sidebar's order; `mostWaiting` picks the most, ties by sidebar order; `nextToSort` still the most waiting other than the one in view.
- e2e (`review-row-actions.spec.ts`): the × is a named button over its drawn pill; pressing it on a row that isn't the open one rejects it (`cls_examples` label −1, source reject), the row leaves, nothing is filed, nothing opens; the thread menu's "Not Facturas" does the same; axe stays clean with it (the existing axe tests include it). `motion.spec`'s Review switch still works; a switcher test that the menu lists the categories in the sidebar's order.

## Performance

One more absolutely placed button per visible Review row (measured in the same pass as the other two); no new subscriptions.

## Out of scope

- Changing what a rejection does (plan 80) or the reader's chip.
- Changing which category Review opens on.

## Revisions after the Codex review

1. **One part map for the overlay.** The slot's children are, by position, accept 0, similar 1, reject 2 (`PART`): what a hover or focus mark lights and what a press is placed by, the × a direct child like the pills. The overlay measures all three; a slot without them gets no buttons. `review-buttons.test.tsx` covers hover, focus and a press on the × that lands on the row under the pointer after a scroll.
2. **The drawn × takes its states from the button.** It's `closeButtonVariants({ size: "sm" })` with `data-hover` mapped to the button's own hover (its field deeper, its glyph full) and Tab's ring through the pills' `RING`; the real `CloseButton` over it stays clear, focused too.
3. **Named for what it says.** `CloseButton` names itself "Close" unless told: `label` and `title` are "Not {category}" (`review.reject`, es "No es {category}"), asserted by role and name.
4. **Keyboard.** Tab goes accept → similar → ×, only on the open row; Enter answers, and the list takes focus back (`answered`).
5. **Width.** The "Add to" label is what truncates (as it did); "Add similar" and the × keep their size. Checked in Lumen's column with a long name in Spanish, light and dark, and in Terno and Graphite; the e2e checks the × lies on its pill, inside the column, after "Add similar".
6. **Order.** `reviewTotals` keeps the categories' array order (what the sidebar draws, reorders included, before they're saved); `mostWaiting` takes the first of the most (strict `>`), and both the sidebar's "To sort" and `nextToSort` (the others filtered first) use it. The switcher walks the categories, so the one in view at 0 sits in its own place.
7. **The motion e2e** picked "the other category" as the last item without a selected descendant: it now takes the first item that isn't itself selected and checks the switch happened.


## Codex code review

No findings (the overlay's measurement, part indices, Tab order, hit testing after a scroll, the menu item, i18n, every caller of `reviewTotals`, ties, and the switcher's at-0 and missing cases were checked).
