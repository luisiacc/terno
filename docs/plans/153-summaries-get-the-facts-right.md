# Plan 153: Summaries get the facts right

- **Status:** built and on `main`, code-reviewed, and audited on mail not used for tuning. Wrong facts are lower, and not zero: see "What the audits showed".
- **Builds on:** plan 151 (who was asked, the corpus and how it's judged).

## The request

> I'm a bit concerned about the wrong facts. I mean, they should be closer to 0 now they say they're 11 and 16. They should be like very close to 0, not 11 or 16, that's way too much. I think we need to do better, getting almost no wrong fact at all. [...] it's necessary to get less wrong facts, on being more accurate in those summaries, like that is crucial.

> for the tests that are failing, if they're not failing because of the work here, let's just leave them. Other people will fix it.

## What exists

Plan 151's prompt, version 4, on GPT Luna at `effort: "low"`. In its last blind round, wrong facts were 11 and 16 by the two judges, per 215 cards. Reading each one, against what the model was sent, gave four causes:

1. **A gap in what's sent.** When the reader's message is the last, `assemble` strips what it quotes. That can be the only copy here: two cards said nobody had answered when the answer was in the quote. The model never saw it.
2. **Rules nobody stated:** credit the person who said it, a proposal isn't a decision, a joke isn't a task, finished work isn't an item, an optional favour isn't a duty.
3. **What code can hold:** "$0.39" when the mail gives no currency, and "hoy" copied from a message.
4. **Plain misreading:** "Debbie's parents" becoming Don's.

The grading question was also too loose: "wrong fact" counted things that were only less precise. So this plan has its own measure.

## How it's measured

**A fact audit.** Claude and Codex each check every claim on every card against the mail, with labels shuffled per conversation. A claim is wrong only with evidence: the message and the words that contradict it, or which messages were checked and found silent. Leaving something out, vagueness and style aren't wrong facts. Then, since a card can't earn trust by saying nothing, they also count asks and key facts missing entirely. "Firm" below means both judges flagged the card.

## Design

**In the prompt, version 5:**

- Accuracy comes first: never state what you aren't sure of, and never lose what the reader needs. Every deadline, amount, option and condition stays.
- Credit each statement to whoever made it.
- Keep each claim as strong as the mail. A proposal, a question or a hope isn't a fact, an optional favour isn't a duty, a choice isn't confirmed until the other side says so, and "on 27 March" isn't "before 27 March".
- Copy names, amounts and dates as written, with no added currency, total or year. A loose date keeps its words.
- Don't say nobody replied or nothing was confirmed: there may be messages you can't see.
- An item citing the reader's own message has to be their promise. Nothing done, withdrawn or overtaken is an item, nor a question they've answered, a joke or an aside.

**In `validate`, where the mail can prove it:** a card goes back to the model once, with what's wrong, when it has a word that fades ("today", "this weekend", "mañana"), a currency the mail doesn't give, or an amount that isn't in the mail. Still wrong after that, the row goes and the summary stands, so a check never loses a whole card. A weekday with no date beside it is asked about once and then left, since "Monday to Friday" can be right.

**In `assemble`:** the last message keeps what it quotes, up to 1,500 tokens, after its own words. A window under 8,000 tokens sends only its own words.

**`summaryBudget`:** a small window gives the answer 30%, not 40%, since the prompt is longer. That still holds the longest answer `validate` keeps.

## What the audits showed

Each column is its own set, and small counts move a lot between sets: compare within a table.

**110 conversations, chosen to include every one flagged so far.**

| | Claude | Codex | Firm |
|---|---:|---:|---:|
| Version 4 | 20 | 18 | 12 |
| Rules and checks, low effort | 7 | 6 | 5 |
| Medium effort | 8 | 6 | 6 |
| High effort | 14 | 12 | 7 |
| A second pass checking the first | 7 | 6 | 4 |

More thinking and a second pass didn't help, and the second pass doubles the time and the cost. So the task stays at low effort, with one pass.

**200 conversations not used for tuning, 95 of them real mail no judge had seen.** "Leave out what you aren't sure of" had bought accuracy by saying less, so this round's prompt was replaced:

| | Wrong, Claude / Codex | Firm | Key facts missing, Claude / Codex |
|---|---:|---:|---:|
| Version 4 | 14 / 11 | 6 | 6 / 25 |
| Trial | 7 / 8 | 5 | 12 / 36 |

**150 conversations: 78 fictional and 72 real no judge had seen.**

| | Wrong, Claude / Codex | Firm | Firm and high | Key facts missing, Claude / Codex |
|---|---:|---:|---:|---:|
| Trial (terse) | 4 / 2 | 1 | 1 | 14 / 58 |
| **What shipped** | 8 / 6 | 4 | 1 | 4 / 22 |
| What shipped on Claude Haiku 5.5 | 32 / 35 | 23 | 5 | 8 / 52 |

Of what shipped: no firm wrong fact in the 78 fictional conversations, and 4 in the 72 real ones, 1 of them serious. No card obeyed a scam or injected text. Haiku is faster (1.9 s against 5.4 s) and costs about the same, and gets far more wrong, so summaries stay on GPT Luna.

**The final audit: the committed code against version 4,** on 119 real conversations no judge had seen, and the 78 fictional ones.

| | Wrong, Claude / Codex | Firm | Firm and high | Asks missing, Claude / Codex | Key facts missing, Claude / Codex |
|---|---:|---:|---:|---:|---:|
| Version 4 | 16 / 22 | 11 | 2 | 7 / 19 | 5 / 47 |
| **What shipped** | 12 / 10 | 5 | 2 | 7 / 12 | 3 / 29 |

On real mail alone, firm cards fell from 10 to 3 of 119. Accuracy didn't cost completeness: omissions fell too.

**It isn't zero.** About 1 card in 40 has something both judges call wrong, and about 1 in 100 has something both call serious. What's left is mostly work addressed to someone else inside the same message ("J- please pull…" with the reader as C-, or the reader telling someone "forward it to me"), a deadline stretched from one item to the next, and small misreadings. The same message holding several people's tasks is the hardest case, and both judges suggest what might reach it: having the model say who owns each row before writing it. That's untested.

**Rules not added,** measured first:

- *Drop actions citing the reader's own message.* Of 51, almost all are real promises the answer key confirms, and 1 of 24 audited was flagged.
- *Drop a question the reader replied to afterwards.* Of 9, one was wrong and another was still open, since a reply can answer part of what was asked.

Both stay the prompt's job.

**Limits:** the same as plan 151's, and one more. Counts this small are noisy: the trial had 5 firm in one set and 1 in another. The audits are two models' judgment on one run of each prompt.

## Tests

`summarize.test.ts`: each kind of word, currency and amount goes back once; what's legitimate passes first time (a time of day, a weekday with its date, a year, a day worked out from "next Friday"); a row that still fails goes while the rest stands; a bare weekday that holds stays. `summaries.test.ts`: the last message keeps its quote and older ones don't; the 2,000-token window holds. The eval and the audit above.

## Performance

Off a hot path. A rejected card costs one more request. Time and cost stay within plan 132's range: about 5 s and under $0.001 a card.

## Out of scope

Failing tests from other work, as the owner asked. A stronger model, which costs more and is the owner's call: Claude Sonnet 5.5 is about 20 times the price and untested. Corpus note: `fetch-real.py` now keeps one of each id, so it holds 502 conversations (8 Apache threads had shared one). Plan 151's "510" counted those twice.

## What the code review changed

Codex raised 8 points on `1b75ed4b`. Six are fixed, each with a regression test.

- **The reader's words come first.** Keeping a quote could push out the answer it came with, in a small window or past the cut. A message's own words are now sent first, then what it quotes in the room left.
- **Amounts are compared whole.** "€250" passed against "1,250 euros", since it was matched inside the longer number. "1,250", "1.250" and "1,250.00" count as one amount. Two written with different conventions, like 1.250,50 and 125,050, still look alike: rare, and the prompt says to copy them.
- **A check can't lose a card.** Two malformed replies could leave no repair for a failed check. The ladder now tells `validate` when it's the last attempt, and the row goes then.
- **Currency is matched as a word,** so "neurology" holds no euro, and "USD 300" is checked like "$300".
- **Dates:** "this Friday, March 6" passes, and "next Monday 9am", "el mes pasado" and "la semana próxima" don't.
- **Only what will show is checked,** so a row that was going anyway costs no request.

Left alone: a repaired reply that brings a new problem just loses that row, which is safe. "USA Today" is sent back once as a word that fades. 30% of a 2,000-token window fits the longest answer in rough tokens, with little to spare, but a window that small has no hidden reasoning to take from it.
