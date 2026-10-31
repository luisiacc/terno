# Plan 85: Free and Pro (subscriptions)

- **Status:** proposed. Nothing is built. Comes **after** plan 84 (Support Terno). Teams is deferred to a later plan.
- **Builds on:** `9d3d661e` (main) and **plan 50** (Terno Cloud: Worker, accounts, signed entitlements, local-mode refresh grant), whose steps 2–4 this plan needs and does not repeat.

## The request

> we're going to do this for pricing lets make multiple plans, one for the subscriptions, another one for donations, donations will be done first
>
> for subscriptions lets leave the teams plan for later too, for now only free and pro, pro just has ai features.
>
> write the plans for now only, so we can implement them later.

The pasted pricing document, the parts this plan covers (§1–§3, §6, §8):

> Free is an excellent email client. Pro is your personal AI email assistant.
>
> **Free — $0**, free forever. Fast email, smart organization, and all essential features. **Pro — $12/mo**, $108/year · $9/month equivalent. AI summaries, personal writing AI, and Ask Your Inbox.
>
> The key principle is that Free users never lose search speed, automatic categorization, email organization, or any basic mail function.
>
> **AI Summaries.** Automatically summarize long conversations when opened, or on demand. Highlight important decisions, dates, action items and unanswered questions. Cache summaries locally so you don't pay for the same summary repeatedly.
>
> **Personal Writing AI.** Generate replies using the current conversation, your previously sent messages, and your writing preferences. Adapt your style to each recipient: formal for clients, brief for colleagues, and more relaxed for friends. Store learned writing profiles locally. The user can review or reset them.
>
> **Ask Your Inbox.** Ask questions across email accounts, such as "What did we agree with this customer last month?" or "Find the invoices I received in September." Search locally first, use AI on relevant results, and link answers to original messages.
>
> I'd start with a $3 monthly provider-cost allowance for managed AI, tracked internally by tokens. That is a cost ceiling for the hosted allowance, not a $3 cash balance. … When the allowance runs out: the user can continue with their own API key or local model, or purchase additional hosted usage. No automatic overage charges. The user should be able to select between managed AI, their own OpenAI/Anthropic key, and a local model. These are execution choices; the Pro subscription pays for your advanced product features.
>
> A 14-day Pro trial would let people discover those features before paying, with a small capped hosted-AI trial allowance to prevent abuse.
>
> | User installs the app | No account or payment required |
> | User starts Pro trial | Pro features unlock for 14 days, with capped hosted AI |
> | User subscribes to Pro | Monthly or annual payment; Pro license activates |
> | Subscription renews | License continues and hosted AI allowance refreshes monthly |
> | User cancels | Pro works until the paid period ends |
> | Subscription expires | App returns to Free; local emails, search and categories remain intact |
> | Hosted AI allowance runs out | No extra charge; offer BYOK, local AI or a prepaid top-up |
>
> For a desktop app, a signed license token can allow local checks without constantly contacting your server. You would still need occasional online checks for subscription status, with a reasonable offline grace period. A customer who stops paying should never lose access to their stored email.
>
> Measure real AI costs and retention. Track token spending per user and per feature, without collecting email content.

