# Plan 202: OpenAI's reasoning effort, measured job by job

- **Status:** the plumbing and the evals are on `main`. Drafting (compose and fill, which on OpenAI run on Sol) asks for `low`, by the owner's word. Summaries stay at the default until the owner picks among the measured choices (see "Open decisions").
- **Builds on:** plans 132 (summaries), 133 (drafting), 153 (summaries get the facts right), 168 (no model choice).

## The request

> i tried doing an ai summary in a 6 messageconversation and it took like 14 seconds which i think its too slow, could you check this out?

> it would be low for summaries only of course, for sol it could use medium/low you could do some evals and compare for jobs that use sol, but any changes done here should be isolated to the summaries, also do an eval with haiku and see id it does better that luna low

## What exists

Every task asks for `effort: "low"`, and `CompletionRequest` says "default low". The Claude transport sends it as `output_config.effort`. **The OpenAI transport never sent it.** So GPT Luna (summaries, follow-ups, the digest, Reply ready's check, Ask's planner) and GPT Sol (drafting) have always thought at their documented default, `medium`. Plan 153's table comparing low, medium and high effort on Luna sent the same request every time; its differences were noise.

The time goes to the model's thinking, not to Terno: assembling a summary is a few database reads. A one-message thread took as long as a long one.

## Design

- `CompletionRequest.reasoningEffort` and `StructuredTask.reasoningEffort`: OpenAI's `reasoning_effort`. Left out, a model thinks at its default. It's separate from `effort` because the two providers' jobs were tuned at different settings: Claude at low, OpenAI at medium. A job sets it only once it's measured at another.
- The OpenAI transport sends it only with provider `openai`, and only to `gpt-6-luna` and `gpt-6-sol`. Both models' pages document `reasoning.effort` on Chat Completions (none, low, medium by default, high, xhigh, max). Azure, OpenRouter, local servers and any other model never get it, since a model that doesn't take it rejects the request.
- No job sets it yet, so nothing the app does changes.
- `budgetedTransport` takes an optional price, so an eval can hold a model the app has no price for (Sol) to the ledger. The app's own prices are unchanged.

## What was measured

### Summaries: speed

All 502 corpus conversations (plan 151), on 2026-11-12. Luna's two settings ran at the same time, so the network was the same for both.

| Messages | Luna default, median / p90 | Luna low | Haiku 5.5 (low) |
|---|---|---|---|
| 1–2 | 4.4 s / 8.9 s | 2.1 s / 5.4 s | 1.7 s / 3.1 s |
| 3–5 | 5.0 s / 11.0 s | 2.2 s / 6.0 s | 1.8 s / 3.4 s |
| 6–8 | 6.4 s / 13.3 s | 2.3 s / 6.2 s | 2.0 s / 5.3 s |
| All | 4.9 s / 10.9 s | 2.1 s / 6.0 s | 1.8 s / 3.6 s |

No errors in any run. A second try after a failed check was needed on 5% (default), 7% (low) and 14% (Haiku) of conversations, and the times include it.

### Summaries: what `score.py` counts

| | Luna default | Luna low | Haiku |
|---|---:|---:|---:|
| Conversations with a row repeating the summary | 3% | 11% | 34% |
| Rows repeating the summary | 15 | 60 | 214 |
| Numbers not in the mail | 24 | 24 | 141 |
| Wrong language | 0 | 0 | 38 |

### Summaries: the fact audit

Plan 153's audit, three cards per conversation with labels shuffled: 90 conversations (40 fictional, 50 real), Claude and Codex each judging every claim with evidence. "Firm": both judges flagged the card.

| | Cards wrong, Claude / Codex | High, Claude / Codex | Firm | Firm and high | Key facts missing, Claude / Codex |
|---|---:|---:|---:|---:|---:|
| Luna default (today) | 5 / 2 | 0 / 1 | 2 | 1 | 2 / 9 |
| Luna low | 9 / 6 | 4 / 7 | 5 | 5 | 1 / 30 |
| Haiku | 14 / 16 | 5 / 14 | 11 | 9 | 0 / 28 |

