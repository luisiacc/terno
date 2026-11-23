# Plan 245: each style can take another font

## The request

> lets allow the user to change the font in settings in the appearance section, currently each style has its own font, lets allow users to set another font, and that font will be used for the selected style and will be remembered.

## What exists

- A design (plan 15) names its font in `fonts`: `sans`, `display` (the same stack in every design today), `features` and the `faces` to have loaded before it paints. Lumen is Figtree, Atelier Instrument Sans, Luma Inter, and macOS, Graphite and Relief the system font (SF, Geist where there is none). Every face is bundled (`@fontsource-variable/*` in `globals.css`, `fonts.test.ts`); nothing reaches a font service.
- `generate.ts` writes one `[data-design="id"]` block per design (`designs.generated.css`): `--ds-font-sans`, `--ds-font-display`, `--ds-font-features`, and every type role's `--type-<role>-family` as the literal stack.
- `applyAppearance` paints `data-design` on `<html>` and caches the appearance for `public/theme.js`, which paints it before React on the next launch. `main.tsx` waits (150 ms at most) for the painted design's faces before the first render; `updateAppearance` waits for a new design's faces (300 ms at most) before a switch commits, so a switch never paints in a fallback font.
- Plan 138 gave each style its palettes (`designPalettes`), swapped into the global slots by `switchDesign`. That swap exists because the slots are one pair; a font has no global slot, so it needs no swap.

## Design

**A catalog of fonts, `packages/ui/src/designs/typefaces.ts`.** `TYPEFACES: Record<FontId, { name, stack, features, faces }>` for every face we bundle plus the system font: System, Inter, Geist, Figtree, Instrument Sans. `FONT_IDS` and `FontId` live in `@terno/core` beside `DESIGN_IDS`, since the settings contract validates them. The designs stop spelling stacks: `fonts` gains `typeface: FontId`, and `sans`, `display` and `faces` come from the catalog through one helper (`typefaceFonts(id)`), with the design's own `features`. A test holds every design's stack to its catalog entry. The generated CSS doesn't change.

**The setting, `designFonts`:** `Partial<Record<DesignId, FontId>>`, default `{}`. An entry is a style's chosen font; no entry is the style's own. The style in use reads its entry directly. Picking a style's own font removes its entry, so "the style's font" is never stored twice and a future change to a style's font reaches everyone who didn't choose another.

**One function decides the effective design:** `withFont(design, fontId | undefined)` in `designs/index.ts` returns the design with the catalog font's `sans`, `display`, `faces` and `features` (the design itself when there is no entry or it names the design's own font). The face waits, the Settings preview and anything that reads `useDesign().fonts` go through it.

**Painting.**
- `generate.ts` writes the role families as `var(--ds-font-display)` / `var(--ds-font-sans)` instead of literals, and one block per font after the designs: `[data-design][data-font="inter"] { --ds-font-sans; --ds-font-display; --ds-font-features }`. Two attributes outrank a design's one, so the font wins wherever a design is set, the Settings mini-mocks included. Weights, sizes, tracking and every other value stay the design's.
- `applyAppearance` sets `data-font` on `<html>` (or removes it) in the same frame as `data-design`, includes it in its key, and treats a font change like a design change: the list's and reader's anchors are captured and restored, since text reflows.
- The cache gains `font`; `theme.js` paints `data-font` from it before first paint (ids checked against its own copy of `FONT_IDS`, kept in sync by a test), and `main.tsx` waits for the effective faces.

**Choosing.** `updateAppearance` waits for the effective faces whenever the effective font changes: a font picked for the current style, or a style switch into a style with a chosen font. The existing sequence counter covers both: a newer choice drops an older wait. The patch carries the whole map, as `designPalettes` does.

**Settings → Appearance.** Under the Style grid, in the same group, a **Font** row: label left, a `Select` right (the ported BoardUI select, `size="sm"`). Each item is drawn in its own font (the item carries `data-design`/`data-font` and `font-sans`, no family strings in app code); the style's own font carries a quiet "Style's font" note. The hint says what it does: "Used with {style}. Each style remembers its own." It joins the Settings search (`appearance.font`, words: font, typeface, type). `en` and `es`.

**Backend.** `designFonts` joins the patch schema (design ids → font ids), `DEFAULT_SETTINGS`, the read sanitizer (unknown designs or fonts dropped) and `GENERAL_KEYS`, so a backup carries it; an import lays the file's entries over this install's, as plan 138 does for palettes. No migration: a profile without it reads `{}`.

## Tests

