# Plan 01: themes, motion, drag-to-category

Status: implemented (see "Implementation notes" at the end) · Scope: `packages/core`, `packages/ui`, `packages/backend`, `apps/web`, `apps/desktop` · Supersedes PLAN.md §9 "Motion 120–180 ms".

## 1. Goals

1. Drag one or many rows from the virtualized list onto a sidebar category. The interaction is fast and animated (ghost, target highlight, fly-in, row flash, count bump), can be undone, and has a keyboard equivalent.
2. Motion is quick and user-controlled. The setting is `0 | 50 | 75 | 100` ms (default 75). No animation runs longer than 100 ms. `0` and `prefers-reduced-motion` turn off every animation. j/k navigation never animates.
3. The whole app is themeable. Mode is `system | light | dark`, and each mode has its own named theme. A theme is a typed token map, users can import their own themes as JSON, and every theme passes WCAG AA in a test.

## 2. Decisions

| Topic | Decision | Rejected alternatives (why) |
|---|---|---|
| DnD engine | **Our own pointer-events controller, about 200 LOC, no dependency** (`lib/drag.ts`). One delegated `pointerdown` on the listbox and pointer capture on it (it stays mounted while rows virtualize away). The payload is ids, not DOM elements. Category rects are cached at drag start for hit-testing. The ghost moves imperatively in rAF. | **Native HTML5:** the ghost is a static bitmap, macOS plays its own ~300 ms slide-back on cancel, and `dragend` is unreliable when the source unmounts. **pragmatic-dnd:** native underneath (same limits), plus an effect per row mount. **@dnd-kit:** context updates re-render every draggable row (breaks the 2-row invariant), its spatial keyboard sensor is the wrong model, and it adds ~30 kB. |
| Keyboard alternative | The existing `l` picker plus palette commands "Añadir a «X»". Picker and drop share one `addToCategory()` with the same toast, undo, and suggestions. | Keyboard drag mode (slow and unfamiliar for an assign action). |
| Motion plumbing | One CSS variable `--motion` plus derived `--motion-fast/base/slow`, wired into Tailwind's `--default-transition-duration` and the keys `--transition-duration-{fast,base,slow}`. Tailwind v4 `duration-*` resolves those keys and sets `--tw-duration`, which tw-animate-css reads. Off = `html[data-motion=off]` → `animation/transition: none`. | JS durations per component. framer-motion (bundle size; shadcn would still need CSS). The 0.01 ms hack (loops keep running). |
| Theme storage | **The typed TS registry in `packages/ui/src/themes` is the source of truth.** A generator writes a checked-in `themes.generated.css` (one `[data-theme="id"]` block per theme), with a drift test. Custom themes go through CSSOM `setProperty`, never CSS string concatenation. | A runtime `<style>` for built-ins (boot cost, not available pre-paint). A Vite virtual module (not greppable). |
| Theme selector | `html.dark` (mode, kept for shadcn `dark:` variants) + `data-theme` + `color-scheme`. Selectors are `[data-theme=…]`, not `:root[…]`, so preview cards can nest a theme. | Theme as a class name (collides with utilities). |
| Category & avatar colors | Each theme redefines all 8 `--cat-*` values. Badge and avatar text uses `--cat-*-ink = color-mix(in oklch, cat 60%, var(--ink-anchor))`, which passes 4.5:1 in every theme (verified). | 8 extra hand-tuned tokens × 13 themes. |
| HTML mail | `htmlMailAppearance: "auto" | "paper"`. In auto mode, mail without its own colors gets the theme's bg/fg/link. Mail that sets colors renders on a light `--mail-paper` card, so designed mail is never inverted. | Always white (jarring in dark themes). CSS inversion (breaks logos). |
| Electron chrome | IPC `unica:appearance` sets `nativeTheme.themeSource`, vibrancy on/off and the window bg hex, persisted in `userData/appearance.json` for the next window. | Leave main theme-agnostic (today the vibrancy is light when the app is dark on a light OS). |

## 3. Settings and data model

`packages/core/src/rpc/contract.ts` `AppSettings` (and the `settings.update` zod schema):

```ts
theme: "system" | "light" | "dark";        // unchanged name = MODE (no migration)
lightTheme: string;                        // default "unica-light"
darkTheme: string;                         // default "unica-dark"
motionMs: 0 | 50 | 75 | 100;               // default 75; zod: z.union of literals
htmlMailAppearance: "auto" | "paper";      // default "auto"
customThemes: CustomTheme[];               // default [], max 20, ≤16 KB total
```

`CustomTheme` lives in `packages/core/src/themes.ts` next to `THEME_TOKENS` (a readonly token-name tuple shared with ui):
`{ id: /^[a-z0-9-]{1,40}$/, name ≤40, mode, extends: BuiltinId, tokens: Partial<Record<Token, Color>> }`. `Color` is a strict regex for `#rgb[a]`, `#rrggbb[aa]` or `oklch(L C H [/ a])` with numbers only, so `;`, `{`, `url(` and `var(` are rejected.

