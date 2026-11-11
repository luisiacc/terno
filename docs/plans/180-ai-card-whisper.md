# Plan 180, the AI card: Whisper

## The request (verbatim)

> i'm still not convinced on the looks of the ai summary card / reply-ai card, get that thread to build me 4 variations, for both light and dark mode of these cards, they still need to be subtle, but lets have another look that is still clean and premium and kind of minimalistic

The four looks (Whisper, Ledger, Float, Edge light) were built on `explore/ai-card-variations` behind a Dev mode switch and compared on one page, in light and dark. The owner's answers:

> i like the whisper version on dark, but thecolor of the light version i don't lie

> hmm i don't like variations 2-4, only one i like, i liked the Tint from settings but i feel it needs to be lighter here

> go with tint at 65% for the light mode, keep the whisper version for hte dark modes

## What exists

One AI card (`AI_CARD`, `ai-card` in `globals.css`, plans 161 and 162) for every AI suggestion in the reader and in Filters:

- **The summary**, at the top of a conversation (`thread-summary.tsx`).
- **Reply ready**, under its last message (`reply-ready.tsx`).
- **The follow-up line** (`thread-followups.tsx`).
- **Filters' AI box** (`filters-dialog.tsx`).

**How it's drawn today.**

- In light it has no fill of its own: an inset 1 px `--card-edge` ring and `shadow-xs`.
- In dark it has the same ring over a 4% wash of the ink (`--ai-card-wash`, set per design in `generate.ts`).
- Its parts are shared constants in `ai-card.ts`:
  - the header (`AI_HEADER`: 40 px, gap 1.5)
  - a muted glyph (`AI_GLYPH`)
  - the title in the ink (`AI_TITLE`)
  - the button row (`AI_ACTIONS`)
- Each user pads the card itself with `px-4 pb-3.5`.
- The summary ends in a footer row: Copy (glyph and word) on the left, "Written with AI" on the right.

**What the contrast suite checks.** `contrast.ts` holds the ring against the reader, against Lumen's reader card and against its own fill, plus the dark wash's step off the reader (`AI_CARD_WASH`). Text on the card is the page's own pairs.

**The exploration commits** (`fa2aa1b08`, `b657a1c14`, `764afeca2`) put the looks behind a Dev mode setting (`lib/ai-look.ts`, `components/ai-looks.ts`). That machinery goes in this plan.

## Design

**The surface.** One look in every design and palette:

- no ring and no shadow
- corners `--card-radius` + 4 px
- **light:** the palette's `--tint` (Settings' groups) at 65% over whatever the card sits on (the reader, Lumen's reader card, a dialog)
- **dark:** the accent's 5% wash, as Whisper had it

`--ai-card-wash` and its per-design value go: nothing else reads it.

**The anatomy.** Whisper's, in `ai-card.ts`, so all four users get it:

- **Inset:** `AI_INSET` = `px-5`, and the bottom `pb-4` (was `px-4 pb-3.5`).
- **Header:** `AI_HEADER` = 44 px, `gap-2`, `py-3` (was 40 px, `gap-1.5`). The owner's "airy over dense".
- **Glyph:** `AI_GLYPH` in the accent, `text-primary`. AGENTS.md mutes an icon beside a label until hover, so this is a deliberate exception: the sparkle (and the spinner while a card works) marks a model's words, and the owner chose the look with it.
- **The summary's controls.** "Written with AI" and Copy move to the header's end, and the footer row goes.
  - Copy is icon-only (`AiCopyButton iconOnly`): `icon-sm`, 28 px, named "Copy", then "Copied", with a tooltip saying the same.
  - The chevron sits beside the title it opens, and the trigger is as wide as its words.
  - Closed, the card is that one row.
- **Spacing:** 20 px under the summary (was 16). Reply ready keeps `mt-4`.

**Contrast.** Text stays on the page's own pairs: `CONTRAST_PAIRS` gains the ink and the secondary ink on `tint` at 65%, over the background, a card and a popover. It also gains both on the primary's 5% wash over a popover (Filters' box in dark).

**The card's edge.** The fill alone now bounds the card. `BOUNDARY_STEPS` loses the five ring steps and the three wash steps, and gains the fill's step off the reader and off Lumen's reader card, in each mode.

Its floor is the owner's choice, written down like `FIELD_FLOOR` (plan 160) and `SELECTION_FLOOR_LIGHT` (plan 173): the step measured in the palettes as built, so the card never vanishes. The card is also its header, glyph and title, so the fill is a cue repeated, not the only one. Per the owner's standing rule ("lighter fields over contrast floors"), we don't darken the fill to reach `TINT_FLOOR`.

**Out of scope.**

- ⌘J's strip and Ask, which aren't this card.
- Reply ready's footer row (Use as draft, Dismiss, "Written with AI"): the owner only weighed the surface.

## Tests

- **Unit:**
  - `contrast.test.ts`: the new pairs and steps run in every palette.
  - `ai-provenance.test.tsx`: icon-only Copy is named, says Copied, and holds 28 px.
  - `reply-ready.test.tsx`
  - `thread-summary-label.test.ts`
  - `source-scan.test.ts`
  - `i18n.test.ts`
- **e2e:**
  - `summaries.spec.ts`:
    - Copy and "Written with AI" are in the header, and no footer row is left.
    - Closed, the card is one row and Copy still works.
    - The fill is the tint at 65% in light and the accent's wash in dark.
  - `replies-ready.spec.ts`, `followups.spec.ts`, and `filters.spec.ts` (the AI box).
  - `design-axe.spec.ts`: the reader with both cards, light and dark.
- **Screenshots:** both cards in light and dark in macOS and Lumen, the follow-up line, and Filters' box.
- **`pnpm ui:rate --screens ai`** (the summary, the follow-up line and Reply ready, Filters' AI box), then `pnpm ui:gate` on that round: two whole passing rounds on one commit.

## Perf

None: one CSS fill instead of a ring and a shadow, and one fewer row in the summary.

## Revisions after the Codex review

The plan's review raised nine points.

1. **e2e checks for the old look.** `summaries.spec.ts` and `replies-ready.spec.ts` asserted the old surface: no fill and an inset ring. They now assert the fill, in light and dark, in every design: the tint at 65%, the accent at 5%, no shadow, no border.
2. **e2e heights.** The specs' 40 px headers are 44: Reply ready's header with Reply | Reply all, and the running summary's row at the minimum window.
3. **Filters' folded header.** 44 px is the header's minimum. Filters' folded header holds a 28 px Edit button, so it grows to 52 px (it was 48 with the old padding). Kept: the same 12 px above and below as every card's header.
4. **The narrow window.** At the minimum window, the summary's row holds the name and both tools inside the card in every design: Copy's right edge stays inside, and nothing in the row overflows.
5. **Skipped: translucent custom tints.** A custom theme with a see-through tint is checked at 65% where CSS paints 65% of its alpha. That gives a false warning on a custom theme, never a wrong colour, and the same holds for the suite's existing alphas. It is rare enough to skip under the review round cap.
6. **Gaps on the card.** A model's gap mark (the gold at 25%) is now checked as drawn: over the card's fill, over the reader's background or Lumen's card, AA in every palette. Gaps are only Reply ready's, so a dialog isn't checked. Over a popover, Catppuccin Mocha would be 4.1:1.
7. **The keyboard.** By keyboard, the name, then "Written with AI", then Copy. Enter copies, says Copied, and leaves the card open. Escape returning focus to the provenance was already covered (`summaries.spec.ts`, plan 162).
8. **The design CSS.** It is regenerated (`gen:designs`), and `designs.test.ts` passes.
9. **The rating.** The rating is the AI set (`--screens ai`), not the everyday screens.
