# Terno: working agreement for agents

Terno is a minimalist, fast email client: Electron (macOS first) plus a web build with parity, in a pnpm monorepo (`apps/desktop`, `apps/web`, `apps/backend-dev`, `packages/*`). The plans in `docs/plans/` record why things are the way they are. Read the relevant one before changing a feature.

## Principles (every change upholds all four)

1. **UX first.** Every flow should feel obvious and calm. Never lose the user's work or position: drafts autosave, undo is exact, and focus and scroll survive navigation. Errors say what happened and what to do next, in plain English.
2. **Intuitive, premium UI.** Minimal, Apple Mail and t3code inspired:
   - hairlines rather than boxes, quiet controls, SF on macOS
   - **alignment is consistent:** things stacked in one column should look aligned. A new element follows its neighbours' margins and content line, never its own. Judge alignment in the resting state, not only on hover: a hover or selection shape may sit wider than a filled box if that keeps the text and icons on one line. Before adding or moving an element, look at it beside its neighbours in a screenshot
   - motion within the `--motion` cap (≤ 100 ms), and none when motion is reduced or off
   - every control keyboard-reachable and named for screen readers (axe-clean in light and dark, AA contrast in all themes)
   - focus rings only while the user moves with Tab (plan 54): never after a click, a shortcut or a programmatic focus, and never around a whole list or pane (plan 52). Style focus with `focus-visible:` utilities, which are gated on this; text fields keep their rings. A control revealed by focus (`opacity-0` until focused) uses `focus-reveal:` instead, which is not gated.

   **English is the source language** for all copy (UI, errors, notifications, docs). UI strings go through the i18n catalog: English is the default, and Spanish (`es`) ships alongside it. Every new or changed string updates `en` and `es` together, and the type check fails if a locale is missing a key.
3. **Performance.**
   - No regressions against the perf gates (`pnpm test:perf`, `pnpm test:ui-perf`, `load.perf.test.ts`).
   - Lists are virtualized, and render counts are asserted.
   - Nothing blocks the backend event loop beyond the slicer's budget. Queries must hold at 50k+ threads in both stores: SQLite in `packages/db`, IndexedDB in `packages/idb`.
   - **No lazy loading, ever.** This is a desktop app: its code is already on disk. Everything is a plain `import`: no `React.lazy`, no dynamic `import()` or `require()` of app code, no `Suspense` for code, no preloads and no chunk splitting. A first click is as fast as a second (`architecture.test.ts` holds this; only web-only code behind `VITE_TARGET` loads on demand, and the desktop build never holds it).
   - An update never makes the user wait: a SQLite migration changes shape only (≤ 1 s at 50k threads, `migrations.perf.test.ts`), and any data work goes to the backend's background slices (plan 112).
4. **Low resource usage.**
   - No polling where an event exists, and no work until a feature is opened.
   - Memory, disk and log files are bounded.
   - Idle means idle: no timers spinning, and no network outside what the user's mail and explicit choices need.

## Non-negotiables

