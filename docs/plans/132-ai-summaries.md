# Plan 132: AI summaries of new mail

- **Status:** built and on `main`, code-reviewed, and run on real mail (see "What building it changed", "What the code review changed" and "What a real mailbox changed"). The scripted eval (`scripts/ai-real/summaries.real.ts`) is written, and this plan records no run of it.
- **Builds on:** plan 131 (base), plan 85 §6 and revision 9 (changes noted below), plan 116 (what "new mail" means), plan 36 (visible text), plan 112 (migrations).

## The request

> for ai summaries, only new emails get summaries, and of course emails not categorized as spam.

> for the summary limits, do allow the user to manually trigger a summary for older mail

> for summaries we'll use gpt luna.

Earlier, from plan 85's document: "Highlight important decisions, dates, action items and unanswered questions. Cache summaries locally so you don't pay for the same summary repeatedly."

## What exists

- **Plan 116 already defines new mail,** and the ingest path carries it: `Core.ingestSliced` passes `live`, and `sync.ingest` marks eligibility in the same commit as the messages (`forwardEligible`, `sql-store.ts:632`, `core.ts:1167`). New means ingested by live sync (not the first sync, a window backfill, an import or the demo), no older than 3 days at ingest, and after the feature was turned on.
- `rootRefs` gives spam, trash, draft and inbox per thread; `aiCandidate` shows the pattern (`sql-store.ts:1299`).
- Visible text is stored (plan 36); `threads.get(id, { bodyFormat: "parts" })` and `bodyPrefix` give bounded reads. Bodies can arrive after the message row (`bodyCompleted`).
- `Conversation` renders below `ReaderHeader` (`reader.tsx`). Plan 15 dropped an "AI summary card" because the `sender-card` header has no slot for it: this plan doesn't put one there.
- No summaries, table or task exist.

## What changes from plan 85 §6

| Plan 85 §6 | This plan |
|---|---|
| On demand from the toolbar and palette for any thread | Kept, for any thread not in spam or trash (§7). Older mail is only ever summarized this way |
| Opt-in "summarize long threads when opened" | Opt-in "Summarize new mail", generated when the mail arrives. Nothing runs by itself on older mail |
| Long means ≥ 4 messages or ≥ 1,500 words | Any new inbound mail, except very short ones (§1) |

## Design

### 1. Which mail gets a summary

A thread gets a summary when a message arrives that is **all** of:

1. **New,** in plan 116's sense: live sync, date within 3 days at ingest, after the feature was turned on.
2. **Inbound:** not from one of the user's addresses, not a draft.
3. **Not spam, not trash.** Checked at ingest, again just before the request, and again before writing, because the user or Gmail can mark it spam in between.
4. **In the Inbox, and not in a Promotions or Social tab** (plan 86). Filing mail away is the user saying they won't read it closely; summarizing ads spends their money. Filters run first, so a filter that archives mail settles this.
5. **Worth summarizing:** the thread's visible new text is at least 60 words. A summary of three lines is longer than the mail.

A new message on an old conversation counts, and its summary covers the conversation, since that's what the reader needs. A message the user sent doesn't trigger one. Mail that was already here when the feature is turned on never gets one, so turning it on sends nothing old to the provider.

### 2. Turning it on

`AppSettings.summaries: { enabled: boolean; enabledAt: number | null }`, off by default, in Settings → AI under a "Summaries" group, with the provider and model row (plan 131 §2): GPT Luna on OpenAI by default. The hint says what it does: "Sends the text of each new conversation to {provider} as it arrives." It's disabled with a pointer to that row until a provider for summaries is set up, and with only another provider's key, the row asks: **Add an OpenAI key** or **Use {configured provider}**. It is one of the few features that sends mail with no click, so it's never on by default and never turned on by a tip.

### 3. Data

Migration (shape only, plan 112) and the same table in `packages/idb/src/schema.ts`:

