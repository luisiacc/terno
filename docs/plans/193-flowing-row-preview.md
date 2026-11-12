# Plan 193: a one-line row's preview flows after its subject

- **Status:** built.
- **Undoes:** plan 160's subject column on one-line rows (List's table and compact density). Plan 158's flowing line comes back.

## The request

> not sure i like this here with the previews being in a columns themselves, ithink they look better coming after the subject whatever width it has
>
> maybe it will need a bit better contrast though.

(The owner, 2026-11-11, on a screenshot of List's table.)

## What exists

Plan 160 gave a one-line row's subject a column of the list's width (`SUBJECT_COLUMN`, `COMPACT_SUBJECT`, `clamp(…cqw…)`), so every preview started at one x. A short subject left a wide gap before its preview. The preview was `text-muted-foreground` (`text-xs` in the table).

## Design

- **Flowing line.** The subject takes its own width (`FLOWING_SUBJECT`: `max-w-[70%] flex-none truncate`), and its marks (Draft, kept, place, reminder) sit right beside it. The preview follows with plan 158's gap and is the first thing cut. The compact sender keeps its column (plan 160). Nothing paints over the meta columns or the date: the line's container is `min-w-0`.
- **A step more ink.** A derived theme token, `row-preview`, is `muted-foreground` mixed 30% toward `foreground` in oklab. That always moves it toward the row's ink, so it never has less contrast than the quiet ink, and the subject's ink and weight still set it apart. Contrast pairs cover it on a row's four fills (background, pane, row-hover, row-selected). Three-line rows keep the quiet ink: their preview sits on its own line.

## Tests

- `list-layout.spec` (the table) and `precision.spec` (List; compact at 1100 and 1060): each preview starts right after its own subject (gap ≤ 16 px; rows with a Draft mark are skipped), in every design.
- `contrast.test.ts`: the four new pairs, in every built-in theme.
- The List screenshot baselines are regenerated, light and dark, in every design.

## Out of scope

- Three-line rows, the Review layout and the reader.

## Revisions after the Codex review

1. **Marks over the date in a narrow compact row.** A `flex-none` subject couldn't shrink beside a Draft mark. The subject now shrinks after the preview is gone (`FLOWING_SUBJECT`, no `flex-none`). This is held by precision.spec's "nothing over the date".
2. **Review's answers.** Answers no longer grow to fill (`flex-1`); they shrink alongside the subject (`ml-auto min-w-0`), so a long subject can't hide "Add to …". `review-row-actions.spec` covers it.
3. **Search hits on a shorter preview.** A long subject now leaves less preview, so `LEAD.wide` drops from 40 to 20 characters: a body match stays visible.
4. **Custom themes with an inverted selection.** Stepping toward the ink could sink the preview on a dark `row-selected`. The derivation now steps only as far as every row fill keeps AA, or the quiet ink's own contrast where that is lower. `registry.test.ts` has a test that fails without this guard.
5. **Empty sets passing.** The gap checks now require at least one visible preview.
6. Not done: the drop flash (primary 16% over the pane). The quiet ink never had a pair there either, and the flash lasts a moment.
