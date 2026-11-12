# 199 — The sent copy's date arrives where "Sending…" was

- **Status**: withdrawn (the owner's report, below)
- **Commit**: 1520ef910
- **Severity**: LOW (additive)
- **Category**: Missed opportunity (state indication)
- **Estimated scope**: 2 files (`apps/web/src/components/held-message.tsx`, `apps/web/src/lib/flash.ts` only if plan 195 isn't built), plus tests; ~10 lines
- **Depends on**: plan 195's `arrive()` (Step 0 adds it if 195 isn't built yet). Best after plan 196 (the seal), but independent of it.

## The request (verbatim)

> […] sending a message(this one could be a bit unique, clean and simple, but unique) and have a good nice transitions that feel nice when using the app. […] respect the settings animation time

Then: "plan for all 5 items" (this is item 5 of plans 195–199).

## Problem

When a held message's copy arrives (plan 182), the copy renders in the card's place: same header family, same body. The only visible change is where the date sits: the "Sending…" status becomes the message's date in one frame. It's the end of the send, and it reads as a flicker in one corner.

```tsx
// apps/web/src/components/held-message.tsx:100-112 — current
export function HeldMessages({ threadId, messages, icons }: { threadId: number; messages: readonly MessageDetail[]; icons: boolean }) {
  const all = useHeldSends((s) => s.holds);
  const holds = useMemo(() => heldIn({ holds: all }, threadId), [all, threadId]);
  const arrived = (h: HeldSend) => h.copy !== null && messages.some((m) => m.id === h.copy!.messageId);
  useEffect(() => {
    for (const h of holds) if (arrived(h)) copyShown(h.draftId);
  }, [holds, messages]);
  return holds.filter((h) => !arrived(h)).map((h) => <HeldMessage key={h.draftId} held={h} icons={icons} />);
}
```

The copy's date is the `<time data-testid="message-date">` in its open header (`apps/web/src/components/reader.tsx:914-917`, `MessageDate`), inside `article[data-message-id="<id>"]`.

## Target

In the effect where a hold's copy is first shown, the copy's date **arrives**: `opacity: 0; translate: 0 4px` to settled, over `--motion-slow` (`min(--motion × 1.33, 100 ms)`) on `--motion-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`): the one arrival motion. Only the date; the header and body are the same message and must not move. Once per hold (`copyShown` already runs once per hold's arrival; guard it the same way). Motion off: nothing.

## Repo conventions to follow

- The once-per-hold effect already exists (the `useEffect` above); add to it, don't add another effect.
- `arrive()` in `apps/web/src/lib/flash.ts`.

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

1. Read `copyShown` in `apps/web/src/lib/held-sends.ts`: it must settle the hold so the effect doesn't fire twice for one. If it can fire again for the same hold (a re-render before the store drops it), guard with a module-level `const dated = new Set<number>()` keyed by `h.draftId` and check it first.

2. **`apps/web/src/components/held-message.tsx`**, the effect in `HeldMessages` becomes:

   ```tsx
   useEffect(() => {
     for (const h of holds) {
       if (!arrived(h)) continue;
       copyShown(h.draftId);
       // plan 199: where "Sending…" was, the copy's date arrives (the rest is the same message, and stays still)
       arrive(document.querySelector(`[data-reader-scroller] article[data-message-id="${Math.trunc(h.copy!.messageId)}"] [data-testid=message-date]`));
     }
   }, [holds, messages]);
   ```

   (Ids are integers from the store, never text from mail; `Math.trunc` keeps the selector safe, as `flash.ts`'s `rowSelector` does.)

   Import `arrive` from `~/lib/flash`.

## Boundaries

- Do NOT animate the copy's article, header or body; only its date.
- Do NOT touch the new-message pane's path (`HeldNewMessage`: the conversation opens on its copy, a navigation) or a send without a hold.
- No new tokens, keyframes or dependencies.
- If the excerpt has drifted, STOP and report.

## Tests

- Unit (`apps/web/src/components/held-message.test.tsx`, jsdom, `animate` stubbed): when `messages` gains the hold's copy, one `arrive` runs on that article's `message-date`; a re-render with the same messages runs none; motion 0, none.
- e2e (the undo-send spec): after the copy lands, its `message-date` ran `arrive` (record `Element.prototype.animate` calls with `page.addInitScript`).

## Verification

- **Mechanical**: `pnpm typecheck`, `pnpm lint`, the unit file and spec.
- **Feel check**: reply with Undo send on, let it go:
  - "Sending…" (and plan 196's line) give way to the date, which fades up 4 px into its place; nothing else in the message moves or flashes.
  - DevTools → Animations at 10 %: one short arrival on the date only.
  - Motion 0 / reduced motion: the date is simply there.
- **Done when**: tests pass and the feel check holds.

## Performance

One `querySelector` and one WAAPI animation per sent message.

## Out of scope

- Plans 195–198.

## Revisions after the Codex review

1. **The selector matched nothing.** An open message's date in the conversation is an unmarked `<span>` in `Message`'s open header (`reader.tsx`), not `MessageDate` (that one is the sender card's, outside the article). The span now carries `data-message-date`, and the selector looks for it inside the copy's article.
2. **Before paint.** The effect that settles a hold on its copy became a layout effect, so the date is never drawn settled and then hidden.
3. **Once, and only here.** `copyShown` settles the hold (`settleHeld` drops it), so a re-render doesn't play it again; a copy that lands while another conversation is open plays nothing (nothing of it is mounted).
4. **Tests.** The e2e (`motion.spec.ts`, after plan 196's seal) delivers the held send and records exactly one arrival, on the copy's date, which ends visible.

## After the owner's report: withdrawn

"That row of the email flashes and looks weird": the date started transparent, so for two frames the header had neither "Sending…" nor the date. The arrival is gone, with `data-message-date`. What also moved there was older than this plan: the copy's HTML body opened at the 120 px guess and then measured, jumping the message for a frame; it now opens at its card's measured height (`carryHeight` in `mail-body.tsx`, seeded when the copy is known). The handoff is simply still. Plan 195's last section has the rule and the tests.
