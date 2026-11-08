# Plan 160: precision across screens

- **Status:** planned.
- **Builds on:** plan 15 (designs), plan 119 (concentric corners, `menu-corners.spec.ts`), plan 158 (the UI rating; rounds 4 and 5 raised every case below).

## The request

> Another change from the owner: precision across screens. In rounds 4 and 5 the raters kept saying the gap to Linear-level craft is consistency, not personality (several say the palette, menus and type are already at that level). Don't add a "visual voice": no bolder colour, new type or signature element. Make the existing system hold everywhere. Follow the usual process: plan, Codex critique, tests, light and dark screenshots in every design, Codex review. Read the issues in /tmp/terno-scratch/ui9/rounds/r04 and r05 for the exact cases.
>
> 1. Write the shared lines down as tokens:
>    - one content start (x) and baseline for every pane title: reader subject, New message / compose title, multi-select panel title, category review header
>    - one reading max-width for message body, draft editor and quoted text, in split and list layouts (today list layout's conversation has two widths in one column: full-width header, capped body)
>    - one inset for floating things (toasts, palette, menus) from the window edge and from their anchor
> 2. Hold them in an e2e spec, the way `menu-corners.spec.ts` holds corners. In every design, open each main screen and check:
>    - the titles share an x and a baseline (today Graphite's New message title starts 20 px off the reader subject; macOS's compose title is off the reader subject baseline)
>    - the body and draft share one max-width
>    - toasts sit at one inset and never cover list rows (one was 8 pt from the window edge)
>    - menus and the palette end on a whole row, never cut mid-row (the palette is cut at small window heights), and the context menu doesn't cover its own row
>    - card edges are complete (New message had a broken top edge)
> 3. Fix what fails, plus:
>    - the subject/preview seam in list rows: a steady boundary so the eye can scan down
>    - the faint light-mode composer and field boundaries, and the selection and segment tints (~1.14 to 1.27:1), inside the contrast suite
>    - restraint: a card only where something floats or can be dismissed, hairlines elsewhere
>
> Don't tell the raters about any of this; the next round judges it blind.
>
> When it's done, show me screenshots with arrows on the things these changes brought, so I can see the details: before/after figures with numbered notes. Use your shoot.mjs and make.mjs in /tmp/terno-scratch/ui9/report, light and dark, with at least one figure per design it touched.

## The cases (rounds 4 and 5)

Titles and lines:
- Graphite: "New message" starts at x≈997 while the reader subject starts at x≈977 (Claude, r04).
- Lumen: "New message" sits at y≈47 against subjects at y≈103, inset 20 pt from its card (Claude, r04).
- macOS: "New message" sits on the toolbar row; the reader subject sits 50 px lower (Claude, r05).

Widths:
- List layout's reader: the header, collapsed rows, reply bar and composer span ~1160 pt while the body wraps at ~740 pt (Lumen, Claude, r05).
- The draft body spans the full 1150 px card while the message above is capped at ~70ch (macOS, Claude, r05). The reply editor inherits the broad column (Lumen, Codex, r04 and r05).

Floating things:
- Graphite: the Undo toast sits about 8 pt from the window bottom, left of the reader's centre (Claude, r04). Atelier: the toast sits bottom-left over list rows in list layout (Claude, r04).
- Graphite: the palette is cut mid-row ("Archive · G then A" half hidden) at small heights (Claude, r04).
- The row menu covers its own row and runs to the window edge over the draft strip (Atelier, Claude, r05; Lumen, Claude, r04; macOS: it covers the target row's date, Claude, r05). After a resize it stays at its old position, detached from its row (Lumen, Claude, r04).

Cards and edges:
- Graphite: the compose card's top border is missing; only the top-left arc is drawn (Claude, r04).
- The compose card is a fixed height with an empty pane below (macOS and Lumen, Claude, r04 and r05).
- At 1100x700 the reply card runs below the frame, with its bottom edge not visible (macOS, Graphite, Claude and Codex, r04).

The scan line:
- Subjects start in one column, but every preview starts immediately after a different-length subject. The middle zigzags and runs into one line (Graphite and macOS, Codex, r04 and r05; Lumen, Codex, r04).

Faint boundaries and tints:
- In light mode, composer boundaries and field dividers barely separate the white form from the white reader (Atelier, Graphite, Lumen and macOS, Codex, r05).
- Atelier: the selected row is 1.24:1 dark and 1.27:1 light; the All/Unread segment against its track is 1.14:1 dark and 1.15:1 light (Claude, r05). Dark hover and segment states are ~1.1:1 (Claude, r04).
- Graphite: the search field is 1.11:1 against the list, and the sidebar selection is 1.12:1 (Claude, r04).
- Lumen: the dark selected row is ~1.5:1 (Claude, r05).

## What exists

- **Reading width:** `--reader-max` (a design value) and `--reader-pad-x`. The reader's `COLUMN` (`reader.tsx`) uses `--reader-col`, which on List's page is `--reader-max + 12rem`. The message body inside it is capped separately (the ~70ch above), which is where the two widths come from. `new-message.tsx`, `selection-bar.tsx`, `snack-dock.tsx` and `first-run-preview.tsx` each repeat `mx-auto max-w-(--reader-max) px-(--reader-pad-x)` by hand.
- **Titles:** the reader subject (`#reader-subject`, under the 52 px toolbar row), `compose-title` (`new-message.tsx`, in its own top band with `items-end pb-3`), the multi-select panel (`selection-bar.tsx`, `pt-18`), and the review header (`thread-list.tsx` `Header`, plan 159 is changing it). Each sets its own vertical offset.
- **Toasts:** `snack-dock.tsx`, `bottom-[calc(0.5rem+var(--dock-lift))]`, `inset-x-2` over the list or the reader column over the reader.
- **Menus and the palette:** `menu-styles.ts`, `command.tsx`, and Base UI positioning (collision padding per surface).
- **Corners:** `menu-corners.spec.ts` (plan 119). Contrast: `packages/ui/src/themes/contrast.ts` (`CONTRAST_PAIRS`, `SURFACE_STEPS`, the rated palettes) and `contrast.test.ts`.

## Design

### 1. Three shared lines, as tokens

Defined once in `globals.css` (from design values where a design differs, generated with `gen:designs`) and used by name. No component repeats the arithmetic.

- **`--pane-title-x` and `--pane-title-top`.** Every pane title (reader subject, New message, the multi-select panel's title, the review header) starts at the reading column's content x and sits with its first baseline at one distance from the pane's top: the reader's (toolbar row plus its gap). A shared `PaneTitle` wrapper (or a class `pane-title`) applies the column, the top and the `type-reader-subject` role. Compose's title moves out of its own band onto that line; its toolbar stays where it is.
- **`--read-max`: one reading measure** for the body, the draft editor, quoted text and their headers, in Split and List. List's page no longer widens the column for the header: the header, collapsed rows, reply bar, composer and body share one column (`--reader-col` goes). The measure is the design's current `--reader-max` (no design gets a wider body than today). A `READING_COLUMN` class in one place replaces the hand-copied strings.
- **`--float-inset`: one gap for floating things.** A toast sits that far from the window or pane edge it rests on, centred on the reader column when over the reader, and never over list rows (over the list it lifts the list's bottom padding by its height, as the draft strip does, or moves to the reader). Menus and the palette use it as the collision padding from the window edge and as the offset from their anchor. One value, from the spacing scale.

### 2. The precision spec

`apps/web/e2e/precision.spec.ts`, tagged `@design` (the five designs can change every number), at 1440x900 and at 1100x700 where a case only shows small:

- **Titles:** open a conversation (reader subject), press `c` (New message), select three rows (the selection panel), open a category's review. Each title's box left and its first baseline (from `getClientRects` on the text, or a `Range` over its first line) match the reader subject's within 0.5 px, in Split and in List.
- **One measure:** in List and Split, the body's column, the reply bar, an open reply's editor and the quoted text share one left and one right edge within 1 px, and that width ≤ `--read-max`.
- **Toasts:** archive a row (the Undo toast); its gap to the window or pane bottom equals `--float-inset` within 1 px; its rect doesn't intersect any visible `thread-row`; over the reader it is centred on the column.
- **Whole rows:** at 1100x700 and 1100x560, open the palette and a right-click menu on the last visible row. The palette's list height is a whole number of rows (plus its padding), so its last visible item is either whole or the list scrolls with a visible cue; a menu that fits shows every row whole. The menu's rect doesn't cover the row it was opened on (its target row's text box), and it stays ≥ `--float-inset` from every window edge. A resize closes it or keeps it on its row.
- **Card edges:** every floating card in view (compose card, reply card, palette, menu, toast) has its four border edges inside the viewport and drawn: computed `border-*-width` > 0 or an equivalent ring, and no ancestor with `overflow: hidden` clipping its rect.

Each check uses `expect.soft` with the design and the measured numbers in its message, as `menu-corners.spec.ts` does.

### 3. Fixes

- Whatever the spec finds, plus the cases above (compose title line, list-layout widths, toast inset and placement, palette height in whole rows, menu placement, the compose card's top edge, the fixed-height compose card, the reply card at 1100x700).
- **The subject and preview seam.** In one-line rows (macOS and Graphite list rows, List layout), the preview stops following each subject: the subject gets a column bounded by a share of the row (a `max-w` in `ch` or a percentage, truncating), and the preview starts at the same x on every row, separated by the existing gap. In two-line rows (Lumen, Atelier) the preview already has its own line; nothing changes there. Picked by eye at 1440 and 1100 in every design.
- **Faint boundaries and tints, in the contrast suite.** New `CONTRAST_PAIRS`-style checks for non-text boundaries (WCAG 1.4.11, 3:1 is the reference; the floor per pair is set from what the eye needs and written down): the composer card edge and field dividers against the reader in light, the selected row, the hover row, the segmented thumb against its track, the search field against the list, the sidebar selection. Palettes are tuned in `registry.ts` to pass; no new colours outside the existing palette families.
- **Restraint.** A surface is a card (a fill, border or shadow on all sides) only when it floats (menus, palette, toasts, popovers) or can be dismissed (compose, a banner with ×). Static content (the reader's header block, the selection panel's sections, settings groups on main screens) uses hairlines. Inventory the cards on the main screens and list in the revisions what changed.

## Tests

- `precision.spec.ts` as above, in every design (`@design`), light only (geometry doesn't change with the palette).
- Contrast: the new boundary pairs in `contrast.test.ts`, every palette, light and dark.
- Unit tests where logic moves (the toast's placement, the palette's whole-row height).
- Baselines updated per design after looking, light and dark.
- Screenshots in every design, light and dark, at 1440x900 and 1100x700, looked at.

## Perf

Layout only. The list row's seam must not add a measurement per row (CSS only); `pnpm test:ui-perf` holds.

## Out of scope

- A "visual voice": no new colours, type or signature elements (the owner).
- The rating itself: raters aren't told; the next round judges blind.
- Plan 159's copy (it changes the review header's words; this plan only its line).

## Revisions after the Codex review

All twelve points taken. Where they change the design:

1. **Titles are per pane, relative to the pane.** Reader-pane titles (the reader subject, New message, Split's multi-select panel) share an x and a baseline measured from the reader pane's left and top. List-pane titles (the mailbox header, the category review header, and List's 52 px selection toolbar that replaces the header) share the list header's line, and start where the rows' content starts: the avatar in Lumen and Atelier, the leading slot in macOS and Graphite (plan 24's slot), so the title and the rows read as one column. No list control moves to the reader's x.
2. **The baseline probe.** The spec inserts a zero-size `inline-block` at the start of the title's text (`vertical-align: baseline`), reads its top and removes it. The origin is the pane's top (the reader `section` or the list pane). The title line is the line under the toolbar row in the resting state: no search row, a conversation without Atelier's chips above the subject (chips sit below the subject line or the spec picks one without them; the engineer decides and writes it down). Below 560 px the container query changes the type; the shared title class carries the same container variants, so the check runs at 1440 and 1100 both.
3. **`--read-max` is the text measure, not the column.** It is today's `35em` cap (`mail-body.tsx` plain text, `composer/rich.css` editor children), named once and used by the plain-text body, the editor's text and quoted text. HTML mail keeps the column's width (its own layout, at about 600 px). The column (`--reader-col`) is one width in Split and List: List's `+12rem` goes, so the header, collapsed rows, reply bar, composer card and body share one column, and the text inside each is capped at `--read-max` from the same left edge.
4. **Menus anchored to their row.** `ContextMenuContent` gains `collisionPadding` (from `--float-inset`) and an anchor. `ThreadMenu` stays one delegated trigger: on `contextmenu` it reads the row's rect from the event target (no per-row primitive or subscription; the 50 ms menu gate in `perf.spec.ts` holds) and anchors to a virtual rect at the pointer's x spanning the row's height, so the menu opens below the row, or above it when there's no room. Only when neither fits may it overlap the row. A resize or a list scroll closes it. Submenus keep their own offsets (`menu-styles.ts`), corrected only for the panel's padding.
5. **A toast never covers rows.** While a toast shows over the list, the list's scroll viewport ends above it (its bottom inset = the toast's height plus two `--float-inset`), scroll position kept, so rows end at a clean edge rather than under the toast; the cursor row is kept in view. Over the reader it stays over the reader, centred on the column. The bottom edge is the window's, or the draft strip's top when it shows. One function computes the reservation (replacing `height + 16`). `snack.spec.ts`'s row-under-the-toast step changes to match.
6. **Measuring rows and settling.** A helper picks a row that intersects the list's viewport (the list overscans), captures its id and click point, and remeasures after a resize. The spec waits for finite opening animations on menus and the palette, never for a snack's countdown.
7. **The palette in whole rows.** On open, its list's max height is the space left between the dialog's top and the window's bottom (less the input, the hints and `--float-inset`), snapped down to end on an item's boundary at the initial scroll position. When the list overflows, a bottom fade shows that it scrolls. The spec reads the intersecting items' rects at the initial position.
8. **Card edges, two checks.** Short cards (New message, a short reply, the palette, menus, toasts): all four edges inside the viewport including the ring's spread, no ancestor with `overflow` other than `visible` cutting them, and a pixel check: a 1 px strip along each edge in a screenshot differs from the surface behind on at least 95% of its length (it catches Graphite's missing top edge, which no computed style shows). Long drafts: the sticky footer stays reachable and the card's bottom edge is reached by scrolling; they aren't held to the viewport.
9. **The seam is a reserved column.** In one-line rows (List in every design, and compact rows in Lumen and Atelier, where `line = compact || wide`), the subject sits in a column of fixed share (truncating), and the Draft, place and reminder marks sit at the end of that column, so every preview starts at one x. `list-layout.spec.ts`'s "preview within 64 px of its subject" becomes "previews share one x".
10. **Floors by role.** Pairs that carry information nothing else gives (a checkbox's border, a field's edge where nothing else marks it) are 3:1 (WCAG 1.4.11). Pairs that repeat a cue shown another way (the selected row, also shown in the reader; the segmented thumb, whose label also changes; hover; the composer card's edge and dividers) get a named floor in a new `BOUNDARY_STEPS` suite in `contrast.ts`, set at 1.35:1 for tints and 1.5:1 for hairlines unless the screenshots show more is needed, and the text on every tint keeps its 4.5:1 (round 5 measured Graphite's selected-row secondary text at 3.8:1: it must pass).
11. **The real layers.** A `composite(layers)` helper checks what is drawn: the divider (`hairline`) over the card, the card's ring (`border`) over the reader's `background`, light's thumb (`card`) over the translucent `bg-field` track over `background`, dark's thumb (`muted`) over `background`, the sidebar's selection over `sidebar`. Every palette, Luma's included.
12. **The inventory first.** Before changing any surface, the engineer lists the cards on the main screens (list, reader, compose, multi-select, review) as containers or controls. Controls (fields, segmented thumbs, selection shapes, chips) keep their shapes. Static containers on those screens become hairline sections; shared tokens (`card-group`, `surfaces.card`) don't change, so Settings and the snippet editor are untouched. The list and its baselines go into this plan.

## The spec on the code before the fixes

`precision.spec.ts` (two Split tests and one List test, every design) was run on 46cdb305f before any fix. 125 checks failed: Lumen 24, Atelier 27, macOS 24, Graphite 24 and Luma 24. The numbers below are CSS px at 1440x900 unless a size is given.

| Check | Lumen | Atelier | macOS | Graphite | Luma |
|---|---|---|---|---|---|
| New message's baseline vs the subject's (Split) | 41 vs 81 | 40.8 vs 106 | 42 vs 80 | 41 vs 85 | 40 vs 84 |
| The selection title's x vs the subject's (Split) | 724 vs 720 | 715 vs 711 | 716 vs 712 | 708 vs 704 | 720 vs 716 |
| The selection title's baseline vs the subject's (Split) | 95 vs 81 | 93 vs 106 | 92 vs 80 | 97 vs 85 | 97 vs 84 |
| New message's x vs the subject's (List page) | 520.5 vs 424.5 | 516.5 vs 420.5 | 512.5 vs 416.5 | 504.5 vs 408.5 | 516.5 vs 420.5 |
| New message's baseline vs the subject's (List page) | 41 vs 81 | 40.8 vs 106 | 42 vs 80 | 41 vs 85 | 40 vs 84 |
| The selection toolbar's baseline vs the header's (List) | 29.5 vs 33 | 29.5 vs 33 | 29.5 vs 32 | 29.5 vs 31 | 29.5 vs 32 |
| The reading column in List (≤ `--reader-max`) | 896 > 704 | 896 > 704 | 888 > 696 | 896 > 704 | 896 > 704 |
| Preview start spread across rows (List) | 166.8 | 176.9 | 184.8 | 174.2 | 181.6 |
| Toast gap to the pane's foot (want `--float-inset`, 12) | 8 | 8 | 8 | 8 | 8 |
| Toast centre vs the reader column's centre (Split) | 964 vs 1040 | 955 vs 1031 | 956 vs 1032 | 948 vs 1024 | 960 vs 1036 |
| Rows the List toast covers | ≥ 1 | ≥ 1 | ≥ 1 | ≥ 1 | ≥ 1 |

In every design:
- The message text's measure and the editor's are 35em each, written twice (no `--read-max`). The quoted text in a reply has no measure at all.
- The palette is cut mid-row at 1100x700 and at 1100x560.
- The row menu on the last visible row (1440x900 and 1100x700) sits 5 px from the window's foot, covers its own row's text, and its bottom edge isn't drawn. A resize leaves it where it was.
- The titles' x already agree for the subject and New message in Split: round 4's Graphite 20 px case was fixed in plan 158. The category review's title already shares the list header's line.

Atelier only: at 1440x900 the open reply card runs past the window (its box 475.9 to 916.9 in a 900 px window). The reader's scroller cuts it, and its bottom edge isn't drawn.

## Restraint: the inventory (revision 12, written before any surface changed)

These are the surfaces on the main screens (list, reader, compose, multi-select, review) drawn as a card: a fill, a ring or a shadow on all sides.

**Kept: they float or can be dismissed**
- The composer's card (New message) and the inline reply's card: dismissable.
- Toasts, the palette, menus, popovers, tooltips and tips: they float.
- The rule offer over the list (`learned-banner.tsx`): its × dismisses it, and plan 159 owns it.

**Kept: controls, not containers**
- The reply bar: the closed draft, a button.
- Attachment tiles: each opens its file.
- Fields, the segmented control's thumb, chips, the format bar's well, row and sidebar selection shapes, and the selection panel's buttons.

**Kept: other reasons**
- The HTML mail's paper (`mail-body.tsx`): it's the mail's own document, not chrome.
- The skeletons: they hold a place while loading.

**Already hairlines**
- Messages (`article.hairline-b`) and the follow-ups section (`border-b`).
- The selection panel's list of rows (`hairline-t`) and List's selection toolbar (`hairline-b`).

**Static containers, so they become hairline sections**
1. The AI summary over a conversation (`thread-summary.tsx`, `card-group`): a block of the model's words, neither floating nor dismissable. It becomes a section with a hairline above and below, on the column's edges; its glyph still says whose words they are.
2. The remote-content notice in a message (`mail-body.tsx`, a `bg-tint` pill): a line with its Load button. It loses the fill and keeps the button.

The shared tokens (`card-group`, `surfaces.card`) don't change, so Settings and the snippet editor are untouched. The baselines that move are the reader's (summary and blocked mail) in each design that shows them.
