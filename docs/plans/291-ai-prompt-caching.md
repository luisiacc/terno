# Plan 291: Prompt caching where it pays, across every AI job

- **Status:** built; measured on Luna and Sol, then on Sonnet, Haiku and Opus once the Anthropic key was back (2026-11-27).
- **Builds on:** plan 133 (drafting's cache breakpoints), plan 168 (routing: Pro is both keys), plan 202 (summaries' volumes), plan 204 (dated reads' volumes), plan 280 (their promises), the price fix in d0dc057ba and 32ac5ee34 (OpenAI's cache reads and writes counted at their own prices).

## The request (verbatim)

> lets make sure our cache strategy for things is good across all ai usage, spawn a t3 thread here to ensure that and do testing for ai features, to ensure we are using caching when necessary and where it saves money on realistic usage.

## What exists

- **One request shape.** `CompletionRequest` (`packages/ai/src/types.ts`) carries `system` and `messages` as `PromptText`: a string, or `PromptBlock[]` where `cache: true` ends a cacheable prefix. Only drafting (`composePrompt`, plan 133) uses blocks: the system prompt (rules, sender, signature, instructions), the general voice, then the draft's long material, each ending a prefix; the task (with today's date) last.
- **Anthropic** (`anthropic.ts`) turns `cache: true` into `cache_control: {type: "ephemeral"}` (5 minutes). **OpenAI** (`openai-chat.ts`) flattens blocks with `promptText` and ignores the flag. Compatible and local servers share that transport.
- **Structured jobs** (`ladder.ts`'s `StructuredTask`) have `system: string` and `prompt: string`, so none of them can mark a prefix: on Anthropic nothing but drafting is cached.
- **OpenAI caches by default.** Measured on GPT Luna today (`/tmp/terno-ai/spend-cache-1.jsonl`, eight summaries, $0.006): in its default *implicit* mode every request **writes its whole prompt** to the cache (2,955 of 2,958 tokens on a cold call; the variable rest, 315 to 370 tokens, on a warm one) at 1.25× input, and a later request with the same system prompt **reads only the system prompt** (2,472 tokens). The written mail is never read again. With `prompt_cache_options: {mode: "explicit"}` and a `prompt_cache_breakpoint` on the system prompt's text part, the system prompt is written once (2,472) and read after, and the rest is billed at plain input. Explicit mode with no breakpoint caches nothing and writes nothing.
- **Prices** (`prices.ts`): Luna $0.10 in, $0.01 cached, $0.125 a cache write, $0.50 out; Sonnet 5.5 $2 / $0.10 / $2.50 / $10; Haiku 5.5 $0.10 / $0.01 / $0.125 / $0.50; Opus 5.5 $4 / $0.20 / $5 / $20. `Usage.inputTokens` excludes cache reads and writes on both transports; `costAt` and the limiter's book count each at its own price.

### What the providers document

- **Anthropic** (prompt caching guide): a prefix match over tools → system → messages; at most 4 breakpoints; minimum cacheable prefix 512 tokens on Opus 5.5, Sonnet 5.5 and Haiku 5.5 (shorter ones silently don't cache and cost nothing extra); 5-minute TTL refreshed by each read, writes at 1.25× input, reads at 0.05× (Sonnet, Opus) or 0.1× (Haiku); 1 hour costs 2× to write.
- **OpenAI** (prompt caching guide and the Chat Completions reference): caching is on by default; from GPT-5.6 on, `prompt_cache_options` (`mode`: `implicit`, the default, or `explicit`; `ttl`: `30m`, the only value on Chat Completions) and `prompt_cache_breakpoint` (`{mode: "explicit", ttl?}`) on a text content part, system messages included, which "marks the exact end of a reusable prompt prefix". In explicit mode "if there are no explicit breakpoints, the request does not use prompt caching". Implicit mode puts a breakpoint at the end of the latest eligible message (here: the user's, so the whole prompt). Minimum 1,024 visible input tokens. A 30-minute write costs 1.25× input; reads 0.1×. `prompt_tokens` holds the cached and written tokens (as the price fix measured).

## The audit

Sizes are the system prompt in characters ÷ 4 (prose); the measured tokens replace them in "Results". Cadence is how often the same prefix recurs within the TTL in real use.

| Job (route on Pro) | Prefix today | Stable across calls? | Variable part | Cadence | Caching |
|---|---|---|---|---|---|
| summary (Luna; Haiku on Claude only) | system ≈2.3k (≈2.8k with "since") | yes within a day: language and today's date are at its end | the thread, 0.1–4k | each new Primary mail of 60+ words, 5/15/40 a day; drains back to back on launch | **cache the system prompt** |
| dated read and its second look (Luna; Haiku) | system ≈6.2k | **no**: "It arrived {time}" is at character 302 | the mail, ≈2k | 10–60 reads a day, drains | **move the arrival line to the end, cache the rest** |
| followup, your mail (Luna; Haiku) | system ≈2.3k | **no**: "It was sent {time}" at character 160 | the sent mail | each sent mail, 3–20 a day | **move the line, cache the rest** |
| followup, their mail (Luna; Haiku) | system ≈1.5k | **no**: "It arrived {time}" at character 355 | the mail | 5–40 a day after its filter | **move the line, cache the rest** |
| wanted (dated route) | system ≈600 | no (arrival line) | the mail | only with a show rule | none: under Luna's 1,024 minimum; on Haiku it'd save $0.00005 a call, not worth an eval |
| match preferences | ≈390 | yes | rows | a few a day | none (below every minimum) |
| compile preferences | ≈2.4k | yes | the person's words | when they edit them | none (once, foreground) |
| digest (Luna) | ≈320 | yes | newsletters | 1–3 a day | none (below minimum) |
| replyCheck (Luna) | ≈190 | yes | the mail | per mail | none |
| intent: readDraft, parseIntent (Luna) | ≈140–200 | yes | a sentence | per draft | none |
| voice judge (Sonnet) | ≈280 | yes | sample | rare, background | none |
| writing and reply drafts, fill (Sonnet; Sol on OpenAI only) | rules ≈1.1k, sender, general voice | yes per account | thread, specific voice, task | drafts, Replies ready drains, refinements | **already cached** (plan 133); on Sol it now gets explicit breakpoints instead of whole-prompt writes |
| ask answer (Sonnet) | rules ≈920 | yes | mail found, question | 1–8 questions a day, often several in a sitting | **cache the rules** |
| ask plan (Haiku with Claude, Luna with OpenAI) | ≈730 | yes within a day (today's date at character 142) | the question | twice per question when the first search finds nothing; several in a sitting | **cache the system prompt** (Haiku's 512 minimum; nothing on Luna, under 1,024) |
| plan action, check candidates (Haiku/Luna) | ≈1k, ≈160 | yes | sentence, groups | rare | none |
| filter (Opus) | ≈310, with today, accounts, categories | no | the request | rare | none |
| categorize (Opus; Luna on OpenAI only) | system ≈60 + **labels and examples, up to 12k characters, in the user turn** | yes while the examples don't change (`examplesVersion`) | the one mail, ≤600 characters | each new undecided mail when AI categorizing is on, up to 20 a minute | **cache the labels and examples** |

**Expected saving per call** (warm, against today): dated ≈6.2k tokens moved from a 1.25× write to a 0.1× read on Luna, about $0.0007 of $0.0010; summary and followups: the mail at 1× instead of 1.25×, small; categorize on Opus: up to 3k tokens at $0.20 instead of $4 a million, about $0.011 a call; Ask's rules on Sonnet ≈$0.0017 a question after the first in five minutes. **Loss risk:** a cold write that's never read: 25% of the prefix's input price, once per TTL.

## Design

### One declaration, mapped by each transport

`PromptBlock.cache` keeps its meaning: *end a cacheable prefix here*. What changes is what the transports do with it:

- **Anthropic:** as today, `cache_control: {type: "ephemeral"}` on that block (5 minutes: the drains and sittings are minutes apart; 1 hour's 2× write doesn't pay).
- **OpenAI, on models that take `prompt_cache_options`** (Luna and Sol, the ones Terno routes to, plus Terra for evals: a set beside `REASONING_MODELS`): every request is sent in **explicit mode**, and a block marked `cache` becomes a text content part with `prompt_cache_breakpoint: {mode: "explicit"}`. No mark: no breakpoint, so nothing is written or read. This removes implicit mode's whole-prompt writes.
- **OpenAI's other models, compatible and local servers:** unchanged, the text flattened with `promptText`.
- **One rendering of blocks** (revised after the Codex review, point 2). Flattened, blocks join with a blank line unless a block already ends in a line break (`blockTexts`); OpenAI's text parts carry the same separators, so the parts read as the flattened prompt. Anthropic's blocks go as written, as they always have. Drafting's blocks don't end in a line break, so every existing payload is byte for byte what it was; a text the ladder cuts in parts carries its own blank line, and categorizing's head its own line break. A request with no mark is sent as a plain string.

No feature branches on a provider: jobs declare blocks, transports map them (plan 85, decision 10).

### Structured jobs can mark a prefix

`StructuredTask` gains three optional fields, so every job keeps plain strings and tests keep reading `task.system` and `task.prompt`:

- `cache?: true`: the system prompt is a stable prefix that recurs; the ladder ends a cacheable prefix after it.
- `systemTail?: string`: per-call words that close the system prompt, after the cached prefix (a mail's arrival time). The model reads `system`, a blank line, then the tail.
- `promptHead?: string`: the head of the user turn, the same across calls (categorize's labels and examples), ending a cached prefix before `prompt`.

The ladder sends the system as blocks only when a task sets either field; repairs keep the same prefix (the first request's whole prompt is a prefix of the repair's). Downgraded modes (json_object, text: only compatible and local servers) append their schema words as a further block.

### The jobs

- **summary, ask plan, ask answer:** `cache: true` (ask's answer marks its rules block in `runAnswerFromMail`).
- **dated (and its second look), your mail, their mail:** the arrival or sent line moves from near the start to `systemTail`. The sentence's words don't change, only where it's read; a later sentence that leans on it ("in that zone") is checked and, if needed, reworded to stand alone. Each reordered prompt's eval runs again (`dated.real.ts`, `followups.real.ts`, `theirs.real.ts`) and must hold its numbers.
- **categorize:** `classify`'s user turn becomes two blocks: labels and what each holds (cached), then the items. `choices()` is already stable while `examplesVersion` is.
- **drafting:** unchanged blocks; it gains explicit breakpoints on Sol.

## Tests

- **Transports** (`contract.test.ts` or a new `cache.test.ts`): Anthropic puts `cache_control` on marked blocks only; OpenAI on Luna sends `prompt_cache_options: {mode: "explicit"}` always and `prompt_cache_breakpoint` on marked parts only, as content parts whose joined text equals `promptText`; a request with no mark has no breakpoint and a string content; a compatible server and an unlisted OpenAI model get neither field.
- **Which jobs mark what:** a table test over every task builder: summary, dated, both followups, ask plan and answer, categorize, compose mark a prefix; the others (match, compile, digest, replyCheck, intent, readDraft, voice, wanted, plan action, check, filter) send no mark.
- **Byte-stable prefixes:** for each caching job, two requests with different mail, dates, arrival times and accounts have byte-identical text up to the last breakpoint (the language held).
- **Accounting:** `ai-limiter` settles a request with cache reads and writes on Luna and on Sonnet at their prices (the read cheaper than input, the write dearer); `worstCaseUsd` still holds a write's price.
- **The reorders:** dated's, followups' and their-promises' existing prompt tests updated to read the time from the tail; their evals rerun on real models.

## Measuring it on real models

A harness, `scripts/ai-real/cache-strategy.real.ts`, replays a day for three personas (light, typical, heavy) through every job on Pro's routing (Luna, Sonnet, Haiku, Opus), from the fictional corpus in the repo (`corpus/synthetic`, `corpus/dated`) and the drafting personas (`packages/mock-data/src/writing-personas`); never real profiles, and never printing mail. A day is bursts: the morning's catch-up drained back to back, then mail through the day, an opened thread and its reply draft, a refinement, Replies ready, several Ask questions in a sitting, categorizing.

Each call's provider-reported usage (input, cache read, cache write, output), cost and latency is written beside the ledger. Real days spread over hours, which a run can't wait out, so the run measures each job **cold** (first in its burst) and **warm**, and the monthly figure applies those to each persona's arrivals: how many of a job's calls fall within the TTL (30 minutes on OpenAI, 5 on Anthropic) of the one before, from arrival times drawn for the persona's day (a seeded Poisson spread over 14 waking hours plus the overnight catch-up). Both arms run the same harness: **before** on this branch's base, **after** on the change. Reported: per job hit rate, read and write tokens, $ per call and latency; per persona $ a month. The owner's rough baseline on Pro routing is light ≈$1.40, typical ≈$5.10, heavy ≈$17 a month.

**Personas' days** (assumptions, from plans 202, 204 and 280): light 5 summaries, 10 dated reads, 3 sent, 5 their mail, 1 digest, 5 reply checks, 1 Replies ready draft, 1 draft and 1 refinement, 1 Ask question, 5 mails categorized; typical 15, 30, 8, 15, 2, 15, 4, 3+2, 3, 20; heavy 40, 60, 20, 40, 3, 40, 10, 8+5, 8, 60.

**Spend:** a fresh ledger (`TERNO_AI_LEDGER=/tmp/terno-ai/spend-cache-<n>.jsonl`, `TERNO_AI_CAP_USD` ≤ 55), stopping to ask before $25 in all.

## Performance and resources

No new work in the app: a few more fields on the request. Latency should drop slightly on warm calls (a cached prefix is read, not processed); the harness compares medians per job, cold and warm.

## Out of scope

Which model runs each job; prompt wording beyond the reorders (and a reword only where a reorder needs it); 1-hour TTLs and pre-warming; JEV's categorizer (its own transport, no prompt).

## Revisions after the Codex review

Codex read the plan against the code (`codex exec -s read-only`, 12 points). What changed:

1. **The dated prefix holds per language and zone**, not per language: the reader's zone is in the time rules as well as the arrival line. The zone is the machine's, so it's stable for a reader; the arrival line alone moves. The unit test checks a different zone or language gives a different prefix.
2. **Existing payloads stay byte for byte** (Design, "one rendering"): Anthropic's blocks as written; separators only where a cut text carries them; categorizing's head keeps its single line break.
3. **Stability is asserted within each variant** (language, zone, day, the "since" prompt), and a deliberate miss across them. The replay sends a third of its summaries with a new message (the "since" prompt).
4. **Categorizing's prefix changes with a thread's vetoes** (a category the user took off it leaves the labels), and the labels are also the output schema's enum. New mail rarely has a veto, so the replay keeps one label set; a thread with a veto simply misses the cache.
5. **Repairs.** In explicit mode a repair can't read the first try's user turn (implicit mode wrote it). A repair is rare: a breakpoint on every first try's user turn would cost 0.25× its input on every call to save 0.9× on the few repaired, which pays only past a 28% repair rate. The replay tags repairs and reports how many there were.
6. **Second looks** are in the replay: one dated read in six is asked again with a sentence (`again`), as `secondLook` does, and shares the first's prefix.
7. **Jobs left out of the replay** are named: compile preferences, filters, plan action and its checks, the voice judge, fill. None marks a prefix; on Luna explicit mode only removes their whole-prompt write. The replay adds match and wanted preferences and parse intent.
8. **Ask's branches** (a command, nothing found, nothing usable) end some questions before an answer; the replay answers every question in both arms alike, so the comparison holds and the absolute Ask cost leans high.
9. **The month's estimate** uses one timeline for drafts and Replies ready (they share an account's prefix), and measured cold and warm prices, partial reads included.
10. **The arms are isolated by time and by reported reads**, not by a changed date alone: hours apart (past every TTL), and a call counts warm only when its provider reports a read.
11. **GPT Sol's price moves into the app** (`prices.ts`, from its model page): OpenAI-only drafting counted its cache at the unknown model's $10 / $50.
12. **Every attempt is recorded**, failed ones and repairs too; an OpenAI refusal now keeps the usage it was billed for; a spent cap ends the run rather than leaving a day with jobs missing.

**Renumbered:** written as plan 290; main took 290 for Needs you's batched read, so this is 291.


## What the code review changed

Codex reviewed the series (`codex exec -s read-only`, 10 findings). Each fix has a test that fails without it.

1. **(High) Explicit caching only on OpenAI's own endpoint.** An OpenAI profile can be saved with another base URL (a relay); it got `prompt_cache_options` and content parts it may refuse. Now `api.openai.com` only; a relay gets the flattened text and neither field (`cache.test.ts`).
2. **Categorizing's example holds a fixed id.** On a server without structured output the ladder puts the example in the system prompt, ahead of the cached labels, and it carried the mail's id: every mail had its own prefix. Test: two mails, one prefix.
3. **A marked assistant turn keeps its breakpoint** on OpenAI (it was flattened). Test.
4. **The stream test reads a real event stream** (deltas, the end and the cached usage), not only what was sent.
5. **The harness** spreads a repair's cost over its job's calls instead of counting it as a call; counts the intent reads that come with each draft and the second looks as the day sends them; runs a job alone when asked (intent, the Ask planner or answer); counts a task that fails before any request. The second-look estimate (`dated-second-look.real.ts`) counts the arrival line now read last.

Left as stated limits, not fixed: prices are pooled across personas (the prompts are the same jobs, and each persona's prefix is its own, so a cold and a warm price per job is what changes); the replay's summaries include short newest messages the worker would skip, and its "since" share is about a fifth, not a third (both arms alike: only the absolute summary cost leans low); each arm file is one complete run (an interrupted first attempt was moved aside, below).

Building it also found that the harness's Ask answers had failed before sending anything (no `signal`): the before arm's answers were run again alone.

## What measuring found: a breakpoint inside a message isn't read with a JSON schema

The first after run had the dated and follow-up readers writing their 6,423- and 2,595-token prefixes again on nearly every call and almost never reading them (dated 13% hits, the others 0%), while summaries read theirs. The difference: a breakpoint that ends a block in the *middle* of a message (the per-call arrival line follows it). Probes on Luna (`/tmp/terno-ai/spend-cache-1.jsonl`, label `cache-shape-probe`): without a response schema, a mid-message breakpoint is read; **with a JSON schema it's written on every call and never read** (2,312 tokens three times running), while one that ends a message is read on every later call (2,297), whether the tail is a second system message or the start of the user turn. The docs don't say this; it's measured, and the fix only adds a message boundary: **on OpenAI, a structured request ends a message at each breakpoint**, the same text in the same role (`openai-chat.ts`, test in `cache.test.ts`). Drafting (no schema) keeps one message. The after arm's dated, follow-up and categorizing rows from before the fix were set aside (`/tmp/terno-ai/cache-runs/discarded-after-openai-midmessage.jsonl`) and those jobs run again.

## Results

**Measured in two passes.** The Anthropic key first had its monthly usage limit reached (every request, token counting included, got a 400), so the replay first ran every job on **an OpenAI key alone** (`TERNO_CACHE_ROUTE=openai`: drafting on Sol, everything else on Luna), which exercises every declaration through real breakpoints. Once the key was back, the same replay ran Pro's Anthropic jobs (drafting, Replies ready and Ask's answer on Sonnet, the planner on Haiku, categorizing on Opus) in both arms (`TERNO_CACHE_JOBS=reply,writing,refine,askPlan,ask,categorize`, the after arm 6 minutes after the before arm ended), and Pro's month takes its Luna jobs from the OpenAI arms (the same calls).

**Method.** Each arm replayed the three personas' days once, the before arm from a checkout of the base (32ac5ee34), the after arm 30 minutes later (OpenAI's cache lasts 30). A call is warm when the provider reports a read. Per job: the input's cost cold and warm (repairs spread over their job's calls), and the answer's cost pooled over both arms (its length is the model's, run to run, and caching doesn't change it). A month: 30 days of each persona's calls, each job's share of warm calls from its arrivals (above). In the before arm the dated and follow-up readers never count warm: their prefix carried each mail's own arrival minute, and the replay's few warm reads there were the corpus's repeated days and minutes.

### Per job (Luna and Sol, measured)

| Job | Before: in / read / write tokens a call, hit rate | After | Input $ a call, cold → warm, before | After | Latency median, cold / warm, before → after |
|---|---|---|---|---|---|
| summary (Luna) | 3 / 2,718 / 344, 84% | 427 / 2,480 / 158, 80% | $0.00044 → $0.000069 | $0.00041 → $0.000080 | 7.8 / 5.3 s → 9.2 / 4.6 s |
| dated read and second look (Luna) | 3 / 794 / 5,845, never warm | 212 / **6,266** / 169, **97%** | $0.00074, always | $0.00082 → **$0.000086** | 2.1 s → 2.4 / 2.1 s |
| your mail (Luna) | 3 / 0 / 2,694, 0% | 113 / **2,421** / 168, **94%** | $0.00034, always | $0.00033 → **$0.000037** | 2.5 s → 2.7 / 2.3 s |
| their mail (Luna) | 3 / 28 / 1,753, never warm | 145 / **1,588** / 55, **97%** | $0.00022, always | $0.00022 → **$0.000031** | 1.5 s → 1.6 / 1.2 s |
| digest, reply check, wanted, match, intent, Ask's planner and answer, categorize (Luna) | whole prompt written at 1.25× when over 1,024 tokens (digest 367, match 1,122, ask 2,259, categorize 702 written a call) | nothing written or read | e.g. ask $0.00028, categorize $0.00012 | ask $0.00023, categorize $0.00011 | unchanged (within a run's spread) |
| Replies ready draft (Sol) | 3 / 1,091 / 503, 87% | 49 / 1,211 / 337, 87% | $0.0040 → $0.0011 | $0.0040 → $0.00075 | 2.6 / 1.6 s → 2.0 / 2.1 s (first word) |
| draft asked for (Sol) | 3 / 438 / 1,150, 33% | 78 / 446 / 1,067, 33% | $0.0040 → $0.00088 | $0.0040 → $0.00081 | 0.9 / 0.6 s → 1.0 / 1.3 s |
| refinement (Sol) | 3 / 1,058 / 549, 100% | 96 / **1,513** / 0, 100% | $0.0016 | **$0.00049** | 0.9 s → 0.8 s |

Before, Luna wrote every prompt over 1,024 tokens to its cache at 1.25×, mail and all, and read back only a system prompt that stayed the same. Now it writes a prefix only where one is marked, once per 30 minutes per prefix, and reads it on 94–97% of the readers' calls. Summaries are about even: implicit mode also read their system prompt (it never changed), and the after arm's warm call costs a hundred-thousandth of a dollar more (it reads 240 tokens fewer than implicit mode found). The dated reader is the big one: 6,266 of its 6,650 input tokens now come from the cache, at a tenth of the price, where before all of them were written at 1.25×. Latency: no regression; warm calls are as fast as or faster than before, and every difference is within one run's spread.

### Per persona, a month (an OpenAI key alone, measured)

| Persona | Before | After | Saved | Input alone, before → after |
|---|---:|---:|---:|---|
| light | $0.92 | $0.82 | 11% | $0.69 → $0.59 |
| typical | $2.70 | $2.04 | 24% | $1.98 → $1.31 |
| heavy | $6.12 | $4.54 | 26% | $4.33 → $2.75 |

By job, typical: dated $0.78 → $0.30 of input, their mail $0.10 → $0.04, your mail $0.08 → $0.06, refinements $0.10 → $0.03, Replies ready $0.38 → $0.37; heavy: dated $1.55 → $0.51, their mail $0.26 → $0.08, your mail $0.20 → $0.12, refinements $0.24 → $0.07 (`TERNO_CACHE_REPORT=1` prints every job).

### Pro's routing (both keys), measured

Pro's Anthropic jobs, per call (all three personas' days):

| Job | Before: in / read / write / out tokens a call, hit rate | After | Input $ a call, cold → warm, before | After | Latency median, cold / warm, before → after |
|---|---|---|---|---|---|
| Replies ready (Sonnet) | 71 / 1,669 / 499 / 90, 87% | the same | $0.0056 → $0.00093 | the same | 1.5 / 0.8 s → 0.9 / 0.8 s (first word) |
| draft asked for (Sonnet) | 117 / 606 / 1,481 / 61, 33% | the same | $0.0055 → $0.00097 | the same | 0.5 / 0.8 s → 0.8 / 0.7 s |
| refinement (Sonnet) | 148 / 2,090 / 0 / 43, 100% | the same | $0.00051 | the same | 0.5 s → 0.5 s |
| Ask's planner (Haiku) | 1,742 / 0 / 0 / 346, 0% | 122 / **1,288** / 322 / 387, **80%** | $0.00017, always | $0.00021 → **$0.000029** | 2.2 s → 2.1 / 2.2 s |
| Ask's answer (Sonnet) | 3,225 / 0 / 0 / 177, 0% | 2,083 / **1,047** / 95 / 182, **92%** | $0.0065, always | $0.0068 → **$0.0043** | 0.7 s → 1.0 / 0.6 s (first word) |
| categorize (Opus) | 2,096 / 0 / 0 / 32, 0% | 155 / **1,873** / 68 / 33, **96%** | $0.0084, always | $0.0105 → **$0.0010** | 1.6 s → 1.9 / 1.1 s |

Drafting is unchanged, as designed: the same blocks, bytes and breakpoints as plan 133. The three newly marked jobs read their prefix on 80–96% of the replay's calls, which run back to back; a real day's share comes from its arrivals (below). Anthropic's tokenizer counts these prompts at about one and a half to two times Luna's (categorizing 2,096 tokens against Luna's 1,053, Ask's answer 3,225 against 2,262), so the estimates written while the key was blocked were low: a categorized mail costs $0.009 on Opus, not $0.0075. A cold call pays the 1.25× write: categorizing $0.0084 → $0.0105, Ask's answer $0.0065 → $0.0068.

A month, Pro's routing: the Luna jobs from the OpenAI arms, the Anthropic jobs from these, each job's warm share at 5 minutes (light, typical, heavy: categorize 20/40/38%, Ask 0/67/75%, the planner 0/75/80%, drafts 0/14/0%).

| Persona | Before | After | Saved | Without AI categorizing |
|---|---:|---:|---:|---|
| light | $2.52 | $2.51 | under 1% | $1.16 → $1.12 (4%) |
| typical | $8.96 | $7.26 | 19% | $3.54 → $2.84 (20%) |
| heavy | $25.18 | $20.73 | 18% | $8.91 → $7.20 (19%) |

By Anthropic job (a month, before → after): categorizing light $1.36 → $1.39, typical $5.42 → $4.42, heavy $16.27 → $13.53; Ask's answer $0.25 → $0.26, $0.74 → $0.62, $1.98 → $1.61; the planner a cent or a few either way; drafting $0.41, $1.25 and $3.57, unchanged.

The owner's rough baseline (light ≈$1.40, typical ≈$5.10, heavy ≈$17) sits between the two columns: these personas categorize every undecided mail on Opus, which most people won't turn on, and Opus categorizing is most of a Pro month when it is on. **Where it doesn't pay:** a light persona's categorizing and Ask are cold most of the day, and their writes cost a little more (3 and 1 cents a month); everything else is cheaper or even.

**A 1-hour lifetime, worked out from these prices (not built).** Anthropic's 1-hour cache writes at 2× input and reads at the same price. From the same arrival model, categorizing's warm share at 1 hour is 40/60/98% (light, typical, heavy) and drafting's 0/57/78%. Categorizing's input then costs light $1.51 (against $1.29 at 5 minutes), typical $4.24 (against $4.02) and heavy about $2.3 (against $12.36); drafting's light $0.53 (against $0.34), typical $0.91 (against $1.04) and heavy about $1.5 (against $3.0). One lifetime for everyone doesn't pay: an hour wins only when a prefix comes back more than once an hour, which a heavy user's mail does and a light user's doesn't. Choosing the lifetime from how often the account's prefix was used in the last hour would take most of heavy's $10 a month; it's the next step if the owner wants it.

### The evals of the reordered prompts (Luna, old prompt and new, same day)

| Eval | Old prompt | New prompt |
|---|---|---|
| dated, run 1 | found 187/187, times 44/44, moves 5/5, wrong shown 0, wrong texts 3 (fails ≤ 1) | 187/187, 44/44, 5/5, wrong shown 1, wrong texts 2 (fails ≤ 1) |
| dated, run 2 | 185/187, 43/43, 5/5, wrong shown 0, wrong texts 2 (fails ≤ 1) | 187/187, 44/44, 5/5, wrong shown 0, wrong texts 3 (fails ≤ 1) |
| your mail (followups.real.ts) | run 1 cut off by a time limit; run 2: 1 of 6 failed (v11: one wrong row shown) | 6 of 6 pass, twice: promises 170/170, replies 30/30, dates 90/90, words 70/70, nothing false |
| their mail (theirs.real.ts) | passes: 36 shown, 0 wrong, days 24/24, firmness 33/33, moves 6/6 | identical, passes |

The dated eval's wrong-text threshold fails on both prompts in every run (Luna's texts, as before this change); on everything else the new prompt holds or does better.

### Spend

One ledger, `/tmp/terno-ai/spend-cache-1.jsonl` (cap $55): **$3.17 counted**, of which about $0.42 is worst-case reservations for Anthropic requests refused before running while the key was blocked (not billed), so about $2.75 billed: the OpenAI replay's arms $0.58, the Anthropic replay's arms $1.26 (before $0.94, after $0.32: Opus categorizing read its prefix in the after arm), the evals $0.80, probes $0.02, and a first before run that was interrupted (its arrival times repeated; moved aside to `discarded-before-1.jsonl`) about $0.05.

## Tests run

After rebasing on main (b498eefef), Node 24.21: `packages/ai/src` (all 17 files, `cache.test.ts` new) and the backend's AI jobs (`ai-limiter`, `ai-service`, `ai-backend`, `categorize`, `summaries`, `dated`, `dated-second-look`, `followups`, `ask`, `writing`, `replies`, `preferences`, `dev-ai`, `architecture`): 31 files, 1,148 tests, all pass. `pnpm typecheck` and `pnpm lint` clean. No perf gate covers request building; nothing on a hot path changed.
