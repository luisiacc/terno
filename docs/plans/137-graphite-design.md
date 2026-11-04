# 137 · Graphite: a design from a typographic blueprint

## Request (verbatim)

> - Use SF Pro in regular and medium with -0.15px letter spacing
> - Keep type to 12px, 13px, 14px, and 24px
> - Build hierarchy with #292929, #5D5D5D, and #9E9E9E
> - Size icons at 14px for navigation and 20px for cards
> - Use 8px navigation, 16px cards, and rounded pill CTA radii
>
> Simple systems make polished products.
>
> can you create a theme with this blueprint for our app, make sure it looks good and pro and clean and preimum

With a picture of a neutral, white, hairline-divided app window: quiet grey sidebar rows on an `#F4F4F4` selection, grey section labels, a 24 px medium title, a charcoal pill button, a 16 px card of rows divided by hairlines, and sky-blue dots as the only colour.

## What exists

- A design (plan 15) is typography, shape, density and variants; a palette holds the colours. Luma (plan 117) is the last one added, and the recipe is in `AGENTS.md`.
- Most of the blueprint is already a design value: the text scale, type roles, radius ladder, `navRadius`, the palette.
- Four things are not, because every design so far has the same value:
  1. **Weights.** `font-semibold` and `font-bold` are in about 40 files (counts, dialog titles, avatars, badges). A design can't cap them.
  2. **Base letter spacing.** Only the type roles and `tracking-*` set it. Text that uses neither has none.
  3. **Sidebar icons** are `size-4` in `sidebar.tsx`.
  4. **Button corners** are fixed in `button.tsx`. Lumen's pill is only its compose button.
- Settings groups draw `bg-tint` at `radius-lg + 2px` (`settings/parts.tsx`), so they can't be the blueprint's 16 px outlined card.
- `text-[0.8rem]` (12.8 px) is hard-coded on small buttons and toggles, off every scale.

## Design

**Graphite** is a fifth design, chosen in Settings → Appearance or the palette. Nothing changes in Lumen, Atelier, macOS or Luma: every new value below is set to what they draw today, and their baselines hold (only the Style grid and palette lists gain the new cards).

The name is the colour, and stays clear of the product in the picture (as plan 117's rename did).

### `designs/graphite.ts`

| Blueprint | Value |
|---|---|
| SF Pro, regular and medium | `-apple-system, BlinkMacSystemFont, "Geist Variable", …`, macOS's stack: SF on a Mac, the bundled Geist elsewhere (SF can't be redistributed to the web build). Every role's weight is 400 or 500; `weights` caps semibold and bold at 500 |
| -0.15px | every role's tracking, `tracking.tight`, `tracking.display` and the new `tracking.base` |
| 12 · 13 · 14 · 24 | `2xs`, `xs` 12/16 · `sm` 13/18 · `base`, `md`, `lg` 14/20 · `xl` 24/32 |
| 14 px navigation icons | `icon.nav: 14` |
| 20 px card icons | the cards that have icons (first run's choices) already draw 20 px; no new value |
| 8 px navigation | `navRadius`, `rowRadius`, `radius.md`, `radius.lg` |
| 16 px cards | `radius.xl`, `radius.2xl`, `layout.cardRadius`; drafts, toasts and Settings groups are all on these |
| Pill CTA | `surfaces.cta: "pill"` |

From the picture: 28 px nav rows, white sidebar and panes divided by hairlines, classic rows without avatars, a title header, the search field, the 24 px reader subject, outlined drafts and outlined Settings cards. **New message is a plain row at the top of the sidebar**, as "New task" is in the picture: a new compose variant, `sidebar-row`, so the only filled pills are real calls to action (Send, Save).

### The palettes

`graphite-light` and `graphite-dark`. Neutral, with a sky-blue `unread` as the one colour.

| Tier | Light | Dark |
|---|---|---|
| Ink (`foreground`, `primary`, selected nav) | `#292929` | `#EDEDED` |
| Secondary (`muted-foreground`, idle nav, section labels, glyphs) | `#5D5D5D` | `#9E9E9E` |
| Control edges (`control-edge`: unchecked boxes, off switches) | `#949494` | `#808080` |

**`#9E9E9E` on white is 2.7:1, which fails AA for text (4.5:1) and for UI marks (3:1)**, so the light palette can't use it for anything that has to be seen. Text there is `#292929` or `#5D5D5D`, and control edges are `#949494`, the nearest grey that holds 3:1. Other palettes' `control-edge` is their `input`, so their controls don't move. Dark inverts the ramp: `#9E9E9E` on `#1A1A1A` is 6.5:1, so there it is the secondary tier, and the blueprint's three greys are all in use only across the two modes.

Words that carry a meaning keep their colour: errors, "Draft", and unread and reminder text in the sky blue's ink. The sky blue is pulled down from the picture's so the dot holds 3:1 on white.

### New design values

Each is required, so a future design decides it. The first three default every existing design to today's value.

- `weights: { semibold, bold }` → `--font-weight-semibold` and `--font-weight-bold` read `--ds-weight-*`, in `@theme inline`, so nested previews draw in their own design.
- `tracking.base` → `letter-spacing` on `html, [data-design]` and the `tracking-normal` utility. Existing designs: `normal`.
- `tracking.wide` → the `tracking-wide` utility (small uppercase labels, verification codes). Existing designs: `0.025em`, Tailwind's own.
- `icon.nav` → `--icon-nav`, on the sidebar's icons *and* their wrappers, so the text line and the section labels stay on one line at any size. Existing designs: 16.
- `surfaces.cta: "control" | "pill"` → `--cta-floor` (`0px` or `9999px`). A word-bearing filled or outline button's radius is `max(var(--cta-floor), <its radius today>)`, and so is the Send group's, which draws its own shape. Icon-only and ghost buttons keep the ladder. Outline buttons count because they sit beside the primary in every dialog footer, and two corner shapes side by side look like a mistake.
- `surfaces.card: "tint" | "outline"` and `layout.cardRadius` → Settings groups. Existing designs: `tint` and `radius-lg + 2px`.
- `layout.commandRadius` → the palette's rows, and through `rounded-palette` its panel (rows + 8 px). Existing designs: `radius-xl`. Graphite: 8 px rows in a 16 px panel, since `radius-xl` is 16 px there and made the rows look like pills.
- `text.control` → `--ds-text-control`, the 12.8 px on small buttons and toggles. Existing designs: `0.8rem`. Graphite: 13 px.
- `variants.compose` gains `sidebar-row`.

### Exceptions to "12, 13, 14, 24"

Fixed-purpose micro labels already listed in `source-scan.test.ts` keep their size because they belong to a drawn shape, not to the type system: the 10 px initials in the 20 px avatar, the 7 px file type on an attachment glyph, the 9.5 px initials on the quick-reply bar, the Style cards' mini-mocks, the print sheet. The composer's size menu previews each size it offers, so "Huge" is large on purpose. HTML mail draws in its own frame and sizes.

## Tests

- Unit: counts (10 light and 12 dark built-ins), core's list, the generated CSS, and every Graphite pair in the contrast suite. Theme CSS budget: 10 KB gzip (one pair is about 400 bytes).
- Unit (new): Graphite holds the blueprint: every role and text step is 12, 13, 14 or 24 px, every role's weight is 400 or 500, every tracking is -0.15px, and the palette's three tiers are those hex values.
- e2e (new, `graphite.spec.ts`): in the running app, walks the inbox, reader, composer and Settings, and checks computed sizes, weights and letter spacing, with the exceptions named; nav icons are 14 px and share the section label's left edge; a primary button is a pill and a ghost one is not; a nested macOS preview inside Graphite keeps macOS's letter spacing and button radius.
- e2e: an `e2e-graphite` project runs every `@design` flow with its own baselines. `test:e2e` includes it.
- Existing designs: their baselines pass unchanged except the Style grid and palette lists.
- Visual: inbox, reader, reply, palette, menus, Settings and first run, in light and dark, looked at side by side with the picture.

First run lays the styles out in one row, one column per style, so it goes from four columns to five. Settings' two-column Style grid leaves Graphite on a row of its own, as a list that scrolls.

## Perf

No JS on a hot path. One more `[data-design]` block and one palette pair in the CSS. No font to download on a Mac: SF is the system's. Row heights are design values the virtualizer already reads.

## Out of scope

- Making Graphite the default.
- The picture's dotted texture at the window's top, and its top tab bar. Terno has neither surface.
- The marketing site's style list (Luma isn't on it either).
- Bundling SF Pro: Apple's licence doesn't allow it on the web build.

