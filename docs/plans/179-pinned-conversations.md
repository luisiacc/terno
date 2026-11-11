# Plan 179: pinned conversations

- **Status:** shipped (built on `feat/177-pinned`; renumbered 179 on landing, as main had taken 177 and 178).
- **Builds on:** plan 87 (Remind me: a local per-thread table, the Inbox's top), 142 (follow-ups on the top), 145/166 (headings in the list), 174 (the list's fixed spacing), 158 (marks and their screen-reader words).

## The request

The owner, 2026-11-10, verbatim:

> lets add the ability to pin emails, and they are always pinned on the top on a pinned section, make it look nice and have our design standards

## What exists

- **The Inbox already has a top.** `withTop` (`state/list.ts`) asks, on the plain Inbox's first page, for the due reminders and the follow-ups on top, puts them first and leaves them out of every later page and window refresh (`inboxTop.ids`). `heldOnly` keeps them under a quick filter; `onlyOnTop` keeps a row that is there only for its top (archived, or in a category hidden from the Inbox) out of "select all N". `thread-list.tsx` counts the leading rows in `inboxTop.ids` (`top`), draws one label above them (Bell, "Reminders", `inbox-reminders-label`, 12 px muted) and a hairline in a 9 px gap after them (`TOP_GAP`). Today's groups draw headings in the same way at any index (`TodayHeading`, `TOP_LABEL` space before the row). `row-offsets.ts` knows both, so a design or density switch keeps the first row in place (plan 174).
- **Local per-thread state:** reminders (plan 87) are their own table (`reminders`, SQLite v34; IndexedDB `reminders`, early, cascading with `threads`), a `MailStore.reminders` namespace with a conformance file, a merge rule in both stores, a backend service that sends a snapshot event, renderer-side Undo through `reminders.restore`, and `useReminders` read by rows. Nothing is added to the list queries.
- **Leaving the Inbox ends what the top holds.** `actOn` (archive, trash, spam: `ENDS_REMINDER`), `moveToFolder` (`leftInbox`), and filing into a category hidden from the Inbox (`endDueIfHidden`, and the category move) each collect the due reminders and the follow-ups they ended, by hand, in two parallel lists, and Undo puts both back (`endedReminders`, `endedTops`, `filedReminders`, `filedTops`).
- **"Pinned" already names two things:** the pinned draft (plan 115) and the pinned answer (165), both floating cards at the reading pane's corner. Conversations pinned to the list's top are a third, unrelated thing; their code says `pins` / `PinnedSection` and never `pinned-draft`.
- **Keys:** `p` is unbound (`⇧P` is the previous message). Gmail, Apple Mail and IMAP have no pin: there is nothing to sync.

## The design

### 1. The model

A **pin** belongs to one conversation: `{ threadId, pinnedAt }`. A conversation is pinned or not; pinning a pinned one changes nothing (its place in the section stays).

Pins are **local**, like reminders: no provider has them, so they don't sync and backups don't carry them. At most **100** (`PINS_MAX`): the section is for the few things kept at hand, and the bound keeps every read of it one small indexed probe.

A pin ends when:

- the user **unpins** it;
- the user **archives, trashes, marks as spam, moves to a folder or files into a category hidden from the Inbox** (the same set that ends a due reminder): putting it away says it's done, and leaving it pinned would bring it straight back to the top. Undo of that action puts the pin back exactly;
- the conversation disappears (cascade).

### 2. Stores (`MailStore.pins`, SQLite and IndexedDB)

- **SQLite** migration v55: `CREATE TABLE pins (thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, pinned_at INTEGER NOT NULL) WITHOUT ROWID`. Shape only.
- **IndexedDB:** an early `pins` table keyed by `thread_id`, with a `FOREIGN_KEYS` cascade to `threads`; `IDB_VERSION` 33 creates it for existing databases, `LOGICAL_SCHEMA` 55.
- **Methods:**
  - `list()`: every pin.
  - `add(rows, cap)`: one unit, all or none. Skips threads already pinned (their pin stays) and threads that are gone; refuses (`ok: false`) when the pins not among them plus the new ones would pass the cap. Returns the rows it added.
  - `delete(threadIds)`: the rows it removed (for Undo).
  - `deleteExact(rows)`: only rows that are still exactly these (Undo of a pin never removes one made again since).
