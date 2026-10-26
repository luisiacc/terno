# Plan 19: the Terno logo, everywhere it belongs

- **Status:** in progress.
- **Builds on:** `402470a` (main after plan 18).
- **Request (verbatim):** "we have a logo now , its on `/Users/Luis/Downloads/terno-logo/` folder, lets use it wherever we need here and have its assets"
- **Plan 17** is reserved for People / waiting-for-reply.

## 1. What exists

- **The logo** (Downloads, read-only input): `svg/terno-icon.svg` (a `#2F5BFF` rounded square, 100-unit viewBox, `rx 24`, with a white T over an envelope drawn at 45 % opacity), `terno-mark-blue.svg` / `terno-mark-white.svg` (the T and envelope alone, viewBox `14 14 72 72`; the blue one draws the envelope at 35 %), `terno-wordmark.svg` (`#14161A`), `terno-lockup.svg` / `terno-lockup-white.svg`; PNG exports of each.
- **Desktop:** `apps/desktop/resources/icon.{icns,png,svg}` is a placeholder (an indigo envelope), drawn by hand. `package.mjs` gives electron-builder `mac.icon: resources/icon.icns`. The DMG is `hdiutil create -srcfolder Terno.app` (no volume icon). The app menu's About uses Electron's standard panel (role `about`), which shows the bundle's icon when packaged and Electron's in dev. electron-builder is 26.15.3: `mac.icon` also accepts an Icon Composer `.icon`, which it compiles with `actool` (Xcode 26+) *at package time* into `Assets.car` (+ `CFBundleIconName = Icon`) and replaces the `.icns` with actool's own rendering.
- **Web:** `index.html` has a `<title>` and nothing else: no favicon, touch icon or theme color. The web build's Vite plugin already emits `manifest.webmanifest` (no icons) and links it; the service worker precaches `./`, `theme.js` and the bundle. `public/` holds only `theme.js`, and it is copied into both targets.
- **In-app:** the reader's empty state (`Welcome`, `reader.tsx`) draws a placeholder tile: a `bg-tint` rounded square with a muted "T", above "Terno" and the tagline. The first-run dialog, the web's blocking screens (`web/gate.tsx`: another tab, starting, errors) and Settings → Updates (footer "Terno 0.1.0") carry no mark.
- **Rules that bind the mark:** no literal colors or reduced-opacity utilities in app code (`no-hardcoded.test.ts`), text only on `CONTRAST_PAIRS`, sizes from the scale (`source-scan.test.ts`), all three designs × light and dark.
- **README** opens with `# Terno` and the tagline.

## 2. Assets in the repo

- `brand/` (repo root): the six source SVGs, byte for byte. These are the "assets"; everything else is derived from them.
- **One command:** `pnpm brand` (root) → `pnpm --filter @terno/ui gen:brand` → `packages/ui/scripts/gen-brand.ts`. Like `gen:designs`, the pure part (`packages/ui/src/brand/generate.ts`: parse the SVGs, build every text output) is separate from the CLI (rasterize, `iconutil`, `actool`), so a unit test can run it.
- **What it reads from the icon:** the tile's color, and its shapes split by role: solid shapes are the T, translucent ones the envelope (with their opacity). A new logo with the same structure regenerates everything; a different structure fails loudly in the parser.
- **Rasterizing:** Playwright's Chromium (already used by the e2e suite; `@playwright/test` becomes a dev dependency of `@terno/ui`), each size drawn from the vector rather than downscaled, transparent background. `iconutil` builds the `.icns`; `actool` (Xcode 26) compiles the Tahoe asset catalog. The script refuses to run without them, and says what to install.
- **`brand/generated.json`:** the sha256 of every source and every binary output. A unit test recomputes the text outputs and compares them byte for byte, checks the source hashes (an edited SVG without `pnpm brand` fails) and the binary hashes (a hand-edited PNG fails). No rasterizing in the test, so it stays cheap and doesn't depend on Chromium's anti-aliasing.

## 3. macOS app icon

### 3.1 The legacy `.icns` (every macOS)

