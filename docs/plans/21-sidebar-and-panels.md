# Plan 21: a quieter sidebar (More) and resizable panes

- **Status:** in progress.
- **Builds on:** `402470a` (main after plan 18).
- **Parallel work:** plan 17 (People, "waiting for your reply": stores and quick filters) and sender icons plus an account label in thread rows run in other worktrees. This plan stays in the sidebar and the app shell (`sidebar.tsx`, `app.tsx`, a new `lib/panes.ts`, `components/pane-handle.tsx`) so the merges stay clean. Full-window visual baselines are the one shared surface (§7).

Two parts. Each has its own e2e spec section and its own section in the Codex reviews.

## Part A: only Inbox and Starred, the rest behind "More"

**Request (verbatim).** It came with a screenshot of the sidebar (Inbox, Starred, Sent, Archive, All Mail, Spam, Trash, then Categories and Accounts) with a red line under Starred:

> "for all themes, always, lets only show the inbox and starred here, the others should be behind a 'More' light button showing and dissappearing with a nice quick transition, leave that space that they occupy like that, so they don't shift the layout whey they appear."

### A.1 What exists

- `sidebar.tsx` renders `VIEWS` (seven folders) as `NavItem`s inside a `Tooltip` (the shortcut, where there is one), then the Categories section, then Accounts, all in one scrolling `<nav>`. Only the inbox shows a count (`counts.inboxUnread`, per account when one is chosen). Categories are drop targets (`useDropState`); folders are not.
- Every design (macOS, Atelier, Lumen) uses the same `NavItem`: its height is `--nav-h`, its shape `--nav-radius`, its type `type-nav`. The designs differ only around it (the compose control above, the review badge on categories).
- Ways to reach a folder besides the sidebar: `g i / g s / g t / g a / g #` (`keyboard.ts`, `go.*`), the command palette, and `navigate()` from anywhere (search, a sender, boot restoring the last view).
- Device-local UI state lives in `localStorage` with a `terno:` key, read synchronously, with a try/catch for private mode: the format bar (`terno:format-bar`, `composer/controller.ts`), the list filters (`terno:list-filter`), the language, the appearance cache. On desktop this is the `app://terno` origin's storage in the profile (it survives restarts; the migration smoke moves it).

### A.2 Design

**Layout.** Inbox, Starred, then a quiet **More** row, then a block of five slots that always takes the five folders' height (Sent, Archive, All Mail, Spam, Trash), then Categories and Accounts.

- *The reserved space.* "Leave that space that they occupy like that, so they don't shift the layout when they appear": the block keeps its height while the folders are hidden, so Categories and Accounts never move when More is toggled. Folders fade in and out in place; nothing below them moves.
- *Where More sits.* Two placements keep the layout still: (a) More right under Starred, the reserved block below it; (b) More at the bottom of the reserved block, under the empty space. I chose **(a)**: the closed state (what the user sees most) reads as one group, "Inbox, Starred, More", with breathing room before Categories. It's also the usual disclosure shape: the trigger sits above what it reveals. With (b) the closed sidebar has a hole between Starred and an orphaned More. Both were screenshotted (§A.5) before deciding.
- More is one sidebar row in the folders' rhythm (`--nav-h`, the icon column), but light: `text-muted-foreground`, no icon weight, a small chevron in the icon slot that turns when open, the label "More" or "Less" ("Más" or "Menos"). Its hover is the sidebar's hover. It isn't a nav item: it never takes `data-active`.
- *Transition.* Each hidden slot goes `opacity: 0`, `translateY(-2px)`, `visibility: hidden`. Showing reverses it over `--motion-base` (75 ms by default, within the 100 ms cap), with `--motion-ease`. `visibility` is part of the transition, so the fade-out finishes before the row stops painting. There is no stagger, because a delay would count against the cap. With motion off (the setting at 0 or the OS asking for reduced motion), the global rule already sets `transition: none`, so it appears at once. The chevron's turn uses the same duration.

**State.** `open` lives in a tiny zustand store (`useSidebarMore`) persisted to `localStorage["terno:sidebar-more"]` (`"open"` or `"closed"`), read synchronously at module load, exactly like the format bar. It's per device, like other window layout. It's closed by default, as the request asks.

