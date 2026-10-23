# Única: technical plan (v1)

> "El único cliente de email que necesitas"

Única is a minimalist, extremely fast desktop email client. It supports unlimited accounts, cross-account categories, AI-built filters, filters learned from user behavior, and agent access for Codex / Claude Code.

This document is the source of truth for architecture, design system, and technical decisions. §12 records the plan review with Codex. The deliverable of the first implementation session is a **working, measured developer preview**: a real arm64 `.app`, real IMAP/SMTP + Gmail code paths tested against in-process servers and fakes, and performance proven by tests.

---

## 1. Scope

| Area | v1 (this session) | Deferred |
|---|---|---|
| Accounts | Unlimited. **Manual IMAP+SMTP** (SMTP alone only sends, so "SMTP manual" means IMAP+SMTP) and **Gmail** (OAuth PKCE loopback + Gmail API; the user supplies the Google OAuth client ID) | Outlook/Graph, JMAP |
| Mail | Unified + per-account views, threads, reader, compose / reply / reply-all / forward (plain text + quoted original), archive, delete, spam, star, read/unread | Rich editor, remote draft sync, attachment upload on compose, snooze |
| Search | FTS5 across all accounts + operators `from: to: subject: has:attachment is:unread is:starred in: account: category: before: after:` and `-negation`. **Message predicates must match the same message.** Index completeness is shown (synced range / bodies pending) | Relevance sort, saved searches |
| Categories | Manual, cross-account, **additive** (a thread can be in several), with explicit removal. Smart categorization (plan 02): local, explainable auto/suggest/nothing per category, snackbar bulk actions (sender, domain, list, topics, filter, undo) | Embeddings, model sync |
| Filters | Typed rule DSL (no regex), visual builder with live preview + apply-to-existing. Actions: archive, trash, spam, mark read, star, add category | Scheduling |
| AI filters | Natural language → structured `FilterRule` → visual builder → preview → save. Providers (plan 05): **local** Ollama, LM Studio and any loopback OpenAI-compatible server; **cloud** Anthropic, OpenAI and OpenAI-compatible APIs (OpenRouter, Groq, Together, Azure, custom) with the user's own keys; **Fake** (tests, demo) | Summaries, smart reply, embeddings / background classify |
| Local mode | On for new installs: nothing leaves the Mac except mail with the user's servers (and loopback AI). One network policy in the backend, a renderer backstop in main | — |
| Owner identity | The first verified mailbox becomes the owner ("tu cuenta Única"), separate from mailboxes; change requires live re-verification | Cloud sign-in, billing |
| Learned filters | From **explicit user actions only** (automated filter actions are excluded): sender/List-Id/domain → proposed rules accepted in one click | ML ranking |
| Agents | **MCP stdio server** (tools over a local socket to the running app) + **SKILL.md** | Remote MCP, headless mode, JSON CLI |
| Platform | macOS arm64 `.app` + `.dmg`, ad-hoc signed | Notarization, Win/Linux, mobile (Expo reusing `core`) |

## 2. Architecture

```
┌──────────────────────────────── Electron app ──────────────────────────────────┐
│ Main (thin)                         Utility process "backend" (Node 24)         │
│ - windows, menus, app:// protocol   - SOLE DOMAIN WRITER of SQLite (node:sqlite)│
│ - safeStorage (Keychain) for        - repositories, query engine, FTS5          │
│   secrets, OAuth loopback           - ops state machine + sync (IMAP/Gmail/SMTP)│
│ - spawns backend, brokers ports     - filters, suggestions, learning, AI        │
│                                     - local socket server for MCP (token auth)  │
│ Renderer (React 19, sandboxed) ◀── MessagePort, typed RPC ──▶ backend          │
└─────────────────────────────────────────────────────────────────────────────────┘
  apps/backend-dev: same backend over WebSocket (dev-in-browser + Playwright)
  unica-mcp (stdio, ELECTRON_RUN_AS_NODE) ── unix socket ──▶ backend (app must run)
```

