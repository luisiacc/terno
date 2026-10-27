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
  - closing uses `--motion-base` (75 ms) with `--motion-ease`. That's slower than `Expand`'s close (`fast`, `ease-exit`): here many rows move, and at 50 ms on an ease-in curve they'd read as a jump;
  - the rows fade in linearly while their slots grow on the curve. On the curve, the first frame would show slivers of each row.

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

- A mouse or pen click in the sidebar, made while More is closed and you're in a hidden folder, **holds** that folder. Its row stays (no longer active) after the click takes you elsewhere.
- It goes when the pointer leaves the sidebar, or when something covers it, such as a dialog. If the row has keyboard focus at that moment, it goes when focus leaves the group instead.
- Leaving any other way (a shortcut, the palette, Enter on a focused row, a tap) holds nothing, so the row collapses at once. With no pointer resting on the sidebar, nothing can move under it.
- Toggling More lets held rows go. The folder you're in always stays.
- Held rows are focusable and clickable like any shown row.

This is event logic only. A captured `click` listener on the sidebar adds the current folder to a React state (`held`) before the click navigates. `pointerenter`, `pointerleave` and `focusout` decide when to let go. Nothing is read from the DOM during render, and hovering renders nothing.

### Everything else from plan 21, unchanged

- `aria-expanded` and `aria-controls`, the More/Less label, the `role="group"` and its name;
- persistence, closed by default;
- focus recovery onto More;
- shortcuts and the palette;
- every design (the same component), and `ROW_SEAM` on every row.

### Scrolling and resizing

Nothing you're looking at jumps when More toggles. There are three cases, each tested:

- **More in view.** `scrollTop` is unchanged, and More and everything above it stay put. Opening only adds below.
- **Rows in view below a change** (a shortcut revealing Trash while scrolled down, or closing while scrolled to the end): the browser's scroll anchoring changes `scrollTop` so the rows in view stay put.
- **Overflowing only while open,** scrolled to the end, then closed: the content stops overflowing, `scrollTop` clamps to 0 frame by frame, and the sidebar ends at its top with nothing cut off or blank.
**Resizing panes** is untouched. The wrapper is width-agnostic, and a drag's CSS-variable writes don't touch it.

**Dragging rows onto categories.** A drag caches the targets' boxes and re-measures them when the sidebar scrolls. Now More's group also changes size during a drag (a held row let go, or a key revealing Trash), which moves the categories without any scroll. A `ResizeObserver` on the group, alive only during a drag, re-measures them too.

## Tests

**e2e (`sidebar-panels.spec.ts`, Part A, `@design`; replaces "nothing below moves"):**

1. **Closed: no gap.** The Categories title starts right under More. `title.top − more.bottom` equals the gap the design puts between sections (`accountsTitle.top − lastCategory.bottom`), to 0.5 px. Open: the same gap under Trash, and the first category is 5 rows (5 × `--nav-h`) lower. The nav's `scrollHeight` grows by 5 rows.
2. **Animates within the cap** (revised after the Codex review: frozen, not sampled on the clock). With motion on, click and freeze More's transitions halfway:
   - the first category is strictly between closed and open, and past halfway;
   - every transition is ≤ 100 ms;
   - the same holds closing;
   - the motion setting at 100, 50 and 0 caps them at 100, 67 and instant;
   - the ui-perf gate times the real thing (frames between, settled within 100 ms plus two frames).
