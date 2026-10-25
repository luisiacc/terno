# Plan 15: designs (macOS, Atelier, Lumen)

- **Status:** shipped (§12, §13).
- **Builds on:** `b77b27b` (main), plus plan 14 once merged.
- **Request (verbatim):** "for the appearance of the app, lets be even more themable, look at these 2 pictures, lets add those as more themes, but these not only change colors but also the UI components, the current theme will be called "MacOS" and will be one of the available themes. i'm also attaching here the code that produced those uis in the pictures, do check that the fonts and weights are different, also they have different font families. so lets make our design system components even more themable at this level, but keeping it easy for changing them later so the maintenance of this is not too heavy for future agents. The default theme will be the one from the 2nd picture. These themes will apply to the entire app, including settings and everything, make sure that this doesn't cause any bugs please, be thorough and have codex do code reviews of your logics and code and fix the findings."
- **Inputs:** picture 1 (**Atelier**), picture 2 (**Lumen**, the new default), and the code that produced them (a Next.js/v0 showcase: `app/globals.css` tokens per `.theme-atelier` / `.theme-lumen`, `app/layout.tsx` fonts, `components/variants/{atelier,lumen}.tsx`, `components/mail/{primitives,reply-area}.tsx`). The reference code is read as a spec only. Nothing from it is copied, installed or run.

Vocabulary used below. A **design** (macOS, Atelier, Lumen) is typography, shape, density and a small, closed set of component variants. A **palette** is what the app calls a "theme" today: the 13 color sets in `packages/ui/src/themes/registry.ts`, plus custom themes. **Mode** is light or dark. In the UI, a design is a **Style** and a palette is **Colors**.

## 1. What the references do (and where they differ from Terno)

| | Today (becomes **macOS**) | **Atelier** (picture 1) | **Lumen** (picture 2) |
|---|---|---|---|
| UI font | SF on macOS, Geist elsewhere | Instrument Sans | Figtree |
| Display font | the UI font, semibold 15 px list title, 20 px subject | **Instrument Serif** 400: list title 30 px, subject 44 px / 1.05, section labels *italic* 17 px | Figtree **700**, tracking −0.02 em: greeting 24 px, subject 32 px / 1.15, −0.025 em |
| Weights | 400 / 500 / 600 | 400 / 500 / 600, unread from 600 | 400 / 500 / **600 / 700**: names 600, unread 700, active nav 600 |
| Body | 13 px list, 14 px reader | 13.5 px list, 15 px reader | 14 px list, 15.5 px reader |
| Radius | `--radius` .5 rem (rows 6, dialogs 16) | .625 rem (rows `rounded-xl`) | **1 rem** (rows `rounded-2xl`, pills `rounded-full`) |
| Icons | lucide, stroke 2 (1.75 in the toolbar) | Phosphor, *light* | lucide, stroke **1.5** |
| Compose | quiet icon in the list header | outlined sidebar button "Nuevo mensaje" + `C` kbd (and the header icon) | solid black pill "Redactar" in the sidebar |
| List header | title (+ "Filtered by") + search field | serif title + "90 mensajes · 3 sin leer" + search field with `/` | greeting "Buenas noches, Luis" + "**3 sin leer** · 2 conversaciones esperan tu respuesta", search behind an icon, **filter chips** |
| Row | dot · from · count · meta · date / subject · snippet, 68 px | **avatar 36 px**, dot left of it, meta before the date | **avatar 44 px**, unread dot *on* the avatar, meta at the end of the snippet line |
| Category review | "Revisar" sub-row under the category | inline ✨14 badge before the unread count | inline ✨14 gold pill (no unread count) |
| Reader header | subject, then account · category badges | account + category chips **above** a serif subject | **sender card** (64 px avatar, name, address, chips), then subject |
| Reply affordance | reply / reply all / forward icons | the same icons | **"Responder R" pill** + forward |
| Reply surface | `bg-tint` | outlined | card with a soft shadow |

Two things in the references fail Terno's own rules and change on the way in:

- **Contrast.** Atelier's `muted-foreground` `#7a776f` is 4.47:1 on white (AA needs 4.5), and less on its sidebar. Lumen's `#78726b` is 4.75:1 on white but 4.32:1 on its `muted` `#f5f4f2`. Lumen's gold `#c8952e` (ring, unread dot, "3 sin leer", star) is 2.69:1 on white, so it fails even the 3:1 UI minimum. The palettes below darken these until the existing contrast suite passes. Gold *text* uses the darker `#8a5d12` (5.8:1).
- **Translucent text** (`text-foreground/80`, `/75`) is everywhere in the reference. `no-hardcoded.test.ts` forbids it because translucent text can't be contrast-tested. Terno uses tokens instead.

## 2. What exists

- **Palettes:** `packages/ui/src/themes/registry.ts` (`defineTheme`, `derive()` fills ~40 derived tokens with contrast-driven steps). It generates `themes.generated.css` (`[data-theme="id"]` blocks; `:root` = the first theme). There are tests for sync, AA for every pair in `contrast.ts` (`CONTRAST_PAIRS`), and no hard-coded colors or durations in `apps/web/src` and `packages/ui/src`. A palette also carries `vibrancy` and an optional `font` (only Apple uses it, as `--theme-font`).
- **Core vocabulary:** `packages/core/src/themes.ts` (`THEME_TOKENS`, `BUILTIN_THEMES`, `DEFAULT_THEME`, the custom theme schema whose `extends` is a built-in id).
- **Settings:** `AppSettings.theme` (mode), `lightTheme`, `darkTheme`, `motionMs`, `htmlMailAppearance`, `customThemes`, `density` (`comfortable | compact`). The backend (`packages/backend/src/settings.ts`) stores **only the keys a patch set** under `settings.app` and merges `DEFAULT_SETTINGS` on read. So a key that was never chosen is absent from storage. It is the same code over SQLite (desktop) and IndexedDB (web worker).
- **Applying:** `apps/web/src/lib/appearance.ts` `applyAppearance()` sets `.dark`, `data-theme`, custom tokens (CSSOM), motion vars and `data-vibrancy` in one frame (`data-theme-switching` turns transitions off). It caches `terno:appearance` for `public/theme.js`, which paints before React. It also tells desktop main (`setAppearance`: themeSource, opaque background, vibrancy).
- **Foundations:** `packages/ui/src/styles/globals.css`. The type scale (`--text-2xs … --text-xl`), `--font-sans` and the radius ladder live in `@theme inline`. Tailwind **inlines** those values into utilities, so today they can't be overridden per subtree (radius works only because the inlined value is `calc(var(--radius) * k)`). Fonts: `@fontsource-variable/geist` and `geist-mono`, bundled.
- **Layout:** `app.tsx` grid `232px · minmax(340px,400px) · 1fr`. Desktop window min 980×600, traffic lights at (20, 19) in a 52 px drag strip.
- **List:** `thread-list.tsx` (`useVirtualizer`, fixed `estimateSize` = `ROW_HEIGHT[density]` = 68 / 40 from `thread-row.tsx`). `ThreadRow` is `memo`, with per-row selectors (two rows re-render per j/k, a render probe in perf runs). The unread filter (plan 12) is per mailbox, stored in localStorage, with `unreadOnly` through `threads.list` / `ThreadScope` and covering partial indexes in SQLite (v11) and in-memory orders in IndexedDB.
- **Avatars:** initials with `avatarColor(email)` in `reader.tsx` and `inline-draft.tsx`. `AVATAR_BG` is duplicated in both files. Rows have no avatar.
- **Tests:** `themes.spec.ts` (every palette applies; theme.js before React; a visual baseline per palette), `visual.spec.ts` (key screens light and dark), axe in snack/unread-filter/print/settings-pass specs, `perf.spec.ts` (j at key repeat and 2,000-row scroll per density, row height asserted 68/40), and the desktop packaged smoke.

