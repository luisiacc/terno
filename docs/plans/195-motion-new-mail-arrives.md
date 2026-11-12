# 195 — New mail arrives instead of pushing the list down

- **Status**: built
- **Commit**: 1520ef910
- **Severity**: MEDIUM
- **Category**: Missed opportunity (a jarring change)
- **Estimated scope**: 2 files (`apps/web/src/lib/flash.ts`, `apps/web/src/state/list.ts`; globals.css already has the slide), plus tests; ~60 lines

## The series (plans 195–199)

| Plan | What | Severity | Depends on | Status |
|---|---|---|---|---|
| 195 | New mail arrives (adds `arrive()`, `armReflow()`) | MEDIUM | none | built |
| 196 | Sending: the held message arrives, and seals as it leaves | LOW | 195's `arrive()` | built |
| 199 | The sent copy's date arrives where "Sending…" was | LOW | 195's `arrive()`; best after 196 | built |
| 197 | Review's next category arrives | LOW | 195's `arrive()` | built |
| 198 | An emptied list's empty state arrives | LOW | 195's `arrive()` | TODO |

Build in that order: 195 first (it adds the shared helper the others use; each later plan also carries the helper's exact code, so any can run alone), then the send pair, 196 then 199, then 197 and 198. One motion throughout: arrive = `opacity 0 → 1`, `translate 0 4px → 0`, `--motion-slow` on `--motion-ease` (the spring only for 198's rare win); leave = the existing reflow fade. Every duration goes through the user's setting (`motionMs()`, plan 01) and stays within 100 ms; motion off plays nothing.

## The request (verbatim)

> i only like the 'one consistent motion'
>
> i think we could do a nice simple and very very clean animation […] we can identify spots as well those new spots like new messages coming in, sending a message(this one could be a bit unique, clean and simple, but unique) and have a good nice transitions that feel nice when using the app.
>
> example when reviewing categories 'to sort' section, maybe others, respect the settings animation time

Then: "plan for all 5 items" (this is item 1 of plans 195–199).

## Problem

When mail arrives while a list is at its very top, the refresh commits the new rows and every row below moves down a row height in one frame. Nothing bridges it: the row you were looking at jumps. It isn't caused by the user, so it surprises.

```ts
// apps/web/src/state/list.ts:392-417 — current
    // the window refresh keeps the first visible row where it was (new mail above it doesn't push it down): always after a page
    // (Back finds what it left), and on the list unless it's at the very top (there, new mail shows as it arrives)
    const restore = windowed && (options.window || listAnchor.scrolled?.()) ? listAnchor.capture?.() : undefined;
    // another list starts where it was left, or at its top, in the commit that shows it
    const arrives = !sameView && !options.keepSelection;
    const commit = (fn: () => void) => (restore || arrives ? flushSync(fn) : fn());
    commit(() => {
      inboxTop.ids = top.ids;
      …
      useList.setState({ key, itemsKey: key, items: page.items, index: indexOf(page.items), … });
    });
    restore?.();
    if (arrives) listAnchor.scrollTo?.(place?.scroll ?? null);
```

The way out of the list already has a bridge, which this plan mirrors:

```ts
// apps/web/src/lib/flash.ts:62-85 — current (the exemplar)
let reflowTimer: ReturnType<typeof setTimeout> | null = null;
export function reflowRemoval(ids: readonly number[]): void {
  const ms = motionMs();
  const list = document.querySelector<HTMLElement>("[role=listbox]");
  if (!list || ms === 0 || ids.length === 0) return;
  for (const row of list.querySelectorAll<HTMLElement>(rowSelector(ids))) {
    const ghost = row.cloneNode(true) as HTMLElement;
    …
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Math.round(ms * 0.66), easing: "ease-out", fill: "forwards" });
    fade.onfinish = fade.oncancel = () => ghost.remove();
  }
  list.dataset.reflow = "";
  if (reflowTimer) clearTimeout(reflowTimer);
  reflowTimer = setTimeout(() => delete list.dataset.reflow, Math.min(ms * 1.33, 100) + 60);
}
```

```css
/* packages/ui/src/styles/globals.css:427-430 — current: while data-reflow is on the listbox, rows slide */
[data-reflow] [data-thread-id] {
  transition: transform var(--motion-slow) var(--motion-ease);
}
```

## Target