- **Merges:** the survivor is pinned if either was; it keeps its own `pinnedAt`, else takes the vanished one's. A delete cascades.

### 3. Backend

**RPC:**

- `pins.list()` → `{ pins: Pin[] }`.
- `pins.add({ threadIds })` (≤ `PINS_MAX` ids) → `{ added: Pin[] }`; over the cap `L("errors.pinsFull", { max })`.
- `pins.remove({ threadIds })` → `{ removed: Pin[] }`.
- `pins.restore({ drop, put })`: Undo. `drop` through `deleteExact`, `put` through `add` (so a pin made since stays as it is); over the cap it refuses and nothing is put back.
- `pins.threads({ accountId? })`: summaries of the pinned conversations, newest pin first, leaving out those in Trash or Spam (spam reaches nothing) and narrowed to one account when asked.

**The event** `pins: { pins }` goes to every window after each change. A `Pins` service (`backend/src/pins.ts`) keeps the last snapshot sent and, while any pin exists, looks again after a `changed` flush (throttled to once a second, as reminders do), so merges, cascades and an account's removal reach the windows. No timer otherwise: no pins, no work.

**Leaving the top, in one place (the refactor this needs).** The three paths that put conversations away now each collect a third list by hand; instead, the backend gets one pair:

- `leaveTop(threadIds)` → `TopLeft { reminders, followups, pins }`: ends the due reminders, the follow-ups on top and the pins of these conversations.
- `returnTop(left)`: puts them back, reminders first (their cap refuses before anything moves, as now), then pins (their cap likewise), then follow-ups.

`actOn`, `moveToFolder`, `endDueIfHidden`/`restoreFiled`, the category move's step and `undoActs` carry one `TopLeft` per undo id instead of `ended` and `tops`. Behaviour for reminders and follow-ups is unchanged (their tests stay as they are).

### 4. The Pinned section

