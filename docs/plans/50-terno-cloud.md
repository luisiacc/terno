# Plan 50: Terno Cloud (hosting, licenses, encrypted sync)

- **Status:** proposed, revised after the Codex plan review (§11, which overrides earlier sections where they differ). Nothing is built yet.
- **Builds on:** `3c4f9d23` (main).
- **Request (verbatim):** "for the server that we'll have eventually so users can sync some stuff like their filters and things and for storing either licenses or the state of subscriptions, plus also the web server wich can be like mail.terno.app, what platform you think we should use, railway? fly.io? cloudflare?" Then: "yes do that please" (write it up as a plan and run it through the Codex critique).

## 1. Decision

**Cloudflare, for all three pieces.** Fly.io is kept as the answer for one future job only (§7).

| Need | Shape of the work | Cloudflare piece |
|---|---|---|
| `mail.terno.app` | a static build (`pnpm build:web` → `apps/web/dist-web/`), its backend in a Web Worker | Workers static assets |
| Licenses and subscriptions | billing-provider webhooks, a few rows per user, signing an entitlement | a Worker + D1 |
| Sync of filters, categories, settings | small per-user state, several devices, pushed changes | one Durable Object per user (its own SQLite), WebSocket hibernation |
| Gmail token broker (plan 04 deferred it) | stateless refresh-token exchange | a Worker |

Why not the others:

- **Railway**: the nicest DX for "a Node container plus Postgres", but always-on billing, few regions, and nothing this workload needs that Workers lack.
- **Fly.io**: real VMs near users and long-lived TCP. That only matters for server-side IMAP (§7). For webhooks, small per-user state and a static site it means running and patching machines for no gain.
- **Cloudflare** scales to zero, has no machines to patch, puts the static site on its CDN with preview deploys, and its Durable Object WebSocket hibernation lets a server push sync changes as events while costing nothing when idle. That is principle 4 ("no polling where an event exists", "idle means idle") on the server side too.

Accepted costs: the Workers runtime isn't full Node (`nodejs_compat` covers what we'd use; nothing in `packages/backend` runs there), D1 is SQLite with per-database size limits (far above this data), and there is some lock-in. The lock-in is contained by §3.5.

## 2. What exists

- **Web build** (plan 04): a static site; the backend runs in a dedicated worker (`apps/web/src/web/worker/`) on SQLite-WASM with the `opfs-sahpool` VFS (`stores.ts`), which needs **no** COOP/COEP headers. Gmail over REST+CORS; IMAP/SMTP, MCP and background sync are desktop-only (`HostCapabilities`). `vite.config.ts` puts the CSP in a `<meta>` (`WEB_CSP`), registers a service worker (`src/web/sw.js`) that precaches the build, and moves source maps to `.maps/<build id>/`, outside what is deployed. Plan 04 §14 named "any static host (Cloudflare/GitHub Pages), with PR preview deploys" and never shipped a deploy.
- **Gmail on the web** has no refresh token: access tokens live 1 h in worker memory, then a "Reconnect Gmail" chip. Plan 04 deferred a "stateless token broker", and `gmail.modify` is a restricted scope that needs Google verification before public hosting (see the Google Cloud OAuth notes: the consent screen is still in Testing).
- **Network policy** (`packages/backend/src/net-policy.ts`): `NetPurpose` already includes `"cloud"`; it is denied in local mode, and every client must go through `fetchFor(purpose)`. Plan 05 §B: "A future sign-in or billing check uses `cloud`. It is denied in local mode and never blocks the app; entitlement will be a cached signed token with a grace period."
- **Owner identity** (plan 05 §C): the first verified non-demo account is the owner ("the Terno account: you'll sign in and be billed with it"). The `owner` row has a stable local `user_id` (uuid) and a reserved `cloud_json` column ("remote user id, last sync"); `owner_history` records changes. `OwnerIdentity` is in `packages/core/src/rpc/contract.ts`.
- **What would sync already has a portable shape:** `app.export`/`app.import` (both in `packages/backend/src/import.ts`, `exportMailbox`; `exportFile` in `contract.ts`) carry categories, filters, settings (read field by field) and drafts. Import is already conservative: privacy settings only ever tighten ("a file never makes this install less private").
- **Filter rules reference local ids**: `accountConditionSchema` (`packages/core/src/rules/schema.ts`) holds a numeric account id, and filter actions reference category ids. These ids differ per install, so sync cannot ship rows as they are (§4.3).
- **Diagnostics** (plan 10): Sentry only outside local mode and with consent, scrubbed. The server must not become a second, unscrubbed channel.

