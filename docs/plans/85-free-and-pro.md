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

| | Free | Business | Pro |
|---|---|---|---|
| Price | $0, forever | **$49/user/year** (proposed) | **$12/month** or **$108/year** |
| Who needs it | individuals; organizations under 100 employees and contractors **and** under US$5M revenue | people using Terno for work at a larger organization who don't need AI | anyone who wants the AI features |
| Everything the app does today (accounts, unified inbox, search, categories, AI filters and categorization with your own key or a local model, themes, shortcuts, codes, snooze, …) | ✓ | ✓ | ✓ |
| Business use at any company size (LICENSE grant (c)) | under the limit only | ✓ | ✓ |
| Smart categorization (decision 8) | own provider | own provider | ✓ (`jev`) |
| AI summaries | own provider | own provider | ✓ |
| Personal Writing AI (with per-contact style) | own provider | own provider | ✓ |
| Ask Your Inbox | own provider | own provider | ✓ |
| Managed AI allowance ($3 of provider cost per month) | | | ✓ |

"Own provider" is the user's API key or a local model (decision 9).

**Business** unlocks no features; it is the right to use Terno for work at an organization that isn't a Small Organization (LICENSE). **Pro includes business use**: a Pro subscriber never needs a Business seat too. Both are stated in the subscription terms shown at checkout and on terno.app/pricing: "Every paid subscription includes the right to use Terno for work, at a company of any size."

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
- **Business seats** are a provider product too, **yearly only**, bought one seat per person (a company buys N seats with one invoice; the provider's quantity field). A seat is needed for each person who has connected a work email account to Terno (LICENSE "Seat"), unless they have their own Pro; admins count them in the Google Workspace admin console (apps with access; Microsoft accounts connect over IMAP today, so Microsoft 365 doesn't list Terno), their device management, or by asking. Seats can be added any time, prorated; removed only at renewal. There is **no enforcement in the app**: no license keys, no seat checks, no prompts based on company size (we can't know it, and local mode sends nothing). Compliance is the company's, as with Docker Desktop. A Business subscriber may sign in to show "Business" in Settings → Pro, but nothing depends on it. Seat assignment, admin and SSO are out of scope (Teams/Enterprise later).
- **Records**: D1 `subscriptions` (plan 50) for Pro and Business (`plan` column), and nothing else. Contributions (plan 84) never touch it.
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

Teams (comments, shared drafts, assignments, admin, seat management, SSO); prepaid AI top-ups; non-USD pricing; embeddings/semantic search; product analytics; the three features' detailed designs (their own plans).

## Later

- **Top-ups**: a prepaid one-time product that adds to the ceiling for the current or next months, never auto-charged.
- **Teams**: its own plan, after Pro has paying customers.
- Supporter badge from plan 84, once accounts exist.

## Order of work

Features come first, on the user's own provider; the server and billing follow (decision 4, as changed on 2026-11-04).

1. The swappable base (decision 10): `AiTasks` as the seam, `AiService.forTask`, the `calibrated` flag.
2. AI summaries (own plan), then Personal Writing AI (own plan), then Ask Your Inbox (own plan), then smart categorization as suggestions (own plan). Each ships when it is ready, Free on the user's key or local model, with no account and no server. With no provider set up, a feature offers only **Use your own key or local model** until Pro exists.
3. Plan 50 steps 2–4 (Worker skeleton, accounts, billing + offline entitlements, local-mode grant), with Pro as the only paid plan.
4. `Entitlement`, `requirePro()`, `billing.*` RPCs, Settings → Pro, behind a dev flag.
5. Trial.
6. Managed AI: relay, metering, the managed `AiTasks`, the "AI features run on" choice, allowance UI. No feature changes, by decision 10.
7. Launch Pro, on desktop and the web together, when hosted AI runs every shipped feature: remove the dev flag. Filing with hosted `jev` joins once decision 8's open points are settled, and doesn't hold up this launch.

## Decisions (2026-10-31)

1. **Provider:** the same merchant of record as plan 84, once it passes plan 84's sandbox gate.
2. **Support amounts:** plan 84.
3. **Web:** `mail.terno.app` gets Pro at launch, with the same account and entitlement as desktop (answers plan 50 open question 3). On the web the session lives in the worker's store; checkout opens in a new tab.
4. **Launch scope (changed 2026-11-04, the user: "the features will ship before the server and billing"):** the AI features ship one at a time on the user's own provider, before the server and billing exist. Pro launches later, with hosted AI for every feature shipped by then.
5. **Trial allowance:** $0.50 of provider cost.
6. **Free AI tasks:** managed AI never runs filters or categorization, even for Pro users without a provider.
7. **Organization limit (Docker-style).** The BSL 1.1 grant allows free production use for individuals and Small Organizations (fewer than 100 employees and contractors **and** less than US$5M annual revenue), 30-day evaluation at any size, and any use by someone holding an active paid subscription. Larger organizations need a paid seat per person who uses Terno for work: **Pro** (AI included) or **Business** ($49/user/year proposed, no features). Pro's terms state it covers business use. Enforcement is the license alone, never the app.
8. **Pro categorization beyond filters uses `jev` (2026-11-01).** The request: "for the ai pro plan, for categorization that doesn't fall into filters, we can use 'jev'". Threads that no filter (manual, AI or learned) places are categorized with `jev` in Pro. Decision 6 still holds for Free: filters and the existing categorization never run on managed AI.

   **What `jev` is** ([TypeSafe AI's announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev), read 2026-11-04; its figures are self-reported): TypeSafe AI's first public "System One" model, a hosted model in waitlisted early access (docs.typesafe.ai). It takes text and structured state and returns one value from outputs defined in advance, with a calibrated confidence. Latency 70–500 ms; input $0.042 per million tokens, output free. It generates no free text, and choices go up to 255 before a slower two-stage path. So it fits picking a category and cannot write summaries, drafts or answers.

   **Scope (2026-11-04).** The request: "categorization we could have for thins don't have a rule yet, but are new and we can categorize it with confidence". So `jev` looks at a thread only if it is new (the engine's existing limit: an inbound root in the Inbox, within `POLICY.autoWindowDays`, never backfill) and no filter placed it and the local engine didn't file it. It files the thread itself when its confidence clears the bar; below the bar it files nothing. This is a deliberate exception to plan 02 §3.6, where AI only suggests.

   **Who gets it (2026-11-04).** The request: "for the smart categorization, it would be only under the paid plan, the one that uses AI, the one with our current filters is free", then "the local engine stays free, also if they use a local ai provider or their own api key they canuse ai features as well". So filters, the local engine and Settings → Categories' existing AI switch (`aiCategorize`, `AiAssist`) stay Free. Smart categorization on Terno's hosted `jev` needs Pro; on the user's own provider it doesn't (decision 9). When Pro ends, new mail stops going to hosted `jev` and threads it already filed stay where they are.

   Consequences for the plan: `AiAssist` can't simply be reused, because it only sends threads where the engine already has evidence (`p ≥ 0.5`, enough examples, labels limited to those categories), which is the opposite of mail with nothing to go on. `jev` needs the user's categories as its choices. A filing keeps what the engine's `auto` filings have: Undo, `added_by = 'auto'` so it doesn't train the model, the veto checks, and the per-category safety valve that pauses filing when users keep reverting.

   **To settle in the categorization plan:** which account pays and whether requests go through the relay, since decision 6 keeps managed AI off categorization and this is a third provider path; the confidence bar, measured on real mail rather than assumed from TypeSafe AI's calibration claim (start at the engine's `POLICY.autoP`, 0.97); what `jev` gets for categories with no examples yet, since a name alone may say little; what mail text is sent, in the disclosure of revision 5; TypeSafe AI's data retention, which the announcement doesn't state, as a launch requirement like revision 5's zero-retention terms; and what happens if early access ends or the service is down, which must leave categorization on the local engine.

9. **AI features are free on the user's own provider (2026-11-04).** The request: "if they use a local ai provider or their own api key they canuse ai features as well". This reverses the pasted document's "the Pro subscription pays for your advanced product features": every AI feature (summaries, writing, Ask Your Inbox, smart categorization) runs without Pro on the user's key or local model. **Pro sells hosted AI:** no key or model to set up, the included allowance, hosted `jev`, and business use at any company size. It overrides the earlier text where they differ:
   - **Gating (§2, revisions 6 and 7):** `requirePro()` guards only hosted requests, meaning the relay and hosted `jev`. A request on the user's own provider needs no entitlement, account or sign-in. Gating tests change to match: each AI feature runs on Free with a fake provider, and a hosted request throws `ProRequired`.
   - **Execution (§5, revision 2):** "Pro features run on" becomes "AI features run on". Managed AI is one choice, offered only with Pro or a trial.
   - **Pro tags (§7):** an AI feature with no provider configured offers both ways to run it, **Use your own key or local model** and **Try Pro free**. With a provider configured, it shows no Pro tag. **Replaced by plan 147 (2026-11-05):** with no provider configured an AI feature shows nothing at all; Settings → AI is the way in, and where Pro's offer goes when it's built.
   - **When Pro ends:** AI features on the user's own provider keep working; only hosted AI stops.
   - **Order of work:** the three features and own-provider smart categorization don't need plan 50's Worker when they run on the user's provider, so they ship first (decision 4).
   - **Smart categorization on the user's own model only suggests (2026-11-04, the user: "for users own model will be suggestions, not filed automatically").** Decision 8's automatic filing relies on `jev`'s calibrated confidence, and a general model's self-reported confidence has no such claim behind it. Filing stays hosted `jev` only.
10. **One interface; the AI behind it swaps (2026-11-04).** The request: "we need to make it so the ways to apply the ai are different but the interfaces are the same, so we can just hotswap them like a local model and hotswap the provider with the api key of the user or with our own." Features never know what runs them. Most of this exists: tasks call `AiTasks` (`packages/ai/src/types.ts`), `createAi` builds it over any `ModelTransport`, and `AiService.current()` resolves the configured provider on every call, so changing provider or key already applies to the next request.
    - **`AiTasks` is the seam.** `summarize`, `compose` and `ask` are added to it next to `classify`. Managed AI implements the same interface. It can't be only a `ModelTransport`: `jev` generates no text and its API isn't known yet, so managed `classify` goes to `jev` while the writing tasks go to the relay's language models.
    - **Two levels of choice.** "AI features run on": **Your provider** or **Managed AI**. A local model and a user's key are both already "your provider" (the existing provider setting, which keeps each provider's model and key when switching). This replaces revision 2's three modes with `aiExecution: "own" | "managed"`. Switching never touches the saved provider config, and revision 2's rule stays: managed AI isn't in the provider list.
    - **One place decides.** `AiService.forTask(task)` returns the `AiTasks` for a task: it reads the choice, applies decision 6 and calls `requirePro()` when the choice is managed. That replaces §2's check at each Pro RPC.
    - **Differences are declared, not branched on.** An implementation states what it can do, and callers read that: `AiTasks` gains `calibrated: boolean`, true only for hosted `jev`. Categorization files when `calibrated` and confidence clears the bar, and suggests otherwise. No feature checks `providerId`, and an architecture test enforces it.
    - **A swap never moves mail silently.** Switching aborts requests in flight, including repairs still in the ladder, so nothing more goes to the provider the user left. Managed AI running out or Pro ending shows the §5 message and offers the alternatives; it never falls over to another provider on its own, because that would send mail somewhere the user didn't pick for this.
    - **Limits that stay visible.** Budgets follow `Capabilities.contextTokens`, since a local model may hold far less than a cloud one. `complete()` returns whole text today, so streaming for summaries and drafts is added to the transport interface when the first writing task is built.
    - **Tests:** the existing contract suite (`packages/ai/src/contract.test.ts`) runs every task against every implementation, managed included. Swapping during a task sends nothing further to the old provider. The same feature e2e passes on a fake own provider and a fake managed one.

11. **The AI features' implementation plans (2026-11-04).** [Plan 131](131-ai-tasks-base.md) is the shared base, [132](132-ai-summaries.md) summaries, [133](133-ai-drafting.md) drafting, [134](134-smart-categorization.md) smart categorization. They override §6 where they differ. Models (the user: "for claude models use sonnet 5.5 for drafting, for summaries we'll use gpt luna"): `claude-sonnet-5-5` and GPT Luna, replacing §5's example models for those features, so hosted AI also discloses OpenAI as an upstream. Summaries run by themselves only on new, non-spam mail (the user: "only new emails get summaries, and of course emails not categorized as spam"), and older mail can be summarized by hand (the user: "do allow the user to manually trigger a summary for older mail"); drafting builds a four-level voice profile (you, account, domain, person) through a consented job, and draft requests send style notes plus messages to this person only. Hosted drafting at that quality on the $3 allowance is about 100 to 200 drafts, which needs revisiting before it's promised.

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
