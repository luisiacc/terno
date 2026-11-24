# Plan 269: a notice gets no summary, because it has nothing to read

## The request

> (a LinkedIn mail, "Daniela Abarca Jiménez via LinkedIn" <messaging-digest-noreply@linkedin.com>, "Daniela just messaged
> you": "1 new message awaits your response", her photo, name and title, a View message button, an Install LinkedIn
> Widgets block and LinkedIn's footer. Its summary: "LinkedIn notified you that Daniela Abarca Jiménez sent a new message,
> but the message's contents aren't included in the email.")
>
> these kinds of messages also should not get a summary, its just a notification and the content is clear, doesn't need a
> summary, lets extrapolate this criteria to similar emails and do something general with a general criteria, get fable
> and astra to pitch in on what they think for this criteria

Fable and Astra each pitched a criterion without seeing the other's. Astra's: skip mail that announces one event (a phrase
list per language and per kind of event, a matching button, nothing else in the body). Fable's: summaries are for mail with
something to read, so count only what a person reads in a machine's mail. The owner chose Fable's rule with Astra's
paired tests ("ok lets do it like that").

## The criterion

**Mail from a machine gets an automatic summary only when it has at least 60 words of real reading.** Real reading means
sentences, not the template around them. Links, buttons, headings, a name-and-title card, label rows and the footer don't
count. A machine's mail with several facts in it (three or more amounts, dates or times, such as an itemized bill) is read
as today. Mail from a person is counted as today. Asking for a summary by hand still always works.

## What exists

- `SummaryWorker.consider` (`packages/backend/src/summaries.ts:302`): a queued thread is dropped when it is spam or trash,
  outside the Inbox, in a Gmail tab (`sources.tab > 0`), when its new mail is only codes (plan 261), or when the new
  messages' own text has fewer than `MIN_WORDS = 60` words. `wordsIn` counts every `\S+` in the first 4,000 characters,
  so a URL, a button label, a promo block and a legal footer count as words. That is how the LinkedIn mail passed.
- The worker never asks whether a sender is a machine. `SummarySourceMessage` carries `list` only.
- Plan 17's `automatedLevel` and `senderIsPerson` (`packages/core/src/people.ts:90`, `:139`): a person is level 0, or level
  1 that the user has written to. The dated reader already puts `person` on its rows this way (`packages/db/src/dated.ts:137`,
  `packages/idb/src/dated.ts:144`).
- HTML-only mail is stored as one line: `htmlToText` (`packages/mail/src/visible-mail-text.ts:261`) collapses every block
  boundary into a space. Mail with a plain-text part keeps the sender's lines.
- Gmail's tabs keep most social and promotional mail away from summaries, but only for Gmail. IMAP and Outlook accounts
  have no tabs, so every notice in their Inbox is summarized.

## Design

### 1. `readingWords(text)`: what a person reads

A pure function in `packages/core/src/reading.ts`, over a message's own text (quotes already removed):

1. **No lines, no judgement.** Text with no line break is counted whole, as today. That is how HTML-only mail is stored
   (`htmlToText` flattens its blocks) and how a one-line note looks: template and prose can't be told apart.
2. **Lines.** Split into lines and trim each one. Links and tokens with no letter or digit (`·`, `|`, `—`, `----`)
   aren't words.
3. **Footer.** Drop every line that has a footer phrase: unsubscribe, "you are receiving", "this email was sent to" or
   "intended for", "manage your preferences" or "notification settings", "view in browser", "all rights reserved",
   "registered trademark", ©, and their Spanish forms. The phrases are language data: `FOOTER_WORDS` in `packages/i18n`
   beside `CODE_WORDS`, a `Record<LocaleId, …>`, so a new language must add its own. Only phrases that live in footers:
   "privacy policy" and "terms" also head a notice that changes them. A line is dropped, never everything after it: a
   newsletter that mentions unsubscribing in its first paragraph loses that line, not the issue.
4. **Hard wraps.** A line of 50 characters or more, links left out, joins the line after it, so plain text wrapped at 72
   columns reads as its paragraphs.
5. **Prose.** A line, once joined, counts when it has 12 or more words, or 4 or more and ends a sentence (`.`, `!`, `?`):
   "Rollback complete at the edge." Other lines are template: a heading, a name, a title, a button, "Order #123",
   "Total: $18.40".
6. **Facts.** When the kept lines hold three or more distinct amounts, dates or times, the message is counted whole, as
   today: an itemized bill or a schedule says more than its sentences. The patterns move out of
   `packages/core/src/writing/checks.ts` into `packages/core/src/text-facts.ts`, which both use. Times (`14:30`, `6 pm`)
   and numeric dates (`06/03/2026`) are added there for this.

### 2. The worker counts a machine's mail by its reading

- `SummarySourceMessage.person`: from `senderIsPerson`, in both stores, as the dated reader computes it. The
  `correspondents` lookup runs only for a role address (plan 17's level 1), once per sender per read.
- `consider` adds up, per marked message, `wordsIn` for a person's mail and `readingWords` for anyone else's. The sum
  against `MIN_WORDS` is unchanged. A notice beside a real reply in one conversation doesn't hide the reply: the reply's
  words still reach 60.
- Asking by hand (`ai.summarize`) and every other gate are untouched. The gate decides automatic requests only: a notice
  arriving in a conversation that already has a summary leaves it as a short reply or a code does today.

### Examples

No summary (a machine, under 60 words of reading): "X messaged you", "X commented on your post" with no excerpt or a
one-line one, connection and follow notices, "your statement is ready", shipping status, sign-in and password-changed
alerts, a receipt with one total, CI passed or failed, "finish setting up your account".

Still summarized: a GitHub, Jira or Linear notification carrying a real comment, a newsletter, a notice of changed terms,
an itemized bill (the facts), a support desk's reply, an incident report, an invitation with an agenda.

## Tests

- `packages/core/src/reading.test.ts`, on fictional templates, in pairs (Astra's): the same template, sender and footer,
  with and without one detail that matters. A LinkedIn-style message notice (nothing to read) and the same with what she
  wrote (exactly her words count). A one-total receipt (skip), a statement with amounts and dates (counted whole). A
  review notice with no comment (skip), with a real review (keep). An incident update in short sentences (keep).
  Hard-wrapped plain text (all of it counts). A Spanish notice with a Spanish footer (skip). A newsletter that mentions
  unsubscribing first (keep). Text with no lines (counted whole).
- `packages/backend/src/summaries.test.ts`: a machine's notice is dropped with no request to the AI; a person sending the
  same text is summarized; a notice and a long message in one conversation are summarized; asking by hand summarizes
  the notice. It fails with the worker counting every sender as a person.
- Store conformance (`packages/store/src/conformance/ai-summaries.ts`, both stores): `person` for a person, a list, bulk
  headers, a no-reply address, and a role address before and after the user writes to it.
- `packages/backend/src/summary-reading.corpus.test.ts`: over the fictional corpus, every conversation at 60 words or
  more today still is, but for the ones named as meant to be skipped (`steps-004`, a "verify to finish setting up" note
  with four bullets of tips).

## Performance and resources

`readingWords` is one pass over at most 4,000 characters the worker already reads, for new mail only. `person` costs a
primary-key lookup per role-address sender of a thread read. No migration, no network, no model call, no HTML parse on
the backend's event loop.

## Out of scope

- Phrase lists of kinds of notices (Astra's event matcher): the reading count catches them without naming them.
- HTML-only notices. Their stored text is one line, so they are counted as today. Reading them needs the lines worked
  out where the HTML is parsed (the incoming-processing worker) and stored with the message, as plan 261 stores a code:
  a column and every body path. Changing `htmlToText` itself is not the way (see the Codex review). The big senders of
  notices (LinkedIn, GitHub, Google, Slack, Jira, banks, shops) send a plain-text part.
- Prepared replies, the digest and What matters: they already ask whether the sender is a person.

## Revisions after the Codex review

The first draft also made `htmlToText` write a line break at every block's end, so HTML-only mail would keep its lines.
Codex made twelve points:

1. The same notice reaches the worker as an old flattened body, a new one with lines, or the sender's plain text, and a
   footer phrase in a flattened body dropped the whole message. The `htmlToText` change is out: text with no lines is
   counted as today, and HTML-only notices are out of scope (above).
2. A hidden gap wins over a break in `appendText`, and the stores' visibility harness compares stored text byte for byte.
   Moot with the change out.
3. A code split across two table cells (`123\n456`) would stop matching plan 261's six digits. Moot.
4. `withoutQuotes` would cut a reply written below an HTML blockquote at its "On … wrote:" line. Moot.
5. Ask's passages and search excerpts treat a line as a sentence boundary, and MCP returns the stored text. Moot.
6. Dated items and follow-ups split evidence at lines. Moot.
7. `senderIsPerson` is broad: a first reply from a person at `support@` counts as a machine. Kept: a machine's rule only
   drops lines that aren't prose, so a support reply in sentences still counts in full, and one that doesn't reach 60
   words of sentences is short enough to read. A bot at an ordinary address is counted as a person, as today.
8. Ten one-line sentences ("Rollback complete.") would count for nothing, and a long link made its line look wrapped.
   A line of 4 or more words that ends a sentence now counts, and the wrap test leaves links out. Tested with an
   incident update.
9. Three spellings of one date count as three facts, and three items at one price as one. Kept: the facts rule only puts
   a message back where it is today, and both cases are rare.
10. The `correspondents` lookup ran for every message on every sources read. It runs only for a role address (as
    `senderIsPerson` already short-circuits) and once per sender per read.
11. Said what happens to a summary the reader already has: the gate decides automatic requests only (above).
12. The corpus can't say what the worker summarizes today, and a blanket "nothing lost" would reject the skips meant.
    The corpus test names the one meant skip, and the worker test runs mail through the real queue with a fake model.