## Revisions after the Codex review of the plan

Eight points, all taken:

1. Send draws its own outer shape, so `Button` alone left the main call to action square. The group takes the floor too.
2. `var(--radius-lg)` inside an arbitrary value resolves at the root, so a nested design would get Graphite's radius. The new expressions read `--ds-radius-*`.
3. First run hard-coded four columns; it's now five.
4. `tracking-normal` (Kbd) and `tracking-wide` (small labels) overrode the base tracking. Both are design-controlled now.
5. The size menu's `text-2xl` is off the scale; it's a preview of that size, so it's named as an exception.
6. The plan claimed "every word" neutral and "one colour". Meaningful colour stays, and the plan now says so.
7. The plan promised `#9E9E9E` for the scrollbar, which derives from the ink. Promise removed.
8. Switching into Graphite is added to the untagged test that checks scroll, draft, selection and focus survive a switch.

## Baselines already failing on the base commit

Run on a clean checkout of `50d09c24`, with the same results: `send-later.spec` (`send-group-rest.png`, 896 pixels, every design), `visual.spec` (`compose-new-inline.png`, 48,119 pixels). Flaky there too: `visual.spec`'s "AI on a local model" (5 of 6 failed on that checkout, with a real Ollama running on the machine) and `dialog-move.spec`'s "Tab onto a control past the edge" (in macOS, Luma and Graphite). Left alone: they aren't this change's, and rewriting them would hide what moved them.

## Revisions after the Codex code review

Two findings, both fixed, each with a test that fails without the fix:

1. `input` isn't only decorative: it drew unchecked checkboxes and off switches, at 2.68:1 (light) and 2.50:1 (dark). A darker `input` can't be the answer, because 13 fields also fill with `dark:bg-input/30`, and an opaque grey pushed that fill so light the To label dropped to 4.18:1 (the `@design` axe test caught it). So a new derived token, `control-edge`, draws those two controls: `#949494` and `#808080` in Graphite, and equal to `input` in every other palette. `input` is the same quiet wash here as elsewhere. `CONTROL_EDGES` holds Graphite to 3:1. The suite still exempts the older palettes: that's an existing gap, and closing it means repainting every design.
2. The pill tests passed with the `Button` change removed, because Send sets its own radius and the nested preview has no button in it. They now measure the real `Button`s from `controls-markup.ts`, including one nested in Luma (`10px`, where the root alias would have given Graphite's `8px`).
