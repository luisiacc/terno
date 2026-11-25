# Plan 273: with What matters first, a notification is for what What matters counts

## The request

> i just received a notification here on my local nighntly installation for this email, when my default view is 'what
> matters' i should have not received this notification for the linkedin alert since it doesn't show on the 'what matters'
>
> debug this and investigate then fix it

(The screenshot: "LinkedIn Job Alerts", jobalerts-noreply@linkedin.com, "Pasito is hiring a Fullstack Engineer", in the
Inbox, and not in What matters.)

## What happened

The nightly's message (read from a copy of its database) has `gmail_labels = ["IMPORTANT","CATEGORY_UPDATES","INBOX"]`,
`is_bulk = 1` and no `List-Id`, and What matters has no item for it. Plan 41's rule (`importance` in
`packages/core/src/attention.ts`) notifies for mail Gmail marks Important that has no `List-Id` and isn't in Promotions,
Social or Forums; bulk headers don't count against it, on purpose (a security code says Auto-Submitted). So the alert
passed as `"gmail"`.

Plan 207 made the Dock's number follow the first screen (`badgeCount`, `leadScreen`): with What matters first, the badge
is What matters' count. Notifications were left on plan 41's Inbox rule, so with What matters first the app counts one
thing and interrupts for another.

## What exists

- `Attention` (`packages/backend/src/attention.ts`): a primed account's pass hands over the ids it inserted as live mail;
  `screen` reads them back (`store.sync.arrivals`) in chunks and keeps what is `stillNew` and has an `importance`; mail
  whose body hasn't come waits for the account's next pass while a filter reads bodies (`waiting`, `BODY_WAITS`);
  `flush`, after the gather and the gap, reads the queue again and says one notice. `refresh` already reads
  `firstScreen` (for the badge).
- `TodayService` (`packages/backend/src/today.ts`): `withCount` gives the sidebar's number only when What matters is
  available and shown (`setting()`: `available && show`); `counts` is the count projection (`project(…, { count: true })`,
  cached placement), whose rows `todayCounted` counts (Missed, Today and its Waiting on you part). `changed()` is the one
  funnel for "What matters holds something else" (the dated reader's writes, acts, settings, Clear AI data).
- `projectRows` (`packages/core/src/today-projection.ts`) in count mode returns `rows: []` and the counts.
- The dated reader marks live received mail at ingest (`ai_dated_mail`, `arrived_at` = the message's date) when its
  account reads with AI, reads it later, and deletes the mark when it's read (`consume`, or `finish`'s write).
  `store.dated.marks.pendingOn(threadId, before)` says a message of that conversation from before `before` is still to
  be read. A person's mail waiting on you is a Waiting on you row at once (the store's `waitingPage`), no model needed.

## Design

**The rule.** The notification for new mail follows the screen that leads (`leadScreen`), as the badge does:

- **The Inbox leads** (unset, Inbox chosen, or What matters not shown): plan 41's rule, unchanged.
- **What matters leads:** new mail is said when its conversation has a row What matters **counts** (the rows the badge
  counts: Missed, Today, Waiting on you), and is still news (`stillNew`). Gmail's Important label and plan 41's
  importance play no part: What matters already decided who is a person and what needs you. Coming up, a day ahead and
  Plans aren't counted, so a parcel that ships Thursday doesn't interrupt, as it doesn't add to the badge.

One sentence: "With What matters first, Terno notifies you about new mail that What matters counts."

