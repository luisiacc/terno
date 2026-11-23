# Plan 235: Automated mail: an opened row can be ticked, and a row menu that hides its sender

## Request (verbatim)

> in the 'automated mai' section of the what matter section, there is a bug when it says an item that it was opened in the
> inbox [screenshot: rows "Opened · stays in Inbox"] i cannnot check the checkbox it has, lets fix that please.
>
> also for thos items there, we need a right click context menu for them, i'd like the ability to mark them somehow so they
> won't appear on this list at all in the future either, same when multiple are checked in, irght now i can only archive them

## What exists

- `apps/web/src/components/digest-page.tsx` is both pages: Today's digest (AI lines, every unread row pre-ticked, Archive
  takes the ticked) and, with the digest off, **Automated mail** (`row.automated`: nothing ticked, Archive selected).
- A row is **opened** when it's read: opened from the page (`pick.opened`, live) or read anywhere (`readIds`, not live).
  `tickable = live && !opened`, so an opened row's box is disabled. The backend agrees: `TodayService.archive` spares
  every read thread (plan 145: "an opened newsletter is read, so it stays in the Inbox and out of the batch"). That rule
  is right for the digest's pre-ticked batch; it's wrong as a lock: the person can't choose to archive one they read.
- `toggled` (in `DigestPick`) means the unticked rows in a digest and the ticked rows in Automated mail.
- Plan 166's "Not a newsletter" keeps a sender out of every digest **and Automated mail** (`today:notNewsletters`, a
  settings list, cap 500, exact Undo, Settings → AI → Newsletter digest lists it). Its row control and menu are digest only:
  "Automated mail hasn't claimed anything is a newsletter" (plan 166 left "a control for Automated mail" out of scope).
  The RPC takes one sender.

## Design

### 1. An opened row can be ticked (both pages)

- An opened row **starts unticked** (as now: it says "Opened · stays in Inbox"), but its box works. Ticking it is the
  person's explicit choice, held apart from `toggled` in a new `DigestPick.readTicked` set (read rows the person ticked).
  Kept apart so a row that turns read never flips: in a digest an unread row the person unticked is in `toggled`; read
  later, it must stay unticked, not read as "ticked".
- `stateOf`: read → `readTicked.has ? "archive" : "opened"`; else live → ticked/keep as now; else "archived".
  `read(i) = live(i) ? opened(i) : readIds.has(i) && !archivedHere.has(i)` (archived here is archived, whatever readIds
  said before the next read).
- **Tick all:** in Automated mail every row still in the Inbox, read ones too (the person picks everything there); in a
  digest the unread ones, as now (its hint says "Any you untick or open stay"). **Untick all** clears both sets.
