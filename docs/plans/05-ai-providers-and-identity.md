# Plan 05: adaptable AI providers, local mode, owner identity

Status: proposed. Scope: `packages/ai`, `packages/backend`, `packages/db` (migration v3), `packages/core/rpc`, `packages/mail` (fetch injection, Gmail `sub`), `apps/desktop` (network backstop), `apps/web` (Settings, first run).

Verified in `/tmp/unica-ai-lab` against `openai@7.43.0` with local stub servers:
- `chat.completions.create` sends `zodResponseFormat(schema, name)` as `{type:"json_schema", json_schema:{name, strict:true, schema}}`.
- `{type:"json_object"}` works.
- `models.list()` paginates `/v1/models`.
- Errors map to these classes: `AuthenticationError` (401), `RateLimitError` (429), `APIConnectionTimeoutError` (timeout) and `LengthFinishReasonError` (from `.parse` only). A refusal comes back as `message.refusal` with `parsed: null`.
- The constructor fails with no key (`apiKey: null` throws "Missing credentials"), so local servers need a placeholder key.
- The constructor falls back to `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID`, so every value must be passed explicitly.
- A custom `fetch` option works. Both SDKs accept one. A policy error thrown inside it becomes `APIConnectionError` with `cause` set to our error, and no socket is opened.
- `diagnostics_channel` `net.client.socket` and `undici:client:beforeConnect` fire on Node 24, so a test can watch every connection.
- `AzureOpenAI` (with `endpoint`, `apiVersion` and `deployment`) and `responses.parse` exist.

---

## A. Adaptable AI

### Decisions
1. **Two wire protocols, many providers.**
   - Anthropic Messages: the existing code, kept as is.
   - OpenAI Chat Completions: one adapter for OpenAI, OpenRouter, Groq, Together, Azure (via `AzureOpenAI`), Ollama, LM Studio and any custom endpoint.
   - We do not use the Responses API. Only OpenAI implements it, and Chat Completions with `json_schema` gives the same structured outputs. One code path is easier to test.
2. **Tasks sit above transports.** Each transport only does `complete()` and can optionally `listModels()`. Tasks (`generateFilter` now, `classify` later) are a prompt plus a zod schema run through one shared fallback ladder. A new provider means no task changes, and a new task means no provider changes.
3. **Capabilities come from two places:** what the provider declares, combined with what *Test connection* actually observes for that base URL and model. We never assume a compatible server supports `json_schema`.
4. **Fallback ladder:**
   - Step 1, `json_schema`. If the server rejects it with a 400 mentioning `response_format`/`json_schema`/`schema`, downgrade for this session, save the downgraded capability, and retry. The retry does not count as a repair attempt.
   - Step 2, `json_object`, with the JSON Schema and one example in the system prompt.
   - Step 3, plain text, then extract JSON: strip `<think>…</think>` and code fences, take the first balanced `{…}`.
   - Every step goes through the same zod parse and `convertWireFilter`. Malformed JSON and wrong shapes now go into the **repair** loop instead of throwing. Repairs: 1 for `json_schema`, 2 for the other steps.
5. **Keys stay in the backend.**
   - Stored as `ai:<provider>[:<preset>]:apiKey`, encrypted with `SecretCipher` (safeStorage on desktop; WebCrypto with a non-extractable AES-GCM key in IndexedDB for the future web host).
   - The renderer only sees `hasKey` and `keyHint`, the last 4 characters, saved when the key is stored.
   - Clients are created per config hash and the SDKs are lazy `import()`ed, so backend boot does not change.
6. **Wire schema stays primitive for strict mode.** zod v4 turns `.int()` into `minimum/maximum`, which some local grammars reject. Use `z.number()` and check for integers in `convertWireFilter`. A snapshot test guards the emitted JSON Schema.

### Interfaces (`packages/ai`)
```ts
export type AiProviderId = "anthropic" | "openai" | "compatible" | "ollama" | "lmstudio" | "fake" | "none";
export type CompatiblePreset = "openrouter" | "groq" | "together" | "azure" | "custom";
export type OutputMode = "json_schema" | "json_object" | "text";

export interface ProviderDescriptor {            // static registry entry, also sent to the UI
  id: AiProviderId; label: string;
  locality: "local" | "cloud" | "by-url";        // compatible = by-url (loopback ⇒ local)
  needsKey: boolean; defaultBaseURL?: string; presets?: CompatiblePreset[];
  declared: { output: OutputMode; embeddings: boolean };
  discovery: "openai" | "ollama" | "lmstudio" | "none";
}
export interface Capabilities { output: OutputMode; contextTokens: number | null; embeddings: boolean; probedAt: number | null }
export interface ModelInfo { id: string; label?: string; contextTokens?: number; sizeBytes?: number; loaded?: boolean }

export interface ProviderConfig {
  id: AiProviderId; model: string; baseURL?: string; preset?: CompatiblePreset;
  apiKey: string | null; capabilities?: Capabilities;
  fetch: typeof fetch;                           // ALWAYS the network-policy fetch (see Local mode)
  timeoutMs: number; maxRetries: number;
}

export interface ModelTransport {                // anthropic.ts, openai-chat.ts, fake.ts
  complete(req: { system: string; messages: ChatMsg[]; output: OutputMode; schema?: { name: string; zod: z.ZodType };
                  maxTokens: number; signal: AbortSignal }): Promise<{ text: string; stop: "end" | "length" | "refusal" }>;
  listModels?(signal: AbortSignal): Promise<ModelInfo[]>;
}

export interface AiTasks {                       // what backend handlers use
  readonly providerId: AiProviderId; readonly local: boolean;
  generateFilter(prompt: string, ctx: FilterGenerationContext, signal?: AbortSignal): Promise<GeneratedFilter>;
  classify<L extends string>(input: { items: { id: string; text: string }[]; labels: readonly L[]; instructions: string },
                             signal?: AbortSignal): Promise<{ id: string; label: L | null; confidence: number }[]>;
  embed?: (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>; // declared only; built with the categorization agent
}
export function createAi(config: ProviderConfig): AiTasks;
export function discoverModels(config: ProviderConfig, signal: AbortSignal): Promise<ModelInfo[]>;
export function probe(config: ProviderConfig, signal: AbortSignal): Promise<{ latencyMs: number; capabilities: Capabilities }>;

export class AiError extends Error {             // kinds added: timeout, blocked, not_configured, unsupported
  kind: "invalid_output" | "refused" | "auth" | "rate_limited" | "unavailable" | "timeout" | "blocked" | "not_configured" | "unsupported";
}
```
**How the OpenAI-compatible adapter builds its client and reads errors:**
- Construction: `new OpenAI({ apiKey: key ?? "local", baseURL, organization: null, project: null, fetch, timeout, maxRetries })`.
- Azure uses `AzureOpenAI({ endpoint, apiKey, apiVersion, deployment })`.
- OpenRouter gets `HTTP-Referer` and `X-Title` headers.
- Model discovery:
  - Ollama: `GET /api/tags`, plus `POST /api/show` for the `*.context_length` of the selected model.
  - LM Studio: `GET /api/v0/models` (`max_context_length`, `state`), falling back to `/v1/models`.
  - Others: `/v1/models`.