**The one arrival motion** (shared by plans 195–199; this plan adds it): an element goes from `opacity: 0; translate: 0 4px` to settled, over `--motion-slow` (`min(--motion × 1.33, 100 ms)`: 100 ms at the default 75) on `--motion-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`). It uses the individual `translate` property, so it composes with a row's inline `transform: translateY(…)`. With motion off (the setting at 0, or the OS's reduced motion) nothing plays: `motionMs()` is 0 (the repo's settled decision, plan 01: motion off means none).

**New mail at the top**: when a same-list refresh brings 1–3 rows that weren't there, above every row that was, and the list is at its very top:

1. the list's existing rows slide down into place (the `[data-reflow]` transition, already in globals.css), and
2. the new rows arrive.

Nothing plays when: the list is scrolled (the anchor already keeps the reader's place; nothing moves), more than 3 rows arrive at once (a sync batch just appears), it's another list or the first load, motion is off, or a drag is in progress.

## Repo conventions to follow

- Row effects that must survive virtualization live in `apps/web/src/lib/flash.ts` and address rows by `data-thread-id` (`rowSelector`). Durations come from `motionMs()` (`apps/web/src/lib/appearance.ts:54`), never literals; `Math.min(ms * 1.33, 100)` is `--motion-slow`.
- Easing strings for WAAPI are read from the tokens, so the curve has one source: `getComputedStyle(document.documentElement).getPropertyValue("--motion-ease").trim()`.
- Comments: terse, say why, cite the plan (`// plan 195: …`), match the file's voice.

## Steps

1. **`apps/web/src/lib/flash.ts`**: add the shared helper and the reflow arming, below `reflowRemoval`:

   ```ts
   /** A motion token's value (WAAPI can't read a var()): the curves have one source, globals.css */
   const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

   /**
    * Plan 195: the one arrival. From 4 px below and transparent to settled, at --motion-slow on the motion ease (the spring
    * where a rare moment allows it). `translate` composes with a row's own transform. Skipped when motion is off.
    */
   export function arrive(el: Element | null, { spring = false }: { spring?: boolean } = {}): void {
     const ms = motionMs();
     if (!el || ms === 0) return;
     for (const a of el.getAnimations()) if (a.id === "arrive") a.cancel();
     const run = el.animate([{ opacity: 0, translate: "0 4px" }, { opacity: 1, translate: "0 0" }], { duration: Math.min(Math.round(ms * 1.33), 100), easing: token(spring ? "--motion-ease-spring" : "--motion-ease") || "ease-out" });
     run.id = "arrive";
   }

   /** The listbox's rows slide to their places for this window (the same window a removal opens). */
   export function armReflow(): void {
     const ms = motionMs();
     const list = document.querySelector<HTMLElement>("[role=listbox]");
     if (!list || ms === 0) return;
     list.dataset.reflow = "";
     if (reflowTimer) clearTimeout(reflowTimer);
     reflowTimer = setTimeout(() => delete list.dataset.reflow, Math.min(ms * 1.33, 100) + 60);
   }

   /** Plan 195: rows that just arrived at the list's top (the others slide down with armReflow, called before the commit). */
   export function arriveRows(ids: readonly number[]): void {
     const list = document.querySelector<HTMLElement>("[role=listbox]");
     if (!list) return;
     for (const row of list.querySelectorAll<HTMLElement>(rowSelector(ids))) arrive(row);
   }
   ```

   Then make `reflowRemoval` call `armReflow()` in place of its last three lines (same behaviour, one place).

2. **`apps/web/src/state/list.ts`**, in `reloadList`, just before `const commit = …`:

   ```ts
   // plan 195: new mail at the top of the list on screen arrives (the rest slide down) rather than pushing it down in a
   // frame. Only at the very top (scrolled, the anchor keeps the place: nothing moves), only a few (a sync batch just
   // appears), never on another list, a first load or during a drag
   const arrived = sameView && !restore && current.items.length > 0 && !listAnchor.scrolled?.() && useDrag.getState().phase === "idle" ? arrivedOnTop(current.index, page.items) : [];
   if (arrived.length) armReflow();
   ```

   change the commit to flush when rows arrive, so they're in the DOM when they're asked to arrive:

   ```ts
   const commit = (fn: () => void) => (restore || arrives || arrived.length ? flushSync(fn) : fn());
   ```

   and after `restore?.();` add `if (arrived.length) arriveRows(arrived);`.

   Add the helper near `pruneSelection`:

   ```ts
   /** Rows a refresh brought above every row that was there, when 1 to 3 of them (plan 195) */
   function arrivedOnTop(before: Map<number, number>, items: readonly ThreadSummary[]): number[] {
     const out: number[] = [];
     for (const t of items) {
       if (before.has(t.id)) break;
       out.push(t.id);
       if (out.length > 3) return [];
     }
     return out;
   }
   ```

   Imports: `armReflow, arriveRows` from `~/lib/flash`; `useDrag` from `~/state/drag` (check for an import cycle: `state/drag.ts` must not import `state/list.ts`; if it does, STOP and report).

## Boundaries

- Do NOT animate anything on j/k, selection, scrolling, a list switch, a search, or a page load (plan 01: never animated).
- Do NOT add CSS keyframes or new tokens; no new dependencies.
- Do NOT change `reflowRemoval`'s ghost fade.
- Durations only through `motionMs()`; nothing over 100 ms.
- If the code at the cited lines has drifted, STOP and report.

## Tests

- Unit (`apps/web/src/state/list.test.ts`): `arrivedOnTop` returns the new ids above the first known one; `[]` for 4+ new rows; `[]` when the first row was already there (a row that moved up isn't new).
- Unit (`apps/web/src/lib/flash.test.ts`, jsdom with `Element.prototype.animate` stubbed): `arrive` does nothing with motion off; plays one animation with id `arrive`, its duration `min(round(ms × 1.33), 100)`; a second call cancels the first.
- e2e (`apps/web/e2e/list-layout.spec.ts` or the inbox-scan spec, one `scenario()`): with the list at its top, ingest one thread (fixtures' `ingestConversation`) and assert the new row's `getAnimations()` includes `arrive` and the listbox had `data-reflow`; scrolled down, the same arrival plays nothing; with motion 0, nothing.
- Perf: `pnpm test:ui-perf` (the list gates) stays green; a refresh with no arrivals does no extra work (the check is two Map lookups).

## Verification

- **Mechanical**: `pnpm typecheck`, `pnpm lint`, the unit files above, the e2e spec above.
- **Feel check**: run the app (`pnpm dev` or the e2e build), keep the Inbox at its top, send yourself a mail (or ingest one in the dev backend):
  - the rows below slide down one row as the new one fades up 4 px into its place; no row jumps.
  - DevTools → Animations at 10 %: the slide and the fade share one duration and curve, and start in the same frame.
  - scroll down a little, receive again: nothing moves on screen.
  - set Animations to 0 in Settings → Appearance, and separately turn on reduced motion (Rendering panel): the row appears at once.
- **Done when**: the tests above pass and the feel check holds at 50, 75 and 100 ms.

## Performance

At most one `flushSync` per refresh that brings 1–3 new rows; WAAPI on ≤ 3 elements, composite-only (`opacity`, `translate`). No subscription, no render added.

## Out of scope

- Arrivals deeper in the list (a thread bumped by a reply moves rows around; that's a re-order, not an arrival).
- Plans 196–199 (send, Review's switch, empty states, the held card's date).

## Revisions after the Codex review

1. **Arrival needs provenance, not just a new prefix.** Undo, recovery, searches and Review reload the list too. Only a refresh the backend's own `changed` event asked for (`refreshList(…, { arrivals: true })`, from `boot.ts`) of a plain mailbox (`scope.kind === "view"`) can arrive; rows the user's own edits removed in the last 30 s (`patchRows` with a null patch records them, bounded at 500) never count, so an undo never looks like new mail.
2. **No extra commit with motion off.** Whether anything will arrive is decided (motion on included) before the commit; only then is it flushed.
3. **`motion-paused`** (the frames a language switch re-mounts the app) stops script animations too: `motionNow()` in `flash.ts` is 0 while it's on, and every helper reads it. Cancelling a ≤ 100 ms animation already running when reduced motion turns on mid-flight is too rare to handle.
4. **The list store stays free of the DOM.** `state/list.ts` imports nothing that touches `document` (node tests import it): the motion side comes in through `listArrival`, filled by the list component while it's mounted (as `listAnchor` is).
5. **The Inbox's top** (Pinned, Reminders) stands above where mail arrives: `arrivedOnTop` passes over those rows.
6. **Tests that can see a ≤ 100 ms effect.** The e2e opts out of the suite's reduced motion, records arrivals as they're asked for (`Element.prototype.animate`, by its `id`), and samples the row under the new one every frame to see it pass between its two places; scrolled down, nothing arrives.
