# Plan 280: Owed to you (their promises)

- **Status:** built on `feat/280-owed-to-you`, code-reviewed by Codex (one round). "Revisions after the Codex review" overrides the sections before it; "What building it changed" and "What the code review changed" override both. The real-model eval is written and not run, and the panel on a copy of a real mailbox hasn't happened: both wait for the owner's go-ahead.
- **Builds on:** plan 142 (follow-ups), plan 204 (the dated reader of incoming mail, its marker, checks, settle and move), plan 210 (prompt versions and the panel), plan 211 (AI on by default, per account), plan 268 (CHECK lists go when their column needs a new value), plan 277 (follow-ups survive Archive).
- **Reverses:** plan 142's "Not their promises to you" and plan 204's "never other people's promises to them" (the owner, 2026-11-25).

## The request

From research on what people want from AI in email, relayed to this thread:

> tracking commitments matters most when it covers both sides: what I promised, who needs an answer from me, and what someone else promised me ("Alex said he'd send the contract by Thursday"). Reliability is the main worry: don't turn every "I'll" into a task, recognize tentative promises, changed deadlines and promises already kept, and make mistakes easy to correct.

## Decisions (the owner, 2026-11-25)

| Question | Decision |
|---|---|
| Track their promises to you | **Yes**, reversing plans 142 and 204 |
| What matters | **No.** What matters is the user's own actions: their promises live in Follow-ups only (as nudges already do) |
| Tentative promises | **Tracked quietly,** easy to dismiss |
| Promises to someone else, you only copied | **Never** |
| A promise of theirs that your own mail records ("as agreed, you'll send it Thursday") | **Yes** |
| Delivery through a service (e-signature, file share) closes it | **Yes, when we're sure** |
| A promise closed by the mail itself | **Silent,** as plan 142's |
| Setting | **Part of Follow-ups,** its words widened; only with AI available |
| Late | **One working day** after its day; weekends don't count |
| Name | **Owed to you** |

## The gap today

- A wait ends on any reply: `closeAnsweredFollowups` (`packages/db/src/followups.ts:338`) closes an `awaiting` row as `replied` without reading the reply. "Ana hasn't replied" goes the moment Ana writes "I'll send it Thursday", and nothing remembers the one thing still owed.
- The dated reader rules it out on purpose: prompt v16 (`packages/ai/src/dated.ts`, "Not items") leaves out "a person's mail that only thanks, tells or says what they'll do".
- Your own mail stating their promise ("as agreed, you'll send the contract Thursday") makes at most an `awaiting` wait (`expectsReply`): ended by any reply, back after `nudgeAfterDays`, never on Thursday, and without the thing owed.

## Design

### 1. What counts

**Their promise:** in the new text of a message (quotes stripped, plan 36), **a person commits to do a concrete thing for the reader**: send, deliver, sign, pay, decide, or get back to them. "I'll send the contract by Thursday", "te mando la factura mañana", "we'll have the quote to you next week", "let me check and get back to you" (a holding reply: undated).

- **To the reader:** the reader is in To, or named as who it's for. A promise made to someone else while the reader is only copied is never theirs (the owner).
- **Firm or tentative:** "I'll try to…", "hopefully by Thursday", "should have it early next week", "probablemente el viernes", "if all goes well" are tentative (`firm = 0`): tracked quietly (§6).
- **Their condition on their side** ("once Legal signs off I'll send it") is tracked, undated unless it names a day. A condition on the reader ("once you send the sizes I'll quote") is not theirs yet.

**Not their promise** (each an eval case, en and es):

- From an automated address: a shipment's estimate is the dated reader's `delivery`; "we'll review your application within 10 business days" is no one's promise to track.
- An offer waiting on the reader's yes ("I can send it if you want"): the dated reader's `ask` already.
- Nothing concrete: "I'll keep you posted", "let's catch up", "will think about it" with nothing to come back with.
- What they've just done ("attached is…"), what someone else has under way ("Legal will prepare it"), being somewhere they're expected ("see you Thursday"), banter and jokes, a stranger's pitch ("I'll send you a case study").
- Anything in quoted history, Spam, Trash, the bulk tabs (Gmail's Social and Promotions, Outlook's Other), or list mail that doesn't address the reader.

### 2. Reading incoming mail

**The dated reader's pass reads it, as a second task of its own.** Not new fields in `readDates`:

- The dated pass (`DatedWorker`, `packages/backend/src/dated.ts`) already reads every person's incoming mail whatever its cues, from its own durable marker (`ai_dated_mail`), with Spam and Trash checked before the request, at the transport and in `finish`; the per-account switch (plan 211); and it already offers a thread's and a sender's open items to settle and move, your promises among them (`movedPromises`, written in `finish`'s transaction). Their promises need exactly that.
- Prompt v16 holds sixteen versions of panel work and rules this case out; adding a kind would move the boundaries that took the most rounds (an offer versus an ask, sign-offs). Plan 204 kept the dated reader out of summaries for the same reason. A task of its own is frozen, versioned and evaluated alone, and `dated.real.ts` must not move.
- Not the follow-ups worker: it reads sent mail, and incoming mail there would need a second marker and a second Spam pipeline (plan 204 revision 1's trap).

**One marker, two wants.** `ai_dated_mail` gains `wants_dated` and `wants_theirs` (booleans), written in the ingest commit by the shared predicate: `wants_dated` while the dated reader is wanted, `wants_theirs` while Follow-ups is (§7) and the account's switch allows it. Each task consumes its own flag in `finish`; the row goes when neither is left. Every path that deletes `ai_dated_mail` rows (finish, prune, Clear AI data, the scan's expiry) follows that rule, in both stores. The worker runs while either is wanted.

