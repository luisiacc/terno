# Plan 187: how many lines of preview a conversation shows

## Request (verbatim)

> lets have an options in the 'appearance' section so the user can determine how many lines he wants to see on the preview of the email, default 1 line, can choose 2, and can also choose 'no preview'(we'd need to implement this), this would also show on the first-time wizard for appearance, only if they select the 'split' view

## What exists

- **Rows.** `ThreadRowView` (`apps/web/src/components/thread-row.tsx`) draws a conversation in one of three shapes: Apple Mail's three lines (sender and date, subject, preview), the compact one-line row, and List's full-width one-line row (plan 24). Only the three-line row has a preview line of its own; the one-line rows trail the preview after the subject's column.
- **The preview line** (`RowSnippet`) is one truncated line. It is also where other things stand in the preview's place: an owed follow-up's words (plan 142), an action preview's reason (plan 162), a search's match excerpt (plan 158), and, in a category's Review list, the answers (plan 80). Plan 173 put the marks (category dots, clip, star, bell) and the account label at the end of that line.
- **Heights.** Rows are virtualized at one fixed height per list, from the design: `design.rows.comfortable` (or `results` in a search, `compact`, `wide`). The same `wide && !compact ? … : …` expression is written twice, in `thread-list.tsx` and in `first-run-preview.tsx`. `designs.test.ts` checks a three-line row has room for its three type-role leadings plus 10 px.
- **Settings.** Appearance → List has Layout (a segmented Split | List, through `updateAppearance`, optimistic, with the list's first row and the open thread kept in place across the height change by `captureDesignAnchors`) and Density (a select, through the dialog's plain `update`).
- **First run** (plan 98): step 1 is Layout (two radio cards), with the live `FirstRunPreview` on the right drawing real `ThreadRowView`s in sample mail.

## Design

### The setting

`AppSettings.previewLines: 0 | 1 | 2`, default `1` (nothing changes for anyone who doesn't choose). In the contract (`settingsPatch`: literals 0, 1, 2), `DEFAULT_SETTINGS`, and the export's `GENERAL_KEYS` (an export carries it like density). The type is `PreviewLines`, exported from `@terno/core/rpc`.

It is an appearance field: `updateAppearance` takes it (optimistic, serialized, reconciled like layout), and `applyAppearance` puts it on `useAppearance`, so a change re-renders the list inside the same `flushSync` + `captureDesignAnchors` that a design or layout switch uses: **the first row on screen and the open conversation stay where they were** when rows grow or shrink.

### Where it applies

Only to the three-line row (Split's list, and List's list while it is too narrow for one-line rows). Compact and List's full-width rows are one line by construction and stay as they are.

Some lists use the preview line for something that is not the preview. They keep it:

| List | Lines shown |
| --- | --- |
| a mailbox, Today, Reminders, follow-ups | the setting |
| a search's results | at least 1 (the match excerpt is why the row is there) |
| an action's preview (plan 161) | at least 1 (the reason a row is in it) |
| a category's Review | exactly 1 (the answers are one line) |

`previewLinesFor(setting, { review, results, previewing })` (pure, `packages/ui/src/designs/rows.ts`) is that table.

### Heights

`rowHeight(design, { compact, wide, results, lines })` in the same module is the one place a list's row height is worked out (`thread-list.tsx` and `first-run-preview.tsx` both call it; the duplicated expression goes). A three-line row's height is the design's (`comfortable` or `results`, which are for one preview line) plus `(lines − 1) ×` the design's `rowSnippet` leading in px: a line more or a line less, the padding unchanged. Leadings are rem (`designs.test.ts` already reads them at 16 px; a new assertion requires `rowSnippet.leading` to be in rem so this stays exact).

| Design | none | 1 line | 2 lines |
| --- | --- | --- | --- |
| Lumen | 62 | 76 | 94 |
| Graphite | 68 | 84 | 104 |
| Atelier | 62 | 76 | 94 |
| Luma | 54 | 68 | 86 |
| macOS | 50 | 64 | 82 |

`designs.test.ts`: with no preview, every design's two remaining lines still have 5 px above and below and the avatar still fits (`avatar.row + 16 ≤ height`).

### The row

`ThreadRowView` takes `lines: 0 | 1 | 2` (default 1; only the three-line shape reads it):

- **1**: exactly as today.
- **2**: the preview wraps and clamps at two lines (`line-clamp-2`, long words broken). The line is always two lines tall (`min-h` of two leadings, top-aligned) so a short preview never re-centres the row's text off its neighbours'. The marks and the account sit on the first of the two lines (top-aligned, one leading tall), as they sit on the single line today.
- **0**: no preview line. The marks and the account move to the end of the subject's line, with the same rules (the account keeps the right edge, marks before it). An owed follow-up's words go with the preview; its date still shows when it's owed (`RowDate`).

### Settings → Appearance → List

A **Preview** row under Density: a select (as Density is) with *None*, *1 line*, *2 lines*; hint "How much of each message shows under its subject." It is shown while the layout is Split (the user's rule), and disabled while Density is Compact, with the hint "Compact rows are one line." — the row doesn't vanish under the pointer when density changes beside it.

### First run

Step 1 (Layout): under the two cards, while Split is chosen, a **Preview** label and a segmented control (*None* | *1 line* | *2 lines*, as the Look step's mode switch) that applies at once; the live preview on the right redraws with it (its keyed fade includes the setting). Choosing List hides it; the choice stays as it was.

### i18n

`settings.appearance.preview`, `.hint`, `.compactHint`, `.none`, `.one`, `.two`, and `firstRun.layout.preview`, in `en` and `es`.

## Tests

- `packages/ui/src/designs/rows.test.ts`: `previewLinesFor` table; `rowHeight` for every shape, every design (comfortable, results, compact and wide ignore or apply `lines` as above).
- `designs.test.ts`: none-row fits its two lines and the avatar; `rowSnippet.leading` is rem.
- `thread-row-marks.test.tsx`: lines 0 has no `row-snippet` and the marks and account on the subject's line; lines 2 clamps to two lines (class) and the marks sit on its first line.
- `contract` / settings unit: `previewLines` accepts 0, 1, 2 and refuses 3; defaults to 1; import carries it.
- e2e (`designs.spec.ts`, beside the density height check, in the one design the height is asserted in): Settings → Preview → None, then 2 lines: the first row's height is the design's ± one leading, and the snippet is gone / two lines tall; the Preview row is absent in List and disabled with Compact. `first-run.spec.ts`: on step 1 the Preview control shows with Split, hides with List, and choosing None changes the preview's row height.

## Perf

No new work per row: one prop, the same fixed-height virtualizer (heights stay uniform per list; nothing is measured). `line-clamp-2` is a paint-time clamp on at most the overscanned rows. Default (1) renders exactly what renders today, so the list perf gates are unaffected; `pnpm test:ui-perf` run once.

## Out of scope

- Previews in compact and List's full-width rows (they are one line by design).
- More than two lines (Apple Mail offers up to five; the request is none, one, two).

## The owner, while planning (2026-11-11)

> when 'no preview' option is selected the color of the subject should be the color of what the preview would be

With no preview, the subject line is drawn in the preview's quiet ink (`text-muted-foreground`, as `RowSnippet` is, the open row included).

## Revisions after the Codex review (plan)

1. **Density joins the anchored path** (#2). Compact ↔ Comfortable changes row heights as much as Preview does, but went through the dialog's plain `update`, so the first row on screen jumped. Density becomes an appearance field like layout and Preview: `updateAppearance`, on `useAppearance`, inside `applyAppearance`'s capture and restore. `ThreadList` reads `compact` and `previewLines` from `useAppearance`.
2. **The preview line stops being one line** (#4): at 2 lines `truncate` is replaced (not added to): `whitespace-normal`, `line-clamp-2`, `wrap-break-word`.
3. **Marks and account align by their own class** (#5): `self-center` becomes the line's alignment, chosen once (`self-center` at 1 line, top-aligned at one leading's height at 2), so nothing stays centred against two lines. Screenshots in light and dark at the narrowest list, in classic, avatar and large-avatar designs.
4. **First run disables the control under Compact too** (#7), with the same explanation as Settings.
5. **Tests** (#3, #5, #6): the e2e scroll check of `designs.spec.ts` is extended: partway into the list, Preview 1 → 0 → 2 keeps the same first row and the open conversation on screen. An e2e geometry check that at 2 lines the marks sit on the preview's first line. Review keeps its one-line row and its answers under Preview = None (e2e, the answers clicked).
6. **Perf** (#8): one ui-perf run at Preview = None and one at 2 lines, in the default design, with the existing frame and render-count assertions.
7. Not taken: #1 (Preview changed in Settings while an action's preview is open, then Cancel): an action preview's saved offset is a raw `scrollTop`; changing an appearance setting in the middle of an action's preview is rare enough to leave (the codex-review-round-cap rule), and the same is true today of a design switch.

## What the Codex code review changed

1. `thread-list-work.test.tsx` changed density through `useApp`'s settings; the list now reads the painted appearance (`useAppearance`), so the test goes through it, restores it, and also checks a change of the preview's lines recomputes every position (a line less, then back).
2. The Appearance baselines (every design's `design-settings-appearance`, `themes.spec`'s light and dark, Spanish) gain the Preview row; looked at and updated. (`es-settings-general.png` was already stale before this series and is left as it was.)
3. The two-line and no-preview checks were class strings in jsdom. `designs.spec.ts` now measures them in the browser in every design (classic, avatar, large avatar): two lines are two leadings tall and clamped, the marks and the account centred on the preview's first line; with none, no preview and both centred on the subject's line.

## Follow-up: the subject reads as the preview did (the owner, 2026-11-11)

> the subject line when no preview should have this style, same size as now, but should have this color and font weight

With no preview the subject takes the preview's weight as well as its ink (`--type-row-snippet-weight`), read or unread, at the subject's own size, leading and tracking. Unread still shows by the sender's weight, the dot and the date. `designs.spec.ts` checks an unread subject's computed color, weight and size in every design.

## Follow-up: room between the sender and the subject (the owner, 2026-11-11)

> lets have a bit more spacing between the sender and the subject when there is no preview, its look super close now

With no preview the subject's line sits `NO_PREVIEW_GAP` (6 px at first; 4 px, `mt-1`, after the owner's "reduce the gap by 2px") below the sender's, and `rowHeight` adds the same, so the padding above and below is a one-line row's (the table above includes it). `designs.spec.ts` measures the gap in every design.
