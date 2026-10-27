# Plan 40: More takes no space while closed; what's below slides

- **Status:** in progress.
- **Builds on:** `5a972a3` (main).
- **Reverses:** plan 21 §A.2's reserved block. Everything else in plan 21 Part A stays.
- **Parallel work:** plans 38 (badge and notifications) and 39 (autolinks) run in other worktrees. This plan stays in `sidebar.tsx` and the sidebar specs; the full-window baselines are the shared surface (whoever lands second regenerates them).

## Request (verbatim)

It came with a screenshot of the sidebar with More closed: Inbox, Starred, More, then a large empty gap before Categories, and a red arrow from the gap up toward More.

> "lets not have this space blank as always, lets occupy that space with the items like categories if they are there then the rest of items below them, when clicking 'more' it should shift them with a nice quick smooth animation and performant."

## What exists

- `sidebar.tsx`: Inbox and Starred (`PINNED`), then `MoreFolders`: a More button (`nav-more`, `aria-expanded`, `aria-controls="sidebar-more-folders"`, More/Less), then a `role="group"` of five slots (Sent, Archive, All Mail, Spam, Trash).
  - Each slot always keeps its row's height. Hidden slots are `opacity: 0`, `translateY(-2px)`, `visibility: hidden` and `inert`, fading over `--motion-base`.
  - Plan 21 wanted this: "leave that space … so they don't shift the layout". The user now wants the opposite.
