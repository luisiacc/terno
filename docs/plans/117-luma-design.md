# 117 · Luma: a design between Lumen and macOS, with BoardUI's base controls

## Request (verbatim)

> https://www.boardui.com/
>
> can you use that and the base components from there, not the template, the base compoennts, as the base for our components here as well, so i cna see how everything looks with them.

## What exists

- BoardUI (MIT, github.com/BoardUI/boardui) is React 19, Tailwind v4 and React Aria. Its base components (`components/base/`) are buttons, input, textarea, select, checkbox, switch, dropdown, tooltip, kbd, badges, tabs and a segmented control. Their look: Tailwind's neutrals with a blue accent ramp, Inter, 10 px controls, 16 px menus, a primary button lit top to bottom (accent 500 → 600), white secondary buttons with a 1 px border and a contact shadow, *filled* fields (tertiary grey, no border, a ring on hover), white thumbs with a small coloured "chip", and a soft two-layer dropdown shadow.
- Terno's base components (`packages/ui/src/components/`) are shadcn on Base UI, drawn from palette tokens and the design's variables (plan 15). A design is type, shape, density and structural variants; colours live in palettes.

## Design

Luma is a fourth design, so it can be compared with the others by switching in Settings → Appearance (or ⌘K → the design). Nothing changes in Lumen, Atelier or macOS.

- **Primitives stay Base UI.** Swapping to React Aria would change focus, keyboard and portal behaviour that the e2e suite and plans 52 and 54 pin down. Luma ports the *look*: the classes, translated to our tokens.
- **Design** (`designs/luma.ts`): Inter (bundled, `@fontsource-variable/inter`), BoardUI's ramp (11 · 12 · 13 · 14 · 16 · 18 · 24), radii 4 · 8 · 10 · 12 · 16 · 24, medium weights, 32 px row avatars, the pill compose button, outlined drafts, title header, search field, filter menu.
- **Palettes** `luma-light` and `luma-dark` (BoardUI's neutrals; dark on #121212). Dark mode's primary is a lighter blue with dark text, because white on BoardUI's blue can't reach 4.5:1 while the same blue also reads as text on the ground (`CONTRAST_PAIRS`).
- **Controls**: a `board:` variant (`globals.css`), true inside `[data-design="luma"]` but not inside another design nested in it. It has one attribute's specificity, as `dark:` does, so `board:` utilities override the base and dark ones. Where a `board:` utility replaces a property, its states are restated under `board:`.
  - Button: primary lit from the top (`from-highlight`); outline is BoardUI's secondary (1 px border, contact shadow, firmer border on hover).
  - Input, textarea, input group: the filled field. `bg-field` is a 5% ink wash, so it also reads on Settings' grey groups. The border returns on hover, focus and error.
  - Select trigger: BoardUI's select, drawn as its secondary button.
  - Checkbox and switch: white with a contact shadow, then the accent lit from the top with an inner highlight; the switch thumb carries BoardUI's dot.
  - Menus (dropdown, context, select, palette): solid, 12 px corners, `shadow-menu` (a 1 px edge and a short soft shadow), 32 px rows with 8 px corners, and a neutral highlight. The menu remaps `--accent` to `--muted`, so every item state follows without restating it.
  - Popover and tooltip: rounder, `shadow-menu`. Kbd: a pill. Badge: 4 px. Card: 16 px with a contact shadow.

## Tests

- Unit: the counts (9 light and 11 dark built-ins), the font list, the generated CSS, and every Luma palette pair in the contrast suite. The theme CSS budget goes to 9 KB gzip (one pair is about 400 bytes).
- e2e: a `e2e-luma` project runs every `@design` flow (layout, keyboard, axe in light and dark) with its own baselines; `test:e2e` includes it.
- Visually checked in light and dark: inbox, context menu, palette, inline reply, Settings (General, Appearance, Accounts, AI).

## Perf

No JS. The CSS adds the `board:` rules (scoped selectors, parsed once) and one palette pair. Inter's faces download only when Luma is in use (`faces`, plan 15).

## Out of scope

- BoardUI's application components and templates (sidebar, data table, charts, composer…).
- Making Luma the default or applying its controls to every design: a decision once it has been seen.
- Sizes: BoardUI's 36 px medium button and 42 px switch would move every toolbar and settings row, so Luma keeps Terno's control heights.

## Revisions after the Codex review

Five findings, all fixed. `e2e/board-controls.spec.ts` (now `controls.spec.ts`) renders the real components into the app in Luma, light and dark, and fails without the fixes:

1. An invalid outline button lost its error border to `board:border-border` (same specificity, emitted later). It's restated under `board:aria-invalid:`.
2. Hovering a focused or invalid input group brought back the neutral border. Focus, error and disabled are restated under `board:`.
3. The primary's white highlight left its text at 4.0:1 at the top of the gradient. The gradient now runs between `primary-hover` and `primary` (in dark palettes, between `primary` and the darker `primary-hover`). Both are fills the contrast suite checks its text on. Hover drops the gradient for the darker hover fill.
4. A disabled field lost its fill to `board:bg-field`. It's restated under `board:disabled:`.
5. The web build's service worker precached all seven Inter subsets (224 KB) whatever the design. It now precaches only latin and latin-ext, which is all English and Spanish need; any other subset loads over the network if text ever needs it.

Already failing on the base commit and unrelated: `designs.spec` (macOS baselines, the font-service checks), `sidebar-panels.spec`'s long-sidebar group in every design, `settings-edits.test.ts`'s import tests, and `no-hardcoded`'s `folder-rows.tsx:151`.

## The name

The design was first called Board, after BoardUI, and renamed so the app doesn't carry another product's name. **Luma** is Lumen + macOS, which it sits between: Lumen's avatars, pill compose and category pills; macOS's title, search field, filter menu, classic reader and reply icons; rows between the two.

The design had a working id before it was released. The Codex review of the rename asked for a migration of saved designs and palettes under that id; none is needed, since no build carrying it ever shipped.