**Its own module.** `packages/ai/src/their-promises.ts` (the task, prompt, fake) and `packages/backend/src/their-promises.ts` (selection, input, `checkTheirPromises`), called by the worker. `dated.ts` gains the call and the shared finish, not the logic.

**The local filter** (a cost filter that errs towards reading, never a judgment). A message is read for `theirs` when it is from a person (not `automated`), not in a bulk tab, and one of:

- the thread has an open `awaiting` or `theirs` row of the reader's;
- the sender (`addressKey`) has an open `theirs` row (delivery often comes in a new conversation);
- a service's relay names the address of someone with an open `theirs` row (§4; read even from a bulk tab or an automated sender);
- the new text has a commitment cue: `hasCommitmentCue(text)` in `@terno/core`, pure, en and es ("I'll", "I will", "we'll", "get back", "by Friday", "te mando", "te envío", "le hago llegar", "quedo de", "me comprometo", "voy a", "vamos a" and their family).

**`AiTasks.readTheirPromises`,** structured output through the ladder, `effort: low`, frozen and versioned (`THEIRS_PROMPT_VERSION`), mail in delimited blocks as material, no tools:

```ts
interface TheirMailInput {
  text: string;               // their new text, quotes stripped, ≤ 1,500 tokens
  answering?: string;         // the reader's message it answers (In-Reply-To), own words only, ≤ 800 tokens: "will do, Thursday" means nothing alone
  subject: string;
  from: { name: string };     // never an address
  reader: { name: string; addressed: "to" | "cc" | "none" };
  attachments: string[];      // file names, ≤ 10 × 120 characters: "Contract_signed.pdf" may keep a promise
  owed: { label: string; text: string; due: string | null }[]; // t1, t2: this thread's and this sender's open promises to the reader, ≤ 10
  relay?: { service: string; block: string };  // a service's mail naming the debtor (§4)
  receivedAt: string;         // weekday, date and time, in the reader's zone
  zone: string;
  language: string;           // the app's: `text` is for the reader
}
interface TheirMailResult {
  promises: { text: string; quote: string; due: string | null; time: string | null; partOfDay: PartOfDay | null; firm: boolean }[]; // ≤ 3
  kept: { label: string; evidence: string }[];       // "here's the contract", "signed", or an attachment's name
  moved: { label: string; due: string; time: string | null; evidence: string }[];   // "need till Monday"
  withdrawn: { label: string; evidence: string }[];  // "we can't send it after all"
}
```

The text is a verb phrase in its base form, said to the reader, with no subject: "send you the contract", "enviarte el contrato". The line is the app's (§6).

**Local checks** (`checkTheirPromises`, pure, as `checkSentMail` and `checkDates`), before anything is stored:

- a promise's `quote` is in `text`, normalized; one that isn't is dropped;
- `due` parses, is on or after the day it arrived and within a year, else undated; `time` parses as `HH:MM` or is dropped; zones by `datedTiming`;
- the reader is in To or named; `addressed: "cc"` with no name drops every promise (the owner's rule);
- a `t` label must be one it was given; `kept`, `moved` and `withdrawn` need evidence in `text`, or (for `kept` only) one of `attachments` exactly;
- **only the debtor can close or move their promise:** the message is from the row's `person_email` (`addressKey`), or is a relay that passes §4. So the worst an injected instruction can do is close its own sender's debt;
- `moved` and `withdrawn` exclude `kept` (kept wins); a moved day passes the same date rules from the new message.

### 3. Reading your own mail

`readSentMail` (`packages/ai/src/followups.ts`, prompt v15) gains:

- **`theirs`:** a promise of theirs your message records, `{ text, quote, to, due, partOfDay, firm }`: "as agreed, you'll send the contract Thursday", "thanks for offering to send it Friday, yes please". The `quote` must be in your `ownText`, `to` a recipient label who is a person. A request ("can you send it Thursday?") stays a wait.
- **`owedKept`:** `t` labels (the thread's open promises to you, as `<owed>` material) your message says arrived, with evidence in your words: "got the contract, thanks", "recibido, gracias".

A message that records a promise for a person makes no `awaiting` for that person: the promise is the more exact wait. Its `expectsReply` for anyone else is unchanged.

### 4. How one closes

- **They delivered:** `kept` from their later mail, on the thread or in a new conversation from them, with evidence (§2).
- **Through a service, when we're sure:** a relay (`dated-relay.ts`' shape) closes a promise only when the relay's own text names the debtor's **address**, not just a name (DocuSign's "Alex Reed (alex@x.example) sent you…", a file share's "alex@x.example shared…"), the model gives `kept` with evidence in the relay's block naming the thing, and the address matches the row's `person_email`. Anything less closes nothing.
- **They withdrew it:** `withdrawn`, `closed_reason: withdrawn`.
- **You said it arrived:** `owedKept` from your sent mail (§3).
- **By you:** **Received** (Done), **Not a promise** (Dismiss), **Later**, each with plan 142's exact Undo.
- **Silent:** a close by mail has no snack and nothing to undo, as plan 142's (the owner).
- **Moves:** Archive keeps it (plan 277). Trash and Spam hide it and it comes back with the conversation. A deleted conversation cascades.
- **Over:** an open `theirs` row retires quietly (`dismissed`, `expired`) 30 days after it came due, in the daily bounds.

### 5. Dates

- **Its day:** as your promises' (prompt v14's rules): a soft day is its last day ("this week" is Sunday), a part of the day is `partOfDay`, a time keeps its zone.
- **Late is one working day** after its day: the morning (`REMIND_MORNING`) of the next working day after the due day ends. Due Thursday, it's late Friday 9:00; due Friday, Monday 9:00. Working days are Monday to Friday. `theirDue(o)` in `@terno/core`, pure, tested across weekends, month ends and DST beside `followupDue`.
- **Undated** ("let me check and get back to you"): late after `nudgeAfterDays` working days, at 9:00.
- **Moved** by the debtor's later mail (§2): the day and `due_at` recomputed, `changed_at` and `changed_from` written; it's open again if the new moment is ahead. Your own counter-proposal ("could you do Wednesday?") moves nothing.

