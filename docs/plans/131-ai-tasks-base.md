# Plan 131: the AI tasks base

- **Status:** proposed. Nothing is built.
- **Builds on:** `b4cf8d1c` (main), plan 05 §A, plan 85 decisions 9 and 10.
- **Used by:** plan 132 (summaries), plan 133 (drafting), plan 134 (smart categorization). This goes first; those three can then proceed in any order.

## The request

> we need to make it so the ways to apply the ai are different but the interfaces are the same, so we can just hotswap them like a local model and hotswap the provider with the api key of the user or with our own.

## What exists

- `AiTasks` (`packages/ai/src/types.ts:73`): `generateFilter`, `classify`, an unbuilt `embed`. `createAi` builds it over any `ModelTransport` (`tasks.ts:58`).
- `ModelTransport.complete` returns whole text (`types.ts:48`). `CompletionRequest.system` and messages are strings (`:33`). No usage comes back (`:42`).
- `anthropic.ts` hard-codes `effort: "low"` (`:36`) and sends `fallbacks: "default"` on every request (`:33-34`). SDK 1.1.0 already has streaming, `cache_control` and `effort`; no upgrade is needed.
- `AiService.current()` resolves the configured provider per call and caches clients by config hash (`packages/backend/src/ai-service.ts`). Callers: `filters.generate` and `Backend.ai()` (`core.ts:2665`), which `AiAssist` uses.
- `RpcClient.call` takes no signal (`packages/core/src/rpc/client.ts:82`). `filters.generate` aborts its predecessor by client id; nothing else is cancellable.
- `AiAssist` holds the only background limiter: 20 calls a minute, in memory (`ai-assist.ts:21`).
- `ai.profiles` keeps each provider's model and URL, so switching provider loses nothing (plan 05).

## Design

### 1. `AiService.forTask(task)`

```ts
type AiTaskName = "filter" | "categorize" | "summary" | "writing";
forTask(task: AiTaskName): Promise<AiTasks>;
```

The one place that decides what runs a task. `current()` becomes private and every caller moves over. Today it returns the user's provider with the task's model applied. Managed AI later plugs in here (plan 85 decision 10) with no feature change. No feature reads `providerId`, except the existing `reason.aiCloud` text, which names the provider for the user. An architecture test scans `packages/backend/src` and `apps/web/src` for other branches on it.

### 2. A provider and model per task

The user's choice (2026-11-04): "for claude models use sonnet 5.5 for drafting, for summaries we'll use gpt luna." That puts two tasks on two providers, so a task names both:

```ts
ai.tasks?: { summary?: { provider: AiProviderId; model: string; preset?: CompatiblePreset }; writing?: { … } };
```

Keys, URLs and capabilities stay in each provider's existing profile, so a task only points at one. `forTask` resolves the task's target, or the configured provider and model when absent.

