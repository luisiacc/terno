# Única

> **El único cliente de email que necesitas.**

Única is a minimalist, keyboard-first, extremely fast desktop email client for macOS (Apple Silicon first). Features:

- Unlimited accounts: Gmail via OAuth, plus any IMAP/SMTP server.
- Categories that span accounts, with "add similar emails?" suggestions.
- Filters built with AI from a plain-language description, then refined in a visual editor. The AI can run on this Mac (Ollama, LM Studio, any local OpenAI-compatible server) or in the cloud with your own key (Claude, OpenAI, OpenRouter, Groq, Together, Azure).
- **Local mode** (on for new installs): nothing leaves the Mac except mail with your own servers.
- Filters learned from what you archive.
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
                                                 ├─ node:sqlite (WAL, FTS5), sole writer
                                                 ├─ ops queue → IMAP / SMTP / Gmail
                                                 └─ unix socket ◀── unica-mcp (Claude Code / Codex)
Main process: windows, app:// protocol, Keychain (safeStorage)
```

- **SQLite via `node:sqlite`:** no native modules. Tests run the same SQLite build the app ships.
- **Every action is local-first.** The optimistic state and a durable op are written in one transaction, and the op worker syncs to the provider afterwards. A send whose outcome is ambiguous is marked *unknown* and never resent automatically.
- **Search** uses a selectivity-based planner over FTS5 and partial indexes. Message predicates (`from:`, words, `has:attachment`, dates) must all match the *same* message.
- **Background work** (imports, bulk filters) runs in ~8 ms adaptive slices, and WAL checkpoints run on a worker thread, so typing and navigation never stall.

## Performance (measured, enforced by tests)

`pnpm test:perf` seeds **50k+ messages across 8 accounts** (realistic bodies, long threads, shared timestamps) and asserts p95 latencies against the product targets. Reports are written to `test-results/perf/*.json`.

| What | Target (p95) | Typical on M-series |
|---|---|---|
| Open a view / page deep with keyset | ≤ 5 ms | ~0.3 ms |
| Category view (5k threads) | ≤ 5 ms | ~2 ms |
| Sidebar unread counts | ≤ 5 ms | ~2.7 ms |
| Full-text search (common, rare, prefix, operators) | ≤ 25 ms | 0.05–20 ms |
| Filter preview over all mail | ≤ 50 ms | ≤ 30 ms |
| RPC round trip (list) | ≤ 3 ms | ~0.4 ms |
| Search **during** a 14k-message import + bulk filter | ≤ 45 ms | ~35 ms |

**In the real renderer** (`apps/web/e2e/perf.spec.ts`, Chromium, production build, real backend):

| What | Target (p95) | Measured |
|---|---|---|
| Holding `j`: keydown → selection committed (300 presses) | ≤ 16 ms | ~1 ms |
| Search: keystroke → results rendered | ≤ 100 ms | ~19 ms |
| Scroll to the end → next 100 rows rendered | ≤ 150 ms | ~35 ms |
| DOM rows while scrolling 2,000 threads | bounded | ≤ 33 |

**Packaged app** (`pnpm test:smoke`): about 0.5 s from a warm start to the first mail painted.

## Tests

```bash
pnpm test               # unit + integration
pnpm test:perf          # performance gate
pnpm test:e2e           # Playwright flows + visual regression + UI perf (apps/web)
pnpm test:smoke         # Playwright against the PACKAGED arm64 app (run dist:mac first)
```

What the tests cover:

- Search results checked against a brute-force oracle over a seeded mailbox.
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
packages/db       node:sqlite store: schema, FTS, planner, rule compiler, ops, perf gate
packages/backend  Service layer: RPC handlers, ops worker, sync, filters, agent socket
packages/mail     IMAP (imapflow), SMTP (nodemailer), Gmail (REST + OAuth), MIME
packages/ai       AI transports (Anthropic, OpenAI-compatible incl. Ollama/LM Studio/Azure), structured-output ladder, discovery, offline fake
packages/mcp      MCP server + SKILL.md
packages/ui       Design system: shadcn (Base UI) re-themed with Única tokens
packages/mock-data Deterministic mock mailbox generator
```