- Error mapping:
  - 401/403 → `auth`
  - 429 → `rate_limited`
  - `APIConnectionTimeoutError` → `timeout`
  - `APIConnectionError` whose `cause` is a `NetworkPolicyError` → `blocked`
  - `ECONNREFUSED` on a local provider → `unavailable` with the hint "Is Ollama running?"
  - `message.refusal` → `refused`
  - `finish_reason:"length"` → `invalid_output`

Prompt budget: the filter prompt plus schema is about 1.5k tokens. If `contextTokens < estimate + maxTokens`, Test connection shows a warning. Ollama's OpenAI API cannot set `num_ctx`.

### Settings, RPC, migration
`AppSettings` replaces `aiProvider`, `aiModel` and `hasAiKey` with:
```ts
localMode: boolean;
ai: { provider: AiProviderId; model: string; baseURL: string | null; preset: CompatiblePreset | null;
      hasKey: boolean; keyHint: string | null; local: boolean; capabilities: Capabilities | null;
      profiles: Partial<Record<AiProviderId, { model: string; baseURL?: string; preset?: CompatiblePreset }>> };
```
Each provider keeps its own profile, so switching back and forth keeps each model and URL. `readSettings` maps old stored `aiProvider/aiModel` values into the new shape.

New RPCs (renderer only; not added to `MCP_ALLOWED`):
- `ai.providers()` → `ProviderDescriptor[]`
- `ai.listModels({provider, baseURL?, preset?})` → `{ models, tookMs }`. Timeout 3 s local, 8 s cloud; cached for 60 s.
- `ai.test({provider, model, baseURL?, preset?})` → `{ ok, latencyMs, capabilities?, error?: {kind, message} }`. Runs a tiny structured probe and saves the capabilities.
- `ai.setKey({provider, preset?, value})`. An empty value deletes the key. `settings.setSecret` keeps only `gmailClientSecret`.
- `settings.update` accepts `{ localMode?, ai?: {...} }` and returns `BAD_REQUEST` if it would select a cloud provider while `localMode` is on.
- AI failures become `RpcError("UNAVAILABLE", msg, { aiErrorKind })` so the UI can give help specific to the error.

Migration v3 (SQL) renames the secret: `UPDATE secrets SET name='ai:anthropic:apiKey' WHERE name='anthropicApiKey'`.

### Settings UI (tab "IA")
1. **Local mode** banner (when on): "Modo local: la IA solo puede usar modelos de este Mac."
2. **Provider** select, grouped:
   - *En este Mac*: Ollama, LM Studio, Servidor local (custom).
   - *En la nube*: Claude (Anthropic), OpenAI, Compatible con OpenAI (OpenRouter, Groq, Together, Azure, Personalizado).
   - *Desactivada*.
   - Cloud entries are disabled in local mode, with the hint "Desactiva el modo local para usar la nube". *Demo sin conexión* only appears in dev/demo builds.
3. **Endpoint**: shown for compatible and local providers, pre-filled (`http://127.0.0.1:11434/v1`, `http://127.0.0.1:1234/v1`). Validated inline; in local mode it must resolve to loopback.
4. **API key**: password field and *Guardar*. Once saved it shows "Guardada · …a1b2" and *Quitar*. The field is never pre-filled.
5. **Model** combobox with the discovered models (size, context, loaded state), a refresh button, and free text allowed. If Ollama is not reachable, show inline: "No encontramos Ollama en 127.0.0.1:11434".
6. **Probar conexión**: "Conectado · 412 ms · salida estructurada ✓ / modo JSON / texto", or the error with help for that error kind.
7. **Privacidad** box for the current provider, with the exact host. For filters, the data sent is: your description, account emails and names, category names, and today's date, **never message content**. Local providers show "Nada sale de este Mac." The same one-line notice repeats in the AI filter builder, next to *Generar*.

### Performance
- AI never runs on the interactive path:
  - Calls are async network I/O, with nothing synchronous in the backend.
  - There are no probes at boot. Discovery only runs when the AI tab opens, or when the endpoint or provider changes (debounced 400 ms).
- Deadline per `filters.generate`: 100 s total, shared by downgrades and repairs, below the 120 s RPC timeout.
  - Cloud: 30 s per request, `maxRetries: 1`.
  - Local: 90 s per request (the first call loads the model), `maxRetries: 0`.
- A new `filters.generate` from the same client aborts the previous one (an `AbortController` map, like `searchSeq`). `b.abort` also aborts it on shutdown.
- Future `classify` over incoming mail:
  - Runs in a background queue (concurrency 1 for local models), outside ingest transactions, and applies results through the existing ops path.
  - It sends headers and snippets, so it gets its own privacy notice and opt-in.

---

## B. Local mode

**Guarantee:** while it is on, the app opens no connection except:
- to the user's mail servers: IMAP/SMTP hosts from the account config, and Gmail's OAuth/API hosts;
- to loopback (local AI, backend-dev, the MCP unix socket).

Links the user clicks still open in the system browser. That is an explicit user action outside the app.

**One central policy** lives in `packages/backend/src/net-policy.ts`:
```ts
type Purpose = "mail" | "ai" | "remote-content" | "telemetry" | "update" | "cloud";
interface NetworkPolicy {
  assert(purpose: Purpose, url: string | URL, meta?: { providerLocality?: "local" | "cloud" }): Promise<{ pinnedHost?: string }>;
  fetchFor(purpose: Purpose, meta?): typeof fetch;   // assert + pin resolved loopback IP, then fetch
}
```
- `mail` is always allowed.
- `ai` in local mode is allowed only if the provider is local **and** the host is `localhost`, a loopback literal, or resolves (`dns.lookup all`) only to `127.0.0.0/8` or `::1`. The request then goes to the **resolved IP**, which prevents DNS rebinding. Prototyped: LAN and remote hosts are rejected with zero connections.
- `remote-content`, `telemetry`, `update` and `cloud` are denied.

**How it is enforced:**
1. Every outbound call path goes through the policy:
   - `createAi` requires `fetch: policy.fetchFor("ai")`, and `Backend.ai()` calls `assert` first so the error is fast and clear instead of an SDK retry.
   - `packages/mail` Gmail takes an injected `fetch` (`fetchFor("mail")`).
   - Future updater, telemetry and cloud identity clients must take `fetchFor`.
2. An **architecture test** scans non-test sources for `fetch(`, `new OpenAI(`, `new Anthropic(`, `http(s).request`, `net/tls.connect` and `net.fetch`. Hits are allowed only in an allowlist: `net-policy.ts`, imapflow/nodemailer use with account hosts, and main's `app://` file handler.
3. **Renderer backstop:**
   - The backend tells main `{type:"policy", localMode}` at startup and whenever it changes.
   - Main sets `session.defaultSession.webRequest.onBeforeRequest` to cancel `http(s)/ws(s)` to anything except loopback (needed in dev).
   - The mail iframe always gets `csp(false)`, and the "show images" button is hidden. *Superseded by plan 37: remote images load in local mode too when the user asks (per message, or with the setting); main lets only images from a mail frame through.*
4. Turning local mode on keeps the cloud AI config dormant. AI reports "en pausa por el modo local" and turning local mode off restores it. Turning local mode off needs a confirmation that lists what becomes allowed.