All of Luna low's firm errors but one are about who owes what: a forwarded notice's tasks for the admins given to the reader, the reader's own "let me know" turned into the reader's task, a proposal's author asked for feedback on it. That's the hardest case plan 153 named, and low effort makes it more common. Both judges agree on the order: default, then low, then Haiku, with Haiku well behind (and in the wrong language on 38 cards). So Haiku isn't better than Luna low; it's worse on every measure but speed.

The counts are small, and plan 153 found one judge moves a few cards between identical runs. But both judges went the same way on all three, and firm-and-high errors went from 1 to 5.

### Drafting on Sol

Plan 133's drafting experiment, run on Sol at its default and at low, interleaved case by case: 63 drafts each, across one-tap, notes, refine and the shipped arm (`local+examples`), plus 3 attacks.

| | Time to first word, p50 / p90 | Total, p50 / p90 | Output tokens, p50 |
|---|---|---|---|
| Default, all arms | 2.2 s / 4.9 s | 2.5 s / 5.3 s | 185 |
| Low, all arms | 1.1 s / 2.4 s | 1.5 s / 2.9 s | 68 |
| Default, shipped arm | 1.9 s / 4.4 s | 2.3 s / 4.6 s | 155 |
| Low, shipped arm | 1.1 s / 2.3 s | 1.4 s / 2.9 s | 43 |

Low was faster in 57 of 63 pairs, and about 20% cheaper. On the shipped arm, judged by Haiku: meaning kept 24 of 24 both, the authorship judge fooled 10 of 24 both, nothing invented, the same length. The one difference read by hand favours low: at default Sol dropped the person's typed sign-off in 10 of 60 drafts, at low in none. No attack was obeyed, and nothing leaked. Twelve fictional cases is enough to see a large loss, not a small one.

Sol drafts only when the user has an OpenAI key and no Claude key; with both, Sonnet drafts.

### Spend

$1.26 of the default $5 ledger in the first round: Luna $0.36, Haiku $0.25, Sol $0.64, Haiku as drafting judge $0.01. Round two brought it to $4.00: Terra $1.79, the Luna variants $0.95. The audit's judges were Claude and Codex sessions, not the ledger.

## Round two: a prompt for Luna at low, and GPT Terra

> lets do sol drafting at low. lets try also gpt terra low for summaries and what would be the avg cost per user per month usign terra as summaries, i also want you to try to make the gpt luna low work with a better prompt(investigate prompting techniques for luna)

**What OpenAI says about prompting.** There's no guide for Luna. For reasoning models in general: a clear goal, strong constraints and an explicit output contract, without prescribing each step; effort is "a tuning knob, not the primary way to recover quality"; and reasoning models do better on the Responses API than on Chat Completions. The GPT-6 guide's prompts were observed on Astra and are to be tested on each model.

**What low effort gets wrong.** Reading the audit's cards: in the reader's own message, "please let us know if we can conference" became the action "Let Yair know whether the conference can be held"; a forwarded notice to admins became the reader's tasks. The rules said this already, inside a long sentence among others. Low effort doesn't reread them.

**Variant B** (variant A was the first part alone; B did better on every count). A section before "Return:", the action rule pointing to it, a check at the end of the system prompt, and one line after the mail:

> Who has to act. A request belongs to whoever it's put to, and only the reader's become items:
> - In the reader's own message (author="the reader"), every request is for the people it went to. "Let me know", "please confirm", "send me", "can you…" mean they act and the reader waits on them, which goes in the summary. From the reader's own message only a promise is theirs: "I'll send it Friday".
> - In someone else's message, a request is the reader's when it's put to them: they're in "to" and nobody else is named for it, or it names them. A request naming someone else ("Jeff, please…"), or put to a group the reader is only copied on or forwarded, isn't theirs.
> - A forwarded notice is for the people it first went to: passed on for information, it asks the reader nothing.
> - Whoever made a proposal, asked for reviews or asked a question isn't asked to answer it.
> When it isn't clear the reader is the one asked, it isn't an item.

