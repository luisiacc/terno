# 118 · BoardUI's controls as the base of every design

## Request (verbatim)

> i mean to use it for all styles as the base  design system

(After plan 117, which added BoardUI's base components as a fourth design, Luma.)

## What exists

Plan 117 drew BoardUI's controls under a `board:` variant, only inside Luma. The shared components (`packages/ui/src/components/`) kept shadcn's look for Lumen, Atelier and macOS.

## Design

BoardUI's controls become the components' own classes, so every design draws them; the `board:` variant is gone. A design still decides type, radii, density and structure (plan 15), and its palette decides the colors, so each design gets them in its own shapes and colors. Luma stays as the design that is drawn around them: Inter, its radii, its palette.

- **Button.** Primary is lit from the top, from `primary-hover` to `primary`, the two fills whose text the contrast suite checks; it is reversed in dark mode, where `primary-hover` is the darker; hover drops the gradient. Outline is BoardUI's secondary: a 1 px border on `card` over a contact shadow, firming up on hover and when open.
- **Input, textarea, input group.** The filled field: `bg-field`, a 5% ink wash that reads on white and on grey groups alike. The border shows on hover, focus and error.
- **Select trigger.** BoardUI's secondary button.
- **Checkbox and switch.** White over a contact shadow, then the accent lit from the top with an inner highlight; a dot in the switch's thumb.
- **Menus (dropdown, context, select, palette).** Solid `popover` with `shadow-menu` (a 1 px edge and a short soft shadow), 12 px corners, 32 px rows with 8 px corners, highlighted in `muted` (the menu maps `--accent` to `--muted`). They were translucent glass; BoardUI's are solid. `surface-glass` stays for the composer's link bubble.
- **Popover, tooltip.** Rounder, `shadow-menu`. **Kbd**: a pill. **Badge**: square-ish (`rounded-sm`). **Card**: `rounded-2xl`, a contact shadow and a `border` ring.

Since a state style now lives in the same class list as its rest style, Tailwind's variant order handles the cascade: `hover:` < `focus-visible:` < `disabled:` < `has-` < `aria-`. The restating plan 117 needed is gone, and the dark invalid border is the shared one (`destructive/50`).

## Tests

- `e2e/controls.spec.ts` (was `board-controls.spec.ts`) runs in all four designs, light and dark. It renders the real components, injects them into the app, and checks the error border (also hovered), focus under hover, the disabled fill, and the primary's two gradient stops against probes of the tokens.
- Every project's baselines are updated (macOS `e2e`, `e2e-lumen`, `e2e-atelier`, `e2e-luma`), and the axe checks still run in each in light and dark.
- Visually checked: menus, settings, reply and inbox in Lumen, Atelier and macOS, light and dark.

## Perf

Fewer CSS rules than plan 117 (no scoped variant). Menus lose their backdrop blur, which is cheaper to paint.

## Out of scope

- BoardUI's control heights (36 px buttons, 42 px switches): every toolbar and settings row would move.
- Application components (the sidebar, rows, the reader): they are Terno's, per design.

## Revisions after the Codex review

Three findings, all fixed, each with a regression test that fails without its fix:

1. Send's split button: its halves pass `bg-transparent`, but `bg-linear-to-b` survived the merge, and its opaque gradient hid the open half's `aria-expanded` fill once the pointer left. The halves now drop the gradient (`bg-none`), and the group, which owns the fill, is lit like a primary (`controls.spec`: the open half shows `primary-hover` and no image).
2. Text on the filled field was not in the contrast suite. Eight pairs now cover a field's text and placeholder on its 5% wash (`FIELD_WASH`, which a test keeps equal to `--color-field`), over the background, cards, menus and Settings' tint groups. Every built-in palette passes, and custom themes get them as warnings.
3. The draft's From selector passes `dark:bg-transparent`, which beat the base `hover:bg-muted` in dark mode. It now has `dark:hover:bg-muted` (`controls.spec`, dark).
