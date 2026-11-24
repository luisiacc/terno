# Plan 261: a code anywhere in the mail, and code mail gets no AI

## The request

> got this email
>
> (Microsoft Token Verification <token@microsoft.onmicrosoft.com>, "Action required: Verify your email address": a
> greeting, three paragraphs about signing up, then "Please verify your email address by entering this code: 391372",
> then "Your code will expire after 10 minutes." and a footer)
>
> one, it should not have triggered the ai summary or the automatic ai draft, its just a code.
>
> also it didn't show the quick code shortcut pill for this, lets fix it and make it be recognize as a code, just the
> presence of the word 'code' and a code should be enough

## What exists

- Plan 72's `findCode(subject, body)` (`packages/core/src/codes.ts`): six digits standing alone, the one closest to a word
  that announces a code ("code", "código", "OTP" …), but only within 120 characters of it (`NEAR`).
- The list's pill (`useThreadCode`, `apps/web/src/lib/codes.ts`) and the thread menu's Copy code read
  `findCode(subject, thread.snippet)`. The snippet is the newest message's first 200 characters. In this mail the code sits
  about 500 characters in, so the list never sees it. That is the missed pill, not the 120-character rule ("this code:
  391372" is adjacent).
- Automatic summaries (`SummaryWorker.consider`, `packages/backend/src/summaries.ts`): new Inbox mail with at least 60 words
  is summarized. Nothing asks whether it's a code.
- Prepared replies (`ReplyWorker.eligible`, `packages/backend/src/replies.ts`, plan 144): a conversation that waits on you
  (`waitingSince`) gets a reply drafted when opened. `token@microsoft.onmicrosoft.com` reads as a person (no list, no bulk,
  no role word), so the thread waits on you and a reply was prepared.
- The digest (`today.ts`) and the dated reader (plan 243) already leave code mail out.

## Design

### Detection: the word and a code are enough

`findCode` drops `NEAR`: the six-digit candidate closest to an announcing word wins at any distance, within the text it
already reads (the subject, then the message's own text up to 20 000 characters, quotes and URLs removed). Every other
guard stays: ids, amounts, phones, references, dates, quoted history, a reply's subject.

### The code is stored with the message

A message's code is found once, when its text is known, and stored: `messages.code` (TEXT, null for none), and
`threads.code`, the newest message's, written by the thread recompute beside `snippet` (same message, same rule). A
`ThreadSummary` carries `code` when there is one.

- At ingest: `findCode(subject, text)` with the body's text when the message brings one, else with its snippet (a
  header-only IMAP message or a Gmail metadata row, as today's list reads it).
- When a body arrives (`setBody`): found again from the body's text with the stored subject.
- A captured (large) body: `stageBody` finds it while the text is still in memory and puts it on the capture
  (`bodyCapture.code`), as it does the snippet. Text in parts is read up to findCode's 20 000 characters.
- Both stores, the same helper (`bodyCode` in `packages/store/src/body-parts.ts`).

The list and the thread menu read `thread.code` (still offered only while the newest message is at most two hours old);
the snippet path goes. Because each message keeps its own subject, a reply's subject is ignored by findCode's own
reply rule, and the "subject only for a one-message thread" rule in the renderer goes with it.

### Code mail gets no automatic AI

- Summaries: a marked arrival that carries a code doesn't count (`SummarySourceMessage.code`): a thread whose only new
  mail is a code is dropped, as one under 60 words is. Asking by hand still works.
- Prepared replies: `eligible` returns null when the message a reply would answer (the newest one not yours) carries a
  code. A reply written by hand, or asked of the AI by hand, is untouched.
- The digest reads the stored code (`DigestFact.code`) instead of finding one in the snippet.

## Revisions after the Codex review

Codex made twelve points against the plan:

1. A large body arriving later (`setBody`) was staged without the subject, so its capture had no code. Both stores' `setBody`
   now read the subject (and In-Reply-To) and pass them to staging; tested with a captured body arriving after the headers.
2. The legacy-body upgrade stages without a subject: its capture's code is undefined, and publication keeps the stored one
   (`code = CASE WHEN … ELSE code END`), so the conversion changes nothing.
3. Sends, seeds and provider drafts: the rule is in the shared insert (`incomingCode`) and body publication, so every path
   gets it; mail of yours (sent or a draft) carries none.
4. The thread's newest message can be yours or a draft, not what the AI reads. The AI checks now read each message's code
   from the summary sources, the newest message not yours for a reply.
5. Dropping a thread's summary for a code would drop a real message that arrived beside it. A code's arrival just doesn't
   count; tested with a long message and a code in one conversation.
6. A repair revealing a code while a summary waits for the limiter: not handled, as rare (the review cap).
7. Mail from before the update has no code stored: accepted. Codes show for two hours, and there are no users yet.
8. Without `NEAR`, "code of conduct" in a footer makes an order number a code. That is what the owner asked for ("just the
   presence of the word 'code' and a code"); every other guard stays.
9. A reply without "Re:" keeps the original's subject: a message with In-Reply-To takes no code from its subject
   (`codeSubject`); tested.
10. The digest now reads the stored code. The dated reader keeps reading the whole text with findCode (plan 243).
11. Cost: findCode takes about 0.08 ms on a 20 000-character body (measured), beside the snippet and tail already made in
    the same place. No change.
12. The legacy fixtures that seed a v37/v38 schema with today's insert needed `messages.code`. They were already failing on
    `threads.only_yours` (plan 256); both are added and dropped around the seed now.

## Migration

SQLite v79: `ALTER TABLE messages ADD COLUMN code TEXT; ALTER TABLE threads ADD COLUMN code TEXT;` Shape only, no rewrites.
IndexedDB: logical schema 79, no version change (absent reads null). Mail from before has no code stored; codes only show
for two hours, and there are no users yet, so nothing backfills.

## Tests

- `packages/core/src/codes.test.ts`: the owner's mail finds 391372; a code far from its word is found (was a negative).
- Store conformance (both stores): a message whose code is past the first 200 characters stores it on the message and its
  thread; a body arriving later sets it; a captured large body sets it; a newer message without a code clears the thread's.
- `apps/web/src/lib/codes.test.tsx`: the pill reads `thread.code`, whatever the snippet says; `codes.spec.ts` e2e adds a
  mail whose code is past the snippet.
- Backend: `summaries.test.ts`, a code mail of 60+ words is dropped, not summarized, while a long message beside a code in
  one conversation still is; `replies.test.ts`, a waiting code mail gets nothing prepared, and the person's later message
  does. Both fail without the fix.

## Perf

findCode is linear over at most 20 000 characters, once per message when its text arrives, beside the snippet and tail
already computed there. The list reads a column it already loads the row for; the renderer no longer runs a regex per fresh
row. Two nullable columns: no index.

## Out of scope

- "Needs you": a code mail from a person-like sender still waits on you until the dated reader says nothing's asked.
- Codes other than six digits.