- `packages/ui`: the generated font blocks and `var()` role families; every design's stack is its catalog entry's; `withFont` (own font, other font, unknown); `fonts.test.ts` still finds every catalog face bundled.
- `packages/backend/src/settings.test.ts`: default, persistence, sanitizing on read, refusal of an unknown font on write; `settings-edits.test.ts`: export and import carry and merge it.
- `apps/web/src/lib/appearance.test.ts`: a font choice paints `data-font` and caches it; picking the style's own font removes the entry and the attribute; a switch into a style with a font waits for that font's faces and paints it; switching back restores the other style's choice.
- `apps/web/src/lib/theme-script.test.ts`: `theme.js` paints a cached font, ignores an unknown one; its `FONT_IDS` match core's.
- `apps/web/e2e/designs.spec.ts`: through Settings, Lumen takes Inter (computed `font-family` of the list title changes), Graphite keeps its own, Lumen gets Inter back, and it survives a reload with no frame in Figtree.

## Performance and resources

No new faces, packages, timers or network: every font is already bundled, and a face's file loads only when a font that uses it paints. A font change repaints once, as a design change does; the CSS grows by five three-line blocks. The perf gates' `setDesign` doesn't go through `updateAppearance`.

## Out of scope

- Fonts installed on the Mac (the Local Font Access API, or the shell listing them): a picker of hundreds of names, families without the weights the designs use, and a style's look left to chance. The catalog is a one-line addition per bundled face.
- A separate display font, a mail-reading font, or size; the composer's own font marks stay as they are.
- A palette command for fonts.

## Revisions after the Codex review of the plan

Twelve points. What changed:

- **Font choices are intents, not maps** (#1, #3, #4). `setStyleFont(design, font)` is the only way to change a font (`updateAppearance` no longer takes `designFonts`). Its sequence counter is per style, so a style switch or another style's font never drops a choice still waiting for its faces. The pending entry is the choice itself: it's laid over snapshots as one style's change, and the map sent is the one the backend last confirmed with that style changed, so a refused choice never rides back inside a later one. `designFonts` is in `APPEARANCE_FIELDS`. Tests for all three.
- **The painted font is state** (#2). `useAppearance` holds `font` (from theme.js's `data-font` at load, set in the same synchronous commit as the design); `useDesign()` and `currentDesign()` read both. `withFont` returns one object per pair, so a component's design is stable between renders.
- **Boot waits when the cache is behind** (#5). `settingsFaces` waits (150 ms at most) for the bootstrap's faces when they aren't what theme.js painted. An import or storage switch (`adoptSettings`) still paints at once and lets the face swap in, as a design does today: rare, and bounded by the loader.
- **Previews carry `data-font`** (#6): the Style cards, first run's preview and its "Aa" specimens. `fontAttr()` gives the attribute for a design from `withFont`.
- **The font block sets `font-feature-settings` itself** (#7), so a nested preview or a menu item doesn't inherit the page's features.
- **The wait is bounded, as before** (#8): the plan no longer promises no fallback frame; the e2e checks `data-font` before React mounts and the computed family after.
- **System outside Apple platforms** (#9): the stack falls back to the bundled Geist with no wait, as macOS, Graphite and Relief already do. Unchanged and stated.
- **Import is the file's map, as it is** (#10). A backup that carries `designFonts` restores it whole, a style on its own font included; a file from before this plan leaves the install's choices alone. No merge (plan 138 merged palettes because older files have no map; here absence already means "older file").
- **The Select** (#11): `<SelectTrigger {...a} size="sm">`, `items` for the trigger's label and `label` on each item for typeahead, so the "Style's font" note is neither in the value shown nor in what's typed. The e2e picks by keyboard and checks the trigger's name and description.
- **The style descriptions** (#12) keep naming each style's own font (Luma: Inter; macOS: the system font): they describe the style, and the Font row right under them says what this one draws in now. Left as they are.

## What was built

As designed above, with the revisions. The Font row sits in the Style group under the descriptions; the select lists System, Inter, Geist, Figtree and Instrument Sans, each in its own font, the style's own marked. The style hint is unchanged.

Tests: `designs.test.ts` (catalog, `withFont`, `fontAttr`, generated blocks), `appearance.test.ts` (four cases above), `theme-script.test.ts`, `settings.test.ts`, `settings-edits.test.ts`, and `designs.spec.ts` (the request through Settings by keyboard, across a switch and a reload). The Settings → Appearance baselines moved for the new row: `designs.spec` in all six styles, `themes.spec` light and dark, and `visual.spec`'s Spanish one. Every other baseline is unchanged, so the role families through `var()` draw as before.

Failures seen while testing that `main` has without this change: `packages/i18n/src/scan.test.ts` (`packages/ui/src/brand/generate.ts:129`), `visual.spec`'s owner card, category picker and AI filter builder baselines, and `design-axe.spec`'s composer check (flaky by style).
