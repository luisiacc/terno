# Plan 213: the list's keys on What matters' rows

- **Status:** built.
- **Builds on:** plan 210 (the feed, its rows, the open row and the place a conversation was put away from), plan 204 (Done means gone; archiving doesn't end a task), plan 158 (an app-opened conversation is unread until chosen).

## The request

> in the 'what matters' ui , key shortcuts don't work like e for archiving and hte normal ones, they should work, you cna use that ui populated using the demoai command

## What was wrong (seen on `dev:demo-ai`'s mailbox)

1. **Nothing open, the keys on a row** (after Esc, or Tab): `e`, `#`, `!`, `s`, `u`, `l`, `v`, `h`, `r`… did nothing. The thread actions act on `selectedId`, and the feed has none until a row is opened (it keeps the place as `useFeedRow.cursor`, a row, not a selection).
2. **A person waiting on you, open, `e`:** the snack said Archived, but the row stayed and the reader stayed on it. In What matters the view is `"all"`, so `staysInView` kept every archived conversation; the open row was held (plan 210's revision 9) until it was put away, and then it vanished with the keys falling to the page.
3. **Trash or Spam on the open row:** the Inbox's `stepPast` moved the selection by the list's conversations, never the feed's `opened` row, so no row showed as open and j/k started over from the top.

## Design

- **The target** (`lib/feed-focus.ts`, `keyRow` / `feedKeyThread`): the open conversation when one is open, as the Inbox's, wherever focus is (a dialog's field, the palette, another row, the digest's row); with nothing open, the feed's place (`useFeedRow.cursor`): the row a conversation was put away from, or the row the keys were put on (a row's focus sets it, `placeFeedKeys`). `currentTargets()` (every thread action, the category picker, remind, pin) and the keys' `hasTargets` use `keyThread()`. The digest's row is never one.
- **`r`, `a`, `f` with nothing open** open the keys' row's conversation first (`openFeedKeyRow`), the reply in it, as the Inbox replies to its selected row.
- **What leaves** (`lib/feed-leave.ts`, `feedRowsLeaving`): Trash and Spam take every row of the conversation (What matters shows nothing in them); Archive only a person waiting on your answer (`waitingPage` reads the Inbox only). A task (a bill, your promise), a reminder and a history line stay, their mail filed (plan 204: "the bill still has to be paid after its mail is filed").
- **How it leaves** (`dropFeedRows`, taken out of `today-task.ts`'s `leaveFeedRows`, which Done, Remove and Later keep using): at once, the open row moving on to the next as after Done (opened by the app when the user had opened it, plan 210 iteration 4); the keys go on to the next row when they were on one that left, never to the page. `actions.ts`'s `leaveList` sends What matters to `leaveFeed` instead of the Inbox's `stepPast`; a conversation leaves the list only when none of its rows is left. A conversation open beside the feed that is none of its rows (opened from elsewhere), trashed, goes on to the feed's first row (`onToFirstRow`), as before but with the row shown open.
- **Undo is exact:** `SelectionBefore` keeps the feed's open row and place (`feedBefore`) and the feed's own moves; `restoreSelection` puts them back (`reopenFeedRow`), the checks and the keys with them, unless a newer choice came (a row opened, a sibling row, the keys put on another row). The read after an Undo can answer before the backend has the conversation in What matters again (its waiting facts follow the mailbox; seen as a flake under load), so the put-back waits for the answer that holds the row: at most three answers, and only while nothing newer is chosen. Done's Undo (`restoreFeedRow`) gets the same wait.

## Tests

- **unit `actions.test`, plan 213:** the keys put on another row after the action stay there through Undo; Undo while the backend hasn't the conversation back yet restores the open row and the checks with it.
- **unit `feed-leave.test`:** what each action takes out; the keys' row as the target with nothing open, and the keys and place going on; the open row leaving opens the next with the keys; Undo's put-back waits for the answer that holds the row; a waiting put-back dropped when the user moves, and given up after a few answers. Without the wait, two fail.
- **e2e `what-matters-feed.spec`, "the list's keys on What matters' rows":** `e` with nothing open (row leaves, keys on the next, z back with the keys); `e` on the open row (next opens, z reopens it); a task stays open with its mail filed; `#` with nothing open and z; `r` with nothing open opens the conversation with its reply. Without the fix, three of the four fail. Eight repeats in parallel pass.
- Run: the unit files for actions, select, keyboard, feed-focus, feed-pane, feed-leave, today-task, today, today-line (133); e2e what-matters-feed, today, what-matters-change, what-matters-mute, hand-to, triage, plain-actions, selection, list-keyboard-entry (62, 2 skipped as before; hand-to's known flake aside). Checked on `dev:demo-ai`'s mailbox (a copy) in the built desktop app.

## Revisions after the Codex code review

Round one (8 points, all taken):

1. **The target followed DOM focus,** so a dialog's field (the category picker), the palette, the digest's row and `r` disagreed on which conversation the keys meant: with A open and B focused, `l` then typing categorized A, `#` on the digest's row trashed A, `e` hit B while `r` replied to A. Now one rule: the open conversation when one is open; with nothing open, the feed's place, which a row's focus sets (above). (Points 1, 2, 3 and 5.)
2. **Undo replaced a newer sibling-row choice:** opening another row of the same conversation changes the feed's `moves`, not the selection. `restoreSelection` checks the feed's moves too (`feedMoves`, recorded by `settled`).
3. **The waiting put-back ignored newer choices and could stay subscribed** after What matters was left. It now ends on any newer choice (selection revision, checks, scope, the open conversation, the feed's moves, place and open row, the list's key, leaving What matters), through the app's, the feed's and Today's stores, all dropped at once.
4. **Dropping rows was quadratic** (a scan of the rows per id): 10,000 rows took about 400 ms in Codex's probe. It builds a set once.

Round two (2 points, taken, each with a unit test that fails without it):

1. **The keys put on another row after the action** (Tab) changed the place without a move, so Undo pulled the keys back. A new place counts as a feed move.
2. **Checks restored before their row came back** were pruned by the next stale answer, and that write ended the wait, so neither came back. In What matters the checks now come back with the row.

## Perf

No new reads: the target is the feed's place, a store read at a key press; the rows that leave are a filter over the feed's rows (bounded as the feed is). The wait is a store subscription that ends at the row, a move, or three answers; no timer.

## Out of scope

- Archive ending a task. Plan 204 decided it doesn't; the snack says Archived and the row stays.
- A cursor drawn on a row nothing has focused (What matters opens with nothing chosen; j or Tab picks the first).
- The palette with nothing open still hides the conversation actions (its availability reads the open conversation), as before.
- `hand-to.spec`'s palette scenario flakes under parallel load with or without this change (1 in 16 repeats before it, 2 in 16 after; passes alone).