> Before you answer, check each action and question: whose message is it, and who does it ask? Drop any that "Who has to act" doesn't give the reader. Then check the summary says nothing the reader has to do or answer, and no item repeats the summary.

After the mail: "Write the card for the reader above. Before including an action or a question, look at who wrote that message and who it asks."

**On the 502 conversations, Luna at low:**

| | Median / p90 | Actions citing the reader's own message | Rows repeating the summary |
|---|---|---:|---:|
| Default, shipped prompt | 4.9 s / 10.9 s | 52 | 15 |
| Low, shipped prompt | 2.1 s / 6.0 s | 52 | 60 |
| Low, variant B | 2.1 s / 5.6 s | 13 | 41 |
| Terra low, shipped prompt | 2.3 s / 3.7 s | 63 | 7 |

**The audit, on mail no prompt was tuned on:** 60 real conversations from `real-mail-fresh` and 30 fictional ones not in the first audit, four cards each, labels shuffled.

| | Median / p90 | Cards wrong, Claude / Codex | High, Claude / Codex | Firm | Firm and high | Key facts missing, Claude / Codex |
|---|---|---:|---:|---:|---:|---:|
| Luna default (today) | 4.3 s / 9.4 s | 2 / 1 | 0 / 0 | 1 | 0 | 0 / 10 |
| Luna low, variant B | 2.0 s / 5.3 s | 6 / 4 | 1 / 2 | 2 | 1 | 3 / 11 |
| Terra low | 2.2 s / 3.5 s | 4 / 2 | 1 / 1 | 2 | 1 | 0 / 8 |
| Terra low, variant B | 2.3 s / 3.8 s | 4 / 2 | 0 / 0 | 1 | 0 | 0 / 6 |

This set was easier than the first (default: 2 / 1 here, 5 / 2 there), so compare within it. Variant B removed the ownership errors: none of Luna low B's flagged claims is about who owes what, where they were most of plain low's. What's left on Luna low B is ordinary slips: the question asked on a list credited to the reader (both judges, high), a deadline written as "end of day", a status a later message overtook. Terra low with variant B is the closest to today's accuracy, with no high-severity claim from either judge, and the most even times.