Migration:
- **DB:** none needed. `readSettings` already spreads `DEFAULT_SETTINGS` over the stored blob, so the new fields take their defaults.
- **Unknown or deleted theme ids:** the renderer's `resolveTheme()` falls back to the mode default.
- **localStorage:** `unica:theme` becomes `unica:appearance = {mode, light, dark, motion, vibrancy, custom?: tokens}`. theme.js converts the old key once.

## 4. File-by-file changes

**packages/core**
- `src/themes.ts` (new): `THEME_TOKENS`, `CustomTheme` zod schema, `BUILTIN_THEME_IDS`.
- `rpc/contract.ts`: the fields above.

**packages/ui**
- `src/themes/color.ts` (new): oklch↔sRGB, gamut clip, alpha compositing, `contrast()`, `toHex()`.
- `src/themes/registry.ts` (new): `defineTheme()` and the 13 themes from §5, plus `derive()` for the derived tokens.
- `src/themes/generate.ts` and the script `gen:themes` → `src/styles/themes.generated.css`.
- `src/themes/apply.ts`: `motionVars(ms)` and `applyCustomTheme(sheet, theme)` (CSSOM).
- `styles/globals.css`:
  - import the generated CSS and drop the hand-written `:root`/`.dark` values (`:root` keeps the unica-light fallback)
  - `--font-sans: var(--theme-font, "Geist Variable", …)`
  - `--color-overlay`, `--color-cat-*-ink`, `--color-drop-target: color-mix(in oklch, var(--primary) 16%, transparent)`
  - shadow overrides `--shadow-{sm,md,lg,2xl}` using `var(--shadow-color)`
  - motion keys and `--default-transition-duration: var(--motion-fast)`
  - the `[data-motion=off]` rule
  - vibrancy rule `:root[data-vibrancy] { --sidebar: var(--sidebar-translucent) }`, which replaces the `.is-mac` literals
  - `::selection` from primary
  - sonner override: `[data-sonner-toaster] [data-sonner-toast][data-sonner-toast]{transition-duration:var(--motion-slow)}`
  - keyframes `drop-flash`, `dot-pop`, `count-bump`
  - a base-layer fallback `[class*="animate-in"],[class*="animate-out"]{--tw-duration:var(--motion-base)}`