**Mail the reader hasn't read yet waits for it.** A message whose conversation isn't counted yet but which the dated
reader still has to read (`marks.pendingOn(threadId, date + 1)`) waits, as mail whose body hasn't come waits for a body
filter today. It's looked at again each time What matters changes (`TodayService.changed()` → `attention.whatMattersChanged()`),
and said then if its conversation is counted. It's let go quietly once the reader is done with it and nothing counts it,
or after `READING_WAIT_MS` (5 minutes, real elapsed time: a notice later than that isn't news). At most `MAX_IMPORTANT`
wait, newest kept. No timer: an expired one is dropped the next time anything is looked at; nothing waiting, nothing is
read.

**Where it lives.**

- `projectRows` in count mode returns its rows unordered (it built them already; today it drops them), so the count
  projection says which conversations are counted. `todayCounted` decides, as for the counts.
- `TodayService.noticeVerdict(arrivals)`: `null` when What matters isn't available or shown (the Inbox leads, as
  `leadScreen` with `today === undefined`); else `{ counted, reading }`: message ids whose conversation has a counted row
  (one count projection, through the existing placement cache), and of the rest, those still marked for the reader
  (`pendingOn`, one indexed read each, bounded by the chunk).
- `Attention` gets `whatMatters?(arrivals)` (the verdict) in its options; core passes the today service's. `screen` and
  `flush` share one `judge(rows)`: the rule that leads (by `firstScreen`, then the verdict's null), the body wait, the
  reading wait. `flush` judges again (a setting changed, a row done, the reader settled meanwhile). A `firstScreen`
  change in `refresh` drops what waits for the reader (it belonged to the other rule).
- Reminders, follow-ups and the morning brief are unchanged: they are What matters' own and are said as today.

**Copy.** Settings → General → Notifications' hint follows the first screen, as the badge's already does
(`badgeHint`): with What matters leading, "New mail that What matters counts, while Terno is running. …" (desktop) and
the web's form, in `en` and `es`.

## Tests

- `attention.test.ts`: with `firstScreen: "whatMatters"` and a verdict fake: a Gmail-Important automated alert that
  isn't counted says nothing (the reported case); a counted person's mail is said; mail still being read waits and is
  said on `whatMattersChanged()` once counted, or let go when the reader is done and nothing counts it, or after
  `READING_WAIT_MS`; a verdict of `null` (What matters not shown) falls back to plan 41's rule; the Inbox leading never
  asks the verdict; a `firstScreen` change drops the reading waits; flush judges again (counted at the screen, done
  before the flush: nothing).
- `today-projection` unit test: count mode's rows are the counted conversations' and the counts are unchanged.
- `notify.int.test.ts` (through the real backend): What matters first, a Gmail-Important bulk alert in a second pass
  notifies nothing; a person's mail waiting on you notifies once.
- The Today count perf gate (`load.perf.test.ts` / Today's), since `projectRows`' count mode changed.

## Perf and resources

The verdict runs only when there's important-looking news to judge, never on an idle mailbox: one count projection
(cached placement, the same work the sidebar's count does on every change) and at most a chunk of indexed `pendingOn`
reads. `whatMattersChanged()` with nothing waiting returns at once. No timers are added.

## Out of scope

- A row the user's words (plan 249's second reader) bring later: mail is judged by v16's reader and the projection as
  they are; a show rule's row that arrives after the reading wait isn't said.
- Notifying when an existing item becomes due (deadlines notifications: plan 204's later plan).
- Per-account notification choices.

## Revisions after the Codex review

Codex's critique (12 points) changed the design as follows:

1. **The reader's marks are read by message, not by conversation.** `pendingOn(threadId, date + 1)` matched an older or a
   scan mark in the same conversation. A new store read, `dated.marks.among(messageIds)` (both stores, by the key, one
   statement; conformance test), says which of these messages are still marked.
2. **Rechecks are driven by the reader, not by `TodayService.changed()`.** The reader consumes marks on paths that never
   call `changed()` (a hard-gate drop, a reading with nothing to write, a terminal error), and `changed()` also fires on
   the clock (midnight, a deadline moving into Today), which would turn this into deadline notifications. The dated
   reader calls `looked()` after each message it considers; `attention.readerLooked()` re-judges what waits for a reading,
   and returns at once when nothing waits.
3. **No lost notice between the two reads.** The verdict reads the marks first and the projection second: a reading that
   commits in between is in the projection. A look that comes while a judgement is running (before its wait exists) is
   counted (`looks`), and the judgement looks again after it.
4. **Cancellation after the verdict.** `screen`, `flush` and the recheck check the generation (notifications off, stop)
   and the account's epoch (removed) after the verdict's await; `drop()` and `forget()` clear the reader's waits; every
   recheck runs on the screening chain, so two never deliver the same message.
5. **A wait for the reader is judged only by What matters.** If What matters no longer leads when it's looked at again
   (hidden, AI off), it's let go, never re-judged by plan 41's rule. A `firstScreen` change clears the waits at once.
6. Covered by 2: clock-only changes never recheck.
7. **One deadline.** A message that waited for the reader carries `until` (its first wait + `READING_WAIT_MS`) through
   every queue (the reader's, the body's, the notice's); the flush drops it past the deadline, so a notice held by the gap
   can't come late. Mail that never waited for the reader keeps plan 41's bounds alone.
8. **One projection per look.** The screen reads its chunks, keeps what's still news, and asks the verdict once for the
   whole pass; the flush and each recheck ask once.
9. **`projectRows`' count mode keeps `rows: []`.** The counted mail is an opt-in output (`counted: true` →
   `CountedMail { messages, waiting }`), built from the rows `todayCounted` counts in the same pass.
10. **Decided: the message must be what its row stands for.** A counted row stands for a message when one of its dated
    items (a merged row's every member) was read from it, or when its conversation is the one waiting on you. A reminder
    or a promise of yours on the conversation, or an item read from an older message, doesn't make new mail there news.
11. **The integration test proves both rules diverge**, with the fake provider and a scripted model so What matters is
    really offered: Gmail's Important alert says nothing with What matters first and is said with the Inbox first; a
    bill only the reader can place (plan 41 would never say it) waits for its reading and is said once the scripted model
    returns it.
12. **The hint is checked in the renderer**: `first-screen.spec.ts`'s Settings scenario reads the notification hint with
    What matters first and with the Inbox first; screenshots of the group in light and dark were looked at.

Copy, as built: "New mail that needs you in “What matters”, while Terno is running. …" (desktop) and "… while this tab is
open in the background." (web), in `en` and `es` («Correo nuevo que te necesita en «Lo importante»…»), the badge hint's
own words.


## The Codex code review

Eight findings; seven fixed, each with a test that fails without it:

1. **A first-screen change during a verdict** (a `policy` counter bumped by `refresh`): the judgement is made again under
   the screen that leads now. Test: a bill only What matters counts, the Inbox chosen while its verdict is on its way: nothing.
2. **A reader look during a verdict could still lose a notice** (the store can show the mark gone before the cached items
   change). The reader names the message it looked at (`looked(messageId)`); looks are remembered by message (the latest
   `LOOKS_KEPT`), a verdict overtaken by a look at one of its candidates it didn't count is made again (at most three
   times), and a wait added after a look at its own message is looked at again at once. The test's fake verdict now reads
   its answer when asked, so the stale verdict is what the code gets.
4. **Mail that waited for What matters fell back to plan 41's rule** in the notice's gap or a body retry. It's judged by
   What matters alone wherever it is (`waited`). Test: counted, then What matters hidden before its notice: nothing.
5. **A first-screen change during a multi-chunk pass** could drop mail plan 41 had filtered. Every row still news is kept
   for the one judgement (bounded by `MAX_PENDING`).
6. **Trimming the reader's waits on every insert** was quadratic in a big pass: once a batch (`trimReading`).
7. **Any reader look re-ran the projection** while something waited: only a look at a message that waits does now.
   Test: a look at another message reads nothing.
8. **Expired waits could crowd out fresh ones**: the expired go before the bound is applied.

Not taken: #3, mail read elsewhere during the last verdict's few milliseconds is said. That is plan 41's own
read-then-say window (the flush reads, then shows), unchanged here.