1. **`node:sqlite`.** Verified: Electron 45 ships Node 24.22 + SQLite 3.53.4 with FTS5, trigram, and `remove_diacritics`; host Node 24 has the same SQLite. No native modules, so packaging is simpler and tests run the shipped engine.
2. **Backend in an Electron `utilityProcess`.** It is the single writer and owns migrations, optimistic state, and operation scheduling. The renderer receives a MessagePort via `MessageChannelMain`, so data doesn't hop through main.
3. **Small versioned RPC envelope** (`packages/core/rpc`): `{v, id, method, params}` → `{id, ok, result|error}`, plus `event` pushes. zod-validated at the boundary, with timeouts, disconnect handling, and resubscribe. The transport is tiny: MessagePort in prod, WebSocket for backend-dev, a unix socket (NDJSON) for MCP.
4. **Local-first.** User actions commit optimistic state **and** their operation atomically in one transaction. Sync pushes to providers.
5. **Bounded backend work.** Imports, FTS updates, and bulk rule application run in chunks (≤500 rows per transaction) and yield to the event loop between chunks, so interactive RPCs interleave. Queued obsolete searches are coalesced (only the latest per client runs). Sequence ids discard stale responses; we don't pretend to cancel a running synchronous query.

### Boot performance (borrowed from t3code)
- Privileged `app://` scheme with `codeCache: true`; CSP on every response; `module.enableCompileCache()`.
- `show:false` → `ready-to-show`; OS-theme `backgroundColor`; `backgroundThrottling:false` until first show; inline theme script in `index.html`.
- `contextIsolation`, `sandbox`, no `nodeIntegration`. The preload (bundled standalone CJS) only performs the MessagePort handshake and exposes a few desktop helpers.
- Lazy chunks for compose, settings, and the filter builder. `titleBarStyle:'hiddenInset'`, sidebar vibrancy.

## 3. Monorepo (pnpm workspaces + catalog)

```
apps/desktop      Electron main + preload + backend entry; electron-builder config; staging packager
apps/web          Renderer (React 19, Vite, Tailwind v4)
apps/backend-dev  WebSocket host for backend (dev + Playwright), seeds mock data
packages/core     Pure TS: domain types, zod schemas, RPC contract, search parser, rule DSL + JS evaluator,
                  learning heuristics, keybinding resolver, threading. No Node/DOM deps (mobile-reusable)
packages/db       node:sqlite wrapper (pragmas, LRU statement cache, tx helpers), migrations, repos, FTS,
                  search & rule SQL compilers
packages/backend  Services + RPC handlers, ops state machine, sync orchestration, filters, suggestions, AI
packages/mail     IMAP (imapflow), SMTP (nodemailer), Gmail (REST + OAuth PKCE), MIME (postal-mime)
packages/ai       Provider interface, Anthropic provider, Fake provider, prompt + schema
packages/mcp      MCP stdio server (socket client) + SKILL.md
packages/ui       Design system: shadcn (Base UI flavor) components + tokens
packages/mock-data Deterministic seeded generator (faker es/en) incl. adversarial shapes
```

Tooling: pnpm workspaces + catalog, TypeScript strict (`noUncheckedIndexedAccess`), Vitest projects, Playwright, oxlint, esbuild for main/preload/backend/mcp, Vite for the renderer, electron-builder 26 (pinned) packaging a **self-contained staging dir**.

## 4. Data model

Pragmas: WAL, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=2000`, `temp_store=MEMORY`, `cache_size=-65536`, `mmap_size=256MB`, `checkpoint_fullfsync=ON`. Run `PRAGMA optimize` after imports/migrations and on idle. Prepared statements are cached in an LRU.

**Provider state lives on messages; thread flags are derived aggregates.**

```
accounts(id, kind, email, display_name, color, provider_config_json, secret_ref, sync_state_json, created_at)
messages(id INTEGER PK, account_id, thread_id, provider_msg_id, rfc_message_id, in_reply_to, references_json,
         from_name, from_email, from_domain, to_json, cc_json, recipients_text, subject, date, snippet,
         body_state['none'|'partial'|'full'], body_tail_norm, list_id,
         is_read, is_starred, in_inbox, is_sent, is_draft, is_trash, is_spam, has_attachments,
         gmail_labels_json, size)
message_bodies(message_id PK, body_text, body_html)       -- v6; no row for a message without a body
message_locations(message_id, mailbox, uidvalidity, uid)  -- IMAP identity; remapped after MOVE
threads(id INTEGER PK, account_id, provider_thread_id, subject, snippet, participants_json,
        last_date, message_count,
        -- derived from messages (recomputed in the same tx as any message change):
        unread_count, has_attachments, is_starred, in_inbox, has_sent, in_trash, in_spam, last_from_name, last_from_email)
