# 223: the follow-up snackbar's layout

## Request

> this snackbar here with this info about moving something to a folder looks bad to me, not aligned, bad hierarchy, not understood at all, lets polish the design of these snackbars to make them look clean and be intutive

(The snackbar after a drag onto a folder whose default moved the rest: "Moved 13 emails with the same sender and subject to Factura iuspro · Move similar… · Undo · ×", the note "New mail like this goes there too." under it, and "No, only move this email … 0" below.)

## What was wrong

- **Hierarchy:** the title carried everything (count, scope, folder) and wrapped to two bold lines; the note under it said "like this" without saying what "this" was.
- **Alignment:** the note sat at its own indent (`pl-8`), neither on the title's text nor on the dot; "No, only…" sat on the dot's column, with its `0` pushed to the far edge.
- **Crowding:** "Move similar…", Undo and × all shared the title's row, squeezing it.
- The category snackbar (plan 91) and the similar one (plan 63) drew all this separately, each slightly differently.

## Design

One frame for both, `components/offer-snack.tsx`:

- **Head:** the lead (a category's dot, on the title's first line), the title, and under it one muted line: the scope and what new mail does. Undo and × at the right, centred on that block.
- **Below a hairline**, everything that could still change it, every line's text on the title's column: the offers (on asking), then the foot: "No, only move this email `0`" (its key beside it), and across from it "Move similar…". Without a foot, "Move similar…" stays beside Undo, as before.
- **Copy:** the title says what happened ("Moved 13 emails to Factura iuspro"); the line under it says why and what follows ("All with this sender and subject. New ones will go there too."). Running: "All with this sender and subject". Retargeted and a filter that couldn't be saved say the scope first too (`offers.default.moveNoFilter`; the spam snackbar keeps `offers.default.noFilter`).

## Tests

- `offers.spec.ts`, `dnd.spec.ts`: the new title and note text.
- `snack.spec.ts`: the open bar's chrome budget is the one-line head plus the hairline section's padding (≤ 48, was ≤ 40 with the padding inside the offers box).
- Axe in light and dark (`offers.spec.ts`, `similar.spec.ts`, `snack.spec.ts`, `design-axe.spec.ts`) unchanged and passing.