```sql
CREATE TABLE ai_summaries (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending','ready','failed')),
  through_message_id INTEGER NOT NULL,   -- the newest message it should cover
  content_hash TEXT,                     -- of the text actually sent
  prompt_version INTEGER,
  language TEXT, model TEXT, provider TEXT,
  body_json TEXT,                        -- the validated result
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  generated_at INTEGER
) WITHOUT ROWID;
CREATE INDEX ai_summaries_pending ON ai_summaries(created_at) WHERE state = 'pending';
```

- **Queueing is durable and atomic:** a `pending` row is written in the ingest commit, the way `forward_eligible` is, so a crash or quit loses nothing. Passing `summaryEligible = live && summaries.isActive` keeps ingest free of work when off.
- **A newer message** moves `through_message_id` forward and sets the row back to `pending`. The old summary stays out of the UI until replaced, because it no longer describes the thread.
- **Bounds:** at most 5,000 rows, oldest `ready` first, pruned in a background slice. `pending` rows older than 3 days are dropped, so a long time offline doesn't produce a burst of work on mail the user has moved past.
- **Cleanup:** deleting a thread cascades. Merged threads keep the surviving id's row and re-queue only if a message in the merge was eligible. Removing an account cascades through its threads. Settings → Storage → Clear AI data empties the table. Not exported, not synced, not in search.
- **Moved to spam or trash after generation:** the reader doesn't show it; the row stays, so Not spam brings it back without a second request.

### 4. The work

`SummaryWorker` in `packages/backend`: drains `pending` through `AiLimiter` (plan 131 §5), oldest first, woken by ingest results and at startup. No timers when empty. Soft cap of 300 a day, after which rows wait for the next day's first wake-up.

For one row:

1. Re-check §1 (3) and (4) and the setting. If it fails, delete the row.
2. If a body isn't here yet, leave it `pending`; `bodyCompleted` wakes it. It never fetches a body by itself beyond what sync does.
3. Assemble: newest inbound message whole up to 4,000 tokens, up to the 12 newest others at 400 tokens each with quotes stripped, then from, date and snippet for the rest. Sized down with `Capabilities.contextTokens` as in plan 133 §1.3.
4. Hash what will be sent. If it matches a `ready` row at this prompt version, language and model, mark it ready with no request.
5. `forTask("summary").summarize(...)`.
6. Re-check, then write in one transaction, conditional on `through_message_id` not having moved. If it moved, drop the result and go again.

Failures: `rate_limited` and `unavailable` leave it `pending` for the next wake-up, up to 3 attempts, then `failed`. `auth` and `not_configured` pause the worker until settings change, without burning attempts. `refused` goes straight to `failed`. Nothing retries on a timer.

### 5. The task

```ts
summarize(input: { thread: ThreadText[]; language: string; today: string }, signal?): Promise<ThreadSummaryResult>;

interface ThreadSummaryResult {
  summary: string;                     // 1 to 3 sentences
  items: { kind: "decision" | "date" | "action" | "question"; text: string; message: string }[]; // at most 6
}
```

Structured output through the existing ladder, so it works on every provider with no streaming. Messages are labelled `m1`, `m2` in the prompt and mapped back; an item citing an unknown label is dropped, never shown unlinked. Mail goes in delimited data blocks and the system prompt says it is material, not instructions (plan 85 revision 10). `language` is the app's language, since that's who reads it. The prompt is frozen and versioned; `effort: low`.

### 6. In the reader

A quiet block between the header and the conversation, in the conversation's text column so it aligns with the messages:

```
Summary                                        ⌄
Ana can't make the 12th and proposes the 19th. She
needs the signed contract before then.
  Action   Send the signed contract            →
  Date     Meeting moved to 19 March           →
```

