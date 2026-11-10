# Plan 168: Terno picks the model

## The request

The owner, verbatim:

> for the ai settings, the user should not be able to select the ai model to use, we decide that based on the api keys available or if he is in the pro plan, if in pro plan or dev mode ai, that selector doesnt show, also same if any other setting allows to select which model to use

## What exists

- **Settings → AI's first group** (`apps/web/src/components/settings/ai-tab.tsx`): a Provider select (Ollama, LM Studio, a server on this Mac; Claude (Anthropic), OpenAI, an OpenAI-compatible service; the demo; none), the key for *that one* provider, an endpoint where one applies, a **Model** field with a discovered list (`ai-model`, `ai-models`, `ai-model-option`, the refresh button) and Test connection. Only one provider's key can be added there.
- **Each feature's "Where X runs" row** (`TaskTargetRow` in `ai-summaries.tsx`, plan 131 §2): a provider select and a model select (or a model field) for summaries (`ai-summaries-target`), Ask (`ai-ask-target`), follow-ups (`ai-followups-target`) and the digest (`ai-digest-target`). They write `settings.ai.tasks.<task>`.
- **Summaries' "ask" row** (plan 132 §2): with only a paid provider that isn't OpenAI, summaries wait for **Add an OpenAI key** (a second key field, `ai-summaries-key`) or **Use {provider}** (`ai-summaries-use`, which writes `tasks.summary`).
- **The backend's routing** is `AiService.targetFor` (`packages/backend/src/ai-service.ts`): a task's own choice first; otherwise defaults that depend on which provider is *the configured one* (Sonnet for drafting and Ask on Claude, Haiku for follow-ups and the digest, Luna for summaries once there's an OpenAI key, Opus — the Claude profile's model — for filters and categorizing).
- **"Can this run" helpers** (`packages/core/src/today.ts`): `aiReady`, `chosenTargetReady`, `writingCanRun`, `summaryCanRun`, `aiFeaturesAvailable`; and in the renderer (`apps/web/src/lib/ai.ts`) `summaryTarget`, `askTarget`, `followupTarget`, `digestTarget`, `writingTarget`, `writingModel`, `askReady`, `summaryReady`, `mailDestinations`. Each restates part of `targetFor`.
- **Dev mode's Pro AI** (plan 146, `withDevAi` in `packages/backend/src/settings.ts`): the environment's keys over the saved settings, with the configured provider Anthropic (else OpenAI) and the task choices filtered to what the environment holds. The AI tab then shows only a note pointing at Dev mode, the disclosure, and the feature groups — which still carry the per-task rows.
- **Pro's routing**, as the rating records it (`PRO_ROUTING` in `scripts/ui-rating/keys.mjs`, held by `keys.test.ts`): summaries on OpenAI `gpt-6-luna`; ⌘J, Reply ready, voice and Ask on `claude-sonnet-5-5`; the check, the planner, follow-ups, the digest and intent on `claude-haiku-5-5`; filters on `claude-opus-5-5`; categorizing on JEV. It isn't written down anywhere as a table: it falls out of `targetFor` over `withDevAi`.
- Nowhere else chooses a model: the command palette, onboarding (first run picks a running local model by itself, `first-run.tsx`) and Dev mode have no model control. The drafting group's note ("Drafts are written by …") names a model but chooses nothing.

## Design

### 1. One routing function: `routeFor(job, ai)` in `@terno/core`

`packages/core/src/ai-routing.ts`, used by the backend's `targetFor`, the core gates and the renderer, so they can't disagree.

```ts
export const AI_JOBS = ["summary", "writing", "voice", "intent", "reply", "replyCheck", "ask", "askPlan", "followup", "digest", "filter", "categorize"] as const;
export function routeFor(job: AiJob, ai: RouteFields): { provider: AiProviderId; model: string } | null;
export function aiCanRun(job: AiJob, ai: AiSettings | null | undefined): boolean;
```

