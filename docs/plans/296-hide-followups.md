# Plan 296: hide a conversation's follow-ups

- **Status:** built.
- **Builds on:** `e75777e5d` (main).
- **Request (verbatim):** "we need a way to hide these , lets have a 'hide followups (3)' on the top right at the ned, in the same line as the 'expand message' and amount of messages" (with a screenshot of a conversation showing an own promise's card, "Due Oct 30 · You told Terry you'd send the final PDFs", and two cards for promises of Terry's).

## 1. What it means

Above a conversation the reader stacks its follow-up cards: the items card (`ThreadItems`, plan 210: your promises and dated items, one leading and the rest on its Also line, or a person waiting on you, plan 216) and a card for each wait or promise of theirs (`ThreadFollowups`, plans 142 and 280). With two or three of them the mail starts half a screen down.

The reader's chips line (account · N messages · Expand all) gets, at its end on the right, **Hide follow-ups (3)**: the count is every item those cards hold. Pressed, the cards go and the control reads **Show follow-ups (3)**. The choice is one for the reader, like the summary's disclosure (`terno:summaryOpen`): it holds for every conversation and across launches, so someone who wants the mail first doesn't hide them again in each one; the count on the line keeps them one click away and says there is something there.

Nothing is dismissed, snoozed or changed: the follow-ups stay in What matters, Follow-ups, People and the Inbox's top exactly as before. Hidden, the reader doesn't offer the follow-ups tip either (it points at a card that isn't there).

## 2. What exists

- `reader.tsx` `Thread`: `useReaderItems(detail)` once (plan 210), then `ReaderHeader` → `ThreadChips` (account, `MessageCount` with Expand all, categories, suggestions), `ThreadItems`, `ThreadFollowups`, the summary, attachments, the conversation. `ThreadChips` is the same line in every design; the design only moves it (`classic` / `sender-card` under the subject, `chips-display` above it).
- `thread-items.tsx` `ThreadItems`: draws nothing until `ready`; then the lead (`top`, or the waiting line when `waiting === "top"` and its task exists) and an Also line (`others`, plus the waiting line when `waiting === "also"`).
- `thread-followups.tsx` `ThreadFollowups`: the rows of kind `awaiting` and `theirs` for the thread, when follow-ups are offered for the account and the thread isn't in Trash or Spam; offers the `followups-first` tip.
- `lib/summaries.ts`: `open` + `setSummaryOpen` in localStorage under `terno:summaryOpen`, the pattern this follows.

## 3. Design

- **Counting** lives with what draws it, so the count and the cards can't disagree:
  - `thread-items.tsx` exports `readerItemCount(items: ReaderModel): number`, the same conditions `ThreadItems` draws by (0 while not ready; lead + Also line).
  - `thread-followups.tsx` exports `useFollowupCards(detail)`: the rows it draws (the `waits`), used by `ThreadFollowups` itself and by `Thread`.
  - `Thread` adds them and passes `followups={{ count, shown, toggle }}` through `ReaderHeader` to `ThreadChips`.
- **State:** `lib/followups-shown.ts`: a small zustand store `{ shown }` read from localStorage `terno:followupsShown` (default shown; storage refused, shown, held for the session), `setFollowupsShown(shown)`. Not account data, so plan 293's reconcile has nothing to drop. (After the review: `useReaderItems` combines it with the feed's reveal, see the revisions.)
- **The control:** `FollowupsToggle` in `reader.tsx`, the same `link-secondary` xs button as Expand all (`text-foreground-soft`, the icon at 3.5), `EyeOff` while shown and `Eye` while hidden; a plain button whose name says what it does (no `aria-pressed`: the label already changes); `ms-auto` puts it at the line's end. With no follow-ups it isn't drawn; with one message (no count, no Expand all) it still sits at the end of the account's line. Narrow (`@max-[560px]`), the count and Expand all already give way; this stays (it's the only way to the mail).
- **Hidden:** `Thread` doesn't mount `ThreadItems` or `ThreadFollowups`. `useReaderItems` keeps running (the summary and the count read it). The tip is offered only while shown.
- **Copy:** `reader.followups.hide` "Hide follow-ups ({count})", `reader.followups.show` "Show follow-ups ({count})"; es "Ocultar seguimientos ({count})", "Mostrar seguimientos ({count})" (`followups.title` is "Seguimientos").

