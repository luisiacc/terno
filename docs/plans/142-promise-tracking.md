# Plan 142: Promise tracking (Follow-ups)

- **Status:** built and on `main`, code-reviewed in two rounds (see "What building it changed" and "What the code review changed"). The real-model eval (`scripts/ai-real/followups.real.ts`) is written and not run, and the owner's read on a copy of a real profile hasn't happened: both wait for the owner's go-ahead. "Revisions after the Codex review" overrides the sections before it.
- **Builds on:** plan 131 (AI base), plan 17 (who is a person, your addresses), plan 87 (reminders, the Inbox's top, the due notification), plan 133 (the writing extractor, templates, one-tap drafts), plan 132 (the worker's shape), plan 113 (tips).
- **Used by:** plan 145 (the brief's "needs you").

## The request

> **Promise tracking (build first):** "You told Tom you'd send this by Friday" or "Ana hasn't replied in 5 days, want to nudge them?" This extends plan 17's "waiting for your reply" and plan 87's reminders. Few clients do this well, and a missed promise is costly.

## Decisions (the user, 2026-11-05)

| Question | Decision |
|---|---|
| What's tracked | Your promises, and people who haven't replied to you. **Not** their promises to you |
| Detection | A small model reads each message you send, once you turn this on |
| Turning it on | Offers a one-time check of the last 30 days, with the count and cost, and sends nothing old without a yes |
| Where it shows | On top of the Inbox when due, until opened; your own due promises notify like reminders; a Follow-ups row under More lists them all; the thread shows a quiet line |
| When a promise comes back | The morning of its date. With no date, after 3 days |

The name in the product is **Follow-ups** (es: **Seguimientos**).

## What exists

- **Plan 17** computes `waiting_since` for mail waiting on *you*. Nothing says a thread is waiting on *them*. `has_sent` says only that you wrote at some point.
- **Plan 87's reminders:** `Reminder { threadId, dueAt, kind, setAt }`, `kind` is unchecked `TEXT` in SQLite, a single timer (`armReminders`), `reminders.put(rows, cap, { ifAbsent })`, `deleteExact`, the "Reminders" group on top of the Inbox, ended by opening, archive, trash or spam, `reminderNotice`, and `reminders:notifiedUpTo`. The manual "Remind me if they don't answer" stays as it is. `answered` already compares against your addresses.
- **New-mail marker:** `ai_new_mail` (`markNewMail`) only marks mail that isn't from one of your addresses, so sent mail needs its own.
- **The writing extractor** (`packages/core/src/writing/extract.ts`) gets what you actually wrote, including inline answers, without quotes or signature. `TemplateFinder` sets mail templates aside.
- **Send paths:** the composer, Send Later and automatic forwards (plan 116) all arrive as a `send` op, and mail sent from another client arrives through sync as `is_sent`.
- **One-tap drafts:** `ai.compose` with an `instruction`, committed as one undo step (plan 133 §10).
- **Volume:** a real profile sent 340 messages in 180 days across three accounts (plan 133, "What a real mailbox changed"), so about 2 a day.

## Design

### 1. What counts

- **A promise:** a concrete thing you said you would do for someone, in this message. "I'll send the contract by Friday", "te lo reviso mañana", "let me check and get back to you". Not pleasantries ("let's catch up sometime"), not what you ask of others, not what you've just done ("attached is…").
- **Awaiting a reply:** your message asks or needs something from a person, and they haven't answered. Not "thanks!", not an FYI, and not a message to a list or an automated address. The recipient must be a person by `senderKind` (plan 17 §2.2).

### 2. Which mail is read

A durable marker, written in the commit that makes the mail known, so a quit loses nothing:

```sql
CREATE TABLE ai_sent_mail (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  sent_at INTEGER NOT NULL
) WITHOUT ROWID;
```

- **Sent from Terno:** marked when the `send` op completes, so a scheduled message counts when it really goes, and one that fails or is undone never does.
- **Sent from elsewhere:** marked by live sync ingest (`is_sent`, plan 116's `live`, within 3 days).
- **Not marked:** first sync, backfill, import, the demo, a draft, an automatic forward (you wrote nothing), mail only to your own addresses, and anything before the feature was turned on.
- **Only while wanted:** `followups.enabled` false means ingest does one boolean check and nothing else, and the account's opt-out is honored.
- **Left out when read:** a template (`TemplateFinder`), bulk mail (`is_bulk`), and a message whose own text is empty after extraction.
- Rows are consumed as they're read and pruned at 3 days, like `ai_new_mail`.

### 3. The worker

`FollowupWorker` in `packages/backend`, in `SummaryWorker`'s shape and with plan 132 revision 4's states and failure table: runnable, waiting for a body, paused. Woken by ingest, op completion and startup. No timers when empty. A new background task in `AiLimiter`: 200 requests and 400k input tokens a day.

**The task.** `AiTasks.readSentMail`, structured output through the ladder, `effort: low`:

```ts
interface SentMailInput {
  ownText: string;            // what you wrote, ≤ 1,500 tokens
  answering?: string;         // the message it answers, quotes stripped, ≤ 800 tokens: "sure, will do" means nothing alone
  subject: string;
  recipients: { label: string; name: string }[];  // r1, r2: no addresses
  attachments: string[];      // file names: "here's the contract" may keep a promise
  openPromises: { label: string; text: string }[]; // p1, p2: this thread's, to judge whether this message keeps them
  sentAt: string;             // weekday, date and time, in the user's time zone
  language: string;           // the app's: the short text is for the reader
}
interface SentMailResult {
  promises: { text: string; quote: string; to: string | null; due: string | null }[]; // ≤ 3
  expectsReply: boolean;
  awaiting: string[];         // labels of who should answer
  kept: string[];             // labels of open promises this message keeps
}
```

**Checks, local, before anything is stored:**

- **`quote` must appear in `ownText`,** normalized. A promise with no real quote is dropped, so the model can't invent one.
- **`due` must parse** as `YYYY-MM-DD`, on or after the sent date and within a year. Otherwise it counts as undated.
- A `to` or `awaiting` label that isn't in the input is dropped. An `awaiting` that leaves nobody who is a person cancels the wait.
- A `kept` label that isn't in the input is ignored. Never closes on doubt.

Mail is in delimited blocks, as material, and the prompt is frozen and versioned (plan 85 revision 10). No tools. The worst an injected instruction can do is add a row the user dismisses, and the quote check limits even that to the user's own words.

**Provider and model.** `AI_TASK_NAMES` gains `followup`: the summary row's target if one is set up, else `claude-haiku-5-5` on Anthropic, `gpt-6-luna` on OpenAI, else the configured model. The switch's hint names it, and a default never moves mail silently (plan 131 §2). About $0.0003 to $0.001 a message (plan 132's figures for a similar request), so pennies a month.

### 4. Data

```sql
CREATE TABLE followups (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,          -- the message it came from; no cascade: losing the copy doesn't erase the promise
  kind TEXT NOT NULL CHECK (kind IN ('promise','awaiting')),
  text TEXT NOT NULL,                   -- "Send the contract", in the app's language
  quote TEXT,                           -- your words, for a promise
  person_name TEXT, person_email TEXT,
  sent_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  dated INTEGER NOT NULL DEFAULT 0,     -- the promise named a date
  state TEXT NOT NULL CHECK (state IN ('open','due','done','dismissed')),
  closed_reason TEXT,                   -- replied, kept, user
  closed_at INTEGER,
  from_scan INTEGER NOT NULL DEFAULT 0, -- found by the 30-day check: never jumps or notifies
  model TEXT, provider TEXT, prompt_version INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX followups_active ON followups(due_at, id) WHERE state IN ('open','due');
CREATE INDEX followups_thread ON followups(thread_id, state);
```

- Same table in `packages/idb/src/schema.ts`, with the cascade. Shape-only migration, empty.
- **Merges** move rows to the surviving thread, as `reminders` do. Identical `quote` on one thread is one row, so a re-read can't double it.
- **Bounds:** at most 1,000 active rows (past that the newest undated `awaiting` isn't added, and a promise replaces the oldest `awaiting`), and closed rows kept 90 days in a background slice.
- **Clear AI data** empties it. Not exported, not synced, not in search, not on `MCP_ALLOWED`. An import doesn't carry the setting or the rows.

### 5. When things come due

All at local time, from a pure function in `@terno/core` (`followupDue`), tested across days and DST like `remindPresets`:

| Case | Due |
|---|---|
| A promise with a date | That day at 9:00 (`REMIND_MORNING`) |
| A promise for today, written after 9:00 | Today at 17:00; written after 17:00, tomorrow at 9:00 |
| A promise with no date | 3 days after sending, at the next 9:00 |
| Awaiting a reply | `followups.nudgeAfterDays` after sending (default 5; 3, 5, 7 or 14), at the next 9:00 |

**One timer,** `armFollowups`, for the soonest `open` row, re-armed by the same events as `armReminders`: start, wake, changes. At the moment it fires, in one store unit:

1. The row becomes `due`.
2. Unless it's `from_scan`, a plan 87 reminder is added with `kind: "followup"`, `dueAt` now, and `ifAbsent`, so a reminder the user set is never replaced. The cap refusing it leaves the row in the list, due, with no jump.

So the Inbox's top, ending on open, archive and undo all stay plan 87's code, with one new kind. Pending follow-ups have no reminder row, so they add no bell to any list and don't crowd the Reminders list.

**Notification.** A due promise says so through plan 87's path: "You told Tom you'd send the contract" and the subject, under the same settings. With "Show sender and subject" off: "A promise is due". Several together: "3 promises are due". **A nudge doesn't notify:** it's not a thing you must do, the user chose this. Once each, by `notifiedUpTo`.

### 6. How one ends

- **Awaiting:** any message after `sent_at` not from one of your addresses, on the thread or naming your message in its references (plan 17 revision 7), not a draft and not spam or trash. `closed_reason: replied`. Checked with plan 87's `answered` on the budgeted slices it already runs, plus a follow-up's own thread on `notifyChanged`. **A later message of yours** on the thread also closes it, and the worker decides afresh whether that one waits, so a nudge starts a new wait.
- **Promise:** `kept` from the model, on a later message you send on that thread. `closed_reason: kept`. A later message never closes a promise on its own, because "sorry, need one more day" is not keeping it.
- **By you:** **Done**, **Not a promise** / **Dismiss**, and **Later** (plan 87's picker, moves `due_at`). Each has a snack with Undo, restoring the exact row.
- **Moves:** archive doesn't close it (it ends the Inbox row, as plan 87 does, and the list keeps it). A thread in Trash or Spam doesn't show, and comes back with it. A deleted thread cascades.
- **Opening** ends the Inbox row, not the follow-up.

A row that ended by itself reverts with no fuss: nothing to undo, no snack.

### 7. Where it shows

**The Inbox's top.** Due rows join the Reminders group. In place of the snippet, the row says it, in the attention ink: "You told Tom you'd send the contract by Friday" or "Ana hasn't replied in 5 days". `useFollowups` (threadId → active rows), filled at boot and by a `followups` event like `useReminders`.

**The Follow-ups list.** A row under More, after Reminders (`nav-followups`), which like Reminders also shows when More is closed and something is due, with a count in the unread tone. App state gains `followups: boolean`, like `reminders`: no select-all scope, no quick filters, one bounded page.

```
DUE
  Tom Reed     Send the contract · by Fri        Today
  Ana Ruiz     No reply in 5 days · Nudge        Today
COMING UP
  Greenway     Confirm the renewal               Mon 9:00
```

Ordinary rows, so j/k, the reader and menus work, with Done on `d`-free keys: a row action and the menu. Empty: "Nothing to follow up. Terno keeps track of what you promise and who owes you a reply."

**In the thread.** A quiet line in the conversation's text column, in the position the summary block uses, above it when both are there. No box, a hairline, and aligned with the messages:

```
You told Tom you'd send the contract by Friday  →
Done · Not a promise · Later
```

`→` scrolls to the message and expands it. The tooltip shows the quote. A nudge reads "Ana hasn't replied in 5 days" with **Nudge** · Dismiss · Later.

**Nudge** opens the inline reply, with the one-tap draft running on the fixed instruction "a short, friendly nudge about my last message": To is who it's waiting on, the ordinary composer, one undo step, and nothing is sent. The strip is plan 133's, unchanged. It spends a foreground permit, because you asked.

**A tip** (plan 113), `followups-first`, shows the first time a follow-up appears on an open thread, with a picture of the line. Never on the first day of the 30-day check.

### 8. Settings and turning it on

**Settings → AI → Follow-ups:** a switch, "Keep track of what I promise and who owes me a reply", off by default, with the hint: "Sends the text of each message you send, and the message it answers, to {provider}." Then the provider and model row, and "Nudge after": 3, 5, 7 or 14 days. **Settings → Accounts:** "Track follow-ups in this account", on by default. Disabled with a pointer until a provider is set up.

**On turning it on,** one inline line, shown once:

> Check the last 30 days too? {n} sent messages, about {cost}. · **Check** · **Not now**

- `{n}` counts local sent mail in the last 30 days with §2's exclusions. `{cost}` shows only for a known price (plan 133 §4).
- **The check** goes through the worker as background work, capped at 300 messages, and stays under the daily ceilings.
- **Its rows are `from_scan`:** they go to the list only, with no Inbox jump and no notification, so day one isn't a flood. A promise overdue by more than 7 days, or a wait older than 14 days, isn't added: that's over.
- **Replies already there count:** a wait answered since is never added.

**Off** stops the worker and the timer, drops pending markers, and hides the row, list and lines. Rows stay until Clear AI data, so turning it back on loses nothing. Reminders it already added stay, as any due reminder does.

**Local provider:** works, one at a time. **Provider gone or key removed:** the worker pauses, what's already tracked keeps coming due, and Settings says why.

### 9. Copy

`t()` and `L()`, `en` and `es` together. Sentences are the app's, with the model's short `text` inside: "You told {name} you'd {text}" doesn't translate well, so the model's `text` is written as a noun phrase of the action and the line is built per language with `es` keys of its own. Plurals through the catalog. Nudge's instruction isn't translated: it talks to the model, and the draft's language follows plan 133.

## Tests

- **Core:** `followupDue` across weekdays, times, DST, same-day and past dates, with the time zone set.
- **Conformance, both stores:** marker on live sent mail and on send op completion; none for first sync, backfill, import, demo, drafts, forwards, or with the setting off; a marker and a re-ingest don't double; a failed or undone send marks nothing; cascade, merge, prune, bounds; `ifAbsent` keeps a user's reminder; `from_scan` adds no reminder.
- **Worker (fake provider):** a quote not in your text is dropped; bad date becomes undated; unknown labels dropped; a template and bulk mail aren't read; `auth` pauses and a settings change resumes; daily ceiling; off mid-drain sends nothing further; no timer while empty; every `AiErrorKind`'s transition.
- **Ending:** a reply closes a wait, one from yourself or in Spam doesn't; a reply in another Gmail thread by references does; your later message closes a wait and starts a new one when it expects a reply; `kept` closes a promise and a later unrelated message doesn't; Done, Dismiss and Later with exact Undo.
- **Timer:** with fake timers, nothing until due, then the row, the reminder and the event; wake re-arms; `stop()` clears; notification once across a restart; promise notifies and a nudge doesn't.
- **Scan:** the count and exclusions; nothing sent on Not now; capped; rows stay out of the Inbox and notifications; overdue and stale rules.
- **e2e (`followups.spec.ts`):** send a promise through the fake, the row appears in Follow-ups; made due, it's on top of the Inbox with its line; opening ends the Inbox row and the list keeps it; Done and Undo; the thread's line and `→`; Nudge opens a draft and nothing is sent; the 30-day offer; turning off hides everything; en and es; axe light and dark. `@design` for the thread line and the row's text, with screenshots looked at beside their neighbours in each design.
- **Eval (real model, gated, synthetic):** `scripts/ai-real/followups.real.ts`: about 150 sent messages in English and Spanish, with labelled promises, non-promises, thanks, FYIs and dates ("el viernes", "next Tuesday", "end of the month" across a month's edge). Measures: precision and recall of promises and of `expectsReply`, right dates, `kept`, cost. **Precision outranks recall on `awaiting`,** recall outranks precision on `promise`: a false row costs a click, a missed promise is the failure this exists for.
- **Release gate:** a run on a copy of a real profile, read by the owner, as plan 133's was.

## Performance

- **Off:** one boolean at ingest and op completion. **On:** one indexed insert per sent message.
- **Reads hold at 50k+ threads in both stores** (`followups.perf.test.ts`): the active list and `useFollowups` ≤ 5 ms at 1,000 rows, `armFollowups` one indexed probe, `answered` over 1,000 rows on budgeted slices as plan 87 gates it. `load.perf.test.ts` unchanged with the feature on.
- **Migration ≤ 1 s:** empty tables.
- **Lazy:** the list and thread line are their own chunk. Entry chunk unchanged except an icon if one is new.
- **Idle:** one timer for the soonest due row, none when there are none. The worker sleeps on an empty queue. No polling.

## Out of scope

Their promises to you (the user's choice; the same worker could read inbound later). Sent mail with no text. A row for attachments you forgot. Sending a nudge by itself. Calendar events. Editing the promise's text. Shifting due dates off weekends. Sharing with Pro gating, which arrives with plan 85.

## Order

1. Tables, marker in both stores, conformance, migration gate.
2. `readSentMail`, prompt v1, checks, fake, contract tests, eval.
3. `FollowupWorker`, limiter task.
4. `followupDue`, `armFollowups`, the reminder kind, notification.
5. Ending: replies, `kept`, actions and Undo.
6. The Inbox line, the Follow-ups list, the thread line, Nudge.
7. Settings, the 30-day check, copy, the tip.
8. Real run and the owner's read.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, `/tmp/terno-plans-141-145/142-promise-tracking.out`) raised 12 points, all accepted. Each replaces what the sections above say.

1. **Injection can do more than add a row.** §3's claim is wrong: `kept` closes promises, so an instruction in `answering`, a subject or a file name could hide real obligations. `kept` becomes `{ label, evidence }`, and `evidence` must appear in the new message's `ownText`, the user's own words. A closure applies only to the exact open row sent, conditionally. Adversarial tests try to close every label.
2. **A thread is read in order.** `SummaryWorker` skips what's waiting for a body and carries on, which here would read "Here's the contract" before the promise it keeps. Markers on one thread run oldest first, and one waiting for a body holds later ones on that thread only. The 30-day check replays the same way. `finish` is atomic and rechecks the source, replies and sends since, and the affected rows' revisions, as summaries' writes do.
3. **Only a confirmed send closes a wait.** Both stores write the local message as sent before its op runs (`sql-store.ts:1041`, `store.ts:1687`), so a sweep reading `is_sent` would close a wait during Undo Send, offline queueing or a permanent failure. Your own message closes a wait in the transaction that records the confirmed send, and the sweep ignores your messages. Tests: Undo Send, offline, failure, each with a wait open.
4. **`answered` isn't reusable.** Plan 87's filters to `noReply` on one `thread_id` (`db/reminders.ts:61`, `idb/reminders.ts:52`), and plan 17's reference lookup asks the opposite question. A dedicated indexed `followups.answered` in both stores uses `sent_at` and the source's RFC Message-ID through `message_refs`. The row keeps `rfc_message_id`, since its source may go.
5. **A follow-up has its own way onto the Inbox's top; it doesn't use a reminder row.** This replaces §5's step 2, and the `followup` reminder kind goes. With one reminder slot per thread and `ifAbsent`, a promise due today on a thread reminded for next month would get neither its Inbox row nor its notification, and Done or Later couldn't stay exact across two tables. A row gains `inbox_state: 'none' | 'onTop' | 'seen'`. The Inbox's top merges due reminders with `onTop` follow-ups, one row per thread, under the same heading. Opening, archive, trash, spam and moving to a hidden category set `seen`, through the shared dwell (plan 144 revision 9) and `actOn`'s ending path, journaled for Undo. Manual reminders are never touched, and several follow-ups on one thread coexist.
6. **Undo and Later are one journal entry on the row:** state, `due_at` and `inbox_state`, restored conditionally so another window's change survives. Later sets `open` and `none`, so the timer sees it again.
7. **Notifications are their own kind.** `announce()` takes every newly due reminder and drops its metadata, and `reminderNotice` counts threads (`reminders.ts:174`, `attention.ts:111`). `MailNotice.kind = "followup"` carries the promise's text with redaction under the same setting, for promises only, in `apps/desktop/src/attention.ts:38` and the web. `notified_at` per row, not one `notifiedUpTo`, so two promises on one thread each say so once.
8. **The monthly ceiling must see it.** `monthBackgroundUsd` sums a hard-coded three tasks (`ai-limiter.ts:353`). It's derived from the background-task registry, tested with mixed spending. This lands once, with the first of plans 142, 144 and 145 to be built.
9. **The marker carries its queue.** `ai_sent_mail` gains `queued_at` and `source: 'live' | 'scan'`. Scan rows are the bounded 300 the user agreed to, expire 14 days after queueing rather than at 3 days, and survive a restart and a daily limit. A test holds it.
10. **One row per thread.** The list keys on `ThreadSummary.id` (`list.ts:57`, `thread-list.tsx:675`), so lists show a thread once, with its most urgent obligation and "+1". The thread's line lists each with its own Done, Dismiss and Later. Tests cover keyboard and actions with several on one conversation.
11. **Identity is the source, not the words.** The same sentence on two messages is two promises. A row is unique on `(message_id, item)`, with one `awaiting` per source message. Results, closures and consuming the marker commit together, including when nothing was found, so a crash can't redo or lose it. A merge dedupes on that identity.
12. **Every input has a limit.** At most 20 recipients and 10 file names at 120 characters, 10 open promises (newest first), and a subject of 200. The output's reservation and the ladder's schema and repair text fit the session's capacity (`summaryBudget`). Tests on a small window through fallback and repair.

## What building it changed

- **The row's text is a verb phrase, not a noun phrase.** §9 asked for a noun phrase, but "You told Tom you'd {text}" and "Le dijiste a Tom que ibas a {text}" both need the base form of the verb, so the prompt asks for "send the contract" / "enviar el contrato". The line's own words are still each language's.
- **`followups` is an early table on IndexedDB,** because the Inbox's top reads it before messages load, as reminders do.
- **A confirmed send closes waits with `closed_reason: superseded`,** so a list of closures can tell it from a reply.
- **Later is a small menu of the reminder presets,** not plan 87's dialog, which only knows reminders.
- **The monthly ceiling sums `DAILY_REQUESTS`' keys** (revision 8), so plans 144 and 145 get it by adding a line.
- **The shared dwell** (`lib/open-dwell.ts`) landed here for plan 144 revision 9, and reminders moved onto it.

## What the code review changed

Codex raised 14 points, all fixed, each with a test.

- **Consent runs from `enabledAt`,** at the mark and again before the request. What was sent earlier takes a check's yes.
- **A read belongs to the provider and the account:** a provider change, a key or the account's switch aborts it, and a late answer writes nothing.
- **A check takes only confirmed sends.** A queued or failed copy has `local:` as its id, and may never have gone.
- **Filing and folder moves keep the top in their Undo,** as an archive does.
- **What a reply answers is its `In-Reply-To`,** and only without one the newest message before it.
- **Off leaves the list at once, in every window,** and the Inbox's top reloads.
- **The wide row says what's owed too;** a follow-up's date is when it's owed, in the row and on the thread's line.
- **Selected rows use their own ink** (AA), and `primary` on `row-hover` is in the contrast suite.
- **A rate limit has its one timer,** cleared by stopping and by Settings.
- **A quit between coming due and saying so says it on return:** what's announced is what's due and unsaid.
- **A small window holds the repairs too:** the prompt, two bad answers and the last answer.
- **Settings says why it stopped,** with what to do.

A second round, on the fixes, raised 7, all fixed: an opt-out reaches a read still getting ready, and there's a last look before anything leaves; a reply naming a message we can't use gets no context rather than the wrong one; a validation's words are bounded in a repair (`ladder.ts`, for every task); a row's line uses Draft's ink, already gated on the row's every state, instead of a new pair four palettes failed; a reminder set for next month doesn't speak for a row a promise brought to the top; and Settings hears a failure while it's open.

## What the full run showed

`pnpm test:all` took 1,551 s on a machine with a load of 20 to 27 from other work, and exited non-zero: unit and perf failed twice under that load. Those failures were re-run alone and passed: unit's attachment conformance, checkpoint and facts files (1,280 tests), and `expunge`, `writing` and `search-everywhere` (10 tests). Nothing that failed touches Follow-ups. An earlier run found two real problems, both fixed: a settings object with no `followups` crashed the list, and the gate's fixtures took a mailbox snapshot per row.

## What the eval and the panel changed

Real models, on a copy of one real mailbox (5,939 threads, three accounts, Spanish and English) with its keys and queued work removed, read by five reviewers with different concerns: a fact auditor, a busy owner, a safety hawk, a bilingual editor and a recall PM. Four rounds, each reviewer blind to the others. No mail is recorded here. The owner's read is still theirs.

- Prompt version 4. Reviewers held the read to one test: if it went quiet, would anybody notice?
- **What changed:** accepting an offer whose next step is theirs, and sending what someone needed in order to act, both expect a reply ("quedo a la espera" among them), with those two as examples. An open offer doesn't. What they take on ("de nuestra parte", "vamos a revisar") is a promise, each item of a list its own, while what someone else has under way isn't. Nobody is awaited from an automated address.
- **Limit:** a conditional offer in a pitch can read as firm. It stayed split on the last read.
