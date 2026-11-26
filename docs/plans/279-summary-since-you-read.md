# Plan 279: the summary says what's new since you read

- **Status:** built on `t3/summary-since` (a worktree), not on `main` yet. Code-reviewed by Codex, reviewed again by Fable 5.2 and Astra, measured on the corpus. Later sections override the Design where they differ.
- **Builds on:** plans 132 (summaries), 148 and 181 (the card), 151, 153 and 241 (the prompt and how it's measured), 225 (what's shown is read).

## The request

Research on what people want from AI in email (Reddit, Hacker News, Superhuman, Shortwave and Fyxer users) found a specific request: people with long threads ask "what changed since I last looked?" and "what decisions are waiting on me?" rather than a summary of the whole conversation. The idea: a "since you last read" version that covers only the messages after the point the user stopped reading: what was decided, any new or changed date, and what is now asked of you.

The owner's answers to the discussion (2026-11-25):

> 1. that's fine *(the label is "New since Tue 3 Mar", a date, not "since you last read")*
> 2. lets show 'since' until newer mail replaces it
> 3. yes do swap inplace
> 4. list first oly *(rows from new messages are listed first, with no "New" word)*
> 5. yes if it changes something, otherwise not *(one new message gets a since line only when it changes something)*
> 6. no *(What matters' line stays the whole summary's)*
> 7. yes i agree *(no rolling summary: the whole conversation still goes to the provider)*
>
> lets start planning with yourself and codex, also include fable 5.2, then proceed to build it. lets do this in a worktree.

## What exists

