# Architecture

The full technical plan, and the design review held with Codex before implementation, live in [`PLAN.md`](PLAN.md). Storage adapters are described in [`STORAGE.md`](STORAGE.md).

## Overview

```
Renderer (React 19, sandboxed) ──MessagePort──▶ Backend (Electron utilityProcess)
                                                 ├─ MailStore → node:sqlite (WAL, FTS5, search outbox), sole writer
                                                 │    └─ instant search index (RAM, fed by the outbox)
                                                 ├─ ops queue → IMAP / SMTP / Gmail
                                                 └─ unix socket ◀── terno-mcp (Claude Code / Codex)
Main process: windows, app:// protocol, Keychain (safeStorage)

Web: Page ──MessagePort──▶ Dedicated Worker (the tab holding the Web Lock)
                            ├─ the same Backend → MailStore on SQLite-WASM (OPFS) or IndexedDB
                            │    └─ instant search index (snapshot in OPFS)
                            └─ Gmail over REST (CORS) · secrets: WebCrypto
```

- **SQLite via `node:sqlite`:** no native modules. Tests run the same SQLite build the app ships.
- **Every action is local-first.** The optimistic state and a durable op are written in one transaction, and the op worker syncs to the provider afterwards. A send whose outcome is ambiguous is marked *unknown* and never resent automatically.
- **Search** answers from an in-memory instant index (typed-array postings, a newest-first walk over threads) whenever it is exactly at the database's revision, and from a selectivity-based planner over FTS5 otherwise (while it builds or catches up after a write), with identical results. Message predicates (`from:`, words, `has:attachment`, dates) must all match the *same* message. A comma means any of (`acme.test,acme.studio`, `from:ana,bob`), and a bare email address finds mail where it is the sender or a recipient, several of them any of those (plan 140).
- **Background work** (imports, bulk filters) runs in ~8 ms adaptive slices, and WAL checkpoints run on a worker thread, so typing and navigation never stall. Once the WAL passes 16 MB, bulk slices wait (asynchronously) for the checkpoint to catch up so the WAL starts over: back-to-back slices otherwise grew it by gigabytes, and the commit that finally restarted it truncated the file on the backend's thread.

## Repository layout

```
apps/desktop      Electron main/preload/utility backend, packaging, packaged-app smoke tests
apps/web          Renderer (React 19 + Vite + Tailwind v4), Playwright e2e/visual/perf; VITE_TARGET=web adds the web host
                  (src/web: backend worker, Web Locks, service worker, Gmail sign-in, gating) and e2e-web
apps/backend-dev  WebSocket host of the backend for browser dev and e2e
packages/core     Pure domain: types, typed RPC, search parser, filter DSL, learning, keybindings
packages/store    MailStore and search contracts (async store commands, revisions, search feed), the instant search engine + adapter and engine conformance suites
packages/db       SQL layer and SqlMailStore: connection seam, node:sqlite and SQLite-WASM drivers, schema, FTS, planner, rule compiler, ops, outbox, perf gate
packages/idb      IdbMailStore: the MailStore on native IndexedDB
packages/backend  Service layer: RPC handlers, ops worker, sync, filters, agent socket
packages/mail     IMAP (imapflow), SMTP (nodemailer), Gmail (REST + OAuth), MIME
packages/ai       AI transports (Anthropic, OpenAI-compatible incl. Ollama/LM Studio/Azure), structured-output ladder, discovery, offline fake
packages/mcp      MCP server + SKILL.md
packages/ui       Design system: shadcn (Base UI) re-themed with Terno tokens
packages/mock-data Deterministic mock mailbox generator
```
