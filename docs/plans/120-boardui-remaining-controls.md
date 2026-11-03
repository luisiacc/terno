# 120 · BoardUI's tabs, segmented control, date picker, avatar and divider

## Request (verbatim)

> restyle the five above that you mentioend to board ui , make note in the future to get comopnents from the boardui if possible before creating a new base component that could be common

("The five above": tabs, the segmented control, the date picker, avatar and the divider, which BoardUI has and plan 118 left in shadcn's look.)

## What exists

Plan 118 made BoardUI's controls the base of every design, but five of Terno's base components kept shadcn's look. BoardUI's versions (`components/base/` in github.com/BoardUI/boardui, MIT):

- **Segmented control** (`segmented-control.tsx`): a track (`neutral-100`, dark `neutral-925`, so darker than the panel in dark) at `p-1` with 10 px corners, and a thumb (`white`, dark `neutral-800`) with 6 px corners and a 1 px contact shadow (`shadow-2xs`). The chosen label is primary text, the others secondary text that darkens on hover. Terno's `ToggleGroup` with `variant="outline"` drew separate outlined buttons, the chosen one in a 15% wash of the primary (Settings → Mode, Layout, Motion, Mail appearance; first run). The print sheet and the remind popover hand-rolled their own segmented controls.
- **Tabs** (`tabs.tsx`, `pill-tab.tsx`): a line of tabs over a 1 px separator, the chosen one in the accent with a 2 px accent underline. Terno's `Tabs` are shadcn's (a muted track by default, a `line` variant). The only use is Settings' sidebar, which restyles every part.
- **Date picker** (`date-picker/shared.tsx`): the month centered between the previous and next arrows, weekday names in secondary text, 32 px days with 8 px corners, a neutral hover, the chosen day filled with the light accent and dark text. Terno's `Calendar` (react-day-picker, the send-later and remind date) has the month on the left, arrows on the right, and the chosen day in solid primary.
- **Avatar** (`avatar.tsx`): round, no ring, a neutral fill with semibold initials; 20, 24, 32 and 36 px. Terno's has a hairline ring and regular initials. The app's own avatars are `sender-avatar.tsx` (sizes and colors per design, plan 15), not this one.
- **Divider** (`divider.tsx`): a 1 px line in the separator color. Terno's `Separator` is `bg-border`, while the app draws its lines as hairlines (`bg-hairline`, `--hairline-w`).

## Design

Ported as a look onto the same Base UI and react-day-picker parts, in tokens, at Terno's control heights:

- **Segmented control: `ToggleGroup variant="segmented"`.** The track is the field wash (`bg-field`, so it reads on white, on Settings' grey groups and in popovers) at `p-0.5`, the thumb `bg-card` with `shadow-xs`. In dark mode the track is `bg-background`, the darkest surface, and the thumb `bg-muted` with an inner highlight, as BoardUI's darker track and lighter thumb. Items are `h-7` (the track is `h-8`, Terno's control height) with `rounded-md`; the track is `rounded-md` plus its `p-0.5`, so the corners are concentric (plan 119). Labels are muted and reach the foreground on hover and when chosen. Every `variant="outline"` group moves to it, and so do the print sheet's and the remind popover's own; the `outline` toggle variant and its contrast pair go.
- **Tabs.** The default list is the segmented control's track and thumb, so the two read as one family; the `line` variant is BoardUI's tabs: a hairline under the list, the chosen tab in `primary` with a 2 px `primary` underline. Settings keeps its sidebar.
- **Calendar.** The month centered between the arrows (`font-medium`), weekday names `text-xs font-medium text-muted-foreground`, days `size-8 rounded-md` with a `muted` hover, the chosen day a 15% wash of the primary with `foreground` text (`font-semibold`), today in `primary`. Its popover's corners are concentric with the days: `rounded-md` plus the `p-2.5` inset.
- **Avatar.** No ring; semibold initials on `muted`; `lg` is 36 px.
- **Separator.** A hairline: `bg-hairline` at `--hairline-w`.

**For the future:** AGENTS.md (Designs → Base controls) says to look in BoardUI's `components/base/` first, before writing any new base component that could be shared, and to port its version when there is one.

## Tests

- `e2e/controls.spec.ts`: Settings → Appearance's mode control in every design, light and dark: the chosen item's fill is `card` (light) or `muted` (dark), the others have none, the track is the field wash (light) or `background` (dark), and its radius is the item's plus the inset.
- `e2e/menu-corners.spec.ts`: the date picker's popover is concentric with its days.
- Unit: the contrast suite keeps passing with the chosen day's pair (`foreground` on the primary's 15% wash over `popover`) in every built-in palette.
- Existing specs that click these controls (settings, first run, print, reminders, send later) keep passing; Settings, first run and print baselines are updated in every design.
- Visually checked in light and dark: Settings → Appearance and General, the remind popover, the date picker, the print sheet.

## Perf

Classes only. Nothing changes in the entry chunk's size beyond a few rules.

## Out of scope

- The app's own avatars (`sender-avatar.tsx`) and the list's quick-filter chips: they are per design (plan 15).
- BoardUI's labelled and double dividers, pill tabs' sliding indicator and the segmented control's sliding thumb (motion: a later, separate pass within `--motion`).

## Revisions after the Codex review of the plan

Ten points; what changed:

1. **Today in the calendar** kept `primary` text on the hover fill and on the chosen wash, which fail AA in some palettes (Apple light: 4.05 and 3.67). Today is `primary` only at rest; hovered or chosen, its text is `foreground` (`controls.spec`: hovered and chosen, in light and dark).
2. **The segmented gap** is the variant's own (`gap-0.5`), not `spacing`'s 8 px; the quick-filter chips keep theirs.
3. **The print sheet's and the remind popover's** own track, thumb and pressed fills are gone, not overlaid; `controls.spec` checks both against the tokens.
4. **Settings' sidebar** passes `dark:bg-transparent` and `dark:data-active:shadow-none` over the new dark track and thumb. Its rows keep their height: the old trigger was sized by its text (line height plus 6 px, `flex-1` from a zero basis), so the sidebar now asks for exactly that, and the trigger's `flex-1` is horizontal only.
5. **The print sheet's labels still wrap** (`h-auto`, `whitespace-normal`, `min-h-7`).
6. **Height:** the segmented control is 32 px (`h-7` items in a `p-0.5` track), Terno's default control height, where Settings' outlined `sm` toggles were 28 px. Intentional: it is one control now, as tall as the buttons and selects beside it.
7. **Avatar group count** matches the avatar: 36 px beside a large avatar, semibold. The group's ring between stacked avatars stays: it separates them.
8. **Unused components are probed:** `controls-markup.ts` renders the segmented control, default and line tabs, an avatar and a divider in every design and mode, against token probes.
9. **Focus:** nothing of BoardUI's focus handling is copied; the days and arrows keep `focus-visible:` rings.
10. **Baselines:** Settings → Appearance and General, and the print sheet, are regenerated (`--update-snapshots=all`, since the 0.2% tolerance let the small controls pass); first run is covered by `controls.spec`'s checks of the shared control rather than a new baseline.
