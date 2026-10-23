# Única: plan técnico (v0)

> "El único cliente de email que necesitas"

Única is a minimalist, extremely fast desktop email client. It supports unlimited accounts, cross-account categories, AI-built filters, filters learned from user behavior, and agent access for Codex / Claude Code.

This document is the source of truth for architecture, design system, and technical decisions. Section 12 records the plan-review discussion with Codex.

---

## 1. Product scope for v1

| Area | v1 | Later |
|---|---|---|
| Accounts | Unlimited. **Manual IMAP+SMTP** ("SMTP manual" in the brief: SMTP only sends, so receiving needs IMAP) and **Google/Gmail** via OAuth + the Gmail API | Outlook/Graph, JMAP |
| Mail | Unified inbox and per-account views; threads; read/compose/reply/reply-all/forward; archive, delete, spam, star; drafts; attachments (view/save, attach on send) | Snooze, send-later, templates |
| Search | Instant FTS5 search across all accounts. Operators: `from: to: subject: has:attachment is:unread is:starred in:<view> account: category: before: after:` | Saved searches |
| Categories | Manual cross-account categories (thread-level). "Move similar emails?" suggestions after categorizing | Category rules auto-suggested |
| Filters | Delete / spam / archive / recategorize / mark read / star. Built with a **visual rule builder** or **from natural language via AI**, with a live preview of matches before saving | Scheduled re-runs |
| Learned filters | Heuristics watch archive/delete/star/importance actions per sender, domain, and List-Id, then propose filters the user accepts with one click | ML ranking |
| AI | Pluggable providers: Anthropic API, OpenAI API, and local **Claude Code** / **Codex** CLIs (reuse the user's subscription); deterministic Fake for tests | Summaries, smart replies |
| Agents | **MCP server** (stdio), plus a **SKILL.md** and a JSON CLI. One access point to all connected mail | Remote MCP |
| Platform | macOS Apple Silicon (.app/.dmg) | Windows/Linux, mobile (Expo) reusing `core`/`db` logic |

## 2. Architecture

```
┌───────────────────────────── Electron app ─────────────────────────────┐
│  Main process (thin)          Utility process "backend" (Node 24)       │
│  - windows, menus, tray       - node:sqlite (WAL), FTS5                 │
│  - app:// protocol            - repositories / query engine             │
│  - safeStorage (Keychain)     - sync engine (IMAP, Gmail, SMTP)         │
│  - OAuth loopback             - pending-ops queue, filter engine        │
│  - spawns backend, brokers    - AI providers, learning                  │
│    MessagePort ───────────────┐                                         │
│                               ▼                                         │
│  Renderer (React 19, sandboxed) ◀── typed RPC over MessagePort ──▶      │
└──────────────────────────────────────────────────────────────────────── ┘
        ▲ same RPC over WebSocket (dev-in-browser + Playwright)
  External: `unica-mcp` (ELECTRON_RUN_AS_NODE) ─ opens same SQLite file (WAL)
            writes go through pending_ops; app notices via PRAGMA data_version
```

Key decisions:

1. **`node:sqlite` (DatabaseSync), not better-sqlite3.** Verified: Electron 45 ships Node 24.22 + SQLite 3.53.4 with FTS5, trigram, and `remove_diacritics`. Host Node 24 has the same SQLite, so tests run the exact engine the app ships, and there is **zero native-module rebuild pain**. The MCP sidecar can use the same code. t3code uses the same approach.
2. **Backend in an Electron `utilityProcess`**, not the main process. DB and sync work never block window/IPC handling. The renderer gets a **direct MessagePort** to the backend (via `MessageChannelMain`), so data never hops through main.
3. **Transport-agnostic typed RPC** (`packages/core/rpc`): request/response + server-push events, defined once with zod schemas.
   - Transports: MessagePort (prod) and WebSocket (`apps/backend-dev`, used for `pnpm dev:web` and Playwright).
   - The same backend code runs in both.
4. **Local-first actions.** Every user action (archive, read, categorize...) commits to SQLite immediately and appends to `pending_ops`. Sync workers push to providers with retries/backoff. The UI never waits on the network.
5. **Threads are the unit of triage.** A denormalized `threads` table (last_date, participants, snippet, unread_count, flags, mailbox, account) makes list queries index-only. Messages hang off threads.
6. **The renderer holds only what's on screen.** Keyset pagination plus a virtualized list (fixed row height), with an LRU of thread bodies and prefetch of neighbors (±3) on selection.

### Process / boot performance (borrowed from t3code)
- Custom privileged scheme `app://` with `codeCache: true` (V8 code cache for the renderer; `file://` doesn't get it). CSP on every response.
- `module.enableCompileCache()` in main/backend boot.
- Window: `show:false` + `ready-to-show`; `backgroundColor` from the OS theme; `backgroundThrottling:false` until first show. Inline theme script in `index.html` to avoid a flash.
- `contextIsolation`, `sandbox`, no `nodeIntegration`. Preload exposes only a MessagePort handshake + a few desktop helpers.
- Lazy-load heavy, rarely-used views (settings, filter builder, compose editor).
- macOS: `titleBarStyle: 'hiddenInset'`, sidebar `vibrancy`.

## 3. Monorepo layout (pnpm workspaces + catalog)

```
apps/
  desktop/        Electron main + preload + backend entry; electron-builder config
  web/            Renderer (React 19 + Vite + Tailwind v4); also runs in a browser against backend-dev
  backend-dev/    Node WebSocket host for the backend (dev + e2e); seeds mock data
packages/
  core/           Domain types, zod schemas, RPC contract, search-query parser, filter rule engine (pure),
                  learning heuristics (pure), keybinding resolver. Zero Node/DOM deps → reusable on mobile
  db/             node:sqlite wrapper, migrations, schema, FTS5, repositories, rule→SQL compiler, statement cache
  backend/        Service layer: RPC handlers, pending-ops, sync orchestration, filters, suggestions, AI
  mail/           Provider adapters: IMAP (imapflow), SMTP (nodemailer), Gmail (REST + OAuth PKCE), MIME (postal-mime)
  ai/             AI providers (Anthropic, OpenAI, Claude Code CLI, Codex CLI, Fake) + prompt/structured output → FilterRule
  mcp/            MCP stdio server + JSON CLI over packages/db; SKILL.md
  ui/             Design system: shadcn components (customized), tokens (CSS), icons, primitives
  mock-data/      Deterministic seeded generator (faker es/en): accounts, threads, newsletters, receipts...
tooling/          shared tsconfig, vitest config
```

Tooling: pnpm 10 workspaces with a `catalog:`; TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`); Vitest (projects); Playwright; oxlint; esbuild for main/preload/backend/mcp bundles; Vite for the renderer; electron-builder for packaging.

## 4. Data model (SQLite)

Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `temp_store=MEMORY`, `cache_size=-64000`, `mmap_size=268435456`, `checkpoint_fullfsync=ON`. No ANALYZE; we rely on explicit indexes and assert plans in tests. Prepared statements are cached in an LRU.

```
accounts(id, kind['imap'|'gmail'], email, display_name, color, settings_json, sync_state_json, created_at)
threads(id, account_id, provider_thread_id, subject, snippet, participants_json, last_date,
        message_count, unread_count, has_attachments, is_starred, is_important,
        mailbox['inbox'|'archive'|'trash'|'spam'|'sent_only'|'drafts'], has_outgoing, list_id, from_email, from_domain)
messages(id, thread_id, account_id, provider_id, message_id_hdr, in_reply_to, references_json,
         from_name, from_email, to_json, cc_json, bcc_json, subject, date, snippet,
         body_text, body_html, is_read, is_outgoing, has_attachments, list_id, raw_headers_json, size)
attachments(id, message_id, filename, mime, size, content_id, provider_ref, local_path)
categories(id, name, color, icon, position)
thread_categories(thread_id, category_id)  -- PK(thread_id, category_id)
filters(id, name, enabled, source['manual'|'ai'|'learned'], rule_json, created_at, last_applied_at, hits)
pending_ops(id, account_id, kind, payload_json, attempts, next_attempt_at, last_error)
user_actions(id, thread_id, action, from_email, from_domain, list_id, at)   -- feeds learning
dismissed_suggestions(key, at)
settings(key, value_json)
messages_fts USING fts5(subject, from_text, to_text, body, content='', contentless_delete=1,
                        tokenize="unicode61 remove_diacritics 2", prefix='2 3')
```

Indexes cover the list queries (keyset `(last_date DESC, id DESC)`):
- `threads(mailbox, last_date DESC, id)`
- `threads(account_id, mailbox, last_date DESC, id)`
- `threads(is_starred, last_date DESC)` partial
- `threads(from_email)`, `threads(from_domain)`, `threads(list_id)`
- `thread_categories(category_id, thread_id)`
- `messages(thread_id, date)`

Sidebar unread counts come from a small `counters` table maintained by triggers (O(1) reads), not COUNT(*).

## 5. Search

- `core/search`: parser for `from:ana subject:"factura marzo" has:attachment -is:read texto libre` into an AST, then `db/search` compiles it to SQL.
- Free text → `messages_fts MATCH` (prefix on the last token for type-ahead). Structured operators → indexed WHERE clauses on `threads`. Results are grouped by thread, ordered by `last_date` (default) or bm25 (option).
- Renderer: the input is never blocked. Queries are debounced at ~0 ms with request cancellation (latest wins, sequence ids) and `useDeferredValue` for rendering.

## 6. Filters, categories, learning

- **Rule DSL** (zod, in `core`):
  `{ match: 'all'|'any', conditions: [{ field: from|fromDomain|to|subject|body|listId|hasAttachment|account|olderThanDays|category, op: contains|equals|endsWith|startsWith|matches, value, negate? }], actions: [{ type: archive|delete|spam|markRead|star|setCategory, categoryId? }] }`
- **Two evaluators of the same rule**:
  1. pure JS `evaluate(rule, message)` for incoming mail;
  2. `compileRuleToSql(rule)` for preview and bulk-apply over existing mail.
  A parity test runs both against thousands of mock messages and they must agree.
- **AI filter creation**: natural language → provider with structured output → validated `FilterRule` → shown in the **visual builder** (editable chips) with a **live preview** (count + first 20 matches) → save. Invalid AI output gets a repair loop (1 retry), then a clear error.
- **Category suggestions**: after a thread is put in category C, find similar threads (same from_email > same list_id > same from_domain > FTS similarity on subject terms) not yet in C. Show an inline "Move 14 similar?" toast with a review list.
- **Learned filters**: `user_actions` aggregated per sender/domain/list_id. If ≥5 actions in 30 days and ≥85% are the same action (archive/delete/spam), propose a rule. Starring/marking important reduces the score for destructive rules. Pure function in `core/learning`, fully unit-tested.

## 7. Mail providers & sync

- **IMAP** (`imapflow`): initial sync of the last N days (default 90) for INBOX, Sent, Archive/All, Junk, Trash. Envelope + bodystructure + text preview first; full bodies in the background (newest first) and on demand. UIDVALIDITY + highest UID (+ CONDSTORE/QRESYNC when available) for incremental sync; IDLE on INBOX. Threading by Message-ID/References/In-Reply-To, falling back to normalized subject + participants.
- **SMTP** (`nodemailer`): send, then append to Sent if the server doesn't auto-save.
- **Gmail**: OAuth 2.0 installed-app flow with PKCE + loopback redirect on 127.0.0.1. Client ID is configured via settings/env (the user creates it in Google Cloud). REST: `threads.list`/`messages.get` (metadata first, full on demand), `history.list` for incremental, `messages.send` raw, `modify` labels for archive/spam/trash/star. Native `threadId`.
- Secrets (IMAP passwords, OAuth refresh tokens, AI keys) are stored with Electron `safeStorage` (Keychain-backed), encrypted blobs in SQLite. The backend asks main to decrypt over IPC.
- **Pending ops**: `{archive, trash, spam, move, markRead, star, send, saveDraft}` per account. Exponential backoff; idempotent ops; failures surface in the UI.

## 8. Agent integration: SKILL vs MCP (decision)

**Recommendation: MCP as the primary integration, with a SKILL.md on top.**
- MCP works the same in Claude Code and Codex, has typed tools, and needs no per-agent glue. The SKILL teaches Claude Code *when/how* to use the tools, query syntax, and etiquette (e.g. never send without confirmation).
- `unica-mcp` = `ELECTRON_RUN_AS_NODE=1 <Única.app binary> <resources>/mcp.cjs`. A wrapper script is shipped in the app's Resources. Settings → "Agents" shows copy-paste commands: `claude mcp add unica -- …` / a Codex `config.toml` snippet.
- It opens the same SQLite file (WAL lets it read concurrently). Mutations write the DB + `pending_ops` using the same repository code; the running app picks them up via `PRAGMA data_version` polling (cheap) and syncs them.
- Tools: `list_accounts`, `search_emails(query, limit, cursor)`, `get_thread(id)`, `list_categories`, `set_category`, `archive`, `trash`, `mark_read`, `create_draft`, `send_email` (disabled unless the user enables "allow agents to send"; otherwise creates a draft), `list_filters`, `create_filter`.
- A JSON CLI (`unica-mcp cli search "from:x"`) is a fallback for skill-only use.

## 9. Design system

Base: **shadcn/ui** (Tailwind v4, CSS-variable theming, oklch) installed into `packages/ui`. We keep shadcn's component APIs and token names (`--background`, `--foreground`, `--primary`, `--muted`, `--accent`, `--border`, `--ring`, `--sidebar-*`...) and only re-theme values and add a few email-specific tokens. No ad-hoc colors in app code; lint/grep checks enforce token usage.

**Personality:** calm, paper-like, typographic, quiet chrome; content first. Inspired by Superhuman's keyboard-speed, Apple Mail's restraint, and Linear's density/precision.

- **Type:** Geist Variable (UI) + Geist Mono Variable (counts, shortcuts, metadata). Bundled offline via @fontsource-variable. Dense scale: 11/12/13/14/16/20/24. The list uses 13px.
- **Color (light):** warm paper neutrals (hue ≈ 85, chroma ≤ 0.006).
  - background `oklch(0.99 0.002 85)`; sidebar slightly darker translucent `oklch(0.965 0.004 85 / 0.8)` over vibrancy; foreground ink `oklch(0.22 0.01 265)`; muted-foreground `oklch(0.52 0.01 265)`; border `oklch(0.91 0.004 85)`.
  - Single accent **"Única indigo"** `oklch(0.56 0.19 268)` used for primary, ring, unread dot, and selection.
  - Destructive `oklch(0.58 0.21 25)`.
- **Color (dark):** background `oklch(0.17 0.006 265)`, sidebar `oklch(0.2 0.006 265 / 0.75)`, foreground `oklch(0.95 0.004 85)`, accent `oklch(0.7 0.16 268)`.
- **Category palette:** 8 muted hues at equal lightness/chroma (L 0.68, C 0.12): rose, amber, lime, emerald, cyan, indigo, violet, slate. Used as dots and soft badges (`/15` bg).
- **Shape/elevation:** `--radius: 0.5rem`. Hairline borders, almost no shadows (popovers and dialogs only). Selection = accent-tinted row background `--accent/10` plus a 2px accent rail.
- **Motion:** 120–180 ms ease-out on overlays only. List navigation and view switches are **instant** (no animation). Respects `prefers-reduced-motion`.
- **Layout:** 3 panes. Sidebar 232px (views, categories, accounts, filters), thread list 400px (resizable, 64px two-line rows: sender · date / subject — snippet, category dots, unread dot), reader (max-width 760px). Action toolbar in the reader: Reply (r), Reply all (a), Forward (f), Archive (e), Delete (#), Spam (!), Category (l/v), Mark unread (u), Star (s).
- **Keyboard first:** `j/k` move, `enter/o` open, `e #`, `/` search, `c` compose, `⌘K` command palette (cmdk), `g i/g s/g a`, `x` select, `⌘Enter` send, `esc` back. Rendered as `kbd` hints in tooltips/palette.
- Components from shadcn: button, input, textarea, dialog, sheet, dropdown-menu, context-menu, popover, tooltip, command, badge, separator, scroll-area, tabs, switch, select, toggle-group, sonner (toasts), resizable, skeleton, avatar, kbd. Plus custom: `ThreadRow`, `MailToolbar`, `CategoryDot`, `RuleChip`, `ShortcutHint`.
- HTML email body renders in a **sandboxed iframe** (`srcdoc`, sanitized with DOMPurify, `sandbox="allow-popups allow-popups-to-escape-sandbox"`, CSP blocking scripts). Remote images are blocked by default with a "load images" bar (privacy/tracking). Links open in the system browser.

## 10. Renderer performance plan

- React 19 + **React Compiler** (no manual memo). Zustand for UI state with per-row selectors (`useStore(s => s.selectedId === id)`), so moving the selection re-renders 2 rows, not the list.
- Thread list: `@tanstack/react-virtual`, fixed 64px rows, overscan 8, keyset pages of 100 prefetched when 50 rows from the end. Row components are cheap (no Radix inside rows, no per-row tooltips).
- Data cache: a small query store keyed by `(view, query)` with stale-while-revalidate. Backend pushes `changed{threadIds, views}` events; affected pages are refetched.
- Reader: thread bodies prefetched for neighbors, LRU 200; iframe reused and only `srcdoc` swapped.
- Keyboard handler at document level with a pure resolver (`core/keybindings`), no per-component listeners.
- Bundle: initial chunk < 300 KB gz; lazy-load compose editor, settings, filter builder.

## 11. Testing strategy (meaningful tests only)

1. **Pure logic (core):** search parser (operators, quotes, negation, unicode/diacritics), rule evaluation, learning heuristics (thresholds, decay, conflicting signals), keybinding resolver, threading algorithm (References chains, broken chains, subject fallback).
2. **DB integration (real node:sqlite, temp files):** migrations from scratch, repositories, counters triggers vs ground truth, FTS correctness (accents, prefixes, operators), **rule JS-vs-SQL parity** over 5k mock messages, keyset pagination (no dupes/gaps under concurrent inserts), `EXPLAIN QUERY PLAN` assertions (no full scans on hot queries).
3. **Providers:** SMTP send against a real in-process `smtp-server`; Gmail sync/ops against a fake Gmail HTTP server (pagination, history, 401 refresh, 429 backoff); IMAP sync against a fake imapflow-compatible adapter (UIDVALIDITY reset, new mail, deletions); pending-ops retry/backoff/idempotency.
4. **MCP:** an in-memory MCP client calls tools against a seeded DB; checks results and that mutations land in `pending_ops`; send gating.
5. **Performance (budgets):** seeded **50k messages / ~20k threads / 8 accounts**. p50/p95 over N runs after warmup, for: inbox first page, deep page (keyset), account filter, category filter, unread counts, FTS search (common/rare/prefix/operators), open thread, filter preview, suggestions. Budgets ~2–3× targets to stay non-flaky; plan assertions are deterministic. RPC payload byte budgets per page.
6. **E2E + visual (Playwright):** web renderer against backend-dev with seeded mock data. Flows: triage with keyboard, search, open/reply/reply-all/forward/send (captured by local SMTP), categories + "move similar", AI filter builder (Fake AI) with preview + apply, learned-filter suggestion accept, add IMAP account form, settings/agents. `toHaveScreenshot` baselines in light + dark.
7. **UI perf (Playwright):** hold `j` across 500 threads and assert per-keystroke selection→paint p95 < 16 ms; type a query and measure keystroke→results painted p95 < 100 ms; DOM row count stays bounded.
8. **Electron smoke:** Playwright `_electron` launches the **packaged arm64 app** with a demo seed, checks the inbox renders, search works, the backend process is alive, and opening a message works.

## 12. Plan review with Codex

(to be filled with the discussion outcome)

## 13. Milestones

1. Monorepo scaffold, tooling, CI scripts
2. `core` (types, rpc, search parser, rule engine, learning, keybindings) + tests
3. `db` (schema, migrations, repos, FTS, search compiler, counters) + tests + perf tests
4. `mock-data` generator
5. `backend` service + RPC handlers + backend-dev (WebSocket)
6. `ui` design system (shadcn + tokens)
7. `web` renderer: layout, list, reader, search, keyboard, compose, categories, filters, AI builder, settings
8. `desktop`: Electron main/preload/utility process, app:// protocol, safeStorage, packaging
9. `mail` providers (SMTP, IMAP, Gmail) + sync + pending ops
10. `ai` providers + `mcp` server + SKILL
11. Playwright e2e/visual/UI-perf + Electron smoke on the packaged app
12. Codex review rounds → fixes