## 3. Design

### 3.1 The model

```
Style (design)  ×  Colors (palette per mode)  ×  Mode (system | light | dark)  ×  Density
```

Each layer owns one thing:

- **A design owns** fonts, weights, sizes, tracking, radii, hairlines vs fills, shadows, spacing and row heights, plus a closed set of structural variants (§3.3). It never owns a color (the hard-coded-color scan enforces that).
- **A palette owns** every color, as today.
- **A design names its own palette pair** (`palette: { light, dark }`). Under the default color choice (**"Style colors"**), switching the design switches the colors with it. That's what makes Atelier look like Atelier.

**Why palettes stay independent of the design.** It keeps quality high and maintenance low:

- Contrast is a property of colors alone. The existing suite already proves every palette AA on every pair the app draws. If designs owned colors, that proof would be redone per design, and the 13 palettes would either vanish for Atelier/Lumen users or be duplicated three times.
- With palettes independent, a user who likes Dracula keeps Dracula under Lumen, and adding a design never touches colors.
- The cost is one rule: **a design may only draw text and UI on pairs listed in `CONTRAST_PAIRS`.** A design that needs a new pair adds it there, and the pair is then proven for every palette at once. Example: Lumen's gold "3 unread" needs the new derived `unread-ink` token below.
- The axe matrix (§6) is the backstop.

**macOS is today's app, exactly.** Its definition reproduces the current tokens and variants, and its palette pair is `terno-light` / `terno-dark`. Every existing visual baseline must pass **unchanged** under macOS. That is the proof the refactor changed nothing for it.

### 3.2 Where design values live (one file per design)

```
packages/ui/src/designs/
  types.ts       DesignDefinition: every token group and every variant is required
  macos.ts       today's values
  atelier.ts
  lumen.ts
  index.ts       DESIGNS (ordered), designById(); a test keeps it in sync with @terno/core DESIGN_IDS
  generate.ts    → styles/designs.generated.css (like themes): one [data-design="id"] block per design
  fonts.css      @font-face for Figtree, Instrument Sans, Instrument Serif (§3.5)
```

`DesignDefinition` (abridged; the type has no optional members, so a new design must decide everything):

```ts
interface DesignDefinition {
  id: DesignId;                                      // "macos" | "atelier" | "lumen" (@terno/core)
  palette: Record<ThemeMode, BuiltinThemeId>;        // "Style colors"
  /** may the sidebar show macOS vibrancy (ANDed with the palette's flag) */
  vibrancy: boolean;
  fonts: { sans: string; display: string; features: string };   // CSS font-family stacks
  /** the dense scale, per design: 2xs xs sm base md lg xl (size + line height) */
  text: Record<TextStep, [size: string, leading: string]>;
  /** the existing ladder's steps, set per design instead of × one --radius */
  radius: Record<"sm" | "md" | "lg" | "xl" | "2xl", string>;
  /** semantic type roles: where designs actually differ */
  type: Record<TypeRole, { family: "sans" | "display"; size: string; leading: string; weight: number; tracking: string; style: "normal" | "italic" }>;
  weights: { rowFrom: number; rowFromUnread: number; navActive: number; sender: number };
  icon: { stroke: number; toolbarStroke: number };
  layout: { sidebar: string; listMin: string; listMax: string; readerMax: string; readerPadX: string };
  rows: { comfortable: number; compact: number };    // px; the virtualizer reads these
  avatar: { row: number; rowCompact: number; reader: number; collapsed: number; senderCard: number };   // px, 0 = none
  surfaces: { draft: "tint" | "outline" | "card"; navActive: "fill" | "raised" };
  variants: DesignVariants;                          // §3.3
}
type TypeRole = "listTitle" | "greeting" | "listSubtitle" | "sectionLabel" | "nav" | "rowFrom" | "rowSubject" | "rowSnippet" | "readerSubject" | "senderName" | "body";
```

**Generation.** `generate.ts` turns each definition into CSS variables:

- `--font-sans`, `--font-display`, `--font-features`
- `--text-sm` and `--text-sm--line-height`, and the rest of the scale
- `--radius-md` and the rest of the ladder
- `--type-reader-subject-size` (and family, weight, tracking, leading, style)
- `--icon-stroke`, `--sidebar-w`, `--row-h`, `--avatar-row`, and so on

All of these go in a `[data-design="id"]` block. Attribute selectors, not `:root[…]`, so a Settings preview card can nest any design (the same reason `themes.generated.css` does it). `:root` gets the default design (Lumen) as the fallback before theme.js runs.

**Two changes to `globals.css` make this work:**

1. **Move the type scale, the radius ladder and `--font-sans` from `@theme inline` to `@theme`.** Utilities then compile to `var(--text-sm)`, `var(--radius-md)` and so on, so a `[data-design]` block can override them. `--font-sans` for macOS stays `var(--theme-font, -apple-system, BlinkMacSystemFont, "Geist Variable", …)`, so the Apple palette's font still works under macOS. Under Atelier and Lumen the design's font wins (`--theme-font` is ignored there).
2. **Role utilities, written once:** `type-list-title`, `type-greeting`, `type-section-label`, `type-row-from`, `type-reader-subject`, and the rest of the roles. Each reads its role variables (`font-family: var(--type-…-family)`, size, weight, tracking, line-height, style).

   Components use a role utility only where designs differ. Everything else keeps the shared scale (which each design sets). Icons: `svg.lucide { stroke-width: var(--icon-stroke) }`. A CSS property beats lucide's presentation attribute. The toolbar's `[&_svg]:stroke-[1.75]` becomes `var(--icon-stroke-toolbar)`.

   Atelier's Phosphor *light* is approximated with lucide at stroke 1.25. A second icon set would double every icon import and the tests for one design's look. Rejected.

**Draft surfaces and nav highlights** are CSS too, driven by tokens: `draft-surface` (tint / hairline outline / card with `--shadow-raised`) and `nav-active` (fill / raised). Shadows keep using `--shadow-color`, so dark palettes deepen them as today.

### 3.3 Structural variants (closed set, implemented once each)

Variants exist only where the DOM structure differs. Everything else is tokens. `DesignVariants`:

| Variant | Values | macOS | Atelier | Lumen |
|---|---|---|---|---|
| `compose` | `list-header` · `sidebar-outline` · `sidebar-pill` | `list-header` | `sidebar-outline` (+ header icon, as in the picture) | `sidebar-pill` |
| `listHeader` | `title` · `display` · `greeting` | `title` | `display` (serif title + "N unread") | `greeting` (inbox), `display` elsewhere |
| `search` | `field` · `button` | `field` | `field` | `button` (expands into the field) |
| `quickFilters` | `menu` · `chips` | `menu` | `menu` | `chips` |
| `row` | `classic` · `avatar` · `large-avatar` | `classic` | `avatar` | `large-avatar` |
| `categoryReview` | `sub-rows` · `inline-badge` | `sub-rows` | `inline-badge` | `inline-badge` |
| `readerHeader` | `classic` · `chips-display` · `sender-card` | `classic` | `chips-display` | `sender-card` |
| `replyAction` | `icons` · `pill` | `icons` | `icons` | `pill` |