- **Privacy.** Mail content, addresses, names, subjects, tokens and keys never leave the machine except to the user's own mail servers and the AI provider they chose. Terno keeps its copy of the mail on this machine and has no server of its own that stores it (plan 97). The old `localMode` setting decides nothing and is never shown: no switch, row or pill. Everything else may use the internet, each by its own setting or explicit choice:
  - updates (plan 11)
  - website icons (plan 22)
  - remote mail content, loaded per message or with the setting (plan 37)
  - cloud AI, the provider the user picks
  - error reports, with consent (plan 78)
  - unsubscribe, on the user's click (plan 96)

  Diagnostics follow plan 10. The desktop renderer itself reaches nothing beyond loopback and approved mail images (main's fence).
- **Never** read or print the user's real secrets, and never touch real profiles (`~/Library/Application Support/Terno*`): use temp profiles and copies.
- **Process safety.** Only kill processes you started, by the PID you captured. Ports 5173/5174 and other vite/node processes may belong to the user. Unset `ELECTRON_RUN_AS_NODE` when launching Electron.

## How a feature is built

1. **Plan.** Write `docs/plans/NN-<name>.md`: the request verbatim, what exists, design, tests, perf and out of scope.
2. **Codex critique of the plan.** Run `codex exec -s read-only -C <checkout> - < prompt` and ask for at most 12 concrete points against the code. Append "Revisions after the Codex review".
3. **Implement** in atomic commits, with tests for every behavior:
   - unit tests and e2e (`apps/web/e2e`)
   - the packaged smoke for desktop-only paths
   - perf gates for anything on a hot path

   Visually verify UI changes: take screenshots in light and dark and look at them.
4. **Codex code review: always, for every feature and fix series.** Run `/tmp/terno-scratch/codex-review.sh <base> <name> <plan> <out>`, or the same prompt with `-C <worktree>`. **Fix every finding** with a regression test that fails without the fix. Record what the review changed in the plan.
5. **Before calling it done,** `pnpm test:all` passes: every gate (plan 139). What failed only on the crowded first pass is named as flaky: look at it. While working, run only the tests you touched plus typecheck and lint. Report failures honestly.
6. **Rate the UI (plan 158).** A series that changes how a main screen looks or behaves re-rates the styles it touches: `pnpm ui:rate`, then `pnpm ui:gate`. **Every score, on every rated screen, in every rated style, from both Claude and Codex, is at least 9 out of 10.** [`docs/ui-rating.md`](docs/ui-rating.md) has the screens, the facets (UI and UX) and how raters stay independent: they run in a clean room, and never hear the bar, an earlier score or what changed.
7. **Watch the test time.** `pnpm test:all` reports how long it took, about 12 minutes after plan 139; keep an eye on it, but it isn't a limit. A behaviour is tested once, at the lowest level that can catch its failure. A test repeats across a design, a store engine or a mode only if that can change its result. A wall-clock assertion goes in a perf gate, never a unit or e2e test: those run on a full machine. Merge tests that can share a page (`scenario()` in `e2e/fixtures.ts`) rather than paying for another backend and load. Reads hold at 50k+ in both stores; a mailbox is built once and copied (`packages/db/src/test/perf-mailbox.ts`), unless what the gate holds is the connection that wrote it.

## Designs (styles)

A design (plan 15) is typography, shape, density and a closed set of structural variants; colors stay in palettes (`packages/ui/src/themes/registry.ts`).

- **Change a design:** edit its file (`packages/ui/src/designs/lumen.ts` …), run `pnpm --filter @terno/ui gen:designs`, update that design's baselines only (`pnpm --filter @terno/web exec playwright test --project=e2e-lumen --update-snapshots`), and look at them in light and dark.
- **Add a design:** add its id to `DESIGN_IDS` (`packages/core/src/themes.ts`) and `theme.js`'s list, copy the closest definition (its type forces every value and variant), give it a palette pair (new palettes go in the registry and must pass the contrast suite), add its `en`/`es` name and description (`design.<id>`, `design.<id>.description`), add it to `DESIGNS` and a Playwright project (with its line in `FLOWS`).
- **Add a variant value:** add it to the union in `designs/types.ts`; the compiler then points at every `variant(…)` map that must implement it. Keep roles, names, test ids and shortcuts identical across values (`designs.spec.ts` checks the shared parts in every design).
- **Base controls** (plans 118 to 122, 125): the shared components in `packages/ui/src/components/` follow [BoardUI](https://www.boardui.com/)'s components (MIT). **[`packages/ui/BOARDUI.md`](packages/ui/BOARDUI.md) maps every BoardUI Base component to its Terno file** (or "port on first use") and lists the deliberate deviations; keep it current. **Never hand-build a control that is in that catalog** (a close ×, a spinner, a radio, a chip, a banner, a link button, a disclosure, a pager …): use the component, or port it first. A port follows the component page's parts, variants and states exactly, in our tokens; a deviation is written down there with its reason. **Before writing a new base component that could be shared** (or adding one with the shadcn CLI), look in BoardUI first and port its version when there is one, translated to our tokens (plans 120 and 122 are examples). **Always look in [boardui.com/components](https://www.boardui.com/components/), never the GitHub repo** (its export lags the site: the Time Field was missing from it). Each component's page, `/components/<name>`, shows its look, states and behavior; its source is `https://www.boardui.com/r/<name>.json`. Use only components without a **Pro** mark (Pro is paid and not licensed to us). BoardUI is built on React Aria; port its look onto Base UI's primitive when Base UI has one, and use React Aria's only for a part Base UI lacks (the Time Field):
  - filled fields (`bg-field`, the border only on hover, focus and error); the secondary as a 1 px border on `card` over `shadow-xs`; the primary lit from the top, between `primary-hover` and `primary`
  - floating panels solid on `popover` with `shadow-menu`, menu rows highlighted in `muted` (`[--accent:var(--muted)]`)
  - a choice of a few (a segmented control) is `ToggleGroup variant="segmented"`: a track with a thumb, never separate outlined buttons
  - corners concentric with what they hold: a panel of rows is `rounded-menu` at `p-1.5` (`rounded-palette` for command lists); anything else is the inner radius plus the gap
  - Terno's control heights, not BoardUI's. Check it in every design, light and dark (`e2e/controls.spec.ts`, `e2e/menu-corners.spec.ts`).
- **Rules:** no colors or durations in a design (token references only); text only on pairs in `CONTRAST_PAIRS`; sizes, families and radii only from the scale, the ladder and the type roles (`source-scan.test.ts`); motion within `--motion`.
- **What runs where** (plan 139; `e2e/designs.spec.ts` holds the same): `e2e` runs every flow once, in macOS. A flow repeats in another design only if that design can change its result:
  - **`@design`, all five designs:** what type, shape, density or a palette can change. `designs.spec`'s first part, the baselines, icon and corner checks, the List round trip.
  - **`@variant`, Lumen and Atelier:** a flow that goes through a structural variant macOS doesn't hold (search behind a button, chips, the sender card, the reply pill, a sidebar compose, a display or greeting header, avatar rows, the inline badge, pill tabs), and the axe sweep (`e2e/design-axe.spec.ts`: a new surface is a line there, not a tag on its flow) and motion, which change only with a structure: `contrast.test.ts` holds colors in every palette, and a design has no durations. **`@variant-graphite`** also runs in Graphite, for its compose row. Luma adds no value, so it has no flow of its own.
  - **No tag** for everything else, which reads the same in every design; a flow about one design says `test.use({ design })`. A design holding a new variant value adds a `@variant` flow and its project's line in `FLOWS` (`playwright.config.ts`).
- **Icons:** only from `@terno/ui/icons` (Hugeicons, free core set); never import an icon package or paste an SVG icon into a component. A new icon is one line in `packages/ui/src/iconset/catalog.ts` plus `pnpm --filter @terno/ui gen:icons` (one module per icon, so only those in use are bundled), picked by eye at 16 px next to its neighbours.
  - **One line weight at every size,** as SF Symbols keep theirs: the stroke is non-scaling, so a 12 px glyph draws the same 1 px line as a 28 px one. A design sets it with `icon.stroke` (1.5 = 1 px); a surface tunes it with `--icon-line` on the svg (the toolbars use `--icon-line-toolbar`), never with `stroke-[…]` or a `strokeWidth` prop.
  - **Sized to the text beside it:** an icon next to a label is `1.15em` (menus, the palette, buttons with text); icon-only buttons keep the 16 px glyph. Don't hard-code a pixel size where the icon sits beside text.
  - **Quiet:** an icon beside a label is muted and reaches full contrast only on hover, open or active; filled buttons keep icon and label one color.

## Conventions

- Read the surrounding code first and match its idiom, naming and comment density (terse comments that explain why).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Commit only; never push unless asked.
- Product rules worth knowing:
  - Dragging threads onto a category *moves* them; multi-category only through the right-click menu.
  - Composing is inline, never a modal.
  - HTML mail frames never scroll inside.
- **Education tips** (plan 113): to teach something at the moment it matters, build on the shared base, never a one-off popover. Add an id to `TIPS` (`apps/web/src/lib/tips.ts`), call `offerTip(id, target)` where the moment happens, and write a component on `Tip` (`components/tip.tsx`: shown once, waits for a clear stage, never takes focus, Escape and a click away close it) with a picture from `tip-picture.tsx` (the app's rows, menus and gestures in miniature, showing the exact gesture). `components/category-inbox-tip.tsx` is the example. Keep the words to a title and one or two lines; e2e opts in with `test.use({ tips: true })`.
- **Strings:** `t()` in the UI and main, `L()` in the backend; a new language is `packages/i18n/src/locales/xx.ts` plus one line in `locales/index.ts` (README → Adding a language).
- **Parallel checkouts.** Run e2e with `E2E_PORT=<free port>` (it builds to `dist-e2e-<port>`) and `pnpm test:web` with `WEB_PORT=<free port>` (it also takes the next one) so two checkouts never share a server. On macOS there is no `timeout`. In zsh, quote globs.