- Automated mail's count counts every row still in the Inbox (opened ones were left out of "# messages").
- **Backend:** `today.digestArchive` items gain `read?: true` ("the page showed it read and the person ticked it"). A read
  thread is archived only with that flag; one read since the page was drawn without it is still spared (plan 145 holds).
  Starred or replied stay spared as now (the row doesn't show either).

### 2. The row menu in Automated mail, and Hide sender

- Automated mail rows get the row menu (right-click, ⇧F10): **Open**, **Archive**, separator, **Hide sender**.
  The digest's menu is unchanged (Open, Not a newsletter).
- **Targets** (as lists do): right-click a ticked row while others are ticked → the ticked rows; anything else → that row.
  Labels count when more than one: "Archive 3", "Hide 2 senders" (senders are counted once each).
  A row already archived elsewhere offers Open and Hide sender only.
- **Hide sender** writes the same list as "Not a newsletter": the sender leaves the page, Today's header and Archive at
  once, and stays out of Automated mail and the digest. Snack with exact Undo. Not a new store: the list already means
  "kept out of the digest and Automated mail"; only its name was the digest's.
- **The foot:** with rows ticked, a "Hide senders" button (outline) before "Archive selected", for the ticked rows' senders.
- **Batch RPC:** `today.notNewsletter` takes `senders: {email, name}[]` (1…200) and answers `added: NotNewsletter[]`;
  `today.notNewslettersUndo.remove` becomes a list. One `settings.update`, so a batch and its Undo are one unit (the cap's
  evictions too). The page's one-sender path uses the same call.
- **Copy (en + es):** menu "Hide sender" / "Hide # senders"; snack "{sender} won't show in Automated mail" /
  "# senders won't show in Automated mail"; Undo "Undo, and show {sender} here again" / "Undo, and show them here again";
  failure "Couldn't hide {sender}. Try again." / "Couldn't hide those senders. Try again." Settings' list becomes
  **"Senders left out"**, hint "Kept out of the digest and Automated mail. Remove one to let it back in.", removed
  "{sender} can show in the digest and Automated mail again", its Undo "Undo, and keep {sender} out again".

## Tests

- `digest-page.test.tsx`: an opened row's box ticks and unticks (both pages); a digest row unticked then read stays
  unticked; Archive sends `read: true` only for ticked read rows; Tick all in Automated mail ticks read rows, in a digest
  not; the Automated mail menu: Open / Archive / Hide sender on one row; on a ticked row with others ticked, the counts and
  targets; Hide sender (menu and foot) removes every row of those senders at once, one RPC, Undo brings them back with
  their ticks; the old "automated mail has neither" test becomes the digest-only control test.
- `today.test.ts` (backend): a read thread is archived with `read: true`, spared without; a batch `notNewsletter` adds
  several in one unit, skips listed ones, its Undo removes exactly those it added.
- `ai-summaries.test.tsx`: copy only.
- e2e: none new (no flow beyond the page; unit tests cover it at the lowest level).

## Perf

Nothing on a hot path: the page is ≤ 40 rows; one settings write per batch instead of per sender.

## Out of scope

Hiding per message rather than per sender; Archive in the digest's menu; changing what Automated mail scans.

## Revisions after the Codex review

Codex read the plan against the code and made ten points; what changed:

1. **One set for Automated mail.** Its ticks are all the person's, so `toggled` holds them read or not, and a tick kept
   through a read or a Mark unread stays. `readTicked` is the digest's alone (its unread rows start ticked). (Point 7.)
2. **Bulk changes touch shown rows only**, in both sets: a sender hidden keeps its rows' choices for its Undo. Untick all
   keeps the digest's meaning (every shown unread row into `toggled`). (Points 1, 2.)
3. **Inbox membership** is `live || read`, `read` excluding what this page archived; checkbox, `x`, count, Tick all use it.
   Tested with a page of opened rows only. (Point 3.)
4. **The menu's Archive is consent too:** `archive(targets)` takes the menu's rows and sends `read: true` for its read ones,
   leaving every tick as it was. Tested. (Point 4.)
5. **Undo's promise narrowed:** Automated mail scans unread mail, so an opened row hidden and let back in comes back only if
   a scan still finds it, as every opened row already leaves at its next scan. Undo restores the list exactly. (Point 5.)
6. **No sender address, no Hide:** such rows are left out of the batch and its count; the menu and foot offer none when
   nothing's left. Tested. (Point 6.)
7. The opened-row test (plan 162) is rewritten, not supplemented; the e2e's "Not newsletters" is the new title; the
   Automated mail e2e opens the menu by ⇧F10, checks its items, and runs axe in light and dark with screenshots.
   (Points 8, 9, 10.) The Settings removal copy stays ("{sender} can be in the digest again" is still true).

UI rating (plan 158) is not run for this series: one foot button and a row menu on the digest page, both checked in
screenshots; the owner can ask for a run.

## What the Codex code review changed

- A digest's opened row ticked (or unticked) by the person keeps that choice when it's marked unread: its toggle sets
  `toggled` to match. Tested both ways.
- A digest of opened rows only shows Untick all once one is ticked (Tick all still leaves opened rows out). Tested.

## Follow-up: what Hide does to mail still to come (owner, 2026-11-21)

> I think we need to clarify that, for the hide-to-centers, it also has them in the future. From this list let's have some
> kind of a help icon where you can hover over it and see a tooltip with that information so they know that in that
> right-click menu

The menu's Hide row ends with a muted info icon (in the row's shortcut slot, `ContextMenuShortcut`); its tooltip says mail
from the sender stops showing here now and in the future, stays in the Inbox, and where to let it back in. A click on the
icon does nothing (it isn't the row's). The row is described by the same text for screen readers (`aria-describedby`), and
the foot's Hide senders button has it as its tooltip. Copy `today.digest.hideHelp`, en + es.

What the Codex code review of the follow-up changed: a click on the tooltip itself (portaled, but the row's child for
React's events) hid the sender; the stop now sits on the row-end wrapper that holds both icon and tooltip. And a keyboard
has no hover: the help also shows while the arrows have the Hide row (the menu notes whether a key or the pointer moved
last). Both tested (unit and e2e).

## Follow-up: Shift with a tick (owner, 2026-11-22)

> we need to make the shift_click in here work so i can select multiple with shift and checking one

Shift with a tick gives every row from the last one ticked or unticked (by click or `x`) to it that row's new state, up or
down, as a list's range does; with no earlier one it is a plain tick. The range takes the rows Tick all takes (in Automated
mail every tickable row; in a digest its opened rows stay out unless they are the one pressed), so one `setTicks(ids, on)`
now serves a tick, a range and the keys. The anchor resets with the day. Shift's mousedown on a tick is prevented so it
selects no text. Base UI forwards the click's modifiers to the change event (`dispatchClickWithModifiers`), which is where
Shift is read. Tested in the unit (both pages, both directions, unticking, an opened row) and in today.spec (real Shift
click, no text selected).

What the Codex code review changed: preventing Shift's mousedown also kept the focus on the last tick, so Space then toggled
that one; the press now focuses its own tick (a program's focus: no ring). Tested in today.spec.

## Follow-up: a Close on the page (owner, 2026-11-22)

> also when that list becomes empty, and when its not empty, that panel for list of newsletters should have a close button
> on the top right to clsoe it

Automated mail and the digest have a × at the top right, full, emptied or with no digest at all: on the pane's bar at the
column's right edge, where the reader's × sits for an open conversation, with the same name and tooltip (Close, Esc). It
does what Esc does there, through one `closeDigestPage()` in `lib/page.ts`: beside What matters' feed the page goes and
the feed has its room back, on its way in; in List the page over the feed closes. It scrolls with the title (the page has
no fixed bar, and a floating × would sit over the rows' dates). Tested in today.spec, Split and List.

The Codex code review found one difference from Esc, kept on purpose: with feed items ticked, Esc clears the ticks first,
while the × closes the page and leaves them ticked. A click on × asks for the page to go, and the reader's × does the same.