**Indicator:** a "Local" pill (laptop-shield icon) in the sidebar footer. Tooltip: "Nada sale de este Mac salvo el correo con tus servidores". Clicking it opens General, where the **first row** is the switch. When local mode is off and a cloud AI is active, the pill reads "IA: OpenAI (nube)".

**Defaults:**
- **New installs: local mode on.** This matches the "local-first" promise. Cloud AI is a deliberate opt-in, and the onboarding choice preselects *Local (recomendado)*.
- Onboarding probes `127.0.0.1:11434` and `:1234`. If it finds a server it offers one model, e.g. "Encontramos Ollama con qwen3:8b".
- **Existing installs**: migration v3 writes `localMode:false` if there are accounts or settings, so behavior does not change silently. A one-time tip offers to turn it on.

**Offline identity:** owner assignment and verification are local and only talk to the user's mail servers. A future sign-in or billing check uses `cloud`. It is denied in local mode and never blocks the app; entitlement will be a cached signed token with a grace period.

---

## C. Owner identity

### Decisions
- The **first verified, non-demo account** becomes the owner.
  - Verified means: Gmail completed OAuth (`google_oauth`), or the IMAP account passed a live login (`imap_login`).
  - The owner is claimed in the same transaction as `createAccount` with `INSERT OR IGNORE` on a singleton row. This makes it race-free across windows, since everything goes through the single-writer backend.
  - `addImap` with `verify:false` never claims. The demo registry's no-op `verifyImap` never claims either (`registry.kind === "demo"`). A backend-dev test flag allows claims for E2E.
- The owner is **separate from mailboxes**. Removing that mailbox sets `account_id` to NULL and nothing else: the owner keeps the same email and the UI explains this.
- **Change owner** works like this:
  - The target must be a connected account, and it must be **re-verified now**. Gmail runs OAuth again with `login_hint`; the returned email must match. IMAP asks for the password again and does a live `verifyImap`. The stored password does not count.
  - `user_id` stays the same, and the previous owner goes to `owner_history`.
  - A future cloud service will also confirm the change by email to the old address.
- **Evidence:** Gmail stores `sub` and `email_verified`. `connectGmail` already calls userinfo; we just keep these fields. IMAP stores `{imapHost, loginUser, emailMatchesLogin}`, because an IMAP login does not prove the address.

### Schema (migration v3)
```sql
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,                 -- stable local id (uuid); future cloud links to it
  email TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL CHECK (provider IN ('gmail','imap')),
  verified_by TEXT NOT NULL CHECK (verified_by IN ('google_oauth','imap_login')),
  evidence_json TEXT NOT NULL DEFAULT '{}',   -- {googleSub, emailVerified} | {imapHost, loginUser, emailMatchesLogin} | {migrated:true}
  verified_at INTEGER, account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  cloud_json TEXT,                       -- reserved: remote user id, last sync
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE owner_history (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, email TEXT NOT NULL, provider TEXT NOT NULL,
  verified_by TEXT NOT NULL, evidence_json TEXT NOT NULL, verified_at INTEGER, replaced_at INTEGER NOT NULL, reason TEXT NOT NULL);
INSERT INTO owner (id,user_id,email,display_name,provider,verified_by,evidence_json,verified_at,account_id,created_at,updated_at)
  SELECT 1, lower(hex(randomblob(4))||'-'||hex(randomblob(2))||'-4'||substr(hex(randomblob(2)),2)||'-'||hex(randomblob(2))||'-'||hex(randomblob(6))),
         email, display_name, kind, CASE kind WHEN 'gmail' THEN 'google_oauth' ELSE 'imap_login' END,
         '{"migrated":true}', created_at, id, created_at, created_at
  FROM accounts WHERE coalesce(json_extract(provider_config,'$.demo'),0) = 0
  ORDER BY created_at, id LIMIT 1;
```
The same migration also renames the AI secret and adds the existing-install `localMode:false` setting.

### RPC and types
```ts
export interface OwnerIdentity { userId: string; email: string; displayName: string; provider: "gmail" | "imap";
  verifiedBy: "google_oauth" | "imap_login"; verifiedAt: number | null; migrated: boolean;
  accountId: number | null; createdAt: number; updatedAt: number }
```
- `Bootstrap.owner: OwnerIdentity | null`
- `identity.get`
- `identity.changeOwner({ accountId, password? })`, with timeout 300 s
- event `owner`

None of these are available to MCP. Evidence details stay in the backend.

### UI
- **Cuentas tab, top card:** "Tu cuenta de Terno: x@y.com — se usa para iniciar sesión y para la facturación. Verificada con Google · 22 oct 2026 · [Cambiar…]".
  - With no owner: "Tu cuenta de Terno será el primer correo que conectes."
  - In demo mode: "Modo demo: sin cuenta de Terno."
- **Removing the owner's mailbox:** the confirm says "Seguirá siendo tu cuenta de Terno; cámbiala en Cambiar…".
- **Add-account dialog** (only while there is no owner): "El primer correo que conectes será tu cuenta de Terno: con él iniciarás sesión y te facturaremos."
- **First run** (fresh install, no accounts, not demo) has two steps: (1) Local vs Connected, (2) Add account, with the owner copy.
- The **web client** later uses the same RPC. On a hosted backend, local mode shows as "solo en escritorio".

---

## Test plan
**`packages/ai`:** one contract suite, `describeProviderContract()`, runs against local stub HTTP servers for anthropic, openai, compatible (OpenRouter headers), azure (`api-key` header, deployment path), ollama and lmstudio. It covers:
- **Request shape:** path, auth header, no user key sent to local servers, `model`, `response_format.json_schema.{name,strict}`, and the system prompt containing the categories.
- **Parsing:** the structured response parses into a valid `GeneratedFilter`, and the repair turn carries the validation error.
- **Error kinds:**
  - 401 → `auth`
  - 429 (`retry-after: 0`) → `rate_limited`
  - a hanging stub with `timeoutMs: 200` → `timeout`
  - refusal → `refused`
  - `length` → `invalid_output`
  - abort → rejects quickly
- **Fallback ladder:**
  - a 400 "json_schema unsupported" leads to `json_object` with the schema in the system prompt;
  - text mode handles `<think>` and code fences;
  - malformed JSON goes to repair.
- **Discovery:**
  - `/api/tags` + `/api/show` context;
  - LM Studio `/api/v0` falling back to `/v1/models` on 404;
  - `ECONNREFUSED` → `unavailable` in under 100 ms.
- **Schema:** a snapshot of the emitted JSON Schema.

**Local mode (backend):**
- With local mode on, generating with `openai` or `anthropic` pointed at a stub fails with `blocked`. The stub records **0 connections**, and a `diagnostics_channel` sentinel sees no connects.
- A compatible provider whose host the injected `lookup` resolves to `10.0.0.5` is blocked. One that resolves to `127.0.0.1` is allowed, and the request goes to the IP.
- An Ollama stub on `localhost` works.
- `telemetry`, `cloud` and `remote-content` are denied.
- `settings.update` selecting a cloud provider → `BAD_REQUEST`.
- The architecture scan test.
- Main's webRequest filter, in the packaged smoke test: with local mode on, a remote `<img>` is cancelled.