**On keys (Claude, OpenAI, or both; Pro; Dev mode's Pro AI).** Whenever the configured provider is `anthropic` or `openai`, the saved keys decide and the saved model doesn't: summaries go to OpenAI when it has a key, everything else to Claude when it has one, and each to the other provider when only that one has a key.

| Job | Both keys (Pro) | Only Claude | Only OpenAI |
|---|---|---|---|
| Summaries | OpenAI `gpt-6-luna` | Claude `claude-haiku-5-5` | OpenAI `gpt-6-luna` |
| ⌘J drafting, Reply ready, learning your voice | Claude `claude-sonnet-5-5` | Claude `claude-sonnet-5-5` | OpenAI `gpt-6-luna` |
| Ask | Claude `claude-sonnet-5-5` | Claude `claude-sonnet-5-5` | OpenAI `gpt-6-luna` |
| Ask's planner and actions, Reply ready's check, who a sentence is for, follow-ups, the digest | Claude `claude-haiku-5-5` | Claude `claude-haiku-5-5` | OpenAI `gpt-6-luna` |
| A filter from a description | Claude `claude-opus-5-5` | Claude `claude-opus-5-5` | OpenAI `gpt-6-luna` |
| Smart categories | JEV with a JEV key, else Claude `claude-opus-5-5` | same | JEV, else OpenAI `gpt-6-luna` |

With both keys this is exactly `PRO_ROUTING`. With only Claude, Haiku summarizes: the model "Use Claude" already picked (plan 132), since this runs on every new mail. **OpenAI has one model here**, `gpt-6-luna`, because it's the only OpenAI model Terno knows the price of (`prices.ts`, the owner's figure) and the only one any plan named; Dev mode with only an OpenAI key already ran everything on it. Picking a stronger OpenAI model for drafting and Ask is the owner's call (open question below), and is a one-line change in the table.

**On a local or custom endpoint (Ollama, LM Studio, a server on this Mac, an OpenAI-compatible service).** Everything runs on the configured provider with the model the user set; JEV still categorizes with a JEV key. Terno can't know what's installed on someone's Ollama or offered by their OpenRouter account, and a guess would fail every request, so **the model field stays for these, and only for these.** A saved OpenAI key no longer pulls summaries off a local model: the user chose to keep mail here, and the row that added that key is gone.

**None, or only JEV:** nothing runs but categorizing on JEV, as today.

`aiCanRun(job, ai)` is `routeFor` plus the key state: the configured provider's key readable and confirmed for its endpoint, a model and endpoint where they're needed; any other provider by its saved key. `aiReady(ai)` becomes `aiCanRun("writing", ai)`; `writingCanRun`, `summaryCanRun` and `chosenTargetReady` go, their callers read `aiCanRun`. `aiFeaturesAvailable` (Today) reads `aiReady` instead of the configured provider's key alone, so an OpenAI-only setup with Claude still selected counts.

### 2. The backend follows it

- `targetFor(job)` is `routeFor` plus the profile: the configured provider as set up (its endpoint and preset), another with its own saved profile, as `profiled` did. No route throws `not_configured`. The summaries-specific refusal (`errors.ai.summaryProvider`) goes: summaries can always run where AI can.
- `withDevAi` stops filtering task choices (there are none to read); Pro's routing is now the table, not an accident of defaults.
- `settings.ai.tasks` **leaves the read shape and the patch schema.** It isn't migrated or deleted: a stored `tasks` stays in the profile, untouched by every write, and nothing reads it. The same goes for a saved model on the Claude or OpenAI profile: kept, unused while that provider is reached by key. Turning back to a local server shows the model it had.
- `configChanged` no longer watches `tasks`.

### 3. Settings → AI

- **Provider:** Claude (Anthropic) and OpenAI become one item, **Claude or OpenAI** (`ai-choice-keys`), "with your own keys". Picking it sets the provider to Anthropic (OpenAI when only an OpenAI key is saved); which of the two is stored no longer changes what runs.
- **Keys:** with that item, two key rows, **Claude (Anthropic) key** and **OpenAI key**, each saved, removed, confirmed or re-entered on its own, with the hint "Add either or both. Terno picks the model for each feature." The configured one keeps the unreadable and moved-endpoint states it has today.
- **No model field** for keys, and none for the demo. Ollama, LM Studio, a server on this Mac and an OpenAI-compatible service keep the field and its discovered list.
- **Test connection** tests each saved key on keys (one line per provider when there are two), and the model otherwise.
- **One quiet line** (`ai-routing`) under the keys and in Dev mode's AI tab, naming who gets what: "Summaries run on OpenAI, every other feature on Claude (Anthropic)." or "Every AI feature runs on Claude (Anthropic)." It's built from `routeFor`, so it can't drift. The privacy footer (plan 131's disclosure) stays, now from `routeFor` over every job.
- **The per-feature rows go:** summaries', Ask's, follow-ups' and the digest's "Where … runs" (provider select and model select or field), and summaries' Add-an-OpenAI-key / Use-{provider} row. Each switch's hint still names its provider. Summaries' group shows only when summaries are offered (plan 157), since the provider group above is now the way to set AI up.
- The usage book, the monthly limit, the background switches, the nudge choice, the not-newsletters list and the drafting note stay.

