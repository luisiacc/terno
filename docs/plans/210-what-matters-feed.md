# Plan 210: What matters as a feed, with its history

- **Status:** built on `t3/what-matters-ui-variants` after the owner's answers (below). "Owner's answers" and "The design as built" override the sections before them, and the revisions where they differ.
- **Builds on:** plan 204 (dated items, Missed, Coming up, the briefing B and its fixes), plan 145 (Needs you, the digest), plan 142 (your promises), plan 87 (reminders), plan 17 (who is a person), plan 166 (Not a newsletter).
- **Takes from the plans plan 204 reserved:** 205's name ("What matters") and its Earlier tab, which becomes the history below the open part (no tab); 207's first screen stays 207's (below). 206 (removal rules, the user's own words) is untouched.

## The request

After the panel picked the briefing (B), the owner:

> also that would be no longer a 'today' viw, it would be a feed and a historic fee, so it also would not be built once every day but every item should be there when it arrives in the inbox, that way it would actually replacethe default inbox view for some people.

Asked which mail gets a line:

> i like the 'every email' but things that are actually mattering for users like the things that currently go into that view, so maybe tasks and people only, reminders, we can't have every email be there otherwise they might as well just use the  inbox, this would be for things that matter, not for any shit, newsletters are  not things that matter for example, we could have a separate  small section for them like we do on the main branch.

Asked what Done does: **"Moves into history"**: it leaves the top and stays further down, newest first, marked done in a quiet style; Undo puts it back on top.

## What exists

- **The briefing (plan 204, the UI experiment):** `?wm=brief` (or Settings → Dev) draws Today as a feed: hairline headings, one sentence an item (`todaySentence`), when in a right-hand column (`todayWhen`), Done and Later in words, the email opening on the right and closing with Esc, the X or a second click. It draws the list's own rows (`useList`), from `today.list`, flattened by `flattenToday`; j/k, D, the right-click menu and Undo are the list's.
- **What Today holds (`TodayService.places`, `packages/backend/src/today.ts`):** Missed, Deadlines, Needs you, Plans, Reminders, Coming up (behind a toggle). Needs you: a person's ask (a dated item of kind `ask`), your promises due with no day, nudges, then waiting conversations (`store.today.waitingPage`: the `needsYou` rule over the newest `NEEDS_WALK` threads with `waiting_since`, narrowed by `stillWaiting`). One thread, one row. Live already: the dated reader's writes, an act, the clock (`armDated`) and mailbox changes send `todayChanged`, and the list reloads.
- **What's closed:** a dated item done, dismissed (Not a task), settled by later mail, or retired as `expired` (`retire()`: a Plan ended, a deadline past Missed's week), its `closed_at` set, kept 90 days (`DATED_CLOSED_KEEP_MS`) then pruned; a promise done or dismissed, its `closed_at` set, kept `FOLLOWUP_CLOSED_KEEP_MS`. Every act has an exact Undo (snapshots).
- **Automated mail:** the digest row at the list's end (`digestRow`): with the digest on, the day's AI digest (prepared once a day, plan 145); with it off, what's automated, live and unsorted, never sent to a model.
- **The first screen:** nothing yet (plan 207).

## Design

### 1. What gets a line

Exactly what What matters holds now, live, plus its history:

- **Tasks:** dated items (bills, renewals, expiries, requests with a day, alerts, Plans, a person's ask) and your own promises.
- **People:** a conversation **waiting on your answer**, by the `needsYou` rule (a conversation you've written in, or the one new conversation from someone you write to), as now. "A person" is plan 17's `senderIsPerson` (`threads.person`: the newest inbound message is from a person), which `waiting_since` already requires.
  - **Only those not yet answered get a line in the open part.** An answered conversation needs nothing from you; keeping it up there is the Inbox again (the owner: "we can't have every email be there"). Once you answer, it moves to the history as **Answered**, so a conversation that had a line keeps one.
  - **Not widened to strangers.** Plan 145's panel read found that "a person" holds any plain address and on real mail most first contacts from unknown plain addresses were a bank's or a service's notices; the rule's "someone you write to" is what kept them out. A first message from a stranger stays in the Inbox. *For the owner:* letting strangers in (a quiet group, uncounted) is the step that makes the feed replace the Inbox for people who get new clients by mail; it's left out here until the panel says how noisy it is.
- **Reminders** due by the end of today, as now.
- **Never** newsletters, notifications or automated mail: they're the **automated section**, one quiet row (the digest row, as on main), between the open part and the history.

### 2. Live, not built once a day

Every line is there when its mail has been read, as Today already is: a waiting conversation the moment the mailbox's facts mark it (ingest, or the background facts slice for older mail); a dated item when the dated reader has read its message (a request to the provider: seconds when it's idle, a minute's hold after a provider failure, plan 204 §3); a promise when follow-ups reads your sent mail. The list reloads on `todayChanged`, as now. Nothing is prepared once a day except the AI digest's lines, which stay plan 145's (today's newsletters, one request, only with the digest on); with the digest off the automated section is live and never read by a model.

### 3. Order

1. **The open part,** by urgency, in this branch's groups: Missed, Deadlines, Needs you, Plans, Reminders, Coming up (closed behind its toggle). *Alignment:* plan 204's eighth round on `t3/what-matters-204` is regrouping these as Missed, Today, Needs you, Soon; when that lands the feed takes its groups unchanged (the feed draws whatever `today.list` gives, by `TODAY_GROUP_ORDER`).
2. **The automated section:** the digest row.
3. **The history,** under a heading "Earlier", newest first: one line per conversation that isn't in the open part, at its newest closing:
   - a dated item **Done**, **Not a task**, **Settled** (by later mail) or **Over** (retired: a Plan that ended, a deadline left past Missed's week), at its `closed_at`;
   - a promise of yours **Done** or **Not a promise**, at its `closed_at`;
   - a conversation **Answered**, at its last message (yours): `person = 1`, `has_sent = 1`, not waiting, not in Spam or Trash.
   - **How far back:** 90 days (the closed rows' keep, `DATED_CLOSED_KEEP_MS`; answered conversations to the same day), and at most **300 lines** (`HISTORY_MAX`), paged to the renderer 50 at a time (`HISTORY_PAGE`) as the list's pages are. Past that, the Inbox and search have it.

### 4. Acting on a line

- **Done** and **Not a task** on an open line: its row leaves the open part at once (as now), the snack says so with Undo, and the reload shows it at the top of the history, in the quiet style (muted words, the column saying "Done", "Not a task" with its day). **Undo** restores the exact item (plan 204's snapshots) and the reload puts it back on top.
- **Later** keeps it open (it moves within the open part or to Coming up), as now.
- **A history line** opens its conversation as any line; it has no Done or Later (it's done); its right-click menu is the conversation's. Reopening a done item isn't offered beyond Undo (out of scope).
- j/k walk the whole feed, open part and history.

### 5. The name and the count

- **What matters** ("Lo importante"): the sidebar's entry, the feed's title, the palette. Not "Today" any more: the history and Coming up aren't today's.
- **The count** is unchanged: `TODAY_COUNTED` (Missed, Deadlines, Needs you; plan 204 §7). Plans, Reminders, Coming up, held rows, the automated section and the history are never counted.

### 6. The first screen

Plan 207's ("Open at launch" from Inbox's or What matters' right-click). This plan makes the feed fit to be one (it holds people and the history); building the setting stays 207's.

### 7. Data and reads

No schema change. Three new bounded reads, each in both stores with conformance:

- `dated.closed({ since, limit })`: closed items (`state <> 'open'`), `closed_at >= since`, newest first. The table holds at most 1,000 open rows plus 90 days of closed ones (pruned), so this is a scan of a bounded table, not of the mailbox.
- `followups.closed({ since, limit })`: closed promises (`kind = 'promise'`, done or dismissed), newest first, the same way bounded.
- `today.answeredPage({ since, limit })`: answered person conversations, newest first. SQLite walks `threads_people` (`WHERE person = 1`, by `last_date DESC`, `has_sent` covered) and stops at `limit` or `since`; IndexedDB walks its `people` order the same way.

`TodayService.history(now)` merges the three by time, newest first, one line per thread (its newest closing), leaves out threads in the open part and in Spam or Trash, caps at `HISTORY_MAX`, and is cached until `changed()` or `touched()`. RPC: `today.list({ heldIds, history: true })` returns the open part as now plus `history: { items, next }` (the first page); `today.history({ after, limit })` the pages after it. The renderer asks for the history only when What matters is drawn as the feed; the list look stays as it is.

### 8. Copy (en, es)

"What matters" / "Lo importante"; "Earlier" / "Antes"; the column's "Done {day}" / "Hecho el {day}", "Not a task" / "No era tarea", "Settled" / "Resuelto", "Over" / "Pasó", "Answered {day}" / "Respondido el {day}"; an answered line's sentence "You answered {name} about “{subject}”." / "Le respondiste a {name} sobre «{subject}».".

## Tests

- **Store conformance (both stores):** `dated.closed` (states, order, `since`, `limit`, open rows never), `followups.closed` (promises only), `today.answeredPage` (person, sent, not waiting, Spam and Trash out, order, `since`, `limit`).
- **Backend:** `history` merges by time, one line per thread at its newest closing, leaves out the open part, caps; Done moves a line from the open part to the top of the history and Undo moves it back; a reply moves a waiting conversation to Answered.
- **Web units:** the history's sentence and column (en, es); `flattenToday` with a history page, and a page appended.
- **E2E (`what-matters-feed.spec.ts`):** the open part and the history under "Earlier"; Done → the line on top of the history in the quiet style → Undo → back on top of the open part; a new waiting conversation arriving while the feed is shown; the automated section's row; axe light and dark.
- **Perf:** the history read at 50k threads in both stores (the Today perf gate's mailbox), with 300 answered conversations and closed rows at their bounds.

## Performance

No lazy loading; the feed is virtualized as now. The history's three reads are bounded (by the tables' keeps and by `limit`), indexed where they touch threads, cached between changes, and paged to the renderer. The open part's reads are unchanged.

## Out of scope

Strangers' first messages (see §1, for the owner); plan 206's removal rules and the user's own words; plan 207's first-screen setting; reopening a done item other than by Undo; the list look getting the history; notifications.

## Revisions after the Codex review

Codex (read-only, `/tmp/terno-scratch/p204/ui-variants/critique-210.full.out`) raised 12 points. All are taken; points 2, 3 and 6 are why this plan stops here.

1. **"Not waiting" isn't "answered."** True: `waitingSince` is null too when their newest message only Cc'd you or was answered elsewhere, and `has_sent` says you wrote once, not that the last message is your reply. Answered needs its own fact: the moment of your reply after their latest inbound message, from a sent message that isn't a draft or a failed send. Nothing stores that now (owner's section, B). Nor can the stores say a conversation ever had a line in What matters, so Answered would be "person conversations whose newest message is your reply, within the window", without claiming each once had a line.
2. **The closed rows have no count bound.** True: the 1,000 cap is on open rows; the closed set can grow without bound inside 90 days, and neither table has an index by closing time. Taken: `dated_items(closed_at DESC, id DESC) WHERE state <> 'open'` and `followups(closed_at DESC, id DESC) WHERE kind = 'promise' AND state IN ('done','dismissed')` in SQLite (a shape-only migration), and IndexedDB indexes on the same keys (a version bump). "No schema change" is withdrawn.
3. **The answered read isn't indexed by answers.** True: `threads_people` covers `has_sent`, not `waiting_since` nor the reply, so finding few answers walks every recent person conversation, and IndexedDB's people order can rebuild synchronously. Taken: an answered order needs a stored column with its own index (owner's section, B).
4. **Per-source limits can't guarantee distinct lines.** Taken: each source is read by its index with a continuation, refilled until `HISTORY_MAX` distinct eligible threads or the window's end; ties by time, then kind (an item, a promise, an answer), then id; a thread's newest closing wins; a test with duplicates across a source's page boundary.
5. **A cursor needs a consistency contract.** Taken by not paging across requests: the history comes whole (at most `HISTORY_MAX`, now 200) in the same `today.list` answer as the open part, from the same read, so an act or new mail between pages can't skip or repeat a line. The window's start is fixed per answer (now less 90 days), and the cache is keyed by its day as well as the generations, so time passing re-reads it.
6. **Paging needs a renderer refactor.** True: `fetchPage` refuses Today's cursors, `flattenToday` replaces every map, the feed never calls `loadMore`, `listKey()` doesn't hold the look and `setWmLook` doesn't reload. With 5 (no paging) only the last two remain, and they fit: the look joins Today's list key when it's the feed, and switching it reloads. A history past `HISTORY_MAX` needs Today's state to take appended pages (owner's section, C).
7. **Done doesn't always move a conversation into history.** True: Done closes the shown item, and the conversation's next item, promise or reminder may claim the row. Taken: Done closes exactly the shown item; the conversation goes to the history only when nothing open claims it; Undo restores the item's snapshot and the reload places it by the rules then (no promise of "on top" beyond that).
8. **Held rows and history.** Taken: one placement rule, open, else held (the selection keeps it in its group), else history; a held row is never also a history line; tests for an open row and a checked row becoming history.
9. **Lifecycles with no history source.** Taken, narrowing the history: dated items by state and `closed_reason` (done; dismissed as Not a task, or Over when its reason is `expired`; settled); promises done or dismissed. Not in the history: an overdue promise past Missed's week (still open, hidden by `promiseOver`), nudges (others' replies, not yours to finish), reminders (deleted when they've gone off).
10. **The same gates on every read.** Taken: the history goes through the open part's gate (`aiFeaturesAvailable`, the dated setting), `withoutUntrusted` for items, Spam and Trash out, merged threads at their surviving id (a merge moves the rows), account removal by cascade, Clear AI data empties it (the dated generation); a test each.
11. **The count.** Corrected in §5: `TODAY_COUNTED` is Missed, Deadlines and Needs you; a test asserts the history, Plans, Reminders, Coming up and held rows don't move it.
12. **Gates.** Taken: the feed's render counts in the UI perf gate, the history read in the Today perf gate at 50k in both stores, `pnpm test:all` (a migration and new store reads), and `pnpm ui:rate` and `ui:gate` before the feed is the default look.

## What needs the owner before building

The feed as asked doesn't fit the code as it is without these. Each is a decision:

- **A. A schema change.** Closed-order indexes on `dated_items` and `followups`, both stores (revision 2). Shape-only, within the migration budget; it brings `pnpm test:all` into this series.
- **B. "Answered" needs a new stored fact (a refactor of the facts pipeline).** A conversation's answered moment (`answered_at`: your reply after their latest inbound message, never a draft nor a failed send), kept with `person` and `waiting_since` at ingest, at send and in the background facts slice, indexed, in both stores, with a backfill slice for existing mail (plan 112: the migration only adds the column). Without it the history can't hold answered conversations correctly or cheaply (revisions 1 and 3). *Option:* build the history without Answered first: Done, Not a task, Settled, Over.
- **C. A history past 200 lines needs Today's renderer state to take pages (a refactor of `flattenToday` and the list's Today branch):** its maps are rebuilt whole on each answer; pages need them split into the open part's and the history's, with cursors that survive an act (revision 6). *Option:* cap the history at 200 lines (about a busy month) and leave the rest to the Inbox and search.
- **D. Strangers.** Whether a first message from someone you've never written to gets a line (§1); plan 145's panel found most such mail on real mailboxes was a bank's or a service's.

With A, and the options for B (no Answered yet) and C (200 lines), the rest fits the code as it is: one `today.list` answer carrying the history, the feed drawing it under "Earlier", Done moving a line there when nothing else claims its conversation.

## Owner's answers (2026-11-14)

- **A.** "Yes, add the indexes"
- **B.** "Ship without it first"
- **C.** "90 days, i should also be able to show more as i scroll to see more if they were in the past and they are already generated items in the feed"
- **D.** "Only if they ask you something"

So: the closed-time indexes in both stores; no answered fact (an answered conversation leaves the open part as now, and isn't in the history); the history reaches back 90 days in pages as you scroll, no line cap (C replaces revision 5's 200 lines and its "no paging"); a stranger gets a line only through an ask (a dated item of kind `ask`, which the dated reader already writes for a person's question), never for a first message alone.

## The design as built

### The history's lines

A line is a **closing** of a conversation's item: a dated item done, not a task (`dismissed`), settled, or over (`dismissed` with `closed_reason = 'expired'`), or a promise of yours done or not a promise, closed in the last 90 days (`DATED_CLOSED_KEEP_MS`, `FOLLOWUP_CLOSED_KEEP_MS`: what's kept). **One line per conversation, at its newest closing** across both tables; a conversation in the open part, held there by the selection, or in Spam or Trash has none; an item from an untrusted sender is left out as in the open part (`withoutUntrusted`). Whether a closing is a line depends only on the data, never on what was paged before.

### The order and the key

Newest first by the key `(at, source, id)`: `at` the closing time; at the same time a dated item before a promise (`source` 0, 1); then the higher id first. `HistoryKey = { at, src, id }`. Each table is read by its new index in that order (`closedPage({ since, after, limit })`, strictly after a key), and a conversation's newest closing by its thread index (`newestClosed(threadIds, since)`).

### Pages, and why none repeats or skips a line

- `today.list({ heldIds, history })`: with `history` (asked only when What matters is drawn as the feed), the open part as before and the history from its top: the first page (`HISTORY_PAGE`, 40 lines), or down to and including `through`, the last line the renderer had (a reload keeps the depth that was loaded).
- `today.history({ after, limit })`: the lines strictly after `after`, in the key's order.
- The backend walks the two indexed reads merged by the key, skipping a closing that isn't its conversation's newest, until `limit` lines or the window's end; `next` is the last line's key, or null at the end.
- Pages are keyset, so between two requests: an item closed meanwhile is newer than any cursor and lands at the top (the reload that `todayChanged` sends shows it); one reopened (Undo) leaves the history (its conversation is open again, and its closing is gone) and its conversation's previous closing, if any, takes its place in key order; nothing already passed is shown again, and nothing after the cursor is skipped. The reload fetches the open part and the history through the same key, so a page's lines are replaced whole, never patched.
- The renderer keeps the history's key with the list: Today's state holds the open part's maps and the history's separately (`flattenToday` for the first answer, `appendHistory` for a page), the list's cursor carries the key, and the feed asks for the next page when its last rows are near (the list's `loadMore`, as the Inbox's). Today's list key includes the look, and switching the look reloads.

### Drawing it

Under a heading "Earlier" ("Antes"), after the automated section: the line's words as the open part says them ("Pay $187.42 for the electricity bill.", "You said you'd send Jess the deck."), quiet (the muted ink, regular weight), and in the right-hand column what happened and when: "Done today", "Not a task Wed", "Settled Nov 2", "Over yesterday" (es "Hecho hoy", "No era tarea el mié", "Resuelto el 2 nov", "Pasó ayer"). It opens its conversation as any line; it has no Done or Later; the right-click menu is the conversation's; j/k walk into it. The chat look gets the same lines under "N earlier".

### Done, Undo

Done (or Not a task) closes the shown item; its row leaves at once as now; the reload puts the conversation at the top of the history when nothing open claims it. Undo restores the item's snapshot; the conversation is open again, so it leaves the history and is placed by the open part's rules.

### Name

"What matters" / "Lo importante" for the sidebar, the title and the palette (`today.title`); the count unchanged.

## What the code review changed

**Round 1** (Codex, read-only, `/tmp/terno-scratch/p204/ui-variants/review-210-1.out`): 7 findings, all fixed, each with a test that fails without it.

1. **Back from the Inbox, a deep history lost the Inbox's conversations.** A history page was deduplicated against the list on screen (the Inbox's rows) while the window was being restored, and its cursor moved past what it dropped. Pages are now joined against the window being built, never the one shown (e2e: a deep line open, the Inbox and back, all sixty lines in order, half of them Inbox conversations).
2. **A page the list dropped still changed Today's maps.** Today's answer and a history page now publish their maps in the commit that shows their rows (`todayAnswer(…).publish`, `publishHistory`), so a late page, or a reload a newer one replaced, changes nothing (`today-history-paging.test.ts`, `today.test.ts`).
3. **A reload whose loaded lines had all left ended the history.** Down to a line with nothing left above it, the answer's continuation is that line, never null (`today-history.test.ts`).
4. **IndexedDB sorted every closed row for each page.** A closing-time order in memory (`ClosedOrder`, as `ThreadOrder` is for threads), kept as rows change and built once; a page is a binary search and a walk. The perf gate now pages through 20,000 closed rows (both stores, first and deep pages under half a millisecond).
5. **A reload that waited while a page went deeper shrank the history back.** A reload compares how many history pages the list took while it waited and asks again, as deep (`today-history-paging.test.ts`).
6. **SQLite's deep page walked the newer closings again.** The key is a row value, `(closed_at, id) < (?, ?)`, which the index seeks (`history-plan.test.ts` asserts the plan).
7. **A long walk past left-out rows held the event loop.** The walk gives the turn back between reads within the backend's slice budget (`today-history.test.ts`).

