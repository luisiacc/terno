# Terno: working agreement for agents

Terno is a minimalist, fast email client: Electron (macOS first) plus a web build with parity, in a pnpm monorepo (`apps/desktop`, `apps/web`, `apps/backend-dev`, `packages/*`). The plans in `docs/plans/` record why things are the way they are. Read the relevant one before changing a feature. [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) has the commands and test suites.

## Principles (every change upholds all five)

1. **Clean architecture.** Always build code cleanly, modularly, and with proper architecture and separation of concerns. Never simply bolt on a feature because it was asked for. If you can't find an easy way to build it naturally, and you'd recommend a refactor to make the whole thing clean, stop your work ahead of time and say so.
2. **UX first.** Every flow should feel obvious and calm. Never lose the user's work or position: drafts autosave, undo is exact, and focus and scroll survive navigation. Errors say what happened and what to do next, in plain English.
3. **Intuitive, premium UI.** Minimal and Apple Mail inspired:
   - hairlines rather than boxes, quiet controls, SF on macOS
   - **alignment is consistent:** things stacked in one column look aligned. A new element follows its neighbours' margins and content line, never its own. Judge alignment in the resting state, not only on hover: a hover or selection shape may sit wider than a filled box if that keeps text and icons on one line. Look at a new or moved element beside its neighbours in a screenshot
   - motion within the `--motion` cap (≤ 100 ms), and none when motion is reduced or off
   - every control keyboard-reachable and named for screen readers (axe-clean in light and dark, AA contrast in all themes)
   - focus rings only while the user moves with Tab (plan 54): never after a click, a shortcut or a programmatic focus, and never around a whole list or pane (plan 52). Use `focus-visible:` utilities, which are gated on this; text fields keep their rings. A control revealed by focus (`opacity-0` until focused) uses `focus-reveal:`, which is not gated.

   **English is the source language** for all copy. UI strings go through the i18n catalog (`t()` in the UI and main, `L()` in the backend): every new or changed string updates `en` and `es` together, and the type check fails if a locale is missing a key.
4. **Performance.** Every feature is designed for speed from the start, not tuned afterwards.
   - No regressions against the perf gates (`pnpm test:perf`, `pnpm test:ui-perf`, `load.perf.test.ts`).
   - Lists are virtualized, and render counts are asserted.
   - Nothing blocks the backend event loop beyond the slicer's budget. Queries hold at 50k+ threads in both stores: SQLite in `packages/db`, IndexedDB in `packages/idb`.
   - **No lazy loading, ever.** Everything is a plain `import`: no `React.lazy`, no dynamic `import()` or `require()` of app code, no `Suspense` for code, no preloads, no chunk splitting (`architecture.test.ts`; only web-only code behind `VITE_TARGET` loads on demand).
   - An update never makes the user wait: a SQLite migration changes shape only (≤ 1 s at 50k threads, `migrations.perf.test.ts`), and data work goes to the backend's background slices (plan 112).
5. **Low resource usage.** No polling where an event exists, and no work until a feature is opened. Memory, disk and logs are bounded. Idle means idle: no timers spinning, and no network outside what the user's mail and explicit choices need.

## Non-negotiables

- **Privacy.** Mail content, addresses, names, subjects, tokens and keys never leave the machine except to the user's own mail servers and the AI provider they chose (plan 97). Everything else that uses the internet does so by its own setting or the user's explicit choice: updates (plan 11), website icons (22), remote mail content (37), cloud AI, error reports with consent (78), unsubscribe on click (96); diagnostics follow plan 10. The desktop renderer reaches nothing beyond loopback and approved mail images. The old `localMode` setting decides nothing and is never shown.
- **Never** read or print the user's real secrets, and never touch real profiles (`~/Library/Application Support/Terno*`): use temp profiles and copies.
- **Process safety.** Only kill processes you started, by the PID you captured. Ports 5173/5174 and other vite/node processes may belong to the user. Unset `ELECTRON_RUN_AS_NODE` when launching Electron.

## How a feature is built