**The selected folder stays visible.** If the current view is one of the five (reached by a shortcut, the palette, a search's "back", boot), its slot is shown even while More is closed. Because the slots are reserved, it appears in its own place and nothing moves. It hides again (with the transition) once the user goes elsewhere. The others stay hidden.

**Shortcuts and the palette** are unchanged: they navigate, and the rule above makes the target visible.

**Accessibility.**

- More is a `<button>` with `aria-expanded` and `aria-controls="sidebar-more-folders"`.
- The block is a `<div id="sidebar-more-folders" role="group" aria-label="More folders">`.
- A hidden slot carries `inert`, so it can't be focused, can't be clicked, and is hidden from the accessibility tree. It's also `visibility: hidden` once the fade ends.
- Tab order: Inbox, Starred, More, then (when open) the five folders, then Categories.
- Focus is never moved by toggling. If focus is inside a folder when More closes (a keyboard user tabbed in, then clicked More), focus goes to More rather than being lost on an inert node.

**Badges.** Today only the inbox has a count. Sent, Archive, All Mail, Spam and Trash show none (Spam and Trash have no unread count in `counts`), so there's nothing a closed More could hide, and **More carries no dot**. If a hidden folder ever gains a count, the rule is a 6 px dot on More while closed. That's out of scope here (§10).

**Every design.** The same component serves all three. `designs.spec.ts`'s shared-parts test gains More's role and name (a button named "More" with `aria-expanded`), and the new spec's sidebar section is tagged `@design`.

### A.3 Copy (en, es)

| key | en | es |
|---|---|---|
| `sidebar.more` | More | Más |
| `sidebar.less` | Less | Menos |
| `sidebar.moreFolders` | More folders | Más carpetas |

### A.4 Tests (e2e: `apps/web/e2e/sidebar-panels.spec.ts`, "Part A", tagged `@design`)

1. **Closed by default.** Inbox and Starred are visible. The five folders are hidden and `inert`, so a Tab walk from Starred lands on More, then on the first category. More has `aria-expanded="false"` and `aria-controls` pointing at the group.
2. **Toggle and persistence.** Click More: the five are visible, `aria-expanded="true"`, the label reads "Less", and Tab reaches Sent. Reload: still open. Click again, reload: closed.
3. **No layout shift.** The bounding boxes of the Categories title, the first category and "All accounts" are identical (to 0.5 px) closed, open and closed again, both mid-transition (sampled every frame with motion on) and after it. The `<nav>`'s `scrollHeight` is unchanged too.
4. **Motion.** With motion on, the reveal runs finite transitions no longer than 100 ms (the motion sampler from `motion.spec.ts`). With reduced motion, no transition runs: `getAnimations()` is empty right after the click, and the folders are visible in the same frame.
5. **The selected folder stays visible.** `g #` (Trash) with More closed shows the Trash row, `data-active`, focusable. The other four stay hidden. `g i` hides Trash again. The same holds for the palette's "Archive".
6. **Shortcuts work while closed:** `g t`, `g a` and `g #` change the list title.
7. **Focus safety.** With focus on Sent (open), activate More by keyboard: focus lands on More, not on `<body>`.
8. **Spanish:** the "Más" and "Menos" labels (covered by `i18n.spec.ts`'s no-leaks walk, which now opens More first).
9. **Existing tests** that click Sent, Archive, All Mail, Spam or Trash go through a fixture helper `navTo(page, view)` that opens More when it must. The perf spec uses it too.

### A.5 Screenshots

Both placements, (a) and (b), closed and open, in light and dark for each design: `/tmp/unica-scratch/sidebar-21/a-*.png`. The design baselines (`design-inbox-*`, `design-980`) change, intentionally, for this part.

## Part B: resizable sidebar and list

**Request (verbatim):**

> "make the panels for the sidebar and the thread list resizable so the user can move it how they want, and we remember it after app restarts."

### B.1 What exists

- `app.tsx`'s shell is one grid: `grid-cols-[var(--sidebar-w)_minmax(var(--list-min),var(--list-max))_minmax(0,1fr)]`. Each design sets the variables:
  - macOS: 232 px, 340–400 px.
  - Atelier: 240 px, 340 to `min(390px, 32vw)`.
  - Lumen: 248 px, 340 to `min(400px, 32vw)`.
- Because the reader is a flexible `1fr`, the grid grows the list to its max first. So the list is 400 px (macOS) or 390 to 400 px at 1440 wide, and `max(340px, 32vw)` on narrow windows in Atelier and Lumen.
- There's no collapse behavior on narrow windows. The desktop window's `minWidth` is 980. `designs.spec.ts` asserts nothing overflows at 980×600, where macOS leaves the reader 348 px.
- The list column carries `hairline-l hairline-r` (the pane borders).
- The sidebar's top 52 px is a `drag-region`, as is the list header. Traffic lights sit at (20, 19) on macOS (`titleBarStyle: hiddenInset`).
- `ThreadList` is virtualized (TanStack). Its virtualizer re-renders only when the visible range changes, so a width change alone doesn't re-render it. Rows have a fixed height per design, so width never changes the range. In the reader, HTML mail frames size themselves with a `ResizeObserver` (`mail-body.tsx`), which is work proportional to the open messages, not a React render.

### B.2 Design

**Widths are CSS variables, clamped by CSS.** The grid becomes:

```css
grid-template-columns: var(--pane-sidebar-eff) var(--pane-list-eff) minmax(0, 1fr);
--pane-sidebar-eff: clamp(200px, var(--pane-sidebar, var(--sidebar-w)), 100vw - 340px - 300px);
--pane-list-eff: clamp(300px, var(--pane-list, max(var(--list-min), var(--list-max))), 100vw - 340px - var(--pane-sidebar-eff));
```

- `--pane-sidebar` and `--pane-list` are the user's widths in px, set on `<html>` only once the user has resized. Unset, the fallbacks are exactly today's resolved widths, so **every existing layout and baseline is unchanged until someone drags**. That's checked at 1440 and at 980 in all three designs.
- The limits (`lib/panes.ts`, one place, in px):

  | pane | min | max | default |
  |---|---|---|---|
  | sidebar | 200 | 360 | the design's |
  | list | 300 | 640 | the design's |
  | reader | 340 | — | the rest |

  The sidebar's 200 still fits the compose pill, the footer (Filters, Local, Settings) and the traffic lights (which end near 80 px). The list's 300 still fits every row layout with its date, checked in screenshots for classic, avatar and large-avatar. The reader's 340 is what macOS leaves it today at the minimum window.
- **Shrinking the window** never overflows and never rewrites what the user chose:
  - CSS clamps on every frame, with no JS or resize listener in the layout path.
  - The list gives way first, down to its min, then the sidebar, so the reader keeps 340 px.
  - Below 200 + 300 + 340 = 840 px (narrower than the desktop's minimum), the reader shrinks, as it does today.
  - Growing the window back restores the stored widths.
  - Density: the limits don't depend on row density (rows don't change width).
- One stored pair for every design: the user's choice is about their screen, not a style. Without it, each design keeps its own default.

**Storage.** `localStorage["terno:panes"] = {"v":1,"sidebar":number|null,"list":number|null}`.

- It's read and applied to `<html>` at module load (imported by `app.tsx`, before React's first commit), so there's no flash of the default.
- A value that isn't a finite number within its limits is dropped, and that pane falls back to its default.
- A failed write (private mode, full storage) keeps the width for the session.
- On desktop this is the profile's renderer storage, the same as the format bar and the language, so it survives restarts. The packaged smoke proves it (B.4).

**Handles (`components/pane-handle.tsx`).** Two handles, one on each edge of the list column (sidebar | list and list | reader), absolutely positioned over the existing hairline. Each is an 8 px hit area centered on the boundary (`-left-1 w-2`) with a 2 px line in it:

- invisible at rest, so the pane's own hairline is what shows;
- visible on hover, focus-visible, or while dragging, in `--ring` at half opacity (full while dragging), faded in over `--motion-fast`;
- `cursor: col-resize`;
- `no-drag`, so on desktop the top 52 px of the boundary isn't eaten by the window's drag region;
- `z-20`, below popovers and dialogs.

**Pointer.**

- **`pointerdown`** (primary button):
  - `preventDefault()`, so no text selection starts;
  - `setPointerCapture`;
  - remember the start x and the pane's measured width (`getBoundingClientRect`);
  - set `<html data-resizing>`, whose CSS gives a `col-resize` cursor everywhere, `user-select: none`, and `pointer-events: none` on iframes, so a mail frame can't swallow the move.
- **`pointermove`:** the next width is the start width plus dx, clamped to the pane's limits *and* to what the viewport allows right now. It's written to `--pane-*` on `<html>` in a `requestAnimationFrame`, at most one write per frame. No React state changes during a drag.
- **`pointerup` or `lostpointercapture`:** apply the last value, commit it to the store and to storage once, and clear `data-resizing`.
- **Esc during a drag:** restore the start width, without committing.
- **Double-click:** reset to the design default. The variable is removed and the stored value set to null.

**Keyboard** (window splitter pattern):

- `role="separator"`, `aria-orientation="vertical"`, `tabIndex=0`, and an `aria-label` ("Resize sidebar" or "Resize message list"; es "Cambiar el ancho de la barra lateral" or "de la lista de mensajes");
- `aria-controls` pointing at the pane's id;
- `aria-valuenow`, `aria-valuemin` and `aria-valuemax`, in px, using the *effective* width and max. A `ResizeObserver` on the two panes updates only the handles' state;
- ← and → move by 16 px, and with Shift by 64 px. Home goes to the min, End to the max. Each press commits;
- Enter resets to the default, the keyboard twin of the double-click. It's local to the focused control, like a slider's keys, so it isn't in the shortcuts dialog;
- the handler calls `preventDefault()`, so the document's shortcut handler (which skips prevented events) never sees those keys.

**Rendering cost.** A drag touches two CSS variables per frame, then layout and paint:

- `App` doesn't subscribe to the widths, so neither `ThreadList` nor any `ThreadRow` re-renders, during the drag or after it.
- The handles re-render from their `ResizeObserver` (two tiny components).
- A new probe, `renderProbe("ThreadList")`, makes the list's own renders countable.

**Desktop parity.**

- Traffic lights: the sidebar's min (200) keeps them inside the sidebar, and its drag region is unchanged.
- The handles are `no-drag` across the title band, so a drag that starts there resizes rather than moving the window. There's a smoke check that the boundary's top is a resize target.
- No main-process change. `minWidth` stays 980.

### B.3 Copy (en, es)

| key | en | es |
|---|---|---|
| `panes.resizeSidebar` | Resize sidebar | Cambiar el ancho de la barra lateral |
| `panes.resizeList` | Resize message list | Cambiar el ancho de la lista de mensajes |

### B.4 Tests

**Unit (`lib/panes.test.ts`):**

- parse and validate the stored value: garbage, out of range, the wrong version and non-numbers each fall back;
- the clamp math for a drag: the limits, the viewport's room, the list giving way first;
- keyboard steps, Home and End;
- a failed write keeps the session's width.

**e2e (`sidebar-panels.spec.ts`, "Part B", tagged `@design`):**

1. **Pointer resize.** Drag the sidebar handle by +60 px: the sidebar's box widens by 60 (±1), the list keeps its width, and the reader narrows. Drag the list handle by +80: the list widens by 80, and the sidebar is unchanged.
2. **Persistence.** Reload: both widths are the same, and `aria-valuenow` matches.
3. **Keyboard.** Focus the sidebar handle. → three times is +48. Shift+← is −64. Home is the min (200), End is the max. `aria-valuenow`, `aria-valuemin` and `aria-valuemax` follow. Enter resets. Arrow keys on the handle don't move the list's selection.
4. **Clamping.**
   - Dragging past the max stops at it, and past the min too.
   - At the minimum window (980), after a wide sidebar and list, nothing overflows (the overflow check from `designs.spec.ts`), and the reader is at least 340 px.
   - Back at 1440, the stored widths return.
5. **Double-click reset:** the design's default width, and the stored value is gone (`localStorage`).
6. **Esc mid-drag** restores the start width, and nothing is stored.
7. **No overflow in any design** at 980 with defaults: the existing test, unchanged.
8. **Axe** (the existing light and dark runs) covers the separators' names and values.

**ui-perf (`perf.spec.ts`).** "Resizing panes: every pointer move paints within a frame budget, and neither the list nor its rows re-render":

- 120 pointer moves across each handle, with a thread open (an HTML message in the reader) and 3,000 threads loaded;
- asserts `ThreadList` and `ThreadRow` renders are 0 during the drag, and 0 for the commit on release;
- asserts the p95 of pointermove to the next frame is ≤ 33 ms × the multiplier, and that no long-animation-frame occurs;
- shown failing on an injected regression (the width committed to a store `ThreadList` reads, on every move), recorded in §Implementation notes.

**Desktop smoke (`packaged.smoke.ts`).**

- Resize the sidebar with the keyboard and open More.
- Relaunch.
- The width and More's state are the same: storage survives a real restart on `app://`.
- The handle's top 20 px is hit-testable, not a window drag region (`document.elementFromPoint` returns the handle).

### B.5 Screenshots

Each design in light and dark, at the default, with a wide sidebar, with a narrow list, and hovering a handle: `/tmp/unica-scratch/sidebar-21/b-*.png`.

## 7. Visual baselines

Part A changes every full-window baseline that shows the sidebar, which is intended: the five folders are hidden, More is visible, and the space is reserved. Updated per design (`e2e`, `e2e-lumen`, `e2e-atelier`), and each was looked at. Part B changes none, because the defaults are today's widths. The other two worktrees will change the same PNGs (thread rows), so whoever merges second regenerates them.

## 8. Performance and resources

- No timers, no polling, and no listeners until used. Part A adds one store and no effects. Part B adds:
  - one `ResizeObserver` on the two panes, which fires only when a width changes;
  - document-level listeners during a drag only (pointer capture keeps them on the handle);
  - no `window.resize` listener, because CSS clamps.
- A drag is CSS-variable writes, at most one per frame. Storage is written once per drag or keypress.
- Bundle: a few hundred bytes in the entry chunk, which is where the shell lives.

## 9. Out of scope

- Collapsing the sidebar entirely, or hiding the list.
- Per-design or per-account widths.
- Resizing the reader's column (`--reader-max`).
- Reordering the folders, or choosing which ones stay visible.
- A dot on More (no hidden folder has a count today; the rule is written down in §A.2).

## Revisions after the Codex review

Codex (`codex exec -s read-only`) made ten points against the plan and the code. All ten were taken.

**Part A**

1. **`view` alone isn't the folder you're in.** A category navigates with `view: "all"`, and so do a category's suggestions (with no category selected). The plan's rule would have revealed All Mail there, and the existing active style already lit All Mail on a category's suggestions. Now there's one predicate, `folderView = categoryId === null && reviewCategoryId === null ? view : null`. It drives both the active style and the closed-More exception, with an e2e for a category and for its suggestions.
2. **Focus recovery covers automatic hiding too.** Picture More closed, Trash selected and focused, then `g i`: the Trash slot goes inert under the focus without any click on More. The fix is a layout effect on `[open, view]` that moves focus to More whenever the focused element sits in a slot that just became inert. It runs before the browser's focus fixup, which happens at the next frame. The click-time check was removed, since this one covers both cases. There's an e2e for that exact sequence. The Tab-order test now expects the Categories section's + button (it comes before the first category).

**Part B**

3. **Esc restores the preference, not the measured width.** The drag keeps the stored, nullable value (`stored`) apart from the effective width, and Esc writes the stored value back, or removes the variable when there was none. Cancelling cancels the pending rAF, and the `lostpointercapture` that follows does nothing. Tested with an untouched pane: nothing is stored afterwards.
4. **Cancellation is owned and always cleaned up.**
   - Esc is captured on the window with `stopImmediatePropagation`, the way row dragging does it, so the document's shortcut handler never clears the selection. The e2e checks that the open thread survives.
   - A window blur cancels the drag, and so does unmounting.
   - `pointercancel` and `lostpointercapture` end the drag.
   - Every way out releases capture, removes the listeners, cancels the rAF and clears `data-resizing`.
5. **ARIA bounds when the window changes but the panes don't.** The handles also observe the grid itself, whose width is the window's. There's an e2e: going from 1440 to 1300 changes the list's `aria-valuemax` while neither pane moves.
6. **The snackbar's inset can re-render the list.** A docked snack that wraps as the list narrows changes `useSnack.inset`, which `ThreadList` reads. That render is legitimate (the dock's height changed) and bounded by line wraps. The zero-render gate runs without a snack. This is noted here rather than gated.
7. **The Electron drag region can't be proven with `elementFromPoint`.** `-webkit-app-region` is applied by the browser process on macOS, and Playwright's synthetic input never reaches it, so a native window-drag check isn't possible in the smoke. The tests assert what can be asserted: the handle's computed `-webkit-app-region` is `no-drag`, and the top of the boundary hit-tests to the handle. The packaged smoke repeats both on `app://`. Moving the window from the title band is unchanged code: the sidebar and the list header keep their `drag-region`.
8. **Mail frames do re-render.** `mail-body.tsx` measures with a `ResizeObserver` and `setHeight`, so the reader's open HTML messages render as their width changes. The perf gate therefore drags with five HTML messages expanded.
9. **Pointermove to the next rAF isn't the paint cost.** The gate records every frame interval across the whole drag instead (the `frameGate` used by the other gates: p95 ≤ 20 ms, no frame over 50 ms, long animation frames reported). It also asserts the pane really followed the pointer.
10. **Defaults are preserved only from the minimum window up.** Below 980 px (web only), the reader keeps its minimum by narrowing the list, then the sidebar. Before this, the reader shrank first. Below the sum of the three minimums, the grid clips, as it already did below 572 px. The no-overflow test now also checks the document, not only the panes.