### 6. Where it shows

Follow-ups only. Never What matters, its count, or a notification.

- **The Follow-ups list:** the row's line, in each language's own sentence: "Alex promised to send you the contract · by Thu" / "Alex prometió enviarte el contrato · para el jue"; late: "… · 2 days late". Tentative: "Alex hoped to send you the contract · by Thu" / "Alex esperaba enviarte el contrato…", in the muted ink. Where the list names kinds (its filter, a section, the tip), these are **Owed to you** / **Te deben**. One row a conversation, its most urgent (plan 142 revision 10).
- **In the conversation:** the follow-up line, "Alex promised to send you the contract by Thursday →" (to the message), with **Received · Not a promise · Later**; late and firm, **Write a follow-up** too.
- **The Inbox's top:** a firm promise, once late, through plan 142's `inbox_state`, ended by opening as a nudge is. A tentative one never.
- **Write a follow-up:** the one-tap draft (plan 133), its fixed instruction naming the thing and the day ("a short, friendly reminder that they said they'd send the contract by Thursday"). Nothing is sent by itself.
- **The guard against the worst nudge:** when the debtor has written since the promise and nothing closed it, the line asks "Alex wrote since. Did it arrive?" with **Received** first, and offers no draft.
- **Tentative, quietly:** list and line only, muted, with **Not a promise** on the row's hover and focus beside Received (one click, Undo).
- **The wait becomes the promise:** when their reply to your wait holds a promise, the wait closes as now (`replied`) and the promise's row takes the conversation's line, so "Ana hasn't replied" turns into "Ana promised to send you…".

### 7. Settings

- **One switch, Follow-ups,** its words widened: "Keep track of promises, mine and theirs, and who owes me a reply" / "Seguir las promesas, mías y de otros, y quién me debe una respuesta". The hint names what's sent: "Sends the text of each message you send, the message it answers, and mail people send you, to {provider}." Off: no `wants_theirs`, no task, no rows shown.
- **Only with AI available** (`aiFeaturesAvailable`, plans 147 and 150): the switch and the rows follow the one gate.
- **Per account:** "Track follow-ups in this account" now reads what you send and receive there; its hint says so.
- **Mail already here:** plan 211's per-account check reads the last 14 days for `theirs` in the dated check's selection (same walk, same bound), as `from_scan`: never on the Inbox's top; a promise already late by more than 7 working days isn't added, nor one a later message kept.
- **The tip** (plan 113): `followups-owed`, the first time an Owed to you line shows on an open conversation, with a picture of the line.

### 8. Data

**One migration step,** shape only but for one rebuild (`migration-rule.test.ts`):