1. **Plan.** Write `docs/plans/NN-<name>.md`: the request verbatim, what exists, design, tests, perf and out of scope. If the feature doesn't fit the code cleanly, the plan says what refactor it needs, and you stop and ask before building it.
2. **Codex critique of the plan.** Run `codex exec -s read-only -C <checkout> - < prompt` and ask for at most 12 concrete points against the code. Append "Revisions after the Codex review".
3. **Implement** in atomic commits, with tests for every behavior (see Testing). Visually verify UI changes: screenshots in light and dark, and look at them.
4. **Codex code review, for every feature and fix series.** Run `/tmp/terno-scratch/codex-review.sh <base> <name> <plan> <out>`, or the same prompt with `-C <worktree>`. Fix every finding with a regression test that fails without the fix, and record what the review changed in the plan.
5. **Run the tests the change touches** (see Testing) and report failures honestly.
6. **Rate the UI (plan 158)** when a series changes how a main screen looks or behaves: `pnpm ui:rate`, then `pnpm ui:gate`. Every score, on every rated screen, in every rated style, from both Claude and Codex, is at least 9 out of 10. [`docs/ui-rating.md`](docs/ui-rating.md) has the screens and facets; raters run in a clean room and never hear the bar, an earlier score or what changed.

## Testing

A behaviour is tested once, at the lowest level that can catch its failure: unit tests, e2e (`apps/web/e2e`), the packaged smoke for desktop-only paths, and a perf gate for anything on a hot path.

**Run what the change touches, not the whole suite.** Typecheck and lint, plus:
- the unit test files for the modules you changed, named directly (`pnpm exec vitest run --project unit <files>`). Avoid `vitest related` on shared modules: from `packages/core` it reaches all 700 files.
- the e2e specs for the flows you changed (`pnpm --filter @terno/web exec playwright test <spec>`), in the designs that can change their result
- the perf gate covering a hot path you touched, with the machine to itself
- `pnpm test:smoke` after `pnpm dist:mac` for a desktop-only path

**`pnpm test:all`** (every gate, about 12 minutes, plan 139) is for changes that reach the whole database: a migration or schema change, the store contract and its conformance suite (`packages/store`), or shared query and storage code in `packages/db` or `packages/idb`. The shared checkout is busy, so before believing a failure there, check `git log` and the machine's load. What failed only on the crowded first pass is named as flaky: look at it.

- A test repeats across a design, a store engine or a mode only if that can change its result.
- A wall-clock assertion goes in a perf gate, never a unit or e2e test.
- Merge e2e tests that can share a page (`scenario()` in `e2e/fixtures.ts`) rather than paying for another backend and load.
- A 50k mailbox is built once and copied (`packages/db/src/test/perf-mailbox.ts`), unless the gate holds the connection that wrote it.
- Parallel checkouts: run e2e with `E2E_PORT=<free port>` and `pnpm test:web` with `WEB_PORT=<free port>` (it also takes the next one), so two checkouts never share a server.

## Designs (styles)

A design (plan 15) is typography, shape, density and a closed set of structural variants; colors stay in palettes (`packages/ui/src/themes/registry.ts`). How to change or add one, and which flows run in which design, is in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) → Styles.

- **Rules:** no colors or durations in a design (token references only); text only on pairs in `CONTRAST_PAIRS`; sizes, families and radii only from the scale, the ladder and the type roles (`source-scan.test.ts`).
- **Base controls** follow [BoardUI](https://www.boardui.com/)'s free components, ported onto Base UI in our tokens. [`packages/ui/BOARDUI.md`](packages/ui/BOARDUI.md) maps each to its Terno file, says how to port one and lists the deliberate deviations; keep it current. **Never hand-build a control in that catalog** (a close ×, a spinner, a radio, a chip, a banner, a link button, a disclosure, a pager …): use the component, or port it first. Look on [boardui.com/components](https://www.boardui.com/components/), never the GitHub repo, and never use a **Pro** component.
- **Icons:** only from `@terno/ui/icons` (Hugeicons, free core set); never import an icon package or paste an SVG. A new icon is one line in `packages/ui/src/iconset/catalog.ts` plus `pnpm --filter @terno/ui gen:icons`. One line weight at every size: set it with the design's `icon.stroke` or `--icon-line` on the svg, never `stroke-[…]` or `strokeWidth`. An icon beside a label is `1.15em` and muted until hover, open or active; icon-only buttons keep the 16 px glyph.

## Conventions

- Match the surrounding code's idiom, naming and comment density (terse comments that explain why).
- Commit only; never push unless asked.
- Product rules: dragging threads onto a category *moves* them (multi-category only through the right-click menu); composing is inline, never a modal; HTML mail frames never scroll inside.
- **Education tips** (plan 113): teach at the moment it matters with the shared base, never a one-off popover: an id in `TIPS` (`apps/web/src/lib/tips.ts`), `offerTip(id, target)` where the moment happens, and a component on `Tip` with a picture from `tip-picture.tsx` (`components/category-inbox-tip.tsx` is the example). A title and one or two lines; e2e opts in with `test.use({ tips: true })`.
