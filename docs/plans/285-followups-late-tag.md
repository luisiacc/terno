# 285: Follow-ups says which rows are late

## Request (verbatim)

> we have followups sometimes, and it says 1 because one of them was overdue, but there was no way to tell which one of the
> followup items were overdue thru the ui, we should have like a unread marker for those in this particular view only, i'm
> not saying they should be marked as unread, but in this view, they should have the unread marker so the user knows which
> ones are actually the ones that we are saying they need to attend

## Owner revision (after the first build)

> hmm i'm thinking maybe not do the same 'unread', because they will expect to dissappear when they view it, so no, lets
> have a small badge for the ones that are represented in the number, like 'due' or something like that, what do yo uthink

The dot stays unread's everywhere. A row the sidebar's number counts says **Late** instead, before the date with the
row's other words (Spam, Trash, Opened), in every layout. Its look: the owner picked C of six mockups (an outlined box,
the bare word, a soft pill, a status dot and word, the date in the late ink with a clock, "3 days late" in the date's
place): BoardUI's Badge as a soft pill, no edge, on a 10% wash of the late line's ink (`draft-foreground`). Its words are
a new derived token, `late-ink`: that ink stepped toward the row's until it holds AA on the wash over each of a row's
fills (the ink itself is held only to the bare fills: 3.8–4.46 on the wash in seven palettes). Four pairs in
`CONTRAST_PAIRS`. The token takes the generated themes' CSS past its 11 KB gzip guard (11 245 → 11 364 bytes); the guard
is 11.5 KB now. "Late", not "Due": the number's description already says "N late" and the card "Was
due …". Hidden from a screen reader as those words are; the row's states say "late" once (`list.row.late`). New key
`list.late` (en "Late", es "Atrasada", the word a screen reader hears for the row, `list.row.late`). The Design section below is the first build's; where it says
dot, read the tag.

## What exists

- The sidebar's Follow-ups number is `useFollowups.due` (`lib/followups.ts` `applyFollowups`): the threads with a row in
  state `due`, a promise of theirs only once `owedLate` (plan 280: firm, dated, no notice hint). Its description says
  "N late" (`sidebar.count.late`).
- In the Follow-ups list (`s.followups`) a row's late state shows only in its preview line's ink (`text-draft-foreground`,
  `useOwed`) and its date. A design with no preview line (plan 187, `previewLines === 0`, the owner's screenshot) shows
  neither line nor ink: nothing tells the counted row from the rest.
- `ThreadRowView` draws one mark on the marks' column: the unread dot (`row-unread-dot`, `bg-unread`), or a checked row's
  check; in a classic List row with the pointer checkbox, the dot sits in `row-pick-slot`.

## Design

In the Follow-ups list, and only there, the dot means "counted": a row gets it when the thread has a follow-up the sidebar's
number counts, and no other row has one, read or unread. The number beside Follow-ups and the dots in the list then match,
as the Inbox's number and its dots do. The thread is not marked unread; its unread state still shows by the sender's and
subject's weight and the date's ink (the dot was never its only cue, plan 158).

- One rule for the count and the dot: `countsLate(row)` in `lib/followups.ts` (`state === "due"`, and for a promise of
  theirs `owedLate`); `applyFollowups` counts with it.
- `ThreadRow` reads one boolean (`useFollowups` selector, only in the Follow-ups list; elsewhere `thread.unread`) and passes
  it to `ThreadRowView` as `dotted`; the view draws the dot (both places it does) from `dotted ?? thread.unread`. Plan 98's
  preview passes nothing and keeps the unread dot.
- A screen reader hears the same: in Follow-ups a dotted row says "late" among its states (after "unread" where it is), the
  word the sidebar's description uses. New key `list.row.late` (en "late", es "atrasado").
- Nothing changes on the Inbox's top, What matters, People or any other list.

## Tests

- e2e `followups.spec.ts`, plan 280's test: its tentative thread is ingested unread; in Follow-ups the late firm row has
  `row-unread-dot` and says "late" to a screen reader, the unread tentative row has no dot (still `data-unread`), and the
  number of dots equals the sidebar's count.
- Unit: `countsLate` (a due promise, a pending one, a late firm promise of theirs, a hedged one, one with a notice hint).

## Perf

One boolean selector per row, active only in the Follow-ups list: a row re-renders only when its own answer flips. No new
query, no backend change.

## Out of scope

- The follow-up line on a design with no preview line (it would need the subject line to give way; a separate question).
- Marking anything unread, or the Inbox's top.

## Revisions after the Codex review

1. The dot follows the list on screen, not where the app is going: `followupsOfKey(itemsKey)` (its own key, the query
   excluded), so the old list's rows keep their dots until the new rows come, as `iconsAllowedForList` does.
2. One set for both: `applyFollowups` builds `late` (thread ids with a row `countsLate`) and `due` is its size; a row reads
   `late.has(id)`, so only a row whose answer flips re-renders.
3. Any counted row marks the thread, not only the one that speaks for it (a thread whose most urgent row is quiet but
   another is late is dotted and counted once): unit-tested.
4. The e2e names rows by their subject, checks the accessible name ("late" without "unread", and the other way), the exact
   count (2) beside the sidebar's, the unread row's dot back in the Inbox, and List's slot path (the wide-list test).
5. Hover and selection hide this dot as they hide the unread dot (the check takes its place): the number and the dots
   agree at rest, as the Inbox's do. The number updates from the snapshot and the rows from their reload, so they agree
   once the list settles.
6. With no preview line (the owner's design) unread shows by the sender's weight and the date's ink, not the subject's.

## What the Codex code review changed

- An IMAP folder named `followups` sits in the key where the Follow-ups flag does: `followupsOfKey` also asks for no
  account (a folder is always an account's; Follow-ups never is, `navigate`). Unit test for the folder's key.
- Not taken: an e2e that holds the Inbox's answer to see the outgoing Follow-ups rows keep their dots. The gate reads the
  rows' own key (`itemsKey`), as sender icons do, and the e2e fixtures have no way to hold one RPC's answer.

## What the Codex code review of the tag changed

- Spanish showed "Atrasado" while a screen reader said "atrasada": one word, "Atrasada".
- The e2e checks the pill is visible (on the open row too) and that "late" is said once.
- The contrast pairs include the pane (the list's own fill) and the open row.
- Not taken: a compact row at the narrowest list with six categories and the Spanish pill can push the date past the
  edge (rare, and the date's group already holds every dot); a custom theme whose translucent selection sits differently
  over the pane than over the background (the gate composites every translucent fill over the background, for all pairs).