## Implementation notes (what differs from the plan above)

- **The reader's minimum is the design's.** A first round of screenshots showed Lumen's toolbar (the reply pill) cut off at a 340 px reader. So `layout.readerMin` joins `DesignDefinition`, emitted as `--reader-min`: macOS 348, and Atelier and Lumen 380. Each value is what that design leaves the reader at 980 today, or less, so the default layout at 980 is unchanged in every design (asserted in `panes.test.ts`). macOS needs 348 rather than 340: at 340 its reader overflowed by 2 px, caught by the clamping e2e.
- **The list's minimum is 300 and the sidebar's is 200, everywhere.** Screenshots at both minimums in all three designs (`b-*-minimums.png`) show every row layout keeping its date and the sidebar footer intact.
- **More's placement:** (a), as planned. In the screenshots of (b) (`a-macos-*-variantb-*.png`), More floats alone under a hole.
- **The ui-perf gate failed on the injected regression.** The injection committed the width to `usePanes` on every move, with `ThreadList` subscribed to it. The gate failed with `ThreadList renders 208` against the required 0. With the regression reverted it passes: 0 renders, frame p95 of 16.7 ms on both edges, no long animation frames.

## What the Codex code review changed

`codex exec -s read-only` reviewed `402470a..HEAD` (the prompt from `codex-review.sh`, with `-C` pointed at this worktree). It found nothing in Part A and two things in Part B. Both are fixed, each with a test that fails without its fix.