| Task | Default | When that provider isn't set up |
|---|---|---|
| Writing | `claude-sonnet-5-5`, when Anthropic is the provider | The configured provider and model |
| Summary | GPT Luna (`gpt-6-luna`; confirm the id against OpenAI's model list when building) on OpenAI | Nothing runs until the user chooses: **Add an OpenAI key** or **Use {configured provider}** |

- **A default never overrides a choice,** and it never moves mail silently (plan 85 decision 10). Summaries won't send mail to OpenAI unless the user has set up that provider, and they won't send it to another provider without being told to. So someone with only an Anthropic key is asked.
- **Filter and categorize** keep using the configured provider.
- **Settings → AI** shows a provider and model row in each feature's group, naming where that feature's mail goes, with the discovery list that tab already has.
- **Hosted AI (plan 85 §5)** follows the same choice: the relay's allowlist is `claude-sonnet-5-5` for writing and `gpt-6-luna` for summaries, which also makes OpenAI an upstream to disclose.

**Why per task:** drafting needs quality and summaries run on every new mail, so they have very different cost and quality needs. Luna's price wasn't checked for this plan.

### 3. Transport changes

Each is added when its first user lands, listed here so they land the same way everywhere:

| Change | First user | Note |
|---|---|---|
| `CompletionRequest.effort`, default `low` | 133 | transport drops it on models that reject it |
| `Completion.usage` (input, output, cache read, cache write) | 132 | never logged with content; used by evals and later metering |
| `system` and messages accept `PromptBlock { text; cache?: boolean }` | 133 | Anthropic maps to `cache_control`; OpenAI-compatible concatenates in the same order |
| `ModelTransport.stream?` | 133 | a server without it falls back to one chunk; idle watchdog of 30 s between events, 90 s to the first on local |

### 4. Cancellation

`ai.cancel({ requestId })`. Foreground AI RPCs carry a `requestId`; the backend keeps one `AbortController` per id, aborted also on provider or model change, the feature's setting going off, and shutdown. A cancelled result is discarded by a generation check before anything is written (plan 85 revision 4). A provider switch sends nothing further to the old provider, repairs in the ladder included.

### 5. One background limiter

Summaries and categorization both call on new mail, and must not each take the provider's whole rate. `AiLimiter` is extracted from `AiAssist`: 20 calls a minute across background tasks, concurrency 1 on a local provider, a soft daily cap per task (§6 of plan 132, plan 134). Foreground requests (drafting) bypass the queue. In memory, no timers while empty.

### 6. Two checks on existing behavior

Reported from reading the code and guidance, **not verified against the API**. A gated real-model test decides each before any change:

- `classify` allows `200 + 60 × items` tokens (`tasks.ts:111`). Thinking counts toward `max_tokens` and can't be disabled on Opus 5.5, so a small batch might truncate. If it does, raise the floor.
- `output_config.effort` errors on Haiku 4.5 and `UNSUPPORTED_OUTPUT` (`sdk-errors.ts:20`) may not catch it. If so, it's an opaque failure on every AI feature for that model.

`fallbacks` also comes off Haiku requests, per the API guidance.

## Tests

- **`contract.test.ts`** runs every task on every transport, as it does now, plus usage and streaming shapes.
- **`forTask`:** picks the task's provider and model, throws the existing typed errors; changing a task's target never changes the configured provider; a summary default with no OpenAI key sends nothing anywhere and asks; a default never replaces a user's choice.
- **Cancellation:** cancel mid-request writes nothing; a late result after cancel is dropped; a provider switch during repairs produces no further request to the old provider.
- **Limiter:** shared budget across two tasks; local concurrency 1; drops nothing it accepted; no live timer while empty.
- **Architecture:** no feature branches on `providerId`; `ai.*` stays off `MCP_ALLOWED`.

## Performance

No new work at boot; `forTask` adds one settings read that `current()` already does. SDKs stay lazy. Nothing enters the renderer's entry chunk.

## Out of scope

The relay, metering, `aiExecution`, `requirePro` (plan 85, when the server exists). `embed`.

## Order

1. `forTask`, callers moved, architecture test.
2. `ai.tasks`, its defaults and the Settings rows.
3. `AiLimiter` extracted, `AiAssist` moved onto it with no behavior change.
4. `ai.cancel` and `requestId`.
5. The two gated checks, fixes if they prove real.
6. The new-mail marker (revision 5), when the first of plans 132 and 134 needs it.

## Revisions after the Codex review

Codex (`gpt-6.1-sol`, high, read-only, against `f787771c`) raised 4 points on this plan, all accepted. Revision 5 follows from its points on plans 132 and 134. Each replaces what the sections above say.

1. **`forTask` returns a task session, not bare tasks.** Today's capabilities belong to the configured model (`ai-service.ts:133`, `settings.ts:439`), so a task model reusing them would inherit another model's context limit and output mode. A session is immutable and holds the tasks, effective model, endpoint, capabilities and a configuration generation. Capabilities load and save under that effective target. Assemblers size their budgets from the session.
2. **Requests belong to a connection.** `emit` filters by origin, so a compose stream would reach every renderer and dev connection (`rpc/server.ts:90`), and a controller map keyed by request id lets anyone cancel anything. Cancellation and stream delivery bind to the originating connection (`CallContext.clientId`, `server.ts:6`), through a new send-to-one on the server. Duplicate live ids are rejected, and a disconnect aborts that connection's requests. Origin exclusion stays as the extra barrier against MCP. Tested with two windows generating and cancelling at once.
3. **Permits go around actual provider requests.** One task can make several requests (`ladder.ts:59`) and cloud clients allow an SDK retry (`ai-service.ts:122`), so limiting tasks limits nothing real. `AiLimiter` hands out a permit per request, repairs and retries included. Foreground work doesn't bypass it: it takes priority, and on a local provider it still shares the one slot, waiting for the running request. Accepted queued work has an explicit bound.
4. **Streaming has a written contract before anyone consumes it.** `stream` yields typed text deltas and exactly one terminal outcome: done, length, refusal, cancelled, timed out or failed, with usage where the provider gave it. Accumulated text is bounded. Deadlines are per task. A transport without streaming yields one delta and the terminal. Writing sets SDK retries to 0, so plan 133's "no automatic retry" survives the SDK.
5. **One durable marker for new mail.** Plans 132 and 134 both need "this arrived as new mail" to survive a quit, a late body and a model that isn't ready, and neither can recompute it later, because the later `setBody` isn't live mail. `ai_new_mail(message_id PRIMARY KEY REFERENCES messages ON DELETE CASCADE, thread_id, arrived_at, wants_summary, wants_category)`, in both stores, written in the ingest commit like `forward_eligible` (`sql-store.ts:632`), only for live mail no older than 3 days and only while a feature wants it, and independently of whether a classifier is ready. Rows are removed as they're consumed and pruned at 3 days. Shape-only migration; an empty table.

## What the code review changed

The user's fear outranks convenience here: "i don't want to wake up to hundreds of dollars of charge".

- **A request is charged before it leaves.** `AiLimiter` reserves the worst case (input estimated from the request's characters, plus `maxTokens`) in one in-memory book, with no await between the last check and the charge, so concurrent callers can't share one remaining allowance (it reproduced 301 requests at a ceiling of 300). The reservation is written before dispatch: background work fails closed if the write fails, a person's request never does. It's settled only when the provider reports usage, so a lost response, a failure, a stopped stream or a crash stays counted. Ceilings are asked again after waiting for a slot.
- **An unknown cloud price counts dear.** $10 per million input and $50 per million output, for the ceiling and the figure alike; a local model is $0. `ai.usage` says `estimated` and Settings shows "about". A server reporting zero tokens counts as not having reported.
- **A key taken back stops spending.** Everything built under a key aborts what it has in flight and refuses what comes next when the key is replaced or removed, before workers resume: clearing the client cache revokes nothing a worker already holds.
- **Real-model runs share one ledger.** `@terno/ai/file-ledger`: append-only `reserve` and `settle` lines under a mkdir lock, unsettled reservations counted as spent, used by the harness and the real-app factory. A stuck lock or a torn line refuses rather than guesses. It reproduced $0.020 against a $0.015 cap; five real processes now hold one reservation. The real-app factory forces `maxRetries: 0`, and the browser proof needs `TERNO_AI_REAL=1` before it reads `.env` and a live backend's guard marker before it types a key.