1. **`followups` rebuilt without its `kind` list** (plan 268): `kind CHECK (kind IN ('promise','awaiting'))` is descriptive, and its column now needs `theirs`. Rows copied unchanged, ids and the AUTOINCREMENT mark kept (v57's way); no table references `followups`, so foreign keys stay on. `rewrites:` says why: at most 1,000 active rows and 90 days of closed ones. `state` and `inbox_state` keep their checks (behaviour). The store checks the kind it writes (`FOLLOWUP_KINDS`) and reads one it doesn't know as unknown, never shown.
2. **`followups.firm INTEGER NOT NULL DEFAULT 1`** (structural boolean).
3. **`followups_owed ON followups(person_email) WHERE kind = 'theirs' AND state IN ('open','due')`:** the sender's open promises for the filter and `owed`.
4. **`ai_dated_mail.wants_dated INTEGER NOT NULL DEFAULT 1`, `wants_theirs INTEGER NOT NULL DEFAULT 0`.**

IndexedDB: the same fields and index, `IDB_VERSION` 43, an upgrade test. Everything else exists: `person_name`/`person_email` (the debtor), `quote`, `due_at`/`dated`/`timed`/`part_of_day`, `changed_at`/`changed_from`, `settled_by`/`settled_at` (the message that kept it), `closed_reason` (`kept`, `withdrawn`, `user`, `expired`).

- **Bounds:** `theirs` counts in the 1,000 active rows; past it, a tentative undated `theirs` goes first, then an undated `awaiting`, as plan 142's order.
- **Clear AI data** empties them. Not exported, synced, searched or on `MCP_ALLOWED`. Merges move them as all follow-ups.

### 9. Copy

`t()` and `L()`, en and es together: the row and the conversation's lines (firm, tentative, late, "wrote since"), Received, Not a promise, the snacks, Owed to you, the setting's words and hints, the account's hint, the tip, the nudge's instruction (not translated: it talks to the model). Never a gendered pronoun for the debtor: "Alex promised to…", never "he'd".

## Precision and recall

**Precision outranks recall here,** the reverse of your own promises: a missed promise of theirs leaves the user where they are today, a false one invites a nudge to someone who never promised or already delivered. The same for `kept`: a wrong close silently loses a real debt, a missed one costs a Received click and the "wrote since" guard catches it before any draft.

The shipping bar, on the eval and the panel:

- rows shown: precision ≥ 0.9, and no consensus-wrong row that's late (one a nudge would be offered on);
- firm dated promises: recall ≥ 0.7; due day exact ≥ 0.9;
- `kept`: precision ≥ 0.95;
- false nudges when a corpus conversation is replayed in order: none;
- `dated.real.ts` and `followups.real.ts` unchanged.

## Tests

- **Core:** `theirDue` across weekdays, Friday, weekends, month ends, DST, undated working days; `hasCommitmentCue` en and es, with cases that must read and plain mail that mustn't.
- **AI:** the task's shape, the frozen prompt's version, the blocks' escaping, the fake's markers; `readSentMail` v15's `theirs` and `owedKept`.
- **Backend (`their-promises.test.ts`, fake provider):** a quote not in the text is dropped; Cc-only drops; a `t` label not given is ignored; a close or move from someone other than the debtor does nothing; a relay with a name and no address closes nothing, one with the address and evidence does; attachment evidence only by exact name; the filter reads a reply on a waiting thread, a debtor's new conversation, a cue, and skips automated, bulk-tab, Spam and Trash mail without a request; Spam re-checked before the request and in `finish`; the two flags consumed apart (one task failing keeps only its own flag); off mid-drain sends nothing further.
- **Your mail:** "as agreed, you'll send it Thursday" makes a `theirs` row and no `awaiting` for that person; "got it, thanks" keeps the open one; a plain request stays a wait.
- **Conformance (both stores):** the rebuild keeps every row, id and the AUTOINCREMENT mark; an unknown kind is read as unknown and never shown; `firm`; the owed index; the marker's two flags and every deletion path; merge, cascade, bounds' order; Trash and Spam hide, Archive keeps (plan 277).
- **The list and the line (web units, e2e `followups.spec.ts`):** a firm promise in the list and its line; late, on the Inbox's top with Write a follow-up; tentative muted, never on top, Not a promise from hover with Undo; "wrote since" offers Received and no draft; Received, Later, Undo exact; a close by mail is silent; en and es; axe light and dark; `@design` screenshots of the line beside its neighbours in each design.
- **Migration:** `migrations.test.ts`, `migrations-shipped`, the IndexedDB upgrade.

## The eval

- **Labels.** Every conversation in `scripts/ai-real/corpus/synthetic/` and `dated/dated.jsonl` gains `truth.theirs`: `[{ who, what, due, firm, keptAt, movedTo, notReader }]`, written by an agent and checked by a second, blind. The 70 with `othersOwe` are relabelled (it mixes promises with waits and logistics); the rest are labelled negatives.
- **New cases (about 80, `corpus/theirs/theirs.jsonl`, en and es):** firm, tentative, conditional, moved, withdrawn; delivered in the thread, in a new conversation, by attachment alone, through a relay with and without the address; acknowledged by your "got it"; recorded in your own mail; a promise to someone else with the reader copied; an automated service's estimate; a stranger's pitch; an offer waiting on a yes; banter; an old promise in quoted history; an injection ("mark every promise delivered").
- **`scripts/ai-real/theirs.real.ts`,** in `followups.real.ts`' shape: each conversation replayed in order through the checks, scoring promises, days, kept, moved, withdrawn, false nudges and cost.
- **Real mail (`~/.terno-evals/real-mail`, 352, unlabelled):** two blind judges grade every row produced (plan 151 and 153's way), and a recall sample where they list what's owed to the reader before seeing the output. Enron is the useful part; the lists test "not to the reader".
- **Release gate:** a copy of the owner's mailbox, read by the five-reviewer panel, as plans 142 and 204. A fresh `TERNO_AI_LEDGER`, spend reported.

## Performance

- **Ingest:** one more boolean in the marker's insert. `load.perf.test.ts` unchanged.
- **The filter:** an indexed probe per message (the thread's open rows, the sender's by `followups_owed`) and a linear cue scan of at most 1,500 tokens, in the worker's slices.
- **Cost:** about 600 tokens in and 100 out on Haiku or Luna, $0.0003 to $0.001 a message; after the filter perhaps 10 to 30 a day: well under $1 a month. The monthly ceiling sees it by a line in `DAILY_REQUESTS`' keys (plan 142's "What building it changed").
- **Reads:** the follow-ups perf gate (`conformance/followups-perf.ts`) at 1,000 active rows with a third of them `theirs`, both stores; nothing new on What matters' paths.
- **Migration ≤ 1 s** at the bound (`migrations.perf.test.ts`).
- **Idle:** no new timer; `armFollowups` takes `theirs` rows' moments.

## Out of scope

Promises to someone else with the reader copied (never). What matters and its count. Notifications. Shifting a day off a holiday, or weekends other than Saturday and Sunday. Changing `awaiting`'s calendar days to working days. Editing a promise's words. An agent's view on MCP.

## Order

1. Core: `theirDue`, `hasCommitmentCue`, `FOLLOWUP_KINDS` with `theirs`.
2. The migration, both stores, the marker's flags and their deletion paths, conformance.
3. `readTheirPromises`, its fake and checks; `readSentMail` v15; the corpus labels, the new cases, the eval.
4. The worker's second task and the shared finish; the closes and moves.
5. The list, the line, the Inbox's top, Write a follow-up, the guard, copy, the tip.
6. Settings, the per-account check, the eval's real run and the panel.

## Revisions after the Codex review

Codex (`codex exec -s read-only`, the critique in the session's scratchpad) raised 12 points, all taken. Each replaces what the sections above say.

1. **The reading moves to the follow-ups worker, with a marker of its own** (points 1–3, 5). Flags on `ai_dated_mail` would tie the new task to the dated reader's whole lifecycle: ingest marks only while `gate.reads()` and `settings.dated.enabled` hold (`core.ts:418`, `dated.ts:1147`); turning it off clears the queue, a skip or a terminal failure consumes the whole mark and retries count by message (`dated.ts:1202`, `:1386`, `:1540`); and `pendingOn`, `among`, `looked`, `caughtUp` and `wantedMark` (`store/dated.ts:329`, `core.ts:432`, `preferences.ts:789`, `today.ts:860`) would read an owed-only backlog as the dated reader's. So:
   - `ai_owed_mail (message_id PRIMARY KEY REFERENCES messages ON DELETE CASCADE, thread_id, sender_key, arrived_at, queued_at, source)` in `ai_sent_mail`'s shape, `source` with no CHECK list (plan 267). It's written in the ingest commit by the shared predicate (`markNewMail`'s: not Spam, Trash, a draft or your own mail) while **Follow-ups** wants it: its setting, its `enabledAt`, the AI gate and the account's **Track follow-ups** switch. The dated reader's settings and **Show in What matters** decide nothing here. Live marks are pruned at 3 days, scan marks at 14, as `ai_sent_mail`'s.
   - **`FollowupWorker` reads both its markers** in one chronological pass per conversation and per debtor: your sent mail and their received mail in arrival order, so a debt is always written before the delivery that keeps it is judged. A relay naming a debtor's address waits behind that debtor's older marks. When a debt comes from an older message after later mail of theirs was already read (a send confirmed late, a scan), that debtor's received marks of the last 14 days are queued again, at most 20.
   - The gates are checked at ingest, at the scan, before the request, at the transport and in `finish`, with the follow-ups clear generation, so a late answer can't recreate a cleared row. Tests: Follow-ups on with the dated reader off, the account's switch turned off during a request, Clear AI data mid-request.
   - `dated.ts`, `ai_dated_mail` and its consumers are untouched. The task's module stays where §2 put it (`their-promises.ts` in `ai` and `backend`), called by the follow-ups worker.
2. **Every exit of a mark is specified** (point 2). A skip, the filter's no, retries exhausted and a successful `finish` each consume the owed mark alone. Clear AI data and a deleted message remove it. An expired mark expires whatever it waited on.
3. **The 14-day check has its own record and rules** (point 4). An account whose dated or follow-ups check finished before this ships still gets one owed check (`owedCheckedAt` per account). Its candidates are the filter's (§2), whether or not a message produced a dated item, and include a relay naming a debtor's address in a bulk tab. Queuing is idempotent on `message_id` and never resets a live mark. **A scan's conversation commits at once:** its marks are read oldest first, results held, and written in one `finish` after the last, so a promise kept later in the conversation never shows. A failure leaves the conversation to read again whole (idempotent by `(message_id, item)`).
4. **What's sent is gated as the source is** (point 6). `answering` is only a trusted send of yours (Terno's confirmed send or Gmail's SENT label, plan 204 round 2 #8) on the same account and conversation, else left out. `owed` holds only the account's rows from conversations not in Spam or Trash. The request carries the ids and revisions of everything it holds into the transport's last check, on every attempt, repairs and fallbacks included. One gone stops it, and it's asked again without that row. The task key `owed` is registered in `BACKGROUND_TASKS`, the limiter and the transport's dispatch, so monthly accounting sees it.
5. **A relay never closes a promise; it asks** (point 7). `relayedAsk` reads prose and display names (`dated-relay.ts:54`), and anyone can write a paragraph with the debtor's address. Nothing in the mail proves a service sent it, and we don't build on provider behaviour the docs don't state. So we're never sure enough for a silent close (the owner's "if we're sure"). A relay that names the debtor's address and the thing owed sets the row's `arrived_hint` instead. The line reads "Alex's contract may have arrived" with **Received** first and no draft, as the "wrote since" guard does.
6. **Evidence must say the thing arrived** (point 7).
   - **Mail evidence:** `kept` needs a positive statement about this deliverable. Evidence with a negation ("wasn't", "hasn't", "not yet", "todavía no", "aún no") is refused locally.
   - **Attachments:** an attachment counts only when its name shares a content word with the promise's text and matches no other open debt of that person.
   - **Cc-only:** a reader only copied keeps a promise only when the promise's own quote names them.
   - **Tests:** a forged relay; "the contract wasn't delivered"; a file name two debts share; a greeting naming the reader before a promise to someone else.
7. **Your mail is trusted before it creates or closes a debt** (point 8).
   - **Trusted sends only:** `theirs` from your mail and `owedKept` need a trusted send (as revision 4), in both stores' write paths: an IMAP message can claim your From.
   - **Item ids:** `theirs` rows take item ids from 100 (`item = 100 + i`), apart from your promises' 0….
   - **Waits:** the one `awaiting` row is chosen among recipients with no debt validated from the same message.
   - **The bound:** if the debt can't be admitted at the bound, the wait is written as before.
8. **The promised day is stored apart from the moment it's late** (point 9).
   - **New column:** `followups.due_day TEXT` (the local day promised; its time in `timed` and the existing columns), shown and moved.
   - **Separate moments:** `due_at` is the late moment (§5). Later writes `deferred_until` and never overwrites `due_at` for `theirs`.
   - **Moves:** a move recomputes both, keeps the deferral and bumps the revision.
   - **Both finish paths** need the exact revision shown, an open row, an authorized source (§2's debtor rule), and evidence from a message newer than the row's source and its last change.
9. **One admission rule for every write that makes a row active** (point 10). The writes are a sent insert, an incoming insert, Undo's restore, and a move that reopens a row. It's the same in both stores, with eviction in a fixed order:
   - first a tentative, undated `theirs`;
   - then an undated `awaiting`;
   - then the oldest undated `theirs`;
   - never a promise of yours.

   An Undo that can't fit says so ("There are too many follow-ups to bring this one back. Dismiss one first."), never truncating `active()` silently. Retiring at 30 days is a moment `armFollowups` wakes for, as well as the daily bounds.
10. **The rebuild copies today's table, not v52's** (point 11).
    - **Shape:** every column of v82's `followups`, AUTOINCREMENT's mark kept (v57's way), and every index recreated by name (`followups_active`, `_thread`, `_top`, `_closed`, `_same`, `_answers`, and the rest the code names).
    - **Gate:** the migration perf fixture holds 50,000 closed rows, since the 90-day window bounds time, not count.
    - **Debtor key:** the owed index is on a normalized `person_key` (`addressKey`), a new column, filled on write.
    - **IndexedDB 43:** the same index, defaults for old records, and an unknown kind left out before the list and the Inbox's top select, in both stores.
11. **One eligibility rule from the store to the draft** (point 12).
    - **The Inbox's top:** both stores' due transition puts a `theirs` row on the top only when it's firm and not `from_scan`.
    - **One rule for the row:** `threads()`, the Inbox's order and the renderer's line take the same row by one rule in `@terno/core` (`lineRow`), so the copy never shows a row the top didn't choose.
    - **Refreshes:** an owed `finish` emits the snapshot and re-arms the timer.
    - **The notice:** `announce()` stays your promises only.
    - **The conversation's card** (`thread-followups.tsx:142`) shows `theirs` rows.
    - **Write a follow-up** is keyed by the follow-up's id, not the thread (`followup-nudge.ts:10`). The backend checks "wrote since" again when it starts, so a stale card can't start a draft. The promise's words go to the fixed instruction as quoted material.
12. **What this changes above.**
    - §2's "One marker, two wants" and its marker columns in §8 are gone (revision 1).
    - §4's relay close becomes revision 5's hint.
    - §8 gains `due_day`, `person_key` and `arrived_hint`, and its migration rebuilds from today's table.
    - The tests follow each revision. The conformance suite adds the admission rule, the trusted-send writes, the owed marker's exits and the rebuild's indexes.

## What building it changed

- **One gate for all of Follow-ups.** Received mail is marked, read and checked by the gate the sent side already uses: the AI gate, the account's AI and Show in What matters switches (`gate.reads`, plan 211), Follow-ups' own setting and `enabledAt`, and the account's Track follow-ups switch. Codex's critique (point 1) asked whether What matters' switch should govern a Follow-ups feature. Follow-ups' sent half already follows it, so the received half does the same; giving Follow-ups its own predicate would be a change for both halves, outside this plan.
- **The task runs on the follow-ups route** (`forTask("followup")`): same provider, model and limiter task, so the monthly ceiling already counts it. Revision 4's own task key isn't needed. The transport's last look (`beforeAhead`) now runs for the `followup` task, and `FollowupWorker.holdingUp` returns at once unless a received message's reading is on its way.
- **Item ids from 200** (`THEIRS_ITEM`). Revision 7 said 100, but that is the wait's item (`AWAITING_ITEM`).
- **No `changed_at` or `changed_from` for a mail's move.** Those columns are the user's own schedule in What matters (Change…), and `scheduleFields` reads them into every row. A promise of theirs records the moving mail's date in `moved_at` (on v84, unshipped) instead.
- **No `person_key` column read by name.** The debtor's key is written at insert and indexed (`followups_owed`). IndexedDB's `owed` index is in memory, filtered to open promises of theirs.
- **The 14-day check doesn't commit a conversation at once** (revision 3). A check's rows are `from_scan`: never on the Inbox's top, never said. The check reads a conversation oldest first, in the same pass as everything else. A debt it finds marks its debtor's later received mail again (`requeue`, at most 20, once per message), so a delivery read before the debt existed is read again. Until then the row can show in the Follow-ups list, and Received closes it.
- **A check's candidates leave out list and bulk mail.** At check time no debt exists yet for a service's notice to name.
- **"Wrote since" is the renderer's**, read from the conversation on screen, which updates with new mail. The backend doesn't check it again when Write a follow-up starts, but nothing is ever sent by itself.
- **The reminder's words are fixed.** They are not the promise's words, which were read from their mail: the draft reads the conversation as material.
- **A tentative promise of theirs** stays out of the sidebar's due count as well as the Inbox's top.
- **Settings' words:** "Keep track of promises, mine and theirs, and who owes me a reply"; the hint says mail people send you is read too. The feature's name stays Follow-ups.
- **The worker test's model and the UI rating's stub** answer the new fields; v15's sent-mail prompt needs a 4,200-token window in its budget test (v14 needed about 3,600).

## What the code review changed

Codex (`codex exec -s read-only`, the review in the session's scratchpad) raised 15 findings in one round. Ten are fixed, each with a regression test that fails without the fix. The SQLite ones were checked by taking the fix out.

1. **A promise from a conversation with anything in Spam was material** when only another of its messages was in Spam. `owed.openFor` leaves out any conversation with a message in Spam, in both stores. A relay's debts go through the same read (`readable`).
2. **The last look checked ids, not revisions.** It now compares each carried promise's revision, so a move since stops the request.
3. **Clipped evidence:** "send the contract" cut from "I can't send the contract until Friday" passed. Evidence is now judged with the whole of its sentences (`deliveredIn`), for their mail and for "got it" in yours. A file counts only when no other open promise of that person's, shown or not, could be it.
4. **Re-queueing after a stale finish.** It happens only after a written finish.
5. **A late-confirmed send of yours** that records their promise now reads the debtor's later mail again.
6. **Older mail could undo a newer move.** `moved_at` (v84) stops it: mail older than the last move can't move or close the promise.
7. **Undo at the bound** is admitted by worth, as a new row is: a promise of yours always fits, so What matters' Undo is never partial. One with no room says "There are too many follow-ups to bring this one back. Dismiss one first." and stays to try again.
8. **A cue-free reply to your send** ("Friday.") was dropped when its wait had already closed. A reply to a trusted send of yours is now always read.
9. **One rule (`lineRows`) for the row that speaks for a conversation:** on the Inbox's top, the row that put it there, never a tentative one beside it. The backend orders the top by the same rows.
10. **The eval** fails on a move nobody made or a made-up deliverable (`words`).

Left, with why:

- **Turning off Show in What matters stops promises of theirs** (finding 4): the gate is Follow-ups' existing one (above). Marks written while the account's Track follow-ups switch is off are dropped by the worker unread, as sent mail's are.
- **Clear AI data during a check** can let the check queue its candidates after the clear (finding 5's first half). The sent check has the same window, and what's queued is read as a new check would read it.
- **A scan's conversation isn't committed at once** (finding 6): see "What building it changed".
- **A relay read while its debtor's promise waits for a body** (finding 7's first half) needs both, in the same seconds.
- **Two follow-ups' reminders in one conversation share its composer** (finding 9): the composer is one per conversation, and each follow-up keeps its own draft key. A backend preparation per follow-up is a refactor of plan 133's one-tap draft.
- **At the bound, a rejected promise of theirs still suppresses that person's wait** (finding 11): only at 1,000 active rows.
- **The check's candidates are capped before filtering and leave out list mail** (finding 13): the cap of 300 is the check's, as plan 211's; walking more is a follow-up if a check is seen to miss promises.

## Tests run

- **Typecheck:** clean.
- **Lint:** `oxlint --deny-warnings` clean on what changed.
- **Unit and conformance, both stores** (`store.conformance.test.ts`, `idb.conformance.test.ts`; the owed suite has 19 tests in each). These pass, apart from two older SQLite conformance tests ("a promise made one item with its request…", "the code review's second round…": `column index out of range` on a `?1` parameter in `apart`), which fail the same way on `main`.
- **Migrations:** `migrations`, `migrations-shipped`, `migration-rule`, and IndexedDB's `owed-upgrade`.
- **Core, AI and backend:** core `followups`; AI `followups` and `their-promises`; backend `their-promises`, `owed`, `followups`, `promise-answers`, `hand-to`, `promise-time`, `today`, `dated`, `ai-limiter`, `account-checks`. One `dated.test.ts` test ("a send between the offer and taking it…", expecting old quote marks) fails the same way on `main`.
- **Web units:** `followups-copy`, `followup-nudge`. `packages/i18n`'s scan fails on `apps/site/src/copy/en.ts`, as on `main`.
- **E2E** (`E2E_PORT=5791`):
  - `followups.spec.ts`, all 9 tests, including plan 280's (axe in light and dark).
  - `what-matters-feed`, `today`, `settings-search`, `ai-no-consent`, `hand-to`: 27 of 29 pass.
  - `what-matters-feed.spec.ts:1194` fails on `main` too.
  - `today.spec.ts:935` failed twice at a load of about 18 and passed four times at 4–9: flaky under load.
- **Perf:**
  - Follow-ups' workload gate on both stores, with a third of the 1,000 active rows promises of theirs. A sender's open promises to you take 0.34 ms on SQLite and 0.13 ms on IndexedDB, at a load of 18.
  - `migrations.perf.test.ts`: v84 (then v84) takes 166 ms with 50,000 closed follow-ups at 57,000 conversations.
- **Not run:** `pnpm test:all`, which the migration and the store contract call for. The shared machine's load stayed between 4 and 18. The real-model eval and the panel wait for the owner's go-ahead.
- **Visual:** the card in light and dark beside its neighbours (`FOLLOWUP_SHOTS`). It sits on the subject's column like the wait's card, and the top's heading counts only the firm promises.

## The Astra and Fable reviews (the owner: "fix them all")

Astra (`gpt-6.2-astra` on Codex, high effort) and Fable (Claude Fable 5.2) reviewed the branch read-only, each on its own: 14 findings each, some the same. The fixes have regression tests; those for the attachment, Spam, hold, trusted-send and repeated-promise findings were checked by taking the fix out.

**Fixed (Astra):**

1. Reading what you send carried promises of theirs from a conversation with Spam in it. It now goes through `owed.openFor`, the store's rule for what may be material; Fable raised it too.
2. A kind the app doesn't know, overdue, woke the timer at once, forever. `nextDue` reads only known kinds, in both stores.
3. An older "got it" of yours could close a promise after a newer move. It must postdate `moved_at` too, in both stores.
4. SQLite set a relay's hint from mail older than the last move; IndexedDB didn't. They agree now.
5. The transport didn't check that the quoted message of yours (`answering`) was still one it may quote. The last look compares its id.
6. A delivery that is only a file was dropped for its empty body. A file alone, to someone who owes one, is read.
7. A file could close a promise over "the final one isn't ready yet". A file is the delivery only when the mail says nothing else (`bare`).
8. A file's uniqueness was checked against at most 50 rows, other people's included. It is now checked against all of the debtor's own open promises, read only when a file is claimed (`claimsFile`).
9. A typographic apostrophe ("can’t") passed the negation check.
10. A conversation held for a body didn't hold its later senders, so their delivery elsewhere could be read before their promise existed.
11. A relay's address matched inside another address ("malex@" for "alex@"). It now needs the whole address.

**Fixed (Fable):**

1. A send that isn't yours for certain dropped the wait and then had its promise refused by the store, so nothing was kept. `FollowupSource.trusted` now reaches `checkSentMail`, and such a send records no promise of theirs and keeps its wait.
2. "Wrote since" stuck once the debtor moved the day: the move's own mail counted. It counts from `moved_at`.
3. The same promise became two rows (said again, or recorded first by your mail). A new one that names the same thing (`sameObject`) as an open promise of that person's is dropped (`saidAgain`).
4. A message read again could add promises at other positions, or bring back one dismissed. A message with a promise of theirs already, closed ones included, adds none.
5. A debtor's mail read again was marked as a check's, so its rows never reached the top. Such mail now has its own source, `requeue`, and lives 14 days.
6. `requeue` walked every message the sender ever sent, by literal address. It now walks the account's last 14 days of conversations by the sender's key, which also catches plus tags and case (Astra's finding about this too).
7. `look()` read the active rows three times. It now reads them twice: once for the waits and what's over, once after they change.
8. Every automated message read all active rows. A service's notice is now checked against the last look's open promises (each finish looks again).
9. `readable()` was a query per row. It is now one store read, `owed.readable(ids, accountId)`, in both stores.
10. `consider` and `considerOwed` repeated the same gate. It is one helper now, `admits`.

**Left, with why:**

- **A partial What matters Undo at the bound** (Astra): it needs 1,000 open promises of your own, with nothing worth less to take the place of.
- **A forged From closing a debt silently** (Fable, "your call"): delivery in a new conversation from the debtor's address is a normal case. Making it a hint would ask for Received on most deliveries, a product change that is the owner's to make.
- **IndexedDB sorting the owed marks on each page** (both): at most 3 days of received mail (14 for a check), the same as the sent marks' paging.
- **Tests for a tie between a sent mark and an owed mark at the same moment, and for the relay branch of the last look** (Fable): the order at a tie is the sent mark's, by the merge's `<=`.

**Tests after the fixes:**

- Typecheck and lint are clean.
- Both stores' conformance (the owed suite now 21 a store), migrations, IndexedDB's upgrade, core, AI, backend (`followups`, `owed`, `their-promises`, `promise-answers`, `hand-to`, `today`) and web units: 2,016 pass. The same two older SQLite conformance tests fail as on `main`.
- `followups.spec.ts`: 9 of 9.
- The follow-ups perf gate on both stores. SQLite's active list once took 29 ms at a load of 19, then 7 ms on both reruns.

## Renumbered for landing

Plan 278 landed first with SQL v83 and IndexedDB 42 (`de08113b3`), so this plan's step is **SQL v84** (`followups_v84`, its rebuild) and **IndexedDB 43**, on a branch rebased onto it. Everything above that says v84 and 43 was written as v83 and 42; the steps are the same.

## The QA panel (the owner: "simulate our 6 or 7 users that do qa")

Seven personas, each with a fictional mailbox written for them (outside the repo, `/tmp/terno-scratch/p280/panel`): Theo (a freelance developer), Priya (a London product lead), María (a Mexico City agency owner, in Spanish), Diego (a Madrid architect, in Spanish), Jordan (a Chicago operations manager), Margaret (a retired teacher in New York) and Sam (a Toronto researcher). `scripts/ai-real/owed-panel.real.ts` (gated) reads each mailbox on real models under the spend ledger, as the app would. Follow-ups goes on Tuesday 2026-11-10 at 09:00, and the checks read what was already there. The rest arrives as live mail at its own moment. The persona opens Terno on Friday 2026-11-13 at 09:30 in their zone. A capture (not committed) serves each copy to the app on that morning and screenshots the Inbox's top, Follow-ups and each card. Each persona then judged their own screens against their own key of what they were owed: four on Fable and three on Astra.

**What the runs found in the reader, fixed in `85c3e9186` and `e24a928ab`:**

- A mail's close or move was dropped when the promise came due while the reading was out.
- "Two open items" was taken as talk to the app.
- A quote whose last words the model reworded was dropped.
- A file alone, or one named in another language, didn't close its promise.
- The check never read service notices.
- The tentative cues missed "intentaré" before a non-ASCII letter.
- The model wrote the sender's "my" (prompt v4 and a local guard).
- A row said the moment the promise turned late ("Tue 9:00 AM") instead of the day promised.

**What the reviewers found, fixed in `e25a12e58`:**

- **Red ink:** every row of theirs was red, read as "all of them overdue". Red now means late and firm; the rest are quiet.
- **The row's name:** a row whose last sender was you showed your name and picture. It now shows who owes it.
- **Undated promises:** a promise with no day showed the mail's date in the date column. It shows none, as What matters' undated promise does.
- **Tentative wording:** "hoped to" and "esperaba" read as given up. A tentative promise now hopes ("Alex hopes to…", "espera…"), and its card says "Maybe by Monday", or "Hoped for Monday" once that day is past, never "Due".
- **Buttons:** Received was the filled button on promises not yet due. The one filled button is now the likeliest step: Received when their mail or a notice may have brought the thing, otherwise Write a follow-up.
- **The follow-up on "wrote since":** a late, firm card whose debtor wrote since hid Write a follow-up. It stays, as the second button (Theo: Marcus wrote about something else).
- **The card's source:** it named the promise's mail even when another mail moved its day. It now names the mail that moved it (`moved_by`, added to v84, which hasn't shipped), or the notice the card asks about. The quote shows on hover only over the promise's own mail.
- **Layout:** the source and "Found with AI" landed in different places from card to card. When a card has a source, the two now share a line of their own under the buttons, with the source's text on the card's text line.
- **The tip:** it promised the Inbox's top, which tentative promises and promises from a check never reach.
- **Prompt v5:** "early next week" became that week's Sunday; a week's start is now its Tuesday. "$1,200" lost its currency; amounts are kept as written.


**The rerun with these fixes (prompt v5):** 56 of 84 promises came out as each persona's key has them, with no false rows. The misses are the expected ones:
- promises the check skips because they are more than 7 days late;
- relays that hint rather than close, by design;
- hedged and holding promises shown as late, by policy;
- group-addressed promises, by policy.

"Early next week" now lands on its Tuesday. The spend ledger (`/tmp/terno-scratch/p280/spend-owed-panel.jsonl`) totals $4.67 for every panel run. Light and dark screenshots of the card were checked after the fixes.

**Left, not this feature's:**

- Margaret's "Got the photos, thanks, dear! … Give Kate my love." made plan 142 wait for a reply. That is the sent-mail reader's judgment, and `isAcknowledgment` rightly keeps a message with more in it.
- "Decirle a Lucía si falta algo" and "Answer Jun about lunch" are the dated reader's items (What matters).

**For the owner:** relay notices closing rather than hinting; what the sidebar's count counts; "Received" for calls and answers; whether a hedged or "I'll get back to you" promise ever turns late; promises addressed to a group; a grace period before suggesting a follow-up to family; and Fable's forged-From close.
