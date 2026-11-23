# Plan 248: any font on the computer, previewed as you go

## The request

> ok for the font we must have a way for them to type the font name or pick from the entire system the font they want, it should update automatically so they can preview it, there should also be a button to go back to that style defaults font, make sure this is intuitive and cleanly done, with great and simple ux

## What exists (plan 245)

- `designFonts: Partial<Record<DesignId, FontId>>`: a style's chosen font, one of five bundled ids (`TYPEFACES` in `packages/ui/src/designs/typefaces.ts`). No entry is the style's own.
- Painting: `[data-design][data-font="<id>"]` blocks in `designs.generated.css` set `--ds-font-sans`, `--ds-font-display` and the features; `applyAppearance` sets `data-font` on `<html>`, `theme.js` paints it from the cache before React, previews carry it beside `data-design`.
- Choosing: `setStyleFont(design, font)` waits for the faces of the style in use, then queues the choice as an intent (a refused one never comes back inside a later map).
- Settings → Appearance → Font: a `Select` of the five, each in its own font, the style's own marked.

## What the platform gives

- `window.queryLocalFonts()` lists the installed faces. Checked on this Mac in Electron 45 on a secure custom scheme like ours (`app://`): 302 families from 1,317 faces, no permission prompt and no user gesture needed (Electron approves permission requests when the app sets no handler, which is documented; the main window sets none). Electron's docs list `local-fonts` as a permission. On the web it exists in Chromium behind a prompt; Safari and Firefox don't have it.
- An installed font needs no loading and no `font-src` (the CSP's `font-src` governs fetched faces only).
- Base UI's Autocomplete (our `Combobox`, plan 203) supports `virtualized`, `onItemHighlighted` and `openOnInputClick`; `@tanstack/react-virtual` is already used by the list and the feed.

## Design

### The choice

`StyleFont` (`@terno/core`) is a bundled `FontId` or `local:<family>`, a family installed on the computer. The family is a name, never CSS: 1–100 characters, no quotes, backslash, semicolon, braces, angle brackets or control characters, no space at either end (`isStyleFont`, shared by the contract, the backend's sanitizer and `theme.js`'s copy of the rule, kept in sync by a test). `designFonts` becomes `Partial<Record<DesignId, StyleFont>>`. A stored family the computer no longer has still paints: the stack falls back to the style's own font.

### Painting a family

- `generate.ts` writes one block per design: `[data-design="lumen"][data-font="local"] { --ds-font-sans: var(--local-font, <Lumen's own stack>), <Lumen's own stack>; --ds-font-display: …; --ds-font-features: normal; font-feature-settings: normal }`. Only the family's quoted name lives inline, as `--local-font` on the element carrying `data-design`: on `<html>` (`applyAppearance`, and `theme.js` before React), or on a preview. Missing family → the style's own font, with no script.
- One helper decides the attributes for any font: `fontPaint(font) → { "data-font", style }` in `designs/index.ts`, used by `applyAppearance`, the Style cards, first run's preview and specimens, and the font list's rows. `withFont` learns `local:`; it keeps the style's own faces, which a family that's gone falls back to.

### Preview without saving

`previewStyleFont(font)` in `appearance.ts` paints a font on `<html>` (only `data-font` and `--local-font`: no React state, no save, no anchors), `previewStyleFont(undefined)` paints the saved one back. `applyAppearance` paints the preview while one is on, so an unrelated settings change during it doesn't end it. The launch cache only ever holds the saved font.

### The field

The Font row's control becomes a font field: a text field showing the font in use, with its list under it.

- **Opening** (a click, focus by Tab then ↓, or typing) lists every font: the five Terno ones first, then the installed families A–Z (`installedFamilies()`, read once when the field is first opened, and kept; nothing runs until then). Each row's name is drawn in its own font; Terno's rows carry a quiet "Built in", the style's own "Style's font". An installed family with a Terno font's name (Inter, Geist…) shows once, as Terno's.
- **Typing** filters as you type, ignoring case and accents, names that start with it first. The first match is highlighted.
- **Previewing:** whatever is highlighted, by the arrows, the pointer or typing, is painted on the whole app at once, Settings included, without being saved.
- **Choosing** (Enter or a click) saves it for the style in use and closes the list; the field shows its name. **Esc** or leaving the field without choosing puts the saved font back.
- **Typing a name the list doesn't have:** with the list, "No installed font called “X”." Without one (a browser that can't list fonts, or a refused prompt), the list offers "Use “X”", previewed like any other: what you see is what you get.
- **Back to the style's font:** a quiet ghost button beside the field, "Use Figtree" (the style's own font by name), shown only while the style has another font. It sits to the field's left, so the field never moves. Picking the style's own font in the list does the same.
- The hint: "For Lumen. Pick or type any installed font. Each style keeps its own."