**Keys:**
- `ai.setKey` stores the key through the cipher.
- `JSON.stringify(bootstrap)` and every `settings.*` result never contain the key.
- The `anthropicApiKey` secret is migrated.

**Identity:**
- Migration from a v2 fixture: picks the earliest non-demo account, skips demo-only DBs, leaves no row when there are no accounts, and has `migrated:true`.
- Claims:
  - the first `addImap` claims the owner and the second does not;
  - `verify:false` and the demo registry never claim;
  - a fake-Google `connectGmail` stores `sub`;
  - two `addImap` calls in `Promise.all` leave exactly one owner.
- Removal: the owner stays and `accountId` becomes null.
- `changeOwner`: a wrong password or a mismatched Gmail email leaves the owner unchanged; success writes a history row and keeps `userId`.
- RPC: `bootstrap.owner` is present and MCP gets `FORBIDDEN`.

**Playwright (backend-dev):**
- AI tab: pick Ollama, see the models from a stub, Test shows latency, cloud options are disabled in local mode.
- Local pill and General switch, with the confirm when turning it off.
- Add account, then the owner card appears; remove that mailbox and the owner card is still there.
- First-run steps.
- Screenshots in light and dark.

## Risks
- **Weak local models.** Mitigated by the ladder, the repairs and the mandatory preview in the visual builder. The copy recommends instruct models of 7B or more. A manual eval script against real Ollama/LM Studio (neither was running here, so `/api/show` and `/api/v0` shapes still need checking on real servers).
- **Strict-schema drift** across servers and zod upgrades. Mitigated by the snapshot test and the downgrade on 400.
- **Leaking environment variables and SDK retries** that wrap policy errors. Mitigated by explicit options, a preflight `assert`, and mapping by `cause`.
- **Unauthenticated local ports:** any local process can pose as Ollama. Accepted, and documented.
- **The migrated owner may be a work mailbox.** The `migrated` flag lets the cloud ask for confirmation later, and *Cambiar…* exists.
- **IMAP login does not prove the address.** Recorded as `emailMatchesLogin`. The cloud will confirm by email before billing.
- **Bundle size:** the `openai` SDK adds weight to the backend only, never the renderer. It is lazy-imported, and boot is measured in the smoke test.

## Ordered checklist
1. db v3 migration (owner, owner_history, secret rename, `localMode` for existing installs) and its tests.
2. `net-policy.ts`, local-mode settings, the architecture test, and fetch injection into Gmail.
3. `packages/ai` refactor: `ModelTransport`, ladder, repair on parse errors, `AiError` kinds. Anthropic and Fake ported, existing tests green. `classify` built on the ladder: about 30 lines and one test.
4. OpenAI-compatible transport (OpenAI, presets, Azure, Ollama, LM Studio), discovery, probe, and the contract suite.
5. Backend: `ai()` built from profiles and the policy, `ai.*` RPCs, abort-previous, deadlines, `RpcError` details.
6. Identity: claim in `addImap`/`connectGmail`, Gmail `sub`, removal semantics, `identity.*` RPCs and event, `changeOwner`.
7. Desktop: policy message to main, webRequest backstop, CSP in the iframe.
8. Web: AI tab redesign, General local-mode switch and pill, owner card, add-account copy, first run.
9. Playwright flows and visuals, plus a smoke-test assertion for local mode.
10. Update docs/PLAN.md §1/§7/§11 and the README (AI providers, local mode).
11. Later, with the categorization agent: `embed` (OpenAI, Ollama and LM Studio `/v1/embeddings`), a background classify queue, and its own privacy opt-in.

## W10 B39: qualify model-selected targets

### Request (verbatim excerpt)

“Determine actual Terno model task(s), offered categories/rules, outputvalidation and persistence boundary before expanding scope.” “Unknown model output should not silently become confidence no-match/success, but normal valid no-match/valid lowconfidence and mixedvalid outputs need their actual existing contract preserved.”

### Current behavior and B39 adaptation

The foreign `ai-choose-rule` architecture is N/A: Terno does not offer existing rule names to a model or mark mail handled from a model's rule selection. `AiAssist` offers category **names** from the uncertain classifier band and may persist only a suggestion, never an automatic filing. `createAi.classify` enforces the offered labels and item IDs through the structured repair ladder; null and low confidence are legitimate non-decisions. The contract is one label per item, so foreign mixed-rule retention is not applicable: an invalid batch is repaired/rejected as a whole. `generateFilter` creates a new user-reviewed filter; its name is user-facing copy, not a selected rule identity. `convertWireFilter` validates category/account IDs against the offered context. `filters.generate` does not save or apply it. `filters.save` persists the DSL, and `filters.apply` claims applications and actions in store transactions. Investigate/protect that actual boundary; do not invent a mail-handled flag.

Two gaps within the owned AI modules: a failed assist attempt remains in the in-memory `seen` set and cannot be explicitly enqueued again in this session; generation validates the pre-await context and can return a now-deleted category target as success. Neither is proof of the foreign false-handled bug.

### Design, tests, performance and exclusions

On assist failure, release only its once-per-thread admission so a later explicit enqueue can retry; do not schedule new retries, poll, or change valid null/low-confidence behavior. Keep diagnostic text independent of model strings at this boundary. After filter generation, recheck referenced categories against current categories and reject a deleted target with typed `invalid_output` using existing localized copy. Preserve all actions or reject the filter; never remove an invalid action to manufacture empty success.

Use deterministic structured AI transport and synthetic temp Backend stores. Fail-first regressions: malformed claimed label can be retried to a persisted suggestion; category deletion while generation waits rejects. Protection: invented/all-invalid/mixed label batches reject, null/low confidence stay non-decisions, valid generated actions survive save/apply, and deletion after generation cannot commit application claims or hits. Verify actual store effects, including retry where meaningful; add no observer-only proof. If that last boundary exposes a store defect, commit the unmarked reproducer and defer minimal store scope to Root rather than change hot files.

Run changed/direct-caller test files and touched-package typechecks plus file-scoped lint. This is off the ingestion hot path and adds no idle work/network/cache; no perf gates, UI changes, app builds or release-wide suites. No core/store/schema/repository, transport, Gmail, SMTP, MIME or root-owned worklist edits. Native Codex read-only plan critique, then at most two Standards+Spec code review rounds; record outcomes below.

### Revisions after the Codex review

Native read-only plan critique completed (9 concrete points). The retry regression will exhaust structured repairs, then call enqueue again; no user retry UI is implied. Scope is the classify/persistence catch only: configuration-stop/discarded-queue admission remains deferred, as does duplicate result-ID validation (current Map uses last result). Valid label/null/low-confidence mixtures retain the current batch contract. Generation will read current categories once, check every action synchronously and preserve cancellation over the extra await. Account-condition deletion is deferred; this slice concerns category actions. Reuse `errors.categoryGone` without interpolated model text. Save may accept stale drafts; qualify store safety per transaction/chunk, using a prior markRead action to prove rollback. Focused SQL and IndexedDB Backend tests will reopen and verify state/hits and retry behavior; assist tests use real task validation, exhausted repair responses and a private sentinel in captured log arguments. No store defect is assumed.

### Implementation and scoped evidence

