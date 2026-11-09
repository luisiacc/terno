# Development

## Quick start

```bash
pnpm install            # Node 24+, pnpm 12
pnpm dev                # backend (WebSocket, demo mailbox) + renderer at http://localhost:5173
pnpm dist:mac           # → apps/desktop/release/mac-arm64/Terno.app and Terno-<v>-arm64.dmg
pnpm brand              # every icon (app, Tahoe, DMG, favicons, the in-app mark) from the logo in brand/ (macOS, Xcode 26)

pnpm dev:desktop         # Electron + Vite HMR on your real profile
pnpm dev:desktop:demo    # separate profile with the ~3k-thread demo mailbox
pnpm dev:demo-ai         # the demo mailbox with every AI feature already holding something, on real models (Dev mode);
                         # the first launch prepares it (~4 min, ~US$0.15), --fresh starts over: docs/AI-DEMO.md
pnpm dev:desktop:seeded  # 8 accounts / ~21k messages, seeded once (--reseed to regenerate)
pnpm dev:desktop --cleandb  # any of the three, from a fresh install: its profile goes to the Trash first
                         # (the renderer runs on localhost:5847, or the next free port; TERNO_VITE_PORT picks one)

pnpm dev:web             # the web build with a demo mailbox seeded into OPFS on first load: http://127.0.0.1:5175
pnpm build:web           # → apps/web/dist-web, a static site (any static host)
```

- **Demo mode:** launch the packaged app with a demo mailbox: `TERNO_DEMO=1 open apps/desktop/release/mac-arm64/Terno.app`. The data is a deterministic set of ~3,000 Spanish/English conversations across 4 accounts.
- **Gmail:** create a Google Cloud OAuth client of type *Desktop app* with the Gmail API enabled. Paste its client ID in Settings → Accounts, then use "Continue with Google". On the web, use a client of type *Web application* with the site's origin as an authorized JavaScript origin.

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

Terno's interface is in English, and in Spanish when you choose Español (Settings → General → Language) or your system is in Spanish ("System", the default). The switch is immediate, menus included. Every string lives in [`packages/i18n`](../packages/i18n): `locales/en.ts` is the source of truth, and `t("key", params)` (UI, desktop main) and `L("key", params)` (the backend: errors and reasons travel as keys, the renderer translates them) are typed against it, so a wrong key or a missing placeholder doesn't compile. Messages are plain strings with `{name}` placeholders, plural objects (`{ one: "# conversation", other: "# conversations" }`, chosen with `Intl.PluralRules`) and `<b>…</b>`-style tags for rich text. Dates and numbers come from `Intl` in the active locale. Only the active language is loaded (English is bundled; others load when chosen).

### Adding a language

1. Copy `packages/i18n/src/locales/es.ts` to `locales/xx.ts` (`xx` = the language code) and translate the values. Keep every key, every `{placeholder}`, every `<tag>`, and the plural objects (add the forms your language needs: `zero`, `one`, `two`, `few`, `many`, `other`).
2. Add one line to `packages/i18n/src/locales/index.ts`: `xx: { name: "<the language's own name>", tag: "xx-YY", load: async () => (await import("./xx")).default },`.
3. Add the words that announce a verification code in that language to `packages/i18n/src/code-words.ts` (plan 72).
4. `pnpm typecheck` lists anything missing, extra or mismatched (`xx.ts` ends with `satisfies LocaleCheck<typeof xx>`), and `pnpm test` checks it again at runtime. Optionally give it its own date formats in `apps/web/src/lib/format.ts` (otherwise the locale's defaults apply).

The language then appears in Settings → General, "System" picks it on systems in that language, and English remains the fallback for anything missing.

## Styles (designs)

A style is one file in [`packages/ui/src/designs/`](../packages/ui/src/designs) (`lumen.ts`, `atelier.ts`, `macos.ts`, `luma.ts`, `graphite.ts`): fonts, the text scale, the radius ladder, type roles (list title, greeting, section labels, rows, the reader's subject…), icon stroke, layout widths, row heights, avatar sizes, surfaces and a closed set of structural variants (where compose lives, the list header, search, filters, the row, the category review, the reader header, the reply control). Its type has no optional member. `pnpm --filter @terno/ui gen:designs` writes the `[data-design]` CSS; colors stay in the palettes (`themes/registry.ts`), and a style only names the pair "Style colors" uses. See [AGENTS.md](../AGENTS.md) → "Designs" to change or add one.

## See also

- [Architecture](ARCHITECTURE.md)
- [Performance](PERFORMANCE.md)
- [Diagnostics and error reports](DIAGNOSTICS.md)
- [Releasing](../RELEASING.md)
