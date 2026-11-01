# 96: terno.app, the public site

- **Status:** building. Five designs are up for choice; the chosen one becomes `/` and the rest are deleted.
- **Builds on:** plan 50 (Cloudflare for everything Terno hosts). This is a new first step that plan 50 didn't list: the marketing site on the apex domain, separate from `mail.terno.app` (the web app, still plan 50 §3.2).

## Request (verbatim)

> i want to start building just the main site terno.app for now, the public marketing place, with the downloads buttons for mac, for linux/windows we should have a waitlist, lets use cloudflare too for deploying it, set up a nice command so i can esilyt deploy the terno.app app, needds to be searchable on google so we need just a static page basically built already, use react for it and some builder to build it and serve html.
>
> now, for the design of it, build me like 5 versions so i can check them all out, we will need nice pictures of the actual app.
>
> features i want to showcase the most are;
> - unified inbox
> - completely local, no account required
> - instant search
> - very fast
> - easy way of categorizing emails and getting them out of your way, drag one thing to a category or archive, have an immediate option to remove all similar to it there and never see them again in your inbox unless you look for them intentionally
> - nice verfication codes shortcut, small feature but super nice
> - multiple themes designs and color themes
> - snippets
> - open source, you can check how data is treated
> - smart command palette with cmd +k
> - nice shortcuts to manage inbox with the keyboard

## What exists

- No site. `apps/` holds `desktop`, `web` and `backend-dev`. The repo is public (`github.com/luisiacc/terno`); `pnpm release:mac` creates **draft** GitHub releases with `Terno-<v>-arm64.dmg` (none published yet).
- Brand: `brand/terno-icon.svg`, `terno-lockup*.svg`, `terno-mark-*.svg`; `pnpm brand` renders the favicons into `apps/web/public/`.
- The app's fonts (Figtree, Instrument Serif…) and the Hugeicons set (`@terno/ui/icons`) live in `packages/ui`.
- The e2e harness (`apps/web/e2e/fixtures.ts`) starts the real backend (`apps/backend-dev` `startDevServer`) and drives a production build of the renderer; `store.dev.seed(dataset)` seeds a `MockDataset`. The demo dataset is mixed Spanish/English with the maintainer's name in it, which a public site shouldn't show.
- Wrangler 4 is installed and signed in on the maintainer's machine.

## Design

### Shape

`apps/site` (`@terno/site`, private):

