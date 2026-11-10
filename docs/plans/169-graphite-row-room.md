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

## What the Codex review changed

One finding, fixed with a test that fails without the fix:

- **A style switch could land on the next row.** The list keeps its first visible row through a switch by scaling the scroll offset by the new row height over the old. That scaled the Reminders label and its gap (and Today's headings) too, which keep their height. With a due reminder on top, macOS (64) to Atelier (76) moved the viewport 9% of a row deeper, and Graphite's 84 px rows made it worse. The anchor now measures from each row's real start (`rowStart`, as the virtualizer lays it out): only the rows scale, and space above or below the anchor row stays as it is. `designs.spec.ts`'s live switch now runs with a due reminder on top (it failed at 0.094 against 0.06).

A second round, on that fix, found one more, also fixed with a test that fails without it:

- **A viewport starting in the gap under a row anchored that row,** already off screen. If a refresh then took it away (a reminder that ended), the restore gave up and the mail on screen moved a row. A viewport in the space under a row now anchors the next row, the one on screen, with the space above it kept. The math moved to `lib/row-offsets.ts` (`rowStart`, `anchorAt`, `anchoredOffset`) with a unit test.

## Follow-up: a click above an open menu closes it

The owner, verbatim (with a screenshot of the filter menu open, an arrow on the list's title above it):

> when that menmu is open, clicking above should close it

The list header is the window's drag area on desktop (`drag-region`), and Electron takes a click there for the window before the page sees it, so the menu never heard of it. Base UI lays a full-window layer behind an open menu, select or popover to catch a click outside (`InternalBackdrop`, `[data-base-ui-inert][role=presentation]`); `globals.css` now makes that layer `no-drag`, as the floating panels already were. While a menu is open the window can't be dragged by its title band, as with a native menu. `inbox-scan.spec.ts` checks the header is a drag area, the point over the title isn't while the menu is open, and a click there closes it (it failed at `none` without the fix).

The Codex review of that fix found a popover has no such layer (Base UI's `Popover` is non-modal), so the reader's reminder picker still stayed open after a click on a title band. Fixed with a test that fails without it (`reminders.spec.ts`): while a popover, a menu or a select is open, `.drag-region` is `no-drag` (`:root:has(…[data-open])`); a tooltip leaves the bands alone, so the window still drags under one.

## Follow-up: blacker ink

The owner, verbatim (with the list and a paragraph of searchbrowser.app, black lead-in over grey text):

> i think there needs to be abit more contrast on the blacks to look like what we intended like this

The reference measures #171717 ink over #8A8A8A grey. Graphite light's ink goes from #292929 to #171717 everywhere it was (foreground, primary, accent and selected-row text, the sidebar's selection, drafts). The grey stays #5D5D5D: #8A8A8A is 3.5:1 on white, under AA, and the grey has to hold 4.5:1 on the selected row's #DCDCDC too (#5D5D5D is 4.8:1 there, about the lightest that does). Dark is unchanged. `designs.test.ts` holds the new hex; the contrast suite passes; Graphite's light baselines are rewritten.

## Follow-up: a tad more weight

The owner, verbatim:

> i think not only darker but als oa tad more font weight

SF is variable, so a half step draws as one (measured in Chromium on macOS: 400, 450 and 500 set different widths). Graphite's roles in the ink go half a step up: regular 450 (subject, body, compose), medium 550 (sender, list title, reader subject, sender name, the selected sidebar item); an unread sender 650, its subject 550, so unread stays a step above read. Grey text keeps 400 and 500 (the preview, labels, the sidebar at rest), so the ink stands further off it, as the reference's lead-in does. Plan 137's two-weight rule becomes this one in `designs.test.ts` and `graphite.spec.ts`; Graphite's baselines are rewritten.
