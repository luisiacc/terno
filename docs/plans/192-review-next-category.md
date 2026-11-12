# Plan 192: an emptied Review goes on to the next category by itself

## Request (verbatim)

> here when i get to an empty list when i'm sorting categories, we should have a button with a progress bar in the borders of 5 seconds, the button will go to the next category that has things to sort, or you can click it and it goes there immediatly, of course, if there is a category with things to sort, if there are , the button no longer has a progress countdown, instead the button becomes a 'Go to inbox' button

(The screenshot: Review on Viajes at 0, "All sorted · Nothing's left to sort in Viajes. Choose another category above, or press Esc to go back.", 75 left in other categories. "if there are" reads as "if there aren't".)

## What exists

- **Review (plan 159).** `lib/review.ts`: `reviewTotals()` gives the categories with suggestions waiting, the most first; `switchReview(id)` changes the category in the same Review (the way back kept); `leaveReview()` goes back where Review was entered from (Esc), else the Inbox. Its last suggestion answered, Review stays on the category, empty: `EmptyState` in `thread-list.tsx` says "All sorted" and, with `review.empty.more` / `review.empty.none`, to choose another above or press Esc. No control.
- **The countdown pill (plans 13, 182).** `components/countdown-pill.tsx`: `CountdownPill`, a pill whose border drains over `Countdown { duration, elapsed(), paused, sync }`; the owner's clock is the truth. Motion off steps it once a second. Owner's rule: a timed action is this pill, never ticking digits.
- **The dock's clock (`lib/snack.ts`)** pauses while hovered or focused, the window hidden, or a dialog covers the app. It is the dock's own state (one snack), not a general timer.
- **Focus on an empty list.** `leaveEmptyList()` hands focus from the emptied list to the empty state's action (`unread-empty-clear`), else the current sidebar row.
- **The app's voice.** `announce()` (plan 188).

## Design

### What it shows

Under "All sorted":

