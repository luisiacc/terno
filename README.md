# Única

> **El único cliente de email que necesitas.**

Única is a minimalist, keyboard-first, extremely fast desktop email client for macOS (Apple Silicon first). Features:

- Unlimited accounts: Gmail via OAuth, plus any IMAP/SMTP server.
- Categories that span accounts, with smart categorization: Única learns from how you file (sender, list, domain and content, all on this Mac, no AI needed), files new mail on its own only when it is sure and says why, suggests the rest, and after every filing offers "todo de este remitente / sobre estos temas" in one keystroke, all undoable.
- Filters built with AI from a plain-language description, then refined in a visual editor. The AI can run on this Mac (Ollama, LM Studio, any local OpenAI-compatible server) or in the cloud with your own key (Claude, OpenAI, OpenRouter, Groq, Together, Azure).
- **Local mode** (on for new installs): nothing leaves the Mac except mail with your own servers.
- Filters learned from what you archive.
- Drag one or many conversations onto a category (⌥ moves them out of the current one); the same undoable snackbar as the `l` picker.
- 13 themes (Única, Apple, Solarized, Gruvbox, GitHub, Catppuccin, Dracula, Monokai, Tokyo Night, Nord) with a light and a dark choice for system mode, your own themes as JSON, all checked for WCAG AA contrast; animations you can set to 0/50/75/100 ms (Ajustes → Apariencia).
- An MCP server so **Claude Code** and **Codex** get one access point to all your email.

The technical plan, and the design review held with Codex before implementation, live in [`docs/PLAN.md`](docs/PLAN.md).

## Quick start

```bash
pnpm install            # Node 24+, pnpm 12
pnpm dev                # backend (WebSocket, demo mailbox) + renderer at http://localhost:5173
pnpm dist:mac           # → apps/desktop/release/mac-arm64/Unica.app and Unica-<v>-arm64.dmg

pnpm dev:desktop         # Electron + Vite HMR on your real profile
pnpm dev:desktop:demo    # separate profile with the ~3k-thread demo mailbox
pnpm dev:desktop:seeded  # 8 accounts / ~21k messages, seeded once (--reseed to regenerate)
```

- **Demo mode:** launch the packaged app with a demo mailbox: `UNICA_DEMO=1 open apps/desktop/release/mac-arm64/Unica.app`. The data is a deterministic set of ~3,000 Spanish/English conversations across 4 accounts.
- **Gmail:** create a Google Cloud OAuth client of type *Desktop app* with the Gmail API enabled. Paste its client ID in Ajustes → Cuentas, then use "Continuar con Google".

## AI providers and local mode

- **Ajustes → IA** picks the provider. Local servers are discovered automatically (model, size, context, loaded state); *Probar conexión* checks latency and whether the model supports structured output, JSON mode or only text, and the app adapts.
- API keys are encrypted with the macOS Keychain and never reach the renderer (it only sees the last 4 characters).
- For filters, the AI receives your description, account emails and names, category names and today's date — never message content.
- **Local mode** (Ajustes → General, first row; "Local" pill in the sidebar): the backend's network policy allows only mail with your servers and AI on loopback (resolved and pinned), main blocks the renderer's remote requests, and remote images stay off. Turning it off asks first. Existing installs keep local mode off until you turn it on.
- **Tu cuenta Única**: the first verified mailbox becomes the owner of this install (shown in Ajustes → Cuentas). Removing that mailbox keeps it; changing it requires verifying the new mailbox again.

## Architecture (short version)

```
Renderer (React 19, sandboxed) ──MessagePort──▶ Backend (Electron utilityProcess)
                                                 ├─ MailStore → node:sqlite (WAL, FTS5, search outbox), sole writer
                                                 │    └─ instant search index (RAM, fed by the outbox)
                                                 ├─ ops queue → IMAP / SMTP / Gmail
                                                 └─ unix socket ◀── unica-mcp (Claude Code / Codex)
Main process: windows, app:// protocol, Keychain (safeStorage)
```

- **SQLite via `node:sqlite`:** no native modules. Tests run the same SQLite build the app ships.
- **Every action is local-first.** The optimistic state and a durable op are written in one transaction, and the op worker syncs to the provider afterwards. A send whose outcome is ambiguous is marked *unknown* and never resent automatically.
- **Search** answers from an in-memory instant index (typed-array postings, a newest-first walk over threads) whenever it is exactly at the database's revision, and from a selectivity-based planner over FTS5 otherwise (while it builds or catches up after a write), with identical results. Message predicates (`from:`, words, `has:attachment`, dates) must all match the *same* message.
- **Background work** (imports, bulk filters) runs in ~8 ms adaptive slices, and WAL checkpoints run on a worker thread, so typing and navigation never stall.

## Performance (measured, enforced by tests)

`pnpm test:perf` seeds **50k+ messages across 8 accounts** (realistic bodies, long threads, shared timestamps) and asserts p95 latencies against the product targets. Reports are written to `test-results/perf/*.json`.

