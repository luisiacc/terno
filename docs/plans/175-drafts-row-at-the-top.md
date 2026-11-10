# Plan 175, the drafts row at the top of the list

## The request (verbatim)

> in one of the plans we removed the drafts from the ui to now show above, and now sometimes they show in the bottom. i don't like this, i think if there is at least one draft it needs to show at the top of the inbox with the style it currently has, if there is more than 1 draft we still show 1 row, and we say how many drafts are there, then that row opens a dropdown with the items being the drafts themselves, i think this is a clean solution

## What exists

Plan 158 moved the drafts strip (`components/drafts-strip.tsx`) from above the rows to the list's foot, so its arrival on `j` couldn't move a row. It holds only what isn't on screen elsewhere: new messages, drafts whose conversation isn't listed, older drafts of a conversation with a newer one, and scheduled sends. A draft on a listed row (its Draft tag), the one being written and the pinned one are left out. So the strip comes and goes as drafts move between those places, which is the "sometimes" the owner sees, and it sits at the foot, out of sight under a long list. With several items it's one line (the draft Esc came back from, else the newest) and a `+N` count that opens the rest upward, inline. The snack dock stands on it (`useSnack.lift`).

## Design

**Where.** At the top of the list, under the header (and the report row, banners and selection bar that already sit there), over the rows, with a hairline under it. Hidden while searching and in an action's preview, as now.

**What it counts.** Every draft with the user's words in it (`authored`, or a file on its way), wherever it is: on a row, open in the reader, pinned, put away; plus scheduled sends. A send in flight stays until it's sent, so it can be opened again and never sent twice (plan 158). Counting all of them is what makes the row steady: it changes only when a draft is written or leaves, never when the reader moves, so `j` and `k` never move a row (plan 158's reason for the foot no longer applies). Its height never changes while anything is counted; it comes with the first draft written (the rows move down one line, once) and goes with the last one (a draft emptied and left, a send).

**One item.** The row is that item, as it looks now: the pen, the subject, the Draft tag and who it's to (or the clock, subject, recipients and when, for a scheduled send). A click opens it as before (`openStoredDraft`), except a draft whose editor is open on screen, which is only focused where it is (`focusDraftOnScreen`). `data-testid=strip-item` and `data-key` as now.

**Several.** One row that says how many: the pen, "3 drafts" (`compose.strip.count`), with "· 1 scheduled" after it when there are scheduled sends (only scheduled sends: the clock and "2 scheduled"), and a chevron at its end. It's the trigger of a dropdown (`DropdownMenu`, BoardUI's menu, the strip's width, under it): the drafts newest first, each item laid out as the one-item row is, then the scheduled sends. Arrows, typeahead and Esc are the menu's. Choosing a draft opens it; choosing a scheduled send opens Send later on it (`ScheduledPopover`, now also controllable and anchored to the row, since the menu that held the item has closed). The menu scrolls past 40vh. Its items are rendered only while it's open.

**Focus after Esc.** Leaving a new message focuses its item if the row is that item, else the row (the dropdown's trigger): `[data-testid=strip-item][data-key=…]`, then `[data-testid=strip-summary]`. The "lead" state (Esc's draft kept on the line) goes: the row is a count now.

**Re-rendering.** The closed row follows only the count, and the key when there's one; a row follows only the strings it shows. Typing in a draft (its body, and so its order) renders nothing; only the open dropdown follows the order.

**The snack dock.** The strip no longer sits at the list's foot, so it sets no `lift`. `useSnack.lift` stays for nothing else: it's removed, and its readers (`snack-dock`, `pinned-draft`, `pinned-ask`) read `pageLift` alone.

**Copy.** `compose.strip.count` ("# draft" / "# drafts"; es "# borrador" / "# borradores"), `compose.strip.scheduled` ("# scheduled"; es "# programado" / "# programados"), the trigger's accessible name `compose.strip.open` ("Show # drafts"; es "Mostrar # borradores"). `compose.strip.more` goes.

## Tests

- Unit (`drafts-strip.test.tsx`, new): one draft shows as the row; one inline on a listed row, one open in the reader and the pinned one are all counted; two drafts show one summary row, "2 drafts", and opening it lists both, newest first, choosing one calls `openStoredDraft`; scheduled sends are in the count and the menu; a `sending` draft and an unwritten one aren't counted; typing in a draft's body doesn't re-render the strip.
- Existing unit tests that said "out of the strip while on its row" now say it's in the strip (`draft-return.test.tsx` and its neighbours).
- e2e (`compose.spec.ts`, the strip scenario rewritten): three new messages put away give one row at the top reading "3 drafts", rows under it don't move while writing and putting away, the menu lists the three, choosing one opens it, Esc lands on the row; a single draft on a listed row also shows the strip. Assertions elsewhere that the written draft isn't in the strip (compose, composer, pinned-draft) are updated to what's now true. `send-later.spec` and `design-axe.spec` follow the scheduled send into the menu where there are several.
- Visual: screenshots of the row with one draft, with several, and the open menu, in light and dark, in Lumen and macOS.

## Performance

The selector was already a pass over the drafts on each store change; it now returns primitives, so the 2,000-draft typing gate (`perf.spec.ts`) gains rather than loses. The j-key gate holds the drafts it already sets up; the strip no longer depends on the list's index, so `j` can't render it. The menu isn't virtualized, as the expanded strip wasn't: it renders only while open.

## Out of scope

- The Draft tag on rows and the conversation's own one-line draft stay as they are.
- A Drafts folder or view.
- Reordering or acting on drafts from the menu (discard, send): the menu opens them, as the strip did.

## Revisions after the Codex review of the plan

Nine points, all taken:

1. **A draft open on screen went through a full open** (source lookup, thread load, a new pane publication) when chosen in the row, which is now possible for every draft. `focusDraftOnScreen` focuses its editor where it is (caret, scroll and undo kept), as a newer choice than any open on its way. It's the row's, not `openStoredDraft`'s: that one's other callers (follow-up nudge, Send later's Edit, unpin) still navigate.
2. **Choosing in a menu could cancel the open** it started (`openStoredDraft` gives up when focus moves, and a closing menu gives focus back to its trigger). The menu hands focus over, as the thread menu's Reply does; a draft that didn't open, with no newer open on its way, puts focus back on the row (`composeIntent`).
3. **Esc from a new message during a search** has no row to land on: as before (the strip was hidden there too), not a regression; not changed.
4. **Focus when the row changes shape** (one draft becomes several, the dropdown goes as the count drops to one): the part leaving notes that it held focus before it leaves the page, and the row replacing it takes it. Focus elsewhere stays there.
5. **"Never moves a row" was overstated.** Restated above: steady while anything is counted; it comes and goes with the first and last draft.
6. **Body edits change a draft's order,** so a list of keys would still render. The closed row follows the count alone; the items, and their order, only while the dropdown is open.
7. **The dropdown isn't virtualized.** Measured instead: see Performance.
8. **Send later opened from the dropdown** follows the live scheduled send by its id, and closes (for good) if it's sent, cancelled or moved meanwhile.
9. **Fixtures.** The j-key gate's two drafts are now a count, the 2,000-draft gate waits for the row, and the menu is exercised for real (jsdom and e2e, pointer and keyboard).
