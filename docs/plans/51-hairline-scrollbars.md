# 51 · Hairline scrollbars

## Request

> make this scrollbar be thinner so its almost not noticeable and that looks better, maybe a bit lighter even.

(A screenshot of the sidebar's scrollbar while the pane is hovered.)

## What exists

`globals.css` gives every element `scrollbar-width: thin` with a transparent `scrollbar-color`, and `*:hover` swaps in the foreground at 24 %. In Chromium (Electron, and the web build in Chrome), "thin" is still an 11 px classic bar with a fat thumb when macOS is set to show scroll bars (or a mouse is attached).

## Design

- Chromium and WebKit get custom `::-webkit-scrollbar` parts: an 8 px gutter with a 4 px pill (2 px transparent border, `background-clip: padding-box`), fully rounded, the foreground at 14 % (lighter than before), 28 % under the pointer or while dragging.
- The standard `scrollbar-width`/`scrollbar-color` properties turn off the custom parts in Chromium 121+, so they move behind `@supports not selector(::-webkit-scrollbar)`. Only Firefox applies them, still thin and hover-only.
- Hover-only is kept. Chromium never repaints a `:hover::-webkit-scrollbar-thumb` rule (a probe showed it stays unpainted even after scrolling), but it does repaint when the thumb's inherited value changes. So the color travels in `--scrollbar-thumb`, set to transparent on every element and to the ink on `*:hover`. Because it's set on every element, a hovered ancestor doesn't light its descendants.
- Elements that hide their bar (`[scrollbar-width:none]` on the tab strips) keep working: the standard `none` still wins in Chromium.

## Tests

`e2e/scrollbars.spec.ts` runs in its own browser, without Playwright's default `--hide-scrollbars`, so the bars actually paint:

- the list's gutter is at most 8 px (it was 11);
- the standard property stays `auto` in Chromium;
- the pane's right edge carries no ink while the pointer is elsewhere;
- on hover the pill appears, at most 4 px wide.

The test fails against the previous CSS (an 11 px gutter).

## Perf

There is no script. The custom property on `*` rides the style recalc that `:hover` changes already trigger.

## Out of scope

Overlay-style scrollbars that fade out after scrolling stops (that would need JS, and it breaks the "idle means idle" rule).