attachments(id, message_id, filename, mime, size, content_id, provider_ref)
categories(id, name, color, position) ; thread_categories(thread_id, category_id, added_by['user'|'filter'|'agent'])
filters(id, name, enabled, source['manual'|'ai'|'learned'], rule_json, created_at, hits, last_applied_at)
ops(id TEXT uuid, account_id, kind, target_json, payload_json,
    state['queued'|'running'|'succeeded'|'failed'|'unknown'], attempts, next_attempt_at, last_error, created_at)
user_actions(id, thread_id, action, from_email, from_domain, list_id, at)   -- explicit actions only
dismissed_suggestions(key, at) ; settings(key, value_json)
messages_fts USING fts5(subject, from_text, recipients, body, content='messages_fts_src' /*view over messages ⟕ message_bodies*/,
                        content_rowid='id', tokenize="unicode61 remove_diacritics 2", prefix='2 3')
search_state(epoch, seq) ; search_outbox(seq, changes) -- v7: one revisioned batch of touched ids per write transaction
```

**Thread semantics:**
- Views are derived: Inbox = `in_inbox=1`; Sent = `has_sent=1`; Starred; Trash; Spam; Archive = not inbox/trash/spam.
- A thread action **captures the targeted message ids at action time** (stored in `ops.target_json`). A new incoming inbox message brings an archived thread back to Inbox.
- Local categories are kept when new messages arrive.
- Threading uses provider thread ids (Gmail) or References/In-Reply-To/Message-ID (IMAP). **No subject-only merging.**

**Indexes (explicit `id DESC`, partial for hot views):**
```sql
threads_order        ON threads(last_date DESC, id DESC)
threads_acct_order   ON threads(account_id, last_date DESC, id DESC)
threads_inbox        ON threads(last_date DESC, id DESC) WHERE in_inbox=1
threads_acct_inbox   ON threads(account_id, last_date DESC, id DESC) WHERE in_inbox=1
threads_starred      ON threads(last_date DESC, id DESC) WHERE is_starred=1
threads_sent         ON threads(last_date DESC, id DESC) WHERE has_sent=1
threads_unread_inbox ON threads(account_id) WHERE in_inbox=1 AND unread_count>0   -- sidebar counts
thread_categories_c  ON thread_categories(category_id, thread_id)
messages_thread      ON messages(thread_id, date)
messages_from        ON messages(from_email) ; messages_domain ON messages(from_domain) ; messages_list ON messages(list_id)
```

Sidebar counts are computed with `count(*)` over partial indexes (measured; no trigger counters unless the budgets fail). Lists run two phases: (1) ids via keyset `WHERE (last_date,id) < (?,?) ORDER BY last_date DESC, id DESC LIMIT n`, then (2) display columns for those ids.

## 5. Search

- `core/search` parses the query into an AST. `db/search` compiles it into **message predicates** (text, from, to, subject, has:attachment, before/after, all matching the same message) and **thread predicates** (in:, account:, category:, is:unread, is:starred).
- **Two strategies, both implemented and benchmarked; the planner picks one:**
  - **A, materialized hits:** `WITH hits AS MATERIALIZED (SELECT DISTINCT thread_id FROM messages_fts JOIN messages … WHERE MATCH …)` → join threads → thread filters → ORDER/LIMIT. Wins for rare terms.
  - **B, chronological walk:** walk the thread order index with an `EXISTS` on message predicates. Used when there is no free-text term (structured-only queries such as `from:x is:unread`).
- Never LIMIT message hits before dedup/thread filtering. Free text gets a prefix match on the last token for type-ahead.
- **Instant search** (plan 03, `@unica/store/instant`): an in-memory `InstantSearchEngine` (typed-array postings with a field mask, prefix ranges, a packed forward index for phrases, bitsets over messages, a newest-first thread walk that stops after limit + 1) answers whenever it is exactly at the store's revision; FTS5 answers otherwise (building, catching up after a commit, over its memory caps) with the same results, and serves as its exact phrase doclist. It is kept current off the interactive path from the search outbox (snapshot restore or a sliced build from a feed lease, replay after commit once writes settle, background compaction, atomic snapshots beside the database). Rules, filters and categorization bulk scopes keep their SQL paths; MCP shares `threads.search`.
- Live lists use a cursor `{generation, last_date, id}`. When the backend reports a change affecting an open view, the renderer reconciles the loaded window and doesn't promise gapless paging across mutations.

## 6. Filters, categories, learning

- **Rule DSL** (zod, typed field/op pairs):
  - fields `from | fromDomain | recipients | subject | body | listId | hasAttachment | account | olderThanDays`
  - ops by type: text `contains|equals|startsWith|endsWith`; bool `is`; number `gt|lt`
  - `negate?`; `match: all|any`
  - actions: `archive | trash | spam | markRead | star | addCategory(id)`
  - Normalization: NFKD + strip diacritics + lowercase on both sides. Null bodies don't match `body contains`.
- Rules evaluate **per message**. Actions apply to the matched messages; category actions apply to their thread.
- JS `evaluate(rule, msg)` (incoming) and `compileRuleToSql(rule)` (preview / apply-existing) share normalization. A **parity test** runs both over thousands of adversarial mock messages and they must agree.
- AI: prompt + JSON schema → `FilterRule` → zod validation. One repair retry, then the error is shown. The result always lands in the visual builder with a live preview before saving.
- **Storage boundary** (plans 03/04 reconciliation): the backend, providers (`ProviderStore`), categorizer and MCP reach storage only through `MailStore` (`packages/store`), async, one atomic store command per method; `SqlMailStore` implements it over the synchronous SQL layer on a `SqliteConnection` (node:sqlite driver on desktop). One conformance suite (`@unica/store/conformance`) defines the contract for every adapter, including the brute-force search oracle. Every write transaction appends the ids it touched to the search outbox (v7) under a revision, served as absolute projections; searches report the revision they answered at, and a cursor from another revision is refused (the renderer restarts from the top). The instant search index consumes it (§5).
- Smart categorization (plan 02, migration v4): pure `core/categorize` (features, grouped Naive Bayes with a positive-unlabeled correction, policy, explanations) and `db/categorize*.ts` store commands; `cls_examples` is the training source of truth (user removals are weight-3 negatives; categories are additive, so another category is never a negative). Classification runs inside the ingestion transaction; the in-memory model is updated only after commit. Auto requires p ≥ 0.97, ≥ 5 examples and a calibrated identity (or a content-only path for unknown senders), with hard/sender/look-alike vetoes and a Beta safety valve that waits for 10 matured outcomes. One `categories.addThreads` path serves the picker, accepted suggestions and drag and drop; bulk applies are undoable batches.
- Learned filters (pure `core/learning`): per key (sender/List-Id/domain) over the last 60 days, ≥5 explicit actions with ≥85% the same destructive action (archive/trash/spam) and no star/important/reply signal → propose a rule. Dismissals are remembered.

## 7. Providers & sync

- **Ops state machine:** queued → running → succeeded | failed (retryable, exponential backoff, max attempts) | **unknown** (ambiguous outcome, never auto-retried).
  - **Send** becomes `unknown` on ambiguous failure (e.g. disconnect after DATA) and the UI asks the user.
  - Ops for the same target coalesce (e.g. read+unread).
  - Incoming sync reconciles with pending ops: local optimistic flags win until the op settles.
- **IMAP** (imapflow): special-use mailbox detection (Inbox, Sent, Archive/All, Junk, Trash).
  - Initial window: N days (default 90), envelope + flags + preview first, bodies after.
  - Identity `(mailbox, UIDVALIDITY, UID)`. A UIDVALIDITY change triggers a mailbox resync.
  - Incremental sync by UID + flags; IDLE on INBOX. Archive = MOVE to Archive, trash = MOVE to Trash.
- **SMTP** (nodemailer): send. Saving to Sent follows a per-account policy: `appendToSent: auto|always|never`, where auto=never for Gmail and always for generic IMAP.
- **Gmail:** OAuth installed-app flow, PKCE + state + loopback on 127.0.0.1; token refresh serialized.
  - Sync: `messages.list` + `messages.get(format=full)` in batches, then `history.list` incrementally. History expiry (404) triggers a full resync.
  - Actions use `messages.batchModify` on the captured message ids; send uses `messages.send` raw.
- Secrets are encrypted via `safeStorage` in main and requested by the backend over the parent port. IMAP passwords and refresh tokens never reach the renderer.
- **Network policy** (`packages/backend/src/net-policy.ts`): every outbound request names a purpose (`mail`, `ai`, `remote-content`, `telemetry`, `update`, `cloud`) and goes through `fetchFor(purpose)`. `mail` is always allowed. In local mode `ai` is allowed only for local providers whose host is (or resolves only to) loopback, and the request goes to the checked IP (no DNS rebinding); everything else is denied before a socket opens. Gmail (OAuth + API) and both AI SDKs receive the policy fetch by injection; an architecture test fails on any other network call. Main cancels the renderer's non-loopback http(s)/ws(s) while local mode is on.
- **AI providers** (`packages/ai`): two wire protocols (Anthropic Messages, OpenAI Chat Completions) behind `ModelTransport`; tasks (`generateFilter`, `classify`) are a prompt plus a zod schema run through one ladder: `json_schema` → (server rejects) `json_object` → text with JSON extraction, with malformed or invalid output fed back as repairs. Capabilities are declared per provider and replaced by what *Test connection* observes. Keys are stored per provider/preset through `SecretCipher`; the renderer sees only `hasKey` and the last 4 characters. SDKs are lazy-imported and every client option is explicit (no env fallbacks).
- **Owner identity**: claimed with `INSERT OR IGNORE` on a singleton row in the same transaction as the first verified account (Gmail OAuth with `sub`, or a live IMAP login recording whether the login user is the address). Removing that mailbox only clears `account_id`; `identity.changeOwner` re-verifies the target now and keeps the user id, writing `owner_history`. Not available to MCP.

## 8. Agent integration (decision: MCP primary + SKILL)

- MCP works identically in Claude Code and Codex with typed tools. The SKILL.md teaches Claude Code the query syntax, safety rules (never send without explicit confirmation), and workflows.
- `unica-mcp` is a standalone CJS bundle in `extraResources` plus a wrapper script `Contents/Resources/bin/unica-mcp` that runs `ELECTRON_RUN_AS_NODE=1 "<app binary>" "<resources>/mcp/unica-mcp.cjs"`. The RunAsNode fuse stays enabled, paths are quoted, and stdout carries only protocol output.
- It connects to the running app's backend via a unix socket in `userData` with a token file (0600). The backend stays the sole writer. If the app isn't running, tools return a clear error.
- Tools: `list_accounts`, `search_emails`, `get_thread`, `list_categories`, `add_to_category`, `archive_threads`, `trash_threads`, `mark_read`, `create_draft`, `send_email` (only if "allow agents to send" is on; otherwise it fails with guidance), `list_filters`, `create_filter`.
- Settings → Agents shows copy-paste setup commands for Claude Code and Codex.

## 9. Design system

Base: **shadcn/ui, Base UI flavor** (the current shadcn default), Tailwind v4 CSS-variable theming in oklch, installed into `packages/ui`. shadcn component APIs and token names stay intact; we re-theme values and add a few email tokens. App code uses tokens only, never raw colors.

**Personality:** calm, paper-like, typographic, quiet chrome, content first (Superhuman speed, Apple Mail restraint, Linear precision).

- **Type:** Geist Variable + Geist Mono Variable, bundled offline. Scale 11/12/13/14/16/20/24; list 13px.
- **Themes** (plan 01): mode `system | light | dark` plus a named theme per mode — Única, Apple, Solarized, Gruvbox, GitHub, Catppuccin Latte (light); Única, Dracula, Monokai, Tokyo Night, Gruvbox, Nord, Catppuccin Mocha (dark) — and custom JSON themes. The typed registry in `packages/ui/src/themes` is the source of truth; `themes.generated.css` (one `[data-theme]` block each) is generated from it and checked in. Every theme passes WCAG AA in a test. The values below are the Única themes.
- **Light:** paper neutrals (hue 85, chroma ≤ .006).
  - background `oklch(.99 .002 85)`, sidebar `oklch(.965 .004 85 / .82)`, foreground `oklch(.22 .01 265)`, muted-fg `oklch(.52 .01 265)`, border `oklch(.91 .004 85)`.
  - Accent "Única indigo" `oklch(.56 .19 268)`. Destructive `oklch(.58 .21 25)`.
- **Dark:** background `oklch(.17 .006 265)`, sidebar `oklch(.2 .006 265 / .78)`, foreground `oklch(.95 .004 85)`, accent `oklch(.7 .16 268)`.
- **Interaction tokens:** `--row-hover`, `--row-selected`, `--row-selected-fg`, `--row-selected-rail`, `--unread`, `--focus-ring`. Contrast checked (AA) in a test.
- **Category palette:** 8 hues at L .68 C .12 (rose, amber, lime, emerald, cyan, indigo, violet, slate) as dots and soft badges.
- **Shape:** `--radius: .5rem`, hairline borders, shadows only on overlays (in the theme's `--shadow-color`).
- **Motion** (plan 01, supersedes 120–180 ms): one setting `--motion` = 0/50/75/100 ms (default 75); fast ≈ ⅔M for hover/press/tooltips/exits, base = M for popovers and menus, slow = 4⁄3 M capped at 100 ms for dialogs, toasts and drop feedback. Nothing runs longer than 100 ms. `0` or the OS reduced-motion preference turns every animation off. j/k, selection, row hover, the reader swap and theme switches never animate.
- **Drag and drop:** rows drag onto sidebar categories (own pointer controller, ids-only payload, no row renders during a drag); a drop is the same `addToCategory` as the `l` picker, with the categorization snackbar and undo. ⌥ in a category view moves.
- **Layout:** sidebar 232px | thread list 400px (64px two-line rows) | reader (max 760px). Reader toolbar: Reply r, Reply all a, Forward f, Archive e, Delete #, Spam !, Category l, Unread u, Star s.
- **Keyboard:** `j/k`, `enter/o`, `esc`, `/`, `c`, `⌘K` palette, `g i/g s/g a`, `⌘↵` send.
- **HTML mail:** DOMPurify, then a sandboxed iframe (`srcdoc`, no scripts, no popups). Strict CSP inside: `img-src` is limited to data/cid unless the user loads remote content. Remote CSS/fonts are blocked too. Navigation is intercepted and only `http(s)`/`mailto` open externally via main's allowlisted handler. `will-navigate`/`setWindowOpenHandler` deny everything else.

## 10. Renderer performance

- React 19 (+ React Compiler if compatible; verified in the build, with manual memo where profiling says so). Zustand with per-row selectors, so a selection change re-renders 2 rows. Stable row identity across refetches.
- `@tanstack/react-virtual`, fixed 64px rows, overscan 10, pages of 100 with prefetch at 40 rows from the end.
- Query store keyed by `(view, query)` with stale-while-revalidate; batched backend `changed` events.
- Reader: debounce iframe document swaps during rapid j/k (the header shows instantly, the body after ~60 ms idle); neighbor prefetch; body LRU bounded by bytes (~20 MB).
- A single document-level keydown handler with the pure resolver from `core`.

## 11. Testing (meaningful only) & performance gate

1. **core:** search parser, rule evaluator normalization, learning thresholds/decay/conflicts, keybinding resolver, threading (broken chains, out-of-order arrival, no subject merge).
2. **db (real node:sqlite on temp files):** migrations; derived thread flags vs recomputation from messages (randomized action sequences); FTS (accents, prefix, same-message semantics, body arrival/replacement/deletion, integrity-check); **rule JS↔SQL parity**; keyset pagination; query plans asserting the intended index is used for hot list queries.
3. **providers:** IMAP sync + ops with **real imapflow against in-process ImapKit** (two accounts, UIDVALIDITY reset, MOVE, flags, new mail); SMTP against an in-process `smtp-server` (including ambiguous failure → `unknown`); Gmail against a fake OAuth + Gmail HTTP server (PKCE/state validation, refresh serialization, pagination, history expiry → full resync, 429 backoff).
4. **backend:** ops atomicity/coalescing/reconciliation; filters on incoming mail; suggestions; learned rules from action sequences; AI repair loop with the Fake provider.
   - **AI provider contract** (`packages/ai/src/contract.test.ts`): one suite run against local stub servers for Anthropic, OpenAI, OpenRouter, Azure, Ollama and LM Studio — request shape and auth, parsing and repair, 401/429/timeout/refusal/length/abort, the downgrade ladder, `<think>`/fences, discovery (`/api/tags`+`/api/show`, LM Studio `/api/v0` → `/v1/models`, closed port in < 100 ms), and a snapshot of the strict JSON Schema.
   - **Local mode**: cloud providers pointed at a reachable stub fail with `blocked` and the stub sees zero connections (checked with `diagnostics_channel`); LAN-resolving names are blocked, loopback-resolving names go to the IP; an architecture scan of all shipped sources.
   - **Keys and identity**: keys never appear in bootstrap or settings results; migration v3 (owner adoption, secret rename, `localMode:false` for existing installs); claim/removal/change semantics including concurrent adds.
5. **mcp:** an MCP client over in-memory transport → socket → real backend on a seeded DB; send gating.
6. **Performance gate** (seeded 50k messages / ~20k threads / 8 skewed accounts, long threads, shared timestamps, realistic Unicode bodies, large categories; serial runs, warmup, p50/p95/max over ≥50 iterations):
   - **SQL p95 targets (release gate on this arm64 reference machine):** list first page ≤ 5 ms, deep keyset page ≤ 5 ms, account/category/starred views ≤ 5 ms, sidebar counts ≤ 5 ms, open thread ≤ 5 ms, FTS search (common / rare / prefix / operators / zero-result intersections) ≤ 25 ms, filter preview ≤ 50 ms, suggestions ≤ 10 ms.
   - Budgets are asserted at these values, scaled only by an explicit `PERF_BUDGET_MULTIPLIER` for slower CI machines.
   - **RPC round trip** measured in-process through the real envelope (p95 ≤ 2 ms + query time). Payload byte budgets per page.
7. **E2E + visual (Playwright, Chromium against backend-dev with mock data):** keyboard triage, search, reply/reply-all/forward/send (captured by local SMTP), categories + suggestions, AI filter builder + preview + apply, learned-suggestion accept, add-account form, settings. `toHaveScreenshot` in light + dark.
8. **UI perf (Playwright, test build with a render probe):** j-key handler→commit p95 and keypress→next-frame p95 (target ≤ 16 ms) over 300 consecutive moves, with no animation started; keystroke→results-rendered p95 ≤ 100 ms; DOM rows bounded; theme switch → painted ≤ 50 ms with zero row renders; drag start ≤ 16 ms, pointermove handler ≤ 2 ms, zero row renders during a drag, ≤ 2 NavItem renders per target change, drop → dot ≤ 16 ms.
   - **Themes and motion:** WCAG AA for 49 token pairs in every theme; the generated CSS matches the registry (and ≤ 8 KB gzip); a scan rejects literal colors, literal durations and translucent text in app code; custom-theme schema incl. CSS-injection cases; theme.js in a `node:vm` sandbox; `themes.spec` / `motion.spec` / `dnd.spec` and a visual baseline per theme.
9. **Electron smoke on the packaged arm64 app, copied outside the repo:** launches, utility process alive, demo seed renders, search works, thread opens, `unica-mcp` answers `list_accounts`; in local mode main cancels a remote `<img>`; `codesign --verify` passes.

## 12. Plan review with Codex: outcome

Codex reviewed v0 (round 1). Adopted:
- message-level provider state with derived thread flags
- actions capture message ids
- the backend as sole writer (MCP over a socket)
- message-vs-thread predicates
- executable query shapes with `id DESC` partial indexes
- two benchmarked FTS strategies (Codex measured 60 ms vs 0.02 ms for rare terms between them)
- ops state machine with `unknown`
- bounded background work
- live-list reconciliation
- search completeness indicator
- typed rules without regex
- learning from explicit actions only
- real p95 gate
- packaging in milestone 1
- reduced breadth
- ImapKit for IMAP tests
- PRAGMA optimize instead of "no ANALYZE"
- self-contained staging packaging
- strict iframe navigation
- Base UI flavor
- interaction tokens

Round 2: Codex accepted these positions (with refinements):
- **backend-dev WebSocket host stays.** It's ~100 lines over the same envelope, and it makes Playwright visual/flow tests fast and deterministic in plain Chromium, which matters more than the cost.
- **Trigger counters dropped:** partial-index `count(*)` is simpler and correct; we measure it.
- **External-content FTS** (over a view) instead of contentless, so `snippet()`/highlight work without duplicating text. Invariants:
  - the view exposes a stable integer `id` + exactly the indexed columns
  - updates/deletes issue the FTS `'delete'` command with the **exact old projected values** before inserting new ones
  - consistency is checked with `INSERT INTO messages_fts(messages_fts, rank) VALUES('integrity-check', 1)`
  - `'rebuild'` is used for backfill
- backend-dev binds to loopback only, with a token check.
- Sidebar semantics are **unread threads** (not messages).

Round 2 refinements adopted:
- **Thread aggregates** are recomputed **once per touched thread at chunk end** (same tx), never per message (avoids quadratic imports). This includes old and new thread ids, empty-thread deletion, and deterministic latest-message ties (`date, id`).
- **Search planner by selectivity, not syntax:**
  - free text → A (materialized FTS hits)
  - structured-only with an indexed message predicate (`from:`, list, domain) → materialize thread ids from `messages_from`/… with all message predicates applied before dedup
  - thread-only filters → chronological walk on partial indexes
  - Negative-only text uses an exclusion path (`NOT IN` hits), since FTS5 `NOT` needs a positive left operand.
- **Crash-safe ops:**
  - On startup, `running` sends → `unknown`; other `running` ops → `queued` (they are idempotent at the provider level: flag/label set-to-state, MOVE guarded by current location).
  - Drafts and send payloads persist in `drafts`/`ops.payload_json` before sending.
  - An op completion only clears optimistic state if no newer op targets the same message+field (per-field op sequence).
- **IMAP reconciliation:** EXPUNGE / vanished UIDs remove locations (a message with no locations is deleted). Reconnect does a full UID+flags diff per synced mailbox. Mailboxes outside INBOX are synced on a timer. Without MOVE: COPY + `\Deleted` + EXPUNGE. Without special-use folders, fall back to name heuristics, then to user choice. Flags are kept per location; the message-level flag is their union.
- **Delayed-body rules:** filters with body conditions re-run when `body_state` becomes `full`. Actions are idempotent (set-to-state), and `filter_applications(filter_id, message_id)` prevents double application.
- **Background budget:** chunks are bounded by **time (≤ 8 ms) and rows**, then `setImmediate` yields. The perf suite measures interactive RPC p95 **while** an import + bulk rule run in the background.

### Implementation review with Codex

Codex reviewed the implementation in three rounds (`codex exec`, read-only).

**Round 1:** two parallel reviews, 28 findings.

- **core/db/backend:** older retries overwriting newer ops; non-atomic filter application; a stale pending-op guard; search negation semantics; Unicode parity between JS and SQL.
- **mail/desktop/mcp:** a STARTTLS downgrade; stale UIDs after a UIDVALIDITY reset; duplicate sends on a truncated Gmail response; reply-recipient injection through display names; SMTP retry classification; a hanging MCP handshake.

All were fixed with regression tests. One fix (superseding ops) introduced a quadratic slowdown, which the backend load test caught (8 s → 160 s). It was resolved with the `op_targets` index (migration v2).

**Round 2** verified the fixes: 19 fully fixed, 9 partial. The remaining work was completed:

- location ops run in FIFO order per message instead of being superseded
- supersede on failure and on crash recovery
- deleted messages are pruned from ops (rowid reuse)
- bulk applies are cancelled when their filter is edited
- Latin-only diacritic folding
- content fingerprints for mail without a Message-ID
- complete Gmail expiry recovery
- a UI warning for partial delivery

**Round 3** checked the round-2 diff for high-severity regressions.

## 13. Milestones

1. Monorepo scaffold + **packaged arm64 Electron skeleton** (utility process, node:sqlite, MessagePort RPC, app:// protocol) and a smoke test of the packaged artifact
2. `core` + tests
3. `db` + tests + perf gate
4. `mock-data`
5. `backend` services + backend-dev
6. `ui` design system
7. `web` renderer features
8. `mail` providers + sync + ops (ImapKit, smtp-server, fake Gmail)
9. `ai` + `mcp` + SKILL
10. Playwright e2e/visual/UI-perf + packaged Electron smoke
11. Codex review rounds → fixes
