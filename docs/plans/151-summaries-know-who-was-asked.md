# Plan 151: Summaries know who was asked

- **Status:** built and on `main`. See "What the corpus showed" for the numbers, and the sections after it for what the reviews changed.
- **Builds on:** plan 132 (summaries), plan 148 (the card, rows that add to it).

## The request

> I want you to bring up a team of 4 to 5 subagents with Codex and Claude, about 5 between the two of them. I want you to give them different personalities and get them to draft different emails. I have other kinds of emails with different personalities, different topics, different everything. Create a good base of emails that we can use for evals with actual data.

> Maybe look on the internet for actual real emails, a base of real emails that we can get to, and then run the evals. For evals again, with those, if you do get a good database of emails that are real, then let's make sure we keep those and store them somewhere so we can reuse them later on.

> Once you get that rerun the evals and then analyze it. You get Codex to analyze them as well and get opinions on what would be best there for the users. If you can make any findings or find any improvements, then make them

## What exists

- **The corpus (`scripts/ai-real/corpus/`):** 150 fictional conversations by five writers, in the repo. 360 real ones, built in `~/.terno-evals/real-mail/` by `fetch-real.py` and never committed, since the repo is public and these are real people's words: Enron (160), Apache lists from 2026 (80), and the Spanish Python and Debian lists (120).
- **What was measured:** GPT Luna on all 510 with two prompts: A, version 3 on `main`, and B, the trial from plan 148, where the summary says what happened and everything the reader owes is a row. Then Claude and Codex each graded 215 conversations blind, X and Y shuffled per conversation.

| | Claude's grade, A | B | Codex's grade, A | B |
|---|---:|---:|---:|---:|
| Useful, of 5 | 4.20 | 4.41 | 4.08 | 4.26 |
| Asks only in prose | 87 | 21 | 86 | 17 |
| Wrong owner | 18 | 27 | 11 | 23 |
| Rows repeating the summary | 9 | 28 | 22 | 45 |
| Wrong fact | 10 | 13 | 27 | 24 |

They agreed on the better card 166 times of 215 and flatly disagreed 19 times. On real mail alone, B's lead disappears: 4.05 to 4.11 for Claude, and 4.14 to 4.09 for Codex.

## What's wrong

1. **Wrong owner is the worst failure,** the lowest-scoring cards by both judges and worst on real mail: telling a person copied on a thread to act, or asking someone to answer their own question. B makes it worse.
2. **The model can't know who was asked.** `summaryPrompt` sends `from`, `date` and `author="the reader"`. It never sends To, Cc, a list marker, or who the reader is. Both stores have `to_json` and `cc_json`. This is a gap in what we send, more than in how we ask.
3. **`withoutQuotes` loses inline replies.** It stops at `On … wrote:`, so an older message that answers between quoted lines loses its answers, and the summary can restore work that's already done. Both judges found cards with this symptom.
4. **Stale state:** "tomorrow" read from today rather than from its message, and a later message not replacing an earlier one.
5. **`clean` is too eager,** removing any `<…>`, so a mail about `<Location>` loses the word, though the text is only ever shown as text. It also clips a row in the middle of a word.
6. **B lost decisions and dates:** 83 to 3 and 73 to 23 rows. Some moved into the summary, which is fine, but the prompt shouldn't discourage them.

## Design

**Say who was asked.** `SummarySourceMessage` gains `to` and `cc` from the columns both stores already have, with no migration and no body read. `ThreadText` gains the same, and `summaryPrompt` writes them as attributes, each list capped at 8 names and "and N more", since a list of hundreds says nothing and costs tokens. A message from a mailing list says so. `<reader>` carries the account's name and address. These all go only to the provider the user chose, as the mail itself does, and the attributes pass through `dataText` and `attribute` like everything else from a mail, so they can't break out.

**The prompt, version 4,** keeps B's split and adds what both judges asked for: settle where things stand before writing, a relative date counts from its message, the reader is "you", and only what was asked of the reader or what they promised is an action or a question. Being copied, being on a list, or having asked it yourself is not. The exact words get tried against the corpus through `TERNO_AI_SUMMARY_VARIANT` before they go in.