- Drawn on Apple's macOS grid: a 1024 canvas, the body an **824 × 824 continuous-corner rounded square** inset 100 px, corner radius 185.4 (Apple's template), with Apple's soft drop shadow in the margin. The continuous corner is the iOS-7/Big Sur curve (three cubic Béziers per corner reaching 1.528 r along each edge), not a circular `rx`.
- The mark keeps its proportions relative to the tile (the 100-unit icon maps onto the 824 body).
- The generator writes `resources/icon.svg` (that drawing, text), renders the ten iconset sizes (16 … 512 @1x and @2x) and runs `iconutil` → `resources/icon.icns`; `resources/icon.png` (1024) is the dev Dock icon (§3.4).
- Why: a full-bleed square is ~20 % bigger than every other Dock icon, and Tahoe puts icons whose alpha doesn't match its rounded-square mask into a gray tile ("icon jail"). An icon on the grid avoids both on Big Sur … Sequoia, and is what Tahoe falls back to without an asset catalog.

### 3.2 The Tahoe icon (`Assets.car` from an Icon Composer `.icon`)

- `resources/icon.icon/` (text, generated): `icon.json` with the brand blue as the solid fill and two layers, the envelope (white, its opacity) under the T (white), each an SVG on the full 1024 canvas. Tahoe draws it with Liquid Glass, and generates its dark, clear and tinted appearances from it.
- **Compiled once by the generator, checked in:** `actool --compile … --app-icon Icon --platform macosx --minimum-deployment-target 26.0` → `resources/Assets.car`. `package.mjs` ships it as an extra resource (`Contents/Resources/Assets.car`) and sets `CFBundleIconName = Icon` (`extendInfo`), next to `CFBundleIconFile = icon.icns`. macOS 26 reads the catalog; older systems the `.icns`.
- **Why not `mac.icon: icon.icon`** (electron-builder compiling at package time): it would make Xcode 26 a requirement of every `pnpm dist:mac` and of every update-test build (`package.mjs` runs for those too), add an `actool` run to each, tie the shipped bytes to whatever Xcode the packaging machine has, and replace our grid `.icns` with actool's rendering. Compiling in `pnpm brand` keeps packaging deterministic and Xcode-free; the cost is a checked-in binary, which the hash manifest keeps honest. Same two plist keys and file as electron-builder's own path.
- `package.mjs` verifies the packaged bundle: `Assets.car` present, `CFBundleIconName` = `Icon`, `CFBundleIconFile` = `icon.icns`.

### 3.3 DMG volume icon

- The mounted DMG shows Terno's icon instead of a generic disk: `hdiutil create` from a staging folder holding `Terno.app` and `.VolumeIcon.icns` (a copy of `icon.icns`), with the folder's custom-icon flag set (`SetFile -a C`, Xcode command-line tools; skipped with a note when missing). Verified by attaching the DMG read-only to a private mount point (`-nobrowse -mountrandom`) and checking the flag, then detaching that device.

### 3.4 Dev and About

- Dev runs (`!app.isPackaged`) call `app.dock.setIcon(resources/icon.png)`, so `pnpm dev:desktop` shows Terno, not Electron, in the Dock and in the standard About panel (which uses the application icon). Packaged builds use the bundle's icon; nothing changes there.

### 3.5 Verification

`pnpm dist:mac`, then: render the packaged `icon.icns` (`sips` → PNG) and `Assets.car` (`assetutil --info`; a Finder/Dock screenshot of the built app if the session allows), compared side by side with Finder neighbors; `pnpm --filter @terno/desktop test:smoke`. Screenshots to `/tmp/unica-scratch/logo/`.

## 4. Web