- **Another category has suggestions** (`next` = the first of `reviewTotals().pending` that isn't the one in view: the most waiting, as the sidebar enters Review): body "Nothing's left to sort in {category}." and a `CountdownPill` "Next: {next}" with a 5 s border. Pressed, or its time up, `switchReview(next)`.
- **None has**: body "Nothing's left to sort." and a secondary button "Go to Inbox", no countdown: out of Review to the Inbox (`navigate` as `leaveReview`'s fallback). Esc still goes back where Review was entered from.

`next` is read live: counts that refresh during the countdown change its label (and the target it goes to); none left turns it into Go to Inbox; suggestions that arrive while Go to Inbox shows start a fresh countdown. The current category is excluded by id, not by its count, so a count that hasn't refreshed yet never makes Review "go on" to itself.

### The clock

A small hook, `useAutoAdvance(ms, paused, run)` in a new `components/review-next.tsx` (the empty state's piece, out of the 1,500-line list file): elapsed time kept as `{ elapsed, since }` like the dock's, one `setTimeout` for what's left while running, none while paused (idle means idle). The pill's `Countdown` is fed from the same clock, so ring and timer can't disagree. It starts when the empty state with a `next` mounts, keyed on the category in view (a new empty category is a fresh 5 s).

It holds (never resets) while:
- the pointer is over the pill (reading it, about to press it),
- the window is hidden (`visibilitychange`),
- a dialog or menu is open (`dialog`, `menuOpen`: the category switcher is open, a right-click menu),
- focus is in a text field (writing something in the reader pane: switching category must not pull the page from under it).

Keyboard focus on the pill does not hold it: focus is handed to it programmatically when the list empties (below), and the countdown is the point. Enter/Space go at once.

### Focus and speech

- `leaveEmptyList()` puts the emptied list's focus on the pill or Go to Inbox first (the empty state's own action, as `unread-empty-clear`).
- Going on with focus in the pill (pressed, or by itself), focus moves to the category switcher (`review-category`), where a switch made by hand leaves it; Go to Inbox with focus in it moves focus to the Inbox's sidebar row. Elsewhere, focus stays where it was.
- When the empty state with a `next` appears, `announce("Going on to {next} in 5 seconds.")` once; going on by itself announces "Sorting {next}." The pill's accessible name says what pressing does now: "Go to {next} now".

### Copy (en / es)

- `review.empty.more`: "Nothing's left to sort in {category}." / "No queda nada por ordenar en {category}."
- `review.empty.none`: "Nothing's left to sort." / "No queda nada por ordenar."
- `review.empty.next`: "Next: {category}" / "Siguiente: {category}"
- `review.empty.nextName`: "Go to {category} now" / "Ir a {category} ahora"
- `review.empty.nextSoon`: "Going on to {category} in 5 seconds." / "Pasando a {category} en 5 segundos."
- `review.empty.nextNow`: "Sorting {category}." / "Ordenando {category}."
- `review.empty.inbox`: "Go to Inbox" / "Ir a Entrada" (es names the Inbox "Entrada")

## Tests

- **Unit** (`review-next.test.tsx`, jsdom, fake timers): goes on after 5 s; the press goes at once; hover, a dialog, a menu, a hidden window and a text field hold it and it resumes with the time it had; the next is never the category in view; none left → Go to Inbox navigates to the Inbox; suggestions arriving start a countdown; unmounting (rows came back by Undo) cancels the timer.
- **e2e** (`categorize.spec.ts`, the existing "y accepts, n rejects" test extended, no new backend): the emptied Review with another category waiting shows "Next: …"; pressing it switches. With none waiting, "Go to Inbox" leads to the Inbox. The 5 s auto-advance is covered by the unit test (no wall-clock in e2e).

## Perf and resources

One timeout while the empty state is up and running; none while held or once gone. No polling: holds come from events (pointer, visibility, focus, the app's state).

## Out of scope

- A setting for the delay.
- Going on when a search is typed: a search already leaves Review (plan 158).

## Revisions after the Codex review

The critique's twelve points, and what each changed (the design above is the first draft; where they differ, this wins):

1. **An answer still on its way.** `answerReview()` empties the list before the backend answers; going on and then failing would reload the wrong category. `categorize.ts` keeps how many answers are in flight (`useReviewAnswers`, a tiny store); the countdown holds while any is.
2. **The list covered by a page (List layout).** The list stays mounted, `inert` and invisible, under a conversation or a new message. The countdown holds while the empty state is inside an `inert` or `aria-hidden` ancestor (a page, the web's blocking screen, any modal's sweep), read by `useCovered()` (new, `lib/covered.ts`: the window hidden, or such an ancestor; a `MutationObserver` on the element's ancestors only, attributes `inert` and `aria-hidden`).
3. **The reader or a composer in use.** It holds while a conversation is selected, a message is being written (`compose`) or a sent one is shown (`heldView`): switching would close them. (Replaces "focus in a text field".)
4. **The dock in use.** It holds while the dock's own countdown is held by the user (hover, focus, its offers open, its undo running: `paused` has `hover`, `focus`, `expanded` or `busy`) and while any undo runs (`useSnack`'s new `undoing` count, kept by `runUndo`, so z's undo holds it too).
5. **Focus from the last row's own button.** That button's removal drops focus on the document, which `leaveEmptyList()` never sees. The action takes focus when it appears if focus is on nothing (the body) or on the emptied list.
6. **Focus when the action changes or goes.** The pill and Go to Inbox are one slot: focus in one moves to the other when counts swap them; the whole empty state leaving (Undo brought the rows back) with focus in it gives focus to the list.
7. **A new destination.** The countdown and its announcement are keyed on the destination's id: a different next category is a fresh 5 s and is said again.
8. **Every blocking surface.** Covered by 2 (`aria-hidden`/`inert` ancestors), plus `dialog` and `menuOpen`.
9. **A failed load.** The countdown arms only on a loaded list (`itemsKey === key`, no `error`).
10. **Keyboard hold.** Focus the user moves to the pill (Tab, a click) holds it until it leaves; focus the empty state gives it itself doesn't (a flag set around its own `focus()` call). The announcement says the time; Esc still leaves Review.
11. **Long names.** The pill may shrink to the column (`max-w-full`), its label truncates (a `span` in `CountdownPill`), the full name stays in the accessible name.
12. **Browser cases.** e2e covers pressing it (the switch and where focus lands), Go to Inbox, and the action taking focus after the last answer by keyboard; the time arithmetic and every hold stay in the fake-timer unit test.