- No card, box or color: type and a hairline. A `Disclosure` from `packages/ui/BOARDUI.md`; the open or closed state persists per user, and it opens by default. `→` scrolls to the message and expands it, keeping focus and scroll rules.
- Provenance on the label's tooltip: "Written by GPT Luna, 3 March. It can make mistakes." Summary text is plain text, never HTML.
- While `pending`: nothing at all. It appears when ready, without shifting what the user is reading (added above the scroll anchor, as the thread's other late content is), and with no motion when reduced.
- `failed`: nothing in the reader. Settings shows the last error kind, so a bad key is findable.
- Every design: `@design` e2e, screenshots beside neighbours in light and dark. Lumen's `sender-card` is the case to look at first.

**Reads stay off the hot path.** The summary isn't in `threads.get`. A lazy component calls `ai.summaries.get({ threadId })` once a thread opens, an indexed primary-key read, renderer-only. An `aiSummary { threadId }` event with `origins: ["renderer", "dev"]` tells an open reader it's ready. Both stay off `MCP_ALLOWED`, since a summary is mail content. Reading is never gated (plan 85 revision 7).

### 7. Summarizing older mail by hand

Any thread that isn't in spam or trash can be summarized on request, whatever its age, and with the "Summarize new mail" setting off. This is the only way older mail gets a summary: there's no bulk action and nothing runs by itself.

- **Where:** a quiet `Sparkles` button in the reader's toolbar, labelled "Summarize", and "Summarize conversation" in the palette. Hidden in spam and trash, and when the thread has any spam message (revision 1 below). No default shortcut.
- **The limits that are automatic-only don't apply:** a request ignores the 3-day limit, the Promotions and Social rule and the 60-word minimum, because the user asked. Spam and trash still apply, re-checked before the request and before the write.
- **The request:** `ai.summarize({ threadId, requestId })`, renderer-only and cancellable (plan 131 §4), through the same `summarize` task, prompt and validation. It takes a foreground permit, so it doesn't wait on the queue, and it doesn't count toward the daily cap. On a local provider it shares the one slot (plan 131 revision 3).
- **In the reader:** the block appears at once at §6's position, reading "Summarizing… Stop" with `spinner.tsx`, and the result replaces it in place without moving what the user is reading. Focus stays put. Leaving the thread doesn't cancel it; the result is there on return.
- **Stored like any other,** in `ai_summaries`, with the same provenance, bounds and clearing. A hash match reuses a stored summary with no request (revision 5 below).
- **Staleness:** a new message hides the old summary as usual. With the setting on, the new message queues as new mail. With it off, the button reads "Update summary".
- **A worker row already running** for the thread is reused, not duplicated.
- **A body that isn't here yet:** the block says "Still downloading this message" and continues when it arrives, as the reader is already fetching what's open.
- **First use on a cloud provider:** one line in the block before sending, shown once per provider: "This sends the text of this conversation to {provider}." · **Continue** · Settings.
- **Errors** appear in the block with `errorHelp(kind)` and Try again. **No provider for summaries:** the block points to the row in Settings → AI.

## Tests

- **By hand (conformance, fake provider, e2e):** an old thread summarizes with the setting off; a short thread and a Promotions thread too; offered nowhere in spam or trash, nor with one spam message in the thread; marked spam mid-request writes nothing; cancel writes nothing; hash match makes no request; a new message hides it, and "Update summary" appears with the setting off; no daily-cap count; the worker and a request on one thread make one call; first-use line once per provider; no OpenAI key asks and sends nothing.
- **Eligibility (conformance, both stores):** live vs first sync, backfill, import and demo; 3-day limit; before `enabledAt`; own message; spam, trash and draft; Promotions and Social; filter-archived; under 60 words; new message on an old thread.
- **Spam at every check:** marked spam while pending, during the request (nothing written), and after (hidden; Not spam restores with no request).
- **Queue:** survives reopen; a newer message mid-request drops the result; prune and offline drop; cascade on delete and account removal; merge.
- **Worker (fake provider):** body arrives late; each error kind; `auth` pauses and settings change resumes; hash match makes no request; daily cap; turned off mid-drain sends nothing further; no timer while empty.
- **Task:** contract suite on every transport; unknown label dropped; injected instructions in mail don't change the output on the fake's scripted attack; canary absent from logs and MCP.
- **e2e:** turn on, new mail arrives, block appears; old mail has none; spam has none; link scrolls; en and es; axe light and dark; `@design`.
- **Eval (real model, gated, synthetic mail):** accuracy of items, invented dates and amounts, length, on GPT Luna.

## Performance

- Off: one boolean checked in ingest. On: one indexed insert per eligible thread, inside the ingest slice. `load.perf.test.ts` at 50k threads with the feature on, both stores, no regression.
- Migration ≤ 1 s at 50k threads: an empty table (`migrations.perf.test.ts`).
- Reader chunk unchanged: the block is lazy and adds no RPC until a thread opens.
- Idle means idle: the worker sleeps on an empty queue.

## Out of scope

Summaries of old mail in bulk or by themselves. Summaries in list rows or notifications. Streaming. Editing a summary. Pro gating, which arrives with plan 85.

## Order

1. Migration, IDB table, conformance.
2. `summarize` task, prompt v1, fake, contract tests, the eval.
3. Eligibility at ingest, `SummaryWorker`.
4. Settings group.
5. Reader block, events, e2e, screenshots.
6. Summarizing by hand (§7): `ai.summarize`, the toolbar button, the palette entry.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, against `f787771c`) raised 5 points on this plan, all accepted. Each replaces what the sections above say.

