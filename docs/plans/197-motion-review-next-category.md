# 197 — Review's next category arrives

- **Status**: built
- **Commit**: 1520ef910
- **Severity**: LOW (additive)
- **Category**: Missed opportunity (state indication)
- **Estimated scope**: 3 files (`apps/web/src/lib/review.ts`, `apps/web/src/components/thread-list.tsx`, `apps/web/src/lib/flash.ts` only if plan 195 isn't built), plus tests; ~30 lines
- **Depends on**: plan 195's `arrive()` in `flash.ts` (Step 0 adds it if 195 isn't built yet)

## The request (verbatim)

> example when reviewing categories 'to sort' section, maybe others, respect the settings animation time

Then: "plan for all 5 items" (this is item 3 of plans 195–199).

## Problem

In Review ("To sort"), once a category is emptied, plan 192's pill counts 5 s and then switches to the next category with suggestions (or the user picks one in the switcher). The list's title and rows change in one frame: nothing marks that this is a new set, and the eye has to work out that the rows on screen belong to another category.

```ts
// apps/web/src/lib/review.ts:65-69 — current
/** Another category's suggestions, in the same Review: the way back stays the one you came in by. */
export function switchReview(categoryId: number): void {
  if (getApp().reviewCategoryId === categoryId) return;
  setApp({ reviewCategoryId: categoryId, selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
}
```

Its callers: the emptied Review's pill (`apps/web/src/components/review-empty.tsx:135`, `go()`), and the category switcher (`apps/web/src/components/review-switcher.tsx:39`).

The list's scroller (`apps/web/src/components/thread-list.tsx:1440`) is `<div ref={parentRef} data-keep-scroll="list" role={items.length > 0 ? "listbox" : "group"} …>`; the title is the `h1 data-testid="list-title"` (`thread-list.tsx:815`, `:847`, `:861`, one per header variant).

## Target

When Review switches category, the moment the new category's rows are committed, the list's rows container and its title **arrive** once: `opacity: 0; translate: 0 4px` to settled, over `--motion-slow` (`min(--motion × 1.33, 100 ms)`) on `--motion-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`): the one arrival motion (plan 195). No stagger (it would run past the 100 ms cap). Nothing on answering a suggestion (rows already leave with the reflow), on j/k, on entering or leaving Review, or on any other list change. Motion off (setting 0 or reduced motion): nothing.

## Repo conventions to follow

- A one-shot intent set by an action and read once by the view: the pattern of `firstReveal` (`apps/web/src/lib/held-sends.ts:62`), a module-level set consumed on read.
- WAAPI effects: `arrive()` in `apps/web/src/lib/flash.ts`, timed by `motionMs()`.

## Steps

0. If `apps/web/src/lib/flash.ts` has no `arrive` export (plan 195 not built), add exactly:

   ```ts
   /** A motion token's value (WAAPI can't read a var()): the curves have one source, globals.css */
   const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

   /** Plan 195: the one arrival: from 4 px below and transparent to settled, at --motion-slow. Skipped when motion is off. */
   export function arrive(el: Element | null, { spring = false }: { spring?: boolean } = {}): void {
     const ms = motionMs();
     if (!el || ms === 0) return;
     for (const a of el.getAnimations()) if (a.id === "arrive") a.cancel();
     const run = el.animate([{ opacity: 0, translate: "0 4px" }, { opacity: 1, translate: "0 0" }], { duration: Math.min(Math.round(ms * 1.33), 100), easing: token(spring ? "--motion-ease-spring" : "--motion-ease") || "ease-out" });
     run.id = "arrive";
   }
   ```

1. **`apps/web/src/lib/review.ts`**:

   ```ts
   /** Plan 197: a switch to this category is on its way: its rows arrive once, when they're in */
   let arriving: number | null = null;
   /** True once, for the category a switch went to (the list reads it when its rows commit) */
   export function takeReviewArrival(categoryId: number): boolean {
     if (arriving !== categoryId) return false;
     arriving = null;
     return true;
   }
   ```

   and in `switchReview`, before `setApp(…)`: `arriving = categoryId;`

