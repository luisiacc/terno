# 119 · Menu corners concentric with their rows

## Request (verbatim)

> here the roundness of the box with the dialog doesn't match with roundess of the items inside, lets make them match and look good

(A screenshot of the send-later popover: a round panel around rows with much tighter corners.)

## What exists

- The send-later, scheduled and remind popovers were `PopoverContent` (`rounded-2xl`) at `p-2` with their rows pulled out to a 4 px inset (`-mx-1`). Their rows are `rounded-md`. In Lumen that put a 20 px panel around 10 px rows 4 px in.
- The menus (dropdown, context, select) were `rounded-xl` at `p-1.5` around `rounded-md` rows. The select popup had no padding of its own (only `SelectGroup` gave `p-1`, and most selects have no group), and the recipient suggestions were `rounded-xl` at `p-1`.
- The palette was a `rounded-2xl` dialog around `rounded-lg` rows 8 px in.

So the curves met in some designs and not in others.

## Design

Two curves look right when they are concentric: the outer radius is the inner radius plus the gap between them.

- **`rounded-menu`** (`globals.css`): `calc(var(--radius-md) + var(--spacing) * 1.5)`, the rows' `md` radius plus the `p-1.5` inset. It is used by every panel of rows: dropdown and its submenus, context menus, select, recipient suggestions, the send-later, scheduled and remind popovers, and the composer's "more formatting" popover. Each design's ladder sets `md`, so this holds in all four.
- Every one of these panels is `p-1.5`. The select popup gets it and `SelectGroup` loses its own `p-1`, so grouped and ungrouped selects inset the same. The pickers' rows no longer pull out (`-mx-1`); their notes and fields move to `px-2` so their text stays on the rows' text line.
- **The palette** is `rounded-lg` rows 8 px in (the list's and the group's `p-1`), so its dialog is `calc(var(--radius-lg) + var(--spacing) * 2)`.

## Tests

- `e2e/menu-corners.spec.ts` (`@design`, so in all four designs): opens the send-later popover, a right-click menu and the palette. For each, it checks that the panel's radius equals the first row's radius plus the row's inset. Before this change it failed in 8 of 12 cases (e.g. "panel 20px = row 10px + inset 4px").
- The send-later, reminders, palette, recipients, controls, designs, themes and visual specs pass in every design, baselines unchanged.
- Visually checked in macOS, Lumen and Luma, light and dark: the context menu, the palette, the remind and send-later popovers.

## Perf

None: a radius and a padding.

## Out of scope

- Popovers that hold forms, not rows (the link editor, the update notice, sign-in): they keep `rounded-2xl` at `p-3`.
