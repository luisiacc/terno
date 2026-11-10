# 97: terno.app, the public site

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
- Serves a production build of `apps/web` and captures, at 2×, in light and dark: the unified inbox, search with results and timing, ⌘K, the snippets page, the "everything similar" snackbar after a filing, the code chip, the five designs and a few palettes, and the shortcuts sheet.
- Converts to WebP (1× and 2×) with `cwebp`, into `apps/site/public/shots/`, plus the OG image.
- These pictures are the app without Pro: no AI card in any of them, the hero included.

### AI pictures (`pnpm --filter @terno/site shots:ai`)

The owner's rule: every AI picture comes from real models on Pro's routing, never the stub or canned text, and no word of it is edited by hand. `shots/ai-shots.ts` shares the seed, the web build, the network fence and the encoder with `shots.ts` (`shots/lib.ts`).

- **Keys:** read from the owner's `.env` through `scripts/ui-rating/keys.mjs` (`readKeys`), held in memory and handed to the backend in memory (Dev mode's `devAi`, plan 146); never printed (the process's output is redacted too), written or committed. Before the throwaway profile is deleted, it's checked for them (`filesHoldingKeys`). The page reaches only the two local servers; the backend reaches only the providers.
- **Mailbox:** `showcaseDataset({ ai: true })` adds what the AI states read, kept out of the free pictures: Isabella Grant (a client) moving next Thursday's walkthrough and asking for the address; her payment, split in two halves, across two archived conversations; Elena's phase-two scope decision; a promise ("I'll call you tomorrow to go over the details") and an unanswered request in sent mail; six more newsletters; old shipping notices still in the Inbox.
- **How it runs:** AI is turned on in Settings as a person does (Dev mode → Pro AI, then the background switches and the offer to read the last 30 days of sent mail). The clock starts at `SHOWCASE_NOW` and runs; the window's agrees. Every state is shot light, then dark, on the same page (the system appearance, flipped), so both show the same words.
- **The bar:** where a model's words decide whether the picture is good, the script checks them and asks again the way a person would, a bounded number of times: Ask (every sentence cited, both sources, short; New question), the rule (it matches mail; Edit request), the digest (it found newsletters; the switch off and on). Reply ready (one short blank, not a question) and the summary (about two lines, with a To do) can't be asked again in place, so a run whose words fall short keeps the previous run's picture (`.shots-raw-ai/` is kept unless `--fresh`).
- **States:** `ai-reply` (the window: Isabella's message, the drafted reply with one gap), `ai-summary` (the card and the message's first lines), `ai-ask` (the panel), `ai-today` (the list), `ai-digest` (the page, in a shorter window so its foot sits under the lines), `ai-generate` and `ai-generated` (⌘J), `ai-action` (the preview's list and how Terno read it), `ai-rule` (the dialog), `ai-followups` (the window).
- **Cost:** about 20 requests and US$0.02 to 0.04 a run, by the app's usage book, which the script prints.

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
- Commands: `pnpm dev:site` (live SSR on :5190, or the next free port; HMR shares it), `pnpm --filter @terno/site preview` (the built site under `wrangler dev`), `pnpm test:site`, `pnpm deploy:site`, `pnpm deploy:site:preview`.
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
- Every picture is in the page twice (light and dark); a switch at its bottom right shows the other, and a click, double-click or the enlarge button opens it full size in a `<dialog>` (Esc, the close button or the backdrop close it). Hidden pictures aren't fetched until shown. Color-theme pictures are light/dark pairs (Apple · Dracula, Terno · Nord, Solarized · Tokyo Night, Catppuccin Latte · Mocha, Gruvbox light · dark).

### What the Codex review of the second round changed

Five points, all fixed with tests (`e2e/site.spec.ts`): the tools move in to the visible part of a frame wider than the screen (Lumen's hero on a phone); the hero's two modes are both lazy so only the shown one downloads (a network assertion); Midnight's inactive switch stays light on hover; the interaction test scrolls the picture, not its box-less wrapper; previews are checked for a 200 and `noindex`, and the dropped designs for a 404.
- Third round: the feature pictures are Lumen with **GitHub light** and a new **GitHub Dark** palette (`packages/ui/src/themes/registry.ts`, now 18 palettes). GitHub's button blue (#1f6feb) with white text reads at 4.1:1 as text on its canvas, below AA, so GitHub Dark's primary is Apple's dark-mode blue (#0a84ff, vivid like GitHub Light's) with dark text on buttons, as every dark palette does.

## Terno Pro section

The AI features as **Terno Pro, coming soon**. The copy was decided by a council (Claude Opus and GPT Sol, three rounds). It is used word for word, and `es.ts` is written in the same plain voice.

- **Copy:** a top-level `pro` key, so `features` keeps one shape; a "Pro" nav link to `#pro`. Two honesty fixes outside the section: the stat now reads "Terno servers storing your mail", and `features.local.body` says your mail *syncs* between your Mac and your mail servers. The meta description gains one sentence.
- **What it shows:** Reply ready leads, with its picture large (`ai-reply`). Ask, Today, the newsletter digest and Summaries follow, smaller. Then what AI sends, and the own-key note linking to the privacy page's `#ai`. The header has the eyebrow, a "Coming soon" chip and the planned price in small muted text. There is no buy or trial button.
- **Shared part:** `parts/pro.tsx` lists the features and their pictures and holds two frames, with their geometry in `styles.css`:
  - **The lead** is the whole window. On a phone it is cropped to the reading pane, so the drafted reply stays legible.
  - **A peek** shows a smaller picture rising into a 16:10 stage, cut off by the stage's bottom edge. Every peek uses one scale (frame width = shot width / 760), so the four read as a set. Ask's frame is cropped to the panel itself, without the dimmed list around it.
- **Per design:** each design colors these frames itself. A quiet violet marks Pro, and nothing louder.
  - **Lumen:** right after the `#local` band. A centered header, the reply in a window, its words beside its points, then four tiles with their pictures peeking up from the bottom.
  - **Midnight:** its own section after the features grid. The same hairline grid, with the reply across it and the four two by two.
  - **Letter:** a new part of the letter after the features. The reply is a wide figure, the four are in-column figures with captions, and `⌘J` becomes a keycap.
- **Tests:**
  - `render.test.ts`: every design and language has the section, its nav link, the five pictures in both modes with their alt text, no download link, form or button beyond the picture tools, and the `#ai` link; plus the Spanish and the honesty fixes.
  - `e2e/site.spec.ts`: the Pro link lands on the section clear of a sticky header. Letter's needed `scroll-mt`, and the test fails without it. The existing axe runs cover the section in every design, light and dark, desktop and phone.

## Section pictures

The owner, on Midnight's "Sign-in codes, one click." card: "the sign in code section doesn't show the code, that picture needs to be cut i believe to only show that section, for the parts we only show sections, no need to have a full picture".

- **Why it broke:** the small feature pictures were the full 1440×900 windows, moved behind a frame by pixel offsets in each design's CSS. Retaking the windows with today's app left the offsets pointing at the wrong place.
- **Now:** `shots.ts` takes a **section picture** of each part a design shows, on the same page as its window, framed from the real elements' boxes (`around` in `shots/lib.ts`, shared with the AI pictures). Rows end where a row ends, dialogs sit on the app's plain background, and floating parts (the snackbars, the dialogs) get a 16 px margin. Pictures: `unified-detail` (the accounts in the sidebar and seven rows with their account names), `code-detail` (the code row and the two under it), `search-detail` (the field, the count and four results), `triage-detail` and `archive-detail` (the "everything similar" offers), `palette-detail` (⌘K with "arch"), `snippets-detail` (⌘;), `shortcuts-detail` (the sheet). `--only=<name>-detail` retakes one.
- **Designs:** Lumen, Midnight and Letter show them whole, at the frame's width; the offset CSS and the `Crop` components are gone, and so is Lumen's ring around the code, which was placed by offsets too. Each has its own alt text.
- **Phones:** a section wider than about 470 px (⌘K, ⌘;, the sidebar and list) keeps that width on a phone and its frame shows its start, or its end for the list, where the account names are (`site-wide` in `styles.css`). Shown at the card's width it would be under half size and unreadable. The enlarge button shows it whole.
- **Test:** `render.test.ts` checks which section pictures each design shows, that no `crop` class comes back, and that each picture exists in both modes.

## Five designs, twenty-two palettes

The owner, on Midnight's themes card: "this section needs to be updated since there are more styles and palettes now". The app has five designs (`DESIGN_IDS`: Lumen, Atelier, macOS, Luma, Graphite) and 22 palettes (10 light, 12 dark).

- **Copy (en, es):** "Five designs. Twenty-two palettes.", the body names all five, and the stat reads 22 color themes in five designs. A top-level `designs` key names them as the app's Settings do (es: Grafito).
- **Pictures:** `inbox-luma` and `inbox-graphite`, each in its own palette, framed like `inbox-macos`. `DESIGN_SHOTS` (`parts/shot.tsx`) lists the five in one order for every design.
- **Layouts:** Lumen shows two over three (Lumen and macOS large), and on a phone Lumen across with the others two by two. Midnight shows five named thumbnails above the palette strip. Letter shows three by two (the five and Apple · Dracula), and two by three on a phone.
- **Test:** `render.test.ts` checks that every design shows all five, in both modes.

## Deploying from GitHub

`.github/workflows/deploy-site.yml` runs `pnpm deploy:site` on every push to main that touches `apps/site/**`, the app's icon set (`packages/ui/src/icons.ts`, `packages/ui/src/iconset/**`) or the workflow itself, and by hand from the Actions tab. One deploy at a time, in push order. A failing test, build or migration stops it before the Worker changes.

- Secret `CLOUDFLARE_API_TOKEN`: a user API token from the "Edit Cloudflare Workers" template plus Account → D1 → Edit and Zone → DNS → Edit, scoped to the account and the terno.app zone. Replace it there if it's revoked or expires.
- Variable `CLOUDFLARE_ACCOUNT_ID`: the account the Worker and the D1 database live in.
