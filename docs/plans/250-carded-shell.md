# Plan 250: the carded shell

## Request

> i want to see how our design looks when the thread list and the main email detail are cards, the background of the app will be the sidebar, and the email list and the email detail are cards, with a 1px margin between them and to the sides, very subtle, i think it would look good

Then, after looking at it: the cards keep their current backgrounds; 2px between them and to the window's edge; less rounded; a bit more room at the top and bottom; the Rules/Settings footer without the divider above it (a mini card was tried and dropped); in dark, the ground a touch deeper than the cards, still subtle. "Land this on main."

## What existed

The shell (plan 21, plan 24) is a grid: sidebar, list, reader (or sidebar and one pane in List). The sidebar painted `bg-sidebar`; the list and the reader sat on the body's background, split by hairlines (`hairline-l` on the list, `hairline-r hairline-strong` between list and reader). The sidebar's footer (Rules, Settings) had a strong hairline above it.

## Design

- `app-panes-carded` (globals.css) on the grid: the ground is `--shell`, `--pane-gap` (2px) between columns and to the right, 2px more above and below (4px).
- `shell` and `shell-translucent` are derived palette tokens (registry.ts, beside `sidebar-translucent`): the sidebar in light, 0.02 deeper in OKLCH lightness in dark, as the same step reads as less there. Under vibrancy `--shell` takes the translucent one, as `--sidebar` does. Only the ground moves: the cards keep their fills, the sidebar's ink gains contrast. (A first cut derived it in CSS with `oklch(from …)`; `no-hardcoded.test.ts` keeps colors in the palettes, so it moved there.)
- `pane-card` on the list's section and on the reader's `main`: the design's small radius (`--radius-sm`), clipped, a hairline drawn inside the edge (outline with a negative offset), so the gap stays the ground's colour. No fill of its own: the list paints `bg-pane`, the reader `bg-background`, as before.
- The sidebar has no fill of its own (the grid's ground is it): one translucent layer under vibrancy, never two.
- The hairlines between the panes are gone (the gap is the edge); the footer's divider is gone (on the ground the footer is part of the sidebar). Its padding is unchanged.
- Every style gets it; the pane handles keep their places (the 2px gap moves an edge by at most 2px).

## Measured (desktop build, 1440×900, macOS and Lumen, light and dark)

List card ends at 634, reader starts at 636 and ends at 1438; cards span 4 → 896. Dark ground vs card: Lumen rgb(26,25,23) vs rgb(33,31,29) (was 30,28,27); macOS rgb(24,25,27) vs rgb(28,29,31) (was 26,27,29). Light unchanged.

## Tests

Screenshot baselines updated (the shell's look changed everywhere); the e2e flows that measure the shell (panes, list layout, precision) run as before.

## Out of scope

A per-style switch for the carded shell; changing the palettes' sidebar tokens.
