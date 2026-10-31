# 92: Hugeicons, and one icon line weight

## Request (verbatim)

> lets change all lucide icons to use  hugeicons  from their core free icons, show me pictures of multiple screens in light/dark modes, after that show me pictures of those screens side to side with the old icons vs the hugeicons icons

> do n1 [the macOS design's stroke 1.5], dide you removed all lucide icons? that was the goal, replace them all.

> ok then do that [lighter strokes, sizes matched to the text, quiet icons] and show me the pictures again after doing those adjustments

> make sure this keeping of the same stroke width and font is followed on the agents.md claude.md , make a note there for future designs and icons

## What existed

- `lucide-react` in `apps/web` and `packages/ui`, imported directly by ~60 components (about 115 icons), the shadcn primitives included.
- Plan 15: `svg.lucide { stroke-width: var(--icon-stroke) }`, per design `icon.stroke` / `icon.toolbar` (macOS 2 / 1.75, Lumen and Atelier 1.5); the toolbars set `[&_svg]:[stroke-width:var(--icon-stroke-toolbar)]`, the empty states `stroke-[1.25]`.
- The stroke lived on the 24-unit grid, so it drew thinner the smaller the icon: 0.75 px at 12 px, 1 px at 16 px (measured).
- Icons beside a label were 16 px next to 13 px text (macOS) in menus, the palette and buttons; outline buttons painted icon and label one color.

## Design

1. **One catalog.** `packages/ui/src/iconset/catalog.ts` maps every icon under the name the UI already used (`Trash2`, `Reply`, `X` …), so call sites change only their import (`@terno/ui/icons`). Each is a Hugeicons free-core drawing: Hugeicons' own lucide aliases where they read well at 16 px, otherwise the closest Hugeicons drawing, picked by eye on contact sheets (Reply/Reply all/Forward as one arrow family, Send a paper plane, compose a pen on a square, the classic Spam, PaintBoard, SquareLock02, Alert02).
2. **Rendered here,** not with `@hugeicons/react`: its paths carry `stroke-width="1.5"`, which no CSS on the svg reaches. `iconset/render.tsx` drops it from the path data and draws an `svg.icon` (decorative `aria-hidden` unless named, as lucide did). Icons import one Hugeicons module each (`@hugeicons/core-free-icons/<Name>`): the package index re-exports ~6,000, which dev and vitest would otherwise load.
3. **One line weight at every size** (as SF Symbols keep theirs): in the base layer, `svg.icon > [stroke]` is `vector-effect: non-scaling-stroke` with `stroke-width: var(--icon-line)`, `--icon-line = icon.stroke × 2px/3` (1.5 → 1 px). A surface tunes it with `--icon-line` on the svg; the toolbars use `--icon-line-toolbar`. Fill-only paths (dots) are untouched. macOS's stroke drops to 1.5 / 1.5, Hugeicons' drawing weight.
4. **Sized to the label:** an icon beside text is `1.15em` (menu, palette and text buttons: ~15 px at 13 px); icon-only buttons keep 16 px.
5. **Quiet:** outline buttons mute their icon until hover or open; menus and the palette already did.
6. `code-chip`'s hand-drawn check takes Hugeicons' Tick02 path (its draw-in needs `pathLength` on the path).
7. AGENTS.md → Designs → **Icons** records the rules for future icons and designs.

## Tests

- Typecheck (an unknown icon name fails it), lint, the UI package's unit tests, and the e2e suites whose screenshots cover icons: their baselines are regenerated in all three designs and looked at in light and dark.
- Before/after galleries of nine screens in light and dark (a throwaway `.dev.ts`), measured: every `svg.icon` draws a 1 px line at 12, 14, 15 and 16 px.

## Perf

One generated module per icon (`gen:icons`), each factory `/* @__PURE__ */`, and the icon modules marked side-effect free in the build (`vite.config.ts`), so each icon lands in the chunk that uses it. Startup JS against main with lucide: +11.2 KB gzip (506.2 vs 495.0), all of it Hugeicons' more detailed paths for the icons on screen at startup; the composer's, settings' and filters' icons stay in their lazy chunks. No runtime cost beyond lucide's.

## Out of scope

- Renaming the exports to Hugeicons' names (no visible change, every file again).
- Icon choices on surfaces not on the galleries beyond a contact-sheet check.

## Revisions after the Codex review

1. **Tree shaking.** The factories in one module weren't pure, so a bundle importing one icon kept all of them, and that module rode the entry chunk whole. Now one generated module per icon (`src/iconset/generated/`, from the catalog by `gen:icons`; a test fails on drift), each factory `/* @__PURE__ */`, and the icon modules side-effect free in `vite.config.ts`: the composer's icons moved into the lazy composer chunk (startup +13.4 → +11.2 KB gzip against lucide). Tests: `icons.test.tsx` (generated modules in sync, pure factories).
2. **The defaults beat every utility.** Unlayered, `:where(svg.icon)` outranked Tailwind's layered utilities, so `[&_svg]:[--icon-line:…]` (the toolbars) was ignored, masked by equal weights. Now in `@layer base`. Test: `e2e/icon-line.spec.ts` sets the toolbar's weight apart and expects its 2 px line while the sidebar keeps the design's (fails without the fix: 1 px), and checks one line at every size in all three designs.
3. **Baselines.** Regenerated in all three designs and looked at in light and dark.
4. **`xs` and `sm` text buttons** still fixed their icons at 12 and 14 px; they follow the label (`1.15em`) now, icon-only sizes keep theirs. Test: `icons.test.tsx` on `buttonVariants`.
5. **The copied-code check** drew a scaling 1.5 px line beside 1 px icons; it's an `svg.icon` with its own stroke now, under the shared line. Test: `code-chip.test.tsx`.