**Where:** the top of the **plain Inbox** (all accounts or one account, with or without a quick filter), the same lists where due reminders show; not a category tab, a folder, Today, Review, Reminders, Follow-ups, an action preview or a search. A pinned conversation shows there wherever it lives (pinned from Archive or a search, it comes to the Inbox's top: the user asked for it there).

**Order of the top:** the Pinned section first, newest pin first; then the Reminders section (due reminders and follow-ups) as now; then the mail. A pinned conversation with a due reminder shows once, in Pinned (its bell shows as a mark).

**In the renderer** (`state/list.ts`):

- `withTop` also asks for `pins.threads({ accountId })` when any pin exists (`anyPinned()`), alongside the page and the reminders. `inboxTop` becomes `{ ids, pinned }`: `pinned` is how many of `ids` lead as pins. Later pages and window refreshes leave all of `ids` out, as now; `heldOnly` and `onlyOnTop` hold for pins unchanged.
- **Pinning or unpinning reloads the plain Inbox** (keeping the selection and the first row on screen, as any refresh does) so the row moves into or out of the section. Elsewhere only the row's mark changes.

**Drawing it** (`thread-list.tsx`, `row-offsets.ts`):

- The top's sections are headings in the list's one heading mechanism: `RowSpacing.groups` holds every heading's index (Today's, and now the top's: Pinned at 0, Reminders at the pinned count), and `rowStart` adds `TOP_LABEL` for each heading at or before a row. `top`/`topGap` still mark the end of the top. The special case "a label above the top" goes; Reminders' label is now one of the headings.
- **The heading** (`TopHeading`, `inbox-pinned-label` and `inbox-reminders-label`): the existing top label's look, so the two sections read as one family: the section's glyph (Pin, Bell) at 12 px and its name, 12 px medium, muted, on the rows' text line (`px-5`), bottom-aligned in its 28 px. `aria-hidden`; the first row of each section says the section's name to a screen reader (`section`, as Today's rows do).
- **The end of the top:** the hairline in a 9 px gap after the last top row, as now (`inbox-top-end`, renamed from `inbox-reminders-end`).
- **The rows** are ordinary rows: selection, j/k, the menu, checking, drag and their render counts are unchanged. A pinned row inside the section shows no pin mark (its heading says it); anywhere else (a search, Archive, a category) a pinned row shows a quiet **pin mark** (Pin, 12 px, muted, `row-pin`) among its marks after the star, and every pinned row says "Pinned" to a screen reader (`list.state.pinned.sr`), as starred ones say "Starred".

### 5. Pinning: the UI

One verb, **toggle**: pin the targets unless all of them are pinned, then unpin them.

- **Key:** `p` (`thread.pin`) on the selection (or the checked rows). Listed in the Shortcuts sheet beside Star.
- **The context menu:** after Star/Unstar, **Pin to top** (Pin) when any target isn't pinned, **Unpin** (PinOff) when any is, each with its key hint. With a "select all N" scope they aren't offered (pins need ids; at most 100); P and the palette say to pick the conversations.
- **The reader:** the More menu (`ToolbarMore`) starts with **Pin to top** / **Unpin** and its key. The toolbar itself gets no new button (it's full, and the owner prefers it quiet).
- **The palette:** "Pin to top" / "Unpin" in the conversation group.
- **Snack:** "Pinned to the top" / "# conversations pinned to the top", "Unpinned" / "# conversations unpinned", each with Undo (and `z`), which puts back exactly what was there (`pins.restore`). Over the cap: an error snack, "You can pin up to 100 conversations. Unpin one to pin this." Nothing changes.
- **Archiving a pinned row** says what the archive's snack already says; its Undo brings the conversation back pinned.

### 6. Strings

`en` and `es` together: `list.pinned` (Pinned / Fijados), `actions.pin` (Pin to top / Fijar arriba), `actions.unpin` (Unpin / Dejar de fijar), `pins.snack.pinned`, `pins.snack.unpinned`, `pins.undoPin`, `pins.undoUnpin`, `pins.failed`, `list.state.pinned.sr`, `errors.pinsFull`, and the Shortcuts sheet's line.

## Tests

- **Store conformance** (`conformance/pins.ts`, both stores): add/list/reopen; adding a pinned thread keeps its `pinnedAt`; a gone thread is skipped; the cap refuses the whole batch and counts only new ones; `delete` returns what it removed; `deleteExact` leaves a re-pin; the cascade when the conversation's last message goes; a merge keeps one pin (survivor's first).
- **Migrations:** v55 in `migrations.test.ts` and its hash in `migrations-shipped.test.ts`; the IndexedDB upgrade from 32 creates the store.
- **Backend** (`pins.test.ts` and `actions.test.ts`): add/remove/restore round trip and the event; the cap; `pins.threads` leaves out Trash and Spam, narrows by account, newest pin first; archive, trash and spam end the pin and `threads.undo` brings it back; a folder move out of the Inbox and filing into a hidden category end it and their Undo restores it; a reminder and a follow-up still end and come back as before (existing tests).
- **Web unit:** `withTop` puts pins first, then due reminders without the pinned ones, and leaves all of them out of later pages; `row-offsets` with two top headings and Today's; `togglePin` pins the unpinned among mixed targets, unpins when all are pinned, and its Undo calls `pins.restore` with exactly what changed; the row shows the mark outside the section and not inside it.
- **e2e** (`pins.spec.ts`, `@design`, one `scenario`): pin a row with `p`: the snack, the row moves under "Pinned" at the top with the hairline after it; pin one from the menu; unpin with Undo; a pinned row in a search shows the pin mark; archive a pinned row, Undo, it's back under Pinned; the Pinned heading's text lines up with the rows' text; with a due reminder too, both headings in order. The spec runs axe on the list with Pinned (and Reminders) on top in light and dark, in every style (`@design`), so `design-axe.spec.ts` needs no line of its own.
- **Visual:** screenshots of the Inbox with Pinned (and with Pinned and Reminders) in light and dark, in macOS, Lumen and Graphite.

## Performance

- The list queries don't change. The Inbox's first page adds one RPC only while any pin exists, bounded by 100 summaries (`threads.summaries` by id).
- Rows read their pin from a renderer store (`usePins`, a set of ids) by a selector that returns a boolean: a pin elsewhere renders no row, and the j-key and theme gates are unchanged.
- No timer, no polling. The look after a `changed` flush runs only while pins exist, at most once a second.
- No store perf test of its own: `pins.list` reads at most 100 rows by primary key and `pins.threads` is `threads.summaries` of them, which the existing gates already time. The sustained j-key gate holds two pins, so crossing the Pinned section is measured (2.8 to 2.9 row renders a move, under 3.5).

## Out of scope

- Pinned sections in other lists (categories, folders, search), and a pin's own place in the sidebar.
- Reordering pins by hand; collapsing the section.
- Sync across devices, backups, MCP tools, a search operator (`is:pinned`).
- A pin button on the reader's toolbar or the selection bar.

## Revisions after the Codex review of the plan

Twelve points; eleven taken, one recorded as accepted. These replace the matching parts of the design above.

1. **Undo never half-restores.** `returnTop` puts the pins back first (all or nothing under their cap), then the reminders; if the reminders' cap refuses, the pins it just put back are taken out again (`deleteExact` of exactly those rows) before it throws, so nothing of the top changes and the Undo stays in the journal for a retry. An action that ended only top state (no message changed) still has its Undo. Tests: refusal at either cap leaves everything as it was, and a retry after making room restores it all.
2. **Holding a row is the Reminders section's alone.** `withTop` holds the open conversation only when it was in the Reminders part (its reminder ended by being opened), only in the same list (the same list key: never across accounts), and only if it isn't pinned now; it goes back inside the Reminders part, never into Pinned. An unpinned row is never held: it goes to its place at once, the selection staying on it. `pinned` is counted from the rows as finally assembled.
3. **The top is published with its page.** `withTop` returns its ids and the pinned count beside the page instead of writing `inboxTop` itself; `reloadList` writes `inboxTop` only for the answer it accepts (the same check that drops a stale page). Later pages and window refreshes keep the underlying page's cursor even when every row of a page is on the top. Tests: a slow first answer for one account doesn't change the top of the account shown since; a page made only of top rows still continues.
4. **Pinning refreshes as mail changing does.** The `pins` event calls `refreshList()` (the path a `changed` event takes: the loaded window and the first row on screen are kept in both layouts, and the selection and checked rows stay). Nothing else reloads for a pin. Test: pinning with more than 500 rows loaded keeps the window and the scroll.
5. **(Accepted, not changed.)** A merge during an Undo's window: Undo of a pin whose conversation merged since leaves the survivor's pin, and Undo of an unpin of a merged-away conversation puts nothing back. Reminders behave the same (plan 87); both need a merge to land in the seconds between the action and its Undo.
6. **A pin's time always moves forward.** The backend gives each new pin `max(now, last + 1)`, so a pin made again in the same millisecond is a new pin that an Undo's exact delete can't take. Equal times (an import, a merge) order by thread id, newest first.
7. **Two operations and a toggle.** `pinThreads(ids)` and `unpinThreads(ids)` are what the menu's two items, the palette's items and the reader's More menu call; `togglePin()` (for `p`) pins unless every target is pinned. One guard serves all of them: with "select all N" (a scope) nothing is pinned and a snack says to pick the conversations. Tests: a mixed selection's Unpin unpins (it doesn't toggle), and a scope pins nothing.
8. **The rule for folders, stated:** a pin ends when the conversation is archived, trashed or marked as spam (from anywhere), and when a folder move or a filing into a hidden category takes it **out of the Inbox** (`leftInbox`, as for due reminders). A folder move that leaves it in the Inbox (its categories keep it) or moves an already archived conversation leaves the pin. Tests for both, with Undo.
9. **One geometry.** The top's sections are computed once (`topSections(items)`: their headings' indexes and the top's end) and feed the virtualizer's sizes, `RowSpacing` (anchors), the headings and the end hairline, which is placed from the last top row's measured end. Tests in `row-offsets.test.ts`: pins only, reminders only, both, with Today's headings unaffected. The heading's text is checked against the rows' text in a screenshot per row layout (classic, avatar, large avatar, wide).
10. **Pinned is not Reminders.** Rows in Pinned get no `reminderTop`: their date is the mail's, a due reminder shows its bell among the marks. `reminderTop` is only for the Reminders part.
11. **IndexedDB upgrade, fully.** The upgraded-store image (`idb.uncertain-upgrade.test.ts`) includes the empty `pins` store; a test upgrades a version-32 database holding mail and a reminder and finds an empty `pins` store with everything else kept; the guarded creation skips an existing store. The historical SQL fixture (`capture-repair-upgrade`) drops `pins` as it drops every later table.
12. **Gates.** This changes a migration and the store contract: `pnpm test:all` runs before it's done, with the migration budget and the load and UI perf gates. A main screen changes: `pnpm ui:rate` and `pnpm ui:gate`. The j-key render gate runs with pins present, and a unit test checks that a pin elsewhere renders no row.

## Revisions after the Codex code review

Five findings, all taken, each with a test that fails without its fix:

1. **A window refresh counted the top's rows twice.** Pages after the first arrive as they are, and the refresh measured its window before leaving the top's rows out, so it stopped short (700 loaded, pins whose dates fall at 501–600: 600 shown, a checked row beyond them dropped). Each page is now joined without the top's rows as it arrives (`join` in `reloadList`), so the window counts rows it shows. Test: `list-pins.test.ts`, a 700-row window with the pins coming again by date.
2. **A pin refreshed Split's list to 500 rows when it sat at the top.** Keeping the window depended on being scrolled. `reloadList` takes `keepWindow`: the whole loaded window in both layouts, with the anchor still only when scrolled. The pins event uses it. Same test.
3. **Unpin on more than 100 selected conversations was refused** by the RPC's limit. Unpin sends only the pinned among the targets, Pin only the unpinned, and a pin past the cap is refused before asking. Tests: `pins.test.ts`, 150 selected with three pinned (checked against the contract's own schema), and a pin past the cap.
4. **Filing into a hidden category ended the pin of a conversation already out of the Inbox** (archived, or in another hidden category). The pinned ones the Inbox shows are read before the filing (`pinsShown`), and only theirs end (`leaveTop`'s `pinIds`); reminders and follow-ups end as before. Test: `backend/pins.test.ts`, archived and hidden pinned conversations filed and moved.
5. **The palette's one command toggled,** so "Unpin" on a mixed selection pinned the rest. It offers Pin to top and Unpin separately, each when it applies; only P toggles. Test: `command-palette.test.tsx`.

## The row menu (after the e2e)

The row menu keeps at most eleven items at its top level (plan 158). Pin to top and Unpin made twelve, so they first went under **More ▸**, as Pin sat under the reader's More menu.

**The owner's call:** Pin is not under More anywhere. In the row menu, Pin to top (or Unpin) sits at the top level right after Star; the top level may hold twelve (`selection.spec`). On the reader's toolbar, Pin is an icon button beside Star, before Remind me: the outline pin while unpinned, filled in the ink while pinned (`aria-pressed`, named "Pin to top" or "Unpin", P in its tooltip), as Star fills when starred. `pins.spec` checks both in every style.

## The owner's second pass: the icon, the headings, the Inbox's count

- **The icon** is the upright pin (`PinTop`, Hugeicons' Pin02; the tilted `Pin` stays the pinned draft's and the pinned answer's). Pinned, it's filled in Star's yellow (`fill-star text-star`): the toolbar's pressed button, the row menu's and the palette's Unpin.
- **No pin in the list.** No row draws one, in or out of the Inbox (the row's `usePins` subscription went with it). A row in the Pinned section still tells a screen reader ", pinned".
- **Headings are words and a count**, at Today's headings' size (`text-sm`, medium) in the softer ink (`foreground-soft`, the owner: not full color; the count in the quiet ink): `Pinned (2)`, `Reminders (1)`, and, once either leads, the rest of the Inbox under its own name: `Inbox (590)`, or the account's name in one account's Inbox (`Personal (225)`). That heading replaced the hairline that closed the top (`TOP_GAP`, `inbox-top-end` and the rows' `reminderEnd` are gone), so the three read as one family; each has 8 px more room above its words than Today's (`INBOX_LABEL`, 36 px, the owner). Reminders got the same treatment as Pinned for that reason (it was a bell and a 12 px grey label).
- **The Inbox's count** is how many conversations that Inbox holds (the pinned ones among them), counted as "select all N" counts it (`threads.scopeCount` on the list's own scope: its account, hidden categories and tabs, its filter). It's asked beside the first page only when a top may lead (anything pinned, reminders due, follow-ups on top), and published with the rows it came with (`inboxTop.total`). Nothing on top, nothing counted. Test: `list-pins.test.ts`.
- **Only Inboxes, each account its own** (already so; now checked end to end): one account's Inbox shows only its own pins, another account's none, and a category or a search none (`pins.spec`).