**What Terra costs.** Per summary, on this mail: 2,125 tokens in, 97 out, $0.0026 (at $1 in, $5 out per million; Luna's is $0.0004 at either effort, since its thinking is cheap). Real threads can be longer than the corpus's, so up to about twice that. A summary is made for each new message in the Primary inbox with 60 words or more of new text, and when asked:

| Summaries a day | A month | Terra low | Luna |
|---:|---:|---:|---:|
| 5 (light) | 150 | $0.40–0.80 | $0.06 |
| 15 (typical) | 450 | $1.20–2.30 | $0.17 |
| 40 (heavy) | 1,200 | $3.10–6.20 | $0.45 |
| 300 (the daily cap) | 9,000 | about $23–48 | $3.40 |

On the user's own key that's the user's bill. Under Pro's managed allowance ($3 a month, plan 85) a typical user's summaries on Terra take about half of it, and a heavy user's all of it.

## Round three: Luna at medium, with both prompts

> can you try gpt luna with medium reasoning and add it to the comparison, with both new and old prompt, i just can't believe these models make those easy mistakes, it says terra low had 4/2 wrong cards, which is more than current luna

Luna's default *is* medium, so "Luna default" was already Luna at medium with the old prompt. It ran again with medium asked for explicitly, which shows how much one run differs from the next, and once with variant B. All six went into one audit with fresh judges, six cards a conversation, on the same 90 conversations as round two.

| | Median / p90 | Cards wrong, Claude / Codex | High, Claude / Codex | Firm | Firm and high | Key facts missing, Claude / Codex |
|---|---|---:|---:|---:|---:|---:|
| Luna medium, old prompt (round two's run) | 4.3 s / 9.4 s | 2 / 1 | 1 / 0 | 1 | 0 | 0 / 9 |
| Luna medium, old prompt (run again) | 4.9 s / 8.2 s | 5 / 4 | 2 / 1 | 3 | 1 | 0 / 9 |
| Luna medium, variant B | 4.3 s / 10.3 s | 2 / 1 | 1 / 0 | 0 | 0 | 1 / 13 |
| Luna low, variant B | 2.0 s / 5.3 s | 5 / 4 | 2 / 3 | 3 | 2 | 3 / 14 |
| Terra low, old prompt | 2.2 s / 3.5 s | 3 / 2 | 2 / 1 | 2 | 1 | 0 / 9 |
| Terra low, variant B | 2.3 s / 3.8 s | 4 / 2 | 1 / 0 | 2 | 0 | 0 / 7 |

**The same model, prompt and effort, run twice, went from 2 / 1 wrong cards to 5 / 4.** So round two's gap between Terra low (4 / 2) and Luna (2 / 1) is within what a second run changes: on 90 conversations these counts can't rank them. The judges were steadier than the runs: the four sets of cards judged in both rounds scored nearly the same both times (2 / 1 and 2 / 1, 6 / 4 and 5 / 4, 4 / 2 and 3 / 2, 4 / 2 and 4 / 2).

What the counts do say:
- Every version gets something wrong on 1 to 5 of 90 cards, mostly low severity. One card is flagged on all six versions (a follow-on meeting's date that every model reads the same way), so some of what's left is the mail being unclear, not the model.
- Variant B costs nothing at medium (2 / 1, none firm) and removed what low effort was getting wrong about who owes what.
- Luna low is the only version with high-severity claims from both judges in both rounds: crediting a list member's question to the reader, and a deadline given as "end of day".
- Terra low and Luna medium can't be told apart on accuracy. Terra low is half the wait and much steadier (p90 3.8 s against 8–10 s) at about seven times the price.

## Open decisions

1. **Summaries.** With variant B in every case: Luna at medium (today's speed, 4–5 s with a slow tail, the cheapest accurate one); Terra low (as accurate as far as 90 conversations can tell, 2.3 s and steady, about seven times the cost); or Luna low (2 s and nearly free, with more high-severity slips).
2. **Sol's drafting: decided.** "lets do sol drafting at low." `DRAFT_REASONING` in `writing.ts`, on compose and fill (Reply ready's prepared drafts go through compose too). The voice judge isn't drafting and wasn't measured, so it keeps the default.

## Tests

`contract.test.ts`: on every provider, a request with `reasoningEffort` sends `reasoning_effort` on OpenAI only, and a request without it sends nothing (this fails if the transport drops it); the filter request sends none; `takesReasoningEffort` knows only Luna and Sol. `base.test.ts`: a price given to `budgetedTransport` holds a model the app doesn't list.

## Evals and their tools

- `summaries-corpus.real.ts`: `TERNO_AI_SUMMARY_EFFORT` sets both efforts, and `default` sends neither; `TERNO_AI_SUMMARY_TAIL`, a file whose text goes after the mail.
- `drafting.real.ts`: `TERNO_DRAFT_MODEL` and `TERNO_DRAFT_REASONING=default,low` (runs are kept apart by model and effort, and the two settings take turns going first); errors go to `/tmp/terno-ai/drafting-errors.jsonl` and run again next time.
- `harness.ts`: eval-only prices (`gpt-6-sol`, `gpt-6.1-terra`), and `adjustRequests` to change a request before it leaves.
- Results: `~/.terno-evals/runs/effort-*.jsonl`, `luna-*-own-{a,b}.jsonl` and `fresh-*.jsonl`; the audits in `~/.terno-evals/audit7` and `audit8`, each with its key beside it; the variants in `~/.terno-evals/variants`; drafts in `/tmp/terno-ai/drafting-*`.

## What the code review changed

Codex reviewed the first version (summaries at low) and found nothing. Separately, the eval harness had copied all of `budgetedTransport` to price Sol; `budgetedTransport` now takes a price instead.

## Out of scope

Showing a summary as it's written (streaming structured output) and starting one before it's asked for. Both would cut the wait without changing the model. The Responses API, which OpenAI recommends for reasoning models.
