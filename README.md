<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/terno-lockup-white.svg" />
    <img src="brand/terno-lockup.svg" alt="Terno" height="48" />
  </picture>
</h1>

> **Your mail, made to measure.**

Terno is a minimalist, keyboard-first, extremely fast desktop email client for macOS (Apple Silicon first), with a web version that runs the same backend in your browser. Features:

- Unlimited accounts: Gmail via OAuth, plus any IMAP/SMTP server.
- Categories that span accounts, with smart categorization: Terno learns from how you file (sender, list, domain and content, all on this Mac, no AI needed), files new mail on its own only when it is sure and says why, suggests the rest, and after every filing offers "everything from this sender / about these topics" in one keystroke, all undoable.
- Filters built with AI from a plain-language description, then refined in a visual editor. The AI can run on this Mac (Ollama, LM Studio, any local OpenAI-compatible server) or in the cloud with your own key (Claude, OpenAI, OpenRouter, Groq, Together, Azure).
- **Local mode** (on for new installs): nothing leaves the Mac except mail with your own servers.
- Filters learned from what you archive.
- Drag one or many conversations onto a category to move them there (out of every other category); the same undoable snackbar as the `l` picker.
- A right-click menu on a conversation or a selection (read/unread, star, archive, delete, spam, categories with checkmarks, "Move to…", everything from a sender, a filter from them), selection with ⌘A, ⌘/⇧-click and ⇧J/K, the usual triage keys (⌫, ⇧I, ⇧U, ⌘⇧U, ⌃⌘A, z…), and "select all N conversations" that the backend applies to a whole view in slices, with progress and undo ([plan 06](docs/plans/06-context-menu-selection.md)).
- A quiet, Apple-Mail-like interface: conversations without boxes (hairlines and faint surfaces), replies and new messages written in place (no dialogs), drafts that are never lost (saved as you type, restored after a restart).
- Three styles ([plan 15](docs/plans/15-design-themes.md)): **Lumen** (the default: warm and people-first, Figtree, big avatars, a greeting, filter chips), **Atelier** (editorial: Instrument Serif titles, ink and paper) and **macOS** (Apple Mail-like, compact, SF). Each has its own type, shapes, density and layout, and its own colors in light and dark; the 17 color themes (Terno, Apple, Solarized, Gruvbox, GitHub, Catppuccin, Dracula, Monokai, Tokyo Night, Nord, Lumen, Atelier) and your own JSON ones work in any style, all checked for WCAG AA contrast; animations you can set to 0/50/75/100 ms (Settings → Appearance); reduced transparency respected.
- Quick filters: unread (⌘L), with attachments, starred, per mailbox, from the "Filtered by" menu or Lumen's chips.
- An MCP server so **Claude Code** and **Codex** get one access point to all your email.
- Printing and PDF (⌘P, ⇧⌘P, File, the reader's printer button, or a right-click on a conversation or a single message): with headers or just the content, quoted history hidden or kept, Letter or A4, previewed as the exact page that prints; wide mail is fitted to the page and nothing leaves the Mac ([plan 09](docs/plans/09-print.md)).
- Settings (⌘, or the gear, or "Settings → …" in ⌘K) where everything shown can be changed: per-account name, sender name, color, signature, sync window, reconnect and removal; categories renamed, recolored, reordered and deleted; filters; themes including your own JSON ones; the MCP token; export and import ([plan 08](docs/plans/08-settings-pass.md)).

The technical plan, and the design review held with Codex before implementation, live in [`docs/PLAN.md`](docs/PLAN.md).

## Quick start

```bash
pnpm install            # Node 24+, pnpm 12
pnpm dev                # backend (WebSocket, demo mailbox) + renderer at http://localhost:5173
pnpm dist:mac           # → apps/desktop/release/mac-arm64/Terno.app and Terno-<v>-arm64.dmg
pnpm brand              # every icon (app, Tahoe, DMG, favicons, the in-app mark) from the logo in brand/ (macOS, Xcode 26)

pnpm dev:desktop         # Electron + Vite HMR on your real profile
pnpm dev:desktop:demo    # separate profile with the ~3k-thread demo mailbox
pnpm dev:desktop:seeded  # 8 accounts / ~21k messages, seeded once (--reseed to regenerate)

pnpm dev:web             # the web build with a demo mailbox seeded into OPFS on first load: http://127.0.0.1:5175
pnpm build:web           # → apps/web/dist-web, a static site (any static host)
```

- **Demo mode:** launch the packaged app with a demo mailbox: `TERNO_DEMO=1 open apps/desktop/release/mac-arm64/Terno.app`. The data is a deterministic set of ~3,000 Spanish/English conversations across 4 accounts.
- **Gmail:** create a Google Cloud OAuth client of type *Desktop app* with the Gmail API enabled. Paste its client ID in Settings → Accounts, then use "Continue with Google". On the web, use a client of type *Web application* with the site's origin as an authorized JavaScript origin.

## Terno on the web

The same renderer, built as a static site: the backend (the same code as the Mac app's) runs in a dedicated Web Worker on SQLite-WASM over OPFS, with the same migrations, FTS5 and instant search index, and talks to the page over the same MessagePort RPC.

- **One tab owns the mailbox** (Web Lock). Another tab waits and can take over: the mailbox goes to the tab that asked, after the owner closed every storage handle; a tab that fails to start gives it up. Those screens are modal (focus, the app behind them inert, shortcuts suspended). A newer build in another tab, or a mailbox already migrated by one, asks to reload instead of touching the data. An error opening the mailbox is shown as such: Terno never starts an empty mailbox in its place.
- **Storage adapters** are plug-and-play ([`docs/STORAGE.md`](docs/STORAGE.md)): SQLite on OPFS by default, a native IndexedDB store (`?storage=idb`, and automatically where OPFS isn't available).
- **Gmail** signs in with Google's browser flow and your own client ID. Without a server there is no refresh token: access lasts an hour and isn't stored, so after a reload or an hour Terno asks you to reconnect with one click. Queued actions and sends wait for it however long it takes, without spending their retries, and go out as soon as you reconnect (the same applies on the Mac when Google revokes a sign-in).
- **Storage:** Terno asks the browser to keep its storage persistent and says in Settings → Data whether it did. If not, the browser may evict the mailbox under pressure (or after Safari's 7 days): mail re-syncs, but categories, filters, settings and unsent work don't, so the same tab exports them as JSON and imports them back. It also switches the engine (SQLite on OPFS or IndexedDB), carrying settings, categories, filters and drafts across; the other engine's mailbox stays where it was.
- **What needs the Mac app:** IMAP/SMTP accounts (a browser can't open those connections), the MCP server for Claude Code and Codex, and sync with the window closed. The app says so where it matters, and suggests the Mac app once (first run, one dismissible line above the list, Settings → General).
- **Local mode in the browser** allows only Google (your mail) and AI on this computer (literal localhost), refuses redirects for those requests, and can't pin DNS or control other tabs and extensions; the settings say exactly that.
- **AI with your own key** runs from the tab's worker, through the same network policy: the SDKs are told they may run in a browser (the key is yours and stays on this device), and Claude gets the `anthropic-dangerous-direct-browser-access` header its API requires from a page. OpenAI, OpenRouter, Groq, Together and Azure OpenAI answer browser requests (CORS); Ollama and LM Studio only answer origins you allow, so Terno says how (`OLLAMA_ORIGINS=<this site>`, LM Studio's «Enable CORS»). A request carrying your key never follows a redirect (a browser would re-send a header like Azure's `api-key` to wherever it points).
- **Secrets** (Gmail sessions, AI keys) are sealed with AES-GCM under a non-extractable WebCrypto key kept in IndexedDB. A service worker serves the shell, worker and WASM of one build, so reloads work offline and an update is a single "Reload".

## AI providers and local mode

- **Settings → AI** picks the provider. Local servers are discovered automatically (model, size, context, loaded state); *Test connection* checks latency and whether the model supports structured output, JSON mode or only text, and the app adapts.
- API keys are encrypted with the macOS Keychain and never reach the renderer (it only sees the last 4 characters).
- For filters, the AI receives your description, account emails and names, category names and today's date — never message content.
- **Local mode** (Settings → General, first row; "Local" pill in the sidebar): the backend's network policy allows only mail with your servers and AI on loopback (resolved and pinned), main blocks the renderer's remote requests, and remote images stay off. Turning it off asks first. Existing installs keep local mode off until you turn it on.
- **Your Terno account**: the first verified mailbox becomes the owner of this install (shown in Settings → Accounts). Removing that mailbox keeps it; changing it requires verifying the new mailbox again.

## Architecture (short version)

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
- **Search** answers from an in-memory instant index (typed-array postings, a newest-first walk over threads) whenever it is exactly at the database's revision, and from a selectivity-based planner over FTS5 otherwise (while it builds or catches up after a write), with identical results. Message predicates (`from:`, words, `has:attachment`, dates) must all match the *same* message.
- **Background work** (imports, bulk filters) runs in ~8 ms adaptive slices, and WAL checkpoints run on a worker thread, so typing and navigation never stall. Once the WAL passes 16 MB, bulk slices wait (asynchronously) for the checkpoint to catch up so the WAL starts over: back-to-back slices otherwise grew it by gigabytes, and the commit that finally restarted it truncated the file on the backend's thread.

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
| "Select all N" archive of 18,792 threads, its undo: longest stall · list RPC | ≤ 50 ms · ≤ 20 ms | ~24 ms · ~0.5 ms |
| Exclusive move of 5,000 threads (in 1 or 20 categories each), its undo: longest stall | ≤ 50 ms | ~15 ms · ~35 ms |
| Count a 47,000-thread category · mark it all read: longest stall | ≤ 25 ms · ≤ 50 ms | ~7 ms · ~36 ms |

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
| Right-click → context menu painted | ≤ 50 ms | ~9 ms p50, ~13 ms p95, 0 row renders |
| ⌘A over 500 loaded rows → committed | ≤ 16 ms | ~1.6 ms, only the rows that changed render; a toggle renders 1 row |
| `j` at key repeat (30/s, 300 presses, both densities, drafts present): frame interval · longest frame | ≤ 20 ms · ≤ 50 ms | 16.7 ms · ≤ 33 ms, 0 long frames, ~3 row renders per move |
| Continuous scroll across 2,000 threads (3 s fling, both densities): frame interval · longest frame | ≤ 20 ms · ≤ 50 ms | 16.8 ms · 16.8 ms |
| Expanding 19 messages of a conversation (5 HTML): frame interval · longest frame | ≤ 20 ms · ≤ 50 ms | 16.8 ms, nothing left mounted when collapsed |
| Inline reply: keypress → first frame showing it · that frame → expansion done | ≤ 50 ms · ≤ 133 ms | ~15 ms · ~115–126 ms |
| Print document for a 100-message conversation → built | ≤ 30 ms | ~9 ms |

**Packaged app** (`pnpm test:smoke`): about 0.5 s from a warm start to the first mail painted.

**On the web** (`pnpm test:web-perf`, Chromium, real OPFS/IndexedDB in a persistent profile, timed in the page through the worker RPC; p95 at ~50k messages, load average 5–10 during the runs):

| What | Budget | SQLite on OPFS | IndexedDB |
|---|---|---|---|
| Repeat visit → first mail painted | ≤ 700 ms (IndexedDB ≤ 900) | ~280 ms | ~680 ms |
| List first / deep page | ≤ 2 ms | 0.7 / 0.8 ms | 0.2 / 0.2 ms |
| Category view · counts · open | ≤ 6 ms (IndexedDB ≤ 4) | 1.7 · 3.9 · 0.2 ms | 0.4 · 0.8 · 0.1 ms |
| Search (instant index) | ≤ 25 ms | ≤ 1.9 ms | ≤ 8 ms |
| Search, durable path alone | ≤ 25 ms (FTS5 1 char ≤ 60; exact scan ≤ 1.5 s) | FTS5 ≤ 9.3 ms (1 char ~38 ms) | exact scan ≤ 1.5 s, in ≤ 8 ms slices |
| Action commit | ≤ 16 ms | ~11.5 ms | ~11 ms (15–29 ms under load) |
| Filter preview over all mail | ≤ 50 ms (IndexedDB ≤ 600) | ~20 ms | ~46 ms |
| Keystroke → results rendered | ≤ 100 ms | ~19 ms | ~18 ms |

Cold first visit to an interactive shell: ~0.3–0.5 s. Seeding the 50k demo mailbox in the worker: ~15 s on OPFS, ~13–18 s on IndexedDB.

## Tests

```bash
pnpm test               # correctness: unit + integration (project unit) and the db suite on SQLite-WASM (db-wasm);
                        # includes the i18n guard (no hard-coded UI strings outside the catalog)
pnpm test:perf          # performance gates alone (project perf, one file at a time): never run them beside other suites
pnpm test:e2e           # Playwright flows + visual regression (apps/web, against backend-dev)
pnpm test:ui-perf       # renderer perf in Chromium (j-key, keystroke → results, scroll, theme, drag)
pnpm test:smoke         # Playwright against the PACKAGED arm64 app (run dist:mac first)
pnpm test:web           # the web build in Chromium: worker on OPFS, takeover, open errors, offline, gating,
                        # Gmail via Google's flow (stubbed), and the store/engine conformance suites inside a worker
pnpm test:web-perf      # web budgets at 10k and 50k messages on OPFS (WEB_PERF_STORAGE=idb for IndexedDB,
                        # WEB_PERF_DURABLE=1 for the durable search path alone)
```

What the tests cover:

- One store conformance suite for every adapter: node:sqlite, SQLite-WASM (in Node, and on OPFS in a Chromium worker) and IndexedDB (fake-indexeddb in Node, and real IndexedDB in Chromium); the whole db suite also runs on SQLite-WASM (`db-wasm`).
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
- Printing from real PDFs: every print fixture (long quoted threads, inline replies, a newsletter, a 1000px table, CJK and emoji, long URLs, images, a hostile subject) exported through Chromium on the web and through Electron's `printToPDF` in the packaged app, read back with pdfjs-dist (page size, text present and absent, footer, nothing outside the printable box) and compared against rendered-page baselines.

## Languages

Terno's interface is in English, and in Spanish when you choose Español (Settings → General → Language) or your system is in Spanish ("System", the default). The switch is immediate, menus included. Every string lives in [`packages/i18n`](packages/i18n): `locales/en.ts` is the source of truth, and `t("key", params)` (UI, desktop main) and `L("key", params)` (the backend: errors and reasons travel as keys, the renderer translates them) are typed against it, so a wrong key or a missing placeholder doesn't compile. Messages are plain strings with `{name}` placeholders, plural objects (`{ one: "# conversation", other: "# conversations" }`, chosen with `Intl.PluralRules`) and `<b>…</b>`-style tags for rich text. Dates and numbers come from `Intl` in the active locale. Only the active language is loaded (English is bundled; others load when chosen).

### Adding a language

1. Copy `packages/i18n/src/locales/es.ts` to `locales/xx.ts` (`xx` = the language code) and translate the values. Keep every key, every `{placeholder}`, every `<tag>`, and the plural objects (add the forms your language needs: `zero`, `one`, `two`, `few`, `many`, `other`).
2. Add one line to `packages/i18n/src/locales/index.ts`: `xx: { name: "<the language's own name>", tag: "xx-YY", load: async () => (await import("./xx")).default },`.
3. `pnpm typecheck` lists anything missing, extra or mismatched (`xx.ts` ends with `satisfies LocaleCheck<typeof xx>`), and `pnpm test` checks it again at runtime. Optionally give it its own date formats in `apps/web/src/lib/format.ts` (otherwise the locale's defaults apply).

The language then appears in Settings → General, "System" picks it on systems in that language, and English remains the fallback for anything missing.

## Styles (designs)

A style is one file in [`packages/ui/src/designs/`](packages/ui/src/designs) (`lumen.ts`, `atelier.ts`, `macos.ts`): fonts, the text scale, the radius ladder, type roles (list title, greeting, section labels, rows, the reader's subject…), icon stroke, layout widths, row heights, avatar sizes, surfaces and a closed set of structural variants (where compose lives, the list header, search, filters, the row, the category review, the reader header, the reply control). Its type has no optional member. `pnpm --filter @terno/ui gen:designs` writes the `[data-design]` CSS; colors stay in the palettes (`themes/registry.ts`), and a style only names the pair "Style colors" uses. See AGENTS.md → "Designs" to change or add one.

## Diagnostics and error reports

Every process logs structured lines (a dotted code plus typed, allowlisted fields; never free text, not even error messages), leaves breadcrumbs, and records unexpected errors and crashes. Reports go to Sentry only from builds given a DSN, never in local mode, and only as the user chose (Settings → General → Diagnostics: Ask, Always or Never). [Plan 10](docs/plans/10-observability.md) has the design and the privacy rules.

**Where things live (desktop, under the profile, `~/Library/Application Support/Terno`):**

| Path | What |
|---|---|
| `logs/{main,backend,renderer,mcp}.jsonl` (+ `.1`…`.4`) | one JSON line per entry: `{ts, level, proc, code, fields, session, version, build, err?}` (`err`: class, code, status, frames); 2 MB × 5 per process (UTF-8 bytes), 0600 |
| `crashes/<ts>-<proc>-<id>.json` | records of unexpected errors, crashes, dead renderers/backends and unclean exits (64 KB each, 20 at most, 30 days) |
| `crashes/rings.json` | the last breadcrumbs of every live process (so a hard crash still has its trail) |
| `crashes/native/` | Electron crash dumps; never uploaded, exported only when ticked |
| `diag/state.json`, `diag/running` | install id, reports seen/sent, last policy; the run marker |

Help → Show Logs opens the folder; Help → Export Diagnostics… (or the Settings row) writes a validated `.zip`. The web build keeps a 2,000-entry ring in IndexedDB (`terno-diag`) and exports JSON.

**Configuring Sentry:**

```bash
# reports on: the DSN is baked in at build time (public by design: it can only submit events)
TERNO_SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project> pnpm dist:mac
TERNO_SENTRY_DSN=… pnpm build:web          # the web build reports from the page (@sentry/browser)

# source maps: every bundle gets a debug id; maps are archived outside the app in
# apps/desktop/.maps/<version>-<sha>/ (web: apps/web/.maps/<build>/) and uploaded when a token is set
SENTRY_AUTH_TOKEN=… SENTRY_ORG=<org> SENTRY_PROJECT=<project> TERNO_SENTRY_DSN=… pnpm dist:mac

# a local crash record (or one from a user's export) back to source lines, offline
pnpm diag:symbolicate path/to/crashes/<record>.json [--maps <archive dir>]
```

Builds without `TERNO_SENTRY_DSN` (dev, forks) never load the reporter. Release names are `terno@<version>+<sha>`, taken from the record (a crash kept across an upgrade reports the build that crashed). Server-side scrubbing in the Sentry project is a good extra, but nothing in a report needs it: there is no message, no address and no path in one ("What gets sent" shows the exact event).

## Agents (MCP + Skill)

With Terno running:

```bash
claude mcp add terno -- /Applications/Terno.app/Contents/Resources/bin/terno-mcp
```

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.terno]
command = "/Applications/Terno.app/Contents/Resources/bin/terno-mcp"
```

Available tools:

- `list_accounts`
- `search_emails`
- `list_threads`
- `get_thread`
- `update_threads`
- `categorize`
- `create_draft`
- `send_email`: only works when the user enables it in Settings → Agents (where "Change token" also cuts off every connected agent).
- `list_filters`
- `create_filter`: supports a dry run.

[`packages/mcp/SKILL.md`](packages/mcp/SKILL.md) teaches Claude Code the search syntax and etiquette.

## Upgrading from Única

Terno was called Única. The first launch of Terno carries everything over by itself ([PLAN §14](docs/PLAN.md#14-rename-única--terno)):

- **Mac:** `~/Library/Application Support/Unica` becomes `…/Terno` (renamed, never copied; quit Única first) and `unica.db` becomes `terno.db`. Passwords, tokens and API keys sealed in the Keychain as "Única Safe Storage" are sealed again under Terno's item (macOS may ask once whether Terno may use the old item). Anything that can't be opened stays where it was and Settings asks you to enter it again. The dev profiles `Unica-dev-seeded`/`Unica-dev-demo` are renamed on their next `pnpm dev:desktop:*`.
- **Web:** the mailbox, its key store, caches and settings move from Única's storage names to Terno's in the browser, and a tab still running the old build hands the mailbox over.
- **Variables:** `UNICA_*` still work for one release (with a warning); use `TERNO_*`.
- **Agents:** re-add the MCP server with the commands above (or in Settings → Agents) and copy the skill to `~/.claude/skills/terno`.

## Layout

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

## License

Terno is **source-available** under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

- **Allowed:** reading the code, running it, and forking or changing it for your own personal, noncommercial version, including sharing that version noncommercially under the same license and with the `Required Notice` line. Use by charities, schools, public research and government bodies is also permitted.
- **Not allowed:** any commercial use, such as selling Terno or a fork, offering it as a paid product or service, or using it inside a business for commercial advantage.

To use Terno commercially, contact the author for a separate license.

The bundled fonts (Geist, Geist Mono, Figtree, Instrument Sans and Instrument Serif, from [Fontsource](https://fontsource.org)) are under the [SIL Open Font License 1.1](https://openfontlicense.org); their license texts ship in their packages.
