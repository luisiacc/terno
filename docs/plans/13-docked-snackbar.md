# Plan 13: the docked snackbar

- **Status:** planned.
- **Builds on:** `2d28e57` (main with the diagnostics primitives).
- **Request:** "these snackbars that show, lets show them always sticky on the bottom, but placed exactly where the list of threads is, at the bottom, with way less height, and kind of embedded there, the button to undo it should have a progress border denoting how much time left before that disappears, also make that button a bit more nicer and premium".

## 1. What exists

- **sonner** (`<Toaster position="bottom-left">` in `app.tsx`, wrapped by `packages/ui/src/components/sonner.tsx`): a floating card ~64 px tall, over the sidebar and the list, stacking several. 28 files call `toast()`, `toast.success/error/warning/loading`, with `action`, `cancel` (a second button), `description`, `duration` (default 4 s; explicit 2, 3, 8, 10 and 12 s) and `id` (an update in place: the progress toasts of `trackJob`, a scope's result, the auto-categorized notice).
- **The categorization snackbar** (`category-snackbar.tsx`): its own fixed layer bottom-left, 560 px wide, three rows (title + undo, chips 1–3 and 5, the "Sobre:" topic row with term toggles, "Más…" and "Ver"). Its own 10 s lifetime, paused while hovered or focused. Keys 1–5, z and Esc while it's up (`snackbar` key context).
- **Undo:** `lib/actions.ts` keeps one `lastUndo` that z / ⌘Z runs (an action, a filing, a discarded draft, a compose conversion). Toast buttons call the same undo paths (`threads.undo` with each `undoId`, `undoFiled`).
- **Layout:** a fixed three-column grid (232 px · 340–400 px · rest). The desktop window is at least 980 px wide, so the list column is always on screen; the web can be narrower, and the grid then overflows at the right (the list column still shows).

## 2. Design

### Placement

- One dock, inside the list column: absolutely positioned 8 px from its left, right and bottom edges, over the bottom rows. It never covers the sidebar or the reader.
- The list keeps working under it: while the dock shows, the virtualizer gets `paddingEnd` and `scrollPaddingEnd` equal to the dock's measured height plus its gap. The last row scrolls fully above it, and j/k (`scrollToIndex`, align auto) stops above it. When it appears over the selected row, the list scrolls that row into view once.
- **When the list column isn't usable** (the only cases the layout has):
  - A modal dialog (Ajustes, Filtros, Añadir cuenta, first run, print sheet, shortcuts): the dock rises above the dialog's dim (z 60 vs 50), in the same place, so what a dialog reports stays legible and clickable. Its live regions stay exposed: Base UI's `markOthers` keeps `[aria-live]` elements out of `aria-hidden`.
  - The web's blocking screens (`#root` inert, opaque): the dock is under the screen, and its timer waits until the screen goes away (see Timer).
  - The fatal screen: no app, no dock.
  - There is no narrow layout without a list column; a future one would mount the dock in its main pane (the dock takes its container from a prop).

### The surface

- Height 36 px for one line (today's toast is ~64 px). Radius 10 px. `surface-glass` (the theme's `--popover-glass`, blurred, solid with reduced transparency), a hairline ring (`--border`), and at most a 1 px soft shadow plus the top `--highlight`: quiet, like the reader's toolbar, not a floating card.
- Left: an optional tone glyph (success check in `--success-ink`, warning, error in `--destructive-ink`, a spinner while loading), then the message in 13 px, one line, truncated. A `description` follows in muted text on the same line when it fits, else it's in the title attribute and the live text.
- Right: the actions, then a close button (×, 20 px, muted). Esc closes when focus is inside the dock.

### The primary action

- A pill button, 24 px tall: label in 12 px medium, then the shortcut as a quiet keycap (`z`) when z would run that same undo.
- Its border is the countdown: an SVG path traced around the pill from the top centre, clockwise, 1.5 px, `pathLength=100`. A track in `--border`, the progress in `--primary`; the dash drains as the lifetime runs. The path is built from the button's measured size, so it's crisp at @2x and its radius matches the pill's.
- Hover: a `--tint` fill and the label in full foreground; pressed: scale 0.97 (motion-fast). Focus: the 2 px ring outside.
- The countdown is a Web Animation (`element.animate`, linear, `id: "snack-countdown"`), synced to the timer's elapsed time on every pause and resume. Motion off and reduced motion disable CSS animations and transitions, not Web Animations: the ring is information and keeps draining; only decorative easing goes.
- Accessible name: what it undoes ("Deshacer archivar", "Deshacer descartar borrador", "Deshacer añadir a Facturas"). The visible label stays "Deshacer".
- A second action (the auto-categorized notice's "Ver") is a quiet text button before the pill.

### Timer

- A pure countdown (`lib/snack.ts`): duration, pause reasons (`hover`, `focus`, `hidden`, `blocked`), elapsed time while running; injectable clock for tests.
- Paused while the pointer is over the dock, while focus is inside it, while the document is hidden (`visibilitychange`), and while `#root` is inert (web blocking screens; a `MutationObserver` on its `inert` attribute). It resumes with what was left.
- Durations: as today (4 s by default; explicit 2–12 s stay). Two changes: a snack with an action or an error gets 6 s, since a pointer has to reach the bottom of the list and an error message is longer. Loading snacks have no timer (they end when their job reports). The categorization snackbar keeps its 10 s.

### One at a time

- A new snack replaces the current one. Its content slides 4 px up and fades in at `--motion-slow`; the old content goes at once. Showing from nothing fades and lifts the whole dock; dismissing fades it. With motion off, all of that is instant (the ring still drains).
- `id`: a snack with the id of the current one updates it in place (no animation, the timer restarts unless it's loading). `snack.progress(id, message)` updates only while that id is still current, so a job's progress never takes the dock back from a newer snack; its final result (`snack({ id, … })`) does show.
- Clicking an action runs it and closes the snack (as sonner). z (`action.undo`) closes the current snack when the snack's undo is the one z just ran.

### API

`apps/web/src/lib/snack.ts`, with no React in the store:

```ts
snack({ message, description?, action?: { label, onClick, name?, shortcut?: "z" }, secondary?, duration?, tone?: "neutral" | "success" | "warning" | "error" | "loading", id? }): string
snack.success(message, opts?) · snack.error(message, opts?) · snack.warning(message, opts?) · snack.loading(message, opts?)
snack.progress(id, message) · dismissSnack(id?)
snack.custom({ id, message, duration, render }) // the categorization snackbar
```

- `useSnack` (zustand) holds the current snack, its sequence number and the countdown state.
- `apps/web/src/components/snack-dock.tsx`: the dock, the pill with its ring, the live regions.
- Every `toast*` call in the app moves to `snack*`. sonner, `packages/ui/src/components/sonner.tsx` and the sonner CSS overrides in `globals.css` go away (nothing else needs a toast stack).

### The categorization snackbar in the dock

- It becomes a custom snack: two compact rows inside the same surface.
  - Row 1 (36 px): category dot, title, the Deshacer pill with its ring and `z`, ×.
  - Row 2 (32 px): one horizontally scrolling strip, with a fade at the edge that overflows: chips 1 "Todo de …", 2 "@dominio", 3 "Lista", 4 "Sobre:" with its term toggles, "Más…" (the input stays inline), count and "Ver", then 5 "Siempre → filtro". Chips are 24 px, keycap numbers stay; focusing a chip scrolls it into view.
- Keys 1–5, z and Esc keep working (same `snackbar` context, same `snackbarControls`). Its lifetime is the dock's countdown (10 s, paused by the dock's hover and focus), replacing its own timer.
- A failed undo no longer opens a second toast: the snackbar turns into the error in place ("No se pudo deshacer: …", in `--destructive-ink`, announced assertively) and the pill reads "Reintentar". The undo is idempotent, as before.

### Accessibility

- Two always-mounted, visually hidden live regions in the dock: `role="status"` (polite) and `role="alert"` (errors). They get the snack's text (message, description) each time a snack shows; the visible message is `aria-hidden` so it's not read twice. Mounted once, they're there before any content arrives and survive a dialog's `aria-hidden` sweep.
- The dock never takes focus. F6 (new `snackbar.focus`, global) moves focus to its first action while it's up; Esc there closes it and focus returns to where it was. z keeps working without focus. Listed in the shortcuts dialog under Moverse.
- axe clean with the dock up (plain, error, categorization), light and dark; pill text AA on the glass, ring 3:1 on it (the contrast suite gets `primary` on `popover-glass`, every theme).

## 3. What changes

- `lib/snack.ts` (new): store, countdown, API. `components/snack-dock.tsx` (new).
- `app.tsx`: the list column gets `relative` and holds `<SnackDock />`; `<Toaster>` and `<CategorySnackbarHost>` go.
- `thread-list.tsx`: only the virtualizer options (`paddingEnd`, `scrollPaddingEnd`) and the scroll-into-view effect, away from the header (another branch changes the header).
- `category-snackbar.tsx`: rendered through `snack.custom`; compact layout; error-in-place.
- `lib/actions.ts`: `lastUndo` changes go through `setLastUndo`, which bumps a sequence the dock reads for the `z` keycap; undo names per action.
- Every `toast` caller (28 files) → `snack`. `@terno/core` keybindings: `snackbar.focus` (F6).
- E2E helpers: `snack(page, text)` replaces the `[data-sonner-toast]` locators; `stabilize` hides the plain dock.

## 4. Tests

- **Unit** (`lib/snack.test.ts`, fake clock): expiry at the duration; each pause reason holds it and resuming continues with what was left; overlapping reasons; replacement resets; same id updates in place; `progress` doesn't steal the dock; loading never expires; action click closes; z closes only its own snack; elapsed time for the ring.
- **E2E** (`snack.spec.ts`): archive shows the dock inside the list column's bounds (not over sidebar or reader) and ≤ 40 px tall; the ring's dash offset grows over time and holds while hovered; Deshacer restores the row; z restores and closes the snack; a second archive replaces the first (one dock); the last row is reachable by scrolling and by j while it's up; F6 focuses Deshacer and Esc returns focus; the categorization snackbar's 1 and z still work inside the dock; a snack fired with Ajustes open sits above the dim and stays clickable; axe (plain, error, categorization; light and dark).
- Existing specs move from `[data-sonner-toast]` to the dock; `motion.spec` exempts only the `snack-countdown` animation from the 100 ms cap (it's the lifetime, not decoration) and still checks the dock's own fade.
- Visual baselines: `category-snackbar*.png` change deliberately (the ring is masked: its level depends on time).
- Screenshots in `/tmp/unica-scratch/snack-13/`: archive undo, draft discarded, categorization, error, mid-countdown and hovered, light, dark and two other themes.

## 5. Revisions after Codex

Codex read the plan against the code (`/tmp/unica-scratch/plan-13-codex.txt`, 10 points). What changes:

1. **Modals: the dock stays under them.** Raising it to z 60 would put it above the dialog's popup too, with its buttons outside the focus trap and `aria-hidden` (Base UI spares `[aria-live]` elements, not their sibling controls). The dock stays at its own level, under the dialog's dim, and its countdown waits while any dialog is open (pause reason `blocked`, like the web's blocking screens). The live regions carry explicit `aria-live` so they're announced from under the modal; actions become reachable when the dialog closes, with the full lifetime still ahead. The big dialogs (Ajustes, Filtros, print) don't reach the list column's bottom edge at 1440×900, so the dimmed dock stays readable.
2. **One undo token, shared by z and the button.** `lastUndo` was a callback for z and a second callback for the toast; a click left z armed, which restored a discarded draft twice. Now `registerUndo(run)` returns a token (`ready → running → done`, back to `ready` on failure) that both z and the snack's Deshacer run, once. The snack's `z` keycap holds while that token is z's and still ready. A late RPC answer can't take a newer action's keycap; an action undone with z before its answer arrives shows no snack. Expiry or replacement never clears z.
3. **The categorization snackbar keeps its own action states.** Its Deshacer isn't the generic "run and close": it stays (pending, the countdown waits with pause reason `busy`) until the backend answers, then closes with "Deshecho: X", or turns into the error with Reintentar. Every result is guarded by its snack's id: a snackbar replaced meanwhile doesn't overwrite the newer snack. Same for `undoScope` retries. `undoFiled` (by batch) stays the undo.
4. **Replacement rules.** User actions replace. Background snacks (send results, the engine's auto adds, the web's carry-over) and results of jobs whose progress snack was already replaced wait in a short queue (3, newest kept) while the current snack has an action, is custom, is an error, or is hovered or focused; they show when it leaves. Neutral, action-less snacks are simply replaced. Actions close their snack before running, so what an action shows next stays.
5. **List room after layout.** The scroll-into-view check runs after the padded spacer commits, compares the selected row's measured box with the scroller and the dock's inset, and scrolls only when the row is under the dock. Tests check bottom-row coordinates against the dock's top.
6. **Motion off.** The countdown stays, as the request asks, but steps once a second instead of flowing; it's the one animation `motion.spec` exempts by id (`snack-countdown`), from the cap and from the motion-off zero. Expiry is a timer, never the animation's end, so Playwright finishing animations in screenshots can't dismiss anything; baselines mask the ring.
7. **Announcements.** Explicit `aria-live` and `aria-atomic`; each new snack remounts its text (a repeated "Archivado" is announced again); progress updates aren't announced (only a new snack or an error in place is); while `#root` is inert the live text waits and is inserted when the screen goes away. The visible text stays in the accessibility tree.
8. **F6.** Resolves while typing and composing too, not under a dialog or menu. It focuses the primary action, else the close button. Focus goes back only if it was inside content that went away, and only to an element that is still connected and not inert. Local Escape handlers (the "Más…" field) keep precedence.
9. **Long text.** One line is the simple case. A description goes on a second line; errors and warnings wrap to up to three lines. The close button's hit area is 24 px. An explicit `duration` always wins over the 6 s rule.
10. **Performance.** The elapsed time never goes through React per frame (the store changes on pause and resume only); the list subscribes to the inset alone; an e2e checks that rows don't re-render while a snack counts down. The glass is kept but lighter (blur 12 px over a near-opaque `--popover-glass`); `test:ui-perf` is the judge.

## 6. As built

- **Status:** shipped on branch `worktree-agent-ab377dd823943b4bc`.
- **Copy.** New strings are English (AGENTS.md): the pill reads "Undo" / "Retry", and every action has an English accessible name ("Undo archive"). Existing messages keep their Spanish wording until the i18n pass. The `z` keycap is generated content with `aria-keyshortcuts`, so the button's text stays its label (axe `label-content-name-mismatch`).
- **Embedded look.** After the first screenshots the surface became nearly solid (`--popover` at 96%, blur 16 px), because rows ghosted through `--popover-glass` in dark themes. A pane-colored fade behind the dock dissolves the last rows into it, so it reads as part of the list. The gap in the ring sweeps clockwise from the top centre.
- **Under a modal** the dock stays where it is, dimmed, and waits (§5.1). F6 does nothing while it's covered.
- **Visual baselines** finish animations, so the ring is drawn run out. That's deterministic, and nothing is masked.
- **Live text** is said once and leaves the live region after 1.5 s, so browsing finds the visible copy alone.

### After the Codex code review (4 findings, `/tmp/unica-scratch/review-13.out`)

1. **A failed Undo click lost its retry.** `undoActions` swallowed the failure, so the token became `done`. Now a failure propagates: the token is `ready` again, z points back at it unless a newer undo replaced it, and the error snack offers "Retry" running the same token. Unit-tested.
2. **A slow bulk undo's outcome overwrote newer snacks.** `undoScope` and the scope filing's undo now publish their outcomes as background news. An e2e holds `categorize.undo`, archives meanwhile, and checks that "Archivado" stays until it leaves.
3. **A queued result could offer an undo that z had already run.** Dequeuing now drops results whose undo is no longer ready. Unit-tested.
4. **Modals outside `useApp.dialog`** (the first run, a standalone report preview) didn't hold the countdown. The dock now also watches its card's `aria-hidden`, which Base UI's modal sweep sets for any modal, and F6 checks the same mark. An e2e checks that the app's own dialog sets it, and that the mark alone holds the ring and blocks F6.

Each regression test fails without its fix.

Also found while running `test:web`: a background sync error ("Falló: star…") replaced the "… conectada" confirmation 17 ms after it showed. Background news now waits behind any of the user's own snacks, and replaces only other news or a job's progress. Unit-tested; `web.spec` covers it end to end.

### Verification

- `pnpm test`: 1,540 + 390 (db-wasm).
- `pnpm test:e2e` (E2E_PORT=5193): 222, including 13 in `snack.spec.ts`.
- `pnpm test:web`: 26 of 27. `migration-web.spec.ts:176` fails on the `terno-diag` IndexedDB added by the diagnostics feature on main. It isn't touched here.
- `pnpm test:ui-perf`: 16 of 16.
- Screenshots of archive (start, mid-countdown, hovered and paused), draft discarded, error and categorization, in Terno light, Terno dark, Solarized light and Dracula: `/tmp/unica-scratch/snack-13/`.
