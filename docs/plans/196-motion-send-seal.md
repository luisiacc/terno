# 196 — Sending: the held message arrives, and seals as it leaves

- **Status**: built
- **Commit**: 1520ef910
- **Severity**: LOW (additive: the one signature moment)
- **Category**: Missed opportunity (state indication; delight in an occasional moment)
- **Estimated scope**: 2 files (`apps/web/src/components/held-message.tsx`, `apps/web/src/lib/flash.ts`), plus tests; ~50 lines
- **Depends on**: plan 195's `arrive()` in `flash.ts` (Step 0 adds it if 195 isn't built yet)

## The request (verbatim)

> […] new spots like new messages coming in, sending a message(this one could be a bit unique, clean and simple, but unique) and have a good nice transitions that feel nice when using the app. […] respect the settings animation time

Then: "plan for all 5 items" (this is item 2 of plans 195–199).

## Problem

Send closes the composer and, in the same frame, the held message (plan 182) appears at the end of the conversation: nothing says it came from the composer. When the undo window ends and the mail really leaves, only the pill's words change ("Undo send" → spinner and "Sending…"): the one moment that matters most in a mail client, the point of no return, is a text swap.

```tsx
// apps/web/src/components/held-message.tsx:30-31 — current: the reader goes to it once
useEffect(() => { if (firstReveal(held.draftId)) revealHeld(held.draftId); }, [held.draftId]);
```

```tsx
// apps/web/src/components/held-message.tsx:51-52 — current: the card
return (
  <article data-testid="held-message" data-held-send={held.draftId} data-phase={held.phase} tabIndex={-1} aria-label={t("compose.held.label")} className="hairline-b outline-none">
```

The phase goes `holding` → `sending` when the window ends (`apps/web/src/lib/held-sends.ts:198` and `:220`), when an Undo lost the race (`:192`), or when the copy is reported (`:258`); `undoing` sits between while an Undo is out.

## Target

Two beats, nothing more:

1. **On Send, the held message arrives**: the article goes from `opacity: 0; translate: 0 4px` to settled over `--motion-slow` (`min(--motion × 1.33, 100 ms)`) on `--motion-ease` (`cubic-bezier(0.2, 0.8, 0.2, 1)`): the one arrival motion. Once per hold (its first reveal), never when a conversation is reopened.

