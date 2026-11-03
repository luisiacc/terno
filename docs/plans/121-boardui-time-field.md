# 121 · BoardUI's time field in the date and time pickers

## Request (verbatim)

> lets use the time field of board ui [screenshot: the remind popover's time select] here and other similar places that use a time field
>
> also this row [screenshot: the date and time fields under "Pick date & time…"] should be same widht ads the item above, because its different width it looks weird

## What exists

`WhenFields` (plans 87 and 94) is the only date-and-time field: the remind popover and Send later share it. Its two triggers were quiet filled controls (`bg-tint`), and the time was a select of 15-minute times with a check on the chosen one. The pickers inset the fields `px-2`, so they were 16 px narrower than the "Pick date & time…" / "Custom…" row above them.

BoardUI (`components/base/date-picker/`) has no separate time input. Its time is chosen in the scheduler: a trigger in its secondary button's chrome (`shared.tsx` `triggerButtonClassName`: white, a 1 px border, `shadow-xs`, an icon and the value) and a column of time slots (`meeting-scheduler.tsx`: centered, the chosen one filled in the tertiary grey, a neutral hover, no check).

## Design

- **Triggers:** the date is `Button variant="outline"` and the time `SelectTrigger`, which already is BoardUI's secondary (plan 118). Both drop the filled look; `rounded-md` and `px-2`, so their corners and icons sit on the rows' line above.
- **Time slots:** the select stays Base UI's (keyboard, typeahead, the chosen time scrolled into view, screen reader names); its items are BoardUI's slots: centered, the chosen one `bg-muted` and medium, no check. Today's past times stay dimmed.
- **Width:** the fields lose the pickers' `px-2`, so they run edge to edge with the rows above; the "time has passed" note moves to `px-2`, on the rows' text.

## Tests

`controls.spec.ts`, light and dark: the date and time triggers start and end on the row's edges, have the card fill, a 1 px border and a shadow; the open list's chosen time is centered, filled with `muted` and shows no check. It fails without the change. The reminders and send-later specs pass in every design.

## Perf

Classes only.

## Out of scope

BoardUI's 12/24-hour switch: the locale already decides (12-hour in English, 24-hour in Spanish).