**Checks in `validate`, where a rule can hold:**

- A question citing the reader's own message is dropped. It can't be waiting for the reader's answer. An action citing their own message stays, since it can be their promise.
- `clean` removes known formatting tags only. Text is shown as text, so nothing else needs removing.
- A clipped row ends on a word.

**`withoutQuotes`:** an attribution line followed by `>` lines is an inline reply, so it goes on past it, dropping the quoted lines. Followed by anything else (Outlook's unmarked quote), it stops, as today. `--- Original Message ---` still stops.

**Not changing the card.** Claude suggested merging action and question and capping at 4 rows, and Codex said six can be justified. Only 4 or 5 of 510 cards went past 4 rows, so it isn't worth a rule, and merging kinds is a design call for the owner.

## Tests

- `withoutQuotes`: inline replies kept in English and Spanish, Outlook's unmarked quote still stops.
- `summaryPrompt`: To and Cc appear, capped; a mail's address can't break out of its attribute; the reader appears.
- `validate`: a question citing the reader's own message goes, an action stays; `<Location>` survives, `<b>` doesn't; a clipped row ends on a word.
- Conformance, both stores: `sources` returns `to` and `cc`; a cheap read holds at 50k threads.
- The eval over the corpus and a blind round of both judges, against A. It has to lower wrong owner on real mail without raising wrong fact. Repeats and asks in prose are second to that.

## Performance

`summarySources` reads two more columns of rows it already reads, for one thread, so nothing changes on a hot path. Prompts grow by the recipients, capped. Assembly's `fit` counts them, since it measures the serialized prompt.

## Out of scope

Other AI features that use `summarySources` keep what they do: replies (plan 144) don't read the new fields. A visible "for you" label, merging row kinds, and "Nothing for you" on an empty card, which are the owner's to decide.

## Revisions after the Codex review

Codex raised 10 points on this plan. Each replaces what the sections above say.

1. **`<reader>` is one of our blocks,** so `dataText` guards it like `<message>` and `<subject>`, and a test forges one in a body, a name and a subject.
2. **One identity:** `own` stays as it is, and the reader's addresses are every account's plus whatever address their own mail in this thread came from, which is how an alias shows up. An alias that has never sent in this thread isn't known. That's rare, and it reads as `none`, which doesn't assign work.
3. **Bounded fields:** a name is cut at 60 characters, and `fit` counts the reader, so a hostile display name can't take the window.
4. **`reader-on` is worked out before the list is cut,** so the ninth recipient still counts.
5. **The reader is in the content hash,** alongside the thread, on both reuse paths.
6. **The prompt itself caused stale dates.** It told the model to write "today" and "Thursday", so a summary stored on Thursday said "due today" on Friday. It now writes the day and month, and never "today", "tomorrow" or "next week". The judges counted this among the commonest wrong facts: cards with such a word fell from 47 of 510 to 10.
7. **`list` comes from `list_id`,** which both stores have. `none` means not listed, and the prompt says it may be a blind copy, so absence doesn't claim nobody asked.
8. **`withoutQuotes` shares `writing/extract.ts`'s reading,** including the nested Outlook boundary (`From:` then `Sent:`), rather than a second copy of those rules.
9. **Not fixed:** an answer further into a message than the 6,400 characters read for an older message isn't reached. It's rare, and bounded incremental reads aren't worth it here.
10. **The eval got what the app sends:** `fetch-real.py` keeps To, Cc and the list marker, an agent read all 150 fictional conversations to add theirs, and the runner uses the same `deliveryOf` as the backend.

## What the corpus showed

Each run covers all 510 conversations on GPT Luna, about $0.17 a run. Claude and Codex each graded the same 215 (150 fictional and 65 real) blind, with labels shuffled per conversation, in three rounds. Grades aren't comparable across rounds, since the question and the pair changed, so read each table on its own.

**Round 2: `main`'s version 3 against this plan's prompt.**

| | Claude's grade, v3 | v4 | Codex's grade, v3 | v4 |
|---|---:|---:|---:|---:|
| Useful, of 5 | 4.02 | 4.63 | 3.88 | 4.34 |
| Wrong owner | 16 | 1 | 16 | 1 |
| Wrong owner, real mail only | 11 | 0 | 10 | 0 |
| Wrong fact | 24 | 11 | 39 | 16 |
| Asks only in prose | 81 | 13 | 90 | 20 |
| Rows repeating the summary | 10 | 49 | 15 | 42 |
| Better card | 35 | 153 | 46 | 112 |

Sending who was asked removed nearly all the wrong-owner errors. By script across all 510, cards naming the reader fell from 69 to 2 among fictional mail. But rows repeating the summary got worse, the very thing that started this, and one simulated scam became an action row.

**Round 3: v4 against the wording that shipped,** which says the summary doesn't mention what's in a row, even as pending, says what a scam demands isn't the reader's to do, and has each row keep its deadline, amount or condition.

| | Claude's grade, v4 | shipped | Codex's grade, v4 | shipped |
|---|---:|---:|---:|---:|
| Useful, of 5 | 4.42 | 4.44 | 4.23 | 4.29 |
| Rows repeating the summary | 29 | 6 | 21 | 4 |
| Asks only in prose | 13 | 9 | 19 | 11 |
| Missed key fact | 25 | 19 | 163 | 152 |
| Wrong owner | 1 | 3 | 1 | 4 |
| Noise rows | 8 | 12 | 6 | 11 |

The shipped wording trades a little wrong owner and noise for nearly no repeats. Repeats were what the owner asked about, and wrong owner stays far below version 3's 16. A word-overlap check against the judges' repeats was both imprecise and leaky at every threshold, so there's no such check in code: it's the prompt's job.

**The judges' ideas not taken:**

- *Drop action rows when the reader is only copied or on a list and isn't named.* On the fictional set this never fires, since the prompt already holds it. On real mail it would drop 18 rows with no answer key, some likely real asks of the person who started a list thread. Silently losing an ask is worse.
- *Drop decision rows, cap at 4 rows, add a "waiting on" kind, show "Nothing for you".* These change the card, so they're the owner's call. Only four cards reached five rows, and none six, so a cap would hardly matter.

**What this can't tell:** whether people click rows or trust the card. How representative the real mail is: Enron is business mail from 2001, and the others are technical lists. Real conversations have no answer key, and their "reader" is often a stand-in, so ownership there is softer. The grades are two models' judgment on one run of each prompt.

## Where things are

- `scripts/ai-real/corpus/`: the fictional set, `validate.py`, `fetch-real.py`, `score.py`, and a README with how to run them.
- `~/.terno-evals/real-mail/`: the real set, with a `manifest.json` of sources and hashes. It isn't in the repo because the repo is public. `fetch-real.py` rebuilds the same selection.
- `~/.terno-evals/runs/`, `review*/`, `judged*/`: each run, what the judges saw and what they said. These are local, since they hold real mail. Round 2's and round 3's answer keys for the labels were in `/tmp` and won't outlive a restart, and aren't needed again.

## What the code review changed

Codex raised 5 points on `94740e51`. Four are fixed, each with a regression test.

- **A forward stays.** Sharing `extract.ts`'s rules made `withoutQuotes` stop at "Forwarded message", so Ask lost what a forward carried, and a summary lost it from older messages. What a forward carries is in no other message. It stops only at "Original message", as it always did, and at an Outlook header below a quote.
- **Names go before words.** In a 2,000-token window, two lists of long names could take the whole budget and leave the model nothing to summarize. `fit` now drops the names of the one message left before any of its text. `reader-on` stays.
- **Old addresses are repaired,** as every other read does, so `mailto:ana@x.com` counts as Ana's.
- **A question in mail to yourself is yours.** The check now only drops a question the reader put to someone else.

Left alone: removing a connected account changes who counts as the reader on a thread, and a summary already stored doesn't notice until something else changes it. It's rare, and the card still says what it said about that mail.