Implemented admission release only for classify/persistence failures; ordinary valid null/low-confidence results remain once-per-thread. Failure logs carry only `aiKind`, never model-derived error text. Generation rechecks category-action IDs against one current category snapshot and checks supersession/shutdown cancellation before returning. Added the dedicated IDB test file to the existing backend DOM-enabled lifecycle typecheck partition; production typechecking retains its current libraries.

Before production edits, the corrected focused regression run reported **4 failed / 12 passed / 28 skipped**: two category-deletion races returned success, and invalid label/ID attempts could not run again. A separate fail-first run also proved the synthetic private ID leaked through log arguments. An initial draft test incorrectly expected `lastAppliedAt` in the public Filter DTO; that harness mistake was fixed before recording RED counts, using physical synthetic-store claim/timestamp reads instead. Store rollback, invented/all-invalid/mixed category actions and valid effects were protection tests, not claimed RED bugs. Final current run: `pnpm exec vitest run --project unit packages/backend/src/ai-filter-output.test.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-backend.test.ts packages/ai/src/ai.test.ts` — **4 files, 82 tests passed**. `pnpm --filter @terno/backend typecheck` (both configured projects), file-scoped `pnpm exec oxlint --deny-warnings` on the four changed TS files, and `git diff --check` pass. No UI/hot-path/release-wide gates ran, per task scope.

B39 qualification: no foreign rule selector/handled ledger exists. Actual unknown targets fail structured validation; malformed mixed actions are not partially accepted. Valid generated action mixtures save/apply once. Deletion after generation may still save a stale draft, but SQL and IndexedDB apply transactions roll back earlier markRead, ops, category membership, claims, hits and application timestamp, including after reopen; a repaired filter can apply. Claims are scoped per chunk, not whole bulk application. There is no new durable AI retry queue: a failed suggestion remains undecided in the store and can run on a subsequent caller enqueue (or a fresh session). Existing configuration-stop queue admission, duplicate classification IDs and account-condition freshness remain deferred. No hot store changes or deferred store reproducer are required by observed cases.

### Native Standards + Spec code review and final handoff

Code round **R1** reviewed `05336e17..e0b5f44f` with `codex exec -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-0f8e2ccf -m gpt-6.1-sol -c model_reasoning_effort='"high"'`: **PASS, no Standards or Spec findings, no high-severity blockers**. The reviewer independently reran backend typecheck and diff-check; it inspected runtime regressions without rerunning them. No review fixes or second code round were needed. Plan critique was separate. Existing deferred backlog: configuration-stop/discarded-queue admission, duplicate classification result IDs, account-condition freshness. None is claimed fixed or newly introduced here.

Exact final validation commands (all pass):

- `pnpm install --offline --frozen-lockfile --ignore-scripts` — locked dependencies, zero downloads; no install scripts.
- `pnpm exec vitest run --project unit packages/backend/src/ai-filter-output.test.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-backend.test.ts packages/ai/src/ai.test.ts` — **82 passed / 4 files** (18 new cases: 4 assist, 14 filter; no skipped tests in this final run).
- `pnpm --filter @terno/backend typecheck` — both configured TypeScript projects passed. The initial missing-DOM failure from adding IDB tests was resolved by using the existing lifecycle partition.
- `pnpm exec oxlint --deny-warnings packages/backend/src/ai-assist.ts packages/backend/src/ai-service.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-filter-output.test.ts` — passed.
- `git diff --check` — passed.

No main checkout access, fetch, push, worklist edits, hot-file changes, user baseline-file access, UI work, polling, new network calls, app builds or broad suites. Temporary synthetic stores were cleaned by test teardown. This section's final follow-up commit records review/validation only.

## W10 follow-up: classification result identities

### Request (verbatim excerpt)

“Implement the finite duplicate-classification-result-ID follow-up recorded in Plan05 and the provider worklist, using this isolated worktree from local main837ba05f.” “Establish the actual supported batch contract before deciding whether duplicate, missing or extraneous IDs must be rejected/repaired. An invalid claimed result must not silently lose another input, be recorded as a legitimate no-decision, or cross-wire labels to a different message. Preserve valid one-result-per-item/null/low-confidence and legitimate batch semantics; don't change user expectations to accept malformed output.”

### Current contract, design and failure map

`ClassifyInput` accepts a batch; `createAi.classify` validates the shape and offered labels, then returns results in input order with confidence clamped to [0, 1]. Missing/unknown result IDs invalidate the entire response and enter the existing repair ladder. The fake provider returns one result per item. The sole production caller, `AiAssist`, sends one item and consumes the first validated result; valid null/low confidence is a once-per-thread non-decision. Its W10 failure catch releases admission for a later explicit enqueue and logs only `aiKind`. No partial batch acceptance is supported.

The Map currently overwrites duplicate result IDs. Conflicting duplicates can manufacture a null/low-confidence success or a suggestion, even with every requested ID present. Require a bijection: each distinct input ID exactly once, no others. Keep response reordering, opaque string IDs, confidence clamping, mixed labels/null/low-confidence and empty batches. Reject ambiguous duplicate **input** IDs locally before transport, rather than invent positional semantics for repeated identities. Build an input Set and result Map in linear time; reject duplicate/unknown/missing IDs with constant, private-data-free domain errors and preserve the existing bounded repair budget. Do not change wire-schema vocabulary, transports or repair counts.

### Tests, performance and exclusions

Before fixing production, exercise deterministic synthetic replies through real `createAi` structured validation: duplicate-only, conflicting/identical duplicates with full coverage, missing/extraneous/mixed-invalid responses, safe errors/repair feedback, reordered valid batches, null/low confidence, empty batches, duplicate inputs and all three output modes' repair limits. Extend AI-only cases in `categorize.test.ts` to prove exhausted duplicates leave no store decision/category effect and permit an explicit enqueue to persist one suggestion. Preserve W10 filter/retry regressions by running direct caller files.

Only changed/direct-caller tests, AI/backend package types and scoped lint; no UI or hot path changes, so no screenshots, perf, app builds or broad suites. No polling, durable retries, extra traffic beyond existing repairs, configuration-stop admission or account-condition freshness work. No BackendCore, handlers, core/store/schema/repository/provider/UI/i18n changes; no worklist/main or user baseline-file access. Native read-only plan critique is separate from at most two Standards+Spec code rounds; after R2 only high-severity correctness/data-loss fixes, lower findings backlogged, no R3.

### Revisions after the Codex review

Native read-only plan critique: no blockers; three test clarifications adopted. Prove successful repair to a reordered batch in the same call as well as exhaustion at exactly 2/3/3 completions for json_schema/json_object/text; duplicate input IDs use zero completions. Actual-store cases cover a last duplicate that is null, low confidence or a confident claim, and verify eligibility, queue and one persisted suggestion after explicit enqueue. Privacy assertions cover generated identity-error detail in repair feedback/terminal errors and sanitized backend logs; the prompt and prior assistant response intentionally remain in the provider's repair conversation. Reject wrong result counts before scanning identities, then check membership/uniqueness with Sets/Maps within the input batch size.

### RED evidence

