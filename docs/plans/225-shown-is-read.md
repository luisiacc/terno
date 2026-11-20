# 225: what the reader shows is read

## Request (the owner, 2026-11-20, verbatim)

> sometimes when i land on the inbo when i open the app, and hte first message is displayed and is unread, we are not markign it as read when its being displayed already, i have to select another email and then select this one again for it to be marked unread, lets fix this at the root cause and make it a way that is hard to make a mistake with that logic.

(With a screenshot: Split, the Inbox's top row open in the reader, still unread.)

## What exists

- The reader's effect ran `scheduleMarkRead(selectedId)` (450 ms dwell, `lib/actions.ts`) unless `openedByApp(selectedId)`.
- Plan 158 (7f103e03f, 8064d5a73) added that exception: what the app opens by itself (a list's first page on launch, a mailbox switch, a search's top hit; the next after Archive or Delete; Undo's put-back; What matters' next row after Done) "isn't read until the user chooses it". Choosing was a row press, Enter, j/k, a press in the reader, a reply (`chooseOpenThread`, an `onThreadChosen` callback reading it then).
- So whether a shown conversation got read depended on how it came to be selected, and every selection path had to say which kind it was. The launch case is the one the owner hit: the app opened the top row, it showed in full, and it stayed unread until the user went away and came back.

## Design

**One rule, in one place:** a conversation on screen in the reader for the dwell (450 ms) is read, however it came to be open. `lib/read-on-show.ts` owns it:

- `showThread(id)` starts a showing and returns its end. The reader calls it through `useReadOnShow(selectedId, drawn)`, one effect keyed on the shown id and on whether its conversation is drawn; the effect's cleanup ends the showing (another thread, the reader unmounted: the bulk bar, a new message, List's page closing). Nothing else starts or cancels a read.
- A showing begins once the conversation is drawn, never while the reader shows its skeleton (the row's header alone isn't the mail).
- The dwell counts only while the window can be seen (`document.hidden`): a launch in the background reads nothing; hidden inside the dwell, it starts over when seen again.
- One read per showing, of the conversation as it is when the dwell ends (unread then, it's read). Read state set by hand (Mark as read or unread, from any key, menu or the palette: `act` says so through `lib/read-by-hand.ts`) ends the showing's read: a Mark as unread inside a showing, before the dwell or after, sticks until it's shown again (then it's read again, as Apple Mail does). Holding j passes rows by inside the dwell, so they stay unread.
- The reader is only mounted while a conversation is on screen (Split's pane, List's page), so List's cursor on a row reads nothing.

Plan 158's provenance (`openedByApp`, `setAppOpened`, `chooseOpenThread`) stays for what it still decides: What matters' Done opening the next row's mail only when the reader was open by the user's choice, and Undo putting that back. It no longer says anything about read; `onThreadChosen` and `readChosenThread` go, having no other use.

This reverses plan 158's "what the app opens by itself isn't read" on purpose: the owner's rule is that what's displayed is read.

## Tests

- `read-on-show.test.ts` (unit): read after the dwell, not before, whoever opened it; nothing once the showing ends or the selection moves; Mark as unread by hand before the dwell (shown read or unread) and after it sticks, another conversation's doesn't stop this one; a cached copy refreshed unread within the dwell is read; hidden windows read nothing and a hidden spell restarts the dwell; a conversation off the list is read.
- `reader-mark-read.spec.ts` (e2e): the plan 158 block flips: the first load's top row (the owner's case), a mailbox switch's and a search's top hit, and Archive's next are read once shown; Mark as unread on the open thread sticks; a conversation whose load is held shows its skeleton past the dwell unread, and is read once drawn (fails without the drawn gate).
- `unread-filter.spec.ts`: the press that "chose" the open thread goes.

## Perf

One timer, one `visibilitychange` listener and one by-hand listener per showing, all gone with it.

## Out of scope

The digest page's own read (`digest-page.tsx`), reminders and AI spend rules (not tied to this dwell).

## Codex code review

Round 1 (three findings, each fixed with a test):

1. The dwell started while the reader still showed its skeleton (a slow or failed load read mail never seen). The showing now begins once the conversation is drawn; the e2e holds `threads.get` and fails without it. This also retired the first version's wait-for-the-thread subscription.
2. A hidden window (a launch in the background) still read the conversation the app opened. The dwell runs only while the window can be seen (unit test).
3. Mark as unread pressed inside the dwell was overwritten when the timer fired (true before for a clicked conversation too). First fixed by reading only what was unread when the showing began (unit test).

Round 2 (two findings, each fixed with a unit test that fails without it):

1. Round 1's #3 was only half fixed: on a conversation shown unread (partly read), Mark as unread before the dwell was still overwritten. `act` now says when read state is set by hand (`lib/read-by-hand.ts`, a module of its own so `actions` and `read-on-show` don't import each other), and that ends the showing's read.
2. The "unread when it began" snapshot let a stale cached copy (read) keep a conversation the backend says is unread from ever being read. With the hand signal the snapshot went: the dwell reads what the conversation is when it ends.

## Notes

- `unread-filter.spec.ts` "select all N is the unread threads" failed twice in crowded multi-spec runs (the count still loading after 8 s) and passed 27 of 27 with its file alone.
- `today.spec.ts` "What matters, part one" flakes under load at its Later step (the row comes back after "Later: Electricity bill"): the same failure shows with plan 158's gate put back (2 of 8 runs), so it predates this plan.
- A new message arriving in a conversation while it's shown stays unread until it's shown again, as before.