**Pattern** (so adding a value is a compile error until every component handles it):

```ts
// apps/web/src/lib/design.ts
export const useDesign = () => designById(useAppearance((s) => s.design));
export function variant<V extends string, T>(v: V, impl: Record<V, T>): T { return impl[v]; }
// a component:
const Body = variant(design.variants.row, { classic: ClassicRow, avatar: AvatarRow, "large-avatar": LargeAvatarRow });
```

`useAppearance` (zustand, already the source of `mode`) gains `design`. Under the React Compiler, a store subscription is what makes memoized components re-render. `ThreadList` subscribes once and passes `variant` and `height` to rows as props, so a design switch re-renders each visible row once and j/k still re-renders exactly two.

**What every variant must keep identical:** roles, names, test ids, focus order, shortcuts, the drop targets, the context menus. Every row variant has `role="option"`, `aria-selected`, `data-thread-id`, `data-unread`, `data-checked`, `row-from` and `row-subject`. Every reader header has `reader-subject`, the category badges with their remove and "auto" buttons, the suggestion chips with y/n, and the account. `compose-button` exists exactly once per design. A component test renders each variant and compares the accessibility tree (names and roles) with macOS's.

#### Per-variant behavior

- **`compose`**
  - `sidebar-outline`: a full-width outline button under the drag strip: pen icon, "New message", `Kbd C`.
  - `sidebar-pill`: a solid `bg-primary` pill (radius full), "Compose". Its tooltip shows `C`.
  - In both, the list-header icon is Atelier-only (as pictured) and has no test id. The sidebar button carries `compose-button`.
- **`listHeader`**
  - `display`: `type-list-title` (serif under Atelier). The subtitle is "N unread" from `counts` (the inbox and categories have it; other views show no subtitle). The thread total in the picture ("90 mensajes") is left out: it would need a count query on every change.
  - `greeting` (inbox only; other views use `display`):
    - The greeting depends on the time of day: morning 05–12, afternoon 12–19, evening 19–05.
    - It uses the owner's first name (`OwnerIdentity.displayName`), or no name when there is no owner. Never an account display name: it may be a company.
    - Below it: "**N unread**" in `unread-ink` ("· M waiting for your reply" arrives with plan 17, §3.7). With nothing unread, the line is "You're all caught up."
    - It refreshes on `visibilitychange` and with one timeout to the next boundary. That is not polling: at most three timers a day, cleared while hidden.
  - In every variant, the account suffix ("· Personal"), the unread filter status, the search stats and the filter button behave as today.
- **`search: button`**
  - A search icon button (`aria-expanded`) replaces the field. Clicking it, `/` or ⌘F expands the field in place of the subtitle line and focuses it.
  - It stays open while the query is non-empty. Esc on an empty query collapses it and returns focus to the button.
  - `searchInputRef` is valid whenever the field is mounted. `keyboard.ts`'s `/` handler expands first, then focuses after render (`focusSoon`).
- **`quickFilters`** (§3.6)
  - `menu`: today's filter button. Its "Filtered by: X" subtitle becomes a menu button that picks the criterion, like Mail's.
  - `chips`: a single-select ToggleGroup (`aria-label` "Quick filters", arrow keys move). It overflows horizontally with the focused chip scrolled into view and no visible scrollbar. The Starred chip hides in the Starred view.
- **`row`**
  - `avatar`: a 36 px initials avatar. The unread dot stays left of it. Meta (categories, clip, star, account ring) goes before the date.
  - `large-avatar`: a 44 px avatar with the unread dot on its top-left (`ring-2 ring-background`, `bg-unread`). Meta moves to the end of the snippet line.
  - Compact density in both: a single line, avatar 20 px, the unread dot on the left as in classic.
  - The drag ghost, the hover and selection shapes, and the hairline-under-selection rules stay. The inset radius uses `--radius-row`.
