# Plan 291: Prompt caching where it pays, across every AI job

- **Status:** planned.
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