Before production edits, `pnpm exec vitest run --project unit packages/ai/src/ai.test.ts packages/backend/src/categorize.test.ts`: **17 failed / 53 passed / 2 files**, no skips. Real structured tasks accepted full-coverage and single-item duplicates, accepted ambiguous duplicate inputs, and exposed synthetic IDs in existing missing/unknown-ID feedback. The actual Backend/SQLite cases proved false suggestions for duplicate claims/identical results, plus suppressed explicit retries for all four duplicate variants. Protection cases already passed for valid reordered label/null/low-confidence batches, opaque IDs and empty batches. Output captured in `/tmp/terno-classification-review.6oNJx4/red.log`; a second pre-fix run with soft initial store assertions retained the same test counts and exposed the false persisted suggestions directly.

### Implementation and scoped GREEN

`createAi.classify` rejects duplicate caller IDs before transport. After normal structured shape validation, a count gate and one Set/Map pass enforce complete, unique, known result identities before returning any result. All identity failures feed the existing whole-response repair ladder with constant detail; no private IDs/text enter these errors. The prompt and public AI interface now state the identity contract. Wire schema, tokens/deadlines, repair limits, confidence clamping, null/low-confidence behavior and `AiAssist` production code are unchanged. Real Backend/SQLite regressions prove no malformed suggestion/category effect and one suggestion after a later explicit enqueue. No shared hot-file dependency was exposed.

Validation before code review (all pass):

- Locked `pnpm install --offline --frozen-lockfile --ignore-scripts`: 728 reused, zero downloads, no scripts.
- The same two RED files: **70/70 passed**, no skips, after the minimal fix.
- `pnpm exec vitest run --project unit packages/ai/src/ai.test.ts packages/ai/src/contract.test.ts packages/ai/src/browser.test.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-backend.test.ts packages/backend/src/ai-filter-output.test.ts --reporter=verbose`: **174/174 passed / 6 files**, no skips. Includes SQL/IDB stale-category regression coverage from W10. Log: `/tmp/terno-classification-review.6oNJx4/scoped-tests.log`.
- `pnpm --filter @terno/ai typecheck`; `pnpm --filter @terno/backend typecheck` (both projects): passed.
- `pnpm exec oxlint --deny-warnings packages/ai/src/tasks.ts packages/ai/src/types.ts packages/ai/src/ai.test.ts packages/backend/src/categorize.test.ts`; `git diff --check`: passed.

Contract limits: classification batches are all-or-error, and IDs identify distinct input items; duplicate input identities have no supported positional meaning. Empty batches still require valid labels and preserve the existing structured call. Domain identity validation is linear and bounded by the input count after the count gate; shared JSON/Zod parsing still processes the provider's response as before. General parser/transport diagnostics and arbitrary custom `AiTasks` implementations are outside this identity follow-up. No provider traffic beyond the existing repair ladder, autonomous retry, UI, ingestion/perf changes or broad gates.

### Native code review and handoff

Actual native **R1**, `codex exec -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-13aa3eb3 -m gpt-6.1-sol -c model_reasoning_effort='"high"'`, reviewed `837ba05f..7acc2507`: **Standards PASS / Spec PASS, no actionable findings or high-severity blockers**. Reviewer independently reran scoped lint and diff-check and inspected RED/GREEN logs and actual store assertions; it did not rerun runtime suites. No review fixes or R2 were needed. Plan critique was separate. Review artifacts: `/tmp/terno-classification-review.6oNJx4/{plan-review,code-r1}.txt`.

Final scoped count by file: AI `ai.test.ts` **34**, `contract.test.ts` **67**, `browser.test.ts` **6**; backend `categorize.test.ts` **36**, `ai-backend.test.ts` **17**, `ai-filter-output.test.ts` **14**. Total **174 passed**, zero failures/skips. AI/backend types, touched-file lint and whitespace checks pass. Scope remains five files; no hot shared-file serial dependency. Existing configuration-stop/discarded-queue admission and account-condition freshness remain backlogged, with no new lower-severity review findings. Root owns rebasing, rerunning, landing and the separate provider-worklist update; nothing fetched, pushed or landed here.


## W10 follow-up: assist readiness and account freshness

### Request and current contract

“Finish the two finite AI readiness/freshness follow-ups recorded in Plan05” from local `0753129b`: release configuration-stop/discarded-queue admission for later explicit enqueue; revalidate generated account conditions after model work. Preserve landed actual-AI and classification identity contracts.

`AiAssist.seen` currently combines queued/in-flight admission and once-per-thread completed work. Disabling categorization or failed `host.ai()` preparation drops the queue without releasing its IDs; preparation also consumes the 20/minute task budget and logs arbitrary error text. `stop()` is a shutdown boundary, distinct from configuration refusal. Generated DSL conditions are a flat bounded (1–20) array, `all`/`any`, with per-leaf negation, account identity in numeric `value`; no nested tree exists. Structured conversion already rejects unknown accounts against offered context. Category freshness and cancellation already have post-model guards.

### Design and failure map

Release the current discarded ID and queued unfinished IDs on configuration refusal/disable; retain completed valid null/low-confidence admission and in-flight deduplication. Explicit enqueue is the only restart after settings repair; no retries or settings watcher. Make shutdown terminal across pending awaits, clear its timer, and guard before starting model work or persisting. Count task attempts only after preparation succeeds, retaining 20/minute and failed-task explicit retry; use only safe error kind metadata in configuration logs. Recheck user choice after preparation before making a task call.

Read accounts once after generation alongside the existing current-category guard, reject any referenced missing account with existing localized `errors.accountGone`/typed `invalid_output`; preserve every valid condition/action and cancellation across added awaits. This is a draft boundary, not atomic validity after return, and no retry-until-stable or new store API is proposed.

### Tests, performance and scope

Fail first through real structured tasks and temp Backend effects: not-configured/local-mode refusal then explicit repaired enqueue; disabled queue discard; synthetic private configuration error log arguments; refused preparation versus 20 actual task attempts; disable/shutdown during preparation and in-flight deduplication. Keep valid null/low-confidence once-per-thread, failed structured repair retry, strict identity budgets and suggestion-only behavior. SQL/IndexedDB generation races delete referenced/negated account while awaiting provider and assert typed/localized rejection without saving/effects; valid all/any mixed/negated leaves preserve save/apply/no-match, unrelated deletion stays valid, cancellation survives the fresh-account await. Nested input is unsupported and remains existing validation behavior.

Only `ai-assist.ts`, `ai-service.ts`, AI-only direct tests and this section. Scoped tests, backend/AI types, touched-file lint and diff-check; no ingestion hot path/perf, UI, full suites or production builds. No core/handlers/store/schema/repos/transports/i18n, main/worklist or user baseline-file access. Native read-only plan critique separate from at most two Standards+Spec code rounds; R1 fixes require failing regressions, after R2 only high-severity correctness/data-loss fixes. Atomic commits, no push/landing.

### Revisions after the Codex review

Native read-only plan critique completed with 11 concrete clarifications. Adopted: distinguish actual classify task attempts from their existing bounded repair completions; timestamp immediately before classify; test exact minute expiry, both disable settings, pending enqueue/preparation/post-model awaits, non-Error privacy and selective retained non-decisions. Actual flat account leaves use numeric values regardless of all/any/negation; retain a surviving mailbox and test same-email replacement identity and unrelated deletion. Fresh snapshots are separate observations, not a transaction or save/apply guarantee. Shutdown can pass its own cancellation signal without changing shared APIs. Immediate cancellation of an existing task on settings changes lacks a notification seam in owned files: preserve an unmarked real structured-repair reproducer and report the serial settings-handler dependency, without polling or changing repair budgets.