1. **"Never spam" covers the whole conversation.** `rootRefs` reports the earliest inbound message's flags (`packages/db/src/categorize.ts:86`, `packages/idb/src/categorize.ts:69`), so a later spam message can sit behind a clean root. The rule is per thread: a thread with any spam message (`hasSpam`, `queries.ts:42`) gets no summary, and any source in trash or marked spam is left out or stops it. Checked on the triggering message and every included source, before the request and before the write, in both stores. Tests cover a mixed thread.
2. **Eligibility is recorded on arrival, and the word count waits for the body.** The trigger is plan 131's `ai_new_mail` marker, written with the message whether or not its text is here yet. The 60-word check runs once the body exists. Both body paths wake the worker: sync (`core.ts:1804`) and a reader-triggered fetch (`core.ts:1687`). A later `setBody` never decides what's new.
3. **Staleness follows the sources.** `through_message_id` can't see a removed older message, a replaced body or a merge (`packages/db/src/ingest.ts:161`, `packages/idb/src/mail.ts:728`). The row keeps a `source_stamp` covering member ids and body versions, checked against the current thread before the write and before display. A mismatch hides the summary. Any source change invalidates; a merge always invalidates, and re-queues only if a message in the surviving thread still has a live marker. Otherwise the stale result goes.
4. **Blocked work can't stall the queue.** States are explicit: runnable, waiting for a body, and paused. A drain skips non-runnable rows in a bounded pass. Every `AiErrorKind` has a transition (`packages/core/src/ai.ts:47`): `rate_limited`, `unavailable`, `timeout` retry up to 3 attempts; `invalid_output` and `refused` fail at once; `auth`, `not_configured`, `blocked` pause until settings change; `cancelled` stays runnable with no attempt spent. Resumes come from existing events: connectivity, settings, body arrival. When rate-limited with work left, one timer to the limiter's next slot, and none on an empty queue.
5. **Reuse requires the same execution target.** The hash check in §4 compares provider and endpoint as well as model, since one model id can sit behind several (plan 85 revision 9). A reused result keeps its original provenance; a provider change never relabels it.

## What building it changed

