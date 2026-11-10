# Plan 169: Graphite's rows get room

## The request

The owner, verbatim (with a screenshot of Graphite's Split inbox, arrows on the message list's rows):

> for this graphite look here i'm not sure the padding/spacing there is correct with apple, it looks very condensed, i think it should be less condensed like https://searchbrowser.app/, very minimalistic

## What exists

- Graphite (plan 137) drew the list's classic row at 64 px: three lines of 13 px type on 18 px lines (54 px), so about 5 px above and below, with a hairline between rows. Plan 158 kept it there for "more mail on screen".
- A row is `flex-col justify-center` at the design's `rows.comfortable` (`thread-row.tsx`); the virtualizer reads the same number (`thread-list.tsx`), as does first run's preview. Nothing else hard-codes it: the e2e checks read `d.rows.*`.
- Search Browser's sidebar, the reference: 15 px text on 30 px rows, no rules between them, and room around each line.

## Design

Graphite only (the others weren't asked about):

| | Before | After |
|---|---|---|
| Row lines (sender, subject, preview) | 18 px | 20 px |
| Comfortable row | 64 px | 84 px: 60 px of lines, 12 px above and below |
| Search results row | 64 px | 76 px: 8 px above and below, closer, as plan 158 wants results |
| List's one-line row | 36 px | 40 px: plan 158's cap for the table row (`list-layout.spec.ts`) |
| Compact | 32 px | 32 px: the dense choice stays dense |

Type sizes, weights, the hairline and the sidebar stay as they are. 9 whole rows show at 1440x900 where 12 did, and 6 at 1100x700 where 9 did: the trade the request asks for, as Lumen and Atelier made it for 76 px rows (`inbox-scan.spec.ts`'s bar, `WHOLE_ROWS` and `SMALL_ROWS`, follows).

## Tests

- `designs.test.ts` already holds a row at least its three lines plus 10 px, and comfortable over compact over wide.
- `inbox-scan.spec.ts`: Graphite's whole-row bar is 9 and 6 (it failed at 12 with the new rows, as it should).
- `designs.spec.ts`, `icons.spec.ts` and `list-layout.spec.ts` read the heights from the design; Graphite's baselines (`design-*`, `list-*`) are regenerated and checked in light and dark.

## Perf

None: one number the virtualizer already reads. Taller rows mean fewer rows mounted.

## Out of scope

- The hairline between rows (Search Browser has none): a structural change to the classic row, shared with macOS; for the owner to decide.
- The sidebar's spacing (plan 137 measured it from its reference) and the other styles.