- **Build:** Vite 8 + React 19 + Tailwind 4. `vite build` makes the client bundle; `vite build --ssr src/entry-server.tsx` makes a renderer; `scripts/prerender.mjs` renders each route to static HTML (`renderToString`) into `dist/`, then the client hydrates. Google gets complete HTML; no client-side routing.
- **Routes:** `/` (the chosen design, `SITE_DESIGN` in `src/designs/index.ts`), `/designs/<id>/` for the five candidates (`noindex`, not in the sitemap, with a small switcher bar), `/privacy/` (what the site stores: waitlist email and platform, nothing else), and a static `404.html`.
- **Content is data:** `src/content.ts` holds every feature, its copy, the shortcuts shown and its screenshot. All five designs render the same content, so choosing a design never means rewriting copy. English only for now (the app's i18n catalog is for the app; a Spanish site is a later step).
- **Shared parts** (`src/parts/`): `DownloadMac` (→ `/download/mac`), `Waitlist` (Linux/Windows, a real `<form method="post" action="/api/waitlist">` that works without JS and is enhanced with `fetch`), `Shot` (`<picture>` with WebP at 1× and 2×, explicit width/height so nothing shifts), `Kbd`, `Seo` (head tags).
- **Icons** only from `@terno/ui/icons`; fonts self-hosted from `packages/ui` (no Google Fonts, no third-party request of any kind).

### Five designs

1. **Lumen**: warm, light, airy, Figtree; a large product shot under the headline, features alternating text and shots. The default app design, as a site.
2. **Atelier**: editorial, Instrument Serif, paper and ink, numbered sections like a printed magazine.
3. **Midnight**: dark, keyboard-first, monospace accents, keys as the main visual language (t3code-like).
4. **Bento**: one dense grid of feature tiles, each with a cropped shot, Apple keynote style.
5. **Letter**: a single column, large text, written like a manifesto about mail that stays yours, shots set inline.

### Worker (`apps/site/worker/index.ts`)

Static assets serve everything; the Worker runs first only for `/api/*` and `/download/*` (`assets.run_worker_first`).

- `GET /download/mac` → 302 to the newest published release's `*-arm64.dmg` (GitHub API, cached 10 min in the Cache API), falling back to `github.com/luisiacc/terno/releases/latest` when there is none or GitHub is unreachable. The button never 404s and the site never needs a rebuild per release.
- `POST /api/waitlist` (`{ email, platform: "linux" | "windows" }`, JSON or form): validated (zod-free, a small check), honeypot field, body ≤ 2 KB, per-IP rate limit (Workers rate limiting binding), stored in D1 `waitlist(email, platform, created_at)` with `UNIQUE(email, platform)` so repeats are quiet successes. A form post without JS redirects to `/?waitlist=ok#waitlist`.
- `www.terno.app` → 301 to `terno.app`.
- Headers (`public/_headers`): CSP `default-src 'self'` (no inline script; the JSON-LD block is `application/ld+json`, which CSP doesn't execute), HSTS, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` empty, immutable caching for hashed assets. Preview deploys add `X-Robots-Tag: noindex`.

### SEO

Title and description per page, canonical, Open Graph and Twitter card (a 1200×630 image from a screenshot), JSON-LD `SoftwareApplication` (macOS, free), `sitemap.xml` and `robots.txt` written by the prerender step, semantic headings, alt text on every shot, Lighthouse SEO 100 as the bar.

### Screenshots (`pnpm --filter @terno/site shots`)

`scripts/shots.ts` (Playwright, run on demand, outputs committed):

- Starts the real backend (`startDevServer`, `seed: false`) and seeds `shots/showcase.ts`: a curated **English** mailbox for a fictional person (four accounts across Gmail and IMAP, categories, a fresh verification code, snippets, newsletters to file), with the clock frozen.
- Serves a production build of `apps/web` and captures, at 2×, in light and dark: the unified inbox, search with results and timing, ⌘K, the snippets page, the "everything similar" snackbar after a filing, the code chip, the three designs and a few palettes, and the shortcuts sheet.
- Converts to WebP (1× and 2×) with `cwebp`, into `apps/site/public/shots/`, plus the OG image.

### Deploying

- `pnpm deploy:site` (root) → build, then `wrangler deploy` (production, `terno.app` and `www.terno.app` as custom domains, D1 provisioned on first deploy and its migration applied).
- `pnpm deploy:site:preview` → `wrangler versions upload --preview-alias <branch>`: a preview URL, nothing live changes.
- `pnpm --filter @terno/site dev` for local work (Vite with the Worker through `@cloudflare/vite-plugin` is not needed: the dev server serves the client, and `wrangler dev` runs the built site with the Worker).

## Tests

- Unit (`vitest`, `apps/site`): the Worker's waitlist validation, honeypot, duplicate, rate-limit and form-redirect paths, the download redirect and its fallback (fetch stubbed), the www redirect.
- Prerender test: every route renders, has one `<h1>`, a title, a description, a canonical, alt text on every image; previews carry `noindex`; the sitemap lists only indexable routes.
- Playwright (`apps/site/e2e`): each design in light and dark at desktop and phone widths, axe-clean, waitlist submit (JS and no-JS), keyboard-reachable controls.

## Perf and resources

- No JS needed to read the page; the client bundle only hydrates the waitlist and the switcher, budget ≤ 70 KB gzip. Shots are lazy below the fold, the hero one eager with `fetchpriority="high"`.
- The Worker only wakes for `/api` and `/download`; no timers, no analytics.

## Out of scope

- `mail.terno.app` (plan 50 §3.2), accounts, billing.
- A Spanish site, a blog, a changelog page, Windows and Linux builds.
- Sending email to the waitlist (exporting it is `wrangler d1 execute`).

## Revisions after the Codex review

Codex (read-only) raised 12 points against the plan; all are accepted. Each replaces what the sections above say.

1. **The Worker runs first for every request** (`run_worker_first: true`) and hands static paths to `env.ASSETS`. That is what lets `www.terno.app` → `terno.app` (301, path and query kept) cover pages and assets, not just `/api`.
2. **One header helper for every response** (`worker/headers.ts`), assets and Worker responses alike, instead of `public/_headers`: CSP, HSTS, `nosniff`, referrer policy, an enumerated `Permissions-Policy` (`camera=(), microphone=(), geolocation=(), …`), immutable caching for `/assets/*`, `no-store` on `/api/*`.
3. **Previews are their own Worker and database:** `pnpm deploy:site:preview` deploys `--env preview` (`terno-site-preview`, its own D1, migrations applied first) to its `workers.dev` URL. `noindex` is decided by hostname at request time (anything but `terno.app`), so the same build can never deindex production.
4. **Separate build directories:** the client build goes to `dist/` (deployed), the renderer to `.ssr/` (never deployed); prerender writes into `dist/`.
5. **Routing is explicit:** `not_found_handling: "404-page"` (a real 404 status, not the homepage), `html_handling: "auto-trailing-slash"`, canonicals with the trailing slash (`/privacy/`). Tested through `wrangler dev`.
6. **Download picks a published stable release** with a `Terno-*-arm64.dmg` asset (no drafts, no nightlies). With none yet, or GitHub unreachable, it goes to `/download/`, a static page that says the first build is on its way and offers the waitlist for Mac too. The button reads "Download for Mac" with "Apple silicon" under it.
7. **The waitlist is bounded:** 50,000 rows at most (beyond that "The list is full for now"), a rate limit of 5 submissions a minute per `CF-Connecting-IP` (approximate, per location; a backstop, not the bound), and rows are deleted once that platform ships and everyone was told.
8. **Every no-JS outcome lands somewhere useful:** a form post answers 303 to `/waitlist/#thanks`, `#invalid`, `#busy`, `#full` or `#error`; the static `/waitlist/` page shows the matching message with `:target` (no script needed) above the form again. Enhanced submits get JSON (`{ ok }` or `{ error }`) and show the same messages in place. The 2 KB limit is enforced while reading the stream; malformed JSON, unknown content types and repeated fields are refused.
9. **The privacy page says exactly what happens:** the waitlist stores the email, the platform and when; the IP is used in memory for rate limiting and not stored; the Worker logs no request bodies; rows are deleted after the launch email or on request. Joining is voluntary and the only data the site keeps.
10. **Screenshots run isolated:** a fresh temp profile, `autoSync: false`, accounts marked demo as `seedDemo` does, website icons off, the backend and page clocks frozen, `en-US`, and Playwright aborts any request that isn't to the local servers. Everything closes in `finally`.
11. **Copy is in `en` and `es`** (`src/copy/en.ts`, `src/copy/es.ts`, typed so a missing key fails the type check): `/` in English and `/es/` in Spanish with `hreflang`. Design previews are English only, while a design is being chosen.
12. **Gates run it:** Worker unit tests live in `apps/site/src/worker/*.test.ts` (the root `unit` project includes them); `pnpm test:site` runs Playwright against the built site under `wrangler dev` with local D1 migrations (headers, status codes, redirects, waitlist with and without JS, axe in light and dark).

## Built

- `apps/site` (`@terno/site`): five home designs at `/designs/<id>/` (Lumen, Atelier, Midnight, Bento, Letter), `/` and `/es/` render `SITE_DESIGN` (`src/site.ts`). The page ships 0.5 KB of script (the waitlist's in-place submit) and 15 KB of CSS, gzipped; no React runs in the browser.
- Screenshots: 25 captures of the real app on the showcase mailbox (`shots/showcase.ts`, a fictional Sam Rivera), `pnpm --filter @terno/site shots`.
- Commands: `pnpm dev:site` (live SSR on :5190), `pnpm --filter @terno/site preview` (the built site under `wrangler dev`), `pnpm test:site`, `pnpm deploy:site`, `pnpm deploy:site:preview`.
- The license is BSL 1.1 ("not an Open Source license"), so the copy says "source available" and that each version becomes AGPL after three years, never "open source".
- Four icons joined the app's catalog for the site: Apple, Command, Github, Zap.

## What the Codex code review changed

Codex reviewed `af09e9e6..610a2284` and raised 7 points; all are fixed, each with a test that fails without the fix (`src/worker/worker.test.ts`, `e2e/site.spec.ts`).

1. **Deploy order:** the database is created (its id written into `wrangler.jsonc` once) and migrated before `wrangler deploy`; any failing step stops the rest (`src/deploy-steps.mjs`, tested for order and for a failing migration).
2. **Atomic cap:** one `INSERT … SELECT … WHERE count < cap ON CONFLICT DO NOTHING`; a repeat sign-up is still thanked once the list is full. The waitlist tests now run on real SQLite with the real migration.
3. **Screenshot cleanup:** every resource registers its disposal before it's acquired; each disposal runs on its own.
4. **robots.txt** no longer disallows `/designs/`, so crawlers can read the previews' `noindex`.
5. **Platforms:** `mac` is the first Apple-silicon build (what `/download/` asks for while none is published), `mac-intel` is Intel Macs; the migration and labels say so.
6. **Email check** refuses control characters and invalid domain labels.
7. **Download lookups** that fail are cached for a minute (found ones for ten), so an outage or GitHub's rate limit isn't hit per click.

## Second round (maintainer's notes)

- Atelier and Bento are dropped; Lumen, Midnight and Letter remain.
- Feature pictures are Lumen with the GitHub light palette in light mode, and Lumen's own dark palette in dark mode.
- Midnight is always dark, its pictures included, whatever the system says.
- Plainer words: no milliseconds, IMAP, search operators or AGPL in the copy ("Results arrive instantly").
- Every picture is in the page twice (light and dark); a switch at its top right shows the other, and a click, double-click or the enlarge button opens it full size in a `<dialog>` (Esc, the close button or the backdrop close it). Hidden pictures aren't fetched until shown. Color-theme pictures are light/dark pairs (Apple · Dracula, Terno · Nord, Solarized · Tokyo Night, Catppuccin Latte · Mocha, Gruvbox light · dark).

### What the Codex review of the second round changed

Five points, all fixed with tests (`e2e/site.spec.ts`): the tools move in to the visible part of a frame wider than the screen (Lumen's hero on a phone); the hero's two modes are both lazy so only the shown one downloads (a network assertion); Midnight's inactive switch stays light on hover; the interaction test scrolls the picture, not its box-less wrapper; previews are checked for a 200 and `noindex`, and the dropped designs for a 404.