### RED evidence and bounded implementation

Before production edits, corrected two-file regressions: **17 failed / 56 passed**; expanded preparation/disable/shutdown/privacy cases: **24 failed / 56 passed** (one pending-enqueue harness incorrectly omitted settings.get's fallback argument; corrected separately before claiming that boundary RED). Corrected pending-enqueue/final-read races: **2 failed / 52 deselected**. Slow-preparation budget test also reproduced premature expiry; an additional post-fix rate-wait shutdown race reproduced **1 failed / 54 deselected**, then drain checks terminal shutdown before requeueing. Early no-match timestamp expectation was corrected to existing `null`; protection cases are not claimed product bugs. Logs live at `/tmp/terno-readiness-review.fYaUzM/`.

Queue release deletes only discarded IDs, preserving completed null/low-confidence admission and in-flight deduplication. Both categorization settings are checked before preparation/task admission; preparation refusal logs only `aiKind`, consumes no task slot, and requires explicit enqueue after repair. Task attempts use actual start timestamps; exactly 60 seconds expires the slot. Shutdown clears its timer, is terminal across awaits, and aborts structured repairs; no autonomous retry, settings polling, filing or new store API. Generation adds one fresh account list alongside the existing category list, then checks cancellation and all actual referenced numeric account leaves using localized `errors.accountGone`. Existing category and identity/repair boundaries remain intact.

**Serial dependency (unmarked reproducer retained):** `categorize.test.ts` case “does not issue structured repairs after disable during model work” still observes two transport completions rather than one. Unlike shutdown, settings disable has no notification into AiAssist. A correct fix needs the shared settings-update handler to cancel the assist's active task (and a restartable per-task controller separate from terminal shutdown); those hot files belong to Root/W02. No observer-only mock, polling workaround or repair-budget change was added. This is a pre-existing in-flight cancellation gap, not a retry caused by queue release. The narrow changes prevent new task starts after observing disable; they cannot promise immediate revocation across an unobserved settings change.

### Scoped validation

- `pnpm install --offline --frozen-lockfile --ignore-scripts`: 728 reused, zero downloads, no scripts.
- `pnpm exec vitest run --project unit packages/ai/src/ai.test.ts packages/ai/src/contract.test.ts packages/ai/src/browser.test.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-backend.test.ts packages/backend/src/ai-filter-output.test.ts --reporter=verbose`: **206 passed / 1 failed / 207 total / 6 files / zero skipped**. Only failure is the unmarked serial settings-disable repair reproducer above (2 actual completions vs expected 1). Counts: AI 34/67/6; backend categorize 54 passed + 1 failed, ai-backend 17 passed, ai-filter-output 28 passed. Do not label this branch fully GREEN.
- `pnpm --filter @terno/backend typecheck` (both configured projects) and `pnpm --filter @terno/ai typecheck`: passed. Early test-spy type failure (missing generic fallback parameter) was corrected and the actual pending-await regression rerun RED before production edits.
- `pnpm exec oxlint --deny-warnings packages/backend/src/ai-assist.ts packages/backend/src/ai-service.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-filter-output.test.ts`; `git diff --check`: passed.

No UI/build/perf/release-wide suite ran. No main/worklist/baseline-file access, shared-hot-file edits, fetch/push/landing or unrelated cleanup; temp synthetic stores cleaned by test teardown. Draft freshness is bounded to observed post-model identities, with no atomic post-return guarantee. Root owns the shared cancellation dependency, rebase/rerun/landing/docs/worktree cleanup.

### Native Standards + Spec code review

Actual native R1 (`codex exec -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-3d3e9257 -m gpt-6.1-sol -c model_reasoning_effort='"high"'`) reviewed `0753129b..6eb188ec`: **Standards PASS / Spec FAIL**, one P2. A microtask can stop the assist after enabled resolves true but before enqueue resumes, leaving terminal pending admission. Before correction the real Backend/settings-read regression failed with **pending 2 vs 0** (`r1-red.log`, 1 failed / 55 deselected). Added immediate abort checks after enabled awaits at enqueue and task boundaries. R1 found no new high-severity blockers and confirmed the existing serial dependency was honestly qualified. No suite rerun was claimed by the reviewer; it inspected captured evidence and diff-check. R2 is the final allowed code round.

After the R1 fix, the same six-file command reports **207 passed / 1 failed / 208 total / zero skipped** (`scoped-tests-r1-fix.log`): categorize now 55 passed + the same 1 serial failure; other counts unchanged. R1 regression is GREEN in that full scoped run. Backend (both projects)/AI types, four-file lint and diff-check pass again.

Actual native **R2 (final)**, same exact model/effort/read-only invocation, reviewed `0753129b..fcccd1ab`: **Standards PASS / Spec FAIL only for acknowledged pre-existing P2 serial settings-cancellation dependency**. R1 resolved; no additional actionable defects or new high-severity blockers. Reviewer independently passed scoped lint/diff-check and inspected captured 207-pass/1-fail runtime evidence without rerunning suites. No R3, no lower-severity backlog beyond the named dependency, and no further code changes after R2. Review artifacts: `/tmp/terno-readiness-review.fYaUzM/{plan-review,code-r1,code-r2}.txt`. Source work is confined to the two AI modules and direct tests; Root must resolve the shared notification/controller boundary and rerun before claiming full readiness.


## W10 released follow-up: public settings cancellation

### Request / current behavior / design

“Disabling categorization MUST stop in-flight structured repair so NO further AI request is sent after the user turns it off.” Resume the whole original branch, first rebase onto local `405673aa`, then finish the shared notification/controller dependency. Original R1/R2 remain historical; this explicit follow-up authorizes one native read-only code round for the whole rebased series, separately from plan critique. Root alone lands/updates the worklist.

Rebase onto `405673aa` completed without conflicts; current `settings.update` already notifies backend-owned components after persistence. AiAssist currently passes only its terminal lifetime signal into classification, so its retained malformed-response disable test permits one extra repair. The existing structured ladder checks its signal before each completion, including repairs.

Notify AiAssist synchronously immediately after settings update succeeds, ahead of other awaited notifications and the RPC response. On either `aiCategorize: false` or `autoCategorize: off`, abort the current generation, clear its timer/queued work and release only unfinished admission, then create a fresh controller without scheduling work. Enqueue/drain/consider capture a generation and fence every asynchronous continuation; old tasks cannot persist a suggestion, erase new admission or discard a new queue. Retain one running drain; when a cancelled old drain settles, schedule only explicitly queued fresh-generation work so reenable/enqueue during a late completion cannot strand it. Shutdown aborts terminal lifetime plus the current generation and cannot restart. No rate timestamps or completed null/low-confidence admissions reset. Reuse existing `b.aiAssist` in the existing settings handler; no BackendCore layer is needed unless evidence proves otherwise.

### Failure map / tests / performance / exclusions

Convert the retained ordinary regression to public `settings.update`, capture actual completion signals/counts, reproduce RED before production changes. Add matched enabled repair control, both disable settings, repeated disable/reenable, old-generation queued work, late valid/malformed completion, in-flight preparation/enqueue/read continuations, reenabled fresh work and terminal shutdown. Use real structured tasks and temp Backend state; no observer-only claim. A completion-return boundary can await a public disable inside the deterministic completion fixture before returning malformed text; no artificial ladder hooks. Verify the same 20 classify-attempt/minute history survives generation changes and cancellation does not create idle timers/automatic retries or auto-file.

Only original six AI/direct-caller files plus settings-specific tests if needed; backend/AI typechecks, exact owned-file lint and whitespace. No production builds/full suites/e2e/perf, UI, stores/schema/transports, protected files/plans, main checkout/worklist, nested children or landing. Preserve original account freshness as a post-model draft snapshot, not an atomic guarantee after return. Plan critique <=12 points via native Sol/high; one follow-up Standards+Spec code review covers original + follow-up against `405673aa`, carries prior findings and this request; after it only high-severity correctness/data-loss fixes, lower backlog, no second follow-up review.

### Revisions after the Codex review (released follow-up)

Native Sol/high plan critique completed with 11 concrete points. Adopted generation capture before first await; active admission separate from completed work; stale catch/drain cleanup fenced as strictly as persistence; running owned until settlement, waking only explicit new work; cancellation check before accepting any late result; public RPC ordering before later notifications and rejected-update control; one-shot gates that permit settings RPC reads through; budget independent of generations; cancellation prevents write admission but does not retract an already admitted store transaction. Backend shutdown currently awaits facts before stopping assist: add a fail-first real shutdown-ordering test and move assist's terminal stop earlier only if reproduced.

### Released RED → GREEN and implementation

Public-settings conversion/new cases before production changes: **7 failed / 57 passed**; expanded settings/read/admission/shutdown controls: **12 failed / 58 passed** (`red.log`, `red-expanded.log`, no skips). Normal enabled repair and rejected-update controls already passed. Minimal generation cancellation + immediate shared handler notification + earlier existing BackendCore assist stop then passed **70/70**. Before code review, a committed-disable/readback overlap regression was independently RED (**1 failed / 70 deselected**): a later successful reenable can coalesce `updateSettings`' readback to true. Notification therefore uses the successfully committed disabling **patch**, not its possibly coalesced returned snapshot. Rejected patches still do not cancel. This captures every explicit disable even if its readback sees a newer update.

Implementation keeps one drain and a restartable generation signal, releasing active/queued unfinished admission on disable while retaining completed admission and all rate timestamps. Old generation cleanup cannot erase/requeue new work; old finally wakes only explicit fresh queue admission. Late valid responses are fenced before accepting or writing, malformed responses cannot enter another ladder turn after acknowledgement, and a cancelled attempt still consumes its actual-call slot. Core terminal stop moved before the facts await only after the real backend shutdown test reproduced further repairs during facts retirement. Existing ladder/transport/store APIs and automatic filing behavior unchanged. Store cancellation guards stop write admission; they do not roll back an already admitted store transaction.

### Released scoped validation before the one code review

The historical original-series serial blocker above is now resolved: its ordinary public-disable test passes with abort observed before releasing malformed output. `pnpm exec vitest run --project unit packages/ai/src/ai.test.ts packages/ai/src/contract.test.ts packages/ai/src/browser.test.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-backend.test.ts packages/backend/src/ai-filter-output.test.ts packages/backend/src/settings.test.ts --reporter=verbose`: **239/239 passed, 7 files, zero failures/skips** (`/tmp/terno-ai-settings-review.Qhvhzu/scoped-tests.log`). Per-file counts: AI 34/67/6; backend categorize 71, ai-backend 17, ai-filter-output 28, settings 16. The original six files therefore pass 223/223.

`pnpm --filter @terno/backend typecheck` (both projects), `pnpm --filter @terno/ai typecheck`, `pnpm exec oxlint --deny-warnings packages/backend/src/ai-assist.ts packages/backend/src/ai-service.ts packages/backend/src/handlers.ts packages/backend/src/core.ts packages/backend/src/categorize.test.ts packages/backend/src/ai-filter-output.test.ts`, and `git diff --check`: passed after the final production changes. No install was needed after rebase. No UI/e2e/perf/build/full suites ran, per released scope. No protected file/plan/worklist/main-checkout access or unrelated edits; Root retains landing ownership.

### One released native code review and findings

Actual native Sol/high read-only review of **whole `405673aa..d30aa17f`** completed: **Standards PASS / Spec FAIL**, two P2 findings, no P0/P1 blockers. Original R1/R2 remain historical; this was the sole released code round, not a third historical round. It independently passed owned lint/diff-check and inspected runtime evidence without rerunning suites. Per the explicit instruction to fix its findings with fail-first regressions, both findings are corrected below; no second released review is requested or claimed.

1. Delayed disable notification could clear a fresh queue after a concurrent reenabling RPC acknowledged. Extended actual public-RPC/store-gate reproducer failed with pending **1→0**, calls **1 vs 2**. Settings writes plus their existing notifications now run in order through one handler-local promise tail (no new bus, retries, polling or store API); reenable cannot overtake a committed disable's notification. The regression also proved the ordering failure before the fix (**1 failed / 72 deselected**), then asserts reenable waits, readback reflects the disable, and later explicit work persists a suggestion. A rejected update settles the tail without poisoning later requests.
2. A successful null/low-confidence result was accepted before `consider()` returned, but its active admission remained marked until drain resumed. Real structured tasks plus a paused real consider-return boundary and public disable/reenable reproduced **2 calls vs 1** for both result forms. Mark those completed non-decisions immediately, preserving seen admission through that gap.

Combined review regressions before correction: **3 failed / 70 deselected** (`review-red.log`); ordering follow-up `review-order-red.log`. The private async boundary wrapper in these two tests runs the actual consider implementation/structured task and public settings RPCs; it adds only the scheduler gap identified by review, with real counts/store assertions. No production test hook was added. Only findings from the authorized review are addressed; afterwards no lower-severity expansion or additional review round.

### Released final handoff

After fixing both findings from the sole released code round, the exact same seven-file scoped command above passed **241/241 tests, 7 files, zero failures/skips** (`scoped-tests-final.log`). Per-file counts: AI 34/67/6; backend categorize **73**, ai-backend17, ai-filter-output28, settings16. Original six AI/direct-caller files: **225/225 passed**. Both original and public-disable/reenable regressions remain ordinary passing tests. Backend typecheck (both configured projects), AI typecheck, exact six-owned-file strict lint, and whitespace checks pass after the review corrections.

The released review verdict remains historically **Standards PASS / Spec FAIL (two P2)** against its reviewed head; both findings then received genuine fail-first fixes and runtime GREEN. No second follow-up code review, implicit historical R3, or post-review lower-severity expansion. No remaining in-scope blocker/backlog was identified. Artifacts: `/tmp/terno-ai-settings-review.Qhvhzu/{plan-review,code-review}.txt`, RED/GREEN logs alongside them. No claims of retracting already dispatched remote work/admitted store transactions, nor atomic validity of a generated draft after return. No UI/build/e2e/perf/full gates or unrelated cleanup; no protected files/plans, main checkout/worklist, fetch/push or landing. Root owns serial landing of the **whole rebased original-plus-follow-up branch** and its worklist/docs/cleanup.