- **`categoryReview: inline-badge`**
  - The category `NavItem` row gets a trailing sibling button inside the same row container (buttons can't nest): ✨ + the suggestion count, before the unread count.
  - Its `aria-label` is "Review 14 suggestions in Facturas" and its test id is `nav-review-<id>`, as the sub-row's is today. It navigates to the same review list, and `data-active` marks it while that list is open.
  - It is keyboard-reachable in sidebar order. It is never a drop target: the category row stays the target, and the badge passes drops through.
- **`readerHeader`**
  - One `ThreadChips` component (account, category badges with auto/remove, suggestion chips with y/n), used by every variant. The variants only arrange it:
    - `classic`: subject, then chips (today).
    - `chips-display`: chips, then a `type-reader-subject` serif subject.
    - `sender-card`: 64 px avatar + `senderName` + address + `ThreadChips`, then the subject.
  - The sender shown is the last message's sender who isn't the user, or the thread's `fromName` / `fromEmail` when every message is the user's.
  - First-letter capitalization of the subject (`first-letter:uppercase` in the reference) is not copied: it alters what the sender wrote.
- **`replyAction: pill`**
  - In the reader toolbar's reply group: a "Reply" outline pill with `Kbd R`, then reply-all and forward icons. Reply-all is kept in the toolbar too, so the capability doesn't depend on the design.
  - Below a 560 px reader width (a container query, not a viewport one), the pill collapses to the icon with the same accessible name, so the toolbar never overflows at 980×600.

**Avatars.** One cheap `SenderAvatar` (a span; no Base UI, no image) replaces the two `AVATAR_BG` copies. It takes initials and `avatarColor(email)` on the `cat-*` 15% tint with `cat-*-ink` (pairs already proven). Shape and size come from design variables. Photos and brand logos (Figma, Stripe in the pictures) are out: Terno has none locally, and fetching them (Gravatar, BIMI, favicons) would send addresses off the machine.

### 3.4 Palettes: four new built-ins, dark variants designed

They are added to `@terno/core` `BUILTIN_THEMES` and to the registry like any palette. Custom themes may extend them, and they appear in the Colors picker under every design. The values are sources (the hex from the reference, then darkened where AA requires), converted to oklch in the registry. `derive()` fills the rest.

- **`lumen-light`:**
  - Background `#ffffff`, pane `#ffffff`, sidebar `#fbfaf9`, muted `#f5f4f2`, border `#eeece8`.
  - Foreground `#1a1816`. `muted-foreground` darkened from `#78726b` until ≥ 4.5 on `muted` (≈ `#6f6962`).
  - **Primary near-black `#1a1816`** (the black Compose pill, the selected chip, Send), primary-foreground white.
  - Accent (gold wash) `#f7f1e6` with accent-foreground `#8a5d12`. Row-selected `#f7f1e6`, row-selected-foreground `#1a1816`.
  - **Unread and ring: a gold darkened to ≥ 3:1 on white** (≈ `#a67a22`). Star: the same gold.
  - Cats from tones 1–5: `#c76a3a`, `#4f8a5b`, `#3a8a95`, `#8d6bb0`, `#c8952e`, plus rose, indigo and slate chosen to match. Vibrancy false.
- **`lumen-dark`** (designed; the reference is light-only):
  - Warm near-black background ≈ `oklch(.19 .006 70)`, sidebar `.215`, muted `.25`, foreground `.95 .005 85`.
  - Primary inverts to `oklch(.94 .006 85)` with a near-black primary-foreground (the pill stays the highest-contrast object).
  - Accent `oklch(.28 .035 80)` / accent-foreground `oklch(.86 .09 85)`.
  - Unread and ring gold `oklch(.8 .13 82)`.
  - Cats lifted like `terno-dark`'s. Vibrancy false.
- **`atelier-light`:**
  - Paper background `#ffffff`, sidebar `#f6f5f2`, muted `#f3f2ef`, border `#ebe9e4`.
  - Ink `#1d1c1a`. `muted-foreground` darkened from `#7a776f` to ≥ 4.5 on sidebar and muted (≈ `#6e6b63`).
  - **Primary navy `#1e3553`**, accent `#edf0f4` / `#1e3553`, row-selected `#edf0f4`.
  - Unread `#1e3553`. Star `#b5643a` (the reference's orange star, tone 1).
  - Cats `#b5643a`, `#5b7f5a`, `#4a7c84`, `#7d6a92`, `#45638f`, plus the rest to match. Vibrancy false.
- **`atelier-dark`:**
  - Ink-navy dark: background `oklch(.2 .012 255)`, sidebar `.18`, foreground paper `oklch(.94 .006 85)`.
  - Primary a lifted navy `oklch(.74 .07 255)` with a dark navy primary-foreground. Accent `oklch(.28 .03 255)`.
  - Star a lifted terracotta. Sage and teal cats lifted. Vibrancy false.

**New derived token: `unread-ink`.** It is `unread` stepped until 4.5:1 on background, pane, sidebar and sidebar-accent, for "N unread" text and Lumen's inbox count. It joins `THEME_TOKENS` and `CONTRAST_PAIRS`, and every palette derives it. The existing suite then proves the four new palettes (all pairs, light and dark) with no new test code.

### 3.5 Fonts

| Family | Package | Styles | Used by |
|---|---|---|---|
| Figtree | `@fontsource-variable/figtree` | wght 300–900, normal | Lumen UI and display |
| Instrument Sans | `@fontsource-variable/instrument-sans` | wght 400–700, normal | Atelier UI |
| Instrument Serif | `@fontsource/instrument-serif` | 400 normal + italic | Atelier display, italic section labels |

All three are SIL OFL 1.1. They are listed in the third-party notices with their license text. Geist and Geist Mono stay (macOS off-Mac, and mono everywhere).

- **Bundled, never fetched.** `designs/fonts.css` declares our own `@font-face` rules pointing at the packages' `latin` and `latin-ext` woff2 files. Vite emits them as hashed same-origin assets, the service worker precaches them for the web, and electron-builder packs them in the app.
  - Spanish (á é í ó ú ü ñ ¿ ¡ « » · — …) is inside `latin`. `latin-ext` covers names like Łukasz or Ağaoğlu. Both carry `unicode-range`, so a subset downloads only when text needs it.
  - CSP is already `font-src 'self' data:` in both builds. Nothing goes to Google: no `<link>`, no `@import url(https://…)`. A test scans the built CSS for `fonts.googleapis` and `fonts.gstatic`.
- **Only the active design's fonts load.** Browsers fetch a face only when rendered text uses it. The one exception is the Settings → Appearance style cards, whose previews render each design's fonts. That is a few tens of KB, loaded when the user opens that tab ("no work until a feature is opened").
- **No fallback flash in normal operation; never invisible text** (revised, R7):
  - The faces use `font-display: swap`.
  - Before its first React render, `main.tsx` waits for the active design's faces (`document.fonts.load` per role sample, Spanish included) for at most 150 ms. They're local files, so normally they're ready well within that.
  - A live switch waits up to 300 ms before applying (§3.8).
  - If a font is late or fails, the fallback renders and swaps in when the font arrives (one reflow, logged to local diagnostics). It's never a blank.
- **Numerals.** Lists use `tabular-nums`. Implementation checks that Figtree and Instrument Sans expose `tnum`. A design whose font lacks it sets `--font-numeric` to its own font with `font-variant-numeric` off and right-aligns, and the visual baselines catch drift.
- **`font-feature-settings`** becomes `--font-features`: macOS keeps `"cv11", "ss01"`, and the references apply the same to Figtree and Instrument.
- **Kept on their own fonts:**
  - HTML-mail iframes (`mail-body.tsx`): the sender's styles, or the system stack.
  - The print document (`lib/print.ts` `FONT`) and the PDF footer (`print-policy.ts`).
  - Monospace surfaces (Geist Mono).
  - Plain-text mail bodies live in the app's DOM and use the design's `body` role (Figtree 15.5 px under Lumen, as pictured).
- **macOS keeps SF** (`-apple-system`) on Mac, desktop and web, and Geist elsewhere, exactly as today.

### 3.6 Quick filters (functional; available in every design)

These generalize plan 12's unread filter instead of adding a second mechanism.

- **Values:** a per-mailbox `filter: "all" | "unread" | "attachments" | "starred"` ("people" joins in plan 17; see the revisions, R10). The mailbox key (`view|account|category`), "a search inherits its mailbox", and "Revisar never filters" are unchanged.
  - Storage moves from `terno:unread-filter` (keys that are on) to `terno:list-filter` (`[key, filter]` pairs, newest last, cap 200). The old key is read once and converted.
- **Stickiness** (plan 12 §3) is generalized from "became read" to "no longer matches". The open thread stays until the selection moves: un-starred while starred-filtered, read while unread-filtered. The list's keep-ids path is already generic. Its predicate becomes `matches(filter, row)`.
- **⌘L keeps its exact meaning** (unread ↔ all), as do its menu item, palette command and tests. If another filter is active, ⌘L switches to Unread.
- **The palette** gains "Show: All / Unread / With attachments / Starred".
- **UI per design:**
  - `menu` (macOS, Atelier): today's button toggles Unread. The "Filtered by: Unread ▾" subtitle opens a menu of the criteria, as in Mail. N is shown for Unread only (today's capped count). Other filters show no count: one more count query per change isn't worth it.
  - `chips` (Lumen): All / Unread / Attachments / Starred (People arrives with plan 17).
  - Both write the same state.
  - Empty states per filter reuse plan 12's ("No unread conversations" becomes a per-criterion title, with the same "Clear filter" button and focus rule).
- **Backend:**
  - `threads.list`, `threads.search` and `ThreadScope` take `filter?: "unread" | "attachments" | "starred"` (one normalized predicate: R8). `unreadOnly` stays accepted as an alias of `filter: "unread"`, for older renderers on the web (a service worker may serve a stale shell for one load).
  - **SQLite** (migration v12, indexes only): covering partial indexes shaped like v11's `threads_unread` / `threads_unread_id`, for `has_attachments = 1` and for `is_starred = 1` (all mailboxes, trash and spam included: R9).
  - **IndexedDB:** in-memory recency orders for attachments and starred, maintained where `unreadOrder` is. No schema change.
  - Both stores: a filtered page at 50k threads must stay within plan 12's budget (perf gates in `store.perf.test.ts` and `idb.perf.test.ts`).
- **"People"** (the chip and its thread column) moves to **plan 17**, together with §3.7 (R10).

### 3.7 "Waiting for your reply" (moved to plan 17)

This needs a thread-level "last inbound message is from a person" fact in both stores, which means a store migration with a durable backfill. Codex's review (R10, R11) showed it needs its own lifecycle and ordering contract. It moves to **plan 17** with the People filter. Until then, Lumen's greeting line shows "**N unread**", or "You're all caught up.".

### 3.8 Applying, switching live, first paint

- **Settings:**
  - `AppSettings.design: DesignId` (default `"lumen"`). The patch schema gets `design: z.enum(DESIGN_IDS)`, and the import whitelist gains `design`.
  - `lightTheme` / `darkTheme` accept a new value, `"design"` ("Style colors"), now their default.
  - `resolveTheme` maps `"design"` to `designById(design).palette[mode]`, and the backend's `resolveThemes` accepts it.
- **Migration (both stores, no schema change: settings are a stored object with defaults on read):**
  - `design` absent → Lumen. Every install that never chose a style gets Lumen. That is the request's default.
  - `lightTheme` / `darkTheme` absent → `"design"`, so they also get Lumen's colors.
  - **A stored palette is honored:** someone who picked Dracula, or Terno claro explicitly, keeps it, now under Lumen.
  - Exports written before this have explicit `lightTheme: "terno-light"`, which imports as an explicit choice. That's acceptable and documented.
- **`applyAppearance`** gains the design:
  - It sets `data-design` in the same `data-theme-switching` frame.
  - The `vibrancy` it sends to main becomes `macDesktop && palette.vibrancy && design.vibrancy && !reducedTransparency`. Main needs no change: it already obeys the boolean and caches it for the first window.
  - The cache gains `design`. `theme.js` validates it against the three ids (fallback Lumen) and sets `data-design` before first paint. Its no-cache defaults become `lumen-light` / `lumen-dark` / `lumen`. `useAppearance.design` initializes from `<html data-design>`, so React's first render matches what theme.js painted.
- **A live switch is one frame with structure and styles in agreement:**
  1. Await the new design's font loads (cap 300 ms; latest choice wins, R2).
  2. Capture the anchors (list row id + pixel offset, reader message id + offset: R3).
  3. Set `data-design` (and `data-theme` if "Style colors" changes the palette) **first**, so measurements in step 4 see the new tokens.
  4. `flushSync(() => useAppearance.setState({ design }))`, so React commits the new structure in the same task, before paint.
  5. Restore the anchors.
- **The list re-anchors.** The row height changes, so `ThreadList`:
  - records the first fully visible row before the switch (a layout effect keyed on height);
  - calls `virtualizer.measure()`;
  - restores that row's offset, then keeps the open thread in view (`align: "auto"`).

  The reader's scroll stays proportional to the message the user was on (`keepInView` of the expanded message under the toolbar).
- **Survives a switch, asserted in e2e:** selection and checks, a draft with text and its caret and focus, expanded messages, the unread filter, an open dialog (Settings stays on Appearance), the docked snack. Nothing remounts: variant subtrees swap, but `DraftSlot`, `Conversation` and the dialogs keep their keys.

### 3.9 Settings → Appearance

From top to bottom:

1. **Style:** three cards (macOS, Atelier, Lumen), `aria-pressed` like the palette cards.
   - Each card is a ~200×120 live mini-mock inside its own `data-design` + `data-theme` (that design's palette in the current mode).
   - The mock shows the design's real fonts and radii: a display word, a row in its row variant, its compose control and a chip. Plus a one-line description ("Apple Mail-like, compact, SF" / "Editorial: serif titles, ink and paper" / "Warm and people-first: big avatars, filter chips").
   - Choosing applies live (§3.8) with focus kept on the card.
2. **Mode:** as today.
3. **Colors:** a first card, **"Style colors"**, shows the current design's pair. Then the 13 palettes plus the four new ones, then custom themes (unchanged import, edit and delete). Previews of palettes render inside the *current* design.
4. Motion, HTML mail: unchanged.

The command palette gains "Style: macOS / Atelier / Lumen". A **first-run style step** is out of scope: new installs simply start in Lumen, one click from the others.

### 3.10 The whole app (surface inventory)

Every surface reaches the design through `<html data-design>` and the CSS variables. The table lists what each one needs beyond inheriting tokens.

| Surface | How it's themed |
|---|---|
| Sidebar (nav, sections, categories, accounts, footer: Filters, Local pill, settings) | tokens + `type-section-label`, `type-nav`; variants `compose`, `categoryReview` |
| List header, search, filters, select-all banner, drafts strip, learned banner, report row, web banners | tokens; variants `listHeader`, `search`, `quickFilters` |
| Rows, drag ghost, empty states, skeletons | variant `row`, `--row-h`; the skeleton mirrors the row variant (avatar circle), so loading doesn't shift layout |
| Reader: toolbar, header, conversation, collapsed messages, "N more", attachments, welcome | variants `readerHeader`, `replyAction`; `type-reader-subject`, `type-sender-name`, `type-body`; collapsed and expanded avatar sizes from tokens |
| Inline draft, new message, signature, quote | `draft-surface`; send pill radius from the ladder; fields unchanged |
| Selection bar (bulk) | tokens only |
| Dialogs: settings (and all tabs), filters, add account, shortcuts, first run, confirm dialogs, category picker, report preview | `packages/ui` components read the ladder, fonts and type scale. Dialog titles get `type-dialog-title` (display font under Atelier, 700 under Lumen) |
| Command palette, menus (context, dropdown, select), tooltips | ladder and fonts; glass rules unchanged |
| Docked snack + category snackbar | ladder and fonts; heights stay measured (`snack.inset`) |
| Print sheet chrome | design; **the print document keeps its own fonts** |
| Diagnostics: error boundary, engine stopped, fatal screen, report preview | tokens. The fatal screen renders before settings, so it gets theme.js's cached design |
| Web-only: gate (wrong tab, open errors, updates), nudge, Gmail reconnect, storage section | tokens; cached design from theme.js |
| HTML mail iframes | unchanged: own fonts, colors from `mailColors()` |
| Desktop: traffic lights, vibrancy | the 52 px drag strip stays in every design, so the traffic-light position (20, 19) is unchanged. Vibrancy per §3.8 (Atelier and Lumen sidebars are opaque paper) |

A **source scan** (unit test) fails on raw `font-*` families, `text-[NNpx]`, and `rounded-[…]` above 4 px in `apps/web/src` and `packages/ui/src` outside `designs/`. Sizes and families then come from the scale and the roles, so no surface silently ignores the design. Existing exceptions (the 7 px attachment label, the 10 px kbd) go in a short, commented allowlist.

## 4. Work, in atomic commits

All of this lands after plan 14 merges, on its catalog. Each commit passes typecheck, lint, `pnpm test`, `test:e2e`, `test:web` and `test:ui-perf`.

1. **core + backend:** `DESIGN_IDS`, `DEFAULT_DESIGN`, `design` setting (contract, default, read, patch, import), the `"design"` palette sentinel, the new built-in ids. Unit tests for the migration semantics (absent vs stored).
2. **ui foundations:**
   - `designs/` (types, macos, generator, generated CSS, sync test); `@theme` vs `@theme inline` split; role utilities; icon stroke variable.
   - **macOS only:** every existing screenshot passes untouched.
3. **palettes:** `lumen-*`, `atelier-*`, `unread-ink`; contrast suite green.
4. **fonts:** packages, `fonts.css`, notices, the no-Google scan.
5. **applying:** `applyAppearance` / `theme.js` / cache / `useAppearance.design` / flushSync switch / font preload. theme.js tests.
6. **atelier + lumen definitions** (tokens only; variants still macOS).
7. **variants:** `SenderAvatar`; `row` (+ heights through the virtualizer, re-anchoring); `compose`; `categoryReview`; `listHeader` + greeting; `search`; `readerHeader` + `ThreadChips`; `replyAction`. One commit per variant, each with its parity test.
8. **settings:** Style picker, "Style colors", palette commands.
9. **e2e projects, baselines, layout, axe, perf per design** (§5).
10. **quick filters:** the normalized predicate (renderer, contract, search, scope, bulk), then the v12 indexes for attachments and starred in both stores.
11. **docs:** the maintenance section (§8) in AGENTS.md and README, and the plan "as shipped".

## 5. Tests

- **Unit:**
  - Every definition fills every token and variant (the type, plus a runtime walk for generated CSS completeness). Generated CSS in sync. `DESIGN_IDS` in sync with the registry.
  - Each design's palette exists and has the right mode. No design file contains a color or a duration (the existing scan now covers `designs/`).
  - The font/size/radius source scan (§3.10).
  - `resolveTheme` with `"design"`. Backend: absent → `lumen` and `"design"`, stored palettes kept, unknown design refused, import honors `design`.
  - theme.js: a cached design applied, an invalid one falling back to Lumen, no cache → Lumen palettes.
  - Filter predicates (one table of cases run against the renderer predicate, SQLite and IndexedDB); the stickiness generalization; `terno:unread-filter` → `terno:list-filter` conversion.
- **Component parity:** for each variant value, the accessibility tree (roles and names) and test ids match macOS's for the same data: rows, reader header, sidebar category with review, compose, list header.
- **e2e, design projects:**
  - The fixture gains a `design` option (default `"macos"`, set through `settings.update` before load). **The whole existing suite keeps running under macOS unchanged.**
  - New Playwright projects `e2e-lumen` and `e2e-atelier` run the specs tagged `@design`: triage (j/k, e, #, undo), selection and select-all, compose and inline reply (autosave, send), unread filter and quick filters, reader (expand, "N more", suggestions y/n), categories drag-and-drop onto a category (and the review badge isn't a target), settings walk, snack, print sheet open.
  - A fresh install (`backendOptions.empty`) asserts `data-design="lumen"` and Lumen palettes.
- **Live switch (`designs.spec.ts`):**
  - Mid-scroll list, an open thread, an expanded older message, a draft with text and focus in it, the unread filter on. Switching macOS → Atelier → Lumen → macOS keeps all of it: draft text and caret, selection in view, the anchor row's offset within one row, expanded state, the filter.
  - Focus stays on the Style card.
  - With fonts available (the normal case), there are no `layout-shift` entries after the switch frame, and no `data-theme-switching` is left behind. With a delayed font (web, a routed delay), the switch still completes, text stays visible, and the late swap is the only extra shift (R7).
  - Reload paints the design before React (theme.js), like the palette test.
- **Visual baselines** (1440×900, light and dark, per design): inbox with reader; inline reply open; Settings → Appearance; command palette; a category review list; empty filtered list; snack docked. Existing macOS baselines are unchanged. The new ones are compared by eye against the reference pictures before they're accepted.
- **Minimum window (980×600) per design, light:**
  - No horizontal overflow in any pane (`scrollWidth <= clientWidth`).
  - Every toolbar button inside the reader's box (the pill collapses).
  - The greeting truncates rather than wraps. Chips scroll.
  - The sidebar's compose button and nav aren't clipped, and the last account stays reachable by scrolling.
  - Plus one screenshot per design at this size.
- **Accessibility:**
  - axe (light and dark) on each design with its own palette: main screen, reader, settings (every tab), palette, a dialog.
  - Each design × two other palettes (`solarized-light`, `dracula`) on the main screen.
  - The unit contrast suite covers all 17 palettes × all pairs, so the browser matrix doesn't need to.
  - Keyboard walk of the new controls (compose button, review badge, chips, search button, reply pill) with visible focus.
- **Motion:** every new transition uses `duration-fast/base` (the scan already forbids literals). With motion off or reduced, chips and the search expansion don't animate (`motion.spec.ts` extended).
- **Perf (`perf.spec.ts`):**
  - "j at key repeat" and "scroll 2,000 threads" run **per design × density**, the expected row height read from the definition. Row renders per move stay within today's 3.5 allowance in every design (the two rows whose selection changed, plus rows scrolled in). The DOM row count stays bounded.
  - A design switch with 2,000 rows loaded takes one frame of work under the budget, with no long task > 50 ms.
- **Stores:** filtered pages (attachments, starred) at 50k threads in SQLite and IndexedDB within plan 12's budget, including a dense case (a mailbox where most threads are starred) and an empty one. The ingest perf gate stays within its budget with the new indexes.
- **Desktop:** `dist:mac` + packaged smoke asserts `document.fonts.check('700 24px "Figtree Variable"')` after load under Lumen (fonts packed), and that `data-design` is set before first paint.

## 6. Performance and resources

- **CSS:** three `[data-design]` blocks of ~80 variables and three font-face sets. Variable lookups cost nothing measurable. No JS is added to the hot path. Variants are plain components chosen once per render. Rows gain at most one span (the avatar).
- **Entry chunk:** variant components are small and needed on first paint, so they stay in. The Style picker is in the lazy settings chunk. Entry size before/after is reported.
- **Fonts:** only the active design's faces load (§3.5). The web service worker precaches all of a build's assets, so a web user downloads the other designs' woff2 once without using them. That is accepted for offline switching, as plan 14 did for the Spanish chunk.
- **Idle:** the greeting's single next-boundary timeout is the only new timer, cleared while hidden.
- **Memory:** the IndexedDB orders for two more filters are bounded by the thread count (ints).

## 7. Out of scope

- **AI thread summary card** (Lumen's "Resumen"): a new AI capability, not a presentation change. It needs:
  - a prompt and structured task in `@terno/ai`;
  - local-mode and provider rules;
  - an explicit on-demand trigger (never background calls);
  - a bounded per-revision cache that must not leak into settings exports;
  - cancellation and errors;
  - its own privacy review.

  **Dropped by the user (2026-10-25): no AI summary card.** The `sender-card` header has no slot for it.
- **Photo and logo avatars:** no local source. Fetching them would leak addresses.
- **A second icon set** (Phosphor for Atelier).
- **Per-design window chrome** (traffic-light moves, title-bar heights).
- **The thread total** in Atelier's subtitle.
- **A first-run style step.**
- **The People filter and "waiting for your reply"**: plan 17 (store migration with a backfill; R10, R11).
- **User-defined designs** (custom themes stay colors-only).

## 8. Maintenance: "How to add or change a design" (goes into AGENTS.md and README)

> **Designs** (`packages/ui/src/designs/`): typography, shape, density and a closed set of structural variants; colors stay in palettes (`themes/registry.ts`).
> - *Change a design:* edit its file (`lumen.ts` …), run `pnpm --filter @terno/ui gen:designs`, update the visual baselines for that design only (`pnpm test:e2e --project e2e-lumen --update-snapshots`) and look at them in light and dark.
> - *Add a design:* add its id to `DESIGN_IDS` (`@terno/core`), copy the closest definition, give it a palette pair (add palettes to the registry if it needs its own; the contrast suite must pass), add `en`/`es` names and descriptions, add a Playwright project. The type forces every token and variant decision.
> - *Add a variant value:* add it to the union in `designs/types.ts`; the compiler then points at every `variant(…)` map that must implement it. Keep roles, names, test ids and shortcuts identical (the parity test checks).
> - *Rules:* no colors or durations in a design; text only on pairs in `CONTRAST_PAIRS`; sizes, families and radii only from the scale and roles (the source scan); motion within `--motion`.

## 9. The user's decisions (2026-10-25)

1. **The AI summary card is dropped.** People and "waiting for your reply" go to plan 17; Lumen ships without the People chip and without the reply count.
2. **Everyone moves to the full Lumen look** (Lumen and "Style colors"), since picture 2 is the default. A theme chosen before is remembered and offered first under Colors ("Your previous theme"), one click away, but no longer applied. This replaces §3.8's "a stored palette is honored".
3. **"macOS"**, Apple's spelling, is the name of the current look.

## 10. Revisions after the Codex review

Codex (`codex exec -s read-only`) made 12 points against the code. All are accepted. They are numbered R1–R12, the references used in the body above, which was updated where it was wrong (scope, fonts, switch order, perf allowance). The details:

1. **Nested font resolution.** In `@theme` (non-inline), `--font-sans: var(--theme-font, …)` is resolved where it is declared (`:root`). A nested palette preview with another `--theme-font` would inherit the outer, already computed font.
   - Every `[data-design]` block declares `--font-sans`, `--font-display` and every role variable that references them, as literals. Under macOS, `[data-design="macos"] [data-theme]` redeclares `--font-sans: var(--theme-font, …)` so the Apple palette's font still applies in its preview card.
   - Computed-style tests: nested `text-sm`, `rounded-md`, `font-sans` under a nested design and palette.
   - The radius record covers the whole ladder used today (`sm` … `4xl`; `badge.tsx` uses `rounded-4xl`).
2. **Switch ordering and races.**
   - CSS goes in before the React commit (see §3.8), so layout effects measure new structure with new tokens.
   - The font wait happens in `updateAppearance` before the optimistic `show()`, behind a sequence number (the latest choice wins, and a stale wait is dropped). Bootstrap, `adoptSettings`, imports and rollbacks apply at once, without waiting (fonts swap).
   - `applyAppearance` stays synchronous.
   - In the reader, the variant component renders **only the header**. `MessageMenu`/`Conversation` and `DraftSlot` are siblings under a stable parent whose element type never changes, so their state survives (keys alone wouldn't across replaced ancestors).
3. **Anchors are captured before anything changes.**
   - `ThreadList` registers a capture callback with the switch coordinator: the first visible row's id and its pixel offset from the scroller top.
   - After CSS and React agree: `virtualizer.measure()`, then restore that row's offset. The open thread is revealed only if it was visible before.
   - The reader captures the message at the top of its viewport and its offset (not `keepInView`, which only ensures visibility) and restores both.
4. **Caches from the previous version.**
   - The appearance cache gains `v: 2` and `design`. theme.js reading a v1 cache paints `design = lumen`. It maps the old default ids (`terno-light`, `terno-dark`) to Lumen's palettes and keeps any other cached id (or custom tokens) as an explicit choice. The rare user who explicitly chose Terno claro sees Lumen colors until bootstrap answers (one frame-level correction, once).
   - Desktop main's saved appearance may still say "vibrancy" for the first launch after the update. Harmless: with no `data-vibrancy`, the page paints an opaque body over it. The renderer's first `setAppearance` corrects it.
   - Tests cover the v1 → v2 cases (absent choice, explicit palette, custom tokens).
5. **Backend validation of `"design"`.**
   - `themeMode()` (patch validation, settings.ts:237, also used by import) accepts `"design"` for both modes.
   - `resolveThemes` keeps the sentinel. A deleted custom theme in use falls back to `"design"` instead of `DEFAULT_THEME[mode]`. The renderer resolves the sentinel.
   - Tests: unrelated patches (density, motion) against absent and explicitly stored palette keys; import of both.
6. **Contrast where avatars and stars are actually drawn.**
   - `inkFor()` also considers `row-hover`, `row-selected`, `accent` (checked rows), `sidebar` and `pane`.
   - `CONTRAST_PAIRS` adds `cat-*-ink` on its 15% tint over those surfaces, and `star` on `row-selected`, `row-hover` and `accent`.
   - These prove every palette for every design's avatar rows before the "all combinations pass" claim is made.
7. **Fonts.** `font-display: swap` instead of `block`; a 150 ms bounded wait before the first render; required faces listed per design (Figtree 400/500/600/700; Instrument Sans 400/500/600; Instrument Serif 400 normal and italic), with samples that include Spanish and latin-ext text. The promise is now "no layout shift when fonts are available"; a delayed or failed font is tested (§5).
8. **One normalized filter predicate.**
   - `@terno/core` exports `ListFilter` and `matchesFilter(filter, summary)` (the renderer's stickiness and `ThreadRow`'s in-scope check, which today reads `scope.unreadOnly`).
   - It also exports SQL and IndexedDB predicate builders used by `threads.list`, `threads.search` (whose schema and handler only know `unreadOnly` today), `ThreadScope` resolution in `backend/src/scope.ts` (bulk actions), and `scopeCount`.
   - `unreadOnly` is still accepted everywhere as an alias of `filter: "unread"`.
   - One table of cases is run against the renderer predicate and both stores.
9. **Starred in every mailbox.** `threads_starred` excludes trash and spam, so it can't serve a Starred filter there. v12 adds `threads_starred_f` and `threads_starred_f_id` (covering, `WHERE is_starred = 1`, like v11). Tests check list, count and scope parity in Trash and Spam, and dense and empty starred mailboxes.
10. **People and its backfill leave this plan.** A durable, restartable, cancellable backfill coordinated with message hydration (IndexedDB loads messages after threads) and concurrent ingest, plus version compatibility in both stores, is a separate risk from an appearance change. **People and "waiting for your reply" move to plan 17.** v12 here is indexes only (like v11), with no backfill.
11. **Reply tracking's ordering and expiry** (the "latest" message excludes hidden ones; recompute doesn't read `list_id` or `is_draft`; counts take no clock) go into plan 17's spec with an injected clock and an expiry refresh policy.
12. **Test wiring.**
    - `test:e2e` runs `--project=e2e --project=e2e-lumen --project=e2e-atelier`, and the `:update` script likewise.
    - The design projects set their own `snapshotPathTemplate` (`__screenshots__/<design>/…`), so macOS baselines keep their paths.
    - The fixture sets the design only for seeded backends unless a test asks, so fresh-install tests see the real default.
    - A shared `search(page, q)` helper opens the search button when the field is collapsed, and the native web suite (`e2e-web/web.spec.ts` fills `search-input` directly, on a fresh install, so in Lumen) uses it.
    - The two Appearance-tab baselines (`themes.spec.ts`) change deliberately (the new Style section). "Unchanged" applies to every other baseline.
    - The perf gate keeps the 3.5 renders-per-move allowance.

## 11. Re-check after plans 11 and 14

Plans 11 (in-app updates) and 14 (i18n) merged before implementation. What changed for this plan:

- **Copy goes through `@terno/i18n`.** Every new string is a key in `en.ts` and `es.ts` (style names and descriptions, the greeting, "N unread", the quick filters and their empty states, the review badge, the palette's Style commands, "Style colors", "Your previous theme"); the source scan catches literals. Design and palette names are catalog strings too (Terno's own themes already were, plan 14).
- **The language switch remounts the tree** (`localeEpoch`); a design switch doesn't: it re-renders the variants in place (flushSync), so the two never interfere. Both caches are read by `theme.js`/`initLocale` before the first frame, and `main.tsx` now waits for both (the locale chunk, up to 150 ms for the design's faces).
- **Plan 11's update pill** lives in the sidebar footer: it takes the design's fonts and radii like everything else and was looked at in every design (the popover included); `updates.spec` runs in the three designs.
- **Backend errors are descriptors** (plan 14 R5): the settings validation's message for "design" needs nothing new.

## 12. As shipped

### Commits

1. `df011f6` palettes: Lumen and Atelier, light and dark; `unread-ink`; badge inks proven on rows, drafts and panes.
2. `c7e0e6f` fonts: Figtree, Instrument Sans, Instrument Serif from fontsource.
3. `beb1e62` designs: definitions, generated variables and type roles; Tailwind's scale, radii and fonts on design variables; typography out of palettes.
4. `1c2bb40` the `design` setting and the move to Lumen; applying in one frame; theme.js cache v2.
5. `c5cbb75` variants: rows, sidebar, list header, reader header, reply pill.
6. `049ab6d` quick filters: unread, with attachments, starred (both stores, SQLite v12).
7. `c738e39` Settings → Appearance: Style, Style colors, the previous theme.
8. `a4e2692` fixes from looking at every design and from axe.
9. `c35f8da` e2e: design projects, layout, parity, axe, switching, the move.
10. `e763b91` perf gates per design and density; the switch gate.
11. `223196f` the web suite in Lumen; same-origin fonts.
12. `153cd7e` radii on the ladder; the source scan.
13. `67e34f1` the packaged smoke in Lumen.

### Departures from the plan

- **Everyone moves to Lumen** (the user's decision, §9): `migrateAppearance` turns a stored settings object without `appearanceVersion` into Lumen with "Style colors", keeping its palettes as `previousLightTheme`/`previousDarkTheme`. It runs on read and is persisted by the next write (unrelated ones too), so choosing a design later never brings the old palette back. An import from before designs is treated the same way.
- **Fonts moved out of palettes entirely**, instead of redeclaring `--theme-font` under macOS (R1): the Apple palette's font was SF on a Mac either way. Type, radii and fonts stay in `@theme inline`, pointing at `--ds-*` variables, so utilities resolve where they're used and a nested design (the Style cards) draws in its own.
- **The radius ladder** is per design (`sm` … `4xl`), not one `--radius` multiplied; fixed 10 px corners became `calc(var(--radius-lg) + 2px)` (the same in macOS).
- **The review badge** sits after the unread count, not before it: the count is inside the category's button (a drop target, and part of its name), the badge is its own control drawn over the row's end.
- **Lumen's search** stays open on blur (F6 to the snack and back would otherwise lose focus); it closes on Esc in an empty field or when another mailbox opens.
- **Atelier and Lumen cap their list at 32vw** so the reader keeps its toolbar at 980 px; macOS keeps its fixed width.
- **The header compose icon is macOS-only** (Atelier has its sidebar button; two buttons with one name were noise).
- **Stars on rows**: the older palettes' gold sits at 2.4–3:1 on hovered and selected rows (only ever checked on the background); the four new palettes hold 3:1 there (`STAR_ON_ROWS`), the older ones are left as they are.

### Bugs found while building

- `stroke-(--var)` in Tailwind v4 sets the stroke *color*: the reader's toolbar icons vanished in Lumen. An explicit `stroke-width` now.
- `text-unread-ink` drew nothing until the token got its `--color-*` entry.
- Base UI radio items stay open on choice: the "Filtered by" menu reopened as closed. `closeOnClick`.
- The Local pill drew the sidebar's accent as text on the sidebar, a pair never checked (3.7:1 in Terno Light): `sidebar-primary-ink`, proven for every palette.
- The Reply pill's `aria-label` didn't match its visible "Reply R" (axe: label in name).
- Pre-existing, not changed here: the dwell's mark-as-read invalidates the open thread's cache, so the reader shows its skeleton for a moment and focus inside the reader is lost (macOS too). Noted for a follow-up.

### Measured

- `j` at key repeat, every design × density: row renders per move 2.95–2.98 (gate 3.5), frame p95 16.8 ms.
- 2,000-row scroll, every design × density: frame p95 ≤ 16.8 ms, DOM rows ≤ 80.
- Design switch with hundreds of rows loaded: its frame 16.7 ms (every switch asserted ≤ 50 ms after one pass that fetches the faces).
- Searches narrowed to conversations with attachments, SQLite at 50k threads: ≤ 10.2 ms a page (broad words, `in:all`, a prefix), ~0.05 ms with none having attachments; the instant index on one 50,000-message conversation with 1,000 date-rejected candidates: 0.19 ms.
- Fonts (latin): Figtree 20 KB, Instrument Sans 30 KB, Instrument Serif 21 + 22 KB; latin-ext 10–12 KB each, fetched only when text needs them.

## 13. What the Codex code reviews changed

Three rounds (`/tmp/unica-scratch/review-15.txt`, `review-15b.txt`, `review-15c.txt`); every finding fixed, each with a test that fails without the fix.

Round 1 (`2c14ff4..42fa077`, 6 findings):
1. **"With attachments" in a search** was `has:attachment`, which every engine tests per message: a conversation whose attachment and match were in different messages disappeared (`88b0dcb`, then round 2 #1).
2. **Going back to the current design** didn't cancel a switch still waiting for its faces (`de4af8e`).
3. **The list anchor** was restored with the wrong sign, and an open thread under the top edge was "revealed" through the virtualizer's own (stale) scroll (`c57e424`): the live-switch test now asserts the same top row at the same depth.
4. **The switch perf gate** could read an empty sample as 0 ms and only asserted the median (`e37a0d7`).
5. **No mailbox-scale gates for the new filters** in either store (`9c83f97`).
6. **The palette's ⌘L item** said "Show all" while ⌘L switched to Unread (`c7bd461`).

Round 2 (on round 1's fixes, 3 findings):
1. **Post-filtering a search's pages** for attachments paged and hydrated the whole match set (13 s at 50k threads, nothing kept): every engine now applies `threadAttachments` before paging (SQLite `t.has_attachments`, the IndexedDB scan's thread row, the instant index's thread docs), with a conformance test and gates (`a4b40e2`).
2. **A page in flight for the last list** held the next list's own paging (`a4beafe`).
3. **The IndexedDB gate** timed counts without asserting them; dense and empty cases added (`a4b40e2`).

Round 3 (on round 2's fixes, 2 findings):
1. **The last list's cursor survived navigation**: paging before the new list's first answer continued the old scope (`08e428b`).
2. **The instant index re-walked a long conversation** per date-rejected candidate (105 ms for one 50,000-message conversation): each thread's answer is kept per query (`083f70c`).

Also removed: Lumen baselines that a full non-gate pass (`E2E_DESIGN_ALL=1`) had written for untagged specs (`0404a51`).

### Verification (after the fixes)

`pnpm typecheck`, `pnpm lint`, `pnpm test` (1,868 unit + 395 db-wasm), `pnpm test:e2e` (556: the whole suite in macOS, the `@design` flows and designs.spec in Lumen and Atelier), `pnpm test:web` (29), `pnpm test:ui-perf` (26, including j/scroll per design × density and the switch gate), `pnpm test:perf` (112), `pnpm dist:mac` and the packaged smoke (38). Known flake under full parallel load, passing on reruns: `print.spec` "from the toolbar … and the palette" (as in plan 14). Screenshots of every design in light and dark (main window, 980×600, reply, compose, every settings tab, palette, shortcuts, print sheet, filters dialog, add account, selection, the filter on, context menu, the update pill and popover, first run, the web gate): `/tmp/unica-scratch/designs-15/`.
