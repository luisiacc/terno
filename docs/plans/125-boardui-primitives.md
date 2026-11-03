# 125 · BoardUI's primitives: the whole base, checked against boardui.com

## Request (verbatim)

> Check our base design system, check that everything has board UI as the base. And the board UI styles, let's make sure we have that. I'm spelled out for future ones as well, so we respect WUI. And actually go to boardUI.com to check the there you are and make sure that ours has their primitives.

Asked how far to go (restyle the existing ones, port the ones the app hand-builds, or port all 48):

> restyle plus used ones, do this in a worktree, also lets use their primitives but respect our themes colors

Asked whether "their primitives" means moving to React Aria: **BoardUI on Base UI** (port each component's structure, variants, sizes and states exactly, in our theme colors, on Base UI; React Aria only where Base UI has no primitive, lazily).

## What exists

BoardUI's catalog (`boardui.com/components`, read 2026-11-02) has 48 free **Base** components; Blocks, Charts and Templates are mostly Pro and are not base controls. Every Base source was fetched from `https://www.boardui.com/r/<name>.json`.

Plans 117–122 ported the field, button, menu-panel, segmented-control, tabs, calendar, avatar, divider and time-field looks. An audit of all 31 files in `packages/ui/src/components/` against the sources found what is still shadcn's:

- **Dialog, alert dialog:** a tinted footer band whose `rounded-b-xl` corners poke past the panel's `rounded-2xl` (a bug, visible in the category-forward dialog); a ghost square close at `top-2 right-2`; a 15 px title; 16 px padding. The alert dialog has another surface (`ring-1`, no shadow), a centred header on phones and square media.
- **Button:** `destructive` is a 10 % red wash (BoardUI's danger is solid, lit from the top); no pressed fill; disabled is `opacity-50` (BoardUI: a grey fill, tertiary text, no shadow); `xs` is medium weight (BoardUI semibold); `link` still has a box and `underline-offset-4`.
- **Menus (dropdown, context, select):** rows regular weight with `gap-1.5` and no space between them (BoardUI: medium, `gap-2`, 4 px apart); group labels 12 px and 2 px off the rows' text; separators 2 px short of the panel edges; check and radio marks muted (BoardUI: accent); destructive rows washed red (BoardUI: red text on the neutral highlight); shortcuts as tracked `text-xs` (BoardUI: tertiary body text); disabled `opacity-50`; the submenu 3–4 px low and, in the context menu, `shadow-lg` instead of the panel's. The select popup covers its trigger (`alignItemWithTrigger`), marks the chosen row with a check instead of a fill, and its chevron never turns.
- **Command palette:** no hint footer, shortcuts as separate keycaps, 36 px regular rows touching, 11 px semibold headings, an inset search divider, a 16 px search text.
- **Tooltip:** no arrow, regular weight, a 6 px offset.
- **Checkbox:** a 1 px tick (BoardUI 2 px), no indeterminate dash, no hover.
- **Skeleton:** shadcn's `bg-muted` pulse, which vanishes on muted surfaces (BoardUI: an 8 % ink tint, shapes, `SkeletonText`).
- **Calendar:** no space between cells, regular days, other months' days shown, today as coloured text (BoardUI: a dot), unavailable days faded (BoardUI: struck through).
- **Smaller:** the switch's thumb and chip are flat; Kbd is 11 px on `muted`; Badge is 20 px with no neutral colour; Avatar's initials don't scale; the line tab's underline stacks on the hairline instead of covering it; the segmented control has no weight change when chosen (and keeps dead `variant=outline` classes); the textarea's text sits 10 px in (BoardUI 12); Input Group squares Kbd's pill and its buttons aren't concentric; the time field's segments are `rounded-sm`; Popover is 288 px with `gap-2.5` at a 4 px offset (BoardUI 320, `gap-3`, 8).

A second search found the BoardUI primitives the **app** builds by hand, outside the shared components:

| BoardUI | Hand-built copies |
| --- | --- |
| Close Button | 10+ in four stylings (`nudge`, `learned-banner`, `diag/report-row`, `sign-in-notice`, `snack-dock`'s `SnackClose`, `attachments`, `filters-dialog`, `thread-list`'s clear search, the dialog's own) |
| Icon Button | the Tooltip + ghost `icon-sm` + label + Shortcut wrapper three times (`selection-bar` `BarButton`, `reader` `ToolButton`, `inline-draft` `ToolIcon`), 26 `size="icon*"` uses |
| Spinner | 25 `Loader2`/`LoaderCircle` + `animate-spin`, `motion-reduce` applied unevenly; about 15 are a busy button |
| Accordion / Collapsible | `accounts-tab` and `categories-tab` rows line for line, about 8 other disclosures; the 0fr→1fr panel written five times (`expand.tsx`, `first-sync-pill`, `sidebar` ×3) |
| Announcement | `learned-banner`, `diag/report-row`, `forward-question` share one class string; `web/nudge` is a fourth |
| Chip | five removable tokens (`reader` category and suggestion chips, `attachments`, the palette's page token, `recipient-input`'s `RecipientChip`) |
| Radio | five groups with two hand-written arrow-key handlers (`first-run` ×3, `composer/rich` swatches, `settings/parts` `ColorPicker`); the theme and style cards are `aria-pressed` buttons in a group |
| Link Button | about 12 raw "text + `hover:underline`" buttons in three stylings |
| Pagination | three identical Previous/Next blocks (`sent-copies`, `recipient-receipts` ×2) |
| Number Field | four `Input type="number"` (`general-tab`, `add-account-dialog` ×2, `filters-dialog`) |
| Progress | `first-sync-pill`'s bar |
| Search Field | the list's search (`thread-list`) |
| Toast | the snack dock (one system, its own store) |

Base UI 1.9 (installed) has radio-group, collapsible, accordion, number-field, progress, meter and toast; nothing outside `components/` imports it.

## Design

**Rule for every item:** BoardUI's component is the spec — its structure, parts, variants we use, sizes' proportions, spacing, weights, states (rest, hover, pressed, open, selected, disabled, invalid) and indicators — drawn in our tokens on Base UI. Kept Terno's: control heights, palette colours (BoardUI's neutral/accent steps map to `foreground`/`muted-foreground`/`muted`/`field`/`card`/`popover`/`primary`/`destructive`, and text only on pairs in `CONTRAST_PAIRS`), the radius ladder and concentric corners (plan 119), Hugeicons with one line weight (`--icon-line` to thicken, never `strokeWidth`), `focus-visible:` rings, the `--motion` cap.

### A. Restyle the existing components

1. **Dialog and alert dialog.** No footer band: the footer is a plain right-aligned row (`flex-col-reverse` on phones). The panel is `p-6 gap-4`; the title `text-lg font-medium`; the description muted body text 4 px under it. The close is the new `CloseButton` (round, `size-6`, on the field wash) at the header's end, not absolutely placed. The alert dialog shares the dialog's surface (`rounded-2xl shadow-modal`), is start-aligned at every width, and its media is a round `size-10` on the field wash, or on the destructive wash with `tone="danger"`. The footer-corner bug goes with the band.
2. **Button.**
   - `destructive` becomes BoardUI's danger: solid, lit from the top (`destructive` to a lighter mix), `text-white`-equivalent foreground on a checked pair, `shadow-xs`. The two callers (`settings/parts`, `storage-tab`) and the alert dialog's confirm use it.
   - Pressed: primary and danger darken (`active:` a 10 % mix toward ink), outline goes to `muted` with the `input` border; the press scale is 0.98.
   - Disabled: primary and danger turn to the `muted` fill with `muted-foreground` text and no shadow; outline keeps its border on the `field` fill with `muted-foreground` text and no shadow. No `opacity-50`.
   - `xs` is `font-semibold`. `link` has no height or padding (`h-auto p-0`), `underline-offset-3`, and darkens when pressed.
   - `ghost` **stays quiet** (transparent, `muted` on hover): BoardUI has no transparent button, and Terno's toolbars are Apple Mail's quiet icons. BoardUI's ghost (an accent wash) is not ported; nothing uses it.
   - A `loading` prop: shows a `Spinner` in place of the leading icon, sets `aria-busy` and disables the button while keeping its width.
3. **Menus (dropdown, context, select)** share one row recipe (moved to `components/menu-styles.ts`, as BoardUI's `menu-styles.ts`):
   - rows `font-medium`, `gap-2`, 2 px apart (`gap-0.5` in the panel; BoardUI's 4 px at its 36 px rows is 2 px at our 32 px), keeping `h-8 rounded-md`
   - group labels `text-sm font-medium text-muted-foreground` on the rows' text line (`px-2`)
   - separators run to the panel's edges (negative margin equal to the panel's `p-1.5`)
   - check and radio marks in `primary`
   - destructive rows: `text-destructive` on the neutral `muted` highlight, no red wash
   - shortcuts: plain `text-sm text-muted-foreground`, `ps-3`, no tracking
   - disabled rows: `text-muted-foreground`, no opacity (the sub-trigger too)
   - the submenu opens 4 px from its parent with its first row on the trigger row, in the same panel (`shadow-menu`, no `shadow-lg`)
   - the root dropdown animates as the others (`zoom-in-[0.97] ease-spring`).
   **Select:** the popup drops 4 px below the trigger (`alignItemWithTrigger={false}`), at least the trigger's width; the chosen row is filled (`bg-muted` with `font-medium`, still `aria-selected`) and has no check; the trigger is `font-medium` and its chevron turns 180° when open (within `--motion`).
4. **Command palette.** A hint footer (`border-t`, muted text, "↑ ↓ Navigate", "↵ Select", "esc Close", from `en`/`es`); shortcuts in one `Kbd` per chord; rows `h-10 rounded-xl px-3 font-medium` 2 px apart in a `p-2` list (`rounded-palette` stays concentric); headings `text-[13px]`-equivalent `text-sm font-medium text-muted-foreground`; the search divider full width; search text `text-sm font-medium` with a `size-5` icon; the empty state centred, muted, `min-h-32`; a description slot replacing the app's hand-rolled `command-hint`. Width and placement stay Terno's (640 px at 18 %): long subjects need the room; noted as a deviation.
5. **Tooltip.** BoardUI's arrow (Base UI `Tooltip.Arrow`, drawn in `popover` with the `shadow-menu` edge, as Popover's), `font-medium`, offset 10 px, `max-w-60`.
6. **Checkbox.** The tick at a 2 px line (`--icon-line` on the svg), filling the box; `indeterminate` draws a `Minus` dash on the checked fill; hover darkens the border at rest.
7. **Skeleton.** `bg-foreground/8`, `rounded-xl` by default; a `shape` prop (`rect`, `text` `rounded-md h-3`, `circle`) and `SkeletonText` (lines `gap-2.5`, the last 60 %). The pulse stays (no sheen): a sheen is continuous paint on every placeholder, and our loaders are short.
8. **Calendar.** Days `font-medium`; 4 px between cells (BoardUI's 12 px makes a 326 px panel that no longer fits our 320 px popover — 4 px is the most that fits); weekday names `text-sm font-medium text-muted-foreground`; other months' days hidden; today a 4 px `primary` dot under the number instead of coloured text; unavailable days struck through in `muted-foreground`; arrows `text-muted-foreground`, darkening on hover.
9. **Smaller ones.**
   - Switch: the thumb is white in both modes, lit from the top (`card` to `muted`) over a two-layer contact shadow; the chip a small embossed dot (`input`, `primary` when on).
   - Kbd: `text-xs font-semibold px-1`, on `border` (darker than `muted`), `muted-foreground` text, a checked pair.
   - Badge: 18 px (`px-1 py-px leading-4`); a `neutral` variant (`bg-muted text-muted-foreground`).
   - Avatar: initials 10/12/14/16 px for xs/sm/default/lg; an `xs` size (20 px).
   - Line tabs: the 2 px underline sits over the list's hairline.
   - Segmented control: unselected items `font-normal`, the chosen one `font-medium` (width reserved so nothing shifts); the dead `outline` classes go.
   - Textarea: 12 px text inset. Input Group: Kbd keeps its pill, its buttons' radius is the shell's minus its inset.
   - Input, textarea, select trigger: disabled is the field wash with `muted-foreground` text, no opacity.
   - Time field: segments `rounded-md`; disabled segments and clock muted.
   - Popover: `w-80`, `gap-3`, offset 8 px (10 with an arrow); a `PopoverFooter` (`flex justify-end gap-2`).

### B. New shared components (in `packages/ui/src/components/`, each from its BoardUI page)

- **`spinner.tsx`** — BoardUI's spinner (a ring with a turning arc) at 1.15em beside text, 16 px alone; `role="status"` with a label when standalone, `aria-hidden` inside a busy button; still under reduced motion (a static arc), and always under `motion=off`.
- **`close-button.tsx`** — BoardUI's round ×: sizes `2xs` 16 / `xs` 20 / `sm` 24 / `md` 32 px, on the field wash, `muted-foreground` glyph darkening on hover, a required `label` (defaults to "Close"). The glyph is the iconset's `X` with `--icon-line` set per size so the line is 1.5 px at every size.
- **`icon-button.tsx`** — an icon-only button with a required `label`, an optional `shortcut`, and the tooltip built in (label + `Shortcut`). Variants `ghost` (Terno's quiet toolbar) and `secondary` (BoardUI's bordered icon button); sizes from Button's `icon-*`. Replaces `BarButton`, `ToolButton`, `ToolIcon`.
- **`collapsible.tsx` and `accordion.tsx`** — Base UI's Collapsible and Accordion in BoardUI's accordion look: a full-width trigger row (`font-medium`, a chevron at the end turning 180°), the panel's height animated with Base UI's `--collapsible-panel-height` within `--motion`, none when reduced. `expand.tsx` (the 0fr→1fr grid) becomes the Collapsible panel where it is a disclosure.
- **`announcement.tsx`** — BoardUI's dismissible banner: icon, title, body, optional action, a `CloseButton xs`; on `bg-tint` with Terno's banner insets, one class list instead of three copies.
- **`chip.tsx`** — BoardUI's chip: `h-6 rounded-md px-2 text-xs font-medium` on the field wash, an optional leading dot or avatar, an optional remove `CloseButton 2xs` with a label naming the chip ("Remove Work").
- **`radio-group.tsx`** — Base UI's RadioGroup and Radio in BoardUI's radio (16 px, the field ring at rest, the accent lit from the top with a white centre when chosen) plus BoardUI's `card` variant (a bordered card that takes the accent ring when chosen) for the first-run and appearance choices. Arrow keys from Base UI; the two hand-written handlers go.
- **`color-swatches.tsx`** — BoardUI color-picker's preset row as a RadioGroup of round swatches (the chosen one ringed), named per colour; replaces `settings/parts` `ColorPicker` and the composer's swatches.
- **`number-field.tsx`** — Base UI's NumberField in Input's filled field with BoardUI's stepper buttons at the end; keeps commit-on-blur.
- **`progress.tsx`** — Base UI's Progress in BoardUI's bar (a 4 px track on the field wash, the fill in `primary`, rounded ends), with an optional label and value.
- **`pagination.tsx`** — BoardUI's simple pagination: "Previous" and "Next" secondary buttons with a "1–25 of 80" range between them.
- **`search-field.tsx`** — BoardUI's search field: Input's shell with the search icon, a clear `CloseButton` when there is text, Escape clears; the list's search uses it.
- **Toast look:** `snack-dock` keeps its store and behaviour but draws BoardUI's toast surface (solid `popover`, `shadow-menu`, `rounded-xl`, the action as a secondary button, `CloseButton`).

Each new string goes through `en` and `es`.

### C. Adoption

Every hand-built copy in the table above moves to its component. App components that only *look* like a primitive but are widgets (the sidebar tree, thread rows, the recipient combobox, the send split button) stay Terno's.

### D. For future components

- **`packages/ui/BOARDUI.md`**: all 48 Base components, each with its Terno file, "Terno's own" (with why), or "port on first use", plus the deliberate deviations above. Updated whenever a component is added.
- **AGENTS.md → Base controls** points to it and adds: never hand-build a control that is in that catalog — use or port the component; when porting, follow the component page's parts, variants and states exactly in our tokens; record any deviation and its reason in `BOARDUI.md`.

## Tests

- `e2e/controls.spec.ts` (every design, light and dark) grows checks against token probes for: the dialog (no footer band, footer inside the panel's corners, close in the header), destructive solid fill and white text, disabled fills (no opacity), menu row weight and gap, full-bleed separators, the select popup below its trigger with the chosen row filled, the tooltip arrow, the checkbox's indeterminate dash, the skeleton's tint, the calendar's today dot, and each new component (rendered through `controls-markup.ts`).
- Unit (`packages/ui`, `apps/web`): Button `loading` (busy, disabled, width kept); CloseButton and IconButton names; RadioGroup arrow keys and the first-run/appearance choices as real radios; NumberField commit on blur and clamping; Pagination range text; SearchField's clear and Escape; Collapsible's `aria-expanded`.
- Contrast suite: the new pairs (danger foreground on its two stops, Kbd text on `border`, the chip's text on the field wash, the disabled text on `muted`).
- Existing specs that click these controls keep passing; baselines regenerated in every design and looked at in light and dark.
- axe stays clean in every design, light and dark.

## Perf

Classes and small components. Collapsible, Accordion, NumberField, Progress, Pagination and RadioGroup land only in chunks that already use them (settings, first run, filters, diagnostics are lazy). Spinner, CloseButton, IconButton and Chip are tiny and shared by the entry chunk; `load.perf`'s entry-size check must hold. `pnpm test:ui-perf` for the list's search field and the reader's toolbar.

## Out of scope

- Moving to React Aria (decided: Base UI underneath).
- BoardUI components Terno doesn't use: Table, Drawer, Carousel, Breadcrumb, Input OTP, Slider, Social Button, Tree View, File Upload, Meter, Button Group, Tag Group, Combobox, Date Calendar's ranges, Notification. They are listed in `BOARDUI.md` as "port on first use".
- Control heights, BoardUI's palette, the skeleton's sheen, the palette's width.
- Blocks, Charts and Templates (mostly Pro).

## Revisions after the Codex review of the plan

Twelve points; what changed:

1. **Destructive menu rows** keep their red wash when highlighted: `destructive` on `muted` fails AA in six palettes (Terno light 4.18, Monokai 3.83). A deviation, recorded in `BOARDUI.md`.
2. **Number Field** keeps `DaysField`'s contract: a typed out-of-range value stays and shows the error (no clamping), an account override may be empty, Enter commits without leaving the field. Base UI's input is `type="text"`, so specs that find it by `spinbutton` move to its label.
3. **Tests of floating parts** (dialogs, menus, the select's placement, the tooltip's arrow) use the app's real callers; `controls-markup.ts` is static HTML and only checks resting looks.
4. **The dialog's close** stays a property of `DialogContent` (Settings and Filters have no visible header): the round `CloseButton` sits at the top end inside the `p-6` inset, on the title's first line, and `DialogHeader` reserves its width (`pe-8`).
5. **Other months' days stay shown** (muted): a chosen date next week can fall in the next month, and `controls.spec` checks that a chosen outside day stays visible. A deviation.
6. **Entry chunk:** `Progress` is plain markup (`role="progressbar"`), not Base UI's, because the first-sync pill is in the entry chunk. The reader's `Expand` (a message body's reveal, not a disclosure control) stays; Collapsible replaces only the settings and diagnostics disclosures, which are lazy.
7. **Accordion** animates with `--accordion-panel-height`, Collapsible with `--collapsible-panel-height`.
8. **`BarButton`:** only its toolbar form (icon-only) becomes `IconButton`; the split-pane form keeps its visible labels as an outline Button.
9. **`RecipientChip` stays** the recipient widget's option (selection, validation, delegated removal). `Chip` is BoardUI's styled span, with an optional remove `CloseButton` for the reader's category chip, attachments and the palette's page token.
10. **`SearchField`** forwards a ref to its input and passes key handlers through, so the list keeps `/` and ⌘F, Escape's clear-then-close-and-return-focus, Enter and ArrowDown leaving the field, and the focus-driven coverage note.
11. **Appearance and first-run cards as radios:** the first-run scroll-into-view selector and the specs move from `aria-pressed` to `aria-checked`.
12. **Input Group** drops its own `opacity-50` and `bg-input/50` disabled look for the field's, and the disabled probe covers a grouped field.

## Implementation notes (phase 1)

Part A and the two Part B components it needs (`spinner.tsx`, `close-button.tsx`). Where the code or AA pushed back:

- **The danger's tokens.** Two derived tokens, `destructive-foreground` (white on a red; the theme's dark where its red is light, every dark palette, as their `primary-foreground` is) and `destructive-shade`, both in `CONTRAST_PAIRS`. The plan's "destructive to a lighter mix" can't hold under white text: Terno Light's red is at 4.63:1 and Apple's at 4.54:1, so nothing lighter reads. The top stop is the red itself and the lower one a shade darker (`destructive-shade`, always darker, a registry test keeps it so): still lit from the top. Hover and press drop the gradient for the red a tenth toward the ink, as the primary does.
- **Kbd on the field wash, not `border`.** `muted-foreground` on `border` fails AA in GitHub Light (4.28) and Dark (4.19), and on a highlighted row in five palettes. The key sits on `bg-field` (its pairs already exist over every surface) and its text turns to the ink on the palette's chosen row (a new pair: the ink on the wash over `muted`). In palettes whose `border` equals `muted` (Gruvbox, Monokai, Nord, Mocha) `border` would not have read as a step anyway.
- **"The disabled text on `muted`"** was already a pair (`muted-foreground / muted`); no new one.
- **Unavailable, not only disabled.** A Tailwind variant `unavailable:` (`:disabled` or `aria-disabled="true"`, not while `aria-busy`) carries the disabled look, so the buttons kept focusable while disabled (`focusableWhenDisabled`: Print, Add account, the reconnect form, capture recovery) now look disabled too; before they showed nothing.
- **Ghost and link still fade when unavailable** (`opacity-50`): their glyphs are muted at rest, so muted text would leave a disabled toolbar icon looking live.
- **`loading`** keeps the button focusable (`aria-disabled`, Base UI's `focusableWhenDisabled`) rather than natively disabled, so focus stays on the button just pressed; its fill doesn't change. With no leading icon the spinner sits centred over the label, which stays (hidden) to hold the width. A leading icon is recognised as an element of `@terno/ui/icons` (each has a `displayName`). Send's halves keep the group's look (the group fades, as before).
- **The dialog's close** is centred on a `text-lg` first line at the 24 px inset by calc; `DialogContent` takes `closeClassName` for the sheets with their own inset: Settings and Print put it on their title's line; Filters keeps it in the corner (`top-2 end-2`), its editor's first card starting at the inset.
- **Menus.** `data-inset` rows indent `ps-8` (8 + a 1.15em icon + the 8 px gap). The select's rows are all medium already, so the chosen row is told by its fill alone. `menu-styles.ts` is imported by path (the package exports components as `.tsx`).
- **Palette.** `rounded-palette` is now `radius-xl` + 8 px (BoardUI's xl rows at the list's `p-2`); the category picker follows. The hint row is `CommandDialog`'s (`hints`), so the category picker has none. Search glyph, rows' icons, headings and hints all start 20 px in (BoardUI's search glyph sits at 12).
- **Spinner.** One crisp arc with its rounded head on a faint track; BoardUI's two blurred glow layers are left out (a blur filter repainting on every spinner). It turns at Tailwind's `animate-spin` (1 s): `no-hardcoded.test.ts` refuses literal durations, and BoardUI's 900 ms isn't worth a token.
- **Avatar** initials: 10 / 12 / 14 / 15 px; the scale has no 16 (`text-md` is 15). The 10 px is listed in `source-scan.test.ts`.
- **Switch, dark.** The white thumb is the ink (`foreground`, lit to a slightly darker mix); its off chip is `muted-foreground` at half (the `input` wash vanishes on a white thumb).
- **Segmented control.** The chosen item's medium width is held only for text labels (`data-label` on `ToggleGroupItem`, drawn by an invisible `::after`); an icon-and-text item may still shift by a pixel.
- **Skeleton.** The list's and Storage's text placeholders take `shape="text"` (with the new `rounded-xl` default they'd have become pills).
- **Input Group** unavailable also takes `pointer-events-none`, so its hover border doesn't come back over a field that can't be used.
- **Baselines.** The Inbox in GitHub, Lumen and Atelier Light changed beyond the button and key: their read rows' names rasterize heavier since the button commit, with identical computed styles before and after (weight 600, the same color and family; checked in the page). The new rendering is the right one: the macOS design draws every sender at 600 (Apple Mail's look, read or not), and the same run draws Terno Light's 600 lighter, so headless Chromium's system-font rasterizing varies by palette, not the CSS; the new baselines were looked at and kept. Filters' close still overlaps the AI card's corner, as the old one did.
