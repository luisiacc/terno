# Plan 141: Ask your mail

- **Status:** built and on `main`, code-reviewed in two rounds (see "What building it changed" and "What the code review changed"). The real-model eval (`scripts/ai-real/ask.real.ts`) is written and not run, and the owner's read on a copy of a real profile hasn't happened: both wait for the owner's go-ahead. "Revisions after the Codex review" overrides the sections before it.
- **Builds on:** plan 131 (AI base), plan 85 §6 and revision 10 (Ask Your Inbox's contract, changes noted below), plan 88 (palette), plan 64 (search), plan 101 (older mail, `live: false`), plan 133 §6.7 (invented specifics), plan 140 (`anyOf` in search, proposed: Ask uses it once it lands).
- **Used by:** plan 143 (actions share Ask's box and its history).

## The request

> **Ask your mail (build first):** this answers questions like "What's the Airbnb door code?" or "When does my lease renew?", with links to the source emails. It can run on the existing search, but mail on the machine only goes back 180 days by default, so older questions need a server fetch.

## Decisions (the user, 2026-11-05)

| Question | Decision |
|---|---|
| Where | The command palette: the question and the answer live in ⌘K |
| Older mail | Offer a button first. Nothing goes to the server until it's clicked. What it finds is kept as normal mail |
| Memory | "saved history option, accessible thru the cmd+k palette like 'Previous AI questions' we keep the last 100, delete older" |
| Follow-ups | Yes, one history entry per conversation |
| Models | A cheap model writes the searches, Sonnet 5.5 answers |

## What exists

- **The palette:** `PalettePage` (`apps/web/src/lib/palette-commands.ts:10`), pages opened by a command's `page`, and a create or search row last at the root (`command-palette.tsx:367`). The panel is 640 px wide (`packages/ui/src/components/command.tsx:64`) with a 384 px list (`:143`). It's built for rows, not for reading.
- **Search:** `store.threads.searchText` over FTS5 or the instant index, thread results, every message term on one message. A default search includes Spam and Trash (plan 64). `in:all` leaves them out.
- **Bounded reads:** `threadContext(threadId, budget)` (`mail-store.ts:567`) reads headers first, then body prefixes it selects, and never reads every body. It chooses the newest messages, not the ones that matched.
- **No provider search.** `MailProvider` (`packages/mail/src/types.ts:248`) syncs, executes ops and reads a known body. `fetchFull` is private to Gmail's provider. Plan 69 said "Do not add provider-side search" for its slice. This plan adds it for Ask only, on a click. Ordinary search stays local.
- **AI base:** `forTask`, `AiLimiter` (a person's request counts as spent, outside background ceilings), `ai.cancel`, streams bound to their connection, per-provider consent as summaries do it (`summaries.acknowledged`).
- **Checks:** plan 133 §6.7's invented-specifics check is local and already compares numbers, dates and URLs in normalized form.

## What changes from plan 85

| Plan 85 | This plan |
|---|---|
| §6: a palette mode and a panel | The palette only |
| §6: nothing about older mail | A server search, on a click |
| §6: a question's history unspecified | Last 100 conversations, kept on this Mac |
| Revision 10: scope changeable per question | Fixed: all mail except Spam and Trash |

## Design

### 1. Reaching it

- **`mod+shift+k`** (free today, `keybindings/resolve.ts`) runs `ask.open`: the palette, on its `ask` page. Shown in the shortcuts sheet.
- **At the palette's root,** "Ask your mail…" and "Previous AI questions" are commands. Typing anything also adds a last row, **Ask AI: "…"**, as search has. Enter on a command that matches still wins, so nothing the palette does today changes.
- **No provider:** the page says "Ask needs an AI provider. Use your own key or a local model." with a button to Settings → AI. A Try Pro button joins when Pro exists (plan 85 decision 9).
- **Reopening:** `mod+shift+k` returns to the last conversation for 30 minutes, caret in the follow-up box, so opening a source and coming back loses nothing. "New question" is a row on the page. After 30 minutes it opens empty, and the conversation is in the history.

### 2. From a question to an answer

```
question → plan (cheap, no mail) → local search → passages → answer (streamed) → local checks
```

**Consent, once per cloud provider,** inline on the page: "This sends your question, then the text of the matching mail, to {provider}." · **Continue** · Settings. A local provider doesn't ask. The backend answers `{ status: "consent" }` until the provider is in `settings.ask.acknowledged`, as `ai.summarize` does.

**The plan.** `AiTasks.planAsk`, on the planning model. It receives the question, today, the time zone, account names and addresses, category names, and for a follow-up the earlier questions and answers. **It receives no mail.** It returns:

```ts
interface AskPlan {
  kind: "question" | "command";      // "command" goes to plan 143
  queries: {                         // at most 3, tried together
    terms: string[];                 // one to six; synonyms and both languages welcome
    anyOf?: string[][];              // plan 140's groups, once it lands
    from?: string; to?: string; subject?: string;
    after?: string; before?: string; // YYYY-MM-DD
    hasAttachment?: boolean;
  }[];
}
```

Each field is validated and rendered into the existing search grammar with values quoted. The model never writes a raw query string, so it can't add `in:spam`. Every query runs with `in:all`. Dates must parse, and `after` can't be later than today. A query with no valid field is dropped. No valid query at all means "I couldn't turn that into a search" with Try again.

**Local search.** Up to 40 threads per query, merged by reciprocal rank with a small recency boost. With no hits at all, one more `planAsk` call, told it found nothing, may broaden the terms. So at most 2 planning calls before an answer.

**Passages.** A new read in both stores, because `threadContext` takes the newest messages, and a lease clause may be in the fifth of forty:

```ts
ask.passages(p: { threadIds: number[]; terms: string[]; maxMessages: number; maxChars: number }):
  Promise<{ messages: AskSource[]; incomplete: boolean }>;
```

For each thread, in rank order: the messages holding a term, else the newest. The text is the stored visible text (plan 36) with quotes removed (`withoutQuotes`, `summaries.ts:43`): the first 400 characters, plus up to 2,000 around the first term. At most 30 messages and 24k tokens, smaller when the session's capacity is smaller (plan 131 revision 1, `summaryBudget`'s approach). Mail with no body yet contributes its snippet and sets `incomplete`, and the page says "Some of this mail is still downloading."

**The answer.** `AiTasks.answerFromMail`, on the `ask` model, streamed:

- **Material, not instructions.** Each message is a delimited block labelled `m1`, `m2`, with data tag names neutralized (plan 133 §6.7). No tools, so an injected instruction can only change text the user reads.
- **Rules (frozen, versioned):** answer only from the material. Cite each claim as `[m3]`. If the material doesn't answer, say so with `<status>not_found</status>`, and with `partial` if it answers in part. Give the source's date where it could be out of date ("as of 3 March"). When sources disagree, prefer the newest and say so. Never guess a code, date or amount.
- **Language:** the question's. A Spanish question about English mail gets Spanish.
- **Effort:** `low`, pinned by the eval.

**Checks, local and instant,** on the finished text:

- A citation to an unknown label is dropped. A sentence left with none isn't removed, but the answer is marked: "Parts of this aren't linked to a message."
- Plan 133 §6.7's invented-specifics check runs against the sources, and a miss becomes a line: "Check: 4921 isn't in these messages." A wrong door code is the failure that matters.
- The answer is plain text, and **URLs and addresses in it are never made links**, so a phishing link quoted from mail can't be one click away. A source row is the way to the mail.

**Bound:** at most 2 planning calls and 1 answer per question, plus 1 answer after a click on Search older mail.

### 3. Older mail, on a click

**When it's offered.** As the page's main action when the status is `not_found` or `partial`: "Nothing in your mail on this Mac answers this. It goes back to {date}." · **Search older mail**. As a quiet link under any other answer, because a local answer can be the wrong year's lease. Never offered when every account's mail is already covered back to its beginning (`syncWindowDays` unset to "all"), or for an account the plan's `before` rules out. Offline it reads "You're offline. Older mail needs a connection."

**A new optional provider method:**

```ts
/** Plan 141: asks the server, on a person's click, which older messages match. Reads no body and stores nothing. */
search?(input: { queries: ProviderQuery[]; before: number; limit: number; signal: AbortSignal }): Promise<ProviderHit[]>;
/** Plan 141: downloads these and ingests them with `live: false`. */
fetchHits?(hits: ProviderHit[], sink: SyncSink): Promise<void>;
```

- **Gmail:** `users.messages.list` with `q`. Google documents that `q` "supports the same query format as the Gmail search box" and that it can't be used with the `gmail.metadata` scope; Terno holds `gmail.modify`. `maxResults` is at most 500; this asks for 50. `includeSpamTrash` is left false. `before:<seconds>` is the same form plan 101 already uses. Requests go through plan 62's pacing.
- **IMAP:** `SEARCH` on the selected mailbox, one folder at a time: the Inbox, Archive or All, and Sent, never Junk or Trash. RFC 9051 §6.4.4 defines `TEXT` as a substring of the header or body, and `BEFORE` on the internal date. It says matching "SHOULD be case insensitive" for ASCII only, so a server may miss other case and accents. Each term is sent as typed and without accents, joined with `OR`, and only `UID`s come back. 30 s per account, then what was found so far. The copy says "may not find everything" for IMAP.
- **Newest 50 in all,** across accounts. Already stored messages are skipped.
- **What leaves:** the search terms go to the user's own mail servers and nowhere else. The text of what's found goes to the AI provider, under the consent already given.
- **Kept as normal mail** (the user's choice), ingested with `live: false`: no arrivals, no notifications, filters and the categorizer as for a first sync (plan 101 point 8). Such a thread then appears in its normal lists, at its old date. It's found by later questions and searches with no second fetch, and source links open.
- **Coverage is untouched.** `covered` and the backfill request don't move: this is a few messages, not a span.
- **It must survive sync.** A test pins that a later pass of both providers keeps a message older than the window, because a Gmail reconciliation and an IMAP re-identification both look at dates (`imap.ts:1287`).
- **Storage removal (plan 69)** can remove it later, as any mail. An explicit click fetching it again is a new request.

**In the page:** "Looking in older mail… 12 of 50", cancellable. When it ends, the local search runs again with the same plan and one more answer is written, as a new answer on the same turn. Nothing found: "Your mail servers found nothing either."

The work runs through a new `core.runForAccount`, in the account's existing slot, so it holds sync and ops as plan 107's folder changes do.

### 4. The page

The palette keeps its 640 px and its rows. The answer scrolls in the page's own area.

```
┌ when does my lease renew?                  ⌫ ┐
├───────────────────────────────────────────────┤
│ Your lease renews on 1 March 2027, with 60    │
│ days' notice to leave. [1] [2]                │
│ Copy · Written by Sonnet 5.5                  │
├───────────────────────────────────────────────┤
│ SOURCES                                       │
│ [1] Greenway Rentals  Lease renewal    12 Oct │
│ [2] Ana Ruiz          Re: the flat      3 Sep │
├───────────────────────────────────────────────┤
│ Ask a follow-up…                              │
└───────────────────────────────────────────────┘
```

- **States:** "Looking through your mail…" with `spinner.tsx` (static under reduced motion), then the streamed text, batched per frame. "Stop" and Esc stop it. A second Esc goes back, as pages do. Screen readers hear "Looking through your mail" and "Answer ready", never the deltas.
- **Sources are palette rows:** arrows and Enter, like every page. Enter closes the palette and opens the thread at that message, expanded, keeping the reader's focus and scroll rules. An inline `[1]` is a button that does the same.
- **A source that has gone:** "This message was deleted" and no link. One now in Spam or Trash is named so, and doesn't open with a click from here without a second one.
- **Copy** copies the answer's text without the citations.
- **Closing the palette doesn't cancel.** The conversation lives in a store outside the component (`lib/ask.ts`), and the answer is in the history when it ends. A disconnect aborts it (plan 131 revision 2).
- **Provenance:** "Written by {model}, {date}. It can make mistakes." on the line's tooltip.
- **Errors:** `errorHelp(kind)` and Try again, in the answer's place. A refusal: "The model declined to answer this."
- **Lazy:** the page is its own chunk. Nothing enters the entry chunk.

### 5. Previous AI questions

`palette.askHistory`, "Previous AI questions" (es: "Preguntas anteriores a la IA"), a palette page: newest first, filtered as you type by question text, in memory over the 100 rows. A row shows the first question, how many follow-ups and when.

- **Enter reopens it** with the saved answers and no request. A source is looked up when shown. **Ask again** on a turn runs it fresh and adds a turn.
- **A follow-up on an old entry** sends the earlier questions and answers as context, not the old mail, and searches again.
- **Delete** on a row (`mod+backspace`), with Undo. **Clear AI data** in Settings → Storage empties it all.

```sql
CREATE TABLE ai_conversations (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,               -- the first question, ≤ 200 characters
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ai_conversations_recent ON ai_conversations(updated_at DESC, id DESC);

CREATE TABLE ai_turns (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('question','command')),
  question TEXT NOT NULL,
  answer TEXT,                       -- ≤ 8,000 characters
  status TEXT NOT NULL,              -- answered, partial, not_found, failed, stopped
  sources_json TEXT NOT NULL,        -- message id, thread id, account id, from, subject, date: to show even if the mail goes
  queries_json TEXT NOT NULL,        -- the plan, for Ask again and Search older mail
  model TEXT, provider TEXT, prompt_version INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_turns_conversation ON ai_turns(conversation_id, id);
```

- **Bounds:** the last 100 conversations ("we keep the last 100, delete older"), enforced in the same transaction as the insert. At most 20 turns a conversation; past that, "Start a new question". So at most about 16 MB, about 1 MB in normal use.
- **Removing an account** deletes the conversations with a turn citing it, since answers quote that mail.
- **Not exported, not synced, not in search, not on `MCP_ALLOWED`,** and never in logs. An import doesn't carry it.
- Same tables in `packages/idb/src/schema.ts`, with the cascade registered. Shape-only migration, as plan 112 requires: empty tables.

### 6. Models

`AI_TASK_NAMES` gains `ask`, and Settings → AI gains a row for it.

| | Anthropic | OpenAI | Anything else |
|---|---|---|---|
| Planning | `claude-haiku-5-5` | `gpt-6-luna` | The `ask` model |
| Answering (`ask`) | `claude-sonnet-5-5` | The configured model | The configured model |

- **One provider.** Planning always uses the `ask` target's provider. A question never reaches a provider the row doesn't name.
- **Limits:** a person's request. It takes a foreground permit, is counted under `byHand`, and runs past the background ceilings (plan 131). On a local provider it shares the one slot.
- **Cost, from `prices.ts`:** planning about $0.0001. Answering on Sonnet 5.5, up to 24k tokens in and about 500 out: up to about $0.06. Far less in a typical question, which doesn't fill the budget.
- `ai.usage` shows it under its own line.

### 7. Settings

**Settings → AI → Ask your mail:** the provider and model row, naming where mail goes, and the hint: "Sends your question, then the text of up to 30 matching messages, to {provider}. Spam and Trash are left out." `ask.enabled` is on by default, because nothing runs until someone asks and the first question asks for consent. Off removes the shortcut's effect, the page and the root rows.

### 8. Copy

Everything through `t()` and `L()`, `en` and `es` together: the page, its states and errors, the consent line, the older-mail lines, the history page, the settings group, palette aliases ("ask", "question", "pregunta", "preguntar").

## Tests

- **Plan validation (unit):** a raw operator in a term is quoted, not parsed; `in:spam` can't appear; a bad date is dropped; no valid query says so; both languages.
- **`ask.passages` (conformance, both stores):** a term in an old message of a long thread is chosen over newer ones; no body sets `incomplete`; the budget holds; Spam and Trash are never read; merged threads.
- **Worker (fake provider):** consent asked once per provider and not for local; no mail in the planning request (canary); zero hits gives one broader plan and then not-found, with no answer request; a citation to `m99` is dropped; an invented digit gets its line; a URL is never a link; injected instructions in mail don't change the output on the scripted attack; cancel writes nothing; closing the palette doesn't cancel; a provider switch sends nothing further (plan 131).
- **Provider search:** Gmail asks for `q` with `before:` and 50 results, and skips stored ids. IMAP searches the right folders and never Junk or Trash (`imap-*.int.test.ts`), and stops at its deadline with what it has. No body is read before the click. Ingest is `live: false`: no arrivals or notifications. **A later pass of each provider keeps the old message.** No search request is ever made without the click.
- **History (conformance):** the 101st conversation deletes the oldest in one transaction; 20 turns cap; cascade; removing an account removes what cites it; Clear AI data empties it; delete and Undo; absent from export, bootstrap and MCP.
- **Reopening is free:** opening an entry sends nothing.
- **e2e (`ask.spec.ts`, no tag; `@design` only for the page's look):** ⌘⇧K, ask, a source opens the thread, ⌘⇧K returns, a follow-up keeps one entry, Previous AI questions reopens with no request, delete; not-found offers older mail and a click ingests from the fake provider and answers; consent; no provider; en and es; axe light and dark; screenshots looked at in every design.
- **Eval (real model, gated, synthetic mail):** `scripts/ai-real/ask.real.ts` over `packages/mock-data`: 40 questions with known answers, including a door code, a renewal date, a fact in the fifth message of a thread, a question whose answer isn't there, conflicting sources, Spanish on English mail, and an attack. Measures: right answer, right citation, says not-found when it should, invented specifics (must be zero), cost and time.
- **Release gate:** a run on a copy of a real profile, as plan 133's own-mail gate did, read by the owner.

## Performance

- **Retrieval holds at 50k+ threads in both stores** (`ask.perf.test.ts`): three queries plus passages ≤ 50 ms in SQLite, one frame per slice in IndexedDB, nothing past the slicer's budget, including the term-in-an-old-message read on a 5,000-message thread.
- **History:** reading the 100 rows ≤ 5 ms; the prune is one indexed delete.
- **Migration ≤ 1 s at 50k threads:** two empty tables (`migrations.perf.test.ts`).
- **Entry chunk unchanged.** The page and its strings' code are lazy.
- **Idle means idle:** no timer, no work and no RPC until someone asks.

## Out of scope

Embeddings and semantic search (plan 85). Searching Spam or Trash by asking. A side panel. Answers in list rows or notifications. Acting on an answer ("remind me about that"). Attachments' contents: only what the mail's text says. Searching older mail automatically, by the user's choice. Pro gating, which arrives with plan 85.

## Order

1. Tables, conformance, migration gate.
2. `ask.passages` in both stores, gates.
3. `planAsk`, `answerFromMail`, prompts v1, fake, contract tests, the eval.
4. `ai.ask`, events, consent, cancellation, checks.
5. The palette pages, `lib/ask.ts`, the shortcut, screenshots.
6. Previous AI questions.
7. `MailProvider.search` and `fetchHits`, Gmail then IMAP, `ai.askOlder`, the button.
8. Settings, copy, tip-free first use.
9. Real run and the owner's read.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, `/tmp/terno-plans-141-145/141-ask-your-mail.out`) raised 12 points, all accepted. Each replaces what the sections above say.

1. **A follow-up's plan does carry mail-derived text.** §2's "receives no mail" holds only for a first question: earlier answers quote mail, so an instruction preserved in one could steer the next search and so what's uploaded. In a follow-up, earlier answers go in a data block as material, not instructions. The consent line and the hint say the question, account names and addresses, and earlier answers go to the provider. A two-turn injection test tries to redirect retrieval.
2. **Consent is for a destination.** Not `acknowledged.includes(providerId)`: `compatible` covers many servers. It's keyed by `destinationOf` (`voice-learner.ts:112`: provider, preset, endpoint origin), which plan 133 already uses, validated before every dispatch, and planning and answering are bound to the one acknowledged target.
3. **History knows what fed it.** Each turn records every account that contributed (`account_ids_json`, cited or not, failed turns too), and a follow-up inherits its conversation's. Removing an account deletes those conversations and aborts requests depending on it. A write checks the conversation still exists and a clear generation inside the transaction in both stores, as summaries do, so deleting or clearing during an answer can't be undone by a late write.
4. **No query strings.** The parser's quoted value has no escape (`parse.ts:135`), so a term holding `"` could end its value and add operators. The plan builds a validated `SearchQuery` directly, forces its scope to `all`, and uses the structured search port. Tests include embedded quotes.
5. **Passages keep the query.** `ask.passages` takes the queries, not flat terms, and gets matching message ids through each query's whole predicate on one message, in both stores. Otherwise a thread that matched on Ana's old lease mail could send Bob's newer mention instead. Context is added around those messages.
6. **Ask has its own specifics check.** Plan 133's compares dates by month and day (`checks.ts:78`), so a source's 2026 authorizes an answer's 2027, treats leading-zero digits as equal, and skips brackets. Ask's mode keeps full dates and exact digits, with no placeholder exemption. Regression tests: wrong year, leading-zero code.
7. **What older mail fetched reaches the answer.** Re-running local searches capped at 40 newest threads could leave a fetched old lease outside every page. Fetched message ids go straight into passage selection, ahead of local candidates, before the final budget.
8. **There's no "all" window.** An unset window inherits General's 180 days, and the schema allows 7 to 3650 (`contract.ts:59`), so §3's "unset to all" would hide the button for nearly everyone. It's offered unless the plan's `after` falls wholly inside the accounts' actual completed coverage, a pending backfill says "still downloading", and an empty result never counts as coverage.
9. **IMAP searches every selectable folder,** custom ones included, not just Inbox, Archive and Sent: a lease filed under `Housing` would otherwise be reported as not found. Junk and Trash stay out, the Inbox and Sent go first, duplicates collapse by Message-ID, and the 30 s deadline covers them all. What the deadline left out is said.
10. **The cap bounds the work, not just the output.** Finding a first term could scan thousands of large bodies. Selection is indexed, part scanning is bounded and cancellable with a work limit that returns `incomplete`. Gates cover a match in a body's tail and no match at all, on captured bodies, in both stores.
11. **Everything has a length.** Question ≤ 1,000 characters. Planning context: the last 3 turns, each answer cut to 1,000. Terms ≤ 100, sources ≤ 30, source headers ≤ 300, turn JSON capped, and history is trimmed deterministically. The answer's budget counts headers, question and framing, not only passages (`summaryBudget`).
12. **The palette's keys need work.** Its capture handler takes Esc on any page and goes to the root (`command-palette.tsx:405`), and cmdk's Enter selects the active row whichever control has focus. The parent routes Esc, stopping a running answer first. The follow-up box, Copy, Stop and citations sit outside the list's key handling. Tests press Enter on each.

## What building it changed

- **Terms and groups.** §2's `terms` said "synonyms and both languages welcome", but search holds every term on one message, so synonyms there would lose the mail. Plan 140 landed first, so `terms` are what must all be there and `anyOf` holds the alternatives, and the prompt says so.
- **A stop.** The Tests section says a cancel writes nothing, and the schema has a `stopped` status. A stop with nothing written yet writes nothing. A stop mid-answer keeps what was written as `stopped`, since that's the user's position. A delete, a clear or a removed account keeps nothing, however far it got.
- **An answer's sources are what it cites,** numbered by first appearance. What was read and not cited still counts in `account_ids_json` (revision 3), and isn't listed.
- **Passages read from the found threads' own rows.** A common word's whole doclist would cost 30 ms a query. A rare word's short doclist is intersected instead, and otherwise the thread's rows are looked up in FTS5 one by one. It's held to 50 ms with the instant index current (`ask.perf.test.ts`). While the index catches up the search path has its own budget (plan 140's 60 ms for a query), so `workloads.perf.test.ts` holds passages to 100 ms and the whole to 250 ms there.
- **Older mail's date.** Gmail's `messages.list` isn't documented to have an order, so each new id's date is read from `format=metadata`, which reads no body. That's up to 150 metadata reads for one click, within plan 62's pacing.
- **IMAP's `search` runs a command per clause** and intersects the UIDs, since a search's keys are an object's and a repeated term can't be written as one command. Drafts are left out with Junk and Trash. A folder Terno hasn't read isn't fetched from: its first read takes it.
- **Undo is a row of the history page.** A snack's dock sits behind the palette's modal, so its button can't be reached there.
- **The usage line.** The plan says both "counted under `byHand`" and "under its own line". It's its own `ask` tally, which, like `byHand`, stays outside the background ceilings.
- **A follow-up's consent line** names the question, account names and addresses, and earlier answers, as revision 1 asks.
- **Not built:** the Try Pro button, which waits for plan 85.

## What the code review changed

Codex raised 15 points, all fixed, each with a test.

- **Consent names what was read.** Continue sends the destination the page showed, and any other one asks again. A `compatible` server is named by its host.
- **An account counts from the moment a search finds its mail,** before anything is read or sent, and a store's write refuses a turn drawing on an account that's gone.
- **Ids aren't reused** (`AUTOINCREMENT`), so Undo can't take the place of what was asked meanwhile. Restoring doesn't replace rows any more.
- **What's shown goes when what it quotes goes.** A new `aiAskGone` event reaches every window, and coming back reads the conversation again.
- **IndexedDB has the same work limit as SQLite:** captured parts per query, one body per queue unit, a stop between them.
- **IMAP's 30 s really ends a command.** The session closes at the deadline, and what was found stands as `partial`.
- **Fetched mail is read around the plan's words,** not only its first 400 characters.
- **A source opens where it is now,** after a merge. Rows and inline numbers share one path: Spam and Trash ask twice, a deleted source doesn't open.
- **Readiness is Ask's own target,** and a key added clears "needs a provider" with no reopening.
- **A reopened conversation gets a fresh older-mail offer,** which an answered question also gets, as §3 asks.
- **Off means off for older mail too,** whatever a stale page still shows.
- **The prompt is fitted whole:** headers bounded, the last messages dropped, then the one left cut.
- **No ring around the answer pane** (plan 52). It stays reachable by Tab, to scroll.

A second round, on the fixes, raised 6, all fixed: a read under way when something goes can't bring it back; an open history empties and drops its Undo when another window clears; a source's state is asked at the moment it's opened; once a captured body is past the work's limit no older one is read, the same in both stores; a follow-up's context goes first on a small window, and a question that still can't fit is refused rather than sent; and a cold IMAP search uses one LIST, so a second can't hang past the deadline.

## What the full run showed

`pnpm test:all` passed in 1,174 s on a machine shared with other work. Each failure on the crowded first pass passed alone, and none touched Ask: attachment conformance, W02's chunked actions, `upgrade.volumes`, the categorization eval, ghost text, and the timing of `attachment-accounting`, the instant index, migrations and search-everywhere.

## What the eval and the panel changed

Real models, on a copy of one real mailbox (5,939 threads, three accounts, Spanish and English) with its keys and queued work removed, read by five reviewers with different concerns: a fact auditor, a busy owner, a safety hawk, a bilingual editor and a recall PM. Four rounds, each reviewer blind to the others. No mail is recorded here. The owner's read is still theirs.

- Round 1 had nine answers that four or five reviewers called wrong; the last panel read had two. Prompt version 5 came after it: its change for two totals and the language rule were checked on the real mail by script and by hand, not read again by the panel.
- **What changed:** a status word is never a required term, and a question gets a query of the sender alone and one without the name (a bank writes under its initials); a meaning is one `anyOf` list; "this week" is 7 days. The answer is told how many it was shown and whether more match (`moreMatch`), says "at least", never shows its working or corrects itself in the text, gives one total at most, and leaves out a one-time code it wasn't asked for. A not-found answer keeps no `[n]`: with no sources it pointed at nothing.
- **Overruled, with the data:** reviewers read "PR not found" as a retrieval miss. Those messages are in Spam, which Ask deliberately doesn't search.
- **Limit:** sums and counts are still the model's, over what it was shown, so it says "at least" or "roughly". Doing them in code is a feature, not a prompt, and isn't here. One panel complaint stays: a time zone stated for a guest can be read as the time's own.
