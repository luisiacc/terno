# 198 — An emptied list's empty state arrives

- **Status**: built
- **Commit**: 1520ef910
- **Severity**: LOW (additive)
- **Category**: Missed opportunity (a jarring change; delight in a rare moment)
- **Estimated scope**: 4 files (`apps/web/src/lib/flash.ts`, new `apps/web/src/components/empty-state.tsx`, `apps/web/src/components/thread-list.tsx`, `apps/web/src/components/review-empty.tsx`), plus tests; ~70 lines, mostly moved
- **Depends on**: plan 195's `arrive()` in `flash.ts` (Step 0 adds it if 195 isn't built yet)

## The request (verbatim)

> […] have a good nice transitions that feel nice when using the app. example when reviewing categories 'to sort' section, maybe others, respect the settings animation time

Then: "plan for all 5 items" (this is item 4 of plans 195–199).

## Problem

When the last row of a list leaves (archive the last mail in the Inbox, answer Review's last suggestion, clear the last reminder), the rows' reflow fades the row out and, in the same frame, the empty state is simply there. Inbox zero and an emptied Review are rare, small wins; today they land flat.

The centered empty states are the same markup five times over:

```tsx
// apps/web/src/components/thread-list.tsx:1066-1072 — current (one of five: Today, Follow-ups, Reminders, the rule-only preview, the mailbox's own at the end)
<div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
  <Sun className="mb-2 size-7 text-muted-foreground" aria-hidden />
  <p className="text-lg font-semibold tracking-tight">{t("today.empty")}</p>
</div>
```

```tsx
// apps/web/src/components/review-empty.tsx:27-37 — current
export function ReviewEmpty({ category }: { category: Category }) {
  const next = useApp((s) => nextToSort(s.categories, s.counts.categorySuggestions, category.id));
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
      <Tags className="mb-2 size-7 text-muted-foreground" aria-hidden />
      <p className="text-lg font-semibold tracking-tight">{t("review.empty.title")}</p>
      <p className="text-xs text-muted-foreground">{next ? t("review.empty.more", { category: category.name }) : t("review.empty.none")}</p>
      <Action next={next} />
    </div>
  );
}
```

A removal goes through `reflowRemoval` (`apps/web/src/lib/flash.ts:69`); navigation never does.

## Target

An empty state that appears **because rows just left** (a removal ran in the last 300 ms) arrives: `opacity: 0; translate: 0 4px` to settled, over `--motion-slow` (`min(--motion × 1.33, 100 ms)`) on `--motion-ease-spring` (`linear(0, 0.2 8%, 0.62 20%, 0.94 34%, 1.03 47%, 1.01 64%, 1)`): the one arrival motion with the spring's small settle, the one place a rare win gets it. An empty state reached by navigating (opening an empty Reminders, a new category) appears at once, as now. The search's "nothing found" never animates (it answers typing). Motion off: nothing.

## Repo conventions to follow

- Shared, duplicated markup becomes one component (AGENTS.md principle 1); the five branches keep their own icons and copy.
- Timing state that must survive the frame lives in `flash.ts` beside the effect that sets it.
- WAAPI effects: `arrive()` in `flash.ts`, timed by `motionMs()`.

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

1. **`apps/web/src/lib/flash.ts`**: remember when rows last left.

   ```ts
   let removedAt = -Infinity;
   /** Plan 198: rows left the list a moment ago (an empty state now is one the user just made, not one navigated to) */
   export const justEmptied = () => performance.now() - removedAt < 300;
   ```

   In `reflowRemoval`, as its first line: `removedAt = performance.now();` (before the early return, so it holds with motion off too: harmless, `arrive` checks motion itself).

2. **`apps/web/src/components/empty-state.tsx`** (new):

   ```tsx
   import { useLayoutEffect, useRef, type ReactNode } from "react";
   import { arrive, justEmptied } from "~/lib/flash";

   /**
    * A list with nothing in it: its glyph, what it means, maybe a hint and a way on. Plan 198: one that the user just
    * emptied arrives (the spring's small settle, a rare win); one navigated to is simply there.
    */
   export function EmptyState({ icon, title, hint, children }: { icon: ReactNode; title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
     const ref = useRef<HTMLDivElement>(null);
     useLayoutEffect(() => { if (justEmptied()) arrive(ref.current, { spring: true }); }, []);
     return (
       <div ref={ref} className="flex h-full flex-col items-center justify-center gap-1 px-8 text-center" data-testid="list-empty">
         {icon}
         <p className="text-lg font-semibold tracking-tight">{title}</p>
         {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
         {children}
       </div>
     );
   }
   ```

   The icon keeps its own classes at the call site (`className="mb-2 size-7 text-muted-foreground" aria-hidden`).

3. **`apps/web/src/components/thread-list.tsx`**: replace each centered empty state (the rule-only preview, Today, Follow-ups, Reminders, and the mailbox's own at the end of that function; NOT the search's `query` branch) with `<EmptyState icon={…} title={…} hint={…} />`, the same icon, copy and test id. Read every branch before replacing: if one has markup beyond icon, title and hint, keep the extra as `children`, or STOP and report if it doesn't fit.

4. **`apps/web/src/components/review-empty.tsx`**: `ReviewEmpty` returns `<EmptyState icon={<Tags className="mb-2 size-7 text-muted-foreground" aria-hidden />} title={t("review.empty.title")} hint={…}><Action next={next} /></EmptyState>`.

## Boundaries

- Do NOT change any copy, icon, test id, focus behaviour (`Action`'s hand-off) or layout.
- Do NOT animate the search's empty answer, loading states or the reader's empty state.
- No new tokens, keyframes or dependencies.
- If a branch doesn't match the pattern, STOP and report.

## Tests

- Unit (`apps/web/src/components/empty-state.test.tsx`, jsdom, `Element.prototype.animate` stubbed; motion at 75): mounted right after `reflowRemoval([…])` it runs one `arrive` animation whose easing is the spring token's value; mounted with no recent removal, none; motion 0, none.
- Existing tests that read `[data-testid=list-empty]` still pass unchanged (the markup is the same): run `apps/web/e2e/` specs that mention `list-empty` (grep) in the `e2e` project.
- e2e (one `scenario()` in the inbox spec): archive the last row of a one-row category; the empty state runs `arrive`. Open an empty view from the sidebar: no `arrive`.

## Verification

- **Mechanical**: `pnpm typecheck`, `pnpm lint`, the unit file, the e2e specs above.
- **Feel check**:
  - archive the last mail of a small category: the row fades, then the empty state rises 4 px and settles with the faintest overshoot; it should read as a small "done", not a bounce.
  - answer Review's last suggestion: same, with the pill under it.
  - click an empty view in the sidebar: no motion.
  - DevTools → Animations at 10 %: the overshoot is visible but under a pixel.
  - Motion 0 / reduced motion: instant.
- **Done when**: tests pass, no screenshot baseline moves (the end state is identical), and the feel check holds.

## Performance

One `performance.now()` per removal and per empty-state mount; one WAAPI animation on a rare mount.

## Out of scope

- An illustration or new copy for empty states.
- Plans 195–197, 199.

## Revisions after the Codex review

1. **The name was taken.** `thread-list.tsx` already had an `EmptyState`: the function choosing which empty state to show. It's `ListEmptyState` now; the shared presentation is `EmptyState` in `components/empty-state.tsx`, used by the rule-only preview, Today, Follow-ups, Reminders and the mailbox's own, and by `ReviewEmpty`. The search's answer keeps its own markup and never animates.
2. **"Just emptied" is the list's own fact, not a 300 ms clock.** A global timestamp from `reflowRemoval` couldn't tell emptying from navigating (any removal armed it, even one leaving rows), missed slow commits, and never fired for reminders and follow-ups, which empty through a snapshot reload. `state/list.ts` watches its own store: the list on screen going from rows to none under the same key marks it (an object's property, not a module `let`); another key clears it; `takeEmptied(key)` spends it once. So a cleared reminder or follow-up arrives too, and so does a list emptied by another window: the list on screen went empty, which is what the bridge is for.
3. **Before paint**, in a layout effect, as the other plans.
4. **Tests.** Unit (`list.test.ts`): said once by its key, spent by another list in between. e2e (`motion.spec.ts`): trashing a category's only row (archived mail stays in its category) records one spring arrival on the empty state; going away and coming back to it, still empty, records none. The ten specs that read `list-empty` pass unchanged.

## After the owner's report on the send's flash (Codex code review)

Removing the last row unmounts the list, its fading copy with it, so the empty state took its place at a transparent first frame: a blink. It settles in without the fade now (`arrive(el, { spring: true, inPlace: true })`, the spring's small settle kept); the e2e checks it doesn't fade. Plan 195's last section has the rule.