2. **`apps/web/src/components/thread-list.tsx`**, in the component that owns `parentRef` (the one rendering line 1440): a layout effect on the committed list key:

   ```tsx
   // plan 197: Review went on to another category: its rows and title arrive once, when they're in
   const itemsKey = useList((s) => s.itemsKey);
   const reviewing = useApp((s) => s.reviewCategoryId);
   useLayoutEffect(() => {
     if (reviewing === null || items.length === 0 || itemsKey !== listKey() || !takeReviewArrival(reviewing)) return;
     arrive(parentRef.current);
     arrive(document.querySelector("[data-testid=list-title]"));
   }, [itemsKey, reviewing, items.length]);
   ```

   Reuse the component's existing `items`, `useList`/`useApp` reads if it already has them (don't subscribe twice to the same slice). Imports: `takeReviewArrival` from `~/lib/review`, `arrive` from `~/lib/flash`, `listKey` from `~/state/list` if not already imported.

## Boundaries

- Do NOT animate on `enterReview`, `leaveReview`, `reviewToInbox`, answering (y/n), j/k, or the Review switcher's menu itself.
- Do NOT stagger rows; do NOT add keyframes, tokens or dependencies.
- If the list shows no rows for the new category (none left after all), the flag is consumed by nothing and does nothing: no fallback animation.
- If the cited lines have drifted, STOP and report.

## Tests

- Unit (`apps/web/src/lib/review.test.ts` or a new one beside it): `takeReviewArrival(id)` is true once after `switchReview(id)`, false after; false for another id; `switchReview` to the current category sets nothing.
- e2e (`apps/web/e2e/review-*.spec.ts`, the plan 192 spec that empties a Review and lets the pill go on): after the switch, the scroller (`[data-keep-scroll=list]`) ran an `arrive` animation (`getAnimations().some(a => a.id === "arrive")` read in the same frame, or record `animate` calls with `page.addInitScript`); answering a suggestion afterwards runs no `arrive`.

## Verification

- **Mechanical**: `pnpm typecheck`, `pnpm lint`, the unit and e2e files above.
- **Feel check**: open To sort, answer a category's last suggestion, let the pill run out:
  - the next category's title and rows fade up 4 px into place, together, once; nothing slides sideways.
  - pick a category in the switcher: the same.
  - answer with y/n: rows leave as before; nothing arrives.
  - DevTools → Animations at 10 %: one curve, under 100 ms at the default.
  - Motion 0 / reduced motion: the swap is instant.
- **Done when**: tests pass and the feel check holds at 50, 75 and 100 ms.

## Performance

One flag read per committed list key; two WAAPI animations on a switch. No new subscription beyond `itemsKey`/`reviewCategoryId` if the component doesn't read them already.

## Out of scope

- Other list switches (sidebar navigation stays instant, plan 01).
- Plans 195, 196, 198, 199.

## Revisions after the Codex review

1. **No read-then-reset module `let`.** `review.ts` already warns that the React Compiler and that pattern don't mix (`reviewFrom`). The intent is an object's property, `reviewArrival.categoryId`, read and spent by `takeReviewArrival`.
2. **The intent is bound to its switch.** `review.ts`'s own app subscription drops it whenever Review goes anywhere but the switch's category (left, entered afresh, another switch); the list spends it on the first commit of that category's rows even when there are none, so an empty destination never animates a later refresh. Unit tests cover a switch left before its rows came and entered again later.
3. **The changing label is the switcher's.** During Review the list's title is the fixed "To sort"; the category's name lives in `ReviewSwitcher`'s select, which changes with the app state, before the rows are in. That name arrives as it changes (a layout effect on the category, while a switch is owed); the rows arrive when they're in. Two beats a few milliseconds apart, the name first, as a reader reads them.
4. **Tests.** The e2e (`motion.spec.ts`) sets suggestions for two categories, switches through the select and records exactly two arrivals (the name and the list), then answers a suggestion and records none.

## After the owner's report on the send's flash

The same check across the series: the rows replace the last category's in place, so their transparent first frame showed an empty list for a moment. They now settle 4 px without the fade (`arrive(el, { inPlace: true })`). The switcher's name no longer animates: a word replaced in its own box can neither fade without a blink nor move without a jolt. The e2e records one arrival, the list's, without a fade. Plan 195's last section has the rule.
