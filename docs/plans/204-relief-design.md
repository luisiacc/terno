# 204 · Relief: a tactile style from two reference widgets

## Request (verbatim)

> can you build a new style for settings with this style, please look at it and see how it works, colors, shadows everything, it looks very clean , can you copy perfectl this style and use it

With two pictures:

1. **Light.** A `#E8E8E8` card with large corners on a `#C9C9C9` page. A black disc with an up arrow (lit from the top, `#2F2F2F` to `#101010`), "Auto-ship releases" in `#1F1F1F` and "On · Nightly" in `#565656`. A toggle: a recessed grey track (shaded at the top) and a pale thumb with a metal rim, a dark ring outside a white one. A black embossed checkbox with a white tick. A segmented control: a recessed `#CACACA` track, "Stable" and "Beta" in `#656565`, "Nightly" raised on its own rimmed pill with a white line under its letters. A flat `#E0E0E0` strip with a grey dot and a status line.
2. **Dark.** The same language at night. A `#212121` card lit from the top (`#2E2E2E` to `#1C1C1C`) with a deep soft shadow. Four recessed progress tracks (`#121212`), one filled in a lit grey. A recessed `#0F0F0F` well with a monospace line. "About **9s** left" in `#969696` and `#EDEDED`. Two raised dark pill buttons (lit top edge, dark rim, drop shadow). Above, a black "Atlas 2.6 · Building" pill with a green glow, and a rimmed pale "Share" pill.

The owner chose, when asked:

- **Scope:** a sixth app-wide style next to Lumen, Graphite, Atelier, Luma and macOS, picked in Settings → Appearance → Style. Its controls, cards, buttons and Settings all get the look.
- **Colours:** a new neutral grey palette matching the pictures, with a dark version in the same spirit.

## What exists

- A style is a design (plan 15) plus a palette pair. Graphite (plan 137) is the last one added; its plan has the recipe.
- **Depth isn't a design value.** Every control's relief is written into its classes, the same for every design: the switch's thumb shadow and lit track (`switch.tsx`), the checkbox's contact shadow and lit tick box (`checkbox.tsx`), the radio (`radio-group.tsx`), the segmented control's track and chosen item (`toggle-group.tsx`, `toggle.tsx`), the primary and outline buttons (`button.tsx`), the progress bar (`progress.tsx`), Settings' groups (`card-group` in `globals.css`). A design can change their corners, never their depth.
- Shadows already take the palette's `--shadow-color` and `--highlight`, so they're token references, as the rules ask.
- `surfaces.card` is `tint | outline`; neither is a raised card.

## Design

**Relief** (Spanish: *Relieve*) is a sixth design. The name says what it is: things stand up from the surface or sink into it. Nothing changes in the other five: every new value below is set to exactly what they draw today, and their baselines hold.

### The fit: depth becomes a design value

One new required value, `surfaces.depth: "flat" | "relief"`. `designs/depth.ts` holds the two presets, each a full set of CSS values over token references (no colours), and `generate.ts` writes them as variables in each `[data-design]` block, so a nested preview draws in its own design as everything else does:

| Variable | Draws | `flat` (today's, verbatim) |
|---|---|---|
| `--depth-raised` | a neutral raised control: outline button, segmented chosen item | `var(--shadow-xs)` |
| `--depth-raised-sheen` | its fill's light (a background image) | `none` |
| `--depth-ink` | the primary button | `inset 0 1px var(--highlight), 0 1px 2px var(--shadow-color)` |
| `--depth-box` / `--depth-box-on` | a checkbox or radio, off / on | `var(--shadow-xs)` / `inset 0 1px var(--highlight)` |
| `--depth-thumb` | the switch's thumb | today's two-layer contact shadow |
| `--depth-well` | a recessed track: switch, segmented control, progress | `0 0 transparent` |
| `--depth-card` | a card of rows (Settings' groups), outside its ring | `0 0 transparent` |
| `--depth-nav` | the chosen sidebar item | `0 0 transparent` |
| `--emboss` | the letterpress line under words on a raised neutral control | `none` |

The components read the variables instead of their literals: one class swap each, no JS, no new DOM. The dark-only literals (the segmented item in dark) get a `-dark` twin.

`surfaces.card` gains `raised`: the card's own fill, its edge, and `--depth-card` under it.

### What `relief` draws (light, from picture 1)

- **Raised neutral** (outline buttons, the chosen segment, the Share pill): a 1 px rim in the ink at ~25%, a white inner ring, a lit top line, a short contact shadow and a softer one below; a top-lit sheen over the fill; words embossed with a white line under them.
- **Ink** (primary buttons, a ticked box, New message): the picture's black disc: lit from `#2F2F2F` to `#101010`, a lit top edge, a dark rim, a drop shadow.
- **Wells** (switch track, segmented track, progress track): an inner shadow at the top and a light line at the bottom edge, as the picture's tracks are shaded.
- **Thumb**: a pale disc, a dark outer ring and a white inner one (the metal rim), over a contact shadow.
- **Cards**: the card's fill, a hairline, a soft wide shadow.

Dark (picture 2) is the same recipe on its own palette: raised dark pills lit at the top edge, wells near black, cards lit from the top.

### Deliberate deviations from the pictures

- **A switch that's on is the ink**, not grey. Picture 1's toggle is on with a grey track, so on and off differ only by the thumb's side. Settings has some forty switches; the ink says "on" at a glance, and it is the pictures' own colour for on (the ticked box, the disc).
- **Text reaches AA.** Picture 2's inactive steps (`#2C2C2C`–`#6A6A6A` on `#212121`) are under 3:1; the dark palette's quiet ink is `#969696`, the picture's "About … left", at 5.8:1.
- **Off switches and unchecked boxes keep 3:1** (plan 137's `control-edge`): picture 1's track (`#A8A8A8`, 1.9:1 on its card) is lighter than that, so the track's fill stays pale and its 1 px rim carries the 3:1.
- **No green glow.** The "Building" pill's green marks a live process; Terno's only live bar is the sync's, which keeps its own. The unread dot keeps Graphite's sky blue, since plan 194 keeps category colours away from unread's hue, and lime and emerald are categories.
- **The page behind the card** (`#C9C9C9`) isn't a surface in a mail window; the sidebar is the card's step down instead.

### `designs/relief.ts`

Graphite's structure, with the pictures' shapes:

| | Value |
|---|---|
| Type | SF (Geist where SF can't go), Graphite's roles and scale, regular and medium |
| Corners | 10 px rows and fields, pill navigation, 18 px cards and dialogs, pill buttons |
| Compose | `sidebar-pill`: Lumen's soft raised pill, which in Relief is the picture's rimmed Share pill (the black fill stays for Send and the other primaries, as Lumen's rule says) |
| List header | `title`, with the All/Unread segmented control (the picture's control) |
| Search | `field`, a well |
| Rows | `classic`, no avatars |
| Reader header / reply | `classic` / `pill` |
| Surfaces | draft `card`, inbox count `muted`, CTA `pill`, card `raised`, depth `relief` |

### The palettes

`relief-light` and `relief-dark`, neutral, with Graphite's sky blue for unread.

| Token | Light | Dark |
|---|---|---|
| `background`, `pane` (list, reader) | `#E8E8E8` | `#1E1E1E` |
| `sidebar` | `#E0E0E0` | `#191919` |
| `card` (raised fills, Settings groups) | `#EFEFEF` | `#262626` |
| `popover` (menus, dialogs) | `#ECECEC` | `#232323` |
| `foreground` | `#1F1F1F` | `#EDEDED` |
| `muted-foreground` | `#565656` (6.0:1) | `#969696` (5.8:1) |
| `primary` / `primary-foreground` | `#1C1C1C` / white | `#E6E6E6` / `#1C1C1C` |
| `control-edge` | `#858585` (3:1) | `#7A7A7A` |
| `highlight` / `shadow-color` | white 60% / black 16% | white 9% / black 55% |

Every pair goes through the contrast suite (`CONTRAST_PAIRS`, `CONTROL_EDGES`, the hairline and tint floors); where a picture's value fails, the palette moves, not the floor.

### Everything else a design needs

The id in `DESIGN_IDS` and `theme.js`, its `en`/`es` name and description, `DESIGNS` order (after Graphite: the two greys side by side), the Style picker (one row of six, or two rows of three when narrow, never a style alone on a row), first run's tiles (two rows of three: six in its 332 px column would cut "Graphite"), a Playwright project `e2e-relief` in `FLOWS`, and the UI rating's style list and names.

## Tests

- Unit: the generated CSS (`gen:designs` in sync), every flat design's depth variables equal today's literals (so a changed preset fails), the counts of designs and palettes, and every Relief pair in the contrast suite. The theme CSS budget holds.
- Unit (new): Relief's palette holds the pictures' values where AA allows (the table above).
- e2e (new, `relief.spec.ts`): in the running app, a switch's thumb, the chosen segment, an outline and a primary button, a ticked box and a Settings group carry Relief's shadows; the same controls in Lumen compute exactly what they did; a nested Lumen preview inside Relief draws flat.
- e2e: `e2e-relief` runs every `@design` flow with its own baselines; `test:e2e` includes it. The other five designs' baselines pass unchanged except the Style picker and first run's tiles.
- Visual: inbox, reader, reply, palette, menus, Settings and first run, light and dark, beside the pictures.
- UI rating: Relief joins the rated styles (plan 158).

## Perf

No JS on a hot path: variables and one class swap per control. One more `[data-design]` block (about 2 KB) and one palette pair. Shadows only on controls, which aren't in the virtualized list's rows; the list's rows stay flat, so scrolling paints what it paints today.

## Out of scope

- The pictures' build widget, terminal well and multi-step progress: Terno has no such screens.
- Making Relief the default.
- The marketing site's style list.


## Revisions after the Codex review of the plan

Twelve points, all taken:

1. The switch's on track already had a lit edge, so it has its own variable (`--depth-switch-on`) apart from the off track's. The off track's pale fill needed its own too: `--depth-track` and `--depth-track-dark` (flat: `control-edge`, and 80% of it in dark, as before), and `--depth-switch-off` puts the 3:1 edge on it as a rim.
2. `var(--shadow-xs)` is a `@theme` alias that resolves at the root, so a nested preview in another palette would draw the outer one's shadow. The presets write it out; a unit test rejects any `--shadow-*` alias or literal colour in a preset.
3. `sidebar-pill` is `ComposePill`, which draws its own pill (and first run's preview a copy). Both read the depth variables now. It stays Lumen's soft raised pill rather than the black one: the plan's table changed instead. The mini-mock is `DesignPreview` in `appearance-tab.tsx`; it needed no change.
4. Send's group draws the primary's fill and shadow itself; it reads `--depth-ink`.
5. Fields had no depth: `--depth-field` sinks `Input`, `Textarea`, `InputGroup` and `NumberField`. Cards get `--depth-card-sheen`. The other raised neutral controls that drew `shadow-xs` on a border (`Select`'s trigger, `ButtonGroup`, `TimeField`, `RadioCard`, the tabs' thumb) read the same variables as the outline button; their borders are `--depth-edge` (flat: `--border`; Relief: its rim) and `--depth-edge-firm`.
6. The dark edge is `#858585`, which holds 3:1 at 80% over the popover; Relief's off track is pale with that edge as its rim.
7. Relief is in the 3:1 control-edge test and out of the "every other palette is `input`" one, and in `RATED_PALETTES`.
8. The test that keeps the plan-15 designs as they were now leaves Relief out, as it leaves Graphite. Relief's weights are its own (550 and 600), not Graphite's cap.
9. First run: two rows of three (see above), and `first-run.spec` counts six and walks Relief.
10. Thread rows draw `CheckboxMark` in select mode, so Relief's checkbox shadow is in the list. Flat designs draw exactly what they did, so the perf gates (run in macOS) are unchanged; Relief's box is two shadow layers on a 16 px box, painted once per visible row.
11. Relief's project runs `@design` and a new `@variant-relief` tag, on the axe sweep and motion; `designs.spec`'s live switch walks Relief.
12. `rate.mjs`'s names map has Relief.

## As built

- `packages/ui/src/designs/depth.ts`: the two presets, `DEPTH_VARS` and `DEPTHS`. `flat` is held to the literals the controls drew before (`designs.test.ts`), so the five older designs render as they did: across `e2e` and the four design projects, every baseline is unchanged except the ones that show the Style picker (Settings → Appearance, in each design and in Spanish, and `themes.spec`'s) and first run's tiles.
- `relief-light` / `relief-dark` in the registry, and a derived `depth-rim` token (black at 24% / 60%) for every palette.
- `e2e/relief.spec.ts`: Relief's controls, Settings' cards, the switch and the chosen tab measured in the running app; a nested Lumen preview's depth is flat; macOS's controls compute exactly Tailwind's `shadow-xs` and no sheen or emboss.
- `controls.spec` runs in every design id, so Relief too: its secondary and radio card borders are compared with the design's raised edge rather than `--border`.
- Already failing on the base commit (`4d940ab1b`, checked on a clean copy): `motion.spec`'s "in a design" flow (the list's listbox never shows) in Lumen and Atelier, so in Relief too.

## Revisions after the Codex code review

Three findings, all fixed, each with a test that fails without the fix:

1. The chosen sidebar row's lift (`data-active:shadow-(--depth-nav)`) is emitted after the outline a right-click menu draws on its row, so the chosen account or category lost that outline, in every design (flat's lift is a transparent layer). The outline is important now; `account-menu.spec` right-clicks the chosen row too.
2. Relief light's star was 2.8:1 on the open row; it's darker (`0.53 0.13 66`), and Relief is in the star-on-rows contrast test.
3. The composer's From select clears its trigger's chrome to sit plain on the row, but not the new sheen and emboss, so Relief painted a lit patch behind it. It clears them too; `relief.spec` checks it.

## The owner's first look

Follow-up requests, verbatim:

> fix those for dark mode and show me more pictures of dark mode

> also i dont like that the selected item like the inbox in light mode looks like the compose button

The two dark-mode points I'd raised, and the owner's one:

- **Send and the other filled buttons in dark** were the light ink, as in Graphite. They're now the dark reference's raised pills ("View build", "Pause"): `#2E2E2E` lit to `#242424`, `#EDEDED` words. The primary (switches that are on, ticked boxes, links, the focus ring) keeps its light ink, so filled buttons have their own tokens: `cta`, `cta-hover` and `cta-foreground`, derived as the primary's in every palette, and set apart only in `relief-dark`. `Button`'s default and Send's group draw them; their text is in `CONTRAST_PAIRS` on both fills. A unit test holds every other palette's `cta` to its primary, and `controls.spec` compares the button with the `cta` probes.
- **The off switch's thumb in dark** was white, the brightest thing on screen. Its dark fill is the design's (`--depth-thumb-dark`, `--depth-thumb-dark-shade`: the ink as before where depth is flat), a soft grey in Relief.
- **The chosen sidebar item** stood up from the sidebar like the Compose pill. It's pressed in now, a held-down key: `--depth-nav` is a shaded well, and in light the fill is a step darker than the sidebar (`#D3D3D3`, 1.14:1). In dark a darker step can't hold the selection's floor on `#191919`, so the fill stays the lighter `#333333`, pressed in by its shading.

## UI rating, round 1 (relief-r01, commit 002cdccdf)

Relief alone, the everyday set. Overall: Claude 6.5, Codex 7 (UI 6 / 6.5, UX 7.5 / 7.5); every cell under 9, the lowest 4 and 4.5. The round first stopped at the List layout's shots: the harness still set the layout in Settings → General, where it hasn't been since af3c9ea74 (fixed in 002cdccdf, for every style).

Fixed at once, with a test that fails without it: the selection bar's Archive drew its icon and key in the primary's foreground, so on Relief's dark filled pill they were dark on dark (~1.2:1). They take the filled button's own foreground (`cta-foreground`).

Then the owner: "do the decisions here found for this style and then do round 2 rate". Changed for Relief only:

- **Dark filled buttons** (Send, the bar's Archive): the middle way between the owner's dark raised pill and the raters' solid fill: graphite `#5E5E5E` lit to `#505050`, white words, 2:1 on a composer, so the main action stands apart from the dark secondary pills.
- **Light surfaces:** the list and reader a step lighter than the picture's card (`#EFEFEF`), the sidebar `#E3E3E3`, cards `#F6F6F6`, menus and the palette `#F8F8F8`, so panes and floating surfaces separate. The open row is `#DADADA`, as strong as the owner's soft light selection allows (plan 173, 1.22:1); the raters asked for more, and that rule stands.
- **Scrims** deeper (24% in light, 65% in dark); the dark popover a step off the app (`#2A2A2A`).
- **Bevels** softer: the white inner ring at 45% and a shorter drop on raised pills and the ink.

Out of scope here, as they aren't Relief's: the rows' height, Reply shown twice while drafting, the recipient warning's timing and place, List layout's category column. They're app-wide and weigh on every style.

## UI rating, round 2 (relief-r02, commit 4655c1034)

Overall: Claude 6.5, Codex 7 (UI 6 / 7, UX 7.5 / 7.5). The lowest cell rose from 4 to 5.5 for both raters; Codex's multi-select went from 7 to 8, and 12 of its 108 cells reached 9. Still below the bar. What holds Relief down, by both raters, is tonal: dark Send (the graphite pill) still reads as one grey among greys, enabled and disabled; the open row, the list and the reader differ by small grey steps (the owner's soft light selection caps the open row at 1.22:1); and the composer barely separates from the reader. The rest is app-wide, as in round 1: Reply shown twice, the small-window sticky header over the sender, the recipient warning's timing, the rows' height, List layout's category column.