- `public/` (generated): `favicon.svg` (the tile itself, so it reads on light and dark tab strips without a media query: the brand blue with a white mark is legible on both), `favicon-32.png` and `favicon-16.png`, `apple-touch-icon.png` (180, full-bleed: iOS rounds it), `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (full-bleed square, the mark inside the 80 % safe circle).
- `index.html`: `<link rel="icon" href="./favicon-32.png" sizes="32x32">`, `<link rel="icon" href="./favicon.svg" type="image/svg+xml">` (browsers with SVG support take it; `sizes` keeps Chrome from preferring the PNG), the touch icon, and `<meta name="theme-color">` for light and dark (`prefers-color-scheme`) set to the default palettes' backgrounds. A unit test derives those two values from the registry, so a palette change can't leave them stale. The title stays "Terno".
- The manifest (web build only, already emitted) gains `icons` (192, 512, maskable 512) and the same theme/background colors; the service worker precaches the icon files with the shell (a few KB) so an offline start still has them.
- Relative URLs (`./`), like the rest: the app is served from any path.

## 5. In-app

- **Component:** `packages/ui/src/brand/terno-mark.tsx`, inline SVG from `mark.generated.ts` (geometry only, emitted by the generator from `terno-mark-blue.svg`). No image request, no new chunk: ~1 KB in the entry chunk.
  - **Monochrome, from tokens:** every shape is `currentColor`; the envelope keeps the logo's own translucency (an SVG `stroke-opacity`, not a utility class). A logo is outside WCAG's contrast requirement, and the T, the part that reads, sits on a contrast-tested pair because the caller colors it with a text token.
  - **Decorative by default** (`aria-hidden`, no focus): every place below names "Terno" in text next to it. With `title`, it is `role="img"` with that name.
- **Why not the blue tile in the app:** a saturated `#2F5BFF` square is the loudest thing on the screen in Lumen's warm paper, Atelier's ink and the dark palettes, and the brand blue isn't a token (each palette has its own `primary`). A quiet mark in the surrounding text color reads like Apple Mail's and t3code's empty states and holds in every design and palette. The colored icon stays where the OS shows it (Dock, Finder, tabs, home screens).
- **Where:**
  1. **Reader empty state:** the mark (40 px, `text-muted-foreground`) replaces the "T" tile above "Terno". Same size and position, so the layout doesn't move.
  2. **First run, step 1:** a small mark (28 px, `text-foreground`) above "Welcome to Terno", the first thing a new user sees.
  3. **Web blocking screens** (`gate.tsx`'s `Screen`: another tab, starting, stale build, errors): the mark above the title, in `text-muted-foreground`, so a full-window state still says which app it is.
  4. **Settings → Updates footer:** a 14 px mark before "Terno 0.1.0" (what an About box shows).
- **Not:** the sidebar, toolbars, the print header (a printout is the user's mail, as in Apple Mail), notifications (the OS adds the app icon), avatars (plan 15: initials only).

## 6. README

`<picture>` at the top: `brand/terno-lockup-white.svg` for `prefers-color-scheme: dark`, `brand/terno-lockup.svg` otherwise, with `alt="Terno"`, ~48 px tall; the tagline stays below. A short "Brand" note in the Quick start's commands: `pnpm brand` regenerates every icon from `brand/`.

## 7. Copy (en + es)

No new UI strings: the mark is decorative where shown, next to the existing "Terno" text. (If the review asks for a named image, `brand.logo` = "Terno" in both.)

## 8. Tests

- **Unit** (`packages/ui/src/brand/brand.test.ts`): text outputs equal the generator's (icon SVG, `.icon` JSON and layers, favicon, `mark.generated.ts`); source and binary hashes match `brand/generated.json`; the parser splits the icon into tile / T / envelope and rejects an SVG without a tile; the squircle path is symmetric and stays inside its box; `index.html` links every icon that exists in `public/` and its theme colors equal the default palettes' backgrounds; the manifest emitted by the Vite plugin lists icons that exist.
- **Desktop:** `package.mjs` asserts `Assets.car`, `CFBundleIconName`, `CFBundleIconFile` in the packaged app; the smoke test (`packaged.smoke.ts` or a new one) reads the packaged `Info.plist` and checks `Resources/Assets.car` and `icon.icns` exist.
- **e2e** (`apps/web/e2e/brand.spec.ts`, tagged `@design` so it runs in all three): the reader's empty state shows the mark, `aria-hidden`, with "Terno" as text; the first-run dialog shows it and its accessible name is still "Welcome to Terno"; axe on the empty state (light and dark); the page's favicon links resolve (200, right type).
- **Web e2e** (`e2e-web`): the gate's starting screen has the mark; the manifest has icons, and each resolves.
- **Baselines:** only those whose pixels change because of the mark (expected: `first-run.png`, possibly empty-state shots); each updated baseline is looked at.

## 9. Performance and resources

- Entry chunk: +~1 KB (the mark's geometry and a 15-line component). No new request on the hot path: favicons are fetched by the browser once and cached; the desktop never requests them.
- App bundle: `Assets.car` and the `.icns` replace the placeholder `.icns` (≈ same size order); the generator never runs at build or package time.

## 10. Out of scope

- A DMG window background or Applications shortcut, Windows/Linux icons, a marketing site, an animated mark, per-palette colored icons.
