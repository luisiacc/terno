# Development

## Quick start

```bash
pnpm install            # Node 24+, pnpm 12
pnpm dev                # backend (WebSocket, demo mailbox) + renderer at http://localhost:5173
pnpm dist:mac           # → apps/desktop/release/mac-arm64/Terno.app and Terno-<v>-arm64.dmg
pnpm dist:linux         # on Linux: the .deb and .rpm packages, x64 and arm64 (see Linux below)
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
pnpm --filter @terno/desktop test:smoke:linux   # the INSTALLED Linux package, /opt/Terno/terno (see Linux below)
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

## Linux (plan 189)

Terno ships `.deb` and `.rpm` packages for x64 and arm64, built on Linux (GitHub's runner for a release: RELEASING.md). Both install to `/opt/Terno`, and their install scripts set up Chromium's sandbox (a setuid helper, or user namespaces with an AppArmor profile on Ubuntu 24.04+). There's no AppImage, because it can't keep that sandbox on. The packages don't update themselves; Settings says so (`updates.unsupported.linux`).

On a Linux machine, with `rpm` installed for the `.rpm`:

```bash
TERNO_GOOGLE_DESKTOP_ID= TERNO_GOOGLE_WEB_ID= pnpm dist:linux   # no Google client outside a release; TERNO_LINUX_ARCH=x64 for one architecture
sudo apt install ./apps/desktop/release/Terno-*-linux-amd64.deb
dbus-run-session -- sh -c 'eval "$(printf smoke | gnome-keyring-daemon --unlock --components=secrets)"; export GNOME_KEYRING_CONTROL; xvfb-run -a pnpm --filter @terno/desktop test:smoke:linux'
```

From a Mac, in Docker (arm64 Linux on Apple silicon). Build from a clean copy of the commit in a volume, never from the checkout's own `node_modules`:

```bash
cat > /tmp/Dockerfile.terno-linux <<'EOF'
FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth dbus-x11 gnome-keyring libsecret-1-0 \
    libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 libnotify4 rpm file && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@12.2.1 --activate
