# Plan 210: What matters as a feed, with its history

- **Status:** plan, for the Codex critique. Built on `t3/what-matters-ui-variants` (plan 204's briefing, "the UI experiment").
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
- **The count** is unchanged: the open part's counted groups (Missed, Deadlines, Needs you, Plans; plan 204 §7). History and the automated section are never counted.

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
