# Plan 239: No daily AI limits, and What matters reads new mail first

- **Status:** built. "Revisions after the Codex review" override the sections before them.
- **Builds on:** plan 132 (the limiter), plan 204/210 (the dated reader and its marks), plan 211 (the check of mail already here).

## The request

Investigating why a "Reminder to Complete LOV Form Submission" (ESOF, a person by plan 17, never written to) wasn't in What matters on the owner's personal profile, the reader had stopped at 01:11 that day: `dated` had used 590,506 of its 600,000 daily input tokens (72 reads of about 8,200 tokens each), and 540 marks from plan 211's check (mail from Nov 12 on) sat ahead of the 60 live ones, oldest first. A live mark is pruned unread after 3 days, so at 72 reads a day that email would most likely never have been read. The owner:

> lets completely remove these daily limits we have, that's just annoying, lets process everything, make it something very big that would prevent like a huge amount, lets do the new email first as you say.

## What exists

- **The limiter** (`packages/backend/src/ai-limiter.ts`): every background task has a daily ceiling in requests (`DAILY_REQUESTS`: summary 300, categorize 200, voice 60, followup 200, reply 100, digest 10, dated 300) and in input tokens (`DAILY_INPUT_TOKENS`: dated 600k, summary 1.5M, …). Past either, `DailyLimitError`; each worker (`summaries`, `followups`, `dated`, `today`'s digest, `replies`) stops until the next day. Separately: the monthly ceiling in US dollars on background AI (`ai.monthlyLimitUsd`, Settings → AI, default $10), and a shared pace of 20 background requests a minute (`BACKGROUND_PER_MINUTE`). The token ceiling is what binds: 600k / 8.2k ≈ 73 reads a day, the 300 requests never reached; the day cost $0.06.
- **The marks** (`ai_dated_mail`, both stores): `live` (ingest, kept 3 days, `DATED_MARK_MS`) and `scan` (the check, 14 days). `marks.page(after, limit)` reads them oldest first by `(arrived_at, message_id)`; `DatedReader.pass` walks the pages, holding a thread and a sender behind a message waiting for its body (revision 5), because a later message of the conversation or the sender may settle an item an earlier one made ("Paid in full"): reading out of order would leave it open.
- **The reader's limited state** (`DatedReader.limited`): set by a daily or monthly limit, never shown (`status()` reports only `paused`).

## Design

### 1. No daily limits: a runaway guard

The per-task daily ceilings become one guard, the same for every task: **10,000 requests and 100 million input tokens a task a day** (`DAILY_GUARD`). Nothing a mailbox does on purpose reaches it (the check of 14 days of a busy mailbox is a few thousand reads); it stops a fault (a loop re-asking the same mail) from spending without end. `DAILY_REQUESTS`/`DAILY_INPUT_TOKENS` go; `BackgroundTask` keeps its registry (what the monthly ceiling sums) as a list.

Unchanged, on purpose:
- **The monthly ceiling** is the user's own setting (Settings → AI), the one money limit. It isn't a daily limit and stays.
- **The pace** (20 background requests a minute, shared) keeps a provider's rate limits and the machine calm. It delays, never drops: 540 marks drain in well under an hour, most of them dropped without a request.

The guard's copy (`errors.ai.dailyLimit`) says what it now is: "Terno paused automatic AI for today after an unusually large amount of work, so a fault can't keep spending on your key. It continues tomorrow." (es alike).

### 2. New mail first

`marks.page` reads in two **lanes**: lane 0 is every live mark, with the scan marks of a conversation or a sender that has a live mark (so a conversation and a sender are still read oldest first: what settles an item is still read after it); lane 1 the rest. Within a lane, oldest first as now. The key becomes `(lane, arrivedAt, messageId)`; `DatedMark` carries its `lane`.

- **The sender** is matched by `lower(trim(from_email))` of the marks' messages (the stores' own column; `addressKey`'s `+tag` folding is left out: a `+tagged` variant of a live sender is read in lane 1, oldest first, which is the order of today).
- **Bounded:** the marks are at most 3 days of live mail and `DATED_SCAN_MAX` scan marks an account; each page reads the table once, joined to `messages` by primary key. SQLite: one statement with a CTE of the live marks' threads and senders; IndexedDB: the same over its `ai_dated_mail` store and `messages` by key. No schema change.
- **New mail during a long pass:** a live mark ingested while the reader walks lane 1 is behind the pass's cursor. `wake()` already sets `again` while a pass runs; the pass now returns before reading a lane-1 mark when `again` is set, so the drain starts over from the top and reads the new mail next. Holds are per pass and cost nothing to rebuild (a body not here is a hold with no request).
- A mark's lane can change between pages (its live peer consumed): it's then read later in the same pass or the next, never twice (each read consumes it, and a held thread stays held for the pass).

### 3. The reader says when it's stopped

`DatedReader.status()` reports a daily guard or the monthly ceiling as `blockedBy` (as `summaries` does, with its `limit`), so wherever the reader's status shows, it says why What matters stopped. Cleared as now: the next day, or a settings change.

## Tests

- **Limiter** (`ai-limiter.test.ts`): a background task runs past the old ceilings (301 summaries, 700k dated input tokens in a day); the guard stops a task at `DAILY_GUARD` requests and at its tokens, and starts again the next day; the monthly ceiling as before; the recheck-after-waiting tests at the guard.
- **Store conformance** (`conformance/dated.ts`, both stores): live before scan; a scan mark of a live mark's conversation, and of its sender, in lane 0 and older first; paging by `(lane, arrivedAt, messageId)` strictly after a key; the old "oldest first" case updated.
- **Reader** (`dated.test.ts`): with an older scan backlog, a live message is read first; a live message arriving while the pass is in lane 1 is read before the rest of the backlog; a sender's older scan message is read before their live one; status shows the guard.
- Typecheck and lint; the unit files above; `today.perf.test.ts` reads marks (unchanged order of cost).

## Performance

`marks.page` reads a bounded table (3 days of live mail, the checks' caps) once a page, as before, now joined by primary key to `messages`; no read of the mailbox. No new timers; no work while idle. The guard and the monthly ceiling are the same constant-time checks.

## Out of scope

- The 3-day keep of an unread live mark (it's reached now only when the provider fails for 3 days; plan 204's choice).
- The pace of 20 a minute, the monthly ceiling, and how a check picks its mail.

## Revisions after the Codex review

Codex (read-only) raised 8 points against the plan; all but one are taken.

1. **Lanes must be transitive.** A and B in one conversation, B and a live C from one sender: B came forward and A didn't, so B could settle A before A's item existed. Taken: `markPage` (`@terno/store`, one rule for both stores) joins conversations and senders by union-find; every mark in a chain with a live mark is in lane 0. Conformance covers it.
2. **`+tag` folding.** Taken: the sender is `addressKey(from_email)`, computed in JS in both stores (SQLite reads `from_email` by join, IndexedDB by key), so scheduling, holds and settling agree.
3. **Promotions behind a lane-0 cursor.** Taken: the check runs before every mark, not only lane 1. Once per wake while a pass runs, the reader orders the queue again and starts over when a lane-0 mark it hasn't seen is new to the pass or now reads before the next mark (`newMailBefore`). Only unseen marks count, so a stream of wakes (bodies arriving) can't starve the rest.
4. **A check's request already waiting for a permit goes first.** Declined: the new mail then waits for one request (at most the minute's pace). Making the wait give way would mean a "yield" between the limiter and the reader for one request's delay.
5–6. **Each page ordered the whole queue.** Taken, with a different shape: the pass orders the queue **once** (`marks.page(null, Infinity)`) and walks that list, plus once per wake while it runs (point 3). At 5,000 marks that takes about 10 ms on SQLite (a join by primary key, then the ordering, linear), so it isn't per page any more. Perf gates in both stores time ordering a busy queue (3,000 marks: nine accounts' checks and three days of new mail) within the slice's budget on SQLite and a frame on IndexedDB. Storing the sender on the mark would remove the join, but it needs a migration with an SQL `addressKey`; not worth it at these sizes.
7. **The status must say it.** Taken: `dated.status` and `datedStatus` carry `limit` ("daily", "monthly"), Settings → AI shows the limit's own sentence instead of the provider's help, and the reader announces entering and leaving the state (a settings change clears it and says so).
8. **"It continues tomorrow" needs a wake.** Taken: the midnight call (`daily()`) wakes a reader stopped on an earlier day.

## Tests as built

- `ai-limiter.test.ts`: past the old ceilings (301 summaries; What matters' 700k tokens); the guard by requests and by tokens, one task's own, gone the next day.
- `conformance/dated.ts` (both stores): new mail first with its conversation's and sender's older marks (a `+`-free spelling of the same address), strictly after a key, and back to the check's order once the new mail is read.
- `dated.test.ts`: new mail arriving while a check's first mail is being read is read before the rest; a sender's older mail is read before their new mail (fails without the sender chain); the guard's status and the next day's start with no mail.
- Perf: `store.perf.test.ts` and `idb.perf.test.ts`, the queue's ordering.