## 4. Tests

- Unit: `lib/followups-shown.test.ts`: default shown, a stored "hidden" read back, the setter writes, a refusing storage keeps the session's value.
- Unit: `readerItemCount` in `thread-items.test.tsx`: not ready 0; a lead and two Also; a waiting lead; a waiting Also with no task isn't counted.
- e2e (`followups.spec.ts`, into the plan 280 test's page as a scenario): the conversation with an owed card shows "Hide follow-ups (1)" at the chips line's right end (its right edge on the column's); pressed, the card goes and it reads "Show follow-ups (1)"; another conversation with one stays hidden; a reload keeps it hidden; Show brings them back. Axe on the line in light and dark.

## 5. Performance

One more selector and a sum per render of the open conversation; no reads, no timers. Nothing in a list.

## 6. Out of scope

- A per-conversation choice, a palette command or a shortcut (the owner: no new shortcuts for this kind of thing; the button is reachable with Tab).
- Hiding the summary (it has its own disclosure).

## Revisions after the Codex review

Codex read the plan against the code (11 points). What changed:

1. **An item opened from What matters shows anyway.** The feed's open row asking for one of this conversation's items (or its waiting line) shows the cards for that opening, whatever the choice; hidden there by hand, it stays hidden until another row is opened. So visibility lives in the reader's model: `useReaderItems` returns `shown` and `setShown` (the store's choice, plus that reveal), and `Thread` reads it.
2. **Hidden, no keys for a line that isn't there.** The choice made from the Also line is published for the keys and the palette only while the cards show, and hiding closes the reader's Later menu (`closeReaderLater`).
3. **Focus:** the control is the same button hidden or shown, so focus stays on it. (A backend change taking the last follow-up away while the button has focus is left as it is: rare, and the reader keeps its section.)
4. **Its own column on the first line.** A trailing `ms-auto` in the wrapping chips line would be the first thing to wrap. The chips line is now two parts: the account, count, Expand all, categories and suggestions wrap in the first; the control is the second, centred on the first line (a chip's 24 px when the line has one, the design's own line height otherwise, `min-h-[inherit]`). The label never wraps; the account's name truncates first.
5. `aria-expanded` on the control, its icon decorative. No `aria-controls`: the cards unmount when hidden.
6. The rows with a card of their own are resolved once in `Thread` (`useFollowupCards`) and passed to `ThreadFollowups`.
7. (A waiting row held with no task draws nothing on the items card even with other items: that's the card's existing rule; the count follows what's drawn. Not changed here.)
8. (The follow-ups tip's anchor: existing behaviour; hidden, it isn't offered.)
9. **The summary:** hidden, it no longer leaves out what the item lines say (`said` is empty), so nothing is in neither place.
10. Opening a conversation still counts as seeing its follow-up for the Inbox's top, hidden or not; the count on the line says it's there. Hide and Show change nothing stored.
11. **Tests:** a two-message conversation with a promise and a wait (count 2, Done → 1, Undo → 2), a one-message one, a reload, and the placement in every design's `@design` run.

## What the Codex code review changed

1. **Hidden for one opening.** A What matters item hidden by hand, then another row of the same conversation opened, then the first again: it showed hidden (the reader stays mounted and the key matched again). The hand's hide now holds for that one opening (`useReaderItems` lets it go when the open row changes); unit test A → B → A.
2. **Another window's choice.** A web tab that takes the mailbox over keeps its page and the value it read at load; the store now follows `storage` events for its key (unit test).
3. (Declined: in a narrow reader with a long account name, Expand all can wrap under the account before the name truncates. That's the chips line's existing wrapping, which this only makes a little likelier; the control stays on the first line.)