1. **Medium: the perf gate resized a one-row list, and stopped recording before the commit.** `selectThread()` leaves an exact-subject search active.
   - Now the search is cleared with the conversation still open, and the gate waits for a screen of rows (at least 10) before dragging.
   - Frames are recorded through the release and 300 ms of settling.
   - Without the fix, the row-count assertion fails (`Received: 1`).
2. **Low: another pointer could end the drag.** A second finger's up event committed and ended the first finger's drag.
   - Now only the primary pointer starts a drag, and only that pointer's up, cancel or lost capture ends it.
   - `setPointerCapture` is guarded.
   - The new e2e ("one pointer drives a drag") fires a touch sequence with two pointer ids. It fails without the fix with "the second finger didn't end the drag".

## Found along the way

**The list stopped paging when a new folder's first page arrived while the old list sat at its end.**

- **How it surfaced:** the "scrolling 2,000 threads deep" perf gate failed intermittently. It never failed on the base commit. The extra click on More shifted its timing: the test scrolled the inbox to its end while All Mail's first page was in flight.
- **Cause:** that page has the same length (100) and the same last visible index (99), so `ThreadList`'s pagination effect (deps `[last.index, items.length]`) never ran again. The list stayed at 100 rows until the user scrolled.
- **Fix:** `itemsKey` joins the deps.
- **Test:** the e2e "keeps paging" holds `threads.list` to reproduce it every time. It failed 3 out of 3 runs before the fix and passes after.

## Suite results (this machine, under the user's other load)

- **Passing:**
  - `pnpm typecheck` and `pnpm lint`;
  - `pnpm test`: 2030 + 405 tests;
  - `pnpm test:e2e`: 742, in all three designs;
  - `pnpm test:web`: 29;
  - `pnpm dist:mac` plus the packaged smoke: 41, including the new restart check.
- **`pnpm test:ui-perf`:**
  - The new resize gate passes: frame p95 16.8 ms, no long frames, 0 `ThreadList` and 0 `ThreadRow` renders.
  - Across the full runs, these gates failed once each, all timing gates outside this plan:
    - autocomplete's 5 MB draft (621 ms against 120 ms; plan 18 lists it as timing-sensitive);
    - the design switch: one 383 ms frame, then 16.7 ms on 30 of 30 switches when repeated;
    - the 2 MB draft (60 ms against 50 ms).
  - The 2 MB draft gate fails 3 out of 3 runs on the base commit too, on this machine right now.