| What | Target (p95) | Typical on M-series |
|---|---|---|
| Open a view / page deep with keyset | ≤ 5 ms | ~0.3 ms |
| Category view (5k threads) | ≤ 5 ms | ~2 ms |
| Sidebar unread counts | ≤ 5 ms | ~2.7 ms |
| Instant search, every keystroke of `p…presupuesto` (engine) | ≤ 2 ms cold · ≤ 1 ms warm | ≤ 0.2 ms · ≤ 0.1 ms |
| Instant search, phrases (incl. frequent words rarely adjacent) | ≤ 5 ms | 0.2–2 ms |
| Search RPC while typing (backend, end to end) | ≤ 5 ms | ~0.7 ms |
| Instant index: memory · background build · stalls while building | ≤ 64 MiB · reported · ≤ 16 ms | ~39 MiB · ~1.3 s · ≤ 12 ms |
| Full-text search on FTS5 (the fallback) | ≤ 25 ms | 0.05–20 ms |
| Filter preview over all mail | ≤ 50 ms | ≤ 30 ms |
| RPC round trip (list) | ≤ 3 ms | ~0.4 ms |
| Search **during** a 14k-message import + bulk filter | ≤ 45 ms | ~35 ms |
| Categorize a thread (20 categories) | ≤ 50 µs | ~30 µs |
| Snackbar counts: sender / domain / list · topic | ≤ 5 ms · ≤ 25 ms | ~1 ms · ~9 ms |
| 14k-message import with the categorizer on | ≤ 10% slower | ~6% |

**In the real renderer** (`apps/web/e2e/perf.spec.ts`, Chromium, production build, real backend):

| What | Target (p95) | Measured |
|---|---|---|
| Holding `j`: keydown → selection committed (300 presses) | ≤ 16 ms | ~1 ms |
| Search: keystroke → results rendered | ≤ 100 ms | ~9 ms p50, ~20 ms p95 |
| Scroll to the end → next 100 rows rendered | ≤ 150 ms | ~35 ms |
| DOM rows while scrolling 2,000 threads | bounded | ≤ 33 |
| Theme switch → painted (double rAF, so ≥ 2 frames) | ≤ 50 ms | ~35 ms, 0 row renders |
| Drag start: threshold move → ghost shown, targets measured | ≤ 16 ms | ~5 ms |
| Drag start: threshold move → the frame showing the ghost rendered | ≤ 1 frame (16.7 ms at 60 Hz) | ~6.5 ms |
| Drag: pointermove handler · row renders during a drag | ≤ 2 ms · 0 | ~0.1 ms · 0 |
| Drop → dot on the row | ≤ 16 ms | ~1 ms, 1 row render |

**Packaged app** (`pnpm test:smoke`): about 0.5 s from a warm start to the first mail painted.

## Tests

```bash
pnpm test               # unit + integration
pnpm test:perf          # performance gate
pnpm test:e2e           # Playwright flows + visual regression + UI perf (apps/web)
pnpm test:smoke         # Playwright against the PACKAGED arm64 app (run dist:mac first)
```

What the tests cover:

- Search results checked against a brute-force oracle over a seeded mailbox, for FTS5 and the instant engine alike (every page of 500 generated queries, mutation sequences, snapshot round-trips, damaged snapshots), and the two engines against each other.
- WCAG AA contrast for every theme (49 token pairs each), a generated-CSS drift check, and a scan that rejects literal colors and durations in app code.
- An offline categorization accuracy eval (AI off, network guarded) over an adversarial mailbox: auto-apply precision ≥ 0.97, recall ≥ 0.80; reports in `test-results/categorize/`.
- JS ↔ SQL filter-rule parity across hundreds of generated rules.
- Randomized consistency checks of thread aggregates.
- Query-plan assertions.
- Real `imapflow` against an in-process **ImapKit** IMAP server.
- `nodemailer` against an in-process SMTP server, including the "connection lost after DATA" case.
- Gmail against a fake Google that verifies PKCE.
- The MCP server end to end.

## Agents (MCP + Skill)

With Única running:

```bash
claude mcp add unica -- /Applications/Unica.app/Contents/Resources/bin/unica-mcp
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.unica]
command = "/Applications/Unica.app/Contents/Resources/bin/unica-mcp"
```

Available tools:

- `list_accounts`
- `search_emails`
- `list_threads`
- `get_thread`
- `update_threads`
- `categorize`
- `create_draft`
- `send_email`: only works when the user enables it in Ajustes → Agentes.
- `list_filters`
- `create_filter`: supports a dry run.

[`packages/mcp/SKILL.md`](packages/mcp/SKILL.md) teaches Claude Code the search syntax and etiquette.

## Layout

```
apps/desktop      Electron main/preload/utility backend, packaging, packaged-app smoke tests
apps/web          Renderer (React 19 + Vite + Tailwind v4), Playwright e2e/visual/perf
apps/backend-dev  WebSocket host of the backend for browser dev and e2e
packages/core     Pure domain: types, typed RPC, search parser, filter DSL, learning, keybindings
packages/store    MailStore and search contracts (async store commands, revisions, search feed), the instant search engine + adapter and engine conformance suites
packages/db       SQL layer and SqlMailStore: connection seam, node:sqlite driver, schema, FTS, planner, rule compiler, ops, outbox, perf gate
packages/backend  Service layer: RPC handlers, ops worker, sync, filters, agent socket
packages/mail     IMAP (imapflow), SMTP (nodemailer), Gmail (REST + OAuth), MIME
packages/ai       AI transports (Anthropic, OpenAI-compatible incl. Ollama/LM Studio/Azure), structured-output ladder, discovery, offline fake
packages/mcp      MCP server + SKILL.md
packages/ui       Design system: shadcn (Base UI) re-themed with Única tokens
packages/mock-data Deterministic mock mailbox generator
```
