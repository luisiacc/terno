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

## Implementation notes (phase 2a)

Part B's radio group, color swatches, number field, pagination, collapsible, accordion and progress, and their Part C adoption. Where the code pushed back:

- **Radio card.** BoardUI's radio source has no card variant; `RadioCard` is the radio itself as a bordered card (`border` on `card`, a contact shadow), the primary edge when chosen (the border plus a 1 px primary shadow, no layout shift), with `RadioDot` inside it. The palette and style grids show the dot only on the chosen card (as the old check did: twenty empty rings would be noise); first run's two layout rows show it always. The cards now sit on the column's line (their edge, not their preview, aligned with the text), as bordered boxes do; first run's palette list is padded by the 6 px it already reached past the column so the edge and the ring aren't clipped.
- **Radios take Space, not Enter** (Base UI, as the platform's radios). The designs spec that chose a style card with Enter now presses Space; first run's "Enter doesn't advance" still holds (Enter does nothing on a radio).
- **Swatches.** The settings swatches are now filled 24 px circles (BoardUI's), not 14 px dots in a 24 px target; the composer's text colours are filled too, its highlights keep the "A" in the highlight's ink, and "none" its stroke. The chosen ring is inset: 2 px of `card`, then a 25 % ink hairline (no literal white). Clicking the composer's chosen swatch still re-applies it (a radio fires nothing for its own value; a mixed selection shows "none" chosen). Test ids kept, now on the radios themselves; the specs' `check({ force: true })` lost its `force`.
- **Number field.** Base UI's input is `type="text"` with no spinbutton role: the specs find it by its label (revision 2). `DaysField` keeps its contract with `allowOutOfRange` (a typed 3 stays, with the reason), `null` for an emptied override, and its own Enter, which reads the typed text (Base UI commits on blur only); a stepper or arrow-key step commits at once, as Base UI defines it. The ports drop the steppers (nobody steps to a port), clamp to 1–65535 on blur and never group digits (`format={{ useGrouping: false }}`, also on the days). The filters' age field had no name; it is "Number of days" now. "Increase"/"Decrease" go through `en`/`es`.
- **Pagination** is BoardUI's simple form only (no page numbers: the settings lists are short). Its ends are unavailable but focusable (`focusableWhenDisabled`), so paging to the last range keeps focus on Next. Each pager names its nav (Sent-copy recovery, Recipient outcomes, Recipients) so three in one account editor stay distinct landmarks; the old per-feature Previous/Next strings are gone. Pagination needed an `ArrowRight` icon (catalog + `gen:icons`).
- **Accordion vs. Collapsible.** The accounts list is an `Accordion` (`multiple`, opened on the account Settings was opened for; each header an `h4` under the group's `h3`). A category's row is a `Collapsible`, not an accordion item: its header row also holds the auto-add switch, which can't sit inside the heading's button. The panel clips while it animates, so it reaches 4 px past its sides (padded back in) to keep the rings of controls at its edges. Base UI sets `aria-controls` only while open; capture recovery passes its own id and `keepMounted` to keep the region its unit test (and screen readers) expect while closed. Chevrons moved from a right-pointing one turning 90° to BoardUI's down-pointing one turning 180°, at the row's end (the snippet editor's "Also fills in" too, which had it first).
- **The update pill's "What's new" stays hand-built**, against the phase's brief: the pill is in the entry chunk, and revision 6 keeps Collapsible to the lazy settings and diagnostics disclosures. Diagnostics had none left to move.
- **Progress** is plain markup (revision 6) on the field wash (the sidebar's border colour before), the fill in the full primary (80 % before), moved by a transform; an unknown amount still draws a third and a started one at least 4 %. The sync sheen is a child over the track, paused while the card is closed as before. Its label row is Progress's own (the name labels the bar; the short count is hidden, the long one is `aria-valuetext`).
- **Entry chunk.** Checked in the web build's source maps: Base UI's radio, radio group, number field, collapsible and accordion land only in lazy chunks (`RadioGroup-*`, `number-field-*`, `settings-dialog-*`); the entry chunk gains only `progress.tsx`. There is no entry-size gate in `load.perf.test.ts` (it measures the backend's event loop).
- **Baselines** changed only where the controls did: Appearance (every design), first run's two steps (light and dark), and General's and Appearance's Spanish shots; all looked at.

## Implementation notes (phase 2b)

Part B's icon button, announcement, chip, search field and toast look, the Spinner, CloseButton and link-button adoption, and their Part C moves. Where the code pushed back:

- **The palette's hint keys** come from Shortcut's symbols (`keyLabel`, exported), so the i18n scan passes for `command.tsx`. Its remaining failures are all `apps/site/src/copy/en.ts`, which this branch never touches.
- **IconButton** is `Button` (ghost, or `outline` for BoardUI's bordered secondary) inside a Tooltip with the label and a `Shortcut`; `label` is required and is the name. It replaces the reader's `ToolButton` (the toolbar's `no-drag` and line weight stay a class at the call site; the star's colour and Older's `aria-busy` pass through), the draft's `ToolIcon` and `BarButton`'s toolbar form; the pane form keeps its labeled outline buttons, with the key alone in its tooltip (revision 8). **In the composer** only the link bubble's three icons moved (they gain tooltips): the format bar's tools are Base UI `Toolbar` buttons (one tab stop, arrow keys, `aria-pressed`, and `render` into menu and popover triggers), a different primitive than a Button with a tooltip. The reader's bell stays a Popover trigger inside its tooltip for the same reason.
- **Announcement** is the list banners' one class list on `bg-tint` (Terno's insets), with BoardUI's medium title, muted text, actions 6 px under it, and an `xs` CloseButton centred on the first line. A `role` (status, group) is named by the title; a plain one carries no name. The learned offer keeps its sentence regular with the sender in medium (`titleProps`), so its emphasis stays; the forward question's question is now the medium title (it was regular). **The web's Mac banner** fits as an `inline` announcement (one line, the text truncating, the download an outline `xs` button before the close, still "Hide for a week" for 7 days): the same behaviour, on the tint instead of a bordered muted box.
- **CloseButton everywhere in the table:** the banners (through Announcement), the sign-in notice's Later (in its tooltip, the sidebar's ring), the snack's close, a filter condition's remove, the chips (attachments, the reader's, the palette's page) and the search's clear. Each keeps its name: "Close" (learned), "Dismiss" (problem row), "Hide for a week", "Later", the snack's "Dismiss", "Remove condition", "Remove <file>", "Remove/Not <category>", "Back to all commands", "Clear search". **Filters' close** moved to the sidebar header's line (`top-4 end-4`) and the editor now starts under it (`pt-12`, the sidebar list's first line), so it no longer covers the AI card's corner. The icon-line spec leaves the close's × its own 1.5 px (a surface tuning its line, as AGENTS.md allows); it now shows on the inbox.
- **Chip** is BoardUI's styled span on the field wash (`h-6 rounded-md px-2 text-xs font-medium`) with a `dot` and an optional `CloseButton 2xs` whose `removeLabel` is required (a type union) and which gets the click event. The reader's category chips lost their tinted badge for a dot on the field wash (BoardUI's chip has no colour wash in our palette); the account chip beside them moved too, so the row is one shape. The suggestion keeps its dashed accent outline (not filed yet) around its accept half and the ×. The specs find a filed category by `data-testid=category-chip` (the badge's `data-slot` is gone). **The palette's page token** was one button (click anywhere to go back); as a chip, the name is text and its × (`palette-back`, "Back to all commands") goes back, so the spec's Shift+Tab lands on `palette-back`.
- **SearchField** forwards its ref to the input and runs the caller's `onKeyDown` first; `clearOnEscape={false}` lets the list keep its own Escape (clear, then close and give focus back). Its clear is out of the tab order and keeps focus in the field (BoardUI's); the list's old clear was tabbable and dropped focus to the body when it vanished. The list keeps its 30 px tint field, but the Input shell's transparent border is back, so the field shows Input's hover border (and the text sits 1 px further in). `pnpm test:ui-perf` passes (search keystroke → results 8.6/15.7/19.3 ms against 100).
- **Spinner adoption.** No `Loader2`/`LoaderCircle` is left; `animate-spin` remains only on the update pill's progress ring (a ring that fills, already `motion-reduce:animate-none`). Busy buttons take `loading`: where the button had an icon at rest the spinner takes its place (Google, Print, Save PDF, Reconnect, Create with AI, the model refresh); where it had none the label is hidden under the spinner (Use here, Try again, Verify, Connect, Test, Check now). Google's sign-in button keeps its "Loading Google…" label beside an inline Spinner (the label is the information). `loading` disables the button, so a second Print or Save PDF while one runs is now refused (before, only `!ready` disabled them).
- **Link buttons.** Nine raw text buttons are `Button variant="link"` or a new **`link-secondary`** (BoardUI's secondary link, in the ink: underlined on hover, muted when pressed). The accent fails AA on the tint in three palettes (Terno 4.37, Apple 4.17, Solarized 4.26) and on a draft's surface (axe: 4.35 in Terno Light), so the select-all banner's and the draft's links (save a copy, retry, the quote's, a forward's Try again) are the secondary link; the update pill's "What's new", the solo search's "Search all accounts" and the link bubble's address are the accent link. The contrast suite now checks the accent as text on panes and cards. The waiting count (an `aria-pressed` filter toggle), the "Filtered by" criterion (a menu trigger) and the mail body's autolinks (anchors) stay as they are.
- **Toast look.** `snack-surface` is the solid popover with `shadow-menu` (the glass and its blur go), `rounded-xl`; the action pill keeps its countdown ring as its border and takes the secondary button's card fill and contact shadow; the close is the round CloseButton; the loading tone is the Spinner. The store and its behaviour are untouched. The native reload notice moved to the same surface (popover, `shadow-menu`, a medium title); its labeled Close stays (it owns focus return).
- **Entry chunk** (the web build's index plus every modulepreload, before the first commit vs after): index 408,986 → 406,035 B raw (129,023 → 128,583 gzip); every eagerly loaded chunk together 1,715,491 → 1,714,569 B raw (558,089 → 559,390 gzip, +1.3 KB). `Loader2` and `X` left the eager set, `close-button` joined it.
- **Baselines.** The inbox and reply shots in every design (the banner's round close, the reader's chips, the search field), the inbox in every palette, three palettes' HTML reader, the unread filter's header, the dracula drag, and visual.spec's AI filter builder, search, HTML newsletter and settings shots; all looked at in light and dark. visual.spec's settings and search shots were already stale before this phase (phase 1's dialog close, phase 2a's number field, plan 97's removed Local pill) and now show the current app. `visual.spec`'s "settings: AI on a local model" (light and dark) fails before its screenshot ("40k ctx" never shows on the model option) with this phase's `ai-tab.tsx` change reverted too; the branch touches nothing in `packages/ai` or the backend, so it is not this phase's.

## Revisions after the Codex code review

Six findings on the whole branch, each fixed with a regression test that fails without its fix (checked by running it against the code before the fix):

1. **A busy text-only button lost its name.** The label under the spinner was `invisible` (out of the accessibility tree) and the spinner `aria-hidden`, so "Connect account" or "Verify" had no name while busy and focused. The label is now `opacity-0`: it still holds the width and names the button. `controls.spec` checks the busy button's accessible name in every design (it read `""` before).
2. **Going back to the still-chosen style didn't cancel a pending switch.** A radio reports no change for its own value, so clicking the original style while another waited for its faces never reached `updateAppearance`, and the other style applied later. The chosen style card's click is a choice again, in Settings and in first run (`style-reselect.test.tsx`).
3. **First run's chosen palette clicked again no longer previewed its mode** (following the system, a light preview stayed light on a click of the chosen dark palette). `ThemeCard` takes an `onClick`, and first run's chosen palette cards choose again, setting the preview's mode as every card's click did before the radios (same test file).
4. **Unparseable text in the sync window stayed silently.** Base UI commits nothing for text it can't read (".", "-") and, on its next render, puts the last number back. `NumberField` gains `onUnparsed`: an edit with no digit at all skips Base UI's blur (so the text stays the user's, still marked edited, and leaving again checks it again) and is reported; any other text Base UI can't read is reported after its blur. `DaysField` shows its existing reason and `aria-invalid` (`days-field.test.tsx`).
5. **Enter and Tab parsed differently.** Enter read the text with `Number()`, leaving the field with Base UI's locale-aware parser ("45,0" in es-ES saved on Tab, failed on Enter). `NumberField` gains `commitOnEnter`: Enter leaves and re-enters the field in the same frame, so it goes through Base UI's own commit and focus stays. The test types forty-five in Eastern Arabic digits, which Base UI reads and `Number()` can't (the test runtime's locale can't be es-ES). Fixes 4 and 5 share that commit path and landed together.
6. **Base UI's `aria-roledescription="Number field"` was English in Spanish.** It comes from the catalog now (`ui.numberField.role`, "Campo numérico").

`visual.spec`'s "settings: AI on a local model" failed intermittently while checking these fixes (the Ollama stub's model detail, "40k ctx", missing from the first option): 2 of 2 in a full run and 3 of 3 once, then 6 of 6 passing on the same code, and passing on the code before these fixes too. Nothing here touches the AI tab or its model list; noted as a flake.

A second Codex pass over those six fixes found three more problems, each fixed with a regression test seen failing without its fix (its fourth point, Han numerals, was skipped as too rare):

7. **The no-digit guard skipped Base UI's blur for every number field**, not only one whose caller handles unparsed text: a port left at "." kept that text after the form set a new port (Base UI's input sync stayed off), while the form held the new one. The guard now runs only when `onUnparsed` is given; otherwise Base UI's own blur cleans up (`number-field.test.tsx`).
8. **A second Enter after a failed save did nothing.** `commitOnEnter`'s blur commits only after an edit, and the first Enter's blur used that up. When an Enter's blur neither commits nor reports unparsed text, the field commits its parsed value itself (with Base UI's `createGenericEventDetails`), so a rejected save is retried (`days-field.test.tsx`).
9. **Arrowing back to the chosen style didn't cancel a pending switch.** Base UI chooses an arrowed-to radio through its hidden input, past the card's `onClick` (fix 2's path), and the still-checked style reports no change. `RadioGroup` gains `onReselect`: the chosen radio clicked, or focused by an arrow key (a flag set on the group's arrow keydown and read by the next focus, since Base UI moves focus a render later); a plain focus (Tab) isn't a choice. Appearance's and first run's style groups and first run's palette groups use it, replacing the per-card clicks of fixes 2 and 3 (and `ThemeCard`'s `onClick`). `style-arrows.test.tsx` arrows Lumen → Atelier → Lumen while Atelier's faces are still loading (`document.fonts` held) and checks that Lumen stays, in both places.

## After the review: the pickers fill their row

Luis pointed at the hole beside Appearance's style cards: fixed 180 px cards wrapped in pairs, leaving a third of the row empty. The style cards are now a two-column grid and their previews stretch with them, taller and with more rows, so a mock reads as a list running on. The color cards had the same hole and now use first run's `repeat(auto-fill, minmax(144px, 1fr))`: three columns in the dialog, two in a narrow window. A fixed three columns cut off "Catppuccin Latte" at 640 px (Codex review, `themes.spec`'s narrow window test seen failing without the fix). First run's style cards go from three columns to four, so Luma isn't alone on a row.

## After the review: nothing runs under Settings' close

The round close is pinned to the sheet (the restyle moved it onto the title's line), but the title scrolled with the section, so scrolled content ran under the close. The section's title now has a row of its own above the scrolling pane, with the existing `scroll-hairline` marking the edge once content has scrolled; at rest the sheet looks the same (no baseline changed). The Codex review found that the recovery tests open Settings in jsdom, which has no `IntersectionObserver`; they stub it as the reader's tests do.