Not adopted from the document: **Teams** (later plan) and **§7, the Business Use license** (licensing was dropped on 2026-10-31; the README's BSL organization limit, see decision 7).

## What exists

- **AI today** (`packages/ai`, plan 05 §A): providers Anthropic, OpenAI, OpenAI-compatible, Ollama, LM Studio (`tasks.ts` `transportFor`). Tasks: `generateFilter` and `classify` (categorization). `embed` is declared, not built. **These stay Free**: categorization and AI filters are "automatic categorization" and "email organization".
- **None of the three Pro features exist**: no summaries, no reply drafting, no question answering over mail.
- **Local mode** (plan 05 §B, `packages/backend/src/net-policy.ts`): `NetPurpose` includes `"ai"` and `"cloud"`. In local mode `ai` is allowed only to a loopback provider, `cloud` is denied. New installs default to local mode on.
- **Owner identity** (plan 05 §C) and the reserved `owner.cloud_json`.
- **Plan 50** (proposed): Cloudflare Worker `apps/cloud` + D1, `packages/cloud-protocol`, server `accountId` and `installId` (revision 4), email-code sign-in, sessions (rev. 5), merchant-of-record checkout in the browser with webhook **reconciliation** (rev. 6), Ed25519 entitlement tokens verified offline with `periodEnd`/`graceUntil`, refresh on existing wake-ups only, and a one-operation `cloud` grant for "Refresh license" in local mode (rev. 2).
- **Plan 84** picks the payment provider; Pro uses the same one.
- **Search** (plan 03, plan 64): FTS5 in SQLite, an IDB index on the web, instant at 50k+ threads, defaulting to everywhere.

## Design

### 1. The plans

| | Free | Pro |
|---|---|---|
| Price | $0, forever | **$12/month** or **$108/year** |
| Everything the app does today (accounts, unified inbox, search, categories, AI filters and categorization with your own key or a local model, themes, shortcuts, codes, snooze, …) | ✓ | ✓ |
| AI summaries | | ✓ |
| Personal Writing AI (with per-contact style) | | ✓ |
| Ask Your Inbox | | ✓ |
| Managed AI allowance ($3 of provider cost per month) | | ✓ |

Rules that every change keeps:

- **Nothing that exists today moves behind Pro.** A test enumerates the existing RPC methods and asserts none requires an entitlement.
- **No account is needed for Free.** Installing, adding mail accounts and every Free feature work without signing in, forever.
- **Losing Pro never loses data.** Mail, drafts, categories, filters, cached summaries and writing profiles stay on disk; Pro features turn off calmly.

### 2. Entitlement in the app

Plan 50's token gives `{ accountId, plan, status, periodEnd, graceUntil, trialEndsAt? }`. The backend turns it into one value, computed locally:

```ts
// packages/core/src/entitlement.ts
type Entitlement =
  | { tier: "free"; reason: "none" | "expired" | "signedOut" | "ownerChanged" }
  | { tier: "pro"; source: "trial" | "subscription"; until: number /* graceUntil */; renews: boolean };
```

- `billing.status` (RPC) returns it plus allowance info (§5); `billing.changed` is pushed when it changes (token refresh, sign-in, owner change, clock passing `until` noticed on the next existing wake-up). No timer.
- **Gating is in the backend**, at each Pro RPC (`ai.summarize`, `ai.compose`, `ai.ask`, `ai.styles.*`), with one helper `requirePro()` that throws a typed `ProRequired` error. The UI also hides or labels controls, but never is the only gate.
- **Offline and local mode:** the token is verified offline. A paid user offline keeps Pro until `graceUntil` (`periodEnd` + 14 days). In local mode, refresh only through plan 50's one-operation grant ("Refresh subscription" button).

### 3. The 14-day trial

- Starting the trial needs a Terno account (plan 50 sign-in) but **no card**. The Worker records one trial per `accountId` and per normalized email (lowercased, Gmail dots and `+tags` folded); a second request returns "Your trial was already used" with a Subscribe button.
- The trial token has `source: "trial"`, `until` = start + 14 days, no grace period after it.
- The trial's managed AI allowance is **$0.50** of provider cost (decision 5), with tighter rate limits (§5).
- Day 12 and the end of the trial: one in-app line in Settings → Pro, and the Pro feature surfaces say "Trial ends in 2 days". No emails beyond the provider's, no modal, no countdown on the main window.

### 4. Billing

- **Checkout** is created by the Worker for the signed-in account (plan 50 rev. 6) and opened in the system browser. Monthly and yearly prices are provider products. The app shows prices from `billing.catalog`, which the Worker returns from the provider (cached in the token's refresh response), so a price change needs no app release. USD at first.
- **Webhook reconciliation** exactly as plan 50 rev. 6; `active`, `trialing`, `past_due` (until grace) mint Pro.
- **Renewal**: the token refreshes on existing wake-ups within 7 days of `periodEnd`; the allowance period resets on the Worker at each billing month (yearly plans reset monthly too, on the subscription's anniversary day).
- **Cancel / change plan / update card**: the provider's customer portal, linked from Settings → Pro. Cancelling keeps Pro until `periodEnd`; the token says `renews: false` and the section says "Pro until 12 March. You won't be charged again."
- **Records**: D1 `subscriptions` (plan 50) for Pro, and nothing else. Contributions (plan 84) never touch it.
- **Refunds and chargebacks** end Pro at the next refresh (reconciled state), never delete data.

### 5. Managed AI and the allowance

Managed AI is a **new AI provider**, `"terno"`, next to the existing ones: Terno's Worker relays requests to Anthropic/OpenAI with our keys and meters them.

**Privacy (non-negotiable, and new).** With managed AI, mail content passes through Terno's Worker on its way to the model. AGENTS.md allows mail content to reach "the user's own AI providers"; managed AI counts only because the user **chooses** it, in the same way they choose OpenAI today. So:

- It is never the default and never chosen silently. Choosing it shows what is sent (the text of the threads you ask about, nothing else), where (Terno's relay, then Anthropic or OpenAI), and that nothing is stored.
- The Worker **does not store or log content**: no bodies, prompts or completions in D1, logs, Logpush or errors. It logs `{ accountId, feature, model, inputTokens, outputTokens, costMicros, status, durationMs }`. A test asserts the log line for a request containing a canary string doesn't contain it.
- Upstream accounts use the providers' zero-data-retention terms where offered; the settings copy names the upstream provider.
- **Local mode** treats `"terno"` as a cloud AI provider: paused, with the existing "paused in local mode" message. Pro features in local mode run on a local model only.

**Execution choices.** Settings → AI gets a row "Pro features run on": **Managed AI** (included) · **Your provider** (the AI provider already configured, key or local) · **Local model**. Free AI tasks (filters, categorization) keep using the configured provider as today; managed AI never runs them (decision 6).

**The relay** (`apps/cloud`, `POST /ai/v1/complete`):

- Authenticated by the session; the account must be Pro or trial.
- **The Worker chooses the model per feature** (allowlist): a fast model for summaries and retrieval steps (e.g. `claude-haiku-5-5`), a stronger one for writing and answers (e.g. `claude-sonnet-5-5`). The client can't name arbitrary models or set huge `max_tokens`.
- Limits per request (input tokens, output tokens), per minute and concurrent per account; the trial's are tighter.
- **Metering**: before the call, estimate cost and refuse if `used + estimate > ceiling`; after, record the actual usage from the provider's response. The ceiling is $3.00 of provider cost per allowance month ($0.50 for trials), stored in micro-dollars from a versioned price table in the Worker.
- Every response carries `{ usedMicros, ceilingMicros, resetsAt }`, so the app updates its display without asking.
- **Run out**: the relay answers `allowance_exhausted`; the app says "You've used this month's included AI. It resets on 1 April. Until then, Pro features can use your own provider or a local model." with buttons for both. **Never** an automatic charge.
- **Top-ups** (prepaid hosted usage) are out of scope for v1 (see "Later"); the copy doesn't mention them until they exist.

**Allowance display** (Settings → Pro and AI): "Managed AI · $1.20 of $3.00 used · Resets 1 April", as a hairline meter. Fetched when the section opens and from relay responses, never polled.

In `packages/ai`: a `ternoTransport` (OpenAI-compatible wire to our relay, session header from the backend), going through `fetchFor("ai", { providerLocality: "cloud" })`.

### 6. The three Pro features (product contract; each gets its own feature plan)

Each is big enough for its own plan with the usual Codex critique (each takes the next free plan number when it is written). This plan fixes what they share:

- **AI summaries.** On demand from the thread toolbar and the palette ("Summarize thread"), plus an opt-in setting "Summarize long threads when opened" (off by default; "long" = ≥ 4 messages or ≥ 1,500 words). Output: a short summary, then decisions, dates, action items, unanswered questions, each linked to its message. **Cached locally** in a new table in both stores keyed by `(threadId, contentHash, promptVersion)`, bounded (LRU, e.g. 5,000 entries or 20 MB), cleared from Settings → Storage. A cache hit costs nothing and works after Pro ends (it's the user's data, read-only).
- **Personal Writing AI.** "Draft reply" in the inline composer (never a modal) and "Rewrite" on a selection. Context: the thread, the user's recent sent messages to that recipient, and a **style profile per contact** (or per domain), learned locally from sent mail by a background job that only runs after the user turns the feature on, in slicer-budgeted pages. Profiles are short text plus a few numeric traits, stored locally in both stores, shown and editable in Settings → Pro → Writing style, resettable per contact and all at once. The draft lands in the composer as normal undoable text, never sent automatically.
- **Ask Your Inbox.** A palette mode and a panel: the question → local search first (FTS5 / IDB index, the existing search-everywhere engine, plus query rewriting by the model into search terms and date ranges) → the top N messages' visible text (bounded, e.g. 30 messages, 24k tokens) → an answer that cites messages; every citation opens the message. If search finds nothing, it says so instead of guessing. No embeddings in v1 (`embed` stays declared).

Shared rules: every AI output says it's AI-written and is editable; every request is cancellable (the existing `AbortSignal` plumbing); token budgets are per feature; prompts carry a version so caches invalidate when they change; nothing runs in the background without the user turning it on.

### 7. Settings → Pro (new section)

- **Free, signed out:** what Pro adds, in three lines, the price ("$12 a month, or $108 a year"), **Try Pro free for 14 days** (signs in if needed), and "Already subscribed? Sign in". Calm, no comparison table.
- **Trial / Pro:** status line ("Pro · renews 12 March" / "Trial · ends 14 March" / "Pro until 12 March"), allowance meter, Manage subscription (portal), Refresh subscription, the execution choice, Writing style.
- **Expired:** "Your Pro subscription ended on 12 March. Your mail, summaries and writing styles are all still here." Subscribe button.
- Pro surfaces elsewhere (Summarize, Draft reply, Ask) are visible in Free with a small "Pro" tag; activating one opens a popover with one line and **Try Pro free** / **Not now**. Users can hide these entry points ("Show Pro features: on/off" in Settings → Pro) so Free never feels like an ad.

### 8. Copy (`en` and `es`)

All new strings through `t()` / `L()`: the Pro section, trial states, allowance and exhaustion messages, `ProRequired`, managed-AI disclosure, execution choices, expiry, the "Pro" tag and popover. Prices come from `billing.catalog` formatted with `Intl.NumberFormat`, not catalog strings.

### 9. Measuring (§8 of the document)

The Worker's D1 `ai_usage` table aggregates `(accountId, period, feature, model) → requests, inputTokens, outputTokens, costMicros`. That is enough to tune the allowance and see per-feature cost. Retention: 13 months, then aggregates without `accountId`. Usage with the user's own provider or a local model is never reported. No product analytics in the app.

## Tests

- **Entitlement (unit, `packages/core`/`backend`)**: every token state → `Entitlement`; grace after `periodEnd`; no grace after a trial; owner email change → `free/ownerChanged`; clock in the future refused (plan 50).
- **Gating**: every Pro RPC throws `ProRequired` on Free; the architecture test that **no pre-existing RPC** requires Pro; Free AI tasks work with no account.
- **Local mode**: `"terno"` provider denied with the paused message; Pro features run on a local provider; zero cloud requests counted across startup and a local-mode toggle racing a request.
- **Relay (Worker, miniflare)**: auth; Free account refused; model allowlist; per-request caps; ceiling enforced before the call and recorded after; exhausted → typed error, no upstream call; reset at the period boundary for monthly and yearly; trial ceiling and limits; **canary string never appears in logs or D1**.
- **Billing (Worker)**: plan 50 rev. 6 suite plus: trial once per account and per normalized email; cancel keeps Pro to `periodEnd`; refund ends it at refresh; contribution webhooks (plan 84) never create a subscription.
- **E2E (`apps/web/e2e`)** with a fake Worker: Free sees tags and the popover; start trial → features unlock → allowance meter updates from responses → exhaustion message offers the two alternatives; expiry returns to Free and cached summaries still show; hiding Pro entry points; axe clean in light and dark, `@design`.
- **Desktop smoke**: the Pro section opens; checkout and portal go through `openExternal`.
- **Perf**: Pro code is a lazy chunk (entry-chunk size gate unchanged); `billing.status` on startup is a local token verify, no request (asserted); the style-profile job and summary cache stay inside the slicer budget at 50k threads in both stores (`pnpm test:perf`).

## Performance and resources

- Nothing Pro loads until a Pro surface or the section opens. No timers: refreshes ride existing wake-ups; the allowance updates from responses.
- Bounded caches (summaries) and bounded profiles (one short record per contact, capped count).
- Background work (style learning, auto-summaries) only after the user enables it, paged and sliced.

## Out of scope

Teams (comments, shared drafts, assignments, admin, per-seat billing); the Business Use license (§7 of the document); prepaid AI top-ups; non-USD pricing; embeddings/semantic search; product analytics; the three features' detailed designs (their own plans).

## Later

- **Top-ups**: a prepaid one-time product that adds to the ceiling for the current or next months, never auto-charged.
- **Teams**: its own plan, after Pro has paying customers.
- Supporter badge from plan 84, once accounts exist.

## Order of work

1. Plan 50 steps 2–4 (Worker skeleton, accounts, billing + offline entitlements, local-mode grant), with Pro as the only paid plan.
2. `Entitlement`, `requirePro()`, `billing.*` RPCs, Settings → Pro, the "Pro" tags (no features yet, behind a dev flag).
3. Trial.
4. Managed AI: relay, metering, `ternoTransport`, execution choice, allowance UI.
5. AI summaries (own plan), then Personal Writing AI (own plan), then Ask Your Inbox (own plan).
6. Launch, on desktop and the web together, when **all three** are solid (decision 4): remove the dev flag.

## Decisions (2026-10-31)

1. **Provider:** the same merchant of record as plan 84, once it passes plan 84's sandbox gate.
2. **Support amounts:** plan 84.
3. **Web:** `mail.terno.app` gets Pro at launch, with the same account and entitlement as desktop (answers plan 50 open question 3). On the web the session lives in the worker's store; checkout opens in a new tab.
4. **Launch scope:** Pro launches with all three AI features, not one at a time.
5. **Trial allowance:** $0.50 of provider cost.
6. **Free AI tasks:** managed AI never runs filters or categorization, even for Pro users without a provider.
7. **Organization limit removed.** The BSL 1.1 stays, but its Additional Use Grant now allows production use by organizations of any size; only selling or hosting Terno for others still needs permission. Companies pay only through Pro seats; there is no business plan.

## Revisions after the Codex review

Codex (read-only, against `9d3d661e`) raised 12 points; all are accepted. The critique is kept at `/tmp/terno-plans-84-85/critique-85-free-and-pro.txt`. Each revision replaces what the earlier sections say.

1. **Every cloud operation has a local-mode path.** Sign-in, start trial, open checkout (the Worker creates it first), open the portal, refresh, and load the allowance are all user clicks, and each runs under a **one-operation `cloud` grant** that extends plan 50 rev. 2 from "refresh" to this named set (one request family to the production Worker, no redirects off that host, cancellable). The button says it: "Contacts Terno's server once". Nothing automatic is ever granted: background refresh and allowance updates still need local mode off. Prices without a request: the build bakes a fallback catalog (`TERNO_PRO_CATALOG`, see 12) that the Free card shows; checkout is authoritative. The allowance meter in local mode shows the last known value with its date ("as of 3 March"). Tests: each grant authorizes only its operation, and a later automatic call is still refused.
2. **Pro execution is a separate setting.** `AiService.current()` resolves one global provider (`ai-service.ts:129`) used by filters and categorization. Pro gets its own persisted `proAi: { mode: "managed" | "provider" | "local"; localProviderId? }`; `"terno"` is **not** added to the shared provider registry (`ai-service.ts:69`), so it can never be picked for Free tasks. `"provider"` reuses the configured provider read-only; `"local"` names a loopback provider explicitly. Tests: changing Pro execution never changes the Free AI config, and vice versa.
3. **The ceiling is enforced by reservation.** The relay reserves the request's **maximum** cost (input tokens counted + `max_tokens` at output price) atomically per `(accountId, period)` before dispatch, in a Durable Object per account (serializes concurrent devices), then settles to the actual usage. Reservations expire after the request deadline; a crash, disconnect or timeout settles at the reservation unless the upstream reports usage; missing usage settles at the maximum. Period rollover keeps outstanding reservations on the period they were made in. The client's SDK retries are off for the managed transport, and structured-output repairs (`ladder.ts:59`) are separate requests, each reserved. Tests: two devices racing at the edge of the ceiling, duplicate request ids (idempotent), rollover with reservations outstanding.
4. **Cancellation is request-scoped end to end.** `RpcClient.call()` takes no signal today (`client.ts:82`). Add `ai.cancel(requestId)`; each Pro RPC carries a `requestId`; the backend keeps an `AbortController` per id, also aborted on local mode turning on, owner change, entitlement loss and shutdown. The relay aborts upstream when its client disconnects. A cancelled request's result is discarded at every layer (a generation counter checked before writing a draft or a cache entry). Usage already incurred is settled as in 3. Tests: cancel mid-stream writes nothing; late results after cancel are dropped.
5. **The disclosure lists what each feature sends.** Before managed AI is chosen, a per-feature list: Summaries: the thread's visible text. Writing: the thread, your draft or selection, your style profile for that contact, and up to N of your recent sent messages to them. Ask: your question (also sent first to turn it into searches), then the text of the matching messages. Destination: Terno's relay, then the named upstream (Anthropic or OpenAI). "Nothing is stored" becomes: "Terno doesn't store the content. It keeps usage counts (feature, tokens, cost) tied to your Terno account for billing." Launch requires upstream zero-data-retention terms in place; if an upstream can't offer them, the copy states its retention instead.
6. **The entitlement keeps every date, and is checked on each use.** `Entitlement` (pro) becomes `{ tier: "pro"; source; periodEnd; graceUntil; trialEndsAt?; renews: boolean; offline: boolean }`, all from the signed token. `requirePro()` verifies the cached token against the clock on **every** Pro operation and at each slice of a Pro background job (style learning, auto-summaries), so expiry is enforced in an app left open for weeks; `billing.changed` is emitted when a check notices the change. Tests: expiry and owner change during a running background job stop it at the next slice.
7. **Reading and deleting stored data is never gated.** Only generation and learning require Pro: `ai.summarize`, `ai.compose`, `ai.ask`, `ai.styles.learn`. `ai.summaries.get`, `ai.styles.list`, `ai.styles.reset`, `ai.styles.delete` and clearing caches are Free. Tests run them expired, signed out and offline.
8. **Trial redemption is its own record.** The Worker keeps `trial_redemptions (emailHash, accountId, redeemedAt)` with a keyed hash of the normalized email, **retained after account deletion** for 24 months for abuse prevention, disclosed in the trial copy and the privacy page. Redemption is one atomic insert (unique on `emailHash`), so two installs starting at once get one trial. Owner transfer doesn't grant a new trial. Normalization is scoped: lowercasing everywhere; dot and `+tag` folding only for `gmail.com`/`googlemail.com`.
9. **Cached outputs carry provenance and follow their sources.** The summary key adds `(language, executionMode, modelId)`; switching provider or language doesn't reuse an output silently, it shows the cached one labeled ("Summary made with Managed AI on 3 March", Regenerate). Deleting a message or thread drops its summaries; removing an account drops its summaries and the style profiles learned only from it; Settings → Storage → Clear AI data removes both. Tests in both stores.
10. **Ask Your Inbox treats mail as untrusted and has a scope.** Default scope: every folder except Spam and Trash (unlike plain search, plan 64), shown in the panel ("Searching all mail except Spam and Trash", changeable per question). Retrieved text goes in delimited, quoted blocks with an instruction that it's data; model-rewritten searches are parsed into the existing search grammar and validated (fields, date range bounds) before running; citations must be ids from the supplied set, others are dropped; a cited message deleted since shows "This message was deleted". Adversarial tests: injected instructions in a message, fabricated citations, deleted references.
11. **Generated text never overwrites live work.** A writing request binds to `(draftId, revision, selection range)`. When the result arrives, it is inserted only if the draft and selection are unchanged; otherwise it appears in a small inline "Suggestion ready" strip in the composer with Insert / Discard, as `ai-service.ts:170` already revalidates mutable targets for filters. Insertion is one undo step and autosaves like typing. Tests: typing, recipient change, draft switch and navigation during generation; exact undo.
12. **Cloud configuration is explicit and isolated.** `scripts/release-env.mjs` gains `TERNO_CLOUD_URL`, `TERNO_ENTITLEMENT_KEYS` (public keys by `keyId`) and `TERNO_PRO_CATALOG`, with the precedence of plan 84 rev. 3: release builds get production; staging builds get staging URL and keys; dev, demo and test builds get none (Pro shows "Not available in this build") unless pointed at a fake Worker by `TERNO_CLOUD_URL=http://127.0.0.1:<port>` in tests. Forks set them empty. The session token stays in the backend (keychain on desktop, the worker's store on web); the renderer never sees it and the preload gains nothing but the checked opener (plan 84 rev. 1). Tests: dev, demo and test builds contain no production URL (bundle scan), and a production token doesn't verify against staging keys.