- **The folder you're in** (`folderView`: `view` unless a category or its suggestions are selected) is shown in its own slot while More is closed. Because the slots were reserved, showing it moved nothing.
- **Focus recovery:** a layout effect on `[open, view]` moves focus to More when the focused element sits in a slot that just went inert.
- **State:** `useSidebarMore` (zustand) persisted in `localStorage["terno:sidebar-more"]`.
- **Below More:** the Categories section (title with `mt-4`, rows that are drop targets, review rows or badges, the new-category input), then Accounts (title with `mt-4`, All accounts, one row per account, Add account). It all sits in one scrolling `<nav data-drop-scroll>`, and the pane is resizable (plan 21 Part B).
- **Motion:** `--motion-fast/base/slow` (50/75/100 ms by default, scaled by the user's setting). The global rule sets `transition: none` when motion is off or reduced. `components/expand.tsx` already animates a `0fr → 1fr` grid row for inline disclosures, so that is the app's idiom.
- `ROW_SEAM`: a half-pixel transparent border so a hovered row's fill never touches the selected one's.

## Design

### Layout

When closed, the group takes no space: Categories sit right under More, at the normal group spacing (the section title's own `mt-4`, the same gap as between the last category and Accounts). Opening grows the five slots from 0 to a row each, and everything below slides down with them. Closing reverses it.

### The animation: per-slot `grid-template-rows`, with what's below on its own compositor layer

I measured three techniques, plus a variant of the first, in the real app before choosing (a throwaway prototype and a Playwright spec):

- 80 extra categories plus the demo's 4 accounts and 6 categories (about 95 rows below More);
- 20 toggles each, with a Chromium trace and every rAF interval recorded;
- CPU at 1× and 4× throttling, three runs at 4×.

The numbers below are main-thread rendering per toggle (UpdateLayoutTree, Layout, PrePaint, Paint, Layerize, Commit), at 4× throttling:

| technique | main / toggle | paint | raster | frame p95 | long frames |
|---|---|---|---|---|---|
| A. `grid-template-rows: 0fr → 1fr` per slot | 36–43 ms | 13–15 ms | 2.0–2.9 ms | 16.7 ms | 0 |
| A + `will-change: transform` on what's below (a permanent layer) | **22–24 ms** | 9 ms | 0.4 ms | 16.7 ms | 0 |
| A + `will-change` only during the toggle | 31–34 ms | 14–15 ms | 1.0 ms | 16.7 ms | 0 |
| B. FLIP: one layout, then `transform` on what's below and `clip-path` on the folders | 21–25 ms | 7–8 ms | 1.2 ms | 16.7 ms | 0 |

All four are smooth: no dropped frames even at 4×, spread over the 5–6 frames of a toggle. Plain A costs about twice as much as B, because every frame re-records and re-rasters the ~95 rows that move. With what's below on its own layer, a layout move only shifts that layer, so nothing is re-recorded or re-rastered, and **A + layer costs the same as FLIP**. Creating the layer only for the toggle costs nearly as much as plain A, because creating and dropping the layer each paints the whole subtree once.

**Choice: A + a permanent layer.** It matches FLIP's cost, and the layout engine and CSS transitions give us, with no JavaScript in the animation:

- **interruption:** clicking More again mid-way reverses from where it is;
- **the selected-folder case:** one slot animating on its own, rows moving around a shown slot;
- **scroll:** the browser's scroll anchoring and clamping run every frame, so a closing group near the bottom of a scrolled list eases instead of jumping at the end;
- **motion off:** the global `transition: none` (a WAAPI FLIP would have to check motion itself, including the language switch's `motion-paused`).

FLIP needs all of that by hand: a measured inverse for each moving block, a "closing" state that keeps the folders painted with a negative margin, and a `clip-path` animation. Chromium doesn't composite `clip-path`, so B paints too.

**Layer cost.** The below wrapper becomes one extra tiled layer (216 × 2,610 CSS px with 80 categories, measured with the CDP LayerTree). Chromium rasters only the tiles near the viewport, so memory is bounded by the sidebar's visible area, not the list's length. The nav is already a composited scroller.

**Details:**

- **Slot.** `display: grid; grid-template-rows: 0fr` (hidden) or `1fr` (shown). The inner wrapper is `min-height: 0; overflow: clip; overflow-clip-margin: 3px`. The clip margin is so the 2 px focus ring (offset 1 px) isn't cut off.
- **Transitions.** `grid-template-rows`, `opacity` and `visibility` transition together:
  - opening uses `--motion-slow` (100 ms at the default setting, the cap) with the drawer curve;
  - closing uses `--motion-base` (75 ms) with `--motion-ease`;
  - these are the same pairs `Expand` uses (open slow, close quicker).

  There's no stagger (a delay would count against the cap), and plan 21's `translateY(-2px)` is dropped, because the row is now revealed by its growing slot.
- **What's below.** Categories and Accounts are wrapped in one `<div data-more-below class="will-change-transform">`. The wrapper adds no box of its own: the first section title's margin collapses through it exactly as before.
- **Motion off or reduced.** The global rule makes the change instant (same frame).
- **Hidden slots** stay `inert` and `visibility: hidden`, with 0 height, so they're out of the tab order and the accessibility tree.

### The folder you're in, while More is closed

Showing it now costs one row of shift. I considered four options:

1. **Show just that row in the collapsed group, animated in (chosen).** You pressed `g #` and Trash appears where it lives, and the list below moves by one row, in the same moment the list on the right changes to Trash. That's the smallest shift and the honest one: it's the place you went.
2. **Auto-open More.** That shifts five rows instead of one, and it writes a preference the user didn't choose. It would either stay open after you leave (surprising) or close again (two shifts).
3. **Show the folder in More's row** ("More · Trash", or More turning into the active row). One control would do two jobs, navigate and disclose, and the active row's look and its `aria-expanded` would conflict.
4. **Above More, between Starred and More.** It's still a shift, and the folder sits away from its siblings once More opens.

Option 1 has one wrinkle: **leaving** that folder by clicking in the sidebar would slide everything up under the pointer right after the click. Your pointer then lands on the neighbouring row, and a quick second click hits the wrong category. So, the refinement: nothing moves under the pointer.

- When you leave a folder that was only shown because you were in it, and the pointer is over the sidebar, its row stays (no longer active) until the pointer leaves the sidebar. Then it collapses, with the transition.
- With the pointer elsewhere (a shortcut, the palette), it collapses at once.
- Closing More with a click collapses everything, held rows included: you asked for it.
- Rows held this way are focusable and clickable like any shown row.
- The held set is the folders you left this way. It's usually one; two if you jumped Trash → Spam with the palette while hovering.

Pointer presence comes from `pointerenter` and `pointerleave` on the sidebar, written to a module variable. Only a leave with something held updates state, so hovering the sidebar renders nothing.

### Everything else from plan 21, unchanged

- `aria-expanded` and `aria-controls`, the More/Less label, the `role="group"` and its name;
- persistence, closed by default;
- focus recovery onto More;
- shortcuts and the palette;
- every design (the same component), and `ROW_SEAM` on every row.

### Scrolling and resizing

- **No jump in scroll position when toggling.** The nav keeps `scrollTop`: More sits above what moves, so it doesn't move.
  - A reveal above the viewport (a shortcut while scrolled down) is absorbed by the browser's scroll anchoring, so the visible rows stay put.
  - Closing near the end of a scrolled list clamps `scrollTop` frame by frame, so it eases rather than jumps.
- **Resizing panes** is untouched. The wrapper is width-agnostic, and a drag's CSS-variable writes don't touch it.

## Tests

**e2e (`sidebar-panels.spec.ts`, Part A, `@design`; replaces "nothing below moves"):**

1. **Closed: no gap.** The Categories title starts right under More. `title.top − more.bottom` equals the gap the design puts between sections (`accountsTitle.top − lastCategory.bottom`), to 0.5 px. Open: the same gap under Trash, and the first category is 5 rows (5 × `--nav-h`) lower. The nav's `scrollHeight` grows by 5 rows.
2. **Animates within the cap.** With motion on, sample the first category's top every frame from the click:
   - it takes at least one value strictly between closed and open (so it slides rather than jumps);
   - it reaches the open position within 100 ms plus two frames;
   - every transition on the group and More is finite and ≤ 100 ms (the existing sampler);
   - the same holds closing.
3. **Instant with reduced motion.** In the frame after the click, the first category is already at its open position, the Trash slot is `opacity: 1` and `visibility: visible`, and nothing animates.
4. **Interruptible.** Two clicks in one frame leave it closed, and the first category back at its closed top with no stray offset.
5. **The folder you're in:**
   - `g #` with More closed shows only Trash, active, focusable; Categories sit one row lower;
   - with the pointer off the sidebar, `g i` collapses it and Categories go back;
   - with the pointer on the sidebar, clicking a category keeps Trash shown (not active, not inert) and Categories don't move; moving the pointer off collapses it;
   - closing More with a click collapses held rows too;
   - a category or its suggestions still never reveal All Mail.
6. **Keyboard and accessibility:** the existing tests (Tab order, `inert`, More/Less, focus recovery), plus a held row being in the Tab order. axe in light and dark (the existing walk), with More open and closed.
7. **Scrolling** with 80 categories:
   - scrolled a little (More still visible), toggling keeps `scrollTop` and More's top;
   - scrolled so More is off screen, `g #` keeps the first visible category's top (anchoring);
   - the pane handle still resizes the sidebar.
8. **The layer:** the below wrapper's computed `will-change` is `transform`. This guards the measured cost.
9. **Row seam:** the existing test, unchanged.
10. **Visual baselines** that show the sidebar, in every design (`e2e`, `e2e-lumen`, `e2e-atelier`), updated and looked at.

**ui-perf (`perf.spec.ts`).** "Toggling More with 80 more categories":

- 20 toggles, motion on;
- `frameGate` (p95 ≤ 20 ms, no frame over 50 ms), plus no long animation frames;
- NavItem renders per toggle ≤ 5 (the five folders; the ~90 category and account rows never render to animate);
- shown failing on an injected regression (the Sidebar subscribing to `open`, which re-renders every row).

## Screenshots

Closed and open, light and dark, for macOS, Lumen and Atelier, plus a frame strip of the transition: `/tmp/unica-scratch/sidebar-more/`.

## Performance and resources

- No timers, no polling, and no listeners beyond `pointerenter` and `pointerleave` on the sidebar, which write a module variable.
- One extra compositor layer, bounded by the visible sidebar (above).
- The animation is CSS transitions only, and toggling renders `MoreFolders` alone: 6 rows.

## Out of scope

- A dot on More for hidden counts (still none; plan 21 §A.2's rule stands).
- Reordering folders, or choosing which are pinned.
- Animating the category rows themselves (added or removed rows still appear at once).
