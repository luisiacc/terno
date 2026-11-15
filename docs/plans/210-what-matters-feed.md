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

**Round 2** (`/tmp/terno-scratch/p204/ui-variants/review-210-2.out`): 6 findings, all fixed, each with a test; the last round (the cap is two).

1. **A page still on its way when a reload landed could bring back what the reload took away** (round 1 handled the other order). A Today reload is the history from its top, so it drops any page on its way (`pageSeq`), and the next page continues from its answer (`today-history-paging.test.ts`, both orders).
2. **An untrusted sender's newer item hid an older line on its conversation.** A line is now a conversation's first eligible closing past the page's key, and a conversation is skipped only when it has an eligible closing at or above the key (an untrusted item, never shown, doesn't count) (`today-history.test.ts`).
3. **Back from another mailbox with nothing open, the feed lost its depth and place.** The feed tells the list where it is (`listAnchor`: the first item on screen and how far into it), so coming back pages down to it and shows it again (e2e).
4. **A conversation's newest closing read its every closed row.** SQLite seeks new per-thread indexes (`dated_closed_thread`, `followups_closed_thread`, in v59, which isn't shipped yet), one row each; IndexedDB's order keeps each thread's closings in order too (`history-plan.test.ts`, `closed-order.test.ts`).
5. **IndexedDB's first read sorted everything at once.** The order is built from plain entries now and its cold build is timed in the perf gate after twenty thousand closings at once: 5 ms (under the 8 ms slice); SQLite's 0.5 ms. Bounded by the 90-day keep.
6. **Unread, the order held every change forever.** It tracks nothing while stale, and past 256 changes unread it marks itself stale and lets them go (`closed-order.test.ts`).

Left as it is: an untrusted item newer than a trusted one of the same conversation, both above a page's key, can let the trusted one show once more past the key (only the newest per table is known without reading a conversation's rows); untrusted items are only those stored before plan 204's guard.

## The full run

`pnpm test:all` (E2E_PORT 5421, WEB_PORT 5422; the machine at load 8 from other work): lint, build, typecheck, db-wasm, e2e, ui-perf and startup passed; perf failed only on the crowded first pass and passed alone. What failed:

- **unit, `reader-compose-focus.test`: this series' bug,** fixed: the reader's Close (plan 204's experiment) called its two hooks only in Split (`!page && feedLook(useApp…, useWmLook…)`), so a layout switch changed the hook count. They run on every render now.
- **unit, `open-errors.test` ("a step that fails names itself"), smoke `mailbox.smoke` ("a step that fails…") and web-conformance's OPFS lifecycle ("a step that fails leaves the file at its version", then "Cannot pause VFS" from the file it left open): not this series.** All three re-run the newest migration that creates a table (v57, plan 204's), which recreates its table by rename and so runs twice without failing; `open-errors.test` fails the same with the branch's migrations before v59 (checked).
- **unit, `apps/site` render test** (the site's design list): not this series (no file of it or of the designs touched).

The unit project run again alone after the fix: only the last two of those.

Screenshots for the owner: `/tmp/terno-scratch/p204/panel/shots-feed/<maria|priya>/` (the copies seeded with 50 past bills from made-up billers so the history reaches its second page; screenshot data only).

## Hiding what's finished (the owner, 2026-11-14)

> lets have a setting to hide done things, they might like that to have an inbox-zero feeling, lets have that on settings too, but lets also have it in a gear icon in the top right of the 'what matters' view so they can access it directly there and change it

- **The setting:** `today.finished` (with What matters' others, saved as every setting is), on by default (the owner chose a historic feed). "Show finished items" / "Mostrar lo terminado": "What's done, not a task or past stays under Earlier. Off, only what's left shows." Off: no Earlier and no history read at all (the backend answers `today.list` without one and `today.history` with nothing, and the renderer doesn't ask); Done still takes a line off the top, with its Undo; on again, the list reloads with the history from its top.
- **In Settings:** General → What matters, beside its other rows, and Settings' search finds it (en and es, with "done, history, earlier, inbox zero…").
- **The gear:** on the feed's title row, at its right, a quiet icon-only button (the sidebar's settings glyph, the header's icon size) named "What matters options", with its tooltip; it opens BoardUI's popover with the same switch (its label and line) and "More settings…", which opens Settings at that row. A change applies at once, wherever it's made.
- **Tests:** backend (hidden: no history and neither table's closed rows read; Done still leaves the top; shown again, the history back); e2e (the gear on the title's line and named, its switch hiding Earlier and bringing it back, axe on the popover in both modes, Done and Undo while hidden, More settings opening Settings at the row, which changes it too).

- **Code review** (Codex, `/tmp/terno-scratch/p204/ui-variants/review-210-3.out`): one finding, fixed with a test. With the options open, D, j/k and e reached the mail behind them (D marked the open task Done). The popover's keys are now its own, Escape closing it there, as the AI provenance popover's are (e2e: the four keys with its switch focused leave the open item as it was).
- **After the screenshots:** the gear sits 4 px in, so its glyph's edge is the right-hand column's; Settings' "Show Today" is "Show What matters" ("Mostrar Lo importante"), beside the new row.

## The owner made the feed the only view (2026-11-14)

> ok then lets remove the current version altogheter and focus all efforts on the B variant

The briefing is What matters; the list layout for it and the chat go, with the `?wm=` switch and Settings → Dev's "Today's layout (experiment)". The Inbox and every other list keep the list.

- **Branch.** `t3/what-matters-feed`, from `t3/what-matters-204`, with the UI experiment's and this plan's commits brought over and their conflicts resolved toward 204's newer groups and kinds (Missed / Today / Needs you / Soon / Reminders / Coming up, `todayCounted`, nudges gone, undated alerts, a promise's own Later, the second line's `also`).
- **The feed is the only view** (`app.tsx`: What matters draws `WhatMattersFeed`, else `ThreadList`). Its header's line (`TodayLine`, the count and Coming up's toggle) moved to `components/what-matters/today-line.tsx`; `useFeedCursor` and the feed's focus to `lib/feed-focus.ts`.
- **Removed:** `lib/what-matters-look.ts`; the chat (its notes, dividers, "That's everything for now", `NoteTaskMenu`, `groupLine`, the `whatMatters.look.*`, `whatMatters.group.*`, `feed.end`, `open`, `more` strings); from the list, What matters' headings, its digest row, its section names said by the first row, its header's line and dates offer, its empty state; from the row, a task's line, its due day, a promise's person, `also`, `noDay` (`TodayRowTask`), and `TOP_LABEL`; `useToday.digestAt`. Their tests went with them (`thread-row-marks`' task rows, `what-matters-looks.spec.ts`, the list-look history test); `today-line.test.tsx` moved with the line.
- **What the list did that the feed now does:** the keys come back to the feed where they came back to the rows (`focusRows` and the skip link: the open item, else the one put away, else the first); the digest's page takes the keys when opened from the feed (it looked only for the list's); Esc on the digest's page puts it away as the feed puts away a conversation, back on the digest's item (the list kept the page and gave the keys back, its reader pane being always there; the feed's room is only there while something's open). The digest's item is marked `data-digest`.
- **Tests moved to the feed:** `today.spec.ts` (the digest's flows, Not a newsletter, Archive all, the ways back, Missed, Done from the menu, D, Not a task, Later, Coming up by keyboard, promises, the reader's line, an ask, an alert with no day, Settings), now reading each item's sentence, its column and its tone; `what-matters-feed.spec.ts` takes the briefing's item test (the sentence, the column, who, Done and Later shown and named, Esc, the reader's Close, a second click, D and z, axe). Dropped as list-only: the bulk selection ending at the digest's row, List's one-row header geometry, a row's avatar geometry and its `role=option` names.

## By day, not by kind (the owner, 2026-11-15)

> also i think we should group by day, not by category of 'needs you' or others, appart from the 'missed category' maybe

Asked where things with no date go, the owner answered **"Under Today"**: "They need you now, so they sit in Today with the things due today. Their right column says when they came ("since Wed") so it's clear they aren't due today." Asked about days further ahead, **"Keep them behind the quiet toggle"**: "Missed, Today, Tomorrow and the days within each item's time to act show; later days stay behind the "N coming up" toggle in the header, grouped by day when opened."

This replaces plan 204's seventh-round groups (Missed / Today / Needs you / Soon / Reminders / Coming up).

- **The groups** (`TODAY_GROUP_ORDER` in core, also the claim order: a conversation's row is its first task): **Missed**; **Today**: what's due or happens today, timed first by its time, then the rest (today's untimed items, a person's ask, an undated promise of yours that's due, an alert with no day, what's waiting on you, your reminders due today); **a day of its own** (`day`, carrying its `YYYY-MM-DD`) for each day ahead whose items' time to act has come, timed first by time then the rest; **Coming up** (behind the header's toggle), by day too. A dated alert sits on its own day like anything dated (plan 204 put every alert in Today; the owner's rule is the day). A conversation with a task on a day ahead is that task, not a waiting row in Today (plan 204 §1, as Soon was).
- **Where:** `datedGroupAt` and `promiseGroupAt` return the group and, for a day of its own or Coming up, its day (the item's due day; an item put off past its day, or with no day of its own, the day its Later ends). `datedPlace`, `promisePlace` and every life rule (leads, Missed's week, Later) are unchanged.
- **The count** keeps its meaning: what's in Missed, Today and the days counts, unless the row's own item is an event or a delivery; Coming up and your reminders don't (`todayCounted(group, why)`, which now reads the row's kind, a reminder sitting in Today). The header, the sidebar (both stores' `countWith`) and the morning notice agree, and the count's path still reads no waiting rows and no reminders.
- **At midnight** (`nextTodayChange`): whenever anything shows, midnight is a change, so "Tomorrow" becomes Today's and the next day takes its name, and "since" columns move on.
- **The feed:** a heading per group ("Missed", "Today", then "Tomorrow", a weekday this week, a date beyond: `dayHeading`, the when column's day words, capitalised as headings, en and es); Coming up's items, opened, join their day's heading (timed first by time, then the rest), drawn quietly as Coming up's were; the toggle's count is theirs. The right column: a day's item says its day or time as before; what has no date says "since Wed" (`whatMatters.since`), quietly; a reminder its time. Weight: Missed and Today's dated items strong; what's undated in Today, days ahead and Coming up quiet.
- **History** ("Earlier") stays as built, newest first.
- **Tests:** core (the group and day of every kind: today, tomorrow, a week out, Coming up by day, a Later past its day, an undated alert, an ask, a promise either way; the count's rule with a reminder and a Plan in Today; midnight with only an ask showing); backend (`today.list`'s sections by day and their order, a waiting thread with a task tomorrow under Tomorrow, the header's, the sidebar's and the notice's counts agreeing); both stores' conformance (unchanged `countWith`); renderer (Coming up merged into its days and their order, the held row's group, the toggle's count); `todayWhen` (since, a reminder, the tones by group); e2e (the headings by day, Coming up opening into them).

### What the code review changed (the feed as the only view, by day; Codex, `/tmp/terno-scratch/p204/ui-variants/review-feed-1.out`)

Twelve findings; ten fixed, each with a test that fails without it:

1. **D finished the open item, not the one the keyboard was on** (Tab to another item, D): D in the feed acts on the focused item, else the open one, else the one just put away (`focusedFeedItem`, `doneOnSelected`). e2e.
2. **j/k left the keys on the previous item** (Enter then reopened it): the keys go with the item j/k opened (`followCursor` → `focusFeed`). e2e.
3. **Coming up grouped a postponed item under its own day**: its day is the later of its own and its Later's (`comingUpDay`), dated items and promises alike. Core tests.
5. **Words that change at midnight with nothing dated showing** ("since Wed", "Done today"): the clock wakes at midnight too, once a day (`armClock`). Backend test.
6. **Search shortcuts (/, ⌘F) focused a field the feed doesn't have**: search from What matters goes to the Inbox's list with its field, looking everywhere as always (`focusSearch`). e2e.
7. **Esc inside an HTML mail didn't put the feed's conversation away**: the frame's Esc does what the page's does (`forwardNavKey`). Unit test.
8. **Focus returning to an item scrolled out of the drawn window fell on the first item**: it's scrolled in, then focused (`focusFeed`; the scroller moved to `lib/list-scroller.ts` so focus code reaches it without the list). e2e (the skip link after scrolling to the history's end).
9. **Two items put off to the same day weren't timed first**: a day's rows go by its day, then the timed by time (`byItsDay`). Backend test.
10. **The wide feed left the page without a main landmark**: the list's pane is `main` while the feed has the room alone, as List's is (a `main` on the feed itself failed axe's top-level rule). e2e.
12. **Esc after Tab and Enter brought the ring back on the item**: the feed's own returns of focus clear it (plan 54; `hideFocusRing`). e2e.

Not changed, and why:

- **4. IndexedDB's history order is built in one go on a cold read** (Codex measured 43 ms at 50,000 closings). Closings are what the reader and your promises produced and closed within 90 days: the 1,000-item open bound and the reading rate keep them in the low thousands, and the perf gate holds the cold build to 8 ms at 20,000. Recorded; a sliced build is the fix if real mailboxes ever come near.
- **11. A conversation on two history pages when its newest closing is from a sender untrusted later**: plan 210's known limit (an item stored before the sender guard); very rare, and the line it shows is true.

Also from the run: test:all's two visual baselines (Settings → General, en and es) were updated for plan 210's own rows ("Show What matters", "Show finished items"); the apps/site render test fails as on the base (unrelated); the Today perf gate's "spread: added" was 2.6 ms against 2 under a load of 11 and 1.5 alone.

**Round 2** (`/tmp/terno-scratch/p204/ui-variants/review-feed-2.out`): four findings on the fixes, all fixed with tests:

1. D on an item other than the open one left the keys nowhere, so a second D finished the open conversation: the keys go on to the item after it (else before), as the open one would (e2e).
2. An item drawn in the overscan, past the feed's edge, was focused out of sight: `focusFeed` brings the item into view whether it's drawn or not (unit, `feed-focus.test.ts`).
3. F6 into the feed lost its ring: only the app's answers to a key (Esc, the reader's Close, j/k) clear it; F6 and the skip link keep it (unit).
4. Two timed items put off to the same day went by their original moments: a day's timed rows go by their time of day, in the backend and in the renderer's merge (backend test with a 6:00 PM item due a day before a 1:00 PM one).

Two rounds, the cap.

## The owner's loop on the feed (2026-11-15)

The owner, after round 9: "it looks like round 7 got high scores, lets see what can be used from there to be used on the new feed, looks like some things are worse on the new feed than from round 7, lets do more rounds now focused on the feed, at least 4 iteration rounds of fix and panel review, lets have the learnings from round 7 that made their cores high in certain sections, and lets improve further lets try to reach at least 8 on each score, when finishing a rate and going to make the fixes, lets analyze truly what would make it to advance the scores based on the panels reviews and be thorouh, maybe spawn a fable5.2 agent to give opinion on what needs to be done too."

A Fable 5.2 analysis of rounds 7–9 (`/tmp/terno-scratch/p204/panel/fable-analysis.md`) and this one agree: of round 7 → 9's drop, about 12 points are the reading (prompt v10's list rules lost Sam's progress report, recalled book and grading deadline; "before Monday" read as Monday), 6 the panel's harness (Enron filler attributed to the personas, Theo in the wrong zone, the scripted Not a task on a real high-stakes item), 5 the feed's layout (plans leading the day, no stakes, the narrow state), 5 reviewer variance. The biggest lever on both layouts: one row per conversation hides items the reader found (Theo's keynote, Margaret's book club, Priya's board meeting).

The owner's answers (2026-11-15): keys for Later and Not a task ("Yes, add keys for Later and Not a task"); "Not a task" renamed "Remove"; "Yes, a row per item" (instead of one row per conversation); the filler "Replace it with noise written for each persona"; "Two reviewers per persona, take the median"; the header "'6 today · 8 this week'".

### Iteration 1 (round 10)

- **The panel, honest:** persona-written filler instead of the Enron/Apache corpus (no mail attributed to a persona that they didn't write); Theo in America/Los_Angeles (his mail: SFO, 1550 Bryant St); the walkthrough's Remove on a key trap or a calendar invitation, never a real obligation; the offer screenshots retaken on the feed with a real provider named, and the AI settings shot back beside What matters'; packets list each row's further items and a second Coming up shot reaches its end; persona names match the mailboxes; two reviewers per persona (one Claude, one Codex), the median per category; `score.py` matches items, counts only what's visible (a row or its Also), calendar invitations no longer traps, and the keys gain the items personas reasonably want.
- **Prompt v11:** group mail that requires the reader's group to do something by a day is the reader's (a course's TAs, "doctoral students in years 2–5", a class's families) and a reminder of it too; only an optional call to action isn't; a class trip or game for the reader's child is an event; a person's mail naming the reader's own meeting is an event; "pick up / return by <day>" is a deadline (`expire`/`respond`, not a zero-lead delivery); "before Monday" / "antes del lunes" / "before the 20th" is due the day before; a soft date ("this week", "ideally before") keeps its phrase in the text; a card's "11/26" is the end of November 2026; a mail that replaces what you promised with another thing is a new request, not a move of the promise; the text names the company, account or document the mail names ("the Lumora-Halvorsen MSA", never "the final MSA"). Eval first, five readings each on both models for the cases from the panel's misses and their traps.
- **The feed:** keys for Later and Remove (unused keys, shown in the menu and on hover, only on What matters items like D); "Not a task" → "Remove" everywhere (en, es), the toast "Removed: …"; inside a day, tasks before plans (timed cutoffs, your promises due, people waiting; then plans and deliveries by time, quieter); the automated row never names a person or a sender already on the screen; one sentence on who reads the mail (the provider by name) in What matters' settings and the offer, "less than a cent" for a tiny cost; the second line and Coming up's rows one step stronger in the type and contrast pairs.

### Iteration 2 (round 11): a row per item

The owner's "a row per item" (a refactor: placing, both stores' counts, the feed's cursor and the reader's line key on conversations today), with true duplicates merged (one event from two conversations; one errand read twice; one promise split in two); a promise broken and then re-dated keeps "promised Tue" on its row; a person's request with a far date shows from its arrival; a delivery that needs someone present shows from the day before; one time per row (the reader's zone in the when column, the mail's zone in brackets only when it differs); the header "6 today · 8 this week" and the sidebar badge Missed + Today.

### Iterations 3 and 4

The row's stake from the mail (quoted), renewals saying the decision; the subject as context when it adds words; the narrow state one line per item; Coming up as a real control with no 14-day horizon; one design for the reader's line; natural Spanish; then mute and the preferences box (plan 206), "this looks like a scam", and a second-day capture so reviewers can see it hold up.

#### Revisions after the Codex review of iteration 1

Codex (read-only, `/tmp/terno-scratch/p204/critique-it1.out`) raised 10 points, all taken: (1) the panel never leaves a real key in a database it copies (a memory-backed secret store for the harness, or cleanup on every path); (2) a settlement or a promise's move needs evidence tied to that obligation, a settlement from another conversation is constrained, and adversarial cases quote instructions to settle unrelated items; (3) the eval scores what survives the app's checks, `checkDates` stops collapsing two different untimed requests on one day, and a soft date ("this week") keeps its phrase in the text this iteration (a softer when column waits for iteration 2's rows); (4) one ranking (tasks before plans inside a day) used before each conversation's row is chosen and when the renderer merges Coming up, with the counts tested together in both stores; (5) Remove acts on one item with the existing revision-checked Undo, and its words never suggest the email is deleted ("Removed from What matters"), en and es everywhere the old name appears; (6) the keys are commands in `packages/core/src/keybindings` (not L, R or Delete, which are taken), dispatched through the same targeting as D, with Later opening the existing picker; (7) the panel exports each row's and Also's identity and text, scores what's visible (default and with Coming up open), applies each persona's zone everywhere (reading, relisting, packets, serving, capture), hashes its fixtures and zone in the manifest, freezes the revised keys before v11 runs, and keeps both reviewers' scores beside their median; (8) the privacy sentence names the destination the dated reader's job is routed to (`ai-routing`), not the settings' provider, and "less than a cent" only for a positive estimate under $0.01; (9) the automated row gets a generic second line instead of guessing which senders are already on screen; (10) the stronger secondary text uses certified contrast pairs per state (rest, hover, cursor, selection), and the hover controls fit without covering the Also line.


#### How iteration 1's feed changes were built

On `t3/what-matters-204`, from `e8f55f119`, one commit each:

- **Keys (point 6).** `today.later` on **b** (Gmail's snooze key, which Later is) and `today.remove` on **⇧D** (Done's sibling: D finishes the item, ⇧D takes it off the list) in `packages/core/src/keybindings`. L, R and Delete are the categories', Reply's and Trash's; m stays free for mute (plan 206). Both are character keys: off with single-key shortcuts off, never while typing, writing, or under a dialog or menu. They go through D's own targeting (`keyTarget` in `lib/today-task.ts`: the item the keyboard is on, else the open one, else the one put away; never among several checked, in a scope, on a row with no task, outside What matters or on the digest's page), and the keys go on to the next item as after D. b opens the item's own Later menu (its presets, then Pick a date…) for the task as it was then (`laterMenu`, so a reload while it's open can't move the choice to another item; the act stays revision-checked); where the feed doesn't draw the item (List's page) it opens Later's date picker (`laterPick`). Opening or leaving it moves nothing; while it's open it holds the app's keys (`menuOpen`), as the reader's menus do, and an item that goes takes its menu with it. The keys show in Done's and Later's tooltips, the right-click menu (Remove ⇧D, Later B), the palette ("Later…", "Remove from What matters", found by "not a task" and "dismiss" too) and the shortcuts help.
- **Remove (point 5).** "Not a task" is "Remove" ("Quitar") in the right-click menu, the reader's dated line (its name "Remove from What matters: …"), a promise's card, the palette and the shortcuts help; Earlier says "Removed {day}" ("Quitado el mié") for an item and a promise alike; the toast is "Removed from What matters: …" ("Quitado de Lo importante: …"), never as if the email went; Settings' hint and search words follow. One item, the existing revision-checked Undo.
- **One order inside a day (point 4).** `dayTier` and `inDayOrder` in core: cutoffs and other tasks due (the timed by time, then the rest as they came due), your promises due, people waiting (an ask, then waiting conversations, as they came), your reminders, then plans and deliveries by time. The backend sorts Today's and each day's (and Coming up's) items by it before `dedupe` chooses each conversation's row, so a conversation with a bill and a dinner on one day is the bill (its D, its Done, its count) with the dinner as its Also. A conversation's own items still claim it before its waiting row (revision 3: a waiting thread with only a Plan is the Plan), which is what the stores' `countWith` subtracts, so the header, the sidebar and the morning notice agree (backend test with all four, and a conformance line in both stores); `todayRanked` then gives waiting rows and reminders their tier's place. The feed merges Coming up into its days by the same order and draws Today's plans and deliveries quietly, as a day ahead's. Today keeps the moment order (a Plan still on from last night first), a day ahead the time of day (two put off to it).
- **The automated row (point 9).** Its second line is "Newsletters and notifications" ("Boletines y notificaciones"); its count, contents and page are unchanged; `digestFrom` went with its only use.
- **Who reads the mail (point 8).** `datedReaderLine` (`lib/ai.ts`) names where `routeFor("dated")` sends the dated reader's job, by the same names every disclosure uses (a relay, a server of the user's own or a local kind on another machine by its host): in the offer, "Terno sends each new message's text to OpenAI to find these; nothing else leaves your Mac for them." (on its own line under the offer and its answers), and in the gear's popover and under Settings' What matters group, "To find bills, trips and requests, Terno sends …". On this Mac: "Terno reads each new message's text with Ollama on this Mac …; nothing leaves your Mac." *"For them"* is ours: with Follow-ups or the digest on, other mail does leave for those features, so the bare "nothing else leaves your Mac" wouldn't be true. The 14-day check reads "less than a cent" ("menos de un centavo") only for 0 < usd < 0.01; free, unknown and larger costs as before.
- **Stronger secondary text (point 10).** The second line, "since …", a day ahead's column and Coming up's sentences use `row-preview`, a step stronger than the muted ink and certified on the pane, the hover and the cursor fills (`CONTRAST_PAIRS`); the open item's words are the selection's ink; the history alone stays muted. Sizes stay the scale's (`text-base` sentence, `text-sm` second line): one step of ink, not of size, so the sentence still leads. Done and Later are measured once per render of the feed (`--wm-controls`, one layout read), so the second line ends in an ellipsis before them in either language, wide or beside an open email; they show on focus by `focus-reveal`.
- **Tests.** Unit: the keys' resolve rules (`resolve.test.ts`), b and ⇧D's targeting and the captured Later (`today-task.test.ts`), `dayTier`/`inDayOrder` (`core/today.test.ts`), the renderer's merge and the plans' tone (`state/today.test.ts`, `today-sentence.test.ts`), `datedReaderLine` and the tiny cost (`ai.test.ts`, `dated.test.ts`), Remove's words (en, es). Backend: the mixed conversation, the order in Today and a day ahead, the header, sidebar and notice counts, Done moving the row to the dinner (`dated.test.ts`). E2E: ⇧D and b on the open item (Escape leaves it, d under its menu does nothing, a preset moves it, z), Remove's words and keys in the menu, the reader's line, the ranking and the mixed conversation's D, the tooltips' keys, the second line's end before the controls (en, es, wide and narrow), the privacy sentence in the offer, the gear and Settings, the automated row's line.
- **Screenshots** (light and dark, 1440 and 1100, wide and with an email open, en and es; the days, the gear and the offer): `/private/tmp/claude-501/-Users-Luis-projects-emailclient/7b05aec3-bb42-482b-ac28-c52081b2529f/scratchpad/shots/{en,es}-{1440,1100}-{wide-hover,open,days,options}-{light,dark}.png` and `{en,es}-1440-offer-{light,dark}.png`.

##### What the code review changed (iteration 1's feed)

**Round 1** (Codex, read-only): seven findings, all fixed, each with a test that fails without it.

1. **b on another item, then Pick a date…, lost where the keys go next:** the picker carries the item after it (`laterPick.next`), and its moment moves the keys there as a preset does (`laterFromPicker`; `today-task.test.ts`).
2. **The palette's Later could lose its menu to the palette's closing focus:** the command says it takes focus (`takesFocus`), as Reply does (e2e: the menu still open after the palette has gone).
3. **With Later's menu open and the pointer on it, the controls stayed over the second line:** the line keeps its room while their menu is open (`group-has-[[aria-expanded=true]]`; e2e, en and es).
4. **A feed that opened on items with no controls never measured them:** the first controls drawn measure, once for the language and design the feed says it's in (`measureControls`, `data-controls-key`); the feed measures again when either changes (`feed-controls.test.ts`).
5. **Waiting conversations showing your promises kept their mail's order:** Today's rows take the whole `inDayOrder` after each conversation's row is chosen, so those promises go by their days among yours (backend test).
6. **"Each new message's text … nothing else" left out what the reader also sends:** the sentence says it: "each new message (its text, subject and names, with what it already found there)" (en, es).
7. **On this Mac, "nothing leaves your Mac" read as the app's promise:** "…for them" ("para esto"), as the cloud sentence says it, since another feature may still send mail (en, es).

The Today perf gate's fixture changed with point 4 of the critique: its fifty mixed conversations (a Plan today, a bill on a day ahead, an ask) are now each Today's ask, the Plan its second line, where they were the Plan.