- **Both a marker and a row.** `ai_new_mail` (the fact: this arrived as new mail) and the `pending` row (the queue) are written together in the ingest commit. `markNewMail` marks only what isn't spam, trash, a draft or from one of your addresses. The filter, tab and word-count checks wait for the worker, since filters run after the mark and text can come later.
- **The stamp is computed without reading bodies.** It hashes each source's id, `body_state`, capture id and `body_tail_norm`, all available in both stores with no body read. An inline body replaced by one with the same tail would go unnoticed; every other change hides the summary.
- **A dropped row keeps its result.** §4 says delete the row when a re-check fails. When the row held an earlier result, it goes back to `ready`, hidden by its stamp, and the marks go. That earlier result can then return with no request if the thread returns to the same text. A row that never had a result is deleted.
- **Failures hold the queue for a minute.** "Next wake-up" meant a burst of new mail could spend all 3 attempts in a second. After `rate_limited`, `unavailable` or `timeout`, new mail doesn't ask the provider again for 60 s. The network coming back and settings changes end the wait, and the one timer of revision 4 is only armed for `rate_limited`. The pass ends at such a failure, so one down provider costs one attempt on one row.
- **A long conversation is capped.** "From, date and snippet for the rest" had no limit, so 1,000 messages would send 1,000 snippets. It keeps the newest 40.
- **`AiLimiter` counts by-hand summaries apart.** They used to land in the same day's tally as the worker's, which would have counted toward the daily cap. They now go under `byHand`, in the usage report but outside both ceilings.
- **`forTask("summary")` with no provider** now says `errors.ai.summaryProvider`, not the filter-worded message.
- **`AiTasks` gained `endpoint`** for revision 5's comparison.
- **The consent line is the backend's.** `ai.summarize` answers `{ status: "consent" }` unless the provider is in `settings.summaries.acknowledged`, and `acknowledge: true` records it. A hash match asks nothing, since nothing would be sent.
- **A waiting body is the renderer's to retry.** `ai.summarize` answers `waitingBody` and holds no state; the block asks again when the thread's messages change.
- **An import never turns summaries on:** `summaries` isn't in the import's settings keys.
- **The toolbar button gives way at the narrowest reader,** as Mark as unread does; the palette keeps it. Pressed while a summary shows, it opens the disclosure.
- **Scroll.** A result arriving above a scrolled reader doesn't move the text, through Chromium's scroll anchoring (e2e). Two limits: at `scrollTop` 0 the content below moves down, since the user is at the top and the block is what they asked for, and Safari on the web build has no scroll anchoring.
- **Memory on the web build.** `ai_summaries` is an in-memory table there like the others, so 5,000 results hold about 5 MB after boot. Only someone with the feature on for a long time gets near it.
- **Not built:** `load.perf.test.ts` wasn't extended. `ai-summaries.perf.test.ts` measures ingest on and off at 50k threads in both stores instead. The real-model eval is written (`scripts/ai-real/summaries.real.ts`), not run.

## What the code review changed

- **Two requests on a thread pay once.** The in-flight lookup and insert happen in `single()`, with nothing awaited between, so the callers' own awaits can't let a second through.
- **Clear AI data stops what's in flight.** It goes through the worker and aborts everything, requests by hand included. `finish` refuses a write that started before the clear (`clearGeneration`, checked inside the transaction in both stores, in memory because nothing in flight outlives the process), so a model that ignored the abort still brings nothing back. To the person who asked, that's a cancel.
- **A small window holds the whole prompt plus the answer.** It reserved 1,500 tokens while asking for 3,000 and sized only the bodies. `summaryBudget` gives the answer the full allowance or half the window, whichever is less, takes off the system prompt and what a server with no `json_schema` also gets, and the complete serialized prompt has to fit what's left: the oldest headers go first, then the oldest of the others, and only then the newest message's words. Labels are given last, so what's cited has no gaps. Below 250 tokens of room nothing further can be cut.


## What a real mailbox changed

33 real messages re-dated as just arrived, through the live ingest path, on GPT Luna: 23 summaries, and the 10 others were spam, under 60 words or not in the inbox, as designed. Turning it on over 6,000 threads read nothing old and spent nothing. A summary costs about $0.0002 to $0.001 and takes 3 to 6 s on Luna (about 2 s on Haiku).

It found one bug: the language came from the backend's `getLocale()`, which is English while the setting follows the system, since a backend can't see the system's. So a Spanish window got English summaries on desktop and web. It now reads the setting, then what the window reported (`app.locale`), as forwards do.
