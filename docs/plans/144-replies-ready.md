# Plan 144: Replies ready

- **Status:** built and on `main`, code-reviewed in two rounds (see "What building it changed" and "What the code review changed"). The real-model eval (`scripts/ai-real/replies-ready.real.ts`) is written and not run: it and the owner's read wait for the owner's go-ahead. The full suite runs once, after plans 141 to 145 are all in (the owner's call). "Revisions after the Codex review" overrides the sections before it.
- **Builds on:** plan 133 (drafting, voice, the composer's commit, the strip, provenance), plan 17 (`waiting_since`), plan 87 (`noteOpen` and the dwell), plan 132 (how a late block joins the reader, `source_stamp`), plan 131 (AI base).

## The request

> **Replies ready when you open a thread:** threads that need an answer already have a draft in your voice, and nothing is sent. This builds directly on plan 133.

## Decisions (the user, 2026-11-05)

| Question | Decision |
|---|---|
| When it's written | **When you open the thread.** It streams in as you read; first word about 0.9 s, finished about 1.7 s (plan 133, measured). Nothing goes out for mail you never open |
| How it looks | A quiet reply block below the last message. It isn't a draft until you use it |
| Which threads | Plan 17's "waiting for your reply", then a cheap model check that drops "thanks!" and FYIs |

## What changes from plan 133

Plan 133's "Out of scope" lists "Auto-drafting on open" and §6.4 says "No pre-warming, which would send mail before the user asked". This reverses both, **behind a switch that's off by default**. Everything else about a draft stays plan 133's: its prompt, voice, checks, provenance and "nothing is ever sent".

## What exists

- **`ai.compose`** (`contract.ts:1122`) streams a draft to its connection, given `accountId`, `kind`, `threadId`, `answeringMessageId`, `to`, `cc`, `session`, `timezone`. An empty `instruction` "answers what the thread needs": the one-tap draft. A `session` holds the assembled context for refinement.
- **`autoRecipients`** (`apps/web/src/lib/compose-fields.ts:73`) works out To in the renderer. So does `openCompose`, with its explicit outcome seam (plan 133 §5.2).
- **`lib/ai-draft.ts`** commits generated text as one undo step, with the strip, the placeholder selection, the send guard and `writing.commitGeneration` (provenance).
- **Plan 87's open:** `noteOpen(id)` from explicit paths, and a 450 ms dwell. Automatic selection and moves aren't opens (revisions 2 and 3).
- **`waiting_since`** on the thread and `waitingSince` on `ThreadSummary`, 30-day window at read time.
- **Reader blocks:** the lazy summary block joins without moving what's read (plan 132 §6, scroll anchoring). A prepared reply goes **below** the last message, so it moves nothing above it.

## Design

### 1. When it runs

All of these, at the moment the dwell ends on an explicit open, in the renderer's check and again in the backend:

1. **The switch is on,** and this account hasn't opted out.
2. **The thread is waiting:** `waitingSince` within `WAITING_WINDOW_MS`. A local fact, free, and false for most threads.
3. **Nothing's in the way:** no saved draft on this thread, no composer open here, not in Spam or Trash, and in the Inbox or a category. Plan 17's fact covers "a person, you're in To, unanswered".
4. **Nothing's stored for this exact state:** no row at the current `source_stamp`. So reopening costs nothing, whatever the row says.
5. **The newest inbound body is here.** Otherwise it waits: `bodyCompleted` continues it if the thread's still open.

j/k through the list passes each thread by in under 450 ms, so it spends nothing. Split's auto-select of the first row isn't an open, so launching the app spends nothing.

### 2. The check

`AiTasks.needsReply`, on a cheap model on **the drafting provider**, so turning this on doesn't add a second place mail goes: `claude-haiku-5-5` on Anthropic, otherwise the writing model.

```ts
needsReply(input: { from: string; subject: string; newest: string /* ≤ 800 tokens, no quotes */; lastFromYou?: string /* ≤ 200 tokens */ }, signal?): Promise<{ needsReply: boolean }>;
```

A "no" is stored (`state: 'skipped'`), so the block never appears and a reopen sends nothing. About $0.0001 on Haiku 5.5. A failure of the check counts as no block and no retry: nobody asked for this, so it stays quiet.

### 3. The reply

- **The renderer asks,** because it holds the recipients: `ai.prepareReply({ requestId, threadId, accountId, to, cc, answeringMessageId, timezone })`, renderer-only, cancellable. `to` is what `r` would do: `autoRecipients`.
- **The backend runs** the check, then plan 133's assembly and `compose` with an empty instruction, and streams `aiReply` events to that connection.
- **Consent:** the switch is the consent. It runs with whatever voice exists: habits and phrases, messages to this person, the model profile only if "Learn my style" was accepted. It never starts the learning job. The block says what it had, as the strip does ("You haven't written to Ana before").
- **Limits:** this is automatic spending, because nobody asked for each one. A new background task, `reply`: 100 requests and 800k input tokens a day, and the monthly limit applies. It takes priority over the queue and shares the one slot on a local provider. Past a limit: no block, and ⌘J still works.
- **Leaving the thread:** before the first word, cancelled. After it, it finishes and is stored, since it's paid for. A provider change, the switch going off, or Clear AI data cancels and writes nothing (plan 132's `clearGeneration`).
- **Pressing ⌘J or `r` while it runs** cancels it. The person asked for something else, which proceeds as today.
- **Cost:** about $0.007 a draft on Sonnet 5.5 (plan 133, on real mail), only for threads you open that need one.

### 4. Data

```sql
CREATE TABLE ai_prepared_replies (
  thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  source_stamp TEXT NOT NULL,          -- plan 132 revision 3: any change to the thread hides it
  answering_message_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('skipped','ready','dismissed','used')),
  body TEXT,                           -- ≤ 20,000 characters
  evidence_json TEXT,                  -- what the strip says: levels used, thin evidence
  checks_json TEXT,                    -- plan 133 §6.7's line, if any
  to_json TEXT,                        -- who it was written for
  model TEXT, provider TEXT, prompt_version INTEGER,
  generated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

- **Not a draft.** It isn't in the drafts table, the strip above the list, any count, or the provider. Until Use, it's a cached suggestion.
- **Stale means gone:** a stamp mismatch hides it, and the next open starts over if the thread still waits. A thread you answered has no `waitingSince`, so nothing runs.
- **Bounds:** 200 rows, oldest first, in a background slice. Same table in `packages/idb/src/schema.ts`. Shape-only migration, empty.
- **Clear AI data** empties it. Not exported or synced, not in search, not on `MCP_ALLOWED`, never in logs. Merged threads drop the row.

### 5. The block

Below the last message, above the reply controls, in the conversation's text column, so its text lines up with the messages. No card or color: a hairline and type.

```
Ana Ruiz                                   9:12 AM
Can you make the 19th instead?
──────────────────────────────────────────────────
Reply ready · In your voice with Ana
Hola Ana, el 19 me viene bien. ¿A la misma hora?
Use · Dismiss
```

- **While it writes:** "Writing a reply…" with `spinner.tsx`, and the text streaming into place, batched per frame, with **Stop**. It appears only once the check says yes, so most threads never show anything. Nothing appears for a thread that doesn't need it, and focus never moves.
- **Long replies:** 6 lines, then **Show all**, a `Disclosure`.
- **Use** opens the inline reply with this text, one undo step, as plan 133's commit: the strip is there with Regenerate, Shorter, Warmer and Undo, the first `[placeholder]` is selected, and §6.7's check line shows. **No request is made.** `writing.commitGeneration` records provenance, so learning from edits works unchanged.
- **Keyboard:** `r` on a thread showing a ready block does the same as Use, because that's what reply means here, and the block's hint says so. To write from scratch, Use then Undo, or Dismiss then `r`. `a` (reply all) uses it with everyone on To. Enter and `e` keep their meanings (`e` is Archive).
- **Dismiss** sets `dismissed` with a snack and Undo. It doesn't come back until a new message arrives.
- **Undo after Use** returns to the block, and the row goes back to `ready`.
- **Sending** changes nothing about the send path: the composer's Send, after you've seen it.
- **Failure:** no block at all, since nobody asked. Settings shows the last error kind, so a bad key is findable, and `auth` pauses it until settings change.
- **Reduced motion:** static spinner, no transition. Screen readers hear "Reply ready" once, never the deltas.
- **Every design:** Lumen's and Atelier's reply pills are the case to check first. `@variant` flow, screenshots beside neighbours, light and dark.

### 6. Settings

**Settings → AI → Drafting:** a switch, "Prepare a reply when I open a conversation that needs one", off by default, with the hint: "When you open a conversation waiting for your reply, Terno sends it to {provider}, with your style notes and up to 4 of your messages to this person, to write a reply. About {cost} each. Nothing is sent to anyone." **Settings → Accounts,** beside its writing instructions: "Prepare replies in this account", on by default. An import never turns the switch on. It's disabled with a pointer when no writing provider is set up.

### 7. Copy

`t()` and `L()`, `en` and `es` together: the block, its states, the switch, the hint, the snack, the account row.

## Tests

- **Eligibility (web unit and backend):** each §1 condition alone stops it; auto-select and an automatic move don't start it; a stay under 450 ms doesn't; reopening at the same stamp sends nothing in every state; the backend rechecks and refuses what the renderer allowed.
- **Worker (fake provider):** a "no" stores `skipped` and sends no draft request; the check goes to the drafting provider and never another (canary per provider); check failure means no block; leaving before the first word cancels and after it stores; provider switch, off and Clear AI data write nothing; a new message mid-stream drops the result; daily and monthly limits stop it and ⌘J still runs; no learning job starts.
- **Use and Undo:** Use makes no request; provenance recorded; a sent-unchanged reply stays out of the corpus (plan 133 §8) through this path; Undo returns the block; `r` and `a` use it; a draft saved meanwhile hides the block; **nothing can send without the composer's Send**.
- **Conformance, both stores:** the table's round trip, stamp mismatch, cascade, merge, prune, clear; absent from drafts, counts, export, bootstrap and MCP.
- **e2e (`replies-ready.spec.ts`, `@variant`):** off by default, nothing on open; on: open a waiting thread, the block streams; "thanks!" shows nothing; Use, edit, Undo; Dismiss and Undo; a new message replaces it; list and Drafts unchanged; en and es; axe light and dark; screenshots looked at.
- **Eval (real model, gated, synthetic):** `scripts/ai-real/replies-ready.real.ts`: `needsReply` on labelled mail, in English and Spanish. **A false no costs a missed draft and a false yes costs $0.007,** so it should lean to yes. Plan 133's hard checks run on the drafts.
- **Release gate:** a run on a copy of a real profile, read by the owner, as plan 133's was. One-tap's known weakness ("I'll check and get back to you") matters more when it isn't asked for, so this read decides whether the block needs its own line about it.

## Performance

- **Off:** the renderer reads one setting, already in memory. No RPC on open and no change to the reader's chunk.
- **On:** a thread not waiting costs one comparison on its summary. A waiting one adds one primary-key read after the dwell.
- **The block is lazy.** The reader's render counts are unchanged, and streaming is batched per frame.
- **Migration ≤ 1 s:** an empty table. **Idle:** no timers, no background queue: all work begins at an open.
- `writing.perf.test.ts` already holds assembly in the slicer's budget at 50k threads in both stores; this adds no read.

## Out of scope

Generating on arrival (the user's choice). A "Reply ready" mark on list rows, which arrival generation would need. Several variants or quick chips. Replying to anything `waitingSince` doesn't cover: forms and support senders (plan 133's ⌘J still does). Sending anything by itself. Pro gating, which arrives with plan 85.

## Order

1. Table, conformance, migration gate.
2. `needsReply`, fake, contract tests, the eval.
3. `ai.prepareReply`, limiter task, cancellation.
4. The trigger in the reader, on `noteOpen`'s dwell.
5. The block: streaming, Use through plan 133's commit, Undo, Dismiss, `r` and `a`.
6. Settings, copy, screenshots in every design.
7. Real run and the owner's read.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, `/tmp/terno-plans-141-145/144-replies-ready.out`) raised 11 points, all accepted. Each replaces what the sections above say.

1. **`compose` would escape the limits.** It hard-codes `foreground: true` (`writing.ts:602`), ceilings apply only to background calls, and the monthly total sums three named tasks (`ai-limiter.ts:353`). Accounting becomes separate from queue priority: the check and the draft both charge `reply`, background reservations fail closed, and it counts in the month (plan 142 revision 8).
2. **Use can't overwrite work.** `composeLanding` can resume a draft discovered during its open (`compose.ts:569`), and `commit` replaces the document without checking (`ai-draft.ts:788`). Use requires the landing outcome, binds to that draft's identity and document, and checks again right before inserting. Changed work is kept, and the existing insert choice is offered.
3. **Eligibility is checked before every request.** The thread can move to Spam while the check runs, and `compose` doesn't refuse it (`writing.ts:565`). Eligibility and the captured source are read before each provider dispatch, including `hasSpam` as `summaryBlocked` does, and the finish is conditional in both stores.
4. **The hint says all of what goes.** The assembler also sends subjects, dates and snippets of up to five earlier conversations, and your name, signature and instructions (`writing.ts:452`). §6's hint lists them. A canary test holds the request to the disclosure.
5. **One preparation per thread.** No stored row doesn't mean none running: two windows, or repeated opens, each with their own request id, would both pay. A synchronous in-memory claim by thread and generation key comes before any await, as `single()` does for summaries. Windows subscribe to it, and it's cancelled only when the last one leaves.
6. **Undo needs the row.** `AiCommit` holds document and subject only (`ai-draft.ts:92`), and typing removes the strip. The commit lifecycle gains the prepared row's identity and revision. `ready` returns only after a successful strip Undo, or an editor undo back to the empty draft that discards it, by a conditional store update. Tests: edits, remounts, a newer row arriving first.
7. **The stamp doesn't cover everything a reply depends on.** `sourceStamp` hashes ids and body versions, not recipients, signature, instructions or model. A separate `generation_key` covers those and the answered message, as `snapshotKey` does, and is checked again on Use.
8. **Pruning mustn't undo a decision.** Evicting `skipped` or `dismissed` rows would pay again and bring a dismissed reply back. Bodies are bounded at 200, and bodyless rows at 5,000 small rows on their own. A failed check is stored as `failed`, so "no retry" survives a restart until the thread changes.
9. **There's no general dwell.** `noteOpen` returns unless that thread's reminder is due (`lib/reminders.ts:106`). A new shared `onExplicitOpen(id)` runs the dwell for everyone, with the selected-thread and `readerShown()` checks, and reminders move onto it. On List's list page j/k only moves the cursor, which isn't an open.
10. **`compose` starts the learner.** It calls `learner.activate()` unconditionally (`writing.ts:595`), which would start corpus work and model refreshes that §3 says never start. Generation is extracted with an explicit policy, and preparation only reads the voice that exists.
11. **The performance claim was wrong.** `writing.perf.test.ts` runs assembly on SQLite only, allowing 120 ms, and its IndexedDB fixture has 5k threads. And a source stamp walks a thread's headers, more than one key read. `replies-ready.perf.test.ts` gates the whole path at 50k+ in both stores, long conversations included, measuring the longest stall as well as latency.

## What building it changed

- **The check and the draft are charged as `reply`,** a background task with its own daily limits that counts in the month, but `ahead`: it doesn't wait for the minute's queue or behind other work for a local model, since someone is reading (revision 1).
- **`WritingService.generate`** is the drafting core without the learner's start: ⌘J activates and charges foreground around it, a preparation does neither (revision 10).
- **The switch is `settings.replies`,** read in memory, and the account's opt-out is in its writing prefs beside its instructions. The stored row's `generation_key` is the session's `snapshotKey` with no answered message: the stamp already holds the newest inbound.
- **Show all** is a link button over `line-clamp-6`, not a `Collapsible`: the text is one paragraph, and clamping is what shows six lines of it.
- **The gate** is `measureReplies` in `workloads.perf.test.ts` on both stores, beside its neighbours, rather than a `replies-ready.perf.test.ts` of its own.

## What the code review changed

Codex (read-only, `git diff main..HEAD`) raised 13 points, all fixed with a test that fails without the fix.

1. Eligibility was read before a request queued, not when it left: the limiter calls `beforeAhead` after any wait, and what no longer holds is aborted there, repairs included.
2. A preparation didn't stop when drafting or sent mail was turned off: it runs under the same permission as ⌘J, and refuses its write once that's gone.
3. Use could land in a draft to someone else: it's offered, "Written for Ana", rather than put in.
4. Clear AI data left the words on screen: `aiReply` says `cleared` to every window.
5. A late generation overwrote a Dismiss: `finish` is conditional on the row it read.
6. An old Undo could reach a newer reply: each row has an immutable `rowId`, and every action names it.
7. Back in List kept a preparation going: leaving follows what's on screen, and a retry reads it again.
8. A blank composer didn't stop one, nor `r` during the dwell: both count as someone writing, until it's opened again.
9. New mail left the old reply showing: it goes, and nothing starts by itself.
10. ⌘Z after Use left a blank draft and lost the row after typing: a draft keeps what it came from through edits, refinements and remounts. Back to nothing, the row returns, and a draft that was only those words goes.
11. Undo used the last reply's revision: each draft gives back its own.
12. A new key didn't lift an auth pause.
13. The gate measured reads, not a preparation: `replies.perf.test.ts` runs the whole path through the service on both stores at 50k+, long conversations included, with the table at its cap. It came in at 21 ms and 17 ms p95, with 22 ms and 8 ms the longest busy.

Round two, on those fixes (3 points, all fixed):

14. A draft's copy of the words outlived the draft: it goes when the draft does, however that happens.
15. Typing ended the strip's listener, so an Undo to nothing was never heard: what a draft came from follows the draft's own text.
16. New mail hid a streaming reply only until its next word: it ends the stream's listener and its pending paint too.

## What the eval and the panel changed

Real models, on a copy of one real mailbox (5,939 threads, three accounts, Spanish and English) with its keys and queued work removed, read by five reviewers with different concerns: a fact auditor, a busy owner, a safety hawk, a bilingual editor and a recall PM. Four rounds, each reviewer blind to the others. No mail is recorded here. The owner's read is still theirs.

- Prompt version 2. Consensus-wrong went from one to none, with one split left.
- **What changed:** a cold pitch or a recruiter's outreach to someone who's never written to them wants no reply. A prepared reply is told not to accept, decline or commit, nor apologize for them, and to keep their tú or usted, leaving decisions as a `[placeholder]`.
- **A real bug the eval found:** the check's 50 output tokens left no room for a model's hidden reasoning, and a real thread failed. It's 1,000 now.
- **Limit:** a reviewer still reads tú in one draft where the thread is in usted.

## The block is a card (2026-11-08)

> i think for drafts like this one, there needs to be some kind of card with a border or a background because users can confuse this with just another part of the text instead of the suggestion by the ai, this is for all styles, please consider that

This replaces §5's "No card or color: a hairline and type", for the reason plan 148 gave the summary: in the reader, "Reply ready · In your voice with Liam" and then the draft, in the body's type and on the body's left edge, read as more of the mail. Everything else in §5 stands.

```
┌─────────────────────────────────────────────────┐
│ ✦ Reply ready · In your voice with Ana          │
│ Hola Ana, el 19 me viene bien. ¿A la misma hora?│
│ [Use] [Dismiss]  Reply uses this too R          │
└─────────────────────────────────────────────────┘
┌─ ↰ Reply to Ana ─────────────────── Forward ✦ ─┐
```

- **The summary's surface.** `AI_CARD` (`components/ai-card.ts`) is `card-group`, and the summary and Reply ready both use it, so a model's words look one way in each design: on the tint in Lumen, Atelier, macOS and Luma, outlined on no fill in Graphite. No new token, color or type; the contrast suite already holds the text on it (plan 148).
- **The label is the header,** in the summary's header style: 40 px, `text-xs`, muted, with `Sparkles` at `1.15em` (the spinner in its place while it writes). "Reply ready" is `font-medium`, as "Summary" is; the voice follows it in regular weight.
- **The draft is inside,** inset by the summary's `px-3.5`, so it no longer starts on the body's left edge. Use, Dismiss and the hint are the footer, `pb-3` from the bottom edge. Dismiss is the `outline` button, the secondary the summary's card uses: `secondary` fills with the tint and vanished on it.
- **One column.** The card's outer edges are the column's, the same as the summary above and the reply bar below.
- **Unchanged:** `data-phase`, every test id, the roles, the live region, keyboard (`r`, `a`), focus never moving, Show all, Stop.

**Other AI text in the reader, looked at and left as it is:** follow-up lines (plan 142) are the user's own commitments, and plan 148 chose no card for them; a Nudge opens the ordinary composer with the AI strip, which already says what wrote it; the digest (plan 145) is its own page under its own title, not text inside a conversation.

**Tests.** `reply-ready.test.tsx`: ready and writing render inside the card, header (glyph, label, voice), then the draft, then the footer with its actions; another thread's reply renders nothing. `replies-ready.spec.ts`, `@design` (every design), at 1440×900 and 1100×700: the card's computed fill, ring and radius equal the summary's; its left and right edges are on the reply bar's and the summary's within 1 px; the draft and the footer's Use start on the header glyph's inset (≥ 12 px), and header, draft and footer stack inside it. The existing `@variant` flow keeps its axe check in light and dark. Screenshots in all five designs, light and dark, both sizes, looked at.