- `components/dialog.tsx`, `alert-dialog.tsx`: `bg-black/10` → `bg-overlay`, and `duration-100` → `duration-slow` (content) / `duration-base` (backdrop).
- `popover`, `select`, `dropdown-menu`, `context-menu`: → `duration-base`. `tooltip` → `duration-fast`.
- All components: `ring-ring/50` → `ring-ring` (the theme's ring alpha now carries the AA guarantee).
- `category-dot.tsx`: SOFT text uses `text-cat-*-ink`.
- `sonner.tsx`: accepts the resolved `"light" | "dark"`.

**packages/backend**
- `settings.ts`: new defaults.
- `updateSettings`: validates that `lightTheme`/`darkTheme` are built-in ids or existing `custom:` ids with a matching mode.

**apps/desktop**
- `preload.ts`: `setAppearance({themeSource, background, vibrancy})`.
- `main.ts`:
  - validated `ipcMain.on("unica:appearance")` → `nativeTheme.themeSource`, `win.setVibrancy`, `win.setBackgroundColor`, and a debounced write of `appearance.json`
  - `createWindow` reads that file for its initial `backgroundColor`/`vibrancy`.

**apps/web**
- `public/theme.js`: resolves mode, theme, motion and vibrancy, then sets `class`, `data-theme`, `data-motion`, `data-vibrancy`, `--motion` and `color-scheme`, and applies cached custom tokens through `style.setProperty`.
- `lib/appearance.ts` (new, replaces `applyTheme` in `boot.ts`). `applyAppearance(settings)`:
  - is optimistic (applies before the RPC returns)
  - suppresses transitions for one frame (`data-theme-switching`)
  - caches to localStorage, sends desktop IPC, and listens to `prefers-color-scheme` and `prefers-reduced-motion`.
- `app.tsx`: Toaster gets the resolved mode; `<DragGhost/>` is mounted.
- `components/settings-dialog.tsx`: new "Apariencia" tab (§9). `state/app.ts`: `SettingsTab` gains `"appearance"`.
- `components/mail-body.tsx`:
  - iframe colors come from the computed `--mail-*` and theme tokens (passed as literals into `srcdoc`), and the memo is keyed by theme id
  - drops the `bg-white` class
  - `TextBody` `text-foreground/90` → `text-foreground`.
- `components/sidebar.tsx`: `NavItem` gets `data-drop-target`, `data-drop-state` and a `.count` slot. `text-sidebar-foreground/50|55|60|85` → `text-muted-foreground` / `text-sidebar-foreground` (alpha text can't be contrast-tested).
- `components/thread-row.tsx`: `text-foreground/75|80` → `text-foreground` (weight already marks unread); `data-checked`; `data-cat-dot={id}` on dots; render probe.
- `components/thread-list.tsx`: installs the drag controller on the listbox; adds a `data-reflow` window for removals.
- `components/drag-ghost.tsx` (new), `state/drag.ts` (new zustand store: `{phase, ids, overTarget, overState}`).
- `lib/drag.ts` (new controller), `lib/flash.ts` (an injected `<style>` keyed by `data-thread-id`, so it survives virtualization with zero React renders).
- `lib/actions.ts`: `addToCategory(categoryId, ids, {move?})` adds only non-members, patches counts optimistically, shows the undo toast and runs single-thread suggestions. The picker uses it too.
- `components/command-palette.tsx`: "Añadir a «X»" commands.
- `lib/render-probe.ts`: `window.__renders[name]++` when `import.meta.env.VITE_RENDER_PROBE`, compiled out otherwise.

## 5. Theme tokens (oklch "L C H")

Each theme declares the tokens below. Values marked AA-adjusted were nudged in lightness only (hue and chroma kept) until the contrast test passed. The source hex comes from each palette's official spec.

**Derived by `derive()` unless overridden:**
- copies of fg: `card-fg`, `popover-fg`, `secondary-fg`, `sidebar-fg`, `sidebar-accent-fg`
- `secondary` = `muted`
- `sidebar-primary(-fg)` = `primary(-fg)`; `sidebar-border` = `border`
- `row-rail` = `primary`
- `ring` / `sidebar-ring` = `primary` at the lowest alpha ≥ .55 that gives 3:1 on bg (light .75, dark .6)
- `chart-1..5` = primary, cat-emerald, cat-amber, cat-rose, cat-slate
- light mode: `overlay` 0 0 0/10%, `shadow-color` 0 0 0/10%, `ink-anchor` .2 .01 265, `mail-paper` = bg
- dark mode: `overlay` 0 0 0/45%, `shadow-color` 0 0 0/40%, `ink-anchor` .98 0 0, `mail-paper` .97 .003 85
- `mail-ink` .24 .01 265, `mail-link` .5 .18 265
- `sidebar-translucent` = sidebar at alpha .72 (light) / .62 (dark).

**Vibrancy** is on for `unica-*` and `apple-light` and off for every other theme (named palettes must render exactly). `apple-light` also sets `--theme-font: -apple-system, BlinkMacSystemFont, system-ui`.

Cat order in the tables: rose, amber, lime, emerald, cyan, indigo, violet, slate.

```
unica-light "Única claro" (AA-adjusted: success .6→.54, star .78→.665, cats amber/lime/emerald/cyan to ≥3:1)
  bg .99 .002 85; fg .22 .01 265; pane .99 .002 85; card 1 0 0; popover 1 0 0; sidebar .965 .004 85
  muted .955 .004 85; muted-fg .5 .012 265; accent .945 .012 268; accent-fg .3 .06 268; border .91 .004 85; input .89 .005 85
  primary .56 .19 268; primary-fg .99 .004 268; destructive .58 .21 25; success .54 .13 160; unread .56 .19 268; star .665 .16 80
  row-hover .965 .004 85; row-selected .94 .03 268; row-selected-fg .22 .04 268; sidebar-accent .91 .008 85
  cats .675 .12 10 | .665 .12 75 | .65 .12 130 | .645 .12 165 | .65 .1 215 | .62 .13 268 | .64 .13 300 | .62 .02 265
apple-light "Apple" (system palette; AA-adjusted blue, red, green, secondary label)
  bg 1 0 0; fg .232 .004 286; pane 1 0 0; card 1 0 0; popover 1 0 0; sidebar .943 0 0
  muted .963 .007 286; muted-fg .49 .008 286; accent .932 .007 286; accent-fg .232 .004 286; border .916 0 0; input .862 .007 286
  primary .573 .218 257; primary-fg 1 0 0; destructive .594 .232 29; success .54 .194 147; unread .603 .218 257; star .68 .175 63
  row-hover .971 .003 286; row-selected .927 .031 259; row-selected-fg .232 .004 286; sidebar-accent .894 0 0
  cats .65 .238 18 | .68 .175 63 | .665 .177 90 | .645 .194 147 | .662 .133 234 | .529 .191 278 | .615 .213 312 | .648 .007 286
solarized-light "Solarized Light" (fg = base02, muted-fg = base01 darkened; base00 fails AA)
  bg .974 .026 90; fg .309 .052 220; pane .974 .026 90; card .974 .026 90; popover .991 .014 93; sidebar .931 .026 92
  muted .931 .026 92; muted-fg .493 .029 222; accent .931 .026 92; accent-fg .309 .052 220; border .897 .029 92; input .863 .031 92
  primary .545 .139 245; primary-fg .974 .026 90; destructive .571 .206 27; success .539 .151 119; unread .615 .139 245; star .649 .134 86
  row-hover .95 .026 90; row-selected .931 .026 92; row-selected-fg .309 .052 220; sidebar-accent .897 .029 92
  cats .592 .202 356 | .581 .173 40 | .649 .134 86 | .639 .151 119 | .634 .102 187 | .615 .139 245 | .582 .126 279 | .648 .016 197
gruvbox-light "Gruvbox Light"
  bg .956 .055 96; fg .344 .007 49; pane .956 .055 96; card .965 .039 101; popover .965 .039 101; sidebar .922 .055 93
  muted .894 .057 89; muted-fg .49 .023 63; accent .894 .057 89; accent-fg .344 .007 49; border .894 .057 89; input .825 .051 85
  primary .471 .082 216; primary-fg .956 .055 96; destructive .437 .179 28; success .531 .112 106; unread .471 .082 216; star .618 .128 71
  row-hover .922 .055 93; row-selected .894 .057 89; row-selected-fg .277 0 0; sidebar-accent .894 .057 89
  cats .546 .203 29 | .622 .171 46 | .64 .143 78 | .631 .135 109 | .625 .094 145 | .576 .066 199 | .597 .111 352 | .619 .029 67
github-light "GitHub Light" (Primer; passes unmodified)
  bg 1 0 0; fg .254 .011 254; pane 1 0 0; card 1 0 0; popover 1 0 0; sidebar .978 .003 248
  muted .978 .003 248; muted-fg .495 .022 251; accent .957 .005 248; accent-fg .254 .011 254; border .881 .013 244; input .881 .013 244
  primary .54 .191 257; primary-fg 1 0 0; destructive .557 .206 25; success .524 .14 148; unread .54 .191 257; star .554 .117 75
  row-hover .978 .003 248; row-selected .954 .028 228; row-selected-fg .254 .011 254; sidebar-accent .938 .007 248
  cats .552 .205 25 | .557 .16 45 | .554 .117 75 | .524 .14 148 | .537 .084 202 | .54 .191 257 | .563 .207 295 | .565 .019 251
catppuccin-latte "Catppuccin Latte"
  bg .958 .006 265; fg .435 .043 279; pane .958 .006 265; card .958 .006 265; popover .979 .003 265; sidebar .933 .009 265
  muted .933 .009 265; muted-fg .492 .034 279; accent .857 .014 268; accent-fg .435 .043 279; border .906 .012 265; input .857 .014 268
  primary .555 .25 297; primary-fg .958 .006 265; destructive .55 .216 20; success .52 .177 140; unread .555 .25 297; star .644 .149 68
  row-hover .933 .009 265; row-selected .899 .043 299; row-selected-fg .435 .043 279; sidebar-accent .906 .012 265
  cats .55 .216 20 | .657 .204 42 | .644 .149 68 | .62 .177 140 | .627 .145 235 | .559 .226 262 | .555 .25 297 | .601 .03 279
unica-dark "Única oscuro" (unchanged)
  bg .17 .006 265; fg .95 .004 85; pane .17 .006 265; card .2 .006 265; popover .21 .007 265; sidebar .2 .006 265
  muted .24 .007 265; muted-fg .68 .01 265; accent .27 .03 268; accent-fg .92 .03 268; border 1 0 0 / 9%; input 1 0 0 / 13%
  primary .7 .16 268; primary-fg .16 .03 268; destructive .68 .19 22; success .72 .13 160; unread .72 .15 268; star .82 .15 85
  row-hover 1 0 0 / 4%; row-selected .3 .05 268; row-selected-fg .97 .01 268; sidebar-accent 1 0 0 / 7%
  cats .72 .12 10 | .78 .12 75 | .78 .12 130 | .74 .12 165 | .76 .1 215 | .7 .13 268 | .72 .13 300 | .7 .02 265
dracula "Dracula" (AA-adjusted: comment → muted-fg .56→.78, red .68→.777)
  bg .288 .022 278; fg .977 .008 107; pane .288 .022 278; card .319 .03 279; popover .34 .027 276; sidebar .255 .019 280
  muted .34 .027 276; muted-fg .78 .08 270; accent .403 .032 278; accent-fg .977 .008 107; border .362 .031 280; input .403 .032 278
  primary .742 .149 302; primary-fg .288 .022 278; destructive .777 .206 24; success .871 .22 148; unread .755 .183 347; star .955 .134 113
  row-hover .319 .03 279; row-selected .403 .032 278; row-selected-fg .977 .008 107; sidebar-accent .34 .027 276
  cats .725 .18 5 | .834 .124 67 | .955 .134 113 | .871 .22 148 | .883 .093 213 | .716 .13 274 | .742 .149 302 | .56 .08 270
monokai "Monokai" (AA-adjusted comment and pink-as-destructive)
  bg .274 .011 115; fg .977 .008 107; pane .274 .011 115; card .302 .011 115; popover .314 .011 115; sidebar .237 .006 122
  muted .357 .018 103; muted-fg .777 .029 97; accent .357 .018 103; accent-fg .977 .008 107; border .357 .018 103; input .399 .016 102
  primary .841 .204 127; primary-fg .274 .011 115; destructive .772 .24 7; success .841 .204 127; unread .841 .204 127; star .879 .125 103
  row-hover .306 .011 115; row-selected .399 .016 102; row-selected-fg .977 .008 107; sidebar-accent .357 .018 103
  cats .642 .24 7 | .767 .168 62 | .879 .125 103 | .841 .204 127 | .827 .108 212 | .711 .15 272 | .701 .181 298 | .547 .029 97
tokyo-night "Tokyo Night" (AA-adjusted comment)
  bg .226 .021 280; fg .846 .061 275; pane .226 .021 280; card .261 .034 274; popover .261 .034 274; sidebar .204 .016 285
  muted .306 .037 273; muted-fg .701 .068 274; accent .306 .037 273; accent-fg .846 .061 275; border .282 .036 275; input .332 .036 271
  primary .719 .132 264; primary-fg .226 .021 280; destructive .723 .159 10; success .795 .139 130; unread .719 .132 264; star .784 .106 75
  row-hover .261 .034 274; row-selected .332 .064 268; row-selected-fg .846 .061 275; sidebar-accent .306 .037 273
  cats .723 .159 10 | .787 .137 51 | .784 .106 75 | .795 .139 130 | .82 .105 236 | .719 .132 264 | .751 .134 299 | .589 .062 277
gruvbox-dark "Gruvbox Dark"
  bg .277 0 0; fg .894 .057 89; pane .277 0 0; card .311 .003 49; popover .344 .007 49; sidebar .241 .005 220
  muted .344 .007 49; muted-fg .79 .035 76; accent .344 .007 49; accent-fg .894 .057 89; border .344 .007 49; input .411 .012 52
  primary .708 .042 170; primary-fg .241 .005 220; destructive .8 .218 30; success .765 .158 111; unread .693 .042 170; star .832 .159 83
  row-hover .311 .003 49; row-selected .411 .012 52; row-selected-fg .956 .055 96; sidebar-accent .344 .007 49
  cats .66 .218 30 | .731 .182 52 | .832 .159 83 | .765 .158 111 | .756 .108 138 | .693 .042 170 | .705 .098 2 | .619 .029 67
nord "Nord" (AA-adjusted nord3 → muted-fg, nord11 → destructive)
  bg .324 .023 264; fg .933 .01 262; pane .324 .023 264; card .379 .029 266; popover .379 .029 266; sidebar .301 .021 266
  muted .379 .029 266; muted-fg .797 .044 264; accent .416 .032 264; accent-fg .951 .007 261; border .379 .029 266; input .416 .032 264
  primary .775 .062 217; primary-fg .324 .023 264; destructive .766 .121 15; success .768 .075 131; unread .775 .062 217; star .855 .089 84
  row-hover .348 .024 266; row-selected .416 .032 264; row-selected-fg .951 .007 261; sidebar-accent .379 .029 266
  cats .606 .121 15 | .693 .096 38 | .855 .089 84 | .768 .075 131 | .763 .048 194 | .697 .059 249 | .692 .062 333 | .625 .041 263
catppuccin-mocha "Catppuccin Mocha"
  bg .243 .03 284; fg .879 .043 272; pane .243 .03 284; card .279 .035 277; popover .324 .032 282; sidebar .216 .025 284
  muted .324 .032 282; muted-fg .781 .04 274; accent .324 .032 282; accent-fg .879 .043 272; border .324 .032 282; input .404 .032 280
  primary .787 .119 305; primary-fg .243 .03 284; destructive .756 .13 3; success .858 .109 143; unread .787 .119 305; star .919 .07 87
  row-hover .296 .031 282; row-selected .404 .032 280; row-selected-fg .879 .043 272; sidebar-accent .324 .032 282
  cats .756 .13 3 | .824 .101 53 | .919 .07 87 | .858 .109 143 | .847 .083 210 | .766 .111 260 | .787 .119 305 | .687 .037 275
```

**Contrast pairs enforced by the test** (alpha tokens are composited over bg):
- **Text, 4.5:1:**
  - fg on bg, pane, card, popover, muted, row-hover, accent, sidebar, sidebar-accent
  - muted-fg on bg, pane, card, popover, muted, row-hover, row-selected, sidebar, sidebar-accent
  - primary-fg/primary; primary on bg and popover (links); accent-fg/accent; row-selected-fg/row-selected
  - destructive on bg and popover; success on bg
  - every `cat-*-ink` on `cat-*`/15%
- **UI, 3:1:** unread on bg and row-selected; rail on row-selected; ring on bg; star on bg; each cat dot on bg.
- **Exempt (decorative):** border, input.

## 6. Motion

`--motion` = the setting M. Derived values (shown at M = 75):
- `--motion-fast` = calc(M × .66) → 50 ms
- `--motion-base` = M → 75 ms
- `--motion-slow` = min(calc(M × 1.33), 100 ms) → 100 ms

Easing is `cubic-bezier(.2,.8,.2,1)`, and exits always use fast. `data-motion=off` applies when M = 0 or the OS asks for reduced motion. JS (WAAPI) animations check `motionMs()` and skip when it is 0. Base UI unmounts right away because `getAnimations()` comes back empty.

| What | Duration |
|---|---|
| j/k, selection, row hover, scrolling, reader body swap, theme switch | **0, never animated** |
| Hover/press colors (buttons, nav, inputs), switch, checkbox, tabs, toggle | fast |
| Tooltip in/out | fast |
| Popover, select, menus, context menu | enter base / exit fast |
| Dialog, alert, palette, category picker, composer | enter slow (fade + zoom-95 / slide-2) / exit fast; backdrop base |
| Toasts (sonner enter, exit, stack) | slow |
| Banners (learned, suggestions) appear | base |
| DnD | ghost in fast; target highlight fast; ghost fly-to-target slow; row flash slow; dot pop base; count bump slow; cancel fade fast |
| Row removal (archive, trash, ⌥-move) | leaving rows fade fast; the rest slide up slow, only while `[data-reflow]` is set (cleared after slow) |
| Spinner, skeleton pulse, sync ping (loops) | run; stopped when motion is off |

## 7. Drag-and-drop spec

1. **Start:**
   - `pointerdown` with button 0 and no ⌘/⇧ on `[data-thread-id]`. The existing mousedown still selects the row instantly.
   - Moving 4 px starts the drag; less than 4 px stays a click.
   - Payload: if the row is checked, all checked ids in list order; otherwise just that row.
   - Sets `html[data-dragging]` (cursor `grabbing`, list hover off) and dims the source rows to opacity .5 through `flash.ts` CSS.
2. **Ghost:** a chip with the first subject (truncated) and a count badge. When more than one row is dragged, two stacked offset layers sit behind it. It is placed at pointer +12/+8 px with `translate3d` in rAF and never re-renders per move.
3. **Targets:**
   - Every category `NavItem`. Rects are cached at start and refreshed on sidebar scroll. The sidebar auto-scrolls inside a 24 px edge zone.
   - `data-drop-state` is `over` (drop-target bg, primary ring, dot scaled 1.25) or `already` (muted, with a check mark).
   - `already` applies when every dragged thread is already in the category, or the category is the current view. Dropping there does nothing.
   - Only the 2 affected NavItems re-render, through per-item selectors.
4. **Drop:**
   - `addToCategory(id, newIds)`: rows get their dot immediately (`dot-pop` and a `drop-flash` keyed by id) and the counts are bumped optimistically (`count-bump`). The ghost flies to the dot and fades out.
   - Toast: "Añadido a «Viajes» · 3 conversaciones", with **Deshacer**. Undo removes only `newIds`.
   - Dropping a single thread runs the existing "add similar?" suggestion.
   - Holding ⌥ while in a category view = move: the threads are also removed from the current category, rows leave with the reflow animation, and undo restores both.
5. **Cancel:** Esc (captured, so it doesn't also close the reader), pointerup off a target, `pointercancel` or window blur. The ghost fades out (fast) with no fly-back.
6. **Keyboard / screen reader:** `l` picker, plus palette "Añadir a «X»". Both use the same toast and undo, and sonner's live region announces the result.

## 8. Settings UI ("Apariencia" tab)

- **Mode:** ToggleGroup Sistema / Claro / Oscuro.
- **Theme grids:** "Tema claro" (6 cards) and "Tema oscuro" (7 cards plus custom themes). Each card is a 132×84 live mini-mock (sidebar strip, 3 rows with an unread dot, a selected row with its rail, a primary pill) rendered inside `data-theme={id}`, using tokens only and no `dark:` utilities.
- **Applying a theme:** picking a theme for the active mode applies it immediately. For the other mode, the card shows "Se aplicará en modo oscuro/claro".
- **Animaciones:** a 0/50/75/100 control with a demo dot. The hint notes that the system's reduced-motion setting overrides it.
- **Correo HTML:** auto/paper.
- **Custom themes:** "Importar tema…" (JSON file) reports validation errors inline and shows contrast warnings (warnings don't block). "Exportar tema actual" copies the JSON. Custom themes can be deleted.

## 9. Test plan

**Unit (vitest)**
- `ui/themes/color.test.ts`: conversions against references (#fff, #000, #ff0000 = .628 .258 29.2) and ratio(#777, #fff) = 4.48.
- `ui/themes/contrast.test.ts`: every built-in theme × every pair from §5. Failures list theme, pair and ratio.
- `ui/themes/registry.test.ts`: tokens complete, ids unique, defaults for both modes, generated CSS matches `generate()`.
- `ui/themes/no-hardcoded.test.ts`: greps `apps/web/src` and `packages/ui/src` for hex/`rgb(`/`oklch(` in tsx, `bg|text-(white|black)`, `duration-\d`, `delay-\d`, and `text-(foreground|sidebar-foreground)/\d`.
- `core/themes.test.ts`: the schema accepts valid themes and rejects `red;}body{…}`, `url(`, `var(`, unknown tokens and >20 themes. `extends` resolves to a full map.
- `backend/settings.test.ts`: every new field round-trips; a legacy `{theme:"dark"}` blob gets the defaults; `motionMs: 60` is rejected; a dangling custom id falls back.
- `web/public/theme.test.ts`: runs `theme.js` in `node:vm` with fake localStorage/matchMedia and checks the attributes, the migration from `unica:theme`, and that reduced motion turns motion off.
- `web/lib/drag.test.ts`: payload order, hit-test, `newIds` (already-member exclusion), optimistic counts, motion vars (75 → 50/75/100; 100 → 66/100/100; 0 → 0).

**Playwright** (motion specs use `test.use({reducedMotion:"no-preference"})`)
- `dnd.spec.ts`:
  - drag one row to "Viajes" (stepped `page.mouse`): ghost visible, target `over`, dot and count, undo reverts
  - `x`×3 then drag: ghost shows "3" and all 3 get the dot
  - `already` state does nothing
  - Esc cancels
  - a click below 4 px still only selects
  - `l` gives the same toast and undo.
- `themes.spec.ts`:
  - every theme: pick it, check `data-theme` and that the computed `--background` equals the registry value
  - after reload, `data-theme` is already set at DOMContentLoaded (captured by `addInitScript`)
  - system mode follows `emulateMedia`
  - iframe background follows the auto/paper rules
  - custom theme import, and a rejected invalid JSON.
- `motion.spec.ts`:
  - at 75: max `getTiming().duration` of all animations after opening a dialog, popover and toast is ≤ 100
  - at 0 and under emulated reduced motion: `document.getAnimations().length === 0` and a button's `transition-duration` is `0s`
  - holding j creates no animations.
- **Visual:**
  - `inbox-<theme>.png` for all 13 themes (DSF 1 to keep baselines small)
  - Apariencia tab in light and dark
  - mid-drag (ghost and highlighted target) in unica-light and dracula.

**Performance** (`perf.spec.ts`, production build with `VITE_RENDER_PROBE=1`, all p95)

| Budget | Target | How |
|---|---|---|
| Theme switch → painted | ≤ 50 ms | 30 alternations: mark → `applyAppearance` → double rAF |
| Rows re-rendered by a theme or motion switch | 0 | `__renders.ThreadRow` delta |
| Drag start (threshold move → ghost painted) | ≤ 16 ms | mark in the controller, rAF |
| Per-pointermove handler | ≤ 2 ms | `performance.measure` behind the probe |
| ThreadRow renders from pointerdown to pointerup | **0** | render probe |
| NavItem renders per target change | ≤ 2 | render probe |
| Drop → dot visible | ≤ 16 ms; renders = dragged rows that are visible | MutationObserver |
| Holding j | the existing ≤ 16 ms gate plus 0 animations | existing test, extended |
| Generated theme CSS | ≤ 8 KB gzip | build-size assertion |

## 10. Risks

- **No drag-out to Finder (.eml).** Could be added later as a separate native drag for export only.
- **AA adjustments change canonical palettes** (the Dracula comment color, Solarized body text). Purists may notice. The test is the authority; custom themes can override and only get warnings.
- **`nativeTheme.themeSource` changes the renderer's `prefers-color-scheme`.** The system listener must apply only when mode is `system`.
- **sonner's internals** (inline durations, a 200 ms unmount timer) aren't fully controlled by CSS. Pin the version and cover it with the motion spec.
- **Specificity:** the vibrancy rule (0,2,0) has to beat theme blocks, and nested preview themes have to beat it. Covered by the visual tests.
- **Base UI's exit detection** under `animation:none` is assumed to unmount immediately. The motion spec verifies it.

## 11. Implementation checklist (one commit each)

1. core: `THEME_TOKENS`, the `CustomTheme` schema, tests.
2. ui: `color.ts` with tests.
3. ui: registry (13 themes as in §5) + `derive()` + contrast/registry tests.
4. ui: generator + `themes.generated.css` + drift test; globals.css imports it.
5. ui: globals tokenization (overlay, shadows, font, vibrancy, selection, ink, ring alpha, drop-target).
6. ui: motion variables, the off rule, reduced motion, `motionVars()` tests.
7. ui components: durations, overlay, `ring-ring`, badge ink, sonner override; the no-hardcoded test goes green.
8. core/backend: AppSettings fields + defaults + validation + settings tests.
9. web: `appearance.ts` + theme.js rewrite + vm test; Toaster resolved mode.
10. desktop: `setAppearance` IPC + `appearance.json` + initial window bg; smoke test still green.
11. web: mail iframe tokens + `htmlMailAppearance`.
12. web: remove alpha text (sidebar, row, TextBody); refresh visual baselines.
13. web: Apariencia tab + `themes.spec` + per-theme baselines.
14. web: `motion.spec`.
15. web: render probe + theme-switch perf case.
16. web: `addToCategory()` (picker, undo, optimistic counts) + palette commands.
17. web: drag store, controller, ghost, sidebar targets, `flash.ts` + unit tests.
18. web: drop/cancel animations, Esc, auto-scroll.
19. web: ⌥-move + `data-reflow` (also used by archive and trash).
20. `dnd.spec` + drag perf cases + mid-drag baselines.
21. docs: update PLAN.md §9/§11 and the README perf table.

## Implementation notes

Where the implementation departs from the proposal above, and why:

- **Undo toast → the categorization snackbar.** Plan 02 landed first: drag and drop, the `l` picker and the palette's «Añadir a «X»» all call `addToCategory` (`lib/categorize.ts`, RPC `categories.addThreads`, source `dnd` for drops), which records the training signal, returns what changed and shows the reusable snackbar with its undo and quick actions. The "add similar?" step is the snackbar's quick actions (plan 02 retired the card). `addToCategory` also bumps the sidebar's unread count optimistically.
- **⌥-move** is one backend transaction (`categories.moveThreads`): added to the target, removed from the current category as a user removal (the engine learns from it). The move's batch snapshots what it overwrote (source memberships with origin and batch, both categories' examples, decision outcomes), and `categorize.undo` on it restores everything in one transaction, so an earlier batch's undo still works. The snackbar says «Movido a …», closes only after a successful undo and offers «Reintentar» on failure.
- **Badge inks are derived tokens**, not `color-mix(in oklch, …)` in CSS: mixing with a near-neutral anchor in oklch rotates the hue (the anchor's hue is interpolated), and Chromium's handling of powerless hues isn't something a test can mirror. `derive()` mixes in OKLab (60/40 toward the ink anchor, more only if 4.5:1 on the 15% tint over bg, card and popover needs it) and writes `--cat-*-ink` per theme. Avatars use the same inks on a 15% tint.
- **Two more contrast pairs**: `mail-ink` and `mail-link` on `mail-paper` (49 pairs per theme).
- **Custom themes never use vibrancy** (their colors render exactly), are applied with CSSOM `setProperty` (preview cards through React's style object), and theme.js re-validates cached tokens with the same numbers-only grammar before applying them. The cache is `unica:appearance = {mode, light, dark, motion, vibrancy: {light, dark}, custom?: {light|dark: {base, tokens}}}`.
- **HTML mail**: "mail that sets colors" is read from the sanitized HTML parsed in an inert document: color attributes or a `color`/`background` declaration in any element's CSSStyleDeclaration (`lib/mail.ts`). The CSP is untouched, so local mode keeps the strict policy.
- **Mode** moved from Ajustes → General to the new Apariencia tab.
- **Row removal**: virtualized rows unmount at once, so the leaving rows fade as detached copies while `data-reflow` lets the rest slide up for one slow window; archive and trash use it too.
- **Measurement definitions.** Drag start is gated three ways: threshold pointermove → ghost shown and targets measured (synchronous, ~5 ms), → the rAF of the first frame (the ghost must already be visible there), and → that frame rendered (a task posted from its rAF); the last two within one display frame. The theme switch is measured to the frame after paint (double rAF), so ~33 ms of it is two vsync waits. "Drop → dot" counts renders until the dot is in the DOM (the backend's later list refresh re-renders rows as before). The drag-perf window starts with the pressed row already selected: pressing a row selects it (two row renders, as with j).
- **The render probe** builds into `dist-e2e` (`VITE_RENDER_PROBE=1`), so a test build never lands in `dist`; production compiles the probe out.
- **Appearance changes are serialized**: one `settings.update` at a time, and every settings answer is reconciled with the still-pending appearance patches (`reconcileSettings`), so an older snapshot or a refusal never repaints over a newer choice. The window background sent to main is always opaque (a translucent custom background is composited over the mode's default).
- **Small fixes found on the way:** the UI perf search case read the query from a stale index of the list key (broken since the review id joined it); the reader's star button is keyed by thread so moving onto a starred thread doesn't fade its color (j never animates).
- `motionVars()` and `applyCustomTheme()` live in `packages/ui/src/themes/apply.ts` and are tested there; `lib/drag.ts` is the pure controller and `lib/drag-install.ts` binds it to the DOM.
