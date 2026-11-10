# BoardUI → Terno: the base catalog

Terno's shared controls (`src/components/`) are BoardUI's free **Base** components (boardui.com, MIT), drawn in Terno's tokens on Base UI (plans 117–122, 125). This file lists every one of BoardUI's 48 Base components (as on boardui.com/components, 2026-11-02) and where it lives in Terno. **Update it whenever a component is added or ported.**

## How to port one

1. Look on **boardui.com/components/<name>** (never the GitHub export, which lags the site). Its source is `https://www.boardui.com/r/<name>.json`. Use only components without a **Pro** mark.
2. Its structure, parts, variants, size proportions, spacing, weights, states (rest, hover, pressed, open, selected, disabled, invalid) and indicators are the spec.
3. Translate it, keeping what is Terno's:
   - **Colours:** our tokens, never BoardUI's palette. Its neutral steps become `foreground`, `muted-foreground`, `muted`, `field`, `card`, `popover` and `border`; its accent becomes `primary`; its error becomes `destructive`. Text goes only on pairs in `CONTRAST_PAIRS` (add the pair when it's a new fill).
   - **Primitive:** Base UI's when it has one. React Aria only for a part Base UI lacks (the Time Field).
   - **Heights:** Terno's control heights (32 px default, a menu's row 28 px), not BoardUI's 36 px.
   - **Corners:** the radius ladder, with corners concentric with what they hold (plan 119).
   - **Icons:** Hugeicons from `@terno/ui/icons`, at one line weight; tune it with `--icon-line`.
   - **Focus:** `focus-visible:` rings.
   - **Motion:** within `--motion`, and none when motion is reduced or off.
   - **The house look:** filled fields (`bg-field`, the border only on hover, focus and error); the secondary as a 1 px border on `card` over `shadow-xs`; the primary lit from the top, between `primary-hover` and `primary`; floating panels solid on `popover` with `shadow-menu`, menu rows highlighted in `muted` (`[--accent:var(--muted)]`); a choice of a few is `ToggleGroup variant="segmented"` (a track with a thumb, never separate outlined buttons); a panel of rows is `rounded-menu` at `p-1.5` (`rounded-palette` for command lists), anything else the inner radius plus the gap. Check it in every design, light and dark (`e2e/controls.spec.ts`, `e2e/menu-corners.spec.ts`).
4. Write any deviation, with its reason, under "Deliberate deviations" below and in the plan.
5. Probe its resting look in `apps/web/e2e/helpers/controls-markup.ts` + `controls.spec.ts` (every design, light and dark). Test its open or floating parts through a real caller.

**Never hand-build a control that is in this table.** If a screen needs one, use the Terno component. If it says "port on first use", port it here first.

## The catalog

| BoardUI | Terno | Notes |
| --- | --- | --- |
| Accordion | `accordion.tsx` | Base UI Accordion (plan 125) |
| Announcement | `announcement.tsx` | the banners above the list |
| Avatar | `avatar.tsx` | the app's own avatars are `sender-avatar.tsx` (per design) |
| Badge | `badge.tsx` | |
| Breadcrumb | port on first use | |
| Button | `button.tsx` | primary, `outline` (BoardUI's secondary), `destructive` (danger), `link`, `link-secondary`, `loading` |
| Button Group | `button-group.tsx` | the reader's Reply and its menu (plan 158). Send's filled split button is still a one-off (`send-button.tsx`) |
| Carousel | port on first use | |
| Checkbox | `checkbox.tsx` | with `indeterminate`; `CheckboxMark` is the same box as a picture, for a row that is itself the control (an option's children can't be focusable, plan 143). Deviation: `target` draws the 16 px box inside a 24 px control of its own, with a hover fill its size, for a box beside a larger button (the digest, plan 161), where a near miss would hit the button; `target="quiet"` outlines the box when ticked too (the ink's mark on the card, the edge at the hover's), for a long column that starts ticked, where solid squares outshout the rows (plan 161, pass 3) |
| Chip | `chip.tsx` | an optional named remove |
| Close Button | `close-button.tsx` | |
| Color Picker | `color-swatches.tsx` | only the preset row, on RadioGroup |
| Combobox | port on first use | the recipient field is a widget of its own (`recipient-input.tsx`) |
| Command Palette | `command.tsx` | cmdk underneath |
| Context Menu | `context-menu.tsx` | rows from `menu-styles.ts` |
| Date Calendar | `calendar.tsx` | react-day-picker; no ranges yet |
| Date Picker | `calendar.tsx` in a Popover | the trigger is the secondary button |
| Divider | `separator.tsx` | a hairline; labelled and double dividers: port on first use |
| Drawer | port on first use | |
| Dropdown | `dropdown-menu.tsx` | rows from `menu-styles.ts` |
| File Upload | port on first use | the composers' drop zone is `composer-drop.tsx` |
| Icon Button | `icon-button.tsx` | the label and shortcut in its tooltip; `ghost` (the quiet toolbar) or `secondary` |
| Input | `input.tsx`, `input-group.tsx`, `label.tsx` | hint text and field errors: port on first use |
| Input OTP | port on first use | |
| Link Button | `button.tsx` `link` / `link-secondary` | |
| Meter | port on first use | Storage's segmented bar is the app's |
| Modal | `dialog.tsx`, `alert-dialog.tsx` | ours: `movable` drags a config dialog aside (plan 129, `lib/dialog-move.ts`); BoardUI's doesn't move |
| Notification | port on first use | |
| Number Field | `number-field.tsx` | |
| Pagination | `pagination.tsx` | the simple Previous / range / Next form |
| Popover | `popover.tsx` | |
| Progress | `progress.tsx` | plain markup |
| Radio | `radio-group.tsx` | with `RadioCard` |
| Search Field | `search-field.tsx` | |
| Segmented Control | `toggle-group.tsx` `variant="segmented"` | |
| Select | `select.tsx` | rows from `menu-styles.ts` |
| Skeleton | `skeleton.tsx` | |
| Slider | port on first use | |
| Social Button | port on first use | |
| Spinner | `spinner.tsx` | |
| Switch | `switch.tsx` | |
| Table | port on first use | |
| Tabs | `tabs.tsx` | default = the segmented track; `line` = BoardUI's tabs |
| Tag Group | port on first use | the quick filters are a ToggleGroup |
| Textarea | `textarea.tsx` | |
| Time Field | `time-field.tsx` | React Aria (plan 122) |
| Toast | `snack-dock.tsx` (apps/web) | the snack's store and behaviour are the app's; the surface is BoardUI's |
| Tooltip | `tooltip.tsx` | |
| Tree View | port on first use | the sidebar's folders are the app's |

Terno's own, with no BoardUI counterpart: `card.tsx`, `scroll-area.tsx`, `toolbar.tsx`, `category-dot.tsx`, `kbd.tsx`/`shortcut.tsx` (BoardUI's Kbd lives inside its palette), `modal-host.tsx` (behaviour only).

