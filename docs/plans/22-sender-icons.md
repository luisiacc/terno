# Plan 22: sender icons (website icons and Google photos)

- **Status:** done (see "Revisions after the Codex review", "What the Codex code review changed" and "Implementation notes").
- **Builds on:** `da55479` (main after plan 20).
- **Request (verbatim):** "extract icons for emails, 1st try to get the favicon from the main site like if the sender is from 'netflix.com' get the favicon and cache it of course, then use it in the future for thos senders, lets also make sure to render the gmail pictures of the users if they have it."
- **Numbering:** 17 is People / waiting-for-reply and 21 the sidebar (other agents, in parallel); 23 is the account label, built with this one because both touch the thread row.

## 1. What exists

- **Avatars.** `SenderAvatar` (`apps/web/src/components/sender-avatar.tsx`) draws initials on a color tint, deliberately ("fetching them would send addresses off the machine"). It is used by thread rows (Atelier `avatar`, Lumen `large-avatar`; macOS rows are `classic`, without avatars), the reader's message headers (expanded and collapsed), Lumen's sender card, the inline draft (the account's own initials) and recipient suggestions. Sizes come from design variables (`--avatar-row`, `--avatar-row-compact`, `--avatar-message`, `--avatar-collapsed`, `--avatar-sender`); rows are fixed-height (`design.rows`), virtualized.
- **Network policy** (`packages/backend/src/net-policy.ts`): every outbound request names a purpose (`mail`, `ai`, `remote-content`, `telemetry`, `update`, `cloud`); local mode allows only `mail` and loopback AI. An architecture test fails on any `fetch(`, `https.request` and the like outside an allowlist.
- **Local mode** is on for new installs (`settings.ts` default). Remote images in mail stay off in it. Updates already have an "only when you ask" exception in local mode (plan 11), the precedent for an explicit choice.
- **Plan 20** (`connectivity.ts`): `BackendCore.networkChanged(online, reason)` from desktop main (scutil, wake) and the web page (online/offline); `reconnect()` on online or a change, `wentOffline()` on offline.
- **Gmail OAuth.** Desktop: RFC 8252 loopback + PKCE (`packages/mail/src/gmail.ts`), scopes `openid email profile gmail.modify`; the refresh token is sealed in the store. Web: Google Identity Services' token model (`apps/web/src/web/google.ts`), an hour-long access token in the worker's memory, `include_granted_scopes: true`. Both already have the `profile` scope, so the userinfo endpoint returns the account's own `picture`.
- **Files.** `Platform.files` (`read`/`replace`/`remove`, whole-file, atomic) is what the instant index and autocomplete snapshots use: Node files beside the database, OPFS on the web; absent for in-memory stores.
- **Diagnostics** (plan 10): typed codes and fields, no free text, no addresses.

## 2. Privacy decisions

1. **A new purpose, `icons`.** Fetching a website icon tells that site the user's IP address and, by timing, that mail from it was looked at. It never carries anything about the user: no cookies, no referrer, no query string, a generic `User-Agent`, and one request per registrable domain (never per address).
2. **The setting.** `senderIcons` in Settings → Appearance: "Website icons — Shows a company's icon, loaded from its own website (netflix.com…). That site sees your IP address."
   - **Default: on in Connected mode, off in Local mode.** Stored only once the user flips it; unset means "the mode's default" (`!localMode`), so turning local mode on also turns the default off.
   - **In Local mode it is one tap.** The hint says "Off in local mode, which keeps traffic to your mail servers. Turn it on to load icons from senders' websites anyway." Turning it on is the explicit choice; the policy then allows `icons` in local mode (only while the stored value is `true`). Settings → General's local-mode hint names the exception when it's on ("…except website icons, which you turned on").
   - **Why not keep it impossible in local mode:** the user explicitly asked for the feature, and principle 4 already admits network that "explicit choices need"; the non-negotiable is kept as written for everything Terno does by itself. This is called out in the report.
3. **Never a third party.** No Google s2, DuckDuckGo, Clearbit or similar: they would see every sender domain. Only `https://<sender's registrable domain>/…` and the icon URLs that site's own page names.
4. **Freemail senders get no favicon.** gmail.com, outlook.com, icloud.com, yahoo, proton, gmx, … (`freemail.ts`, matched on the registrable domain and the provider families like `hotmail.*`): a person at gmail.com is shown by initials, or their Google photo.
5. **Spam gets nothing.** Rows in the Spam view never ask for icons (no request to a spammer's domain, and a phishing domain can't dress up with a bank's icon in the list). The reader asks only for messages not in spam.
6. **Google photos** come only from Google (the user's mail provider) after explicit, per-account consent (§6). They are purpose `mail` (Google's APIs and its `googleusercontent.com` image host).
7. **Diagnostics:** `icons.batch` (count, durationMs), `icons.trimmed` (count, bytes), `icons.people` (count, durationMs, status). Never a domain, address or URL.
8. **Zero requests when off.** With the defaults of a new install (local mode, no Google photos), nothing in this feature leaves the backend: tested (§9).

## 3. Design: backend (`packages/backend/src/icons/`)

### 3.1 Domains (`domain.ts`, `freemail.ts`)

- `senderDomain(email)`: the part after the last `@`, trimmed, lowercased, trailing dot dropped, IDN to punycode via `new URL("https://" + d).hostname`; null for anything that isn't a hostname (IP literals, no dot, `localhost`, `.local`, `.internal`, `.test`, …).
- `registrableDomain(host)`: eTLD+1 from the Public Suffix List (`tldts`, already in the lockfile through jsdom; ICANN section only, so `user.github.io` → `github.io`). `mail.netflix.com` → `netflix.com`, `news.bbc.co.uk` → `bbc.co.uk`, `correo.ñandú.mx` → `xn--and-6ma2c.mx`. Loaded lazily (dynamic import) on the first lookup.
- `iconSubject(email)`: `{ kind: "photo-only" }` for freemail, `{ kind: "site", domain }` otherwise, null when there is no usable domain.

### 3.2 Fetching (`fetcher.ts`, `image.ts`, `html.ts`)

Per registrable domain, at most 4 requests, sequential, each with a **5 s timeout** and an overall **12 s** budget:

1. `GET https://<domain>/` (HTML, read until `</head>` or **256 KB**). `html.ts` extracts `<link rel>` = `icon`, `shortcut icon`, `apple-touch-icon(-precomposed)`, `mask-icon` excluded, with `href`, `sizes`, `type`; resolved against the final URL (and `<base href>`), `https` only.
2. Candidates ranked for the largest avatar Terno draws (64 px at 2×: target 128): apple-touch-icon (opaque, full-bleed), then sized PNG/WebP icons closest above 128, then SVG, then unsized icons; at most 2 candidates are tried.
3. `GET https://<domain>/favicon.ico` last.

Rules for every request:

- **https only**, port 443 only, GET, `accept` per kind, `accept-encoding: identity`, no cookies, no `referer`, a generic browser `user-agent`, no credentials of any kind.
- **Public addresses only** (Node host): the connection's DNS lookup refuses loopback, private (RFC 1918), CGNAT (100.64/10, Tailscale), link-local, unique-local, multicast and mapped forms, so a sender domain can't make Terno probe the LAN. The check is in the lookup the socket uses (no TOCTOU between check and connect).
- **Redirects** handled by the fetcher, not the transport: at most 3 hops, each re-checked (https, public, policy `assert("icons")`); a chain may cross to another registrable domain at most once (`fb.com` → `facebook.com`), never to an IP literal.
- **Size cap** on the body (256 KB for images, 256 KB for HTML), enforced while reading; a larger image is rejected, not truncated.
- **Content is sniffed**, never trusted from `content-type`: PNG, JPEG, WebP, ICO and SVG by magic bytes / root element; anything else (HTML served as `image/png`, GIF, a 0-byte body) is rejected.
- **ICO:** the directory is parsed; the largest PNG entry is extracted and kept as PNG; an ICO of only BMP entries is kept as ICO (browsers decode it) with its largest size recorded.
- **SVG:** sanitized by rejection: no DOCTYPE/ENTITY, `<script>`, `<foreignObject>`, `on*=` attributes, `javascript:`, `<style>` with `@import`/`url(` to anything but `#`, `href`/`xlink:href` to anything but `#…`, `<image>`, `<use>` of external files, `<iframe>`/`<embed>`/`<object>`. It is drawn only as an `<img>` (`data:` URL), where browsers run no script and load no sub-resource anyway; the sanitizer is the second wall.
- **Dimensions** are read from the header (PNG IHDR, JPEG SOF, WebP VP8/VP8L/VP8X, ICO directory); SVG counts as scalable. Icons under 16 px are rejected.

### 3.3 Transports (`transport.ts`)

`IconTransport.get(url, { kind, maxBytes, timeoutMs, signal }) → { status, location, bytes | null, tooLarge }`.

- **Node** (`node-transport.ts`, desktop and backend-dev): `node:https` with `agent: false` (no pooled socket, nothing for plan 20 to reset), the guarded lookup, `servername` from the URL, the timeout as a socket and an overall deadline, streaming with the cap. Allowlisted in the architecture test ("sender icons: one GET per hop, asserted by the policy, public addresses only").
- **Web:** none for website icons. A page or worker can't read another site's icon without CORS, which almost no site sends, and the request would still reach the site (the privacy cost with no benefit). So the web host reports `capabilities.siteIcons: false`; Settings says "Website icons need the Mac app: a browser can't read other sites' icons." Google photos work on the web (§6).
- **Tests and backend-dev:** an injectable transport (`BackendOptions.iconTransport`); backend-dev's default is the Node one, and the e2e fixtures pass a stub that serves generated icons for a few domains and 404 for the rest, so no test touches the internet.

### 3.4 Cache (`cache.ts`)

- **Keys:** `d:<registrable domain>` for website icons, `p:<hash of photo URL>` for Google photos.
- **Entry:** `{ mime, px, full, bytes, file, fetchedAt, usedAt }`, or negative `{ until, reason }`.
- **Storage:** `Platform.files`: one file per icon in `<db>.icons/` (Node; the directory is created) or `…idb.icons_<hash>` (OPFS), plus an index file `<db>.icons.json` rewritten at most every 5 s after a change (atomic replace; a lost or unreadable index starts empty, orphan files are overwritten by name). In-memory stores (tests, demo) keep a smaller cache in memory.
- **Bounds:** 32 MB and 4,000 entries on desktop, 8 MB and 1,500 on the web; LRU by `usedAt` when either is exceeded, negative entries first. `usedAt` is updated in memory on every lookup and persisted with the next index write (no write for reads alone).
- **TTLs:** positive 30 days (served stale while one refresh runs); negative 7 days ("no icon", invalid, too large); a network failure is not cached (§3.6); a timeout counts as negative only the second time in a row (1 day).

### 3.5 Service (`service.ts`) and RPC

- `icons.lookup({ emails ≤ 200 })` → `{ [email]: IconRef | null }`; an email absent from the answer is pending. `IconRef = { id, v, px, full }` (`full`: draw edge to edge: photos and opaque touch icons). Answered from memory (the index and the people map), in microseconds per email.
- Misses are queued: **LIFO** (what was just scrolled to first), deduplicated by key, at most **200** waiting (the oldest dropped; a later lookup queues it again), **4** domains in flight on desktop. Nothing is queued until the first lookup, and lookups are only made by visible avatars: no work until icons are needed, none at all while both sources are off.
- When a key resolves, the backend emits `icons` with `{ [email]: IconRef | null }` for every email that asked for it (kept per key, bounded, dropped once answered).
- `icons.data({ ids ≤ 50 })` → `{ [id]: dataUrl | null }`: the bytes as a `data:` URL (transport-agnostic: MessagePort and backend-dev's JSON WebSocket alike; the CSP allows `data:` images).
- **Network (plan 20):** offline pauses the queue; network failures put the key in a bounded "retry when online" set (100), re-queued on `reconnect()`; nothing is fetched while offline.
- **Settings off:** `senderIcons` off drops queued website keys and answers website lookups with `null` (cached icons stay on disk until evicted; a "Forget icons" button clears them). The policy refuses `icons` while it is off, as a second wall.

### 3.6 Settings

- `AppSettings.senderIcons: boolean` (effective) and the patch field. `readSettings` resolves an unset value to `!localMode`.
- The policy reads it (`readIconsAllowed`): connected mode allows `icons` when the effective value is on, local mode only when the stored value is `true`.
- Export carries it; import only ever turns it off (like local mode, imports never loosen privacy).
- `HostCapabilities.siteIcons` (desktop true, web false).

## 4. Design: renderer

- **`lib/sender-icons.ts`:** a small external store keyed by email with per-key listeners (`useSyncExternalStore`), so an icon arriving re-renders exactly the avatars showing that sender, never a row. Lookups are batched per animation frame (one `icons.lookup` for every avatar mounted in that frame); refs not yet loaded go in one `icons.data` call. Bounded: 3,000 refs, 400 data URLs (LRU, the mounted ones kept). The `icons` event fills entries. It does nothing until an avatar asks, and nothing while both sources are off (`settings.senderIcons` or any account with Google photos).
- **`SenderAvatar`** keeps its span and initials (same size, same layout); with `icon` set, a memoized `SenderIcon` child draws over it:
  - a photo or full-bleed icon: `object-cover`, the full circle;
  - a website icon: centered on a `--mail-paper` tile (light in both modes, like the paper card for HTML mail) with a hairline ring, at most 2× its natural size and at most 62 % of the tile, so a 16 px favicon stays crisp-ish and small rather than stretched;
  - it fades in over `--motion` when it arrives after mount (opacity only; none when motion is reduced or off); an icon already loaded at mount (scrolling back) shows at once, so a virtualized list doesn't flicker;
  - an `<img alt="">` (the row's name is already read), `decoding="async"`, `draggable={false}`, `referrerPolicy="no-referrer"`; on `error` the initials stay.
- **Where:** rows (Atelier, Lumen; macOS rows have no avatar, by design), the reader's message headers and Lumen's sender card, the inline draft's own avatar. Not in recipient suggestions (typing shouldn't fetch). Not in Spam.
- **Settings → Appearance**, a "Sender pictures" group: the website-icons switch (with the local-mode hint, or the web's "needs the Mac app"), each Gmail account's "Photos from Google" (§6), and "Forget saved icons".

## 5. Design rules

Tokens only (`--mail-paper`, `--hairline`), sizes from the existing avatar variables, the fade within `--motion`. No new text colors, so no new contrast pairs. Rows keep their heights: the icon is inside the avatar box.

## 6. Google photos

Google has no API for an arbitrary sender's photo. What exists:

- **The account's own picture:** the userinfo endpoint's `picture` (scope `profile`, already granted): no new consent.
- **The user's contacts and "other contacts"** (people they've emailed): People API `people/me/connections` (`personFields=emailAddresses,photos`, scope `contacts.readonly`) and `otherContacts` (`readMask=emailAddresses,photos`, scope `contacts.other.readonly`). Default photos (`default: true`, Google's letter avatars) are skipped.

Design:

- **Per Gmail account, off by default:** "Photos from Google" in Settings → Appearance (and the account's row in Settings → Accounts links there). Turning it on:
  - **Desktop:** the same loopback + PKCE flow with `scope = contacts.readonly contacts.other.readonly`, `include_granted_scopes=true`, `login_hint=<account>`, `access_type=offline`, `prompt=consent`. The token response's `scope` says what was granted (Google lets the user untick); the new refresh token (covering everything granted) replaces the old one only if the profile's address is the account's.
  - **Web:** a GIS token request with the same scopes and `include_granted_scopes`; the token goes to the worker as today (`accounts.connectGmailToken`) and covers mail too.
  - Never forced on existing accounts, never asked at connect time.
- **State** in the account's config (no migration): `googlePhotos: { on, contacts: boolean, apiDisabled?: boolean, syncedAt }`, surfaced on `Account` as `photos: "off" | "own" | "contacts" | "api-disabled"`.
- **Sync:** when on, the first lookup after it was turned on (and then lazily, at most every 7 days, when lookups happen) pages both lists (1,000 per page, at most 10 pages each), builds `email → photo URL` (bounded 20,000 per account, the URL's size suffix set to `=s128`), and keeps it in `<db>.icons-people.json` (local only, like the mailbox itself). Photo bytes are fetched lazily for visible avatars, from `https://*.googleusercontent.com` only, through the same caps and sniffing, cached as `p:` keys.
- **Matching:** the address normalized (lowercase, trimmed); the photo map wins over a website icon (a person at a company domain shows their face); the account's own picture answers for the account's own address.
- **Errors:**
  - `403 PERMISSION_DENIED` with insufficient scopes: `photos: "own"`, Settings offers "Allow contacts" again;
  - `403` `SERVICE_DISABLED` / `accessNotConfigured`: `photos: "api-disabled"`, Settings says "Turn on the People API in your Google Cloud project (APIs & Services → Library → People API), then try again";
  - `401`: the provider's usual token refresh; a revoked grant is the account's own reconnect.
- **User action needed:** the OAuth client is the user's own (README → Gmail). For contact photos its Google Cloud project needs the **People API enabled**; the two scopes can be added to the consent screen (in "Testing" mode they work for test users without verification; a published app needs Google's sensitive-scope verification). Without that, Terno still shows the account's own picture.
- **Never logged:** no address, URL or name in logs or diagnostics; the People API calls go only to Google.

## 7. Performance and resources

- Lookups are in-memory; `icons.lookup` for 200 emails stays under 2 ms (unit-asserted with 4,000 cached entries).
- Fetch work is network-bound; parsing (≤ 256 KB HTML, ≤ 256 KB images) is a few ms and yields between domains.
- Renderer: per-key subscriptions; `ThreadRow` render counts unchanged by icons arriving (asserted in the ui-perf scroll test with the stub serving icons for every sender). The images are tiny `data:` URLs decoded off the main thread.
- No timers at idle: the index write is a one-shot 5 s debounce; the people sync is lazy; the queue drains and stops.
- Bounded everything: queue 200, waiters per key 50 emails, retry set 100, cache 32 MB/4,000, people 20,000 per account, renderer 3,000 refs/400 data URLs.

## 8. Out of scope

- BIMI logos (need DNS TXT and VMC validation), Gravatar (a third party keyed by address hash), photos for IMAP accounts (no contacts API).
- macOS-design rows: they have no avatar column (Apple Mail's default); adding one is a design change of its own.
- The sidebar's account list (plan 21 is changing the sidebar); the account's own picture shows in the inline draft and on the account's own messages.

## 9. Tests

- **Unit (`packages/backend/src/icons/*.test.ts`):**
  - domains: eTLD+1 (`mail.netflix.com`, `a.b.bbc.co.uk`, `github.io` pages, `co.uk` alone), IDN, IP literals, uppercase, trailing dots, garbage;
  - freemail: families and exact names, company domains not matched;
  - `html.ts`: links in any attribute order and quoting, `<base>`, relative and protocol-relative hrefs, `http:` dropped, no head, a huge head truncated;
  - `image.ts`: sniffing and dimensions for each format, spoofed content types, a GIF and HTML rejected, ICO PNG extraction, SVG accepted/rejected cases (script, onload, foreignObject, external href, entity, `javascript:`);
  - fetcher against a **local HTTPS server** (self-signed test certificate, the transport's lookup mapping test hosts to 127.0.0.1 with the address guard relaxed for that test only): the homepage candidates, favicon fallback, timeouts, a body over the cap, redirect chains (same domain, one cross-domain hop, a second hop refused, `http:` refused), content-type spoofing, and the address guard refusing loopback when not relaxed;
  - cache: LRU by bytes and count, negative TTL, positive refresh after 30 days, timeouts negative only on the second, persistence round trip and a corrupt index;
  - settings: the default per mode, explicit values stick, import never turns it on;
  - policy: `icons` in local mode only when explicitly on;
  - Google: People API mocked (pages, default photos skipped, size suffix, both sources, 403 insufficient scopes → `own`, 403 service disabled → `api-disabled`), matching, the own picture.
- **Zero fetches:** a backend with a new install's defaults (and one with the setting explicitly off in connected mode) gets lookups for every seeded sender; the transport and the policy fetch record **no request at all**.
- **e2e (`icons.spec.ts`, tagged `@design`):** with the stub transport, icons appear on rows and in the reader with the row's box unchanged (bounding boxes before/after), the initials stay for unknown domains and freemail, nothing in the Spam view asks; the setting's default and its local-mode hint.
- **ui-perf:** the continuous-scroll test runs again with icons on (the stub serving every sender) within the existing gates, and `ThreadRow` renders per scrolled row unchanged.
- **Screenshots** in light and dark for each design: `/tmp/unica-scratch/icons-22/`.

## Revisions after the Codex review

Codex (plan critique, 11 points). What changed, by point:

1. **Desktop consent asks for everything again.** Google doesn't support incremental authorization for installed apps, so "Photos from Google" runs the loopback + PKCE flow with the **full** scope list (`openid email profile gmail.modify` plus the two contact scopes) and `login_hint`. The new refresh token replaces the old one only if the profile is the account's address **and** the granted scopes still include `gmail.modify`; otherwise the old credentials stay untouched and the error says why.
2. **Web consent is bound to the account.** A new `icons.authorizeGoogle({ accountId, accessToken, expiresIn, scope })` inspects the token, refuses it unless it opens that same mailbox, hands it to that account's provider and never creates a mailbox (instead of reusing `accounts.connectGmailToken`).
3. **Two scopes, two flags.** The state keeps `connections` and `otherContacts` apart (from the token's granted `scope`), syncs only what was granted, and keeps one source's photos when the other fails.
4. **Allowed destinations.** Every request (the homepage, each redirect hop, each icon URL from the page and `<base>`) must be on the sender's registrable domain or a subdomain of it; a homepage redirect may move to one other registrable domain (`fb.com` → `facebook.com`), which then becomes the site for the rest. Icons on a third-party CDN are not fetched (the domain's `/favicon.ico` is tried instead). Query strings and fragments are dropped from every candidate. Tests assert rejected URLs get zero requests.
5. **Decoded size.** Raster icons over 1024×1024 are rejected (≤ 4 MB decoded); ICO directories are validated (count ≤ 32, offsets and lengths inside the file, entry dimensions) and only one entry is kept (a PNG entry as PNG, a BMP entry re-wrapped as a one-image ICO); SVG is capped at 64 KB and 1,500 elements, and filters (`<filter>`, `<fe…>`) are rejected with the rest. Stored icons are at most 64 KB. No rasterizer is added (none exists in the backend without a native or multi-MB WASM dependency); every icon is drawn at ≤ 64 CSS px.
6. **Spam.** Rows don't ask in the Spam view or in a search with `in:spam`; the reader asks for no message of a thread that is in spam (`ThreadDetail.thread.inSpam`), the sender card included.
7. **Invalidation.** The service has generations: turning website icons off, "Forget saved icons", turning Google photos off for an account and removing an account bump them, cancel what's in flight (an `AbortController` per generation), drop late results, and emit `icons` with `reset: true` so the renderer forgets its refs. `BackendCore.stop()` awaits the service (in-flight fetches aborted, the index flushed) before the store closes.
8. **Bounded disk even after losing the index.** Icons live in numbered slot files (`<base>.icons/<n>`, at most 1,000 slots on desktop and 400 on the web, each ≤ 64 KB), allocated lowest-free-first; a lost index means slots are overwritten from 0 again, never new names, so the files can never exceed slots × 64 KB (64 MB worst case; the LRU keeps the live set ≤ 24 MB). "Forget" removes every slot path and the index. Each index entry records the slot's size and a hash; a slot that doesn't verify is a miss.
9. **No avatar waits forever.** A key dropped from the queue (overflow) answers its waiters with `"again"`; the renderer asks again for those still visible, with the next batch. Waiters are kept per key without a per-key cap, bounded globally (4,000 emails; past it the lookup answers `"again"`).
10. **Visible, not mounted.** One shared `IntersectionObserver` (root: the viewport) gates lookups: an avatar asks only once it intersects; one that leaves view before its batch is sent is dropped from it. Overscan rows and off-screen reader messages ask nothing.
11. **Chunking.** The renderer splits lookups into 200-email and data requests into 50-id chunks, at most 2 in flight, each failing alone.

## What the Codex code review changed

Eight findings (three high, five medium), each fixed with a regression test that failed before the fix (checked by running the test against the unfixed code):

1. **High: a discarded answer kept downloading.** A redirect's or an error page's body was drained with `res.resume()` after the deadline and the abort listener were cleared, so a site streaming an endless 404 kept a socket busy past every cap, even after icons were turned off. Now the request is destroyed before resolving. Test: endless 404 and 302 bodies are closed within ms (`fetcher.test.ts`).
2. **High: the renderer's snapshots kept images alive.** The per-address snapshot (holding the `data:` URL) survived its avatars and the data LRU. Now the last listener leaving drops it, and evicted entries drop theirs. Test: 5,000 avatars come and go, no snapshot remains (`sender-icons.test.ts`).
3. **High: spam searches by another spelling fetched spammers' icons.** The list's guard was a regex for `in:spam`; the parser also takes `en:spam`, `in:"spam"` and other aliases. Now the guard (`iconsAllowed`) asks the search parser for the effective view. Test: every spelling, and `-in:spam` still allowed.
4. **Medium: turning Google photos off didn't cancel a listing in flight**, and a lazy listing ignored offline. `MailProvider.photos(want, signal)` now takes a signal that every page and request carries; turning photos off (or quitting) aborts it; a lazy listing waits for the network. Tests: no page after the abort (`google-photos.test.ts`); turning photos off aborts the provider's signal (`google.test.ts`).
5. **Medium: a namespace prefix hid a banned SVG element** (`<s:filter>` with `s` bound to SVG). Any prefixed element is now refused. Test in `image.test.ts`.
6. **Medium: a slow slot write could land after "Forget"** and overwrite the icon that reused its slot. Every file operation of the cache (slot writes, the clear, the index) now runs in order on one queue. Test: a held write for A, then forget, then B: B's bytes verify.
7. **Medium: the renderer didn't keep to two requests in flight**; every frame could start another batch while earlier ones waited. Lookups and data requests now share one queue with at most two in flight, each finishing starting the next. Test: twelve frames of new avatars against a backend that doesn't answer: two at most.
8. **Medium: partial Google failures in a row grew past the bound** (the previous list merged in without the 20,000 cap). The merge stops at the cap. Test: three listings of 15,000 new addresses with one source failing stay ≤ 20,000.

## Implementation notes

- **Privacy default shipped:** website icons are **off in local mode** (the default for new installs) and **on in connected mode**, until the user flips the switch (Settings → Appearance → Sender pictures → Website icons); the choice then sticks across mode changes. In local mode the hint says what turning it on does; once on, General's local-mode hint names the exception. The network policy allows purpose `icons` only under the same rule, so the setting is enforced at the single exit, not only in the UI. Imports never turn it on.
- **Zero requests by default:** `service.test.ts` asks about every seeded sender on a new install (and in connected mode with the switch off) and asserts the transport and `fetch` saw nothing; the e2e asserts the stub saw nothing while browsing and opening mail.
- **Web:** no website icons (`capabilities.siteIcons: false`, the switch disabled with "Website icons need the Mac app"). Photos from Google work: the People API and Google's image host answer browsers.
- **Google photos:** the account's own picture needs no new consent (scope `profile`); contacts need the two contacts scopes, asked when the user turns photos on for an account, and the **People API enabled** in the user's own Google Cloud project (Settings says so when it's off). Unverified "Testing" clients work for their test users; a published client needs Google's sensitive-scope verification.
- **The account's own picture** shows on the inline draft's avatar and on the account's own messages; the sidebar's account list is left to plan 21.
- **Lookups** are asserted at a median ≤ 10 ms for 200 addresses with 4,000 cached entries (looser than §7's 2 ms, to hold on a loaded machine).
- **Screenshots:** `/tmp/unica-scratch/icons-22/{macos,lumen,atelier}-{light,dark}.png` (the stub's icons are flat squares; real favicons sit on the same paper tile).
