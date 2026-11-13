# Plan 202: OpenAI's reasoning effort, measured job by job

- **Status:** the plumbing and the evals are on `main`. No job uses it yet: whether summaries and Sol's drafting go to `low` is the owner's call (see "Open decisions").
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

$1.26 of the default $5 ledger: Luna $0.36, Haiku $0.25, Sol $0.64, Haiku as drafting judge $0.01. The audit's judges were Claude and Codex sessions, not the ledger.

## Open decisions

1. **Summaries.** Low is 2–3× faster (6.4 s → 2.3 s at six messages) and more often wrong about who owes what. The options: ship low; keep default; or ship low with a prompt or check aimed at ownership, measured with the same audit first. Plan 153's "owner and evidence" field was tried and made things worse, so a new idea is needed.
2. **Sol's drafting.** Low looks better or equal on everything measured. Shipping it is one line in the drafting task, outside this request's "isolated to summaries".

## Tests

`contract.test.ts`: on every provider, a request with `reasoningEffort` sends `reasoning_effort` on OpenAI only, and a request without it sends nothing (this fails if the transport drops it); the filter request sends none; `takesReasoningEffort` knows only Luna and Sol. `base.test.ts`: a price given to `budgetedTransport` holds a model the app doesn't list.

## Evals and their tools

- `summaries-corpus.real.ts`: `TERNO_AI_SUMMARY_EFFORT` sets both efforts, and `default` sends neither.
- `drafting.real.ts`: `TERNO_DRAFT_MODEL` and `TERNO_DRAFT_REASONING=default,low` (runs are kept apart by model and effort, and the two settings take turns going first); errors go to `/tmp/terno-ai/drafting-errors.jsonl` and run again next time.
- `harness.ts`: eval-only prices (`gpt-6-sol`), and `adjustRequests` to change a request before it leaves.
- Results: `~/.terno-evals/runs/effort-{medium,low,haiku}.jsonl`, the audit in `~/.terno-evals/audit7` with its key in `audit7.key.json`, drafts in `/tmp/terno-ai/drafting-*`.

## What the code review changed

Codex reviewed the first version (summaries at low) and found nothing. Separately, the eval harness had copied all of `budgetedTransport` to price Sol; `budgetedTransport` now takes a price instead.

## Out of scope

Showing a summary as it's written (streaming structured output) and starting one before it's asked for. Both would cut the wait without changing the model. The Responses API, which OpenAI recommends for reasoning models.