The list is virtualized (TanStack, through Base UI's `virtualized`): ~300 families draw only the rows in view, so only their fonts are read. A unit test asserts the rendered row count.

`Combobox` gains a picker form (BOARDUI.md deviation): no search glyph or clear button, the chosen item reported through `onChoose` (the search's swallowing of `item-press` stays for the search), the highlight reported, and virtualization passed through.

### Backend, import, cache

The patch schema, the read sanitizer and `theme.js` accept `local:` families with the shared rule. Export and import carry them as they are.

## Tests

- core: `isStyleFont` (the five, a family, every refused character, length, spaces at the ends).
- ui: the `local` blocks per design and their fallback; `fontPaint`; `withFont` with a family.
- web unit: preview paints and restores, survives an unrelated apply, never reaches the cache or the backend; choosing a family saves `local:<name>`; the reset; `installedFamilies` (dedupe, sort, hidden names and invalid names dropped, read once, `null` when the API is missing or refused); the field's filter order; the rendered row count with 1,000 families.
- `theme-script.test.ts`: a cached family paints `data-font="local"` and `--local-font`; a tampered one paints nothing.
- backend: a family persists; a tampered one reads as the style's own; the patch refuses one with a quote.
- e2e (`designs.spec.ts`, with `queryLocalFonts` stubbed to a fixed list so it's the same on every machine): open, type, the highlighted font previews on `<html>` and in Settings, Esc puts it back, Enter saves, the reset button brings the style's font back; a reload paints the family before React; the "Use “X”" path with the API absent.
- Smoke (`pnpm test:smoke`, packaged): the field lists this Mac's installed families.

## Performance and resources

Nothing runs until the field is opened; the family list is read once (tens of ms) and kept in memory (~300 short strings). Rows are virtualized. A preview is two attribute writes on `<html>`, no React render; a choice is the existing save. No network: installed fonts are local by definition, and the list never leaves the renderer.

## Out of scope

- Font size, weights, a separate display or reading font.
- Fonts from files or URLs.
- A permission handler for the main window (Electron's default today, unchanged by this plan; worth its own look).

## Revisions after the Codex review of the plan

Twelve points. What changed:

1. **Launch reads the whole font back.** `paintedFont()` rebuilds `local:<name>` from `data-font="local"` and `--local-font`; the first render's state, `main.tsx`'s face wait and `settingsFaces` all use it.
2. **The fallback inside `var()` is the style's own stack**, not `ui-sans-serif`, so a preview's first frame without the name draws the style's font.
3. **A family keeps the style's faces** (its fallback), so a family that's gone still waits for them at launch.
4. **A look keeps the list's and the reader's places**: each preview paint is wrapped in `captureDesignAnchors()`, as a real font change is.
5. **The handoff from look to choice:** `setStyleFont` ends the preview only when it previews exactly what's being kept, at commit, so there's no frame of the old font during the face wait, and a newer look (the list opened again) survives an older choice's commit. The field ignores highlight changes once a choice is made or the list is closing.
6. **A look's life:** it ends on another style (`applyAppearance` drops a preview for a style not in use), on adopted settings, and when the field unmounts (Settings closes). `applyAppearance` repaints the font when what's painted isn't what should show, so an ended look never lingers. Tests for each.
7. **Field text and query are separate.** Closed, the field shows the font in use; opened, the list shows everything, on the chosen one, until the field is typed in. Opening selects the name (also when the field already had focus), so typing replaces it.
8. **Virtualization is wired:** the popup is the scroll box, rows carry their `index`, a keyboard highlight scrolls to it. The e2e arrows 40 rows past what was drawn and checks `aria-activedescendant` names a drawn, visible option.
9. **Accessibility:** the row's label and hint name the field (`{...a}` on the input); the listbox is named "Fonts"; the notes ("Built in", "Style's font") are outside the value (`itemToStringLabel` is the name). The e2e checks the name, the description, Esc closing the list and not Settings.
10. **`withFont`'s cache is bounded** (64 pairs, oldest out): typed names are endless.
11. **Import drops only a bad entry:** a family that isn't a plain name, or a style this build doesn't know, leaves the rest of the map.
12. **Tests and copy:** the ordering assertion now checks the design blocks come first and the per-design local blocks exist; the catalog indexing is checked. Every string is in `en` and `es`. Without a list, "Use “X”" carries a quiet "If installed". The Appearance screen isn't one the UI rating covers (`docs/ui-rating.md`), so no rating gate.

## What was built

- `@terno/core`: `StyleFont`, `isStyleFont`, `LOCAL_FAMILY_RE` (copied into `theme.js`, compared by a test).
- `@terno/ui`: `withFont` and `fontPaint` for families, the per-design local blocks, and the Combobox's picker form (`combobox-picker.tsx`, on Base UI's Combobox; BOARDUI.md).
- `apps/web`: `lib/local-fonts.ts` (the computer's families, read once), `lib/fonts.ts` (the list and how typing finds), `previewStyleFont` in `appearance.ts`, and `settings/font-field.tsx`, which replaces plan 245's Select.
- Tests: core, ui, web unit (`appearance`, `local-fonts`, `fonts`, `theme-script`), backend (`settings`, `settings-edits`), e2e (`designs.spec`: the whole flow with a stubbed list of 404 families, and the browser without a list), and a packaged smoke (`fonts.smoke.ts`: this Mac's own list, Helvetica typed and kept). The Appearance baselines moved for the field.