## 3. Design

### 3.1 Repository layout

- `apps/cloud/`: one Worker project (`wrangler.jsonc`), TypeScript, built and tested in the monorepo (`pnpm --filter @terno/cloud test` with `@cloudflare/vitest-pool-workers`).
- `packages/cloud-protocol/`: zod schemas and types shared by the app and the Worker (entitlement token, sync envelope, RPC messages). Pure, no runtime deps beyond zod, imported by `packages/backend` and `apps/cloud`.
- Environments: `staging` and `production`, separate D1 databases, separate signing keys. Secrets only through `wrangler secret`; never in the repo.

### 3.2 `mail.terno.app` (first, independent of the rest)

- Deploy `apps/web/dist-web/` with Workers static assets (`assets.directory`, `not_found_handling: "single-page-application"`), on a custom domain.
- Headers from a `_headers` file generated at build time: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (nothing granted), `Cache-Control: immutable` for hashed assets, `no-cache` for `index.html`, `sw.js` and `manifest.webmanifest`. The CSP moves from `<meta>` to a real header too (`frame-ancestors` only works as a header), keeping the `<meta>` for `vite preview`.
- Source maps are never uploaded (they already sit outside `dist-web/`).
- PR previews: `wrangler versions upload` gives each PR a preview URL. Previews get `X-Robots-Tag: noindex`. **Google OAuth** only works on registered origins, so previews run in demo mode; Gmail sign-in is tested on staging.
- No Cloudflare Web Analytics or any injected script: the CSP would refuse it anyway, and it would break the privacy promise.

### 3.3 Accounts on the server

- **The server user is the owner** (plan 05). Linking happens in Settings → Account, an explicit action, outside local mode only.
- **Sign-in proof:** the Worker sends a one-time code to the owner's email (Cloudflare Email Service), the app submits it, the Worker returns a session. Proving ownership with the mail server login (as plan 05 does locally) isn't possible remotely. Google sign-in can be added later as a second proof.
- **What the server learns:** the owner's email address (needed for billing and recovery) and the local `user_id`. The Settings copy says this plainly. Nothing else about mail.
- **Sessions:** an opaque random token, stored hashed in D1, held by the backend in the keychain (desktop) or the worker's store (web); revocable per device from Settings. `owner.cloud_json` keeps the remote user id and the device id; never the token.
- **Owner change** (plan 05 "Change owner"): the server asks the old address to confirm, as plan 05 already planned.

### 3.4 Licenses and subscriptions

- **Billing provider: a merchant of record** (Paddle or Lemon Squeezy) so VAT and sales tax are theirs. Checkout opens in the system browser, never inside Terno. Their webhooks hit `POST /billing/webhook`, verified by signature, idempotent by event id, and update a `subscriptions` row in D1. The open question in §9 is which one.
- **Entitlement = a signed token, verified offline.** The Worker signs (Ed25519) `{ v, userId, plan, status, periodEnd, graceUntil, issuedAt, keyId }`. The public keys ship in the app (`packages/cloud-protocol`), with `keyId` so keys can rotate. The backend verifies locally on start and on each use; the app never needs the server to open.
- **Refresh:** when the token is within 7 days of `periodEnd` or after a billing action, and only outside local mode, through `fetchFor("cloud")`. Driven by the app's own existing wake-ups (start, network back, the settings dialog), with no new timer. In local mode, or offline, the cached token simply runs to `graceUntil` (e.g. `periodEnd` + 14 days).
- **Local mode and paying users:** a paid user in local mode refreshes only when they press "Refresh license" (an explicit choice, the precedent of plans 11 and 22). Expiry downgrades features calmly; it never locks mail, drafts or data.
- **Clock skew:** `issuedAt` in the future by more than a day, or a token whose `userId` isn't this owner, is refused with a plain-English error and a "Refresh license" action.
- What paid features exist is out of scope (§8); this plan builds the pipe and one test entitlement.

### 3.5 Encrypted sync

**The server stores ciphertext only.** Filters hold addresses, domains and subject patterns; categories hold the user's names; both fall under "mail content, addresses, names, subjects never leave the machine except to the user's own mail and AI providers". So:

- **Keys.** On first sync, the device creates a random 256-bit sync key (`crypto.getRandomValues`). It is wrapped by a key derived (Argon2id via WASM, or PBKDF2-SHA-256 at ≥ 600k iterations if WASM is unwelcome in the worker) from a **recovery code** shown once (24 words, BIP-39 wordlist, en/es UI around it). A new device gets the key either by entering the recovery code or by pairing with a signed-in device (a short code shown on one, typed on the other; the key travels end-to-end through the user's Durable Object, encrypted to the new device's ephemeral X25519 key). Losing every device and the code means the synced data is gone; the copy says so, and local data is untouched.
- **Records.** One record per item: `{ kind: "filter" | "category" | "settings" | "keybindings" | "customTheme", id: uuid, rev, deleted, ciphertext }`, sealed with AES-GCM (WebCrypto), the record kind, id and rev bound as associated data. The server sees counts, sizes and timing, nothing else. Records are bounded (≤ 64 KB each, ≤ 10k per user).
- **Stable ids.** Local integer ids don't travel. Each synced item gets a `sync_id` (uuid) column. Inside a filter, account references become the account's **email** and category references become the category's `sync_id`, translated on the way out and resolved on the way in; a filter naming an account this device doesn't have stays inactive and says why ("This filter is for an account that isn't on this device").
- **Merge.** Last writer wins per record, by `(rev, deviceId)`; each record is small and whole, so field-level merge isn't worth it. Deletes are tombstones kept 90 days.
- **Settings sync is an allowlist.** Appearance (design, palettes, custom themes, density, layout, motion), language, keybindings, compose suggestions. **Never synced:** `localMode`, `remoteImages`, `senderIcons`, AI provider and keys, `allowAgentSend`, `gmailClientId`/secret, error-report consent, notifications. Privacy settings stay a per-device decision, like import already treats them.
- **Transport.** The Durable Object for the user keeps an append-only log in its SQLite. A device sends `push(records[])` and `pull(sinceSeq)`; while the app runs it holds one hibernatable WebSocket and the DO broadcasts new `seq` numbers, so another device pulls only when something changed. No polling. When the app isn't running nothing is connected.
- **Where it runs in the app:** a `CloudSync` module in `packages/backend` behind a `SyncTransport` interface (WebSocket to the DO in production, an in-memory fake in tests). The server side sits behind a small `SyncLog` interface, so moving off Cloudflare later means one new implementation on Postgres, not a rewrite.
- **Off by default, and off in local mode.** Turning local mode on closes the socket; turning it off doesn't restart sync unless the user had it on.

### 3.6 Gmail token broker (later, behind Google verification)

- `POST /google/token`: exchanges a code or a refresh token with Google using the web client secret, returns the access token, **stores nothing** (the refresh token is sealed with a per-user key the Worker derives and handed back for the browser to keep). Shipped only once the Google verification for `gmail.modify` is done. Until then the web keeps plan 04's reconnect chip.

### 3.7 Server hygiene

- **Logs:** Workers logs keep method, route, status, duration and a random request id. No bodies, no emails, no IP addresses in our own logs; Logpush off. Sampled, with short retention.
- **Abuse:** rate limits per IP and per user (Workers rate limiting binding) on sign-in codes and webhooks; sign-in codes expire in 10 minutes, 5 attempts.
- **Backups:** D1 Time Travel (30 days). Sync logs are ciphertext the user can always re-push from a device.
- **Deletion:** "Delete my Terno account" in Settings removes the D1 rows and the Durable Object's storage, and cancels the subscription through the billing API.

## 4. Copy (`en` and `es` together)

New strings in Settings → Account and Settings → Sync: link, sign-in code, what the server learns, recovery code (with "store it somewhere safe; without it and without your devices the synced settings can't be recovered"), pairing, device list, "Refresh license", the inactive-filter reason, deletion confirm. All through `t()`/`L()`, with errors that say what happened and what to do next.

## 5. Tests

- **Worker** (`@cloudflare/vitest-pool-workers`, real D1/DO in miniflare): webhook signature and idempotency, entitlement signing, sign-in code flow and limits, sync push/pull/tombstones, hibernation broadcast, account deletion.
- **Protocol:** round-trip of every record kind; tampering (ciphertext, AAD, rev, kind) is refused; key rotation by `keyId`; tokens for another user or from the future refused.
- **Backend:** `fetchFor("cloud")` denied in local mode (extends the net-policy tests); the settings allowlist (a pushed record can never change `localMode` or AI settings); id translation of filters both ways; an unknown account leaves the filter inactive; merge order; expiry and grace downgrade without touching data.
- **E2E (`apps/web/e2e`)** against a local `wrangler dev`: two browser profiles sync a filter and a category; local mode on stops sync; recovery-code restore on a fresh profile. Desktop packaged smoke: the main-process fence lets the cloud host through only outside local mode.
- **Deploy:** a CI check that `dist-web/` has no source maps and that the served headers match `_headers`.