## Deliberate deviations

Each item says what differs from BoardUI and why.

- **Ghost button:** stays transparent with a `muted` hover. BoardUI's ghost is an accent wash and it has no transparent button, but Terno's toolbars are Apple Mail's quiet icons.
- **Ghost and link when unavailable:** they fade with opacity. Their glyphs are muted at rest, so a muted colour alone would leave a disabled icon looking live.
- **Danger:** it runs from the red to a darker shade, not to a lighter top. White on anything lighter than the red fails AA.
- **Shortcuts are keycaps everywhere (plan 158):** a menu row's shortcut is `Shortcut`'s keycap, as in the palette, tooltips and buttons, not BoardUI's plain menu text: one chord is one keycap in Apple's modifier order (⌃⌥⇧⌘), so the same key never reads three ways.
- **Context menu edges and columns:** at a window edge it shifts to fit instead of flipping, so its first rows stay by the pointer. The thread list's menu is the exception (plan 160): it stands by the row it's about, below it or flipped above it, so it never covers that row. Every menu, popover and select keeps `--float-inset` (12 px) from the window's edges, not Base UI's 5. A panel with a submenu keeps a chevron's column on every row, so shortcuts and chevrons form separate columns.
- **Destructive menu rows:** they keep a red wash when highlighted. Red text on `muted` fails AA in six palettes.
- **Segmented control in dark (plan 160):** the chosen thumb is the field's wash, not `muted`, which sat at 1.2:1 on the track, under the tint floor.
- **Filled fields (plans 118, 160):** the wash is the `field` token, the ink at 7 % in every palette. Plan 160 once deepened it until the field stood 1.35:1 off the list; the owner found that too dark and chose the lighter fill back (2026-11-08).
- **Kbd:** it sits on the field wash, not on `border`. Muted text on `border` fails AA in GitHub Light and Dark.
- **Links on the tint and in drafts:** these use `link-secondary` (ink), because the accent fails AA there.
- **Calendar:**
  - Other months' days stay visible, muted, because a date chosen next week can fall in the next month.
  - Cells are 4 px apart, not 12, so the calendar fits the 320 px popover.
- **Command palette:** stays 640 px wide at 18 % from the top, because long subjects need the room. Rows are 36 px, not 40, so more of them show; the list keeps one height so the hint row never moves, and a section's heading stays while its rows scroll.
- **Skeleton and spinner:** the skeleton pulses without BoardUI's sheen, and the spinner has no glow layers. Both effects would repaint continuously.
- **Radio card:** BoardUI's radio has no card variant, so Terno's is the radio drawn as a bordered card.
- **Progress:** plain markup rather than Base UI's.
- **Search clear:** out of the tab order, as BoardUI's.
- **A composer's header rows (plan 161):** To and Subject are bare fields on the row's hairline, Apple Mail's form, not the filled Input or Textarea: the row is the field, and its label and text sit on To's lines.
- **The AI strip's change field (plan 164):** the input group (a textarea and an icon-only submit as its inline-end addon) at the strip's 28 px instead of 32, one line that grows (`field-sizing: content`), its focus ring 2 px at a fifth of the ring color rather than 3 px solid: it sits on a 38 px row between quiet icons, where the full ring read as an alert.
- **Announcement's `wrap` (plan 159):** an inline announcement may wrap its title instead of truncating it, so a learned rule's condition is read whole before it's accepted. BoardUI's inline announcement truncates.
