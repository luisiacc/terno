# Plan 286: Automated mail, clear skies

- **Status:** building
- **Builds on:** `5db0298c7` (main).

## The request (verbatim)

> lets have a fun and simple graphics on that right side when there are not more automated messages to review, show me mockups and i'll choose

Five were mocked in light and dark (a kite on the horizon, a mailbox with its flag down, a sleeping robot, a landed paper plane, an empty tray and a mug). Then:

> ok lets do A

A: the horizon of plan 222 again (the same hairline), a kite over it in the palette's `star`, its dotted string down to the line, one small cloud. "Clear skies." and a line under it.

## What exists

- `components/digest-page.tsx`: `DigestPage` reads its row (`today.digest`, again on `todayDigest`). With no row it draws a bare `p-8` line, "Nothing here yet." (`today.digest.none`), and the page's × (`DigestClose`) when it isn't beside the feed (plan 251's column form).
- The backend's `digestRow()` (`packages/backend/src/today.ts`) answers `null` when the digest isn't available, when Automated mail has nothing left (the digest off and no live automated mail: what the owner sees once everything is archived), and when the digest is on with no digest made yet or kept. A digest being made is a `pending` row, never `null`, so `null` always means nothing to review here.
- `components/what-matters/clear-sky.tsx` (plan 222): the horizon, an inline decorative SVG in `currentColor` and `text-star`, opacities as SVG attributes, no literal colours.
- `components/empty-state.tsx`: the lists' empty state (centred, `text-lg font-semibold tracking-tight` title, `text-xs text-muted-foreground` hint). Its arrival is tied to the list's `itemsKey` (`takeEmptied`), which here is What matters' list, not this page.

## Design

- **When:** nothing is left to review: no row (where "Nothing here yet." shows now), or a `ready` row with no rows left to show and nothing archived from this page (`!finished`): every sender hidden with Hide sender before the backend's next read, or a kept digest whose mail is all gone. In both forms (the page and the column). Pending, failed, finished ("All done for today.", with its Undo) and a page with rows stay as they are.
- **One component**, `components/automated-clear.tsx` (`AutomatedClear`): the kite scene, the title and the line, with the empty state's type: the title `text-lg font-semibold tracking-tight`, the line `text-xs text-muted-foreground` (`max-w-64`, so it wraps in two lines at most). The pane is a bounded scroller (`h-full overflow-y-auto`) whose content is `min-h-full` and centred both ways, so a short window scrolls rather than clips. The page keeps its × at the pane's bar (`DigestClose`), as now; the column form has none, and keeps the column's surface and mark (`bg-pane`, `data-place="column"`). `data-testid="digest-page"` stays on the empty pane (tests and the axe sweep find the page by it), with `data-empty`.
- **Not `EmptyState`:** its arrival reads the list's `takeEmptied`, which belongs to What matters' list beside it; taking it here would spend the feed's. The page's empty state is static: no motion (it replaces a page, and the empty states that arrive are a list's).
- **The scene** (`Kite`, inline SVG, `aria-hidden`, viewBox 200 × 112, `w-full max-w-[200px]`):
  - the horizon: a hairline at y 104, `currentColor` at 0.18 (plan 222's).
  - the string: a dotted quadratic from the kite's foot to the line, `currentColor` at 0.35, `strokeDasharray="1 3"`, round caps.
  - the kite: a diamond in four triangles of `text-star` (`currentColor` inside a `text-star` group), two at 1 and two at 0.78, so its spars show without a background colour (the mock cut them in the pane's colour, which differs between the page, `bg-background`, and the column, `bg-pane`). Its tail: a short S of `star` with two small bows.
  - one cloud: an outline in `currentColor` at 0.28.
  - Opacities are SVG attributes, never utilities; no literal colours, so every palette and design draws it.
- **Words** (i18n, `en` and `es` together), replacing `today.digest.none` (no other user):
  - `today.digest.clear.title`: "Clear skies." / "Cielo despejado."
  - `today.digest.clear.body`: "No automated mail to review right now." / "Ahora no hay correo automático por revisar." (Codex: the list is bounded and filtered, so a promise that everything gathers here would overpromise.)
- The title is the pane's `h1` (`ref={heading}`, `tabIndex={-1}`, `outline-none`), as the page's title is: the column's F6 lands on it (`digestKeys.focus` falls back to `heading`, which the bare line left unset) and a screen reader finds the pane by it.

## Tests

- `digest-page.test.tsx` (`show()` takes `null` and the form; the mock keeps the `todayDigest` listener so a re-read runs on the same mount): with `today.digest` answering `null`, the page draws the clear scene (`data-empty`, the words, the SVG hidden from screen readers) and its ×; in the column form, the scene, `data-place="column"`, no ×, and `digestKeys.focus` lands on the title. A later read that brings a row replaces it on the same mount. Hide sender on every row brings the scene, its Undo brings the rows back. Archiving the last row shows the finished state, not the scene.
- Axe: the sweep (`design-axe.spec.ts`) runs with the AI digest, which has no cheap way to an empty page; the empty pane's words are foreground and muted on the pane's own surfaces (pairs already in `CONTRAST_PAIRS`), and the scene is `aria-hidden`. Checked with axe by hand on the screenshots' pages, light and dark.
- Screenshots in light and dark, looked at, beside What matters.

## Revisions after the Codex review

Codex's critique (10 points): taken, the empty rows case (3), the title as the focus target (5), the column's surface and a bounded scroller (6), the test that re-reads on one mount (7) and plain present-state copy (9). Left out, with why above: a cold scan's `null` (1), `null` for an unavailable or unmade digest (2: neither page is reachable then, and "nothing to review" is true), the swap after the last Archive (4), an axe e2e for the empty pane (8) and the UI rating (10).

## Perf

One static SVG, drawn once; no timers, no listeners, no reads. Nothing on a hot path.

## Out of scope

- Archiving the last row keeps the finished state (its words and Undo) until the backend's next read answers `null`; that swap was there with the bare line too.
- A cold start, before the backend's first scan of automated mail, answers `null` for a moment: the page is reached from the feed's row, which exists only once the scan found mail, so it isn't seen there.
- The UI rating gate (plan 158): an empty state of a secondary pane, not a main screen's look.

- The finished state's swap to this scene once the backend's next read says nothing is left (it happens today with the bare line).
- A row whose items were all left out locally (Hide sender) before the backend's next read: that read answers `null` and brings the scene.