- **One summary a conversation** (`ai_summaries`, `packages/db/src/ai-summaries.ts`, `packages/idb/src/ai-summaries.ts`), made when new mail arrives (`SummaryWorker`, `packages/backend/src/summaries.ts`) or by hand (`ai.summarize`). `body_json` holds `{ summary, items }`. A newer message re-queues it, and the old one is hidden by its `source_stamp` until replaced.
- **What matters reads it:** `summaryAsksNothing` (`packages/store/src/today.ts:117`) drops a conversation from Needs you when its current summary has no action and no question, and `summaryLine` (`packages/backend/src/today.ts:978`) shows its first sentence. So the whole summary has to stay current, and stay what it is.
- **Read state is per message** (`messages.is_read`), synced both ways with Gmail's UNREAD, IMAP's \Seen and Outlook's isRead. Mark as read sets every message; Mark as unread clears only the latest (`packages/db/src/actions.ts:91`).
- **The reader already reads it per message:** `useFold` opens each unread message and the last one, decided once when the conversation is first shown (`apps/web/src/components/reader.tsx:547`). `Thread` is keyed by the conversation, so its first render is the showing's start.
- **What's shown is read** after 450 ms (plan 225), well before a summary comes back (3 to 6 s) and before anyone clicks Summarize.
- **New-mail marks** (`ai_new_mail`, `wants_summary`) are written in the ingest commit for each message that arrived as new mail, and consumed only when a summary is written or dropped (`finishSummary`, `dropSummary`). `SummarySources.messages[].markedAt` carries them.
- **What's sent** (`assemble`): the newest inbound message whole (4,000 tokens), the 12 others before it at 400 tokens without quotes, headers for 40 more.
- **The card** (`thread-summary.tsx`, `Ready`): a header row (title as the disclosure's trigger, provenance, Copy), then the summary and the rows. Copy copies the summary and every row.

## Design

### 1. Where "new" starts

The **boundary** is a message: everything from it on, in the conversation's order (date, id), is new. Over the conversation's messages, leaving out trash, spam and drafts, it is the earliest message someone else wrote that is any of:

1. **unread now;**
2. **marked as new mail** for summaries (`markedAt` not null): it arrived since the last summary was written, so the 450 ms read of plan 225 can't hide it from the summary it triggered;
3. **at or after the reader's snapshot,** for a summary asked by hand (§3).

No column and no migration: unread state and the marks are already in `SummarySources` (`isRead` is added to its message rows, a column both stores already read). Your own messages are never the boundary, but one that falls after it is in the new part, as context.

There is a **since** only when the conversation also has at least one message before the boundary (something already read), and at least one message after it that someone else wrote. A conversation never read, or with nothing new, gets the whole summary alone, as today.

### 2. What's sent, and the prompt (version 9)

- `ThreadText` gains `isNew?: true`, written as `new="yes"` on each message from the boundary on. `assemble` gives the new messages room first: each new message from someone else gets up to 1,000 tokens (the newest keeps its 4,000), and the 12 "others" are chosen newest first as today, so with more than 12 new messages the oldest new ones go as headers. A boundary that `fit` cut away leaves no `new` at all, and so no since.
- The system prompt, full version only, gains one paragraph and one field:
  - `"since"`: only when messages are marked `new="yes"`. One or two sentences on what those messages change about where things stand: what was decided, a date that is new or moved (say what it was), and what is now asked of the reader. Not what was already known before them: text a new message quotes or forwards from earlier in the conversation isn't new, and the reader's own messages are context, not news. It doesn't repeat the items. **Empty when the new messages change nothing** (thanks, an acknowledgement, a "will do"): the owner's answer 5.
  - The summary and items keep every word of version 8: they cover the whole conversation.
- The compact prompt (a small window) gets neither, and sends no `new`: its window is at its floor (plan 241, revision 1).
- `validate` holds `since` to the summary's checks (words that fade, a currency or amount the mail doesn't give: one repair turn, then it's dropped, never the card), at most 400 characters, plain text.
- The schema gains `since: string` (required, may be empty), so every transport of the ladder gets it. A model that returns none is the same as empty.
- `SUMMARY_PROMPT_VERSION` goes to 9; `SUMMARY_WHO_ACTS_SINCE` stays 7.

### 3. Asked by hand

`ai.summarize` takes `since?: messageId`: the reader's snapshot, the earliest unread message someone else wrote when this showing began. `Thread` takes it once on its first render (`useState`), as `useFold` takes its own, and records it in the summaries store (`noteShown(threadId, messageId | null)`), so the toolbar's button and the palette send it without knowing the reader. The backend takes it as one more source of §1's boundary; one that isn't in the conversation is ignored.

### 4. Stored

`body_json` becomes `{ summary, items, since?: { from: messageId, text } }`: written only when a since was asked and came back non-empty. No migration: the column is JSON already (plan 267). The boundary is part of the prompt, so it's part of the content hash: the same text with a different boundary is a new request, and the same boundary reuses. `summaryAsksNothing` and `summaryLine` read only `summary` and `items`: What matters is unchanged. `AiSummary` (core) gains `since?: { from: number; text: string }`; `viewOf` reads it, and drops one that's malformed or names a message the conversation no longer has.

### 5. The card

- **Shown by default whenever the summary has a since** (owner, answer 2): it stays until newer mail replaces the summary, whatever the read state is when the conversation opens.
- **Swapped in place** (answer 3) with BoardUI's segmented control (`ToggleGroup variant="segmented"`, `size="sm"`): **New since Tue 3 Mar** · **Whole conversation**. Each one replaces the paragraph in the same card; the rows don't move. The date is the boundary message's, in the reader's short date (`listDate`'s style), so the label is always true, even after mail was read on another device. The choice isn't remembered: each conversation opens on its since. It sits in the header row, after the title; at the narrowest reader it wraps under the title, as the header's tools already allow.
- **Rows:** the whole conversation's, with those citing a message from the boundary on listed first, in their own order, then the rest (answer 4). No new word or mark.
- **Copy** copies the view on screen: its paragraph, then the rows.
- **Closed** is one row, as today: the toggle hides with the panel, since it changes only what the panel shows.
- No motion beyond the panel's own; the swap is instant (a word change, under `--motion` everywhere).
- en and es strings: `summary.since.view` ("New since {date}" / "Novedades desde el {date}"), `summary.whole.view` ("Whole conversation" / "Toda la conversación"), and the group's name for screen readers (`summary.view`, "Summary view" / "Vista del resumen").

### 6. Privacy and cost

Nothing goes anywhere new. One new fact reaches the provider the user chose: which messages are new to them (`new="yes"`). Plan 97 covers mail metadata sent to that provider; Settings → AI's wording ("the text of each new conversation") stands. One request a summary, as now, with about 100 more output tokens and about 500 more characters of prompt: under 10% of a summary's cost, which is $0.0002 to $0.001.

## Edge cases

- **Your own reply in between** (read m1–m5, your reply m6, m7–m8 unread): the boundary is m7; your reply is before it. A reply of yours after the boundary is context only.
- **One new message:** a since only when it changes something (the prompt's empty case). Under 60 words it gets no automatic summary at all, as today; Summarize by hand still works.
- **A long gap:** a pending summary older than 3 days is dropped and its marks pruned, so nothing runs by itself; by hand, the snapshot carries the boundary. More than 12 new messages: the oldest new ones go as headers, and the since describes the newest.
- **Almost everything new** (only m1 of 30 read): a since is still made; the prompt's "what changes where things stand" keeps it short. Measured in the eval; if it reads as the summary twice, a rule follows.
- **Forwarded:** a "Fwd:" that starts a conversation has nothing before it: whole summary only. A forward inside a conversation repeats old mail in its quote, which the prompt says isn't new.
- **Mail read on another device before it reached Terno** is still marked as new mail: the since covers it, labelled by its date, which is true. The owner's answer 2 accepts a since that outlives reading.
- **Merges, trash, spam, a removed message:** the stamp already hides the summary; the boundary is worked out again on the next run. A since naming a message that's gone isn't shown.
- **New mail arriving while the conversation is on screen:** unread (plan 225) and marked: the next summary's boundary.
- **A stored version 8 summary** has no since: the whole summary, as today, until its conversation changes.

## Tests

- **Unit, `summarize.test.ts`:** version 9; `new="yes"` only on marked messages; the compact prompt has neither the paragraph nor `new`; `since` validated like the summary (repair once, then dropped, card kept); empty `since` stays empty; at most 400 characters.
- **Unit, `summaries.test.ts` (backend, fake provider):** the boundary from unread, from a mark (read meanwhile), and from the by-hand snapshot, the earliest of them; own messages never the boundary; no read part or no new inbound part: no `new` sent and no since stored; the boundary in the content hash (same boundary reuses, another asks); `body_json` holds `since.from`; a since naming a removed message isn't read; new messages get their larger room.
- **Conformance, both stores:** `sources` reports `isRead`.
- **Unit, web:** rows citing new messages first; Copy follows the view.
- **e2e (`summaries.spec.ts`, `@design`):** a conversation with a since opens on it, the toggle swaps to the whole summary and back, in place; the card's left and right edges unchanged by the toggle; the header holds at 1100 px; axe light and dark; en and es. The by-hand request sends the snapshot (a conversation shown unread, then read by the dwell, still gets its since).
- **Eval (real model, gated):** the corpus with a boundary per conversation (§ "Eval" below), version 8 against version 9: the whole summary mustn't get worse (plan 153's fact audit, blind, Claude and Codex), and the since is judged for wrong facts, a change missed, old news reported as new, and an empty since where something changed.

### Eval

`summaries-corpus.real.ts` gains `TERNO_AI_SUMMARY_SINCE=1`: each conversation of three or more messages gets a boundary at its last run of inbound messages after the reader's last own message (or the last one or two inbound messages where the reader never wrote). The fictional set's answer keys don't cover what changed, so the audit judges the since against the mail itself.

## Performance

- Off a hot path: `summarySources` reads one more column of rows it already reads. The reader's snapshot is a `useState` initializer over messages it already has. No migration.
- The card renders the toggle only with a since; one more `ToggleGroup` per open conversation.

## Out of scope

- What matters' line (owner, answer 6) and notifications.
- A rolling summary that sends only new messages (answer 7).
- A since for the digest or the dated reader.

## Order

1. `isRead` in `SummarySources`, both stores; conformance.
2. The prompt, version 9, `since` in the schema and `validate`; unit tests.
3. `assemble`'s boundary and room, `body_json`'s since, `viewOf`, `AiSummary.since`; `ai.summarize`'s `since`; backend tests.
4. The card: toggle, row order, Copy; the reader's snapshot; strings; e2e; screenshots in every design, light and dark.
5. The eval and the blind audit.

## Revisions after the Codex and Fable reviews

Codex (read-only, against `58f126279`) and Fable 5.2 (read-only, a product and prompt view) each raised 12 points without seeing the other's. These replace what the sections above say where they differ.

### Where "new" starts

1. **The new part is the conversation's last run, not "from the earliest unread".** (Fable 7, Codex 1 and 4.) One stray old unread message, or a Mark as unread used as a reminder, made nearly everything new. Over the messages in (date, id) order, leaving out trash and spam, the **anchor** is the last message that is the reader's own, or is read and not new. The new part is every message after it, the first included. A message counts as new when it is unread, or carries a **fresh** mark (`markedAt` at or after the worker's floor, `max(now − 3 days, enabledAt)`, and not a code: the same test `consider` uses, so an expired or left-behind mark counts for nothing), or is at or after the reader's snapshot (by hand). A read hole ends the run: a read message after an unread one is the anchor. A reply of yours means you were there, so the new part never starts before it. There's a since only when the anchor exists (something before) and the new part isn't empty.
2. **Nothing new, but a since already stored:** a summary made again with no newer mail (a body arriving late, Summarize again, Try again after the dwell) keeps the stored `since.from` as its boundary when that message is still in the conversation and nothing of yours comes after it. Owner's answer 2: a since stays until newer mail replaces it. (Fable 12, Codex 5.)
3. **The reader's snapshot is the earliest unread message seen during the showing,** not only on the first render. A cached copy can be drawn read and refreshed unread within the dwell, and the dwell then reads it. Each drawn `detail` until the showing ends updates the snapshot (the earliest wins), held in the summaries store per thread and reset when the conversation is shown again. So Try again, a body that was downloading and the palette all send it, and `handlers.ts` passes it to `request`. (Codex 2.)
4. **A request joins a run on the thread only when both resolve to the same boundary.** Otherwise it waits for that run to end and asks with its own. Rare: a click on Summarize while new mail's summary runs. (Codex 3.)

### The prompt

5. **The since never says what the reader has to do.** Asks stay rows, where Needs you reads them (`summaryAsksNothing`). The since says what was decided, what moved (from what to what), and what arrived that the reader was waiting on. When the only change is a new ask of the reader, the since is empty, and that row is listed first. The summary and items keep version 8's words, and the paragraph says `new="yes"` changes nothing about them. (Fable 1, Codex 9.)
6. **Placement:** the since is the last entry of "Return:", after the items' rules, and last in the schema, so the summary and items come first. The ladder's example has `"since": ""` (a filled example gets copied). CHECK names the since. Empty is said to be the usual answer for a courtesy reply, and a restatement of the new mail isn't a change. (Fable 3, 4.)
7. **A since the summary already says is dropped,** by the rows' own test (`repeats`): what the card shows then is the whole summary, with no toggle. (Fable 2.)
8. **The since is asked from the final fitted thread.** `fit` can cut the boundary, or every message before it. When the first new message or a message before it doesn't survive, `new` is taken off and the request is the whole summary's alone. The budget counts the since's words whenever a boundary exists (`summaryBudget(window, since)`), so a whole-only fallback has room to spare. The new messages keep the others' 400 tokens: raising them would take room from what came before. (Codex 6, 8.)
9. **A missing `since` reads as empty.** `json_schema` (OpenAI, Anthropic) is sent a plain required string. The parse first fills a missing or null `since` with "", so a server without `json_schema` that leaves it out costs no repair and loses no card. Tested through all three rungs of the ladder. (Codex 7.)
10. **Not taken: a citation for each claimed change** (Codex 10). The since is held to the summary's checks (fading words, an amount or currency the mail doesn't give). Asking for a supporting message per change costs a field and a check that "moved from X to Y" can't pass. Old news is the prompt's job, and the eval measures it by script (point 14).

### The card

11. **The control is the panel's first line,** on the paragraph's left edge, not in the header. The header already holds the title, provenance and Copy, and two labels don't fit there in Spanish. Inside the panel it hides when the card closes, with no special case. (Fable 10, Codex 11.)
12. **Labels:** "Since Tue 3 Mar" and "Whole conversation" ("Desde el mar 3 mar", "Toda la conversación"). "New" would be untrue once read (answer 2), and is longer. The date is a calendar date, never a time, from a formatter of its own: "Since today" and "Since yesterday" are their own strings, and a date in another year carries the year. (Fable 9, Codex 11.)
13. **Copy** copies what's on screen, its paragraph and every row. Rows aren't split or marked: the owner chose order only (answer 4). (Fable 11, the part about a divider not taken.)

### When a summary is made

14. **A short reply in a conversation that already had a summary is summarized.** The 60-word floor (plan 132 §1) made the feature's best case vanish: "Let's do Thursday instead" got no automatic summary, and the old card went stale and disappeared. When the thread has a stored summary and the new mail is from a person (plan 269's `person`), the floor doesn't apply. A courtesy reply then gets a summary with an empty since. (Fable 5.)
15. **The content hash covers which messages were sent,** by id, and the boundary, not only their text. Relabelled `m1`, `m2`, two different messages with the same words could reuse a result whose rows and since name messages that aren't there. (Codex 5.)

### The eval

16. **Boundaries by kind, reported apart:** one new message of many, a run of two to four, almost all new, a new message quoting old facts, and built tails added to fictional conversations: a courtesy tail ("Thanks, got it", "Gracias, recibido"), which should give an empty since, and a material one ("Let's do Thursday instead", "Approved"), which shouldn't. Arms: version 8, and version 9 with the same boundaries. Each run records the boundary, the since, and any failure or cut-off. Measured by script: rows lost against version 8, especially asks (What matters' regression), the since's word overlap with the summary, and whether every date or amount in the since appears in a new message's own text, quotes stripped (a proxy for old news). Then the blind audit (plan 153's) by Claude and Codex, on changed cards only, paired. (Fable 6, Codex 12.)

## What the code review changed

Codex (read-only, against `e3d3b7875`) raised 12 points. Eleven are fixed in `0db93c2d8`, each with a test unless noted.

1. **A stored since kept absorbing newer mail.** With automatic summaries off, a reply read on the phone and unmarked made the request fall back to the stored since, which then covered the old update and the new reply as one. The stored since now records `through`, the newest message it read, and the fallback holds only while nothing came after it.
2. **The snapshot erased a read hole.** It took the earliest unread message, so a reminder left unread further up took in a reply that had been read. It now follows the backend's rule: the last unread run, after the last message that's yours or read.
3. **Not fixed: a request waiting on the worker can lose its own boundary.** It needs the worker to start at one boundary, a read-state sync to move the request's boundary to a marked message, and the worker's write to consume that mark while the request waits. Recorded as a known edge case.
4. **A since that failed a check sent the whole card back for repair.** The repair could drop a row the first answer had right, and an empty card could take the conversation out of Needs you. A since is now checked but never sent back: one that fails goes, and the card stands.
5. **An empty since lost where the new mail starts.** "The only change is a new ask" (revision 5) left the rows unordered. The boundary is now stored with empty text: rows citing new mail still come first, and the card shows only the whole summary.
6. **Trash and spam in the snapshot.** The reader's detail keeps trashed messages, so a trashed unread message could become the snapshot, which the backend then ignored. Both are skipped now.
7. **A trashed start stayed on screen.** The card's reload key now includes whether each message is in the trash, and a start that's trashed isn't drawn. (No new test: the existing trash flow covers the reload.)
8. **An expired mark waived the 60 words.** Only a fresh mark from a person does now. (No test: the daily prune removes expired marks before the worker's pass, so this is defensive.)
9. **A newer summary remounted the card** under the keyboard. The view is now held with the `generatedAt` it was chosen for, with no `key`.
10. **The e2e passed without the dwell having read anything:** an unread message drawn open shows no dot. It now waits for the backend's read.
11. **The window test ingested 1 of its 50 messages** (`||=`). All 50 now, and it still holds at 2,000, 4,096, 8,192 and 32,000 tokens.
12. **The corpus runner marked a run whose start had been cut,** which production wouldn't ask about. It now asks only as production does, and the scoring leaves such rows out of the runs made before the fix.

## The second review round: Fable 5.2 and Astra

> when you're done, do a round of code review with fable 5.2 and astra subagents looking for weird edge cases but valid, possible bugs, possible things that could cause a bad summary, summaries must be concise and to the point, no fluff.

Fable 5.2 and Codex on `gpt-6.2-astra` each read the branch at `0db93c2d8` and the eval's real outputs, without seeing each other's findings, and raised 12 points each. Fixed in `48b9141e7` and `341b89ca2`.

**The prompt (both reviews, and the eval).** "Never repeat the summary" made the model split the news. The summary shrank where a since came back (222 characters against arm A's 302), a cancellation stayed in the summary with the since empty, and a moved deadline left the since while its action row went. The two paragraphs are never on screen together, so:
- The summary and items are written as with nothing marked new. A moved date is the new date there too, and an open action stays a row.
- The since stands on its own: one short sentence of 25 words at most, on the biggest change first (a decision, an approval, a cancellation, a date or amount that moved from what to what), and who changed it. With several new messages it says where things ended up.
- No filler: never "a new reply", "the latest message", or when it arrived.
- Only what the new messages say. Never what they leave out. Never "added" or "replaced" without the earlier state, since an earlier message may be cut. Never "done" or "received" unless a new message says so.
- Never a secret; it says one was sent.
- Never what the reader has to do, answer or has promised, nor a question or offer put to them. A promise still open stays a row when the since tells what led to it.
- Empty for thanks, "got it", a receipt, "will do", a promise to explain later, an opinion or an aside.

**In code:**
- **No since after only your own mail.** "You wrote, a reply came" and "your post to a list, every answer new" make the whole summary the news. In the first run, 67 of 259 asked cards had this shape.
- **A since over 400 characters ends at its last whole sentence.** It no longer stops mid-claim.
- **A since is dropped only when it's the summary again** (contained in it, and 80% of its length). A sentence of the summary is a fine since now.
- **"Monday to Friday" and "de lunes a viernes" are schedules, not floating days.**
- **The reader's snapshot:**
  - It skips drafts (`MessageDetail.isDraft`, both stores).
  - It survives leaving the conversation and coming back with nothing unread, while no mail has arrived.
  - Mail that arrives while the conversation stays open starts it afresh.
- **A send-as alias you've sent from is yours** in the summary's sources. That's plan 17's learned addresses, the rule new-mail eligibility already used. It also corrects "the reader" in the prompt for such mail, and drafting's context.
- **A since never makes a window compact:** a window that fits the full prompt without the since's words gets the whole summary, full prompt.

**Not taken:**
- *Mark excerpts as excerpts* (Astra 3). The prompt words cover it, and an attribute on every cut message would change the whole summary's input.
- *Rows citing new mail marked by the model.* The owner chose order only.
- *Fresh marks during a provider outage make mail read in Terno new* (Fable 11). The label's date keeps it true, and it takes days of failure.

### The eval

GPT Luna, at the task's settings. 371 conversations of two or more messages: the 164 fictional ones and the real sets (Enron, Apache, the Spanish lists). Spend: about $1.30 settled on its own ledger (`/tmp/terno-ai/spend-p279.jsonl`).

| | First v9 words (`p279-b`) | After the review (`p279-b2`) |
|---|---:|---:|
| Cards asked a since | 259 | 192 (only your own mail before: none) |
| Since came back | 79% | 85% |
| Summary length where it did (arm A: 300 to 305) | 222 | 263 |
| Summaries under 60% of both A runs | 42 | 6 |
| Since over 25 words | 77 | 17 |
| Courtesy tail, since empty | 93% | 96% |

Noise is arm A run twice with the same words: on the cards asked a since, ask counts differed in 14 to 17 of them and every ask went from 5 or 6. Against arm A, the first words had every ask gone from 6 and the reviewed words from 8. The 8 include the reader's own promise turned into since prose (`priya-024`), which the last rule addresses (see "The last run").

The courtesy misses left are "Will do." / "De acuerdo, lo hago." read as a commitment ("Bea agreed to send the draft"), which is a real change of state, and one "acknowledged receiving".

### The last run

The reviewed words still lost asks above noise once the reader's own promise was in play. `priya-024`: "Priya welcomed your offer…" became the since and "Bring the table" went. Three more versions on the same 192 cards, against arm A and A's own rerun:

| On the 192 cards asked a since | Asks (A had 73; A's rerun 70) | Every ask gone (rerun: 5) | Asks where A had none |
|---|---:|---:|---:|
| `b3`: the since inside "Return:", a promise rule added | 66 | 8 | 1 |
| `b4`: the since as the last step, after the card and its check; "the reader's own promises included" | 82 | 2 | 5 |
| **`b5`, shipped:** the last step, without that clause | 70 | 5 | 0 |

`b4` padded the card the way plan 241's variant B did: "Keep your promise not to send flowers", "Keep the lamp until Oakfield confirms". `b5` is at noise on every count. What shipped (`b7c0897fa`):
- **The since is the prompt's last paragraph,** after the card and its check: "Last, once the card above is done, write "since". Write the summary and items exactly as you would with nothing marked new, and change nothing in them for "since"…"
- **Its own check comes last:** the biggest change first, only what the new messages say, nothing the reader has to do, answer or has promised, and every item they'd give with nothing marked new still there.

On `b5`: summary length 273 where a since came back (A 302, A2 306), 5 under 60% of both A runs, and a since of median 19 words (14 over 25). One card still loses its ask where A's rerun didn't (`priya-006`, the reader's own "I'll ask Mr Bianchi").

**The tails on the final words** (164 fictional conversations each):
- **Courtesy:** 96% empty. The misses read "Perfect, thanks for the update" as an acceptance, "Will do." as a commitment (both a change of state), and once "Thanks, got it." as "she got the dish".
- **Material:** 91% have a since. Every one without a since has the change in its summary, which the card then shows alone: a short conversation's summary is the change ("Hugh cancelled the proposed lunch…"), and a since saying it again is dropped.

**Spend:** $2.17 settled across every run of this plan, on `/tmp/terno-ai/spend-p279.jsonl`.

**Known and left:** `priya-006`'s promise; a courtesy "got it" read as receipt about once in 160; the outage case (Fable 11); a request waiting on the worker losing its boundary (Codex 3). The blind Claude-and-Codex fact audit of revision 16 wasn't run. The review round read the real outputs instead, and the script measures above stand in for it.

**Tests:** unit and backend (532), both stores' conformance (one SQLite Dated-items failure in `followups.ts`'s numbered parameters, which this branch doesn't touch, so it's on `main`), and `summaries.spec.ts` with `reader-mark-read.spec.ts` in all six designs (36). `packages/i18n`'s scan for hard-coded strings fails on `main` too (`apps/site` copy, `packages/ui/src/brand`), none of it from this branch.

## In `pnpm dev:demo-ai`

> show me examples of the new summaries and since wordings, also lets make sure the demoai command we run has examples like this one with the since summaries too

The demo mailbox is generated from sentence banks, so none of its conversations has something coherent to change. A demo AI launch now adds four hand-written conversations once per profile (`seedDemoSince`, `packages/backend/src/demo-since.ts`; `demoSinceWanted`, which is a dev demo on the fixed clock, so the rating's mailbox stays as rated):
- **Venue for the team offsite:** the loft you chose cancels, and Casa Lamm is held until Monday 27 October.
- **Cena de cumpleaños de papá:** dinner becomes Sunday lunch at El Cardenal, no wine needed, and Diego asks who picks up the abuela.
- **Contrato con Lumbre Café:** two new messages. Legal approves with 45 days and 5%, and Andrés accepts and proposes signing Tuesday 28 October.
- **Factura de septiembre:** "¡Gracias, recibida!", nothing changed.

Each has mail already read from someone else, then unread mail. They're dated 14:43 to 14:55 UTC on 22 October, under the Inbox's top six (14:58 and newer), so the conversations the guide names keep their places.

A new preparation step, `since`, after `conversations`, opens each one as a person would and asks for its summary with the toolbar's button. The reader keeps what it drew unread, so the card opens on what's new. It logs each since, or "whole summary only". A profile prepared before this runs only the new step.

**On GPT Luna, two runs of each** (through the corpus runner, the read flags giving the boundary as production does):
- **Offsite:** "Priya says the Roma Norte loft canceled; Casa Lamm is available for 21,000 MXN and held until Monday 27 October." (both runs)
- **Cena:** "Mariana cambió la comida de cumpleaños al domingo 26 de octubre a las 2 en El Cardenal de San Ángel." The question "¿Alguien puede pasar por la abuela?" is a row.
- **Contrato:** "Legal aprobó el pago a 45 días y la penalización de 5%; Andrés aceptó ambos cambios." The signing date is a row.
- **Factura:** empty in one run, "Laura confirmó que recibió la factura de septiembre." in the other. The courtesy rule holds 96% of the time on the corpus, and this receipt is one of the cases it doesn't.

Tests: `demo-since.test.ts` (seeded once, each conversation's boundary where its unread run starts, dated under the top six), `demo-ai.test.ts` (the step's subjects are the seed's, and an old profile runs only `since`), and `test-hooks.test.ts` (only a dev demo on the fixed clock seeds them). `pnpm dev:demo-ai` itself wasn't launched: it opens a window and would use the demo profile.

## The QA panel

> simulate our 6 or 7 users that do qa and have differemt personalities and get them to use this feature, see what they find and fox the obvious things thqt can be improved, then bring me whatever needs my opinion

The seven people of plan 204's panel (Theo, Diego, Jordan, María, Sam, Margaret, Priya): four on Claude (Fable 5.2 twice, Opus, Sonnet), three on Codex `gpt-6.2-astra`. Each wrote six conversations from their own life as a tester would, with read flags and the since they expected, 42 in all. These went through the shipped prompt on GPT Luna, and each person then reviewed their own cards: the text, and screenshots of the real card in the app, light and dark.

| Average of seven, 0 to 10 | |
|---|---:|
| Since is accurate | 7.9 |
| Since is concise | 9.0 |
| Since tells me what I needed | 6.4 |
| Rows are right | 5.1 |
| The card's look and the switch | 7.4 |
| Would rely on it daily | 5.6 |

**Fixed:**
- **An answer cut off left no card.** 3 of 42 long conversations; the worker treats it as invalid output and stops. A summary's answer may now use 5,000 tokens, not 3,000; the allowance is a ceiling, billed only as used. Rerun three times, none was cut off; one in the 42 still was, once.
- **A scam read as a disagreement** (4 of 7 people): "a conflicting message asks you to verify details … by 5pm Wednesday", "Cirrostack Billing separately requests $38,400". The since now puts it first, names its address and says it looks like a scam, and gives none of its deadlines or account details as the reader's. The summary's own scam rule says the same. All four now read, for example: "A message from accounts@cirrostack-billing.example claims new bank details and asks for $38,400, but looks like a scam."
- **A table of contents for a since:** "Hollis's director-approved options replace Q-20931". It now gives the figures, dates and names themselves.
- **Disagreements settled:** "Brenda confirmed lunch is Sunday 13" while Jean thought the 12th. It says so rather than settling it.
- **The two views the same:** when the since's words are nearly all the summary's and the other way round, there's no switch.

Re-measured on the corpus's 192 asked cards: asks 73 → 73 (A's rerun 72 → 70), summary length 300 (A 311), none under 60%.

**Not the feature:** the screenshots' dates ("Since Oct 19" on a November thread) come from the harness, which moves each conversation to the test app's clock; and "Reply" in English on Diego's Spanish card comes from the test window's language.

**For the owner:** rows (5.1, the weakest score), a since naming what's newly asked of you, overdue marks, Reply on every to-do, and wrong facts in the whole summary. Each is in the report that follows.

### The owner's answers, and the second round

> ok lets do your recommendations for all 6 fixes, then run the rating again and see the new scores

Built (`2a835e61e`), with tests:
1. **Rows.**
   - Your open promises with a day or a concrete thing to deliver are actions; a vague or conditional one, or a "don't", isn't.
   - A request or deadline put to everyone in a group you belong to (your school's parents, your course) is yours; a newsletter's isn't.
   - What someone else owes you is a **Waiting on** row, who first ("Kit: two mornings for the door repair"): at most two, never in an ask's place, never counted in What matters' Needs you.
   - All in the full prompt only: the compact prompt is at its window's floor and keeps its words.
2. **The since may close on what's newly asked** in a few words ("and Helen wants section 2 by Friday"); the row stays.
3. **Overdue.** Each row has `due` (YYYY-MM-DD). A to-do whose day has passed reads **Overdue**, and (round 2) every row shows its day ("by Nov 24") unless its words already name it.
4. **Reply only where replying does it.** An action has `byReply`; one done elsewhere (a call, a payment, a form) offers no Reply, and nor does a Waiting on row.
5. **A stronger model**, measured below. Nothing changed.
6. **A failed summary says so.** New mail whose automatic summary failed shows "Couldn't summarize the new mail in this conversation." with Try again, while that mail is unread (`AiSummaryRead` `failed`).

The answer's new fields are lenient: a server without `json_schema` that leaves `due` or `byReply` out reads as no day and yes, at no repair.

**On the corpus** (371 conversations against arm A): asks 121 → 137, cards losing every ask 9 (A's own rerun: 12), rows 123 → 219, of them 78 Waiting on. Of the fictional cards that gained asks, six of nine match their answer key exactly; the noise is a reader's own "how to" ("Park on the street", "Keep the lamp until Oakfield confirms") and one done promise.

**The second round.** Fresh reviewers, the same seven people, never told an earlier score:

| Average, 0 to 10 | Round 1 | Round 2 |
|---|---:|---:|
| Since is accurate | 7.9 | 7.6 |
| Since is concise | 9.0 | 8.6 |
| Since tells me what I needed | 6.4 | 6.3 |
| Rows are right | 5.1 | 5.3 |
| The card's look and the switch | 7.4 | 7.8 |
| Would rely on it daily | 5.6 | 5.7 |

Flat within a reviewer's noise. Two of round 2's worst cases came from the cards file, not the card: for a card without a since it said "Nothing changed, says the model", where the app shows only the summary (which held the change). That label is fixed in the harness. What all seven repeated:
- **Rows don't show their day.** Fixed: `dueWords`.
- **A real change sometimes got no since** (a moved meeting, a moved appointment, a new quote). Fixed: a since is never empty when new mail moves a date or a time, changes an amount, cancels, approves or decides something. On the panel, sinces went from 31 to 34 of 41, and all three cases are right; courtesy tails still 95% empty, material tails 90% with a since.
- **Other people's tasks in threads you manage while copied** (Jordan, Priya, Diego: "Kit owes Ava two mornings"). Waiting on covers only what's owed to you: for the owner.

**A stronger model (Sonnet 5.5) against GPT Luna**, on the panel's 42, judged blind by Claude and Codex (X and Y at random per conversation):

| | Codex: Luna | Codex: Sonnet | Claude: Luna | Claude: Sonnet |
|---|---:|---:|---:|---:|
| Better card | 8 | 23 | 4 | 16 |
| Key facts missing (high) | 45 (17) | 26 (10) | 25 (2) | 8 (3) |
| Wrong claims (high) | 14 (6) | 12 (4) | 11 (0) | 8 (1) |

Sonnet leaves out far less, is wrong about as often (its one serious error: Margaret's December visit put in November), and gives a since on 38 of 42 against Luna's 30 to 34. It's faster (median 2.9 s against 8.6 s) and about 18 times dearer: $0.012 a summary against $0.0007, about $3.70 a month at 300 summaries against $0.20. Neither caught Theo's invoice whose lines don't add up. For the owner.

**Known:** one long solicitor's thread (`margaret-1`) is cut off in 3 of 5 runs at 5,000 tokens; the card now says so with Try again.
