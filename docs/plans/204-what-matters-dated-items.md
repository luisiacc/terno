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