### 4. Strings

New and changed in `en` and `es` together; the ones only the removed rows used are deleted (`ai.summaries.target*`, `ai.summaries.ask`, `ai.summaries.none`, `ai.summaries.addKey`, `ai.summaries.use`, `ai.summaries.keyLabel`, `ai.summaries.devKey`, `ai.ask.target*`, `ai.followups.target*`, `today.digest.target*`, `ai.model.needsKey` and `errors.ai.summaryProvider` where nothing else reads them).

## Tests

- **`ai-routing.test.ts` (core):** the table for both keys (equal to `PRO_ROUTING`'s values), only Claude, only OpenAI, each local kind and a compatible service (the user's model for every job), none, JEV with and without other keys; a stored `tasks` changes nothing; a saved Claude model changes nothing on keys; `aiCanRun` with an unreadable or moved key, a missing model on a local server, a compatible custom without an endpoint.
- **Backend:** `ai-service.test.ts` and `dev-ai.test.ts` — `forTask` builds what `routeFor` says for each job (both keys, only one), a stored task choice from before is ignored, the patch schema refuses `tasks`, an export keeps a stored `tasks` as it was.
- **Renderer:** `ai.test.ts` — the targets and `mailDestinations` follow the route (a stray OpenAI key under Ollama isn't named; both keys name both); `ai-summaries.test.tsx` — no provider or model select in any group; `ai-tab` — keys show two key rows and no model field, Ollama shows the model field.
- **e2e:** `ai-settings.spec.ts` (new, or folded into the existing AI settings flows): with Dev mode's Pro AI, keys (a fake key typed into the field; nothing is sent), and a local server: no `ai-model`, no `*-target` row in the first two; the model field present on the local server. The `design-axe` sweep's Settings → AI line stays as it is unless its structure needs another state.
- **Screens on real models** (harness `ai: true`): Settings → AI and Dev mode in Lumen and macOS, light and dark; Settings → AI with only a Claude key on a temp profile (a key-present state from a fake key, never a real one).

## Perf and resources

Nothing new runs. The model discovery request no longer fires for Claude or OpenAI (it listed their models on every visit to the tab), and the per-feature rows' four `ai.listModels` calls go.

## Out of scope

- Pro's own sign-up and its server relay (plan 85): they'll route by this table.
- A stronger OpenAI model for drafting and Ask (the owner's call).
- Choosing a model for a local or custom endpoint: kept, by design.
- Migrating or deleting stored `tasks`.

## Revisions after the Codex review

Codex (read-only, against the redesign branch's head) raised 8 points on this plan, all accepted:

1. **The other key's state.** `ai.keys` said only whether a key was saved, so an unreadable OpenAI key under Claude looked runnable and its row couldn't show the fix. Each entry now carries `keyUnreadable`, `keyConfirmed` and `keyOrigin` (Dev mode's overlay sets them clean), `routeFor` counts a key only when it can be sent (readable, for its endpoint), so a job falls to the other key, and both key rows show the unreadable and moved-endpoint states.
2. **The filter dialog named the stored provider.** `privacyLine` and the filter's error now follow the `filter` route (OpenAI stored, only Claude's key: "Sent to Claude (Anthropic)").
3. **Exports.** Dropping `tasks` from the read shape drops it from an export. Import never read it (`settingsFrom` takes provider, model, endpoint and preset only), so nothing an import could use is lost; the profile itself keeps it.
4. **A key changes routing.** A client being built for OpenAI when Claude's key is saved would have been handed out on the old route, since only the changed secret's lease was revoked. A routing generation, replaced on every key save, removal or confirmation, makes `forTask` start over; a test fails without it.
5. **An optional key bound elsewhere** (a custom endpoint) is dropped by the backend, which runs without it; the readiness check keeps that distinction (tested).
6. **An empty model** on a local server or service reached client construction through the backend. `targetFor` now refuses it with `errors.ai.modelMissing` ("Choose a model in Settings → AI.") before anything is built.
7. **The routing line and JEV.** It adds "Smart categories run on JEV." when JEV has a key; the privacy footer keeps naming relays by host, now for the other key's profile too.
8. **Test connection** sends each saved key with the model drafting would run on there (Sonnet on Claude, Luna on OpenAI), one result per provider when there are two, and drops a late answer after a key or provider change.

Also: Claude or OpenAI chosen with no key yet makes `targetFor` fall back to the stored provider, so the error still says which key to save; the sidebar's cloud pill names where drafting goes (or "Claude or OpenAI" before a key).

## What the Codex code review changed

Round 1 (`git diff 7aa0d0c67..HEAD`, read-only) raised 5 points:

1. **Categorizing's switch named the stored provider** (Claude stored, only OpenAI's key: it said Claude), and an unreadable JEV key was still named. The hint and the switch's availability now come from the `categorize` route. Regression: `categories-ai-hint.test.tsx` (fails on the old code).
2. **A key confirmed for its endpoint left an old test failure on screen.** The test result's identity now includes every key's readable, confirmed and origin state. Regression in `ai-tab.test.tsx`.
3. **Today's gate stayed weaker than the backend for local servers** (an Ollama with no model showed Today and the digest switch). `aiFeaturesAvailable` is now `aiReady` for every provider, as this plan said. Regression in `today.test.ts`.
4. A JEV key's exact-equality expectation in `smart-categorization.test.ts` didn't allow the new key fields; it now matches the fields it means.
5. **Not changed:** a keychain decryption failure other than the Única migration's isn't recorded as `keyUnreadable`, so routing would still prefer that key. That's true of the configured key before this plan too, it needs a keychain that fails after saving, and the backend still refuses with a clear error; it's left for the keychain's own plan (rare finding, per the review-round cap).

Round 2: spec PASS, one point, fixed. **The chosen key removed while it was being read** made the request fail on `keyMissing` though the other key still worked: the routing generation was only checked after a successful build. A build that fails while the routing, the key's lease or Dev mode changed now starts over. Regression in `ai-service.test.ts` (fails without it). Two rounds, per the review-round cap.

## What changes for existing setups

- A task's saved provider and model, and a saved Claude or OpenAI model, are ignored. Nothing is deleted.
- **AI set to Off with an OpenAI key saved** (possible through the old summaries row, which added a key without choosing a provider): summaries stopped before only if the key went; now AI off means off, and they run again once "Claude or OpenAI" is chosen, the key still there.
- **A local model with an OpenAI key saved:** summaries used to go to OpenAI; they now stay on the local model.
- **Only a Claude key:** summaries used to wait for "Use Claude"; they now run on Haiku (open question 2).

## Open questions for the owner

1. **OpenAI on its own:** which model should draft, answer Ask and write filters when OpenAI is the only key? This plan runs everything there on `gpt-6-luna`, as Dev mode already did, because it's the only OpenAI model Terno knows the price of.
2. **Summaries with only a Claude key** now run on Haiku without asking (the switch is on by default since plan 157; the monthly limit still applies). Before, they waited for "Use Claude". Keep?

## The owner's answers (2026-11-09)

1. "for openai only users, drafting runs on sol, others on luna": with only an OpenAI key, drafting (`writing`, `voice`, `reply`) runs on `gpt-6-sol` (`OPENAI_DRAFT_MODEL`), every other job on `gpt-6-luna`. Terno has no price for Sol, so the usage book counts it dear (`UNKNOWN_CLOUD_PRICE`) until one is added to `prices.ts`.
2. Summaries on Haiku with only a Claude key: "yes", as built.
3. "they can use both, if possible use claude sonnet for drafting luna for small things": with both keys (and so Pro and Dev mode's Pro AI), Sonnet drafts and answers Ask, and Luna takes the small jobs (`SMALL_JOBS`: summaries, follow-ups, the digest, Reply ready's check, reading a drafting instruction). Ask's planner stays on Claude Haiku with its answer: plan 141 §6 keeps a question with one company. Filters and categories stay on Opus (JEV with its key). The rating's `PRO_ROUTING` follows, held to `routeFor` by its test; Settings' line now reads "Drafting, Ask your mail and rules run on Claude (Anthropic); summaries, follow-ups and the digest on OpenAI."
4. The pinned Ask card's 12 px over the list at 1440: "keep that".

### Codex review of the owner's routing

1. With both keys Reply ready's check reads the mail on OpenAI while the reply is written on Claude: Settings' Reply ready hint now adds "First, OpenAI reads the sender, subject and newest messages to tell whether a reply is needed." (`helperElsewhere`, tested).
2. ⌘J's reading of what you typed (and of who it's for) goes to OpenAI with both keys: Drafting's note adds a line naming it.
3. Test connection tried OpenAI's key on Sol with both keys, where OpenAI only runs Luna: a key now tests on a model it runs (drafting's first), Sol only when OpenAI drafts.
