# Plan 204: What matters, part one: dated items, Missed and Coming up

- **Status:** plan, critiqued by Codex; "Revisions after the Codex review" overrides the sections before it. Not built: waiting for the owner's go-ahead.
- **Builds on:** plan 145 (Today), plan 166 (Needs you as one group, after the owner's second look), plan 162 (Today's header holds the digest), plan 142 (follow-ups: the shape this copies), plan 132 and 131 revision 5 (the new-mail marker), plan 87 (reminders), plan 147 and 150 (one AI gate), plan 157 (summaries on by default where AI runs).
- **Followed by:** plan 205 (the name "What matters", Today and Earlier tabs), plan 206 (taking things out, and the user's own words on what belongs), plan 207 (the first screen). Each works without the next.

## The request

> i want to groom the xisting 'today' view with ai, does it show important things from yesterday for example? i think it could become something where we show truly important things for the user, like things expiring soon, heads up of promises made by email, and other importants things, there are really not that great amount of categories that people actually want to look out for

Then, after a first proposal:

> promises to me should not be tracked, only mines, heads up should be folded in. 2. show under missed 3. no, only for today

> I am thinking on maybe change even the today name because it's not all of it for today. And maybe classify and call it like what matters. And it would be useful to show things for today and then there would be a tab or something to show things from the past. We also would need a way to get things out of those … remove everything from this sender from today or remove all with this subject … let the user tune or personalize what goes in today, like we can give them a box where they write things they want in today, and things they do not want … and we can merge that with our own prompting … I want it to be that they can open that by default and forget about the email.

(The second message was dictated; this is its sense, as the owner confirmed it in the next turn.)

> for n2 i agree with that it should show for the time to act like for due dates, i like the coming up thing. yes and the default is a setting they can choose which anytime, they can right click on inbox or what matters and in the context menu there should be an item to make that or remove it from default, we can have a coming up thing that is subtle

## Decisions (the owner, 2026-11-13)

| Question | Decision | Plan |
|---|---|---|
| Whose promises | **Only the user's own.** Never other people's promises to them (confirms plan 142) | 204 |
| Heads up (payment failed, account locked) | **Folded into Deadlines,** not its own group | 204 |
| A date that passes with nothing done | **Shown under Missed** | 204 |
| The 12-row cap | **Gone.** The main view holds what's for today, all of it | 204 |
| When an item shows | **When it's time to act,** not on its date: a bill due on the 20th shows days before | 204 |
| What's later | **A subtle Coming up** | 204 |
| The name | **What matters** (it isn't all about today) | 205 |
| The past | **A tab** beside today's view | 205 |
| Taking things out | By sender and by kind of mail, so it never fills with noise | 206 |
| The user's own words | A box: what they want there and what they don't, merged with our rules | 206 |
| The first screen | **A setting, changed any time:** right-click Inbox or What matters, "Open at launch" | 207 |
| Reading dates in new mail | **Off by default.** In the future, switching to Pro will ask the user whether What matters should be their first screen | 204, 207 |
| Missed's span | **7 days,** then the Earlier tab | 204, 205 |
| Mail already here | **The offer to check the last 14 days,** with the count and the cost, nothing sent without a yes | 204 |

## What exists

- **Today** (`TodayService.list`, `packages/backend/src/today.ts`): Needs you (one group again since the owner's look at plan 166: due promises, due nudges, then waiting threads through `store.today.waitingPage` and the `needsYou` rule), capped at `TODAY_NEEDS_MAX` (12) with `more`; then Reminders due by the end of today. The digest is Today's header (plan 162), not a row. Each thread appears once, Needs you first (plan 145 revision 5). Held rows keep their place (revision 9).
- **Nothing in Today comes from incoming automated mail.** Plan 145's panel read cut a bank's and a payment processor's notices from Needs you, and the rule now lets in only people. So a renewal, a bill, a trial ending or a flight never reaches Today.
- **The list** (`flattenToday`, `apps/web/src/state/today.ts`): `TodayGroup { kind: "needsYou" | "reminders"; at }`, headings as reserved space (plan 87's trick), rows are ordinary thread rows with `whyLine` in the snippet's place.
- **Follow-ups** (plan 142): `FollowupWorker` reads each sent message once (`ai_sent_mail`), `AiTasks.readSentMail` returns promises with a `quote` and a `due`, `checkSentMail` keeps only what passes local checks (the quote is really in the text, the date parses and makes sense, a label is one it was given), and rows live in `followups` with `open/due/done/dismissed`, `dated`, `act(done|dismiss|later)` with exact Undo, a one-time 30-day scan offer, and one timer (`armFollowups`). A promise's date becomes a 9:00 due time (`followupDue`, `REMIND_MORNING`).
- **The new-mail marker** (`ai_new_mail`, plan 131 revision 5): written in the ingest commit with a flag per consumer (`wants_summary`, `wants_category`); each worker pages it (`store.newMail.page(want)`), consumes its flag, and the row goes when no flag is left. Pruned at 3 days. `markNewMail` already leaves out spam, trash, drafts, sent mail and mail from the user's own addresses.
- **Summaries** read the same new mail, but skip short mail (under 60 words) and the Promotions and Social tabs, and their `date` items are free text. They are not the place for this (see §3).
- **The AI gate** (`aiFeaturesAvailable`, plans 147 and 150): one rule for UI and background jobs. **`AiLimiter`** gives each background task its own daily ceiling.

## Design

### 1. What the main view holds

Today's view becomes these groups, in this order, each thread once (the first group that claims it):

| Group | What | Leaves when |
|---|---|---|
| **Missed** | A dated item or a dated promise of yours whose day has ended, open, from the last 7 days | Done, dismissed, or 7 days pass (then it's the Earlier tab's, plan 205) |
| **Needs you** | As now: replies you owe, your promises due, nudges due | As now |
| **Deadlines** | Something to do by a date, from its time to act: pay, renew or cancel, respond or submit, and heads up (payment failed, account locked, a card or document expiring) | Done, dismissed, settled by later mail, or it moves to Missed |
| **Plans** | Something happening to the user: a flight, a reservation, an appointment, a delivery, from its time to act | It ends. A plan isn't missed: the user probably went |
| **Reminders** | As now | As now |
| **Coming up** | Subtle: one quiet line at the end, "4 coming up · next 2 weeks", that opens in place to show Deadlines and Plans whose time to act is later, muted | When their time to act comes, they move up |

- **No cap.** Every row that's for today shows. The list is virtualized already; Needs you's `waitingPage` walk loses its 12 and keeps `NEEDS_WALK`, and "See all in Inbox" goes, since nothing is held back. On a real mailbox Needs you held 3 (plan 145); Deadlines and Plans are bounded by how much dated mail a person gets.
- **One thread, one row.** Missed, then Deadlines, then Plans, then Needs you: a bill's own thread waiting on a reply is the bill. A thread with two dated items shows the soonest; the next takes its place when that one is done.
- **A promise's day ending** moves it to Missed only if it was dated (`dated`). An undated promise stays in Needs you as now.
- **Coming up** is a closed disclosure (BoardUI's, `packages/ui/BOARDUI.md`), muted ink, never counted in the sidebar. Its rows are ordinary rows too, so j/k reach them once it's open. It remembers open or closed per view (a convenience, `localStorage`).

### 2. The time to act

The model says what kind of thing it is and the date; **when it shows is ours**, from a local table in `@terno/core` (`actAt(kind, dueAt, timed)`), pure and tested across days and DST like `followupDue`:

| Kind | Group | Shows from | Missed after |
|---|---|---|---|
| `pay`: a bill, an invoice, a payment due | Deadlines | 3 days before, 9:00 | its day ends |
| `renew`: a renewal, a trial ending, a subscription to cancel | Deadlines | 7 days before, 9:00 | its day ends |
| `expire`: a card, a document, a password, an account | Deadlines | 7 days before, 9:00 | its day ends |
| `respond`: an RSVP, a form, a signature, a reply by a date | Deadlines | 2 days before, 9:00 | its day ends |
| `alert`: payment failed, account locked or suspended, action required on an account | Deadlines | at once | 3 days after arrival, or its date if it names one |
| `event`: a flight, a reservation, an appointment, a booking | Plans | the day before, 9:00 | never (gone when it ends) |
| `delivery`: a parcel arriving, a pickup | Plans | its day, 0:00 | never |

- A date in the past when the mail arrives isn't stored. A date more than a year out isn't either.
- **No time of day:** due at the end of the day (Missed the next morning), sorted as 9:00. **A time:** sorted by it, and a Plan ends 2 hours after it.
- **Ordering inside a group:** by due time, soonest first; Missed by how late, most recent first.

### 3. Reading incoming mail

**A third consumer of the new-mail marker,** not a part of the summary. Summaries skip short mail and Promotions, and "Your appointment is tomorrow at 9" is short; the v7 summary prompt was just tuned on the eval and the panel (plan 202), and new fields would put that at risk; and a summary is about the whole conversation where this is about one message's dates. So:

- `ai_new_mail` gains `wants_dated` (shape-only migration, both stores). `markNewMail` sets it when the feature is on (`NewMailWants.dated`), so the ingest commit stays the one place mail is marked.
- **`DatedWorker`** (`packages/backend/src/dated.ts`) in `FollowupWorker`'s shape: pages `newMail.page("dated")`, plan 132 revision 4's states and failure table, a minute's hold after a provider failure, no timers when empty, Clear AI data aborts and a generation refuses late writes.
- **Read first, locally, and skipped:** Spam and Trash (checked again before the request and before the write, plan 132's three checks; the owner's rule that Spam reaches no AI), Social and Promotions tabs, a digest candidate (the newsletter rule, `digestFacts`), mail from a sender on plan 166's "Not a newsletter" list stays readable (it's a correction about the digest, not about importance), and mail with **no time cue**: `hasTimeCue(text, subject)` in `@terno/core`, en and es, pure: a date in any common form, a weekday, "today", "tomorrow", "mañana", "due", "expires", "vence", "renew", "trial", "flight", "vuelo", "appointment", "cita", "delivery", "entrega", "action required", "suspended" and their family. A message from a person is read whatever its cues, since "by Thursday" is easy to miss. The cue list is a cost filter, not a judgment: it errs towards reading.
- **`AiTasks.readDates`,** structured output through the ladder, `effort: low`, frozen and versioned prompt (`DATED_PROMPT_VERSION`), mail inside delimited blocks as material, no tools:

```ts
interface DatedInput {
  text: string;              // the message's visible text (plan 36), quotes stripped, ≤ 1,500 tokens
  subject: string;
  from: { name: string; automated: boolean };      // never an address
  receivedAt: string;        // weekday, date and time, in the user's zone
  open: { label: string; kind: DatedKind; text: string }[]; // ≤ 10: this thread's and this sender's open items, to settle
  language: string;          // the app's: `text` is for the reader
}
interface DatedResult {
  items: { kind: DatedKind; text: string; quote: string; due: string; time: string | null }[]; // ≤ 3
  settled: { label: string; evidence: string }[];  // "Payment received", "Your booking is cancelled"
}
```

- **What the prompt rules out,** each with an eval case: marketing deadlines ("50% off ends tonight", "last chance", "offer expires"); a scam's demand (it's said, never a task: plan 132's rule); a receipt for something already paid; a newsletter's event listing; a meeting invite (calendar mail is plan 145's answerless kind); what someone asks of a third person; a date that's only history ("you joined on…").
- **Local checks before anything is stored** (`checkDates`, pure, like `checkSentMail`): the `quote` is in the text, normalized; `due` parses as `YYYY-MM-DD` and is today or later and within a year; `time` parses as `HH:MM` or is dropped; `kind` is one of the seven; at most 3 items; a `settled` label is one it was given and its evidence is in the text, else nothing closes.
- **Provider and model:** `AI_TASK_NAMES` gains `dated`, the summary row's target if one is set up, else Haiku on Anthropic and Luna on OpenAI, else the configured model (plan 131 §2, plan 168's routing). A new background task in `AiLimiter`: 300 requests and 600k input tokens a day.
- **Cost:** about 600 tokens in and 100 out a message. With the cue filter, a busy inbox reads perhaps 30 to 60 a day: about $0.01 to $0.04 a day on Luna or Haiku, under $1.20 a month. The settings hint says so in the user's currency format.

### 4. Data

```sql
CREATE TABLE dated_items (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,            -- no cascade: the item outlives its copy, never its thread
  item INTEGER NOT NULL,                  -- 0, 1, 2 within the message
  kind TEXT NOT NULL CHECK (kind IN ('pay','renew','expire','respond','alert','event','delivery')),
  text TEXT NOT NULL,                     -- "Pay the electricity bill", the app's language
  quote TEXT NOT NULL,
  sender_key TEXT NOT NULL,               -- addressKey(from): settling by sender, and plan 206's rules
  due_at INTEGER NOT NULL,
  timed INTEGER NOT NULL DEFAULT 0,
  act_at INTEGER NOT NULL,                -- when it shows (§2)
  state TEXT NOT NULL CHECK (state IN ('open','done','dismissed','settled')),
  closed_at INTEGER,
  from_scan INTEGER NOT NULL DEFAULT 0,
  model TEXT, provider TEXT, prompt_version INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, item)
);
CREATE INDEX dated_open ON dated_items(act_at, id) WHERE state = 'open';
CREATE INDEX dated_thread ON dated_items(thread_id, state);
CREATE INDEX dated_sender ON dated_items(sender_key) WHERE state = 'open';
```

- Same store in `packages/idb/src/schema.ts`, with the cascade and the three indexes. A `DatedStore` in `packages/store`, with a conformance suite both stores run.
- **Why its own table, not `followups`:** a follow-up is about mail the user sent, keyed to a person, with a nudge and a reminder on the Inbox's top; a dated item is about mail they got, keyed to a sender, with two times. Sharing the table would put three meanings on its columns. The actions, Undo and bounds follow `followups`' code and share its helpers where they are the same.
- **Merges** move rows to the surviving thread, as `followups` and `reminders` do.
- **Bounds:** at most 1,000 open (past that, the furthest `act_at` isn't added), closed rows kept 90 days, both in a background slice.
- **Clear AI data** empties it. Not exported, not synced, not in search, not on `MCP_ALLOWED`. An import carries neither the setting nor the rows. Removing an account drops its rows by cascade through its threads.

### 5. Acting on an item

- **Done** (`dated.act(id, revision, "done")`): the row leaves at once, with the ordinary snack and Undo (`z`), exact, as follow-ups' `act`. **Later:** the Time Field's presets (plan 122), which move `act_at` only. Both are in the row's context menu and the palette; Done is also the row's hover and focus control (`IconButton`, the catalog's check, `focus-reveal:`), at the date's place, as plan 166's control. **No new shortcut** (owner, plan 161).
- **Archiving the thread doesn't end it:** the bill still has to be paid after its mail is filed. Trash and Spam do end it, as they end everything in Today.
- **Settled by later mail:** a new message from the same sender or in the same thread is read with that sender's open items (`open`); a `settled` with evidence in the text closes it (`closed_reason` `settled`), so "Payment received" takes "Pay the electricity bill" away. Never closes on doubt.
- **The reader** shows the open item as a quiet line above the message it came from (the AI card's surface, plan 181), "Due Friday 21 · Done", so the user can finish it where they read it.

### 6. Turning it on, and older mail

- **Settings → AI → What matters** (the group plan 205 names; until then "Today"): "Find dates in new mail", **off by default** (the owner, 2026-11-13). **Today's header offers it** while it's off and AI can run: one quiet line, "Show bills, renewals and trips here · Turn on", dismissible for good, so the way in is where its result will be. Turning it on from there, or in Settings, then offers the 14-day check below. The hint: "Reads new mail with a date in it with {provider}, to show bills, renewals, trips and other things with a deadline. About {cost} a month." With the provider and model row. Off: no marker flag, no worker, no requests; Deadlines, Plans, Missed (for items) and Coming up have nothing in them.
- **Mail already here** is never read without a yes. The first time the feature runs, Today's header offers **"Check the last 14 days"**, with the count after the local filter and the cost, as plan 142's scan offer; `from_scan` rows don't notify (no notification exists in this plan anyway) and an item whose date has passed isn't kept.
- **The gate:** `aiFeaturesAvailable`, the one rule. A provider removed stops the worker; rows stay until Clear AI data.

### 7. The sidebar count

The number beside Today becomes: Missed + Needs you + Deadlines + Plans, threads counted once. It rides the `counts` event as now: `needsCount` plus one indexed count of open items with `act_at ≤ now` (and due within Missed's 7 days), less those whose thread is also waiting (a small join on the open set, bounded by the 1,000 cap). **One timer** (`armDated`) for the soonest moment the view changes by itself: the next `act_at`, the next end of a day with a due item, the next Plan's end. It re-arms on start, wake, a change and when it fires; none when nothing's open. No polling.

### 8. Copy (en and es together)

Group headings: "Missed" / "Se pasaron", "Deadlines" / "Vencimientos", "Plans" / "Planes", "Coming up" / "Próximamente". Row lines: "Due Friday · Pay the electricity bill", "Tomorrow 7:40 · Flight to Madrid", "Was due Tuesday · Renew the domain". Dates through `Intl` and the list's own date words. The settings group, its hint, the scan offer, Done, Later, the snack, the reader's line, the count's name for screen readers.

## Tests

- **core:** `actAt` for each kind, a time and none, across a DST change, a date already past, a year out; `hasTimeCue` en and es, with the marketing and history cases that must still read (cost filter) and plain mail that mustn't; the Missed window; group precedence.
- **ai:** `readDates` task shape, the frozen prompt's version, `dataText`-style escaping of the blocks.
- **backend `dated.test`:** `checkDates` drops an invented quote, a bad or past date, an unknown kind, a fourth item, a `settled` without evidence; the worker skips Spam, Trash, Social, Promotions, a digest candidate and no-cue automated mail without a request (the fake records what it was sent), reads a person's mail without cues, re-checks spam before the request and the write, consumes its flag only; failures per plan 132's table; the limiter; Clear AI data mid-request writes nothing; settling by sender and by thread; Done, Later and Undo exact; archive keeps an item, Trash ends it.
- **`today.test`:** groups and their order; one thread once by precedence; no cap; a dated promise past its day in Missed, an undated one in Needs you; Missed's 7 days; a Plan never Missed; Coming up's 14 days and its count kept out of the sidebar's.
- **Conformance (both stores):** `dated_items` writes, the unique key, merges, bounds and pruning, the open index's order, the count with the waiting overlap, the cascade; `markNewMail` sets `wants_dated` only when asked.
- **state/today.test:** `flattenToday` with the new groups, held rows across them, Coming up's rows only when open.
- **e2e `today.spec`** (one `scenario()` page, fake provider): the groups and their headings in order; Done and Undo from the row's control and from the menu; Coming up opening by keyboard; the reader's line and its Done; the scan offer; en and es; `design-axe` light and dark; `@design` for the headings and the control in every design; screenshots looked at beside their neighbours.
- **The eval:** `scripts/ai-real/dated.real.ts` on the fictional corpus, which gains cases for each kind and each exclusion (marketing deadlines, scams, receipts, history, invites, a third person's task, Spanish), then the five-reviewer panel on a copy of real mail (plan 154's way). **Shipping bar:** no consensus-wrong row in the view, and none of the panel's "this needed me" left out, as plan 145's last read.

## Performance

- **`today.list` ≤ 10 ms at 50k threads** in both stores (`measureToday`, `workloads.perf.test.ts`), with 1,000 open dated items in the mailbox. The open index serves Deadlines, Plans, Missed and Coming up in one range read.
- **The count** adds one indexed count and a bounded join to `counts`, under its 5 ms budget; measured in `today-perf` conformance.
- **Ingest:** one more flag in an insert that's already there. `markNewMail`'s cost is unchanged (`load.perf.test.ts`).
- **The worker** runs in the backend's background slices; the cue filter is a linear scan of at most 1,500 tokens of text.
- **Migration** (v next): one column on `ai_new_mail` and an empty table, shape only (`migrations.perf.test.ts`).
- **Idle:** one timer at most, none when nothing's open; no polling; no work when the feature or AI is off.

## Out of scope

Everything in plans 205 to 207: the name, the Earlier tab, taking things out by sender or kind, the user's own words, the first screen. Other people's promises to the user (never, by the owner). Notifications for deadlines (a later plan, once the panel says items are right). Adding to a calendar. Reading Social or Promotions. Amounts and links in the row (the line is the model's words; plan 141's rule: plain text).

## Order

1. `@terno/core`: kinds, `actAt`, `hasTimeCue`, groups and precedence, with tests.
2. Store: the column, the table, `DatedStore`, conformance, the perf gate.
3. `readDates`, `checkDates`, the worker, the limiter's task, the eval corpus.
4. `today.list`'s groups, no cap, the count and `armDated`.
5. The list: headings, Coming up, the row control, the menu, the reader's line.
6. Settings, the scan offer, copy, tip (`today-dated`, plan 113, the first time a Deadline shows).
7. Real-model eval and the panel read; screenshots in every design, light and dark.

## Revisions after the Codex review

Codex (read-only, `codex exec -s read-only`, the critique in the session's scratchpad `p204/critique.out`) raised 12 points, all taken. Each replaces what the sections above say.

1. **Its own marker, not a third flag on `ai_new_mail`.** Every path that cleans that table up deletes a row once both of today's flags are zero (`packages/db/src/ai-summaries.ts:116`, `:210`, `packages/idb/src/ai-summaries.ts:92`), and `Core` only marks when one of the two is wanted (`core.ts:1406`), so a third consumer would have its work deleted under it. The dated reader gets `ai_dated_mail (message_id, thread_id, arrived_at, queued_at, source 'live'|'scan')`, written in the same ingest commit by the same rules as `markNewMail` (one shared predicate, so the two can't drift), in plan 142's `ai_sent_mail` shape. `ai_new_mail` and its consumers are untouched.
2. **The 14-day check has its own durable queue.** `markNewMail` refuses mail older than 3 days and pruning drops it. After the user's yes, `queueScan` writes `source = 'scan'` rows to `ai_dated_mail` (bounded at 300, as plan 142's scan), kept 14 days where live rows keep 3 (`SCAN_MARK_MS` and `SENT_MARK_MS`' pattern), idempotent on `message_id`, surviving a restart, and counted against the same daily limit; the offer shows only while nothing's been scanned.
3. **Spam is checked at the transport, every attempt.** `AiLimiter`'s last eligibility callback runs only for `ahead` and the digest (`ai-limiter.ts:171`, `ai-service.ts:104`). The `dated` task joins it, with the whole-thread `hasSpam` rule (`packages/store/src/ai-summaries.ts:130`), on every attempt including repairs; `finish` checks again in its own transaction.
4. **A digest candidate isn't skipped.** `digestFacts` is a candidate signal, not a newsletter classifier: on IMAP a bill can qualify, and it depends on read and starred state. Only Gmail's Social and Promotions tabs, Spam and Trash are skipped before the cue filter; list and bulk mail goes through the cue filter and the model, whose prompt rules out marketing.
5. **What could settle an item is always read, in order.** Before any cost filter: a message whose thread or sender (`sender_key`) has an open item is read, cues or not, so "Payment received" reaches the model. Marks are taken in arrival order, and a message waiting for its body holds later ones from the same thread or sender (plan 142's `pass`, `followups.ts:244`); only items older than the message are offered to settle (`followups.ts:301`). The scan runs oldest first.
6. **The schema carries what the actions need.** `dated_items` gains `revision INTEGER NOT NULL DEFAULT 0`, `closed_reason TEXT`, `arrived_at INTEGER NOT NULL`, `deferred_until INTEGER`. `DatedStore.finish` writes the items, applies each settlement only if that row is still at the revision the model saw, and consumes the mark, in one transaction that checks the Clear AI data generation and that the source message is still the one read; a merge between read and finish remaps the thread or retries. `act` and Undo snapshot and restore by revision, as `followups` do (`packages/store/src/followups.ts:84`, `packages/db/src/followups.ts:158`). Races tested: Later, Done, merge and Clear AI data each against a finish in flight.
7. **An alert may have no date.** `due` is nullable for `alert` only; a dated kind without one is dropped. `actAt(kind, dueAt | null, timed, arrivedAt)`: an undated alert shows at arrival and goes to Missed 3 days after it.
8. **One rule places an item, and Later is honoured in every group.** `datedPlace(item, now)` in `@terno/core` → `missed | deadlines | plans | comingUp | hidden`; while `deferred_until > now` an item is `hidden` (or Coming up), never Missed. **Promises:** `followups` gains `due_day TEXT` (the day the promise named, shape-only), because `followupDue` moves a same-day promise to 17:00 or tomorrow (`core/followups.ts:108`) and Later overwrites `dueAt`. A dated promise is Missed when `due_day` has ended and it isn't deferred. Rows from before the column fill `due_day` from `dueAt` when `dated`.
9. **Trash and Spam hide, they don't end.** As now (`followups.ts:519`, `today.ts:507`): an item whose thread is in Trash or Spam isn't shown or counted, and comes back with its thread. Nothing is closed, so Undo needs nothing extra.
10. **List and count share one calculation.** `todayPlaces` (backend, over store reads) decides each thread's group by the precedence in §1; `today.list` lists it and `withCount` counts its distinct thread ids (Missed, Needs you, Deadlines, Plans), so waiting threads, follow-ups and dated items overlap once, ended Plans and hidden threads aren't counted, and two items on one thread are one. Tests cover every overlap of the three sources.
11. **The timer covers every change that happens by the clock.** `armToday` replaces §7's `armDated`: the next strictly future moment across dated items and follow-ups: an `act_at`, a due day ending (→ Missed), Missed's 7 days ending, an item entering Coming up's 14 days, a Plan ending, a deferral ending. It emits the list's and the count's invalidation when it fires, and runs with the digest and notifications off. None when there's no such moment.
12. **The whole list is measured, and its work is bounded.** `waitingPage` rebuilds the `NEEDS_WALK` window on every page (`db/src/today.ts:27`, `idb/src/today.ts:24`), and summary lines are checked one thread at a time (`today.ts:553`). Without the cap, `today.list` reads the eligible waiting set once (`store.today.waiting`, bounded by `NEEDS_WALK`), and current summary lines in one batched read (`aiSummaries.currentLines(ids)`). A new gate measures the full `today.list` and the count in both stores at 50k threads with a dense waiting window, current summaries and 1,000 open dated items, ≤ 10 ms and ≤ 5 ms; `today-perf` keeps its store-level reads.

## What building it changed

- **No `followups.due_day` column** (revision 8): a dated promise is Missed once the day of its `dueAt` has ended (`promiseMissed`). Later moves `dueAt`, so it also moves the day; a promise for "today" written after 17:00 is due the next morning and is Missed a day later than its words say. Rare, and no migration on `followups`.
- **The 14-day check is once on the backend too:** `dated.scan` does nothing after `scanAnswered`, since a message read and found to hold nothing (or only what's over) isn't remembered and a second check would read it again.
- **`checkDates` accepts a quote from the subject as well as the text:** a bill's subject ("Your bill is due Friday") is the mail's own words.
- **The tab comes from Gmail's category too** (`datedTab`): an account that doesn't show Promotions and Social apart still has them skipped; they read as Primary at first (found by `dated.test`).
- **The count is plan 145's walk plus one read** (`today.countWith`, both stores): the waiting count and how many of the placed threads are neither waiting nor in Spam or Trash, in one walk. The open dated items are read once until they change (`changed()`, or `touched()` for a merge or a deleted thread).
- **The gate measures what this plan adds to the count,** in the same turns as plan 145's own `needsCount`, which is itself 5 to 6 ms on SQLite at 50k on this machine: at most 2 ms with items spread over the weeks (0.7 measured), 4 ms with all 1,000 showing (1.1 measured). The whole of `today.list` is 4 to 15 ms; the longest turn 41 ms (`today.perf.test.ts`). A tight loop of awaits on SQLite never yields, so the gate takes a turn between calls, as two requests would.
- **Coming up is a toggle in Today's header line,** not a line at the list's end: the list is a listbox, which holds only its options.
- **No hover control on rows:** a row has no hover actions anywhere; Done is in the row's menu, the palette and the reader's line.

## What the code review changed

Codex (read-only, `git diff 599de7aac..HEAD`, `/tmp/terno-scratch/p204/review-1.out`): 7 points, all fixed, each with a test that fails without it.

1. **An open item from a conversation since moved to Spam went to the model as material** (`open_items`). `openFor` leaves out items whose conversation has anything in Spam (both stores, conformance), and the request's last look (`holdingUp`) also checks the items it carries: one gone stops it, and it's asked again without that item (`dated.test` #1).
2. **What's over stayed open forever and would fill the bound of 1,000.** `datedOver` (a Plan that's ended, a deadline past Missed's days and not moved on with Later) and `retire()`, in the day's bounds and when the clock fires: closed as `dismissed`, `expired`, kept for plan 205's Earlier tab (#2).
3. **The 14-day check took the newest 300 received before its own filters,** so Promotions could fill it. It walks up to 3,000 in the backend's slices and picks what the reader would ask about (not Spam, Trash, Promotions or Social; automated mail only with a time cue) before its bound; the offer's count is the same selection (#3).
4. **A dated promise past Missed's days came back to Needs you.** `promiseOver` leaves it out (#4).
5. **Two re-arms of the clock at once left a timer behind,** which `stop()` didn't clear. Only the newest call arms (#5).
6. **"Tomorrow 7:40" stayed "Tomorrow" past midnight.** While any row shows, the next midnight is a change too (`nextTodayChange`; core test).
7. **A yes to the check that failed was saved anyway,** so the check was never offered again. The answer is saved only once the check is queued; a failure says so and the offer stays (`apps/web/src/lib/dated.test.ts`).

Round two, on those fixes (`/tmp/terno-scratch/p204/review-2.out`, 3 points, all fixed, each in `dated.test` failing without it):

8. **The 14-day check could leave out a later message that settles one it reads** ("Paid in full", no time cue), so an already-paid bill stayed open. A message newer than a pick from the same sender or conversation is read too.
9. **Automated mail whose body hadn't come was judged on an empty text** and left out for good. It's read: the worker waits for its body (the filter errs towards reading).
10. **The clock's wake didn't retire what had just ended** once the day's bounds had run (a flight over at 9:40). `daily()` retires at every wake, and keeps the bounds once a day.

Two rounds, as the owner's cap on review rounds asks; nothing left open from them.

## After the user panel (2026-11-14)

Seven simulated users reviewed What matters on their own mailboxes, read by the real reader (the report: https://claude.ai/artifact/Dn12kA8m9gT1XRSwCyw1Fx; method and pitfalls in the session's notes). Would use it daily: 5.3 out of 10. 82% of what the answer keys expected was shown, and 7 of 86 traps. The owner said yes to fixing the list below before landing 204, and decided:

> yes to all 4 suggestions, for the shortcut we can use D if possible

That is: the "before shipping" list; **a week's lead for requests from people and 30 days for expiring documents**; **D** for Done on Today's rows (an exception to the owner's no-new-AI-shortcuts rule, for this one action); and the automated-messages entry moving to **the end** of Today.

### The fixes

1. **Not a task.** Beside Done wherever Done is (the row's menu, the palette, the conversation's line): `dated.act(…, "dismiss")` (exists), or `followups.act(…, "dismiss")` for a promise. The snack: "Removed from Today", with Undo. Learning from it by sender is plan 206's.
2. **D is Done** on the selected Today row (`today.done`, `d`, outside fields and dialogs): a dated item's Done, or a promise's. Anywhere else, and on a row with neither, it does nothing. The menu shows it beside Done.
3. **Task first.** A Today row with a dated item or a promise leads with the task on its second line ("Due Friday · Pay the electricity bill", in the row's foreground, not the snippet's muted ink), the subject quiet on the third, and its due day (and time) where the received date usually is.
4. **Times and order.** Any timed item says its time ("Due today 1:00 PM · Wire payroll"), not only Plans. Inside a group, items order by their day, then the timed ones by time, then the untimed. The text carries the amount when the mail states one (prompt).
5. **Later mail moves a date.** `readDates` gains `moved: { label, due, time, evidence }[]` for open items a later message gives a new day ("Friday at the latest"); the evidence must be the mail's words and the day must pass `datedTiming` from the new message. `DatedFinish` gains `moved`, applied only at the revision shown, in both stores, recomputing `act_at`; a Missed item with a new day leaves Missed by the rule that places it.
6. **Prompt v3** (`DATED_PROMPT_VERSION` 3), each with eval cases: a booking or appointment still ahead is an event, even when the mail "confirms" it or asks to confirm it; a request addressed by name to someone else in a group mail isn't the reader's; a newsletter's optional call to action isn't an item; an account or security item never tells the reader to reply ("Check the fraud alert with your bank"); the amount in the text; `moved`.
7. **Follow-ups (plan 142) don't take conditional or joking lines as promises** ("if we get to the Rose Bowl I'll have a ticket with your name on it"): its prompt version 8, with eval cases.
8. **Promises in What matters.** A dated promise of yours due in the next 14 days is in Coming up. One due today says so ("Due today · You said: send the agenda"). In the conversation, a request's dated line (`respond`) gives way to your own open promise on the same thread, so one obligation has one line and one Done; Done or Not a task on either closes the other on that thread.
9. **Leads:** `respond` 7 days (was 2), `expire` 30 days (was 7).
10. **Later's choices** on a Today row are the reminder presets that apply now, plus "Pick a date…" (the Time Field); Remind me isn't offered beside it on a Today row with an item, since the two meant the same thing there.
11. **The automated-messages entry moves to the end of Today:** the list's last row (`DIGEST_ROW_ID`, as plan 145 had it, never before a person), under no heading of its own.

Out of scope: a rule for a first message from a prospective client; a promise of yours that a later message from someone else replaces; ownership and handing to an assistant (plan 206); the coverage line ("checked mail since…").

### Revisions after the Codex review of the fixes

Codex (read-only, `/tmp/terno-scratch/p204/critique-2.out`) raised 10 points, all taken. Each replaces what the list above says.

1. **Fix 8 is "your reply answers a request", not a coupled Done.** A thread can hold several requests and promises, so pairing by thread could close unrelated work, and a joint Done would need one journal across two stores. Instead, as plan 142's `closeWaitsBefore` does for waits: a message you send on the thread (a confirmed send, or live sync of mail sent elsewhere) settles the thread's open `respond` items from messages before it (`closed_reason` `answered`), in the same commit. Your promise, if it made one, is then the obligation. Both stores, conformance.
2. *(with 1)* No joint action, so no joint Undo.
3. **A promise row carries its own reference:** `TodayWhy.promise = { id, revision }` for promise and nudge rows, so D, Done and Not a task act on the promise shown, never "the thread's most urgent". `today.done` (`d`) is registered in the keybinding resolver like any other binding, so turning character keys off turns it off.
4. **Promises in Coming up are wired to the clock and the list:** open dated promises due in the next 14 days are placed in Coming up; `nextTodayChange` also wakes when one enters the 14 days and when it comes due; a follow-ups change calls `today.changed()` (the list and the count reload), not only the clock.
5. **A moved item keeps its id and adds nothing.** A new day for an open item goes in `moved`, never in `items`; `checkDates` drops a new item of the same kind on the moved item's new day. `moved` and `settled` exclude each other (settled wins).
6. **A move applies to an open item whatever its revision** (it changes only the due day, its time and `act_at`, keeps `deferred_until`, and bumps the revision), so Later meanwhile can't lose the mail's new day. A closed item stays closed.
7. **No recalculation for the new leads:** 204 hasn't shipped, so no stored item has the old ones.
8. **Task first, in every form:** where a row has a snippet line, the task takes it in the foreground ink and the subject moves to it from line two; in a one-line or compact row, the task is what the snippet's place shows; with no preview, the task takes the subject's line. Row heights don't change, so the virtualizer and the anchor are untouched. The right column shows the due day or time.
9. **Later on a Missed item gives it back a visible week:** Missed lasts until 7 days after the later of its day's end and the deferral's end, in `datedPlace`, `datedOver` and `nextTodayChange`. On a Plan, Later offers only times before it ends.
10. **The digest's entry is the list's last option again** (`DIGEST_ROW_ID`, after held rows), superseding plan 162's place in the header (the owner, 2026-11-14): j/k, Enter, the active descendant, and coming back to it from its page (focus and scroll, even when it was virtualized out); still never checked, dragged, given a menu or thread actions.

### What the code review of the fixes changed

Codex (read-only, `git diff b5d4dd8cd..HEAD`, `/tmp/terno-scratch/p204/review-3.out`): 7 points, all fixed, each with a test that fails without it.

1. **A forged From could answer a request:** IMAP marks a message sent when its From is the user's. Only a send that's certainly theirs answers now (see round 2); Terno's own confirmed send is trusted as it is.
2. **A request read after your reply came back open:** it's stored answered when a trusted reply in its thread is newer than it.
3. **A move broke Later's Undo:** a move keeps the revision (it changes no choice of the user's).
4. **A draft sent elsewhere answered nothing:** the check runs on every thread an ingest touched and on flag reconciliation, not only on inserted messages.
5. **A nudge row had no Done or Not a task:** it acts through follow-ups' act, as a promise does.
6. **The order wasn't applied everywhere:** a thread's item and Coming up use the same comparator (by day, then the timed by time).
7. **A timed Missed item lost its time:** "Was due yesterday 1:00 PM · Wire payroll" (en, es).

Round two, on those fixes (`review-4.out`, 3 points, all fixed):

8. **An archived forged message still counted** ("out of the Inbox" isn't Sent: IMAP sets `is_sent` from the From in any folder, and the store doesn't keep which folder is Sent). Only Gmail's SENT label, or Terno's own confirmed send, answers a request; a reply sent from another IMAP client leaves it for the user's Done.
9. **Retiring what's over could dismiss an item a later mail had just moved** (the move keeps the revision): `dated.update` takes an optional `schedule`, and retirement passes the day it decided on.
10. **On SQLite, an answered request at the bound evicted open work:** the answered check comes before the bound, as IndexedDB had it.

Two rounds, per the owner's cap.

## After the second panel round (2026-11-14)

The same seven personas, re-captured at the packets' morning: Deadlines 6.1 → 6.9, Acting 5.1 → 5.9, Plans 3.9 → 6.0 (partly the capture time), Needs you 3.9 → 3.6, would use daily still 5.3. Against the keys, 82% → 88% shown. What the panel kept asking for, and the owner's answers:

> Yeah let's do the quick fixes. Do show the calendar invitations. They can just remove them anyway. Extend the later mail move date to Promises I Made. I think yes. Yes we need to tighten the Needs You rule from plan 145

### The changes

1. **Done means gone.** Done, D and Not a task take the row out of Today at once, with Undo: it isn't held in place as an ordinary row (plan 145's revision 9 holds rows that *leave on their own*; one the user just finished is their choice). The selection moves to the next row, as after Archive.
2. **A row's task line drops "Due today ·"** where the right column already says when: the line is the task, so the amount fits. The conversation's line keeps the full wording.
3. **Prompt v4:** a subscription that renews by itself reads as what it is ("Plan renews automatically ($9.99)", "Free trial ends"), never "Renew …" or "Cancel …" unless the mail says the reader must act to keep or stop it; the amount goes right after the verb ("Pay $187.42 for the electricity bill"); **a calendar invitation the reader is invited to is an event** (the owner: "they can just remove them anyway"), reversing §3's exclusion.
4. **Later mail moves the day of a promise you made**, as it moves a dated item's: the reader's open promises in the thread (plan 142's rows) are offered beside the open items (`p1`, `p2`), and a move on one goes through `followups.move` (both stores): the due moment recomputed by `followupDue` from the new day, the promise open again if that's ahead, its revision kept as a dated item's move keeps it.
5. **Needs you, tighter (plan 145's rule, amended):** a waiting conversation isn't Needs you's when (a) its last message from them is only an acknowledgment ("Thanks.", "Got it", "Sounds good", "Gracias", "Perfecto"; short, no question: `isAcknowledgment` in `@terno/core`, en and es), or (b) it has a summary covering its last message (plan 132) that gives the reader no action and no question (plan 202's who-has-to-act). Both are read in `needsRows`, in both stores, so the list and the sidebar's count agree.

Out of scope: a first message from someone new that asks the reader something (widening Needs you); a promise of yours another person's later mail replaces rather than moves.

### Revisions after the Codex review of the second round's changes

Codex (read-only, `/tmp/terno-scratch/p204/critique-3.out`) raised 8 points, all taken.

1. **A promise's move is the user's choice's equal, not above it:** it applies only at the revision the reader saw (a Later or Done since wins), and it bumps the revision, so an older Undo is refused as "changed since", plan 142's exact Undo.
2. **Atomic with the read:** promise moves go in `DatedFinish.movedPromises` and are written in the same transaction as the items and the mark, both stores. A move for a promise that doesn't exist yet (the incoming extension read before the sent mail) is lost: out of scope.
3. **Who may move a promise:** only a message on the promise's own thread from the person it was made to (`person_email`); quoted, with a real day. `p` labels can't be settled, only moved. Hostile-mail cases in the eval.
4. **Everything that shows a promise or Needs you reloads:** after a promise move, follow-ups' snapshot is emitted and Today changes; when a summary completes, Today changes too (its list and count).
5. **A summary decides only when it's current and of the right kind:** ready, prompt version 7 or later (who has to act), valid JSON, and no message of the thread after the one it covers. Anything else keeps the conversation as plan 145's rule had it. A body with only `date` or `decision` items gives the reader nothing to do or answer.
6. **An acknowledgment is the whole message,** read from its stored text with quotes and signature taken off: a few words of thanks or agreement and nothing else ("Thanks.", "Got it, thanks!", "Gracias", "Perfecto 👍"), never one with a request ("Thanks, send it Friday"). The thread's snippet is a first, cheap screen; the text is read only for a snippet that starts like one. No text: kept.
7. **Applied to `needsYou`'s result,** after its window and its per-sender count, so nothing it excluded can come in.
8. **The perf gate also holds the absolute times** of `needsCount`, the count and the list, at 50k with the waiting window full.

**How change 5 was built.** `isAcknowledgment` and `looksLikeAcknowledgment` live in `@terno/core` (`today.ts`), `summaryAsksNothing` in `@terno/store`; each store's `needsRows` filters `needsYou`'s result with them (`stillWaiting`). IndexedDB keeps bodies out of memory until a unit reads them ahead, so its Needs you is two steps: `needsWalk` (`needsYou`'s rows, and the last message from them of each thread whose snippet starts like a thanks), then the filter. With nothing to read it stays a plain read; otherwise the store reads those bodies ahead in an exclusive unit and decides in it, as `threads.get` does (`needs-you-bodies.test.ts`: after a reopen, the body is fetched, not thrown on). The perf gate adds a third measure, Needs you at its bound: `NEEDS_WALK` (2,000) conversations, each on the slowest path (a thanks-like snippet whose body says more, and a current summary to parse): `needsCount` 21 ms on SQLite and 6 ms on IndexedDB there (7 and 5 as mailboxes have it), the longest turn 45 ms; the gate also holds `needsCount` and the count in absolute terms in every measure.

### Revisions after the Codex code review of the second round

Codex (read-only, `/tmp/terno-scratch/p204/review-5.out`) raised 7 points, all taken, each with a test that fails without it.

1. **A summary speaks for a conversation only if nothing it shows arrived after the summary was written** (`generated_at` against each message's `created_at`, a tie keeping it). `through_message_id` moves when mail is queued, and a dropped request (a reply too short to read) puts the old summary back to ready with the watermark past the new mail; `finish` checks its sources in its own transaction, so its time is what it covers. Conformance: queued, dropped, kept.
2. **An acknowledgment is recognized by what it allows,** not by what it catches: an acknowledgment, words that add nothing ("for the update", "talk soon", "de nuevo") and at most two capitalized words (a name signing it). "Thanks, review the contract today" and "Perfecto, firma el contrato hoy" are kept.
3. **Quotes come off with `withoutQuotes`,** the shared reader's-own-words helper, so an answer written below a quote counts ("Thanks." + quote + "Please sign the contract today" is kept).
4. **A request you've handled isn't waiting on you:** a conversation whose latest message from them has a dated item that's done, not a task, settled or put off till later leaves Needs you too, in `needsRows` (both stores, so the list and the count agree). It's read from the item, so the item's Undo brings the conversation back exactly; something newer from them brings it back; Later's moment brings it back.
5. **The conversation's promise controls** (Done, Later, Not a promise) go through `actOnThreadPromise`: on the promise its Today row stands for, the row leaves at once with the cursor on the next, and Undo brings it back selected, as from the row's own Done.
6. **A timed item not due today keeps its time in the line:** the right column says the day ("Tomorrow"), the line "7:40 AM · Flight to Madrid" (`dueTimeLeft`, beside `dueShort`). Today's timed item is unchanged: its time is the right column.
7. **Headings and the digest's place follow the rows that are left:** each row's group is kept by thread id when the list is built (`kinds`), and `patchRows` has Today find its positions again after any removal (Done, Archive), before the reload.

Not changed: the "N need you" header briefly behind after Done or Undo (the UI helper's note) is the sidebar count's 200 ms pacing (`COUNTS_EVERY_MS`), not a defect.

What the review's fixes cost at Needs you's bound (2,000 conversations, all on the slowest path): `needsCount` from 21 to about 28 ms on SQLite and 6 to 8 on IndexedDB, mostly the conservative matcher's quote stripping (about 1.4 µs a message, after a word-count exit); the longest turn 47 ms, inside the 60 ms budget. As mailboxes have it, unchanged (7 and 5 ms). The gate's ceilings at the bound follow (`today.perf.test.ts`).

**The second pass on these fixes** (Codex, `/tmp/terno-scratch/p204/review-6.out`) raised 2 points, both taken. (1) The allowlist still let requests through: a request word capitalized like a name ("Thanks. Please reply."), or one that was filler on its own ("update", "reply"). Filler is now whole phrases ("for the update"), a name is allowed only as the message's last one or two words, and a request word in what's left ("please", "reply", "avísame", "firma"…) keeps the conversation. (2) Quote stripping read whole bodies on every count: a body over 20,000 characters isn't read for it and keeps its conversation, as anything unsure does. Two review rounds; this closes the series' reviews.

## After the third panel round (2026-11-14)

The same seven personas on 8676aa78c: would use daily 5.3 → 6.0, Acting 5.9 → 7.1, Plans 6.0 → 6.7, Coming up 6.0 → 6.7, Missed 7.6, Deadlines 7.1, Look 7.7, Needs you 3.6 → 4.1. Against the keys, 89% shown. The owner:

> ok then take the next steps the run the 7 person round again, and do that again until we have at least an 8 score for everyone on every category, do a maximum of 6 iterqtions, nevermind the ai budget, but if you can try to make the round 7 person faster by reusing the same base data without loosing variance and scoring quality for us

What the panel and the keys agree on, and what's done about it this round:

1. **Needs you misses people.** Plan 145 lets in a new conversation only from someone you've written to once, so a first ask from a new client, a friend or family you haven't written lately never shows (the keys: 8 misses). **An ask:** the dated reader (prompt v5) notes a direct, undated ask of the reader by a person, a new kind `ask` ("Answer Mariana about a rebranding quote"): the reader addressed in To (or asked by name), never from an automated sender, never what someone asks a third person, never a newsletter's call to action. It's undated (`dated` false, like an alert), never Missed, and shows in Needs you with its line, whoever sent it. It ends as a request does: your send on the thread answers it (plan 204's answered rule takes `ask` with `respond`), Done, Not a task, Later, a later message that settles it, or Needs you's 30-day window (`WAITING_WINDOW_MS`) after it arrived. An `ask` is never a dated kind's substitute: with a day it's `respond`.
2. **A promise you broke shows as their message.** A waiting conversation that has an open promise of yours (any due day) shows the promise ("You said: send the October update", its day on the right), not the snippet: Elena's "gentle nudge" is about the promise. A due-today or past promise keeps Missed's and Deadlines' rules (3).
3. **Today's commitments sit too low.** A promise of yours due today (or due, undated) moves from Needs you to Deadlines, ordered by day with the rest; Needs you is people waiting on an answer (waiting conversations, asks, nudges).
4. **The header's "N need you" counts Plans.** A dinner, a delivery or a meeting isn't something you owe: the count (the header and the sidebar) is Missed, Deadlines and Needs you.
5. **Lines drop the detail that decides.** Prompt v5: (a) an event or delivery gives a window's end or a "by" time (`until`, HH:MM): stored as `until_at` (SQLite v-next, a nullable column; IndexedDB a field), shown "12:00–2:00 PM" and "by 9:00 PM"; (b) the one thing to bring or do for it goes in its text, in a few words ("Blood test (fast after midnight)", "Laptop delivery (signature required)"); (c) an amount keeps the currency as the mail writes it when it isn't the bare local sign ("US$29"); (d) an alert whose mail says the fix says it ("Wire $187,420.55 to cover payroll by 1:00 PM"), never "click" or "reply"; (e) every dated thing in a message is its own item: a keynote in the mail that also asks for the deck.
6. **Later is hidden.** The conversation's line gets Later beside Done and Not a task (the presets and Pick a date, as the row's menu). A preset at or after a timed item's moment isn't offered for it (Later today at 1:00 PM on a 1:00 PM payroll).

The panel itself, to match a real user and run faster without losing what it measures:

- **Summaries on**, as the app's default (they were off): Needs you's who-has-to-act rule only works with them.
- **Dark mode first:** its screenshot was taken after the walkthrough's Done and Not a task, so it showed a different list.
- **In parallel, and reused:** each persona's mailbox is read in its own process (the spend ledger is process-safe), and the screenshots run on their own ports. When nothing the AI reads changed (same prompts), the AI's database is reused and only Today's list is computed again from it with the current code (`TERNO_PANEL_RELIST=1`). The reviewers are always fresh, in the same split of models, never told an earlier score.

Not this round (asked by one or two): handing an item to an assistant; a "this is a scam" action; a row's second item ("also Thursday · Board meeting"); keys for Not a task and Later (the owner's rule: no new AI shortcuts, D the one exception); ranking across groups by stakes.

### Revisions after the Codex review of the third round's changes

Codex (read-only, `/tmp/terno-scratch/p204/critique-4.out`) raised 12 points; taken as follows.

1. **An ask's eligibility is checked locally,** not only quoted: `checkDates` gets the sender (a person by `senderIsPerson`, never a list, bulk or no-reply address) and whether the reader is in To; an ask from anyone else, or with the reader only copied and not named in its quote, is dropped. Hostile cases in the eval: a mail that tells the model to invent an ask, or quotes real words beside one.
2. **An ask has its own lifecycle:** no synthetic day, never Missed; it shows in Needs you from its arrival until `WAITING_WINDOW_MS` (30 days) after it, then it's over and retired (so it never holds the 1,000 bound); Later past that window retires it. Its own branches in `datedTiming`, `datedPlace`, `datedOver`, the conversation's line and `nextTodayChange`. The setting and the offer say "dates and requests" (en, es).
3. **The count and the list agree on Plans** by placement, not by a constant alone: `countWith` takes the threads placed in groups that aren't counted (Plans, Reminders, Coming up), and a waiting thread among them isn't counted; one counted-groups constant, shared by the backend's count and its notification.
4. **A waiting row's promise is one, chosen and carried:** the open promise in that conversation that's due soonest, carried as the row's promise (`{id, revision}`), so Done, Not a promise and Later act on exactly it; a promise put off with Later is still that conversation's promise, shown with its new day.
5. **"Due today" is the calendar day:** a shared `promisePlace` (Missed, Deadlines for due today or due and undated, Coming up, hidden) used by the list, the count and the clock; nudges stay in Needs you.
6. **and 7. A window or a "by" time isn't a new field.** The model gives no time for it and says it in the text ("Furnace service, 12–2 PM", "Package arriving by 9 PM"), so a Plan stays until its day ends and nothing new is stored or moved. (The narrower change: a field would need point, window and "by" semantics through both stores, the clock and the moves.)
8. **Two items of the same kind on one day survive** when their times differ (a keynote at 9:30 and a tech check at 4:00): `checkDates` keys a kind, a day and a time; the three-item bound per message stays.
9. **The migration admits `ask`:** SQLite's `dated_items` CHECK lists the kinds, so the table is rebuilt (ids, revisions and indexes kept; it's bounded at 1,000 open plus 90 days closed), within the migration gate. IndexedDB has no constraint.
10. **Later in the conversation shares the row's flow** (`actOnThreadItem` takes Later and a moment): the row leaves at once, Undo is exact, a failure brings it back. A preset at or after a timed item's own moment isn't offered for an item still ahead; a Missed one keeps every preset.
11. **No imperative from a sender's money instruction:** dropped from 5. An alert keeps saying what to check; the amount and its currency are only what the mail states.
12. **A kept panel database is reused only with a manifest** of the prompts and settings it was read with (`manifest.json`); otherwise the mailbox is read again. Each walkthrough runs on a copy, so its Done and Not a task never reach the kept database or the next capture.

### How the ask and prompt v5 were built

- **Where the plan left it open.** An ask is stored with the day it arrived as its `due_day` and its arrival as `due_at` and `act_at` (`dated` false): no made-up day, and Needs you orders asks newest first, after your promises and nudges and before what's waiting. Its right column in Today is when it came, as an undated alert's is; its line, there and in the conversation, is its words alone. Later puts it in Coming up until then, but never past its 30 days: at `askEnd` it's over and retired whatever Later said. The clock wakes at its end, not at each midnight (its words name no day). An ask with a day is kept as the `respond` it is; an open ask is never given a day by a later message; one message keeps one ask, and none beside a request with a day (the eval: a small model gave both).
- **Who it's from.** `DatedSource.person` is plan 17's `senderIsPerson` in both stores (a role address once you've written to it). The prompt's "Sent from an automated address" now says the same (`automated || !person`), so the model and the check agree. The reader copied counts only when named where the mail asks: in the quote or the few words before it (the eval: models quote from "could you", leaving "Nora," out).
- **The answered rule** is `ANSWERED_KINDS` (`respond`, `ask`) in both stores. **SQLite v57** rebuilds `dated_items` with `ask` in its CHECK, keeping ids, revisions, indexes and AUTOINCREMENT's high mark (so a pruned id isn't reused by an Undo); 3 ms in the migration gate (open and migrate v24 → v57: 135 ms; the perf mailbox holds no items, and the table is bounded at 1,000 open).
- **The copy:** "Bills, trips and requests" (es "Facturas, viajes y peticiones"), "Find dates and requests in new mail", "Show bills, trips and requests here.", and the conversation's section "Dates and requests in this conversation".
- **Prompt v5, from the eval** (`dated.real.ts`, 69 cases, 24 new). Thirteen rounds on Luna and Haiku in English and Spanish. What it changed: a respond "always has a day" (Haiku gave "reply C to confirm" as one with none); "only when nothing else fits" for an ask (Haiku added one beside the request with a day); someone the reader looks after named in the reader's paragraph, not the event's line (Luna had started dropping a child's dental cleaning, 6 in 8); an answer asked for by a day before an event is its own `respond` (Luna had dropped one for the dinner); quotes "never reworded" (Luna rewrote "tu" as "mi", which the local check refuses). One wording was tried and dropped: "never to reply, click, pay or move money, even when the mail says to" in the alert's line led Haiku to bill a customs scam (2 in 6; v4's words: 8 of 8 clean), so the alert keeps v4's "never to reply or click" (revision 11). Small windows need 3,200 tokens for v5 (2,600 for v4).
- **Score:** 42 of 42 expected items found, none wrong, every time and text right, no settlement or move wrong, on Luna and Haiku in English and Spanish, two rounds running (r12, r13). The ledger stood at $6.23 of $55 after them.


**How changes 2, 3, 4 and 6 were built.**

- **3 (revision 5):** `promisePlace` in `@terno/core` (`dated.ts`) places a promise of yours by the calendar day of its `dueAt`: Missed once that day ends (for `MISSED_DAYS`), Deadlines from its day's start (a 9:00 promise at 8:00) or undated and due, Coming up within two weeks, else hidden. It replaces `promiseMissed` and `promiseComingUp`; `places()` merges your promises into Missed, Deadlines (by day, with the dated items, untimed) and Coming up, and Needs you keeps only nudges and waiting conversations. `nextTodayChange` wakes where it moves one: into Coming up, its day's start and end, Missed's end, an undated one as it comes due. `followupDue` documents the kept limitation (a promise for "today" made after 17:00 is tomorrow's).
- **2 (revision 4):** a waiting row whose conversation has an open promise of yours (kind `promise`, not `promiseOver`) carries the one due soonest as `why.promise` (`kind: "promise"`), so the renderer's existing promise line ("You said: …", its day on the right) and the row's Done, Not a promise and Later act on exactly it; no summary is read for its line. Later moves `dueAt`, so the conversation keeps it at its new day (a sooner promise there takes its place).
- **4 (revision 3):** `TODAY_COUNTED` (Missed, Deadlines, Needs you) in `@terno/core`, used by `withCount`, the morning notification and the renderer's "N need you". `countWith(threadIds, now, uncounted)` (both stores, conformance) drops a waiting thread that's placed in a group that isn't counted; the backend passes the threads `places()` put in Plans (Reminders and Coming up are placed after the waiting rows, so they never take one). The perf gate is unchanged and holds (SQLite 0.9 to 1.4 ms added, IndexedDB 0.8 to 1.6).
- **6 (revision 10):** the conversation's line has Later between Done and Not a task, a ghost button with the follow-up Later's menu and popover (BoardUI's ported dropdown and popover, `WhenForm` for Pick a date…), named "Later: {text}", reached by Tab, its focus back on it after Escape; it acts through `actOnThreadItem(…, "later", at)`, the row's flow. One window, `laterBefore` in `@terno/core`: a timed item still ahead takes only moments before its own, a Plan before its end, a Missed item or one whose moment has passed any; `itemLaterWindow` and `laterWindow` (web) feed the row's menu, the conversation's menu, both pickers (`WhenForm` gains `from` and its notes: "Pick a time before it's due / it starts") and `dated.act`'s check (`errors.dated.laterLate`). `TodayTask` carries `dueAt` instead of `end`.
- **Found while building 3:** placing a promise by its day made Later today on a dated promise a no-op (its day stays today, so it stayed in Deadlines; the row left and came back). Without a deferral column on `followups` (a migration, not this round's), Later on a dated promise of yours is another day: `promiseLaterFrom` (tomorrow's start) drops Later today from the row's menu and the conversation's promise card, the pickers say "Pick a day after today", and `followups.act` refuses an earlier moment (`errors.followups.laterDay`). An undated promise and a nudge keep every moment.

### Revisions after the Codex code review of the third round's changes

Codex (read-only, `/tmp/terno-scratch/p204/review-7.out`) raised 3 points, all taken, each with a test that fails without it; the panel's first read of prompt v5 added a fourth.

1. **A later message's day makes an open ask the request it now is:** "can you send a quote?" then "I need it by Friday" settles the ask and adds a `respond` with its words on Friday (`checkDates`), so it reaches Deadlines and Missed.
2. **Done on a conversation's only promise doesn't bring its waiting row back:** a promise of yours there closed (Done, Not a promise) since their latest message, with none still open, is the row you handled (`stillWaiting`, both stores, conformance); Undo brings it back, as does newer mail from them; a second open promise there keeps it waiting.
3. **An ask doesn't hide your promise:** in a conversation where you'd promised them something, the ask's row shows your promise ("could you send that report?" is about it), so its actions act on the promise.
4. **A message that says no answer is needed asks nothing** (`saysNoReplyNeeded`, en and es, whole phrases: "No action needed!", "No need to reply now", "No hace falta que contestes"): never an ask (`checkDates`), and a conversation whose last message from them says it in its first words isn't Needs you's (both stores).

## After the fourth panel round (2026-11-14)

The same seven personas on 548ac7fcd, with the panel's own changes (summaries on, dark first, run in parallel: the mailboxes read in 2½ minutes rather than 17, the screenshots in 24 s rather than 7 minutes). Needs you 4.1 → 6.7, Look 7.9, would use daily 6.1, Missed 7.6, Acting 6.9, Plans 6.6; Deadlines 7.1 → 6.0 and Coming up 6.7 → 6.0. Against the keys, 99% shown on the first read (all of Needs you's misses found). What they asked, checked against the data, and this round's changes:

1. **A later message that changes only the time doesn't move it** ("Saturday's game is moved earlier to 8:00 AM"; the row kept 10:00): `checkDates` required a new day. A timed item moves when its moment changes, the day the same.
2. **A promise's card invents "9:00 AM"** (`followupWhen` shows the moment it comes back): a dated promise of yours says its day ("Due today", "Due Tuesday"), never the time it's placed at.
3. **One vocabulary in the conversation.** The promise card said Reschedule and Not a promise beside the dated line's Later and Not a task: it says Later and Not a task too (en, es), with the dated line's button weights.
4. **A promise row named the reader** (the conversation's last sender is you): a promise's row names the person you made it to.
5. **The buckets disagree** (a December membership in Deadlines, an invoice due in 7 days and your own promise for Sunday behind Coming up's toggle). A bill's lead goes from 3 days to a week, as a request's is (the owner's week); a dated promise of yours is Deadlines' from a week before its day (§2's lead for requests); an expiring document keeps the owner's 30 days.
6. **An undated promise sat in Deadlines under the day it was made** ("Nov 6"): an undated promise that's due is Needs you's (it has no day), ordered after the asks.
7. **Alerts say too little** ("Check the failed payment"). Prompt v6: an alert says what happened, with what the mail states (the amount, the card, what stops), and to check with the company that sent it: "Debit card frozen after a $412.18 charge: check with Tri-River". Still never an instruction to pay, wire, click or reply (revision 11 of the third round).
8. **People before passive plans:** Needs you comes before Plans (Missed, Deadlines, Needs you, Plans, Reminders, Coming up).
9. **Undo names what it undoes:** "Done: Pay $187.42 for the utility bill" (en, es), not "Marked done".
10. **Coming up says its horizon:** the toggle reads "4 coming up in 2 weeks" (en, es).

Not this round: a scam named in the automated messages' row; delegating to an assistant; keys for Not a task and Later (the owner's rule); the separate jobs inside one event's mail.

### Revisions after the Codex review of the fourth round's changes

Codex (read-only, `/tmp/terno-scratch/p204/critique-5.out`) raised 12 points; taken as follows.

1. **No week's lead for promises:** Later on a dated promise moves its due day (there's no deferral column on `followups`), so a promise put off within the lead would stay in Deadlines. Change 5 is the bill's lead only; a promise keeps its day's rule. A deferral column is a later plan's.
2. **An ask's checks run before a day turns it into a request** (`checkDates`): an ask with a day from an automated sender, or asked of someone else, is dropped as an ask would be, not kept as a `respond`.
3. **Prompt v6's alerts are descriptive and attributed,** never an instruction: what the mail says happened, with the amount or card it states ("Debit card frozen after a $412.18 charge, the email says"), never "check with" a name the mail gives (it may be an impersonation), never pay, wire, click or reply. The eval adds a phishing alert with invented details beside real words.
4. **Needs you before Plans is the headings' order only:** a thread that's both a Plan and waiting stays the Plan (its precedence and the count unchanged); `TODAY_GROUP_ORDER` puts Needs you's section above Plans'.
5. **Time-only moves:** the prompt says `moved` is a new day *or time*; `checkDates` moves a timed item whose moment changes on the same day, and a same-day move with no time keeps the item's time. The text's words aren't rewritten (a window said in the text stays). Item id and deferral kept; Undo as before.
6. **The bill's week applies to bills read from now on** (`actAt` is stored): one already open keeps its three days. The panel reads every mailbox again, and a real mailbox's open bills turn over in a month; no rescheduling pass.
7. **A send answers requests as before** (plan 204's rule, any trusted send of yours): "I'll send the deck tomorrow" is a promise follow-ups shows as yours. Not changed this round.
8. **An undated due promise is Needs you's** (`PromisePlace` gains `needsYou`), after asks and before nudges, and its row shows no day (not the mail's date).
9. **A promise's row names and pictures the person you made it to:** `TodayWhy` carries the promise's `personEmail` beside `personName`, and the row uses them for its name and avatar; the thread's own data is unchanged.
10. **The promise card says its day with `promiseWhen`** (no "9:00 AM"); an undated promise says no day; a nudge keeps its "comes back" time. Only the promise's buttons are renamed (Later, Not a task); a nudge's dismissal keeps its words.
11. **Undo's words are captured when acting:** the task's text goes with the act ("Done: Pay $187.42…"), one formatter for the row, the conversation, D and the follow-ups card.
12. **Coming up's horizon wording is dropped** from this round: items come into it by their time to act, so "in 2 weeks" wouldn't be exact.

### How the reader's changes were built (changes 1, 5 and 7; revisions 2, 3, 5 and 6)

- **Time-only moves (change 1, revision 5).** `checkDates` moves an open item when the day changes, or when it's given a moment on the same day that isn't its own (`timing.timed && dueAt` differs): "Saturday's game is moved earlier to 8:00 AM" takes a 10:00 game to 8:00, an untimed bill told "by 5 PM" on its day takes the time. The same day with no time, or the same moment, isn't a move, so the item keeps its own time; another day with no time is the day's move it was (untimed). The stores' move write needed no change: it sets the day, moment and time to act, keeps the id, the revision and the deferral; the conformance (both stores) adds a same-day moment change with Later before it, its Undo, and a retire decided at the old moment refused. The backend test runs Later → move → Undo and move → Later → Undo through RPC, and a "still on" with no time that keeps 8:00.
- **A bill's week (change 5, revision 6).** `DATED_LEAD_DAYS.pay` 3 → 7: a bill shows from 9:00 a week before its day. `actAt` is stored, so one already open keeps its three days.
- **An ask with a day (revision 2).** Checked by `askAllowed` (a person, the reader in To or named where it asks) before it's the `respond` it is; one that fails is dropped, and doesn't count as the message's request with a day.
- **Prompt v6 (change 7, revisions 3 and 5).** An alert's text says what the mail says happened, with the amount, card or account it states, "and always that it's the mail's word": "Debit card frozen after a $412.18 charge, the email says" (es "Tarjeta de débito congelada tras un cargo de $412.18, según el correo"); never to reply, click, pay or call, nor to check with someone the mail names. `moved` is "a new day or a new time" (the same day when only the time changes; the time null when the mail gives none). From the eval: Luna in Spanish noted a game moved to another field ("same time as planned") as a new event beside the open one, so "an open item the mail only mentions again with no new day or time (a reminder, a new place) is neither moved nor an item"; and alerts dropped the attribution on the payroll notice until it said "always". Small windows need a little over 3,200 tokens for v6.
- **The eval** (`dated.real.ts`, 75 cases, 6 new): a game moved earlier on its day (en), a meeting moved earlier (es), the same day at another field with no time (a move may only come with no time), a phishing alert with an invented charge and card beside a bank's words, a genuine card freeze (es), a failed payroll funding notice (an alert, or a pay or respond to fund it by 1 PM, like the suspended account's). Every alert is checked for an instruction (reply, click, pay, call, verify, contact, check with, and their Spanish), for the mail's word ("says", "según"…), and for an amount or card digits the mail doesn't have. Three rounds on Luna and Haiku in English and Spanish; the first had Haiku's payroll "Fund the $48,210.55 payroll debit by 1:00 PM PT" as a `respond`, now accepted beside the alert as the suspended account's is. **Score:** 44 of 44 expected items found, none wrong, every time (17 of 17) and text right, no settlement or move wrong, no alert unsafe, unattributed or with a made-up detail, on Luna and Haiku in English and Spanish, two rounds running. The ledger stood at $6.97 of $55 after them.
- **Left as it was:** a message that repeats an open item still adds a second row when the model notes it again (the store keys items by message, not by what they are); v6's words make that rarer, and a local check against the open items it was shown is a later change.


**How changes 2, 3, 4, 6, 8 and 9 were built.**

- **6 (revision 8):** `PromisePlace` gains `needsYou`: a due promise of yours that names no day (it was Deadlines'). `places()` puts them in Needs you after the asks (an ask's row still shows the conversation's promise, `owed`) and before the nudges, the longest due first; the count reads them before it returns (it's a counted group either way), and a waiting row on that conversation is deduplicated as before. Its row says no day: `TodayTask.noDay` on an undated promise, and the row's date is an empty `data-no-day` slot, never the mail's date (an undated alert or an ask keeps the day it came, and a nudge the mail's date).
- **8 (revision 4):** `TODAY_GROUP_ORDER` is Missed, Deadlines, Needs you, Plans, Reminders, Coming up, and says it's the headings' order only. Which group claims a thread stays `places()`'s push order (Plans before the waiting rows), so a waiting Plan stays the Plan and the count is unchanged (a backend test: both kinds, the count 3). The renderer needed no change beyond its tests: `flattenToday` sorts by the constant, a held row finds its group's place by it, `todayRowsLeft` and the keys follow the rows. The e2e reaches a Plan past Needs you's rows (the list is virtualized).
- **4 (revision 9):** `TodayWhy.personEmail` beside `personName` (promises and nudges). `taskOf` gives a promise or nudge task its `person` (the name, else the address's local part; none when neither is known), and the row (`TodayRowTask`) names and pictures them: the sender's name, the avatar's initials and color, a person's icon only with an address. The thread's own data is untouched. It's read from the row's task each time Today is read, so the promise that becomes the row's after Done brings its own person.
- **2 (revision 10):** `followupWhen` is `string | null`: a dated promise says `promiseWhen` (Missed's "Was due …" once its day has ended), an undated one null (the card shows no line), a nudge its "Comes back …" time. `followup.dueOn` went (unused).
- **3 (revision 10):** a promise's buttons are the dated line's: Done outline, Later and Not a task ghost (`followup.later` "Later", es "Más tarde"; `followup.notPromise` became `followup.notTask`, "Not a task", es "No es una tarea"). A nudge keeps Write a follow-up, its outlined Later and Dismiss. The picker's button says Move (`dated.laterSet`), as the dated line's. The tip's Done and the Inbox's lines didn't use the renamed keys.
- **9 (revision 11):** `taskSaid(action, text)` in `lib/dated.ts`: "Done: {text}", "Not a task: {text}", "Later: {text}" (`dated.snack.*Item`, en and es), cut at a word past 60 characters; with no words (a nudge) the plain "Marked done". `TodayTask.text` carries the words the row showed; `actOnDated` and `actOnTask` take them before the act (a test replaces the row's task while the act is on its way, and the snack still names the first), the conversation's line passes its item's, the promise card its row's (`actOnThreadPromise`, `actOnFollowup`). A nudge's snack keeps follow-ups' words ("Back on top of your Inbox …"). Revision-conditional restore and selection restore are unchanged.
- **Tests:** core (`promisePlace`, the order), backend (`dated.test.ts` "the fourth panel round": Needs you's order with an ask, an undated promise and a nudge above a waiting Plan, the person in the why, the count; `today.test.ts`'s undated promises now Needs you's), web units (`state/today.test.ts` the order and the person, `thread-row-marks.test.tsx` the row, `followups-copy.test.ts`, `lib/dated.test.ts`, `today-task.test.ts`), e2e (`today.spec.ts`, `followups.spec.ts`). The Today perf gate holds (SQLite list p95 13–35 ms, IndexedDB 6–9 ms, on a loaded machine).

### Revisions after the Codex code review of the fourth round

Codex (read-only, `/tmp/terno-scratch/p204/review-8.out`) raised 5 points, all taken, each with a test that fails without it.

1. **Long alerts lost "the email says"** at the 120-character cut. **Prompt v7:** an alert's text is only what the mail says happened (the amount, card or account, what stops), no attribution, no instruction; the app says whose word it is, `datedText` (`dated.alertSays`: "…, the email says", es "…, según el correo") in Today's row line, the conversation's line and its buttons' names. A model that still writes v6's words has them taken off before the cut (`alertText` in `validate`, en and es, leading or trailing). Undo's snack keeps the task's own words.
2. **A move of the time alone needs the item's day:** `<open_items>` gives each its day and time when it has them ("o1 (event, 2026-03-07 10:00): …", a dated promise its day), and the prompt says a time-only move keeps "its own day from <open_items>"; `moved.due` stays required. Two eval cases give only the new time (en, es).
3. **"At 9:00" on an untimed item is a move:** its stored 9:00 is a default, so `timing.timed && !row.timed` is a change.
4. **The eval's instruction matcher** is `scripts/ai-real/dated-checks.ts`, with its own tests in the unit run: English and Spanish, imperative (tú and usted) and infinitive (pagar, llamar, verificar, transferir, hacer clic, responder, consultar con…), an enclitic allowed; a passive or impersonal ("se actualiza", "no se pudo pagar") and an infinitive after a preposition ("hasta confirmar") say what happens and aren't one (the eval found both on genuine alerts).
5. **Attribution is asserted:** the model's alert text has none of its own (`selfAttributed` 0) and no instruction (`unsafe` 0), and the app's line for it says whose word it is (`unattributed` 0, from the catalog's `dated.alertSays`).

**Prompt v7 from the eval.** Eleven rounds on Luna and Haiku in English and Spanish. Haiku put the mail's own fix in an alert ("…; update payment method to reactivate"), so "never an instruction, not even the mail's own: not to update, reply, click, pay or call…". Haiku in Spanish made "just so you know, the caterer is confirmed" an ask 4 in 6; said in the not-items list it cost a game its "arrive by 7:30" (4 in 6), so it's in the ask's line ("nor news for them"), where it costs nothing measured. Seeing the open item's 10:00, a model may "move" it to that same moment ("same time as planned"): no move, as `checkDates` reads it. Small windows need a little over 3,300 tokens. **Score:** 44 of 44 expected items found, none wrong, every time (17 of 17) and text right, every move right (the two time-only ones included), no settlement wrong, no alert with an instruction, its own attribution or a made-up detail, on Luna and Haiku in English and Spanish, two rounds running (r10, r11). Luna's occasional reworded quote (dated-010, "tu" as "mi") and a dropped child's appointment (dated-036, 1 in 8) were seen once each in earlier rounds, as in v5's. The ledger stood at $8.70 of $55.

### The phishing guard (after the fourth panel round)

The panel showed two phishing mails as alerts: security@tririver-fcu-alerts.com's "Online banking access temporarily suspended" in Margaret's Deadlines (her bank writes from tririverfcu.org) and seguridad@bbva-mx-alertas.com.verifica-acceso.info in Diego's Missed. The model saw them as genuine; a local rule now says otherwise.

- **`suspiciousSender(email)`** (`packages/backend/src/suspicious-sender.ts`): the sender's registrable domain, by the Public Suffix List plan 22's icons already ship (`tldts`: `accounts.google.com` is google.com, `bbva.com.mx` keeps `.com.mx`; a name outside the list, its last two labels), joins words with a hyphen and one is a security or account word (alert(s), secure, security, verify, verification, login, signin, account(s), support, update(s), seguridad, verifica(r), verificacion, acceso, cuenta(s), alerta(s), soporte). It lives in the backend, not `@terno/core`, because both callers are there and the suffix list is a backend dependency. Tested with the two fakes and their kind (`chase-secure-login.net`, `santander-cuenta.com.mx`, `paypal-account-support.co.uk`), and genuine senders that must pass (alerts@paybridge.com, billing@stratus.app, alerts@tririverfcu.org, notifications@github.com, no-reply@accounts.google.com, bbva.mx and bbva.com.mx, alerts.hsbc.co.uk, coca-cola.com, mercado-libre.com.mx).
- **The reader** never asks about such a sender's message: its mark is consumed, so it keeps no item, settlement or move and isn't asked again.
- **What's automated and the digest** (plan 145) leave it out of a scan (it takes none of the 40 places and reaches no model) and at read (a digest stored before), so the row's names and count never show it.
- **Dropped: the lookalike half** (a domain with the same letters as one the user already gets mail from, once hyphens and those words are taken out). It needs the domains the user gets mail from, which neither store keeps by domain. A bounded read would be a new index on both stores. Both of the panel's fakes are caught without it, so it's left for a later plan.

## After the fifth panel round (2026-11-14)

On f68d56f93 (prompt v7, the phishing guard): Deadlines 6.0 → 6.9, Acting 6.9 → 7.4, Missed 7.9, Look 7.9; Needs you 6.7 → 5.6, Coming up 5.9, Plans 6.3; would use daily 6.1. Diego is at 7 or more everywhere. Against the keys, 97% shown and both phishing alerts gone. What they asked, checked against the data:

1. **Your own promise due in a few days hides behind Coming up's toggle** (Jordan's pricing for Tuesday, Theo's deck for Sunday), because a promise is Deadlines' only on its day: the fourth round dropped a week's lead because Later moves a promise's day. **A promise gets its own Later:** `followups.deferred_until` (SQLite v58, nullable; IndexedDB a field; snapshots and Undo carry it), set by Later instead of moving `due_at`; a dated promise is Deadlines' from a week before its day (a request's lead), unless put off until later; Missed by its own day as before. The pickers offer every preset again.
2. **A moved item keeps its old words** ("arrive 9:30" beside an 8 AM game): a move may carry the item's new text (prompt v8's `moved.text`, quoted like the rest), written with the move in both stores.
3. **An alert with no day shows the day it came** ("Yesterday" under Deadlines, read as overdue): an undated alert's row shows no day, as an undated promise's doesn't.
4. **Cold outreach is no ask** (a recruiter's pitch asking for intros): prompt v8 says a cold pitch, sales or recruiting outreach to the reader isn't an ask; and the model's text is cut at a word, not inside one.
5. **"You said: call"**: follow-ups' prompt v9 says a promise's text names what, to whom where it matters, and the time it states ("call Marcus at 4:00 PM").
6. **One conversation hides its second date** (Priya's board meeting under "Send Jess your draft", again): a row whose conversation has another open item that would show shows it on its second line, in place of the subject: "Also Thursday 9:00 AM · Board meeting".

The panel: an old corpus message with no To went to the persona as its only recipient, so an all-staff broadcast read as asking them; such a message now goes to undisclosed recipients (the reader isn't named), as it did in its mailbox.

Not this round: delegating; a way to stop a sender for good; the parts of one event's mail (confirm by replying, what to bring) as separate items.

### Revisions after the Codex review of the fifth round's changes

Codex (read-only, `/tmp/terno-scratch/p204/critique-6.out`) raised 12 points, all taken.

1. **Promise Later changes the scheduler too:** one effective wake-up (`max(dueAt, deferredUntil)` while deferred), shared by both stores' due transition and next-due read, notifications, the Inbox's top and the clock; a nudge keeps its rescheduling.
2. **A deferred promise is no row's promise** (`owed` skips it), and a waiting conversation whose only open promise is deferred isn't Needs you's until it's back, derived from stored state so Undo restores it.
3. **A deferral past Missed's week keeps the promise:** while deferred it's never over; when it comes back after its day it's Missed for a week from then (as `missedUntil` does for dated items), in `promiseOver`, `promisePlace` and `nextTodayChange` together.
4. **`deferred_until` everywhere a row goes:** SQLite v58 `ALTER TABLE` (shape only), IndexedDB normalized to null, the row converters, update, restore and snapshots (restored to null explicitly). A promise put off before this keeps the day Later gave it.
5. **Cold outreach, with or without a day:** the prompt says cold pitches, sales and recruiting outreach are neither an ask nor a request with a day; nothing else (an empty reading doesn't suppress a waiting conversation).
6. **Asks stay attributable and plain:** adversarial en/es eval cases (forged familiarity, a request for money or details, an instruction in the mail); no contact history is sent to classify "cold".
7. **A move's new text is optional, bounded and evidenced:** `moved.text` with its own quoted `textEvidence`; the old text stays without it; written with the schedule in one write, both stores; an ask turned into a request keeps its words unless the move gives new ones. Never for a `p…` label (another person's words can't become "You said").
8. **A move's new text is outside Undo's snapshots:** Later → move → Undo keeps the move's day and words and restores the deferral, both stores, both orders.
9. **The second item is chosen while placing,** from the candidates per thread before `best` and `dedupe` drop them: one distinct item that would show (not deferred, over or not yet showing), attached to `TodayItem` as `also`; the count is still of primary threads; no per-row reads; the perf fixture gains threads with several dates and promises.
10. **The second line where a row has one:** it replaces the subject in the layouts with a subject line, and joins the accessible name elsewhere; heights unchanged; D, Done and Later act on the row's own item; en and es.
11. **v9's time is in the words only** ("call Marcus at 4:00 PM"): a promise's moment stays the day's, as now.
12. **Narrow:** an undated alert's row sets no day (`noDay`), its timing and Missed unchanged; word-boundary cuts apply to display text (and a move's text), never to quotes or evidence.

- **The second pass** (Codex, `/tmp/terno-scratch/p204/review-9.out`, 3 points, each with a test that fails without it):
  - **Trust.** Anyone you've written to is trusted, so jane@acme-support.com keeps her asks and invoices. The check is `dated.written`, plan 17's correspondents by `addressKey`, in both stores with conformance. The store is asked only when a sender looks suspicious: one indexed lookup. Trust is by address, not by domain, because neither store indexes correspondents by domain. `untrustedSenders` is the one rule the reader, Today and the digest all apply.
  - **Items stored before the guard** from an untrusted suspicious sender are left out where the open items are read: Today's `datedRows` (the list and the count) and the conversation's `dated.ofThread`. Nothing is retired in the background.
  - **A resumed digest:** `stillListed` applies the guard, so a digest checkpointed before the upgrade neither sends such a message to the model nor stores its result.

### How the promise's Later was built (change 1; revisions 1 to 4)

- **The column.** `followups.deferred_until`, SQLite v58: one `ALTER TABLE … ADD COLUMN`, nullable, no backfill (1 ms at 57,000 conversations in `migrations.perf`; the whole way from v24, 158 ms). IndexedDB keeps it as a field, read as null where a row has none. `FollowupRow.deferredUntil`, `FollowupSnapshot.deferredUntil` and `update`'s patch carry it; `restore` writes the snapshot's deferral, null included (a journal from before it has none, so it's null too). A promise put off before this keeps the day Later gave it.
- **One wake-up.** `followupWakeAt` (`@terno/core`): `max(dueAt, deferredUntil)`. Both stores' `makeDue` and `nextDue` use it (SQLite's over the open rows, the active bound of 1,000), and so do the notice's window and the follow-ups list's order. So a promise put off past its day isn't made due again by the `look()` that follows Later, and Undo's expected revision holds (a backend test fails without it).
- **Later.** `act` on a promise sets `deferredUntil` (state open, off the Inbox's top) and leaves `dueAt`; a nudge's Later moves `dueAt` as before. The tomorrow-only rule is gone with its pieces: `promiseLaterFrom`, `LaterWindow.from`, `WhenForm`'s `from` and its note (`dated.laterNextDay`), and the backend's `errors.followups.laterDay` (en, es). Later on any promise offers every preset and any moment ahead.
- **Where it sits.** `promisePlace` places a dated promise from a request's lead before its day (`DATED_LEAD_DAYS.respond`, 9:00 a week before, by wall clock across DST), or from its Later if that's later: Coming up within two weeks of that, Deadlines from it. Its day over: Coming up or hidden while put off, else Missed until `missedUntil` of its day and deferral (a week from a late return), then over. `promiseOver` is never true while put off. `nextTodayChange` wakes at each of those moments. An undated promise is Needs you's once due and not put off.
- **No row's promise while put off.** `owed` skips it (`promiseDeferred`), so an ask on the same thread shows the ask. Both stores' `stillWaiting` read stored state: a conversation whose open promises are all put off (`deferred_until > now`) isn't waiting, so the list and both counts drop it until it's back, and Undo restores it. A backend test checks the list, the header's count and the sidebar's together, with an unrelated ask on the same thread.
- **A move from their mail** keeps the deferral and, as in the second round, applies only at the revision the reader saw and bumps it. So move → Later → Undo keeps the moved day and removes the deferral. Later → move shown before Later is refused. Later → move shown after Later lands with the deferral kept, and Later's Undo is then refused as changed since (conformance, both stores).
- **Left as it was:** a conversation whose only open promise is put off stays out of Needs you until it's back, even if they write again with no ask in it (no "deferred at" moment is kept to compare with); an ask in it is still shown.


**How prompts v8 and v9 were built (changes 2, 4 and 5; revisions 5–8, 11 and 12's word cut).**

- **A move's new words (change 2, revisions 7 and 8).** `moved` entries carry `text` and `textEvidence`, both or neither (validate); `checkDates` keeps the words only when the evidence is the mail's and only for an o label (a `p…` promise keeps its words), and an ask a day turns into a request keeps its words unless the move gives new ones. Both stores write `text = coalesce(new, text)` in the move's own update; neither the text nor the schedule is in a snapshot, so Later → move → Undo and move → Later → Undo keep the move's day and words and give back the deferral (conformance, both stores; a backend test through RPC).
- **Cold outreach (change 4, revisions 5 and 6).** v8 says it among what isn't an item: "a pitch, sales or recruiting mail from someone who doesn't know the reader…, with a day or without: neither an ask nor a respond". Said in the ask's own line, it cost Haiku a colleague's real ask (dated-052, 5 in 10, against v7's 10 of 10) and made it note "just so you know" as one (6 in 10); in the list, neither. No contact history is sent.
- **The word cut (revision 12).** `cutAtWord` (validate, for an item's text and a move's): `Intl.Segmenter`'s words, a token longer than the bound at a grapheme, never inside an emoji, a flag or an accent; quotes and evidence keep `clean`. Small windows now need a little over 3,700 tokens for v8 (3,300 for v7) and 2,000 for follow-ups' v9.
- **What else the eval changed in v8.** Haiku in Spanish added a moved appointment as a new event too (4 in 4; v7 0 in 8), so "never also in items" comes right after the move's shape; it wrote "llegar 8:00" for a game moved to 8:00 (3 in 4), so the words hold "only what the mail states" and never the item's own day or time, and "keeping what it names" (Luna's "Soccer game" for "Mateo's soccer game"); what the mail asks about a promise ("send it as a PDF") is that promise's (v7 2 in 8, early v8 3 in 8); a stranded traveller's plea to wire money (v7 8 in 8 an ask) and any request to send a password, an account or bank number or an ID by email are never items.
- **Follow-ups v9 (change 5, revision 11).** "What they'll do, to whom when that matters, and the time of day they state, written in full": "call Marcus at 4:00 PM" (es "llamar a Marcus a las 16:00"); the day in `due`, never in the words. Asked for that, Haiku dropped "let me check and get back to you" 8 in 10, so "a promise that says no more is still one". Run on Luna too for the first time, it answered a recipient's name as a kept promise's label, so "its label from <open_promises> (p1, p2…)". "Next Tuesday", sent on a Monday, is read both ways (Luna: the next day), so the eval takes either.
- **Score.** Dated (`dated.real.ts`, 93 cases, 16 new): 48 of 48 expected items found, none wrong, every time (19 of 19), both move texts right, no move, settlement or alert wrong, no text cut inside a word, on Luna and Haiku in English and Spanish, two rounds running (r6, r7, of seven). Follow-ups (`followups.real.ts`, 165 readings): 110 of 110 promises, none false, 30 of 30 replies, none false, 70 of 70 days and 50 of 50 promise texts right, on Haiku and Luna, two rounds running (r5, r6, of six). The ledger stood at $10.91 of $55.