2. **When it leaves, it seals**: the first time a hold's phase becomes `sending`, a 2 px line in the accent (`bg-primary`) draws once across the card's top edge, over the hairline above it: `transform: scaleX(0)` → `scaleX(1)`, `transform-origin: left`, over `--motion-slow` on `--motion-ease-drawer` (`cubic-bezier(0.32, 0.72, 0, 1)`). It then **stays** while "Sending…" shows (a state, not a motion) and goes with the card when its copy takes its place (plan 199 has the copy's date arrive). It's the crossbar of Terno's mark, the bar across the envelope's top, drawn once as the mail is sealed. One element, composite-only, within the 100 ms cap.

With motion off (setting 0 or the OS's reduced motion): the card appears at once and the line shows already drawn while sending (`scaleX(1)`, no animation): the state stays, the motion goes.

With Undo send off there's no held card: nothing here plays (the send sound, plan 170, and plan 199's arrival of the copy mark it).

## Repo conventions to follow

- WAAPI effects live in `apps/web/src/lib/flash.ts`, timed from `motionMs()`; curves read from the tokens (`--motion-ease`, `--motion-ease-drawer`) so they have one source.
- "Once per hold" uses the module-level pattern already in this file: `announcedPhase` (a `WeakMap` keyed by `held.undo`, `held-message.tsx:70`).
- Accent: `bg-primary` (contrast-checked against the background: `contrast.ts`, `ui("primary", …)`). No color literals (`no-hardcoded.test.ts`).

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

1. **`apps/web/src/lib/flash.ts`**: add the seal:

   ```ts
   /**
    * Plan 196: a held message's mail leaves: the accent line across its top draws once, left to right (the crossbar of
    * Terno's mark), and stays while it's sending. Motion off: it's simply there.
    */
   export function seal(line: Element | null): void {
     const ms = motionMs();
     if (!line || ms === 0) return;
     line.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: Math.min(Math.round(ms * 1.33), 100), easing: token("--motion-ease-drawer") || "ease-out" });
   }
   ```

2. **`apps/web/src/components/held-message.tsx`**:
   - `const ref = useRef<HTMLElement>(null);` and `const line = useRef<HTMLSpanElement>(null);` in `HeldMessage`.
   - The first-reveal effect becomes: `useEffect(() => { if (firstReveal(held.draftId)) { revealHeld(held.draftId); arrive(ref.current); } }, [held.draftId]);`
   - A seal effect, once per hold:

     ```tsx
     // plan 196: the moment it can no longer be taken back, once per hold (a conversation left and come back to doesn't replay it)
     useEffect(() => {
       if (held.phase !== "sending" || sealed.has(held.undo)) return;
       sealed.add(held.undo);
       seal(line.current);
     }, [held.phase, held.undo]);
     ```

     with `const sealed = new WeakSet<HeldSend["undo"]>();` beside `announcedPhase`.
   - The article: `ref={ref}`, and `relative` added to its className; as its first child:

     ```tsx
     {/* plan 196: sealed: the accent line over its top edge while it's sending */}
     <span ref={line} aria-hidden data-testid="held-seal" className={cn("pointer-events-none absolute inset-x-0 -top-px h-0.5 origin-left bg-primary", held.phase === "sending" ? "scale-x-100" : "scale-x-0")} />
     ```

   Imports: `arrive, seal` from `~/lib/flash`.

## Boundaries

- Do NOT change the held message's layout, the pill, its countdown, Undo or the announcements.
- Do NOT add a sound, a paper plane, a confetti or any other motion; no new tokens or dependencies.
- Do NOT play anything for a send without a hold (Undo send off, Send later).
- If `held-message.tsx` has drifted from the excerpts, STOP and report.

## Tests

- Unit (`apps/web/src/components/held-message.test.tsx`, jsdom, `Element.prototype.animate` stubbed to record calls; motion at 75): a hold renders, arrives once (one `arrive` animation on the article); re-rendering doesn't arrive again; phase `holding` → `sending` runs one `scaleX` animation on `[data-testid=held-seal]` and leaves it `scale-x-100`; unmounting and mounting the same hold in `sending` doesn't seal again; with motion 0 nothing animates and the line is `scale-x-100` while sending.
- e2e (the existing undo-send spec, `apps/web/e2e/` grep `held-undo`): after the window, `held-seal` is visible and spans the card's width; axe stays clean.
- Visual: screenshots of a held message holding and sending, light and dark (Terno, Graphite), looked at: the line sits on the card's top edge, the column's width.

## Verification

- **Mechanical**: `pnpm typecheck`, `pnpm lint`, the unit file, the e2e spec.
- **Feel check**: reply to a conversation with Undo send on.
  - On Send the card rises 4 px into place as the composer goes; it reads as the same message, not a new thing.
  - When the pill's border runs out, a thin accent line draws across the top of the card, left to right, once; "Sending…" sits under it; when the copy arrives the line goes with the card.
  - DevTools → Animations at 10 %: the line starts thin at the left and decelerates into the right edge (drawer curve), no overshoot.
  - Undo before the window ends: no line ever.
  - Motion 0 and reduced motion: no rise, no draw; the line is simply there while sending.
- **Done when**: the tests pass and the feel check holds at 50, 75 and 100 ms.

## Performance

One WAAPI animation per send at each beat, on one element each (`opacity`/`translate`, then `transform`). Nothing runs while holding; no timers added.

## Out of scope

- The dock's snack and the new-message pane's held view (`HeldNewMessage`): same component, so they get it for free; nothing else.
- Plans 195, 197–199.

## Revisions after the Codex review

1. **The seal plays on a phase change the card sees, not on mounting.** A hold can reach `sending` while no card is on screen; a card mounted already sending (a conversation come back to) shows the line drawn and plays nothing. The card keeps the phase it last saw in a ref; no module-level set.
2. **Layout effects, not passive ones.** The arrival and the seal start before the browser paints, so the card is never shown settled and then hidden, nor the line drawn and then restarted at zero. The reveal (`firstReveal` → `revealHeld`) moved into the same layout effect.
3. **Tests that can see it.** The e2e (`motion.spec.ts`) opts out of the suite's reduced motion and records the `arrive` and `seal` animations as they're asked for: one arrival on Send, no seal while it can still be undone, one seal when "Sending…" shows, the line the card's width on its top edge, and nothing again after leaving the conversation and coming back mid-send.

## Revisions after the Codex code review

1. **Opening a conversation isn't Send.** A reply sent from the pinned card while reading something else first shows when its conversation is opened later; its first reveal would have played the arrival. A hold now says whether it was sent from the composer on screen where its card shows (`sentHere`: not pinned, and the conversation in the reader, or the pane for a new message); only then does the card arrive. The e2e sends from the pinned card while reading another conversation, opens the first, and records no arrival.