WORKDIR /work
EOF
docker build -t terno-linux -f /tmp/Dockerfile.terno-linux /tmp
git archive HEAD | docker run --rm -i -v terno-work:/work terno-linux tar x -C /work
docker run --rm -v terno-work:/work terno-linux sh -c 'CI=1 pnpm install --frozen-lockfile && TERNO_BUILD_SHA=docker TERNO_GOOGLE_DESKTOP_ID= TERNO_GOOGLE_WEB_ID= pnpm build && TERNO_LINUX_ARCH=arm64 pnpm --filter @terno/desktop dist:linux'
```

Then the smoke, as an ordinary user, with namespaces allowed (Docker's default seccomp profile blocks the ones the sandbox needs). Save this as `smoke.sh` and run `docker run --rm --security-opt seccomp=unconfined --security-opt apparmor=unconfined -v terno-work:/work -v "$PWD/smoke.sh:/smoke.sh" terno-linux sh /smoke.sh`:

```sh
apt-get update -qq && apt-get install -y -qq /work/apps/desktop/release/Terno-*-linux-arm64.deb
useradd -m smoke && mkdir -p /work/test-results && chmod 777 /work/test-results
cat > /home/smoke/run.sh <<'EOF'
cd /work/apps/desktop
eval "$(printf smoke | gnome-keyring-daemon --unlock --components=secrets)"; export GNOME_KEYRING_CONTROL
xvfb-run -a ./node_modules/.bin/playwright test -c playwright.linux.config.ts
EOF
su smoke -c 'dbus-run-session -- sh /home/smoke/run.sh'
```

## Languages

Terno's interface is in English, and in Spanish when you choose Español (Settings → General → Language) or your system is in Spanish ("System", the default). The switch is immediate, menus included. Every string lives in [`packages/i18n`](../packages/i18n): `locales/en.ts` is the source of truth, and `t("key", params)` (UI, desktop main) and `L("key", params)` (the backend: errors and reasons travel as keys, the renderer translates them) are typed against it, so a wrong key or a missing placeholder doesn't compile. Messages are plain strings with `{name}` placeholders, plural objects (`{ one: "# conversation", other: "# conversations" }`, chosen with `Intl.PluralRules`) and `<b>…</b>`-style tags for rich text. Dates and numbers come from `Intl` in the active locale. Only the active language is loaded (English is bundled; others load when chosen).

### Adding a language

1. Copy `packages/i18n/src/locales/es.ts` to `locales/xx.ts` (`xx` = the language code) and translate the values. Keep every key, every `{placeholder}`, every `<tag>`, and the plural objects (add the forms your language needs: `zero`, `one`, `two`, `few`, `many`, `other`).
2. Add one line to `packages/i18n/src/locales/index.ts`: `xx: { name: "<the language's own name>", tag: "xx-YY", load: async () => (await import("./xx")).default },`.
3. Add the words that announce a verification code in that language to `packages/i18n/src/code-words.ts` (plan 72).
4. `pnpm typecheck` lists anything missing, extra or mismatched (`xx.ts` ends with `satisfies LocaleCheck<typeof xx>`), and `pnpm test` checks it again at runtime. Optionally give it its own date formats in `apps/web/src/lib/format.ts` (otherwise the locale's defaults apply).

The language then appears in Settings → General, "System" picks it on systems in that language, and English remains the fallback for anything missing.

## Styles (designs)

A style is one file in [`packages/ui/src/designs/`](../packages/ui/src/designs) (`lumen.ts`, `atelier.ts`, `macos.ts`, `luma.ts`, `graphite.ts`): fonts, the text scale, the radius ladder, type roles (list title, greeting, section labels, rows, the reader's subject…), icon stroke, layout widths, row heights, avatar sizes, surfaces and a closed set of structural variants (where compose lives, the list header, search, filters, the row, the category review, the reader header, the reply control). Its type has no optional member. `pnpm --filter @terno/ui gen:designs` writes the `[data-design]` CSS; colors stay in the palettes (`themes/registry.ts`), and a style only names the pair "Style colors" uses. The rules every style keeps are in [AGENTS.md](../AGENTS.md) → "Designs".

- **Change a style:** edit its file, run `pnpm --filter @terno/ui gen:designs`, update that style's baselines only (`pnpm --filter @terno/web exec playwright test --project=e2e-lumen --update-snapshots`), and look at them in light and dark.
- **Add a style:** add its id to `DESIGN_IDS` (`packages/core/src/themes.ts`) and `theme.js`'s list, copy the closest definition (its type forces every value and variant), give it a palette pair (new palettes go in the registry and must pass the contrast suite), add its `en`/`es` name and description (`design.<id>`, `design.<id>.description`), add it to `DESIGNS` and a Playwright project (with its line in `FLOWS`).
- **Add a variant value:** add it to the union in `designs/types.ts`; the compiler then points at every `variant(…)` map that must implement it. Keep roles, names, test ids and shortcuts identical across values (`designs.spec.ts` checks the shared parts in every style).

### What runs where (plan 139)

`e2e` runs every flow once, in macOS. A flow repeats in another style only if that style can change its result (`e2e/designs.spec.ts` holds the same):

- **`@design`, all five styles:** what type, shape, density or a palette can change: `designs.spec`'s first part, the baselines, icon and corner checks, the List round trip.
- **`@variant`, Lumen and Atelier:** a flow through a structural variant macOS doesn't hold (search behind a button, chips, the sender card, the reply pill, a sidebar compose, a display or greeting header, avatar rows, the inline badge), the axe sweep (`e2e/design-axe.spec.ts`: a new surface is a line there, not a tag on its flow) and motion. **`@variant-graphite`** also runs in Graphite, for its compose row. Luma adds no value, so it has no flow of its own.
- **No tag** for everything else; a flow about one style says `test.use({ design })`. A style holding a new variant value adds a `@variant` flow and its project's line in `FLOWS` (`playwright.config.ts`).

## See also

- [Architecture](ARCHITECTURE.md)
- [Performance](PERFORMANCE.md)
- [Diagnostics and error reports](DIAGNOSTICS.md)
- [Releasing](../RELEASING.md)