3. **Instant with reduced motion.** In the frame after the click, the first category is already at its open position, the Trash slot is `opacity: 1` and `visibility: visible`, and nothing animates.
4. **Interruptible,** both ways: freeze at 40 % and click again. The new transitions start from the frozen position, and the slide ends where it started. Reduced motion turning on mid-slide ends it at once.
5. **The folder you're in:**
   - `g #` with More closed shows only Trash, active, focusable; Categories sit one row lower;
   - with the pointer off the sidebar, `g i` collapses it and Categories go back;
   - with the pointer on the sidebar, clicking a category keeps Trash shown (not active, not inert) and Categories don't move; moving the pointer off collapses it;
   - toggling More lets held rows go (the folder you're in stays);
   - a held row with keyboard focus stays when the pointer leaves, and goes with focus;
   - a tap, or Enter on a focused category, holds nothing;
   - a drag re-measures the categories when the folders change size;
   - a category or its suggestions still never reveal All Mail.
6. **Keyboard and accessibility:** the existing tests (Tab order, `inert`, More/Less, focus recovery), plus a held row being in the Tab order. axe in light and dark (the existing walk), with More open and closed.
7. **Scrolling** with 80 categories:
   - scrolled a little (More still visible), toggling keeps `scrollTop` and More's top;
   - scrolled so More is off screen, `g #` keeps the first visible category's top (anchoring);
   - the pane handle still resizes the sidebar.
8. **The layer:** the wrapper's computed `will-change` is `transform`, and the CDP LayerTree has a layer for it. This guards the measured cost.
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

## Revisions after the Codex review

Codex (`codex exec -s read-only`) made 12 points against the plan and the code. All 12 were taken.

1. **No render-time read of pointer state.** The plan read a module variable during render, which is an untracked dependency under React Compiler. Now the hold is event logic: a captured `click` listener adds to the `held` React state before the click navigates, and `pointerleave` and `focusout` let go. Render reads React state only.
2. **Letting go of a focused held row.** Focus recovery now depends on `held` too, and moves focus with `preventScroll`. A held row with keyboard focus stays when the pointer leaves, and goes when focus leaves the group. Tested.
3. **The hold's lifecycle.**
   - Only a mouse or pen click holds. A tap, or Enter on a focused row, holds nothing (both tested).
   - A dialog covering the sidebar counts as the pointer leaving.
   - A remount drops the hold, which is harmless: the folder you're in still shows.
4. **Drag targets go stale when the categories move without a scroll.** A `ResizeObserver` on the group re-measures the targets during a drag. Tested: a key reveals Trash mid-drag, and the highlight follows the category under the pointer. Without the fix, it stays on the old one.
5. **The scrolling contract,** split into its three cases (§Scrolling and resizing). Two motion-on tests were added: closing at the end of a long list (the rows in view stay put), and a sidebar that overflows only while open (it returns to the top, with nothing cut off or blank).
6. **Temporary auto-open** (not persisted) was weighed: it still shifts five rows where one suffices, so the one-row reveal stays. The rule is now precise: toggling More lets held rows go, and the folder you're in always stays (tested).
7. **The geometry assertions.**
   - Content bounds replace `scrollHeight`, which only grows once the nav overflows.
   - The gap reference includes the review rows (the category's box).
   - Empty categories are covered: Categories and their empty note still sit right under More.
8. **The motion spec.**
   - The close timing is documented as different from `Expand`'s, and why.
   - The motion setting is tested at 100 ms (max 100), at 50 (max 67) and at 0 (instant).
   - Reduced motion turning on mid-slide ends it at once, in place.
9. **Deterministic motion tests.**
   - The e2e tests no longer sample frames on the clock. They freeze the transitions (pause, then seek to the middle) and assert the position is strictly between the ends and past halfway (the curve eases out).
   - Interruption is tested both ways: freeze at 40 %, click, and the new transitions start from the frozen position.
   - The wall-clock checks (frames between, settled within 100 ms plus two frames) moved to the ui-perf gate.
10. **The perf gate.**
    - It asserts zero long animation frames, and counts entries still queued in the observer (`takeRecords`).
    - NavItem renders are counted apart: the folders, and the rows below (`NavItem:below`), which must be 0.
    - The injected regression (a category row's prop depending on `open`) was run under React Compiler: the gate failed with 1,700 renders from the rows below (85 rows × 20 toggles).
11. **The layer.**
    - The e2e asserts Chromium really promoted the wrapper: a layer whose `backendNodeId` is the wrapper's, in the CDP LayerTree. A computed `will-change` alone proves nothing.
    - The claim about memory is qualified (above).
    - The cost was re-measured on the shipped code at DPR 1 and 2 (below).
    - Focus rings were checked in screenshots: the clip margin keeps them whole. The review badge, the sign-in marker and the popovers are portaled or positioned inside their row, so the layer's containing block doesn't move them; their existing tests pass.
12. **What the suites really cover.**
    - The new axe test scans the sidebar closed, open and with a held row, in light and dark.
    - `navTo` runs with motion on in the perf project.
    - The Spanish walk, `designs.spec`'s shared parts and the packaged restart smoke are all in the validation run.

## Implementation notes

- **Shipped cost** (the measurement spec on the final code, 80 extra categories, 4× CPU, 20 toggles per run, two runs each): 25–26 ms main-thread rendering per toggle at DPR 1, 24–25 ms at DPR 2. Raster is 0.4 ms, the frame p95 16.7 ms, and there are no long frames. Plain grid rows measured 36–43 ms.
- **The ui-perf gate on the final code:**
  - frame p95 of 16.7 ms and no long frames;
  - 20 of 20 toggles slid through frames between the ends, and all settled within the cap;
  - 5.0 folder renders per toggle and 0 renders of the rows below.

## What the Codex code review changed

`codex exec -s read-only` reviewed `5a972a3..HEAD` with `-C` pointed at this worktree. It made two findings, both medium. Both are fixed, each with a test that fails without its fix.

1. **A click on the folder you're in held it.** With More closed, `g #`, click the Trash row itself, then `g i`: Trash stayed shown and focused, bypassing focus recovery.
   - Now a mouse click only *arms* the hold. The hold is taken when that click navigates: an app-store subscription sees the view change inside the click's handler, so the hold joins the same render.
   - The window disarms it once the click's dispatch ends (it hears the click last), and at the next key or press. An earlier `setTimeout` disarm lost the race to the following keystroke on a loaded machine, because input outranks timers.
   - New e2e ("a click on the folder you're in holds nothing"). It fails without the fix: Trash stays visible.
2. **The overflow test measured the sidebar mid-slide.** It now waits for the five rows to finish growing before sizing the window.

Also from the same pass: the scroll tests wait for the slide's animations to end instead of a fixed 250 ms.

## Suite results (this machine, under the user's other load)

- **Passing:**
  - `pnpm typecheck` and `pnpm lint`;
  - `pnpm test`: unit 6,626 passed plus db-wasm 1,259 passed. The 4 failures are the known `reply-to.test.ts`;
  - `pnpm test:web`: 43 passed;
  - `pnpm dist:mac`.
- **`pnpm test:e2e`, final full run:** 1,039 passed and 17 failed, all outside this plan.
  - **Known on main:** `attachments.spec` 11 and 188 (×3 designs), and `reader.spec.ts:66` (×3).
  - **Failing on the base commit too** (run there 3× each): `list-layout.spec.ts:139` (8 of 9 runs on base), `compose.spec.ts:169` and `resign-in.spec.ts:126`.
  - **Timing only:** `selection.spec.ts:365`, `dnd.spec.ts:41` and `unread-filter.spec.ts:217` each passed 3 of 3 when run serially on their own.
  - `sidebar-panels.spec`: 106 passed, then 212 of 212 with `--repeat-each=2`.
- **`pnpm test:ui-perf`:** 57 passed, 1 failed. The new More gate passes:
  - frame p95 16.8 ms and no long frames;
  - 20 of 20 toggles slid through frames between the ends;
  - 5.0 folder renders per toggle, and 0 renders of the rows below.

  The failure was `autocomplete-perf.spec.ts:317`, at 17 ms against 16.7 ms. It passed 3 of 3 on its own.
- **Packaged smoke:** 54 passed, 2 failed.
  - The More restart check passes.
  - `update.smoke.ts:249` passed 3 of 3 on its own.
  - `people.smoke.ts:83` (a v13 profile migration) fails 3 of 3, and fails on the base commit's own packaged build too. It's the desktop side of the known legacy-migration failures.

**After rebasing onto `4d16b34` (main with plan 39):** no conflicts, and main had touched no baseline and no sidebar code. The full `pnpm test:e2e` gave 1,066 passed and 12 failed: the known `attachments` and `reader:66` failures (×3 designs), `resign-in:126` (it fails on base too), and `selection.spec.ts:81` in Lumen, which passed 3 of 3 on its own. Every baseline matched.