## 6. Performance and resources

- Nothing loads until the user opens Settings → Account; `CloudSync` and the crypto are a lazy chunk, out of the entry chunk.
- Sync work is small records applied through new atomic store commands (revision 9), in bounded pages and measured slices, inside the slicer budget.
- One WebSocket while the app runs and sync is on; none otherwise. No timers. Bounded record sizes and counts.
- Server cost at launch fits the Workers paid plan ($5/month); DO hibernation keeps idle users at ~0.

## 7. When Fly.io becomes part of this

If Terno ever offers **IMAP on the web** or **sync while the app is closed**, a server has to hold IMAP IDLE connections and run `packages/backend` on real Node. That is a Fly.io service (machines near the user's mail provider), added beside Cloudflare, not instead of it. It would also change the privacy story fundamentally (mail passing through our machines), so it needs its own plan.

## 8. Out of scope

Which features are paid and the pricing; the marketing site (`terno.app`); team or shared accounts; syncing drafts or mail state (drafts may come later as encrypted records, mail state belongs to the mail servers); server-side IMAP (§7); a Postgres implementation of `SyncLog`.

## 9. Open questions for the maintainer

1. Paddle or Lemon Squeezy (both merchants of record; Paddle is the more established for desktop software).
2. Is a 24-word recovery code acceptable UX, or do we want the friendlier "passphrase" (weaker, user-chosen)?
3. Does the web build get paid features too, or are licenses desktop-only at first?

## 10. Order of work

1. `mail.terno.app` on Workers static assets with headers and previews (independent, can ship alone).
2. `apps/cloud` skeleton, `packages/cloud-protocol`, staging/production.
3. Accounts (owner link, sign-in code, sessions, deletion).
4. Billing webhooks and signed entitlements, verified offline in the backend.
5. Encrypted sync: `sync_id` migration in both stores (SQLite and IDB), records, DO log, pairing, recovery.
6. Gmail token broker, after Google verification.

## 11. Revisions after the Codex review

Codex (read-only, against `3c4f9d23`) raised 12 points; all are accepted. The critique is kept at `/tmp/terno-plan50/critique.txt`. Each revision below replaces what the earlier section says.

1. **The Gmail token broker (§3.6) is withdrawn from this plan.** Refresh tokens passing through our Worker means Terno can read a mail credential, whatever we store, and a key the Worker derives protects nothing from Terno. Today web access tokens never leave the worker (`apps/web/src/web/worker/providers.ts`). A broker needs its own plan: explicit consent, credential handling, key rotation, and a local-mode policy. The web keeps the reconnect chip.
2. **The manual license refresh in local mode gets a one-operation grant**, like the updater's (plan 11 §9): `assert("cloud")` rejects it unconditionally today (`net-policy.ts:132–133`). The grant covers one request to the production license endpoint only, with no redirects off that host, and can be cancelled. Tests: the grant can't authorize sign-in, sync or a later automatic refresh. The local-mode disclosures (`settings.localOff.*` and the local mode hint) change in `en` and `es`.
3. **The cloud transport is audited in the backend**, not left to main's fence: main fences the renderer (`app.ts` `installNetworkBackstop`), while backend connections police themselves, and `fetchFor` doesn't govern WebSockets. A `CloudTransport` checks policy before every connect and send, cancels in-flight requests and any pending reconnect, and closes when local mode turns on. Tests count real transport calls (zero) across startup, reconnect and a policy change racing a connect. The renderer fence stays as it is.
4. **The server identity is not the local owner `user_id`.** Each store generates that UUID on its own (`packages/db/src/owner.ts:42–44`, `packages/idb/src/mail.ts:1602–1605`), so two installs with the same email differ, and an owner change keeps the UUID while changing the email. The server creates its own `accountId` at the first verified sign-in to an email; each install links with an `installId`; `owner.cloud_json` holds `{ accountId, installId, email }`. Entitlements bind to `accountId` and are valid only while the local owner's email matches the linked email. A local owner change pauses cloud access ("Your Terno account changed; sign in again to move your license") until the server transfer completes. Tests: two fresh profiles with the same email reach one account; an owner change interrupted at each step.
5. **Authorization is explicit.** Every route derives the user from the session alone; the Durable Object id is `idFromName(accountId)` from the authenticated session, never from a client-supplied id. Sessions expire (90 days, sliding) and are revocable per device. The WebSocket authenticates with a single-use ticket from an authenticated `POST` (60 s, never a long-lived token in a URL); revoking a device closes its open and hibernating sockets (the DO checks a revocation list on wake and on each message). Tests: cross-user routing, an expired session, a revoked device, resume after hibernation.
6. **Subscription state is reconciled, not replayed.** Checkout is created by the Worker for the signed-in account (the provider's custom data carries `accountId`, and the Worker checks it against the customer it created). On every webhook, after the signature and event-id checks, the Worker fetches the subscription's current state from the provider's API and stores that; event order no longer matters. Only `active`, `trialing` and `past_due` (until its grace) mint a paid entitlement. Tests: cancellation then a late activation event, refund and chargeback, duplicate delivery, a forged customer association.
7. **Pairing uses an authenticated key exchange**: CPace (a PAKE) over the short code, with the transcript bound to `accountId`, both install ids, both ephemeral keys, a single-use pairing id and a 5-minute expiry; then the sync key travels encrypted under the resulting key. The DO only relays and can't substitute keys. Tests: key substitution, replay, a pairing to another account, guessing limits (3 tries per pairing).
8. **Every field that governs meaning is authenticated.** The sealed envelope carries `{ v, kind, id, rev, deleted, writerInstallId, keyEpoch }` as AES-GCM associated data, with a fresh random 96-bit nonce per seal; the recovery wrap is specified (Argon2id params, salt, AES-GCM) and versioned. Tampering tests cover each field.
9. **Sync goes through new atomic store commands**, because `MailStore` has no cross-call transaction (`mail-store.ts:234–235`) and IDB commits each command on its own (`packages/idb/src/store.ts:326–345`). `sync.applyLocal` commits a mutation with its new `rev` and an outbox row; `sync.applyRemote` commits incoming records with the cursor; `sync.ack` clears the outbox. `rev` is per record, `max(local, remote) + 1` on write; records whose `writerInstallId` is this install and whose rev is already present are skipped, so echoes do nothing. Tests: a crash between every persistence and network step, on both stores (conformance suite).
10. **Retention is bounded and safe for stale devices.** The DO keeps a compacted snapshot (live records plus tombstones) and a log with a minimum retained `seq`. A device whose cursor is older than that must pull the full snapshot and reconcile before it can push, so a deleted item can't come back. Limits: 1 MiB per user live data (filters and settings are small), 16 KB per record, 1,000-record pages, 500 records per push. Pulls decrypt and apply in measured slices. Tests: a device returning after 91 days; a maximum-size catch-up under the slicer budget.
11. **There is a separate, versioned portable schema and an initial reconciliation.** First sync on a device links existing items before uploading: categories match by name (as import does, `import.ts:324–365`), filters by name and rule; matches adopt the remote `sync_id`. A filter that arrives before its category is staged and stays inactive with its reason until the category arrives, or permanently if it was deleted ("This filter's category was deleted on another device"). `sync_id` is added in both stores with a backfill that is resumable and unique-indexed; the IDB change bumps its logical version (`packages/idb/src/schema.ts:15–17`). Tests: upgrade from the current schema, an interrupted backfill, linking existing data, missing and deleted references. (The `export.ts` citation in §2 is corrected: export lives in `import.ts`.)
12. **The first public `mail.terno.app` is demo-only.** Plan 04 requires Google verification of `gmail.modify` before public hosting of the Gmail flow. Production builds without a verified client run demo mode; a deploy check refuses a production build with Gmail sign-in enabled unless `TERNO_GMAIL_VERIFIED=1`. Gmail sign-in is tested on the registered staging origin.

**Order of work, revised:** (1) `mail.terno.app`, demo-only; (2) the Worker skeleton and `packages/cloud-protocol`; (3) accounts with the server identity, sessions and authorization; (4) billing with reconciliation and offline entitlements, plus the local-mode refresh grant; (5) the audited transport, store commands and `sync_id` migrations, then encrypted sync and pairing; (6) Gmail sign-in on the public site once Google verification is done. The token broker is a separate future plan.
