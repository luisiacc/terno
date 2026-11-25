# Plan 259: Outlook accounts over Microsoft Graph

## Request (verbatim)

> start working on supporting outlook and give me steps i need to take myself for api keys and stuff

Outlook here means every Microsoft mailbox a person signs into with "Continue with Microsoft": personal accounts (outlook.com, hotmail.com, live.com, msn.com) and work or school accounts (Microsoft 365 / Exchange Online). On-premises Exchange stays on IMAP.

## What exists

- **Two account kinds.** `AccountKind = "imap" | "gmail"` (`packages/core/src/types.ts:9`), each with a sign-in method (`SIGN_IN`: `password`, `google`). Plans 28 and 26 deferred Outlook on purpose; plan 176 already names it ("Outlook over Microsoft Graph, whose change notifications need a public webhook": it is polled, with `quickChecks` once a delta read is cheap), and `MailProvider.execute` names `forwarding-delivery.int.test.ts` as where a new provider proves its sends.
- **The Gmail path is the template.** It is about 2,400 lines in `packages/mail/src/gmail*.ts`:
  - `connectGmail` is the RFC 8252 loopback with PKCE and state, plus the callback page (`oauth-page.ts`).
  - `createGmailProvider` wraps the refresh-token session: a single-flight refresh, and rotation persisted through `replaceSecret` CAS (plan 32).
  - `gmail-api.ts` is the REST adapter: sync through history, labels as folders, raw MIME downloads in a 6-way pool, quota pacing, batchModify, search, and the folder ops.
- **Much of the machinery is generic but carries Google's name.** These are all provider-neutral in what they do:
  - `ProviderContext.google: GoogleRequests`: per-account request policy, cooldown, generation fencing, proof.
  - `ProviderContext.googleClient()`.
  - `HttpRequestContext.endpoint` (`"gmail-api" | "oauth-token" | "google-userinfo"`) and the cooldown store's `COOLDOWN_SERVICES`.
  - `net-policy.ts`'s `fetchGoogle` and its capacity counters.
  - `provider-http.ts` (already generic).
  - The store's `GoogleAdmission`/`admitGoogle`, the op gates `blockAllGoogle`/`blockGoogleSends`/`blockGoogleBackground`, and the `ADMITTED` SQL that filters `a.kind = 'gmail'` (`db/src/repos.ts:454`).
  - The backend's `googleClients` option and `google-client.ts` resolver.
  - The identity switches in `identity.ts` that branch on `signInMethod`.
- **Truly Google-only pieces:**
  - `validateGoogleConnection`/`gmailClaim`/`googleAdmission`, the userinfo identity read, and Google's revoke (`google-revoke.ts`).
  - The web Google Identity Services popup (`apps/web/src/web/google.ts`).
  - Gmail tabs (`separatesTabs`, `gmail_labels`, the `IMPORTANT`/`CATEGORY_*` signals in `attention.ts` and `people.ts`).
  - Gmail's whole-thread label semantics in `db/src/actions.ts`, `folder-move.ts` and `inbox-hiding.ts`, and their idb twins.
  - The 429/403 `rateLimitExceeded` handling in `core.ts`.
- **The schema refuses a third kind.**
  - `accounts.kind` has `CHECK (kind IN ('imap','gmail'))` (`migrations.ts:143`, schema v1).
  - `owner.provider` has `CHECK (provider IN ('gmail','imap'))` and `verified_by` has `CHECK (... 'google_oauth','imap_login')` (`OWNER_V3`).
  - The accounts table has never been rebuilt. 24 tables reference it `ON DELETE CASCADE`, and migrations run inside one transaction with `foreign_keys = ON`, so a drop-and-copy rebuild would cascade-delete every message. IndexedDB has no such check.
- **Build-baked client.** `scripts/release-env.mjs` builds `TERNO_GOOGLE_CLIENTS` from `.env` (`TERNO_GOOGLE_DESKTOP_ID/_SECRET`, `_DEV_*`). `apps/desktop/scripts/build.mjs` defines it, `backend-entry.ts` parses it, and CI (`release-ci.mjs`, `release.yml`) passes the secrets. The web build gets `VITE_TERNO_GOOGLE_CLIENT_ID`.
- **Network.**
  - All OAuth and API traffic runs in the backend through `fetchFor("mail")`, which is allowed to any host (plan 97). The renderer reaches only loopback and mail images, so Microsoft hosts need no renderer change.
  - `shell.openExternal` opens any `https:` URL.
  - The web CSP would need `login.microsoftonline.com` only if the web flow used a frame or script.

## Why Microsoft Graph, not IMAP with OAuth

Outlook.com and Exchange Online both take IMAP and SMTP with XOAUTH2, so the IMAP provider could carry Outlook with only a new sign-in. That route is weaker:

- Work tenants turn SMTP AUTH off by default, and many turn IMAP off, so a large share of work accounts couldn't send or sync.
- IMAP gives no Focused Inbox, categories or immutable ids.
- Microsoft points new apps to Graph.

Graph supports both account types with the same delegated scopes. It has documented per-folder delta queries, raw MIME in and out, and immutable ids, which fit Terno's store as cleanly as Gmail's history did.

**Decision:** a Graph provider, built like the Gmail REST provider. IMAP with OAuth is not built.

## Design

The work comes in four stages, each landing on its own, with tests. Stage 0 is the refactor that lets Outlook fit without bolting on. Per AGENTS.md, it waits for the owner's go-ahead.

### Stage 0: name the OAuth machinery for what it is (refactor, no behaviour change)

1. **Sign-in methods.**
   - `SignInMethod` becomes `"password" | "google" | "microsoft"`, and `AccountKind` gains `"outlook"`. `SIGN_IN.outlook = "microsoft"`.
   - Every `switch (signInMethod(...))` then fails to compile until it handles `microsoft`, which is the plan-184 contract working as meant.
   - Until stage 1, `microsoft` throws `errors.unsupported`.
2. **Provider request policy.**
   - `GoogleRequests` becomes `ProviderRequests`, and `ProviderContext.google` becomes `ProviderContext.requests`.
   - The backend installs it for every OAuth kind (`kind !== "imap"`), not only `gmail` (`core.ts:1918`).
   - `net-policy.ts`'s `fetchGoogle`/`googlePending`/`googleAvailable` become `fetchProvider`/… with the same caps.
3. **Request contexts.**
   - `HttpRequestContext.endpoint` gains `"graph-api" | "microsoft-token" | "microsoft-identity"`, and `COOLDOWN_SERVICES` gains them. The decoder still accepts every old value.
   - The cooldown checks in `provider-cooldown.ts` key on the account's service set (`servicesFor(kind)`), not `kind !== "gmail"`.
4. **Store admission.**
   - `GoogleAdmission`/`admitGoogle`/`blockAllGoogle`/`blockGoogleSends`/`blockGoogleBackground` become `OAuthAdmission`/`admitOAuth`/`blockAll`/`blockSends`/`blockBackground`.
   - The `ADMITTED` SQL and the store checks (`sql-store.ts:1705,1769,1793`, `idb/store.ts:2641,2744,2768`) test `kind <> 'imap'`.
   - The conformance suite (`store/src/conformance/google-identity.ts`) runs per OAuth kind.
5. **OAuth clients.**
   - `google-client.ts` becomes `oauth-clients.ts`, with `clientFor(b, method, remembered?)`. `BackendCoreOptions.googleClients` becomes `oauthClients: { google?: …; microsoft?: … }`, and `ProviderContext.googleClient()` becomes `oauthClient()`.
   - A Microsoft client is public: an id and no secret. `clientSecret: null` already passes through the Gmail code.
   - The remembered client id is per provider, like the subject: Gmail keeps `googleClientId`, Outlook writes `microsoftClientId` (`oauth-clients.ts`; changed in the stage 0a code review, which found the plan and the code naming it differently).
6. **Shared OAuth pieces, lifted out of `gmail.ts`.**
   - `oauth-loopback.ts`: the loopback listener with PKCE and state, the callback page, and the error mapping. It is parameterised by authorize URL, extra params (`access_type`/`prompt` for Google; `prompt=select_account` and `response_mode=query` for Microsoft) and an error mapper.
   - `oauth-session.ts`: the refresh-token session (single-flight refresh, CAS persistence, closed-lifetime fencing, `tokenResult`). `createGmailProvider` keeps only what is Google's.
   - The token-response validation is shared. Each provider checks its own scopes.
7. **Registry.**
   - `ProviderRegistry.connectGmail`/`beginGmailRenewal`/`revokeGoogle` stay, and `connectMicrosoft`/`beginMicrosoftRenewal` join them. They are two named entry points, not a generic `connect(kind)`, because their results differ (Google's `sub` vs Microsoft's `oid`+`tid`).
   - `createRegistry` picks the provider by kind.

Every existing Gmail test passes unchanged except for renamed imports. That proves the stage changes nothing. The identity, conformance and cooldown suites rerun.

### Stage 1: sign in with Microsoft and keep the account

1. **Schema (SQLite v79, shape only).**
   - Widen the three CHECKs: `accounts.kind` gains `'outlook'`, `owner.provider` gains `'outlook'`, and `owner.verified_by` gains `'microsoft_oauth'`.
   - SQLite's documented way to change a CHECK without touching rows is `PRAGMA writable_schema` (lang_altertable.html §7): update `sqlite_schema.sql` for the two tables, bump `schema_version`, run `integrity_check`.
   - It rewrites no row, and the existing rows satisfy the wider check. It is ~1 ms at any size (`migrations.perf.test.ts`).
   - A rebuild is ruled out (§ What exists: cascades).
   - The test opens a v78 file with mail, migrates, inserts an `outlook` account, and asserts the counts of every account-owned table are unchanged.
   - **Risk to check first:** whether `node:sqlite`/the WASM build run with `SQLITE_DBCONFIG_DEFENSIVE`, which refuses `writable_schema`. If they do, the fallback is a migration-runner step type that runs outside the transaction with `foreign_keys = OFF` (the documented 12-step rebuild, accounts and owner only, a few rows), with `rewrites` saying why.
2. **Sign-in (`packages/mail/src/microsoft.ts`).**
   - `connectMicrosoft` is `oauth-loopback` against `https://login.microsoftonline.com/common/oauth2/v2.0/authorize`, with redirect `http://localhost:<port>/callback`. Microsoft matches loopback ports loosely for desktop clients.
   - Scopes: `openid email profile offline_access User.Read Mail.ReadWrite Mail.Send`.
   - The token exchange posts to `/common/oauth2/v2.0/token` with no secret.
   - Identity comes from `GET https://graph.microsoft.com/v1.0/me` (`id`, `mail`, `userPrincipalName`, `displayName`) plus the id_token's `oid` and `tid`, which is the stable subject.
   - The mailbox address is `mail` when set, else `userPrincipalName` (personal accounts often have no `mail`).
   - Errors map to `errors.microsoft.*`:
     - `access_denied` → "denied".
     - `AADSTS65001`/`consent_required`/`interaction_required` with admin-consent wording → "your organisation's administrator has to allow Terno" (the plan-28 admin case).
     - Anything else → invalid response.
3. **Account and owner.**
   - `OutlookAccountConfig { senderName, microsoftSubject: "<tid>:<oid>", microsoftClientId, tenant: "consumers" | "organizations" }`. The tenant is consumers when `tid` is the documented consumer tenant `9188040d-6c67-4c5b-b112-36a304b66dad`.
   - The refresh token goes in `account:N:refreshToken`, as Gmail's does.
   - `identity.ts` gains `validateMicrosoftConnection` (scope check on `Mail.ReadWrite` and `Mail.Send`), `microsoftClaim`, the reconnect and renewal branches, and `connectExistingMicrosoft` with `login_hint`.
   - The owner's `verified_by` is `microsoft_oauth`.
4. **Remove.** Microsoft has no endpoint that withdraws one app's grant. The remove dialog says so and links the person to where they can withdraw it:
   - personal accounts: account.live.com/consent/Manage
   - work accounts: myapps.microsoft.com

   The local secret is deleted as for Gmail. `accounts.remove`'s `google` result field stays as it is.
5. **Build.**
   - `release-env.mjs` gains `buildMicrosoftClient(env)` from `TERNO_MICROSOFT_CLIENT_ID` (and `TERNO_MICROSOFT_DEV_CLIENT_ID`). It is public, with no secret.
   - A release without it fails unless it is set to `""`, as Google's does.
   - `build.mjs` defines it, `backend-entry.ts` passes it into `oauthClients.microsoft`, and CI passes it as the `release` environment secret `TERNO_MICROSOFT_CLIENT_ID`.

### Stage 2: the Graph provider (`packages/mail/src/graph-api.ts`)

1. **Requests.**
   - Everything goes through `ctx.requests` and `requestHttp`, to `https://graph.microsoft.com/v1.0/me/…`, with `Prefer: IdType="ImmutableId"` on every call so message ids survive moves.
   - Throttling: a 429 or 503 with `Retry-After` feeds the existing cooldown ledger (`graph-api` service). Concurrency is capped at 4 requests per mailbox (Outlook's documented limit), not Gmail's 6.
   - Response bodies are size-bounded as in `gmail-api.ts`.
2. **Folders.**
   - Folders come from `GET /me/mailFolders?$top=…&includeHiddenFolders=false`, recursing into `childFolders`.
   - Well-known names (`inbox`, `sentitems`, `drafts`, `deleteditems`, `junkemail`, `archive`) map to Terno's roles. User folders are folders.
   - Create, rename and delete use `POST /mailFolders/{id}/childFolders`, `PATCH` and `DELETE`, in plan 107's contract. The folder id is the key, so a rename keeps keys, like Gmail's.
3. **Sync.**
   - Each synced folder has a delta cursor: `GET /me/mailFolders/{id}/messages/delta` with `$select` of the envelope fields, `Prefer: odata.maxpagesize=…`, and the `deltaLink` stored in the cursor.
   - The synced folders are Inbox, Sent, Drafts, Archive, Junk, Deleted and user folders, within the window.
   - The first sync filters on `receivedDateTime ge windowStart`, which the delta function supports for messages.
   - An expired or invalid delta link (documented as `410 Gone` / `syncStateNotFound`) restarts that folder with a reconciliation pass, like Gmail's `ExpiredHistory`.
   - A message's single location is its folder. Graph mail lives in one folder at a time, like IMAP and unlike Gmail labels, so the IMAP-style move semantics in `actions.ts` and `folder-move.ts` apply. Those branches are Gmail-only today and leave `outlook` on the non-Gmail path.
4. **Bodies.**
   - `GET /me/messages/{id}/$value` returns raw MIME, which goes into the existing `"mime"` incoming-processing input. There is no new parser, and attachments, inline images and captures work as for IMAP.
   - Downloads run through the same pool and staging as Gmail (50 messages or 4 MB batches, read credits).
5. **Flags and ops.**
   - Read/unread is a `PATCH` of `isRead`. Flagged is `flag.flagStatus`.
   - Move is `POST /messages/{id}/move`. Trash is a move to `deleteditems`, and permanent delete is `DELETE` (or `permanentDelete`).
   - Many messages go through JSON `$batch` in groups of up to 20, and the 4-request concurrency still holds inside a batch.
   - `flagSnapshots` comes from the delta pages, which carry `isRead`/`flag`.
6. **Threads.** `conversationId` is `providerThreadId`. Terno's own threading (`references`) still decides, as for IMAP.
7. **Send.**
   - `POST /me/sendMail` with the base64 MIME body (`Content-Type: text/plain`), built by the existing `buildRaw`. It returns 202 with no id, so the Sent copy is matched by Message-ID on the next sync, as IMAP's is (`sent-copy.ts`).
   - Over Graph's request size limit (verified in docs: 4 MB), the send goes through a draft (`POST /me/messages` with the MIME), an attachment upload session, then `POST /messages/{id}/send`.
   - A timed-out `sendMail` is `ambiguous`, never retried (plan 65).
8. **Search and quick checks.**
   - `search` is `GET /me/messages?$search="…"` (plan 141), and `fetchHits` downloads hits through `$value`.
   - `quickChecks: true` once the Inbox delta read with nothing new is one request (plan 176).
   - There is no push: Graph change notifications need a public HTTPS webhook, which a local client doesn't have (plan 176). The ordinary poll cadence applies.
9. **Not mapped in v1:**
   - Outlook categories. Terno's categories stay Terno's, and Graph's `categories` aren't written.
   - Focused Inbox. `separatesTabs` stays Gmail-only, and a follow-up plan can map `inferenceClassification` to the tabs.
   - Flag due dates.

### Stage 3: UI and copy

- **Add account.**
  - "Continue with Microsoft" sits beside "Continue with Google" with the same BoardUI button and a Hugeicons glyph (a catalog line; no brand SVG).
  - The busy and error states are shared and parameterised by method.
  - The IMAP presets for outlook.com/hotmail.com are dropped in favour of the button, since basic-auth IMAP doesn't work there any more.
- **Settings → Accounts:** the provider label ("Outlook"), the reconnect wording and the remove dialog's grant-withdrawal link.
- **Sign-in notice and panel:** the `microsoft` case.
- **i18n:** `errors.microsoft.*`, `account.connectMicrosoft`, `account.remove.descriptionMicrosoft*`, `signIn.microsoft*`, in `en` and `es` together.
- Screenshots in light and dark, axe-clean, and `pnpm ui:rate` for the add-account screen.

### Stage 4 (later, own plan): the web build

A PKCE popup against the SPA redirect, with tokens that live 24 h as Microsoft gives single-page apps. Web is low priority (memory). Until then the web's Add account shows Microsoft as desktop-only, with the copy Google uses for a desktop-only path. This is a parity gap the plan names rather than hides.

## Tests

- **Stage 0:**
  - The existing Gmail, identity, cooldown, net-policy and store-conformance suites, renamed and green.
  - A type-level test that every `SignInMethod` switch is exhaustive.
- **Stage 1:**
  - `oauth-loopback.test` for both providers: state mismatch is ignored, a single `code` is required, error mapping, and the listener closes.
  - `microsoft.test`: token validation, scope check, identity from `/me` plus the id_token, the consumer tenant, `mail` vs UPN.
  - Migration v79: counts unchanged, `outlook` accepted, `integrity_check` ok, under 1 s at 50k (`migrations.perf.test.ts`).
  - `release-env.test`: client present, empty, or missing on release.
  - Backend `accounts.connectMicrosoft` against a synthetic Microsoft (endpoints moved, like Gmail's synthetic Google).
- **Stage 2:**
  - `graph-api` units against a synthetic Graph server:
    - delta paging, an expired delta restart, `Retry-After` honoured, and 4-way concurrency asserted
    - `$value` into ingest, the move, flag and trash ops, a `$batch` partial failure
    - the 4 MB send switch, and an ambiguous send never retried
  - `forwarding-delivery.int.test.ts` gains an `Outlook` harness in `DELIVERIES`.
  - The store conformance runs with an `outlook` account in both engines.
- **Stage 3:**
  - Unit tests for the dialog and settings rows.
  - One e2e spec, `outlook-connect.spec.ts`, against the synthetic Microsoft: add, sync a few messages, send, reconnect, remove. It is merged into one `scenario()`.
- **Perf:**
  - `load.perf.test.ts` and the 50k queries are untouched (no query change beyond `kind <> 'imap'`).
  - A sync throughput gate for Graph mirrors Gmail's `gmail-batches.perf.test.ts`.

## Perf and resources

- Nothing runs until an Outlook account exists.
- The poll is the existing per-account tick. A quick check is one delta request.
- Downloads are capped at 4 concurrent per mailbox.
- Bodies are streamed into the existing bounded staging.
- There are no new timers and no new background work.

## Privacy

Mail and tokens go only to `login.microsoftonline.com` and `graph.microsoft.com`, the user's own mail provider (plan 97). Nothing else is contacted. Identity uses `/me` and the id_token, with no photo or contacts scopes (plan 258's lesson).

Stage 2b: a send with a file of 3 MiB or more uploads it through a Graph upload session, whose URL Graph hands back "in the `https://outlook.office.com` domain" ([outlook-large-attachments](https://learn.microsoft.com/graph/outlook-large-attachments)). That host is also the user's own mail provider (Exchange Online). The provider sends the file's bytes there and nowhere else: an upload URL on any other host is refused before a byte leaves, and it carries no access token (the page says to send no Authorization header).

## Out of scope

- On-premises Exchange (EWS) and IMAP with XOAUTH2.
- Shared mailboxes and delegate access.
- Outlook categories and Focused Inbox as tabs.
- Push through change notifications.
- The web flow (stage 4).
- Calendar and contacts.

## What the owner has to do (accounts, keys, approvals)

See the step list given with this plan in the conversation of 2026-11-24. In short:

1. Register one app in the Microsoft Entra admin center: multitenant plus personal accounts, the "Mobile and desktop applications" platform with redirect `http://localhost`, the delegated Graph permissions above, and no secret.
2. Put its client id in `.env` as `TERNO_MICROSOFT_CLIENT_ID` (a second, dev registration is optional), and in GitHub Actions for releases.
3. For work accounts, get publisher verification: a free Microsoft AI Cloud Partner Program account for Luisiacc LLC, and a verified domain on the app. Without it, most organisations refuse user consent to an unverified multitenant app asking for mail.

## Owner decisions needed before building

1. Go-ahead for the stage 0 refactor (renames across backend, store, mail and db; no behaviour change).
2. Graph rather than IMAP with OAuth (recommended above).
3. Web parity deferred to its own plan (stage 4).

## Corrections from Microsoft's docs (checked 2026-11-24)

- **Redirect.** `http://localhost` is the one loopback form whose port Microsoft ignores ("only true for localhost redirect URIs"). `127.0.0.1` would need its exact port registered, so Outlook uses `localhost`. "Allow public client flows" must be on for a public client that has redirect URIs (reply-url).
- **Consent.**
  - Mail.ReadWrite, Mail.Send, offline_access, User.Read, openid, email and profile need no administrator's consent as delegated permissions, and all of them work for personal accounts.
  - The 2020 rule blocking user consent to unverified multitenant apps applies only where an organisation turns on risk-based step-up consent. Even so, Microsoft recommends organisations allow only verified publishers, so publisher verification remains the owner's step 3.
- **Delta.**
  - A delta with `$filter=receivedDateTime ge …` returns at most 5,000 messages. A first sync of a wider window therefore lists the folder with paging (`/messages?$filter=…&$orderby=receivedDateTime desc`) and starts the delta afterwards, not from the filtered delta.
  - An expired token can be a 4xx `syncStateNotFound` or a `410 Gone`; both restart the folder.
  - Moving a message out of a folder appears as `@removed` with reason `deleted` (see revision 4).
- **Send size.** No per-request size for `sendMail` with MIME is documented. Following "no undocumented provider behaviour" (memory), Terno doesn't hard-code 4 MB. Until a limit is found in Microsoft's docs, every send with attachments over the documented large-attachment threshold (Graph's attachment upload session: "3 MB to 150 MB") goes through the draft path. That threshold is documented.
- **Refresh tokens** rotate on every use (the CAS path from plan 32 fits). Their lifetime is documented as 90 days for scenarios other than SPAs, which is an inference for desktop.
- **Revoke.** There is no app-side endpoint. The two consent-management links in stage 1 §4 come from Microsoft support pages and aren't on the pages checked; confirm them before shipping the copy.

## Revisions after the Codex review

1. **The migration is a transactional rebuild, not `writable_schema`.** `node:sqlite` runs in defensive mode since Node 24.14, and Codex's probe on 24.21 refused the catalog update. The migration runner gains a step flag that turns `foreign_keys` off before `db.tx` and back on in `finally`. The step rebuilds `accounts` and `owner` (ids kept, the three `accounts` triggers recreated) and runs `PRAGMA foreign_key_check`; a non-empty result aborts the step. The step carries `rewrites` (two tables of a handful of rows), appends the v79 hash, and is timed through the production path, not the perf harness's replay. No full `integrity_check` (it scans the mailbox).
2. **Folder membership for a REST, single-folder provider is new store work.** The non-Gmail path in both engines reads `message_locations`, keyed by UID/UIDVALIDITY, and queues `keepInbox`. Outlook gets its own location model: the immutable message id plus a folder id, settled by the move's answer, with `leaveFolder` undo and archive-vs-move ordering defined. **This is the second refactor the owner approves.** It is stage 0b, in the store contract and both engines, with conformance tests.
3. **Capture locators and threading.** Capture repair gains an `outlook` locator (immutable id) through the codec and both validators. A missing target is an Outlook "gone" outcome, not `ProviderIdentityError`, which parks ops for IMAP recovery. Threading: `providerThreadId` is left null and RFC references decide, as for IMAP. A non-null `conversationId` would take precedence in both stores and regroup threads, and Outlook's conversations are subject-based.
4. **Delta tombstones aren't deletions.** `@removed` in a folder's delta means "left this folder". A message is removed locally only when no synced folder holds it after every folder's page in the pass is read, or after a targeted `GET /messages/{id}` returns 404. Cursors are saved only after a page's effects commit. Tests cover both folder orders and a restart between them. Only Inbox delta pages past an existing cursor ingest as `live`.
5. **Admission is per provider, compared atomically.** It is not `kind <> 'imap'`. A provider discriminator plus its stored subject (`googleSubject` / `microsoftSubject`) is checked with the account stamp and credential commit, as `googleSubject` is now. This also covers renewal without a new refresh token, owner confirmation, `OwnerClaim`, the owner row and the RPC projection. `blockUnverifiedGoogle` and IDB's op-admission filter (`idb/src/mail.ts:1797`) are included.
6. **The request seam is behaviour as well as names.** The saved-account facade gets a distinct name (`ProviderRequests` already names the ticket interface). Its proof, services, retry timing and generation fences are parameters. Pauses are scoped per provider. Graph's 503 and the throttled sub-responses of a 200 `$batch` are recorded like a top-level 429.
7. **Stage 0 can't leave a half-supported kind.**
   - `createRegistry` refuses `outlook` (it would fall through to IMAP today), as does the web worker's registry.
   - The renderer's reconnect and settings switches change in the same stage as the union.
   - A test proves an existing `googleClientId` still selects its issuing client for reconnect and refresh.
   - Gmail keeps its `127.0.0.1` redirect in the shared loopback.
8. **Flags need targeted reads.** `flagSnapshots` means answering `pendingFlagSnapshots` for settled ops, which an empty delta can't. Those targets are read by immutable id (`$select=isRead,flag,parentFolderId`) and applied through `updateFlags`. Both stores bind pending intents on promotion only for Gmail today, so Outlook joins that branch.
9. **Send.**
   - Direct `sendMail` is matched to its Sent copy through the Message-ID promotion both stores already do for non-IMAP `local:` rows.
   - The draft path keeps the draft's immutable id, creates the draft without the large files, uploads each through an upload session, then calls `POST /messages/{id}/send`.
   - `beforeSubmission` runs right before the final send. Draft and upload calls are retryable; the send call is the submission boundary, and a 202 is acceptance.
   - Upload-session URLs may be on `outlook.office.com`. The privacy section names it as the user's mail provider.
   - Interruption tests run on both sides of the boundary.
10. **Remaining provider surface.**
    - The op kinds `archive`, `spam`, `notSpam`, `moveToInbox`, `moveToFolder` and `leaveFolder` map to moves, with retries safe after partial success.
    - `verify` is one `/me` read. `close` aborts its lifetime.
    - `readBody` is `$value` with credit release.
    - The folder catalog is paged, with delete acknowledgements and lost-response recovery (plan 107).
    - Search honours `before`, `limit`, cancellation and `partial`, and its hits ingest as historical.
    - Quick checks honour `sink.quick` and call `again()` when the Inbox delta needs recovery.
11. **Gates.**
    - `pnpm test:all`: schema and shared store.
    - `load.perf.test.ts`, `test:ui-perf` and `ui:gate`.
    - A populated v78 → v79 upgrade on Node and WASM.
    - Mixed Gmail and Outlook op claims at mailbox scale, so one provider's pause never blocks the other and the `ADMITTED` query holds.
    - The packaged smoke (`dist:mac`, `test:smoke`) for the real loopback and reconnect.

## Owner decisions needed before building (revised)

1. Go-ahead for **stage 0a**: the OAuth machinery made provider-neutral. It is renames plus parameterised policy, with no behaviour change for Gmail.
2. Go-ahead for **stage 0b**: a folder-membership model for a REST provider whose mail sits in one folder at a time (store contract, SQLite, IndexedDB, conformance), and the v79 table rebuild.
3. Graph rather than IMAP with OAuth.
4. Web parity deferred to its own plan.

## Owner decisions so far

- 2026-11-24: the web version is ignored for now (decision 4). Stage 4 waits, and the web's Add account shows no Microsoft option.
- 2026-11-24: Microsoft setup done. The apps "Terno" (release) and "Terno Dev" (dev) are verified publisher Luisiacc LLC. The release id is the `release` environment secret `TERNO_MICROSOFT_CLIENT_ID`, next to `TERNO_GOOGLE_DESKTOP_ID`; both ids are in `.env`. Stage 1 reads it in `release.yml` as `secrets.TERNO_MICROSOFT_CLIENT_ID`.
- 2026-11-24: the owner approved stages 0a and 0b and asked for them built in a worktree.

## Stage 0a as built

- Kinds, admission, op lanes, request policy, OAuth clients and the shared loopback and session are as in stage 0a above, with these differences:
  - Outlook's services join the cooldown ledger (`OAUTH_SERVICES`) only with its Graph provider (stage 2). Until then an Outlook account gets no request policy, and Gmail's ledger never holds it.
  - The remembered client is per provider (`googleClientId`, `microsoftClientId`).
- The SQLite step is v81 (v79 and v80 went to plans 261 and 267). Following plan 267's new rule, it drops the kind and provider CHECK lists rather than widening them, and the stores check kinds on write.
- The Codex code review found six issues, all fixed with a test that fails without the fix:
  1. An admission names its provider.
  2. Bindings are held only on their own provider's services.
  3. The remembered client key matches the plan.
  4. Google's cooldown path is taken only by an account with a request policy.
  5. The loopback passes `error_description`.
  6. The web worker gives Outlook its own words.

## Stage 0b: where an Outlook message lives (design)

`message_locations` is IMAP's: every row is a server copy addressed by (mailbox, uidvalidity, uid). That address feeds:
- identity holds, `dispatch` and `mappedMove`
- capture-repair locators and their triggers
- uid-ordered rebuilds and counts
- folder aliases by uidvalidity
- `pendingBodies`

None of these applies to Graph, where a message is in exactly one folder and its immutable id (in `messages.provider_msg_id`) is its identity. Reusing the table with made-up uids would run all of that on Outlook rows. So the design is:

1. **A table.**
   - SQLite v82: `message_folders(message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, account_id INTEGER NOT NULL, folder TEXT NOT NULL)` with `INDEX message_folders_folder(account_id, folder, message_id)`. It is shape only.
   - IndexedDB gets the same as a store keyed by `message_id`, with `account_folder` and `fk_message_id` indexes, deleted with its message.
   - The primary key is the rule: one folder per message, and a move is one write.
2. **Ingest.**
   - `IncomingMessage.folder?: string` is the folder key (the Graph folder id), beside `locations` (IMAP) and `gmailLabels` (Gmail).
   - Ingest writes it for a new row and replaces it for an existing one (a move the delta reported), then `recomputeThreads` updates membership in the same transaction, as it does for locations.
   - A removed message takes its row with it (cascade, and the IndexedDB delete).
   - The provider sends inInbox, isTrash, isSpam and isSent itself, as Gmail does.
3. **Membership, counts and export.** Each place that reads locations "as places" gains a third branch on `message_folders`, in both engines:
   - `MEMBERSHIP` and `writeFolders`, and `overlayFolderOps` (pending moves replayed)
   - `placed` and `countFolderMessages` (a seek on the folder index)
   - folder export's `IN_FOLDER`
   - `replaceFolders`' rebuild gate
   - `rebuildFolders`

   None of the IMAP-only paths read it (holds, aliases, uid walks).
4. **Moves.**
   - `queueFolderMoves` becomes a three-way choice by kind: Gmail's labels, IMAP's locations, Outlook's single folder.
   - "Your own mail stays in Sent" holds for IMAP and Outlook, because both keep sent mail in a Sent folder.
   - `keepInbox` is IMAP's COPY. Graph has no second place for one message (its `/copy` makes a new message), so an Outlook move is always a move: `keepInbox: false`. A thread whose category is shown in the Inbox, filed to a folder, leaves the Inbox on the server.
   - `settleFolderOp` writes the folder on success, as it writes Gmail's labels. The provider's answer is the folder the message is now in, so no provider-side settling is needed.
   - `leaveFolder` (undo) is a move back.
   - Archive, trash, spam, notSpam and moveToInbox set flags as for IMAP. The provider moves the message, and ingest or settle writes its new folder.
5. **Not used for Outlook:**
   - identity holds, `dispatch`, `mappedMove`, `resumeResolved`
   - `pendingBodies` (Graph reads a body by id)
   - capture-repair locators by uid (an `outlook` locator with the Graph id comes in stage 2)
   - folder aliases (Graph folder ids survive renames)
6. **Tests.** An Outlook fixture joins the store conformance suites `folders.ts`, `folder-move.ts` and `folder-export.ts`:
   - membership from `folder`, a move settling, Sent kept, undo
   - counts, export
   - a delta-reported move by re-ingest, and removal

   Each runs in both engines.
7. **Perf.** The membership queries gain one indexed branch that finds nothing for IMAP and Gmail accounts. The `store.perf` and `folders.perf` gates must hold at 50k.

**Owner decision flagged:** an Outlook move of a thread that Terno keeps in the Inbox is a plain move (it leaves the Inbox on the server), since Graph can't keep one message in two folders. The alternative, a Graph copy, would put a second message in the thread.

## Revisions to the stage 0b design after the Codex critique

The critique (11 points) showed that 0b is two pieces of different weight:

- **Storage and membership (no provider needed).** These are buildable and testable now with an Outlook fixture:
  - v82 `message_folders`, and the IndexedDB store with its physical upgrade (`IDB_VERSION` 40 → 41, `onupgradeneeded`, the cascade, satellite loading).
  - `IncomingMessage.folder` on insert and on the existing-row path. It holds a user folder only; a role folder is null, its flags saying which. An omitted folder keeps the stored one.
  - The membership branch, `writeFolders`, and the overlay replayed one folder per message.
  - A bounded `(account, folder, message_id)` count walk.
  - Export using the same state at both steps.
  - A rebuild cursor for Outlook, with pending moves preserved.
  - Conformance in both engines, and populated 50k cases in `store.perf`, `idb.perf`, `filter-folder.perf` and `folder-export.perf`.
- **Move semantics and settlement (need Graph's answers).** These are designed and built with the Graph provider in stage 2, because each rule follows from what Graph returns:
  - One provider move per filing (no archive after `moveToFolder`), with `kept` and `leftInbox` from the resulting state.
  - A per-message source journalled for undo.
  - A confirmed destination per message for every location op (archive, trash, spam, notSpam, moveToInbox, move, leave), including partial success, unknown outcomes and a delta read racing a settlement.

  Until stage 2 no Outlook op runs: the registry refuses the kind.

## Stage 0b as built

The storage-and-membership half, as revised after the critique. Move semantics and settlement wait for stage 2.

- **The table.**
  - SQLite v82 `message_folders` and its `(account_id, folder, message_id)` index are shape only, with no `rewrites`.
  - IndexedDB v41 adds the `message_folders` store: keyed by `message_id`, with `fk_message_id` and `account_folder` indexes, cascaded with its message, and loaded with the late tables. `LOGICAL_SCHEMA` is 82.
  - Two tests that name the newest step learned of it. `upgrade.test.ts` now runs v81 as `migrate` does, with foreign keys off. `idb.uncertain-upgrade.test.ts` lists the new store.
- **Ingest.** `IncomingMessage.folder` is written on insert and on the existing-row path. Absent keeps the stored folder, and null deletes it. Ingest ignores it for an account that is not one-folder (`oneFolderPerMessage(kind)`, Outlook only). The shared rule lives in `@terno/store` (`folder-move.ts`), the SQL in `db/message-folders.ts` and the IndexedDB code in `idb/message-folders.ts`.
- **Membership.** `MEMBERSHIP`, `writeFolders` and IndexedDB's `refreshFolders` read `message_folders` beside labels and locations.
  - SQLite seeks by the thread index, then by the primary key. A test pins that query plan.
  - `writeFolders` and IndexedDB read the table only while it has rows, so an IMAP or Gmail mailbox pays one probe.
  - The pending-move overlay replays an Outlook message's ops with `applyFolderOpOne`. A move replaces the one folder whatever its `from` says, so A → B never shows the message in both.
- **Counts.** An Outlook account's `folders.count` walks `(account, folder, message_id)` past the last id: by the index in SQLite, and by the folder's index bucket kept between slices in IndexedDB.
  - It counts where the server has the message now. A move on its way has moved nothing yet, and mail trashed locally still counts, as with IMAP's locations.
  - A key named twice counts once. There are no thread rows, labels or merge restarts.
- **Export.** An Outlook folder's export walks its messages by id: by the index in SQLite, and by sorted runs of the bucket in IndexedDB, with the `folderMessage` cursor. It reads one state at both steps, so a message mid-move is exported once, from the folder the server has it in.
- **Deviation: no rebuild for Outlook.** The plan asked for a rebuild cursor with pending moves preserved. Outlook membership, like Gmail's labels, never waits on the folder list: Graph's ids are the keys and survive renames. So listing, unlisting or relisting a folder has nothing to rebuild, and `replaceFolders`' gate stays IMAP's. The conformance suite covers ingest before listing and unlist then relist.
- **Not read for Outlook.** Identity holds, dispatch, `mappedMove`, aliases, UID walks, `pendingBodies` and capture locators never read `message_folders`. No `body_protocol` trigger watches it, since Graph reads a body by id.
- **The seam for stage 2.**
  - `queueFolderMoves` still plans an Outlook move as IMAP does: it reads `message_locations`, which is empty for Outlook.
  - `settleFolderOp` writes nothing for Outlook, so until a delta read reports the move, a settled move shows the confirmed folder again.
  - Stage 2 adds the Outlook branch to `queueFolderMoves`, using `applyFolderOpOne` for the replayed source. It also writes the confirmed folder in `settleFolderOp` and for the other location ops. The registry still refuses Outlook ops, so none of this runs before then.
- **Tests.**
  - Conformance in both engines, including SQLite-WASM:
    - membership from `folder`
    - a re-ingest move, absent and null
    - reopen, trash, removal and a mixed thread
    - unlisting and relisting
    - the overlay, replayed in order, with failures
    - counts, sliced and across a refilled bucket
    - export, including during and after a move
  - An IndexedDB v40 → v41 upgrade with rows, a reopen, and deletion with the message and with the account.
  - A SQLite test of the cascades and the query plan.
- **Perf at 50k.** The Outlook cases put 50,000 messages over 250 folders, 25,000 of them in one.
  - SQLite (`store.perf`): pages, sidebar counts, triage and a 200-message delta read, plus counts and export a slice at a time, including a 10,000-folder subtree.
  - IndexedDB (`idb.perf`): the same, with the export's pending runs.
  - `filter-folder.perf`: Outlook filing stays within 2.5× an archive.
  - `folder-export.perf`: the backend's nexts for an Outlook folder in both engines.
- **What the Codex code review changed.** There were two rounds. Each fix came with a test that fails without it.
  - Round 1 (9 findings):
    - #2: an IndexedDB count missed a message that arrived after the folder's index bucket emptied and was remade. The walk now notices the new bucket and walks it, skipping what it already counted.
    - #4: SQLite searched the earlier keys for every key, about 270 ms a slice at 10,000 folders. Each key's first place is now found once a call, and the perf case counts a 10,000-folder subtree.
    - #5: IndexedDB counted `"A"` and `{ mailbox: "A", except: [] }` as two folders.
    - #6–#8: the perf cases now page the folder's own deep page, change state in every triage sample, and gate the membership recompute.
    - #9: tests now show that a folder row goes with its message and with its account, in both engines.
    - Skipped, as rare and shared with existing paths:
      - #1: a message moved between two folders of one subtree between count slices is counted twice. IMAP's count does the same, and the number is only a delete confirmation's.
      - #3: an IndexedDB export misses a message moved into the folder, ahead of its cursor, after the walk's runs were read. Every IndexedDB folder export already behaves this way.
      - #8's backend export over 16,384 messages: `idb.perf` gates the pending-run path at 24,800.
  - Round 2 (6 findings):
    - #5: the count walked the bucket directly, so the existing visits test measured nothing. It walks the index's keys again.
    - #3: a message another generation held was marked as passed, so it was missed when it came back under this folder's own generation in a new bucket. Only a counted message is passed for good now.
    - #6: the SQLite triage gates pair each change with its undoing on one thread, and check it.
    - Skipped:
      - #1, a rebuild for Outlook keys: no Outlook path asks for one (see the deviation above).
      - #2: SQLite's id cursor misses an older message that moves in behind it mid-count. This is the same race as #1, and as rare.
      - #4: a lost IndexedDB walk replays by position. This predates the series and needs a walk evicted mid-count.
- **`pnpm test:all`.**
  - It found one more defect. Fixtures that run today's ingest against an older mailbox (the opening and legacy-body tests) failed with "no such table". SQLite membership now reads `message_folders` only while it has rows, and a schema before v82 counts as having none, as `folderOpsPending` does for a missing index.
  - Everything else that failed also fails on the base: unit, `db-wasm` (`tabs.test`), 17 e2e, 10 smoke, and the five perf files already failing there.
  - The `idb.perf` gates missed by a few milliseconds on the loaded first pass, and all 25 pass run alone.


## Stage 1 as built

Everything in stage 1 except the visible "Continue with Microsoft" button, which is stage 3. The schema step is stage 0a's v81. The build wiring of `TERNO_MICROSOFT_CLIENTS` was also already in place from stage 0a.

- **Shared OAuth pieces, lifted out of the Gmail code.** Gmail moved onto them, and its suites pass unchanged.
  - `oauth-flow.ts`: the sign-in's deadline and cancel, bounded JSON answers, and the RFC 6749 token-response check. Each provider names its own words.
  - `oauth-refresh.ts`: the refresh exchange. The provider names its refusals, its scope check, extra form fields (Microsoft's `scope`) and its words.
  - The loopback's redirect path and malformed-answer page are now per provider.
- **`packages/mail/src/microsoft.ts`.**
  - `connectMicrosoft` signs in on `http://localhost:<port>` with no path. The listener is on 127.0.0.1, and Entra matches the registered `http://localhost` by its path and ignores only the port.
  - It uses PKCE S256, a state, and `response_mode=query`. A new connection sends `prompt=select_account`; an account signing in again sends `login_hint` instead, since Microsoft doesn't take the two together.
  - The code exchange is a public client's: no secret, with `scope` sent.
  - The person comes from Graph's `/me` (`mail`, else `userPrincipalName`, and `displayName`) and the id_token's `tid` and `oid`. The subject is `<tid>:<oid>`, and the tenant is `consumers` for the documented consumer tenant id, else `organizations`.
  - The id_token isn't signature-checked: it comes straight from the token endpoint over TLS (OIDC Core §3.1.3.7). Its `aud`, `iss` (the tenant's v2.0 issuer) and `exp` are checked.
  - A mailbox probe (`/me/mailFolders/inbox?$select=id`) refuses an account with no Outlook mailbox before anything is kept. Examples are a work account without an Exchange Online licence, or a personal Microsoft account under another provider's address.
  - Token and Graph requests, and every refresh (Gmail's too), refuse redirects. A code, its verifier or a refresh token is never replayed elsewhere.
  - `exchangeMicrosoftRefresh` and `createMicrosoftSession` are the rotating refresh session over `createOAuthSession`. `invalid_grant`, `interaction_required` and `consent_required` mean signing in again (`errors.microsoft.revoked`). A renewed grant without mail means `errors.microsoft.permissionRequired`.
- **`microsoft-scopes.ts` (portable).** It holds the scopes, the consumer tenant, and `microsoftMailGranted`. The grant check reads Microsoft's bare or resource-URL spellings in any case, so the backend checks a grant on every host.
- **Error words** (`errors.microsoft.*`, en and es):
  - `denied`: `access_denied`.
  - `consentRequired`: AADSTS65001 or `consent_required`. This is consent not given, which the person may still give; the copy also says an administrator may have to allow Terno.
  - `adminConsent`: AADSTS90093, 90094, 90095 or 900941, an administrator's approval.
  - `noMailbox`, `mailScopeRequired`, `invalidResponse`, and the flow and refresh words.
  - The callback page has its own Microsoft keys.
- **Registry.** `connectMicrosoft` is optional on `ProviderRegistry`: test and demo registries lack it, and the backend then says Microsoft needs the desktop app. The web worker's registry refuses it with `errors.microsoft.needsDesktop`. `create()` for an outlook account still returns the not-yet provider.
- **Endpoints move for tests** like Google's. They go through `createRegistry({ microsoft: { endpoints } })`, and `startDevServer` takes `microsoftClients`. `packages/mail/src/test/microsoft.fixture.ts` is a synthetic Microsoft. It matches the registered redirect as Entra does, checks PKCE, takes public clients only, rotates refresh tokens, and issues an id_token. It also answers `/me` and the mailbox probe. Stage 2's Graph tests can extend it.
- **Backend.**
  - `accounts.connectMicrosoft` keeps `OutlookAccountConfig { senderName, microsoftSubject, microsoftClientId, tenant }` and the refresh token in `account:N:refreshToken`. When it may, it claims the owner as `provider: "outlook"`, `verifiedBy: "microsoft_oauth"`, with evidence `{ microsoftSubject, tenant }`.
  - `validateMicrosoftConnection` checks the identity, the refresh token and `Mail.ReadWrite` with `Mail.Send`.
  - Reconnect and owner change go through `connectExistingMicrosoft`: the remembered registration, `login_hint`, and Microsoft's own refusal words. Another mailbox is refused as `errors.microsoft.connectedOther`, and another person behind the same address (a new `oid`) as `errors.microsoft.invalidResponse`. Admission compares `microsoftSubject` atomically through stage 0a's `oauthAdmission`.
  - `oauthCredentialIntent` (renamed from `googleCredentialIntent`) refuses an omitted refresh token for any kind but Gmail.
  - Removal changes nothing: the store deletes the secret, and no revoke is tried.
- **Deviations from the plan.**
  - There is no `beginMicrosoftRenewal`. Microsoft documents a refresh token on every code exchange that asks for `offline_access`, so a missing one is an invalid response. A cold renewal path would be built on undocumented behaviour.
  - `HttpRequestContext` gained `graph-api`, `microsoft-token` and `microsoft-identity`. `COOLDOWN_SERVICES` and `OAUTH_SERVICES` did not, for two reasons:
    - Stage 1's only Microsoft traffic is the interactive sign-in, one bounded flow through `fetchFor("mail")`, and nothing refreshes while `create()` is not-yet.
    - The ledger would carry rows per owner for services nothing asks.
    Stage 2 adds the three to both, with the Graph provider, and gives the sign-in an installation-scoped policy if Graph's throttling calls for it.
- **For stage 2.**
  - The provider gets its access tokens from `createMicrosoftSession(ctx, { endpoints })`, through `get(run?, admission?)`, `invalidate(token)` and `close()`.
  - `ctx.oauthClient()` resolves the account's `microsoftClientId` (stage 0a), and `ctx.requests` stays undefined until `OAUTH_SERVICES.outlook` exists.
  - Graph calls should refuse redirects as the sign-in does.
- **Left as they are.**
  - Two connects of the same address finishing together can both pass the "already connected" check. This is the same check-then-create race Gmail and IMAP have; a store-level uniqueness guard belongs to its own change across kinds.
  - An Outlook account connected over RPC before stage 2 polls into the not-yet error. No UI can create one until stage 3, and stage 2 replaces the provider, so no special scheduling was added for the placeholder.
- **Codex code review.** It found 10 issues. These were fixed, each with a test that fails without the fix:
  1. The redirect path.
  2. `prompt` beside `login_hint`.
  3. Redirects on token requests.
  5. The mailbox probe.
  6. The id_token's `iss` and `exp`.
  8. Consent versus an administrator's approval.
  9. The remembered registration on reconnect.
  10. The rotating fixture and the delayed write.

  Issues 4 and 7 were left as described above.

  A second round on the fixes found four more:
  1. AADSTS90093 and 900941 are administrator blocks too. Fixed.
  2. Reconnect's `login_hint` is the mailbox address, which can differ from a work account's sign-in name. Left: Entra then asks for the name, and stage 3 can keep the id_token's `preferred_username` for the hint if that proves common.
  3. Graph's identity read and mailbox probe had no redirect test. Added.
  4. The rotation test now holds the write itself.

## Stage 2a as built

The read side of the Graph provider. Writes (flags, moves, archive, trash, spam, folder changes, send), the store's Outlook move semantics and `$batch` are stage 2b's.

### What Microsoft's docs say, and what each choice rests on (checked 2026-11-24)

- **Immutable ids** ([outlook-immutable-id](https://learn.microsoft.com/graph/outlook-immutable-id)): `Prefer: IdType="ImmutableId"` "only applies to the request it is included with", so every Graph call sends it. An id "will NOT change if the item is moved to a different folder in the mailbox"; it changes only when moved to an archive mailbox or exported and re-imported. Delta links "are compatible with both ID formats". Folder ids aren't immutable ids, but "their regular IDs were already constant".
- **Limits** ([throttling-limits](https://learn.microsoft.com/graph/throttling-limits), "Outlook service limits"): per app and mailbox, "10,000 API requests in a 10-minute period" and "Four concurrent requests". The provider holds four slots (every Graph call takes one until its body is read) and paces 15 requests a second with a burst of 900 (under 10,000 in ten minutes). A JSON batch runs "up to four individual requests from the batch at a time" (stage 2b).
- **Throttling** ([throttling](https://learn.microsoft.com/graph/throttling), [errors](https://learn.microsoft.com/graph/errors)): a throttled request gets "429 Too Many Requests" with `Retry-After`; a 503 is "overloaded. You can repeat the request after a delay, the length of which can be specified in a Retry-After header". `requestHttp` (`throttled()`) records a 429, and a Microsoft endpoint's 503 with a Retry-After, in the cooldown ledger. A throttled sub-response of a `$batch` "fails with a status code of 429" inside a 200 batch: stage 2b records those through the same ticket.
- **Delta** ([delta-query-messages](https://learn.microsoft.com/graph/delta-query-messages), [message-delta](https://learn.microsoft.com/graph/api/message-delta), [delta-query-overview](https://learn.microsoft.com/graph/delta-query-overview)):
  - "Delta query is a per-folder operation." The only filters are `receivedDateTime ge|gt`, the only order `receivedDateTime desc`, and "Applying `$filter` in a delta query returns only up to 5,000 messages."
  - `Prefer: odata.maxpagesize` sets a page's size. A page holds `@odata.nextLink` or `@odata.deltaLink`, never both.
  - "`@removed` entries with `"reason": "deleted"` when an item is deleted or moved from the folder", and read changes are returned even for messages the filter doesn't match.
  - "A single entity can be contained multiple times in the response" and replays happen: a page keeps each id's last entry.
  - An expired link is "410 Gone" or "a 40X-series error with error codes such as syncStateNotFound"; Outlook's token lifetime "isn't fixed".
- **Listing** ([user-list-messages](https://learn.microsoft.com/graph/api/user-list-messages)): `$orderby` properties "must also appear in `$filter`", in the same order; `$top` is 1 to 1000; the next page is the whole `@odata.nextLink`.
- **Bodies** ([message-get](https://learn.microsoft.com/graph/api/message-get)): `GET /me/messages/{id}/$value` "returns the message content in MIME format".
- **Folders** ([mailfolder](https://learn.microsoft.com/graph/api/resources/mailfolder)): well-known names "work regardless of the locale". v1.0's mailFolder has no well-known-name property, so each role is read by its name (`GET /me/mailFolders/inbox`, …). Listing returns non-hidden folders only by default; `childFolderCount` says whether to read `childFolders`; a search folder is a `mailSearchFolder`.
- **Search** ([search-query-parameter](https://learn.microsoft.com/graph/search-query-parameter)): "Search results are sorted by the date and time the message was sent", "up to 1,000 results", with KQL properties `from`, `to`, `subject`, `hasAttachments` and the default from/subject/body.

### The provider (`packages/mail/src/graph-api.ts`)

- **Requests.**
  - `createGraphApiProvider(ctx, { tokens, endpoints })` is the adapter. `createGraphProvider` puts it over `createMicrosoftSession` (stage 1), and `close` ends both.
  - Every call goes through `ctx.requests.request` when the backend installed a policy (never `ctx.fetch` then), with `redirect: "error"`.
  - Every target is checked after the URL parser's normalization. A path or link must keep Graph's origin and its `/v1.0/` prefix (a `%2e%2e` segment can't climb out), or it's refused as an invalid answer. Mail never goes anywhere else (plan 97).
  - A slot is held until a response's body is read. A 401's is drained (bounded) before its retry.
  - A 404 means "not there" only when Graph's error code was read and it isn't the mailbox's own (`MailboxNotEnabledForRESTAPI` / `MailboxNotSupportedForRESTAPI`, [Exchange troubleshooting](https://learn.microsoft.com/troubleshoot/exchange/user-and-shared-mailboxes/rest-api-is-not-yet-supported-for-this-mailbox-error)). Nothing is removed on the mailbox's refusal.
  - JSON bodies are bounded (2 MiB a page, 64 KiB otherwise).
  - A 401 renews the token once; a second is `ProviderAuthError(errors.microsoft.revoked)` through `tokenResult`.
  - The mailbox proof is `/me` (`mail`, else `userPrincipalName`, as the sign-in read it), under `microsoft-identity`.
- **The ledger.**
  - `COOLDOWN_SERVICES` gains `graph-api`, `microsoft-token` and `microsoft-identity`, and `OAUTH_SERVICES.outlook` names them, so the backend installs Outlook's request policy (`core.ts`).
  - Op admission (`provider-cooldown.ts`, `core.ts operationAdmission`) gives each OAuth kind its own lanes from its own services, so a Gmail pause never holds Outlook's ops and the reverse.
  - A sync that failed on a recorded throttle (a 429, or Graph's 503 with a Retry-After) waits on the ledger's pause, never a connectivity retry beside it (`core.ts`, the same `throttled()`).
  - A pause says "Outlook is paused" for Microsoft's services (`net-errors.ts`, en and es).
- **Folders.**
  - The roles (Inbox, Sent Items, Drafts, Deleted Items, Junk Email, Archive) are read by their well-known names. A 404 is a role the mailbox doesn't have.
  - The Outbox, Conversation History and Sync Issues, and everything under them, are never synced.
  - Every other folder from the top, and its children where `childFolderCount` says so, is a folder keyed by its Graph id (renames keep keys). Children are read four at once and taken in their parents' order. This is bounded at the account folder cap and 64 levels. The folders synced are exactly the listed ones.
  - A folder under the Inbox shows at the top, as IMAP's INBOX children do.
  - The list goes to `setFolders` when read: on the first pass, every 15 minutes, and when a message is met in a folder the list doesn't have (once a pass).
- **Sync.**
  - Each synced folder's place is in the cursor: `{ after, startedAt, delta?, initial?, round?, list?: { next? }, at? }`.
    - `after` is where its delta's window starts.
    - `delta` is the link to read next; absent, it's the first round from the filter.
    - `round` is when the round under way began.
    - `list` is the rest of the window still to list.
    - `at` is when the last finished round began.
  - **A first sync** reads the folder's filtered delta round first (`$filter=receivedDateTime ge <window>`), downloading what it names, and keeps its deltaLink. It then lists the rest of the window, newest first (`$filter=…&$orderby=receivedDateTime desc`, what's stored skipped). The round names at most 5,000, and how many it named never proves it named them all. What changes meanwhile is the next round's.
    - This deviates from the plan's "list first, then start delta": that order leaves a gap. A message listed and then deleted before the delta's first round is never reported (Codex code review #1).
  - Each page's place is saved only after its effects. A message held back by its own content (plan 265) keeps the page to be read again.
  - The Inbox goes first, then the other roles, then the person's folders. The roles' deltas are read every pass and the person's folders' at most every 5 minutes (in memory).
  - A first sync's listing works FIRST_SYNC_CHUNK_MS a pass, then `again()`. A delta reads at most 100 pages a pass.
  - Flags come from the folder's role (`inInbox`, `isTrash`, `isSpam`; `isSent` set in Sent and never cleared by a move, as Gmail's label), plus `isRead`, `isDraft` and `flag.flagStatus === "flagged"`.
  - `folder` is the Graph id for a person's folder and null for a role folder. `providerThreadId` is null: RFC references thread (revision 3).
  - A delta's update entry carries only what changed, so absent fields are left unchanged. Entries for one id in a page merge.
  - A message the store doesn't have, received inside the window, is downloaded. One whose entry names no date is read by id first; one found outside the window is remembered for that window (up to 10,000), so its read changes aren't read again. A change to one outside the window (a read state the docs say is always returned) is nothing.
  - A nextLink or deltaLink that can't be used is never saved. A first round out of the pass's share stops the pass's folders, as a listing does.
  - **`@removed`** (revision 4) is "left this folder". If this pass already saw the message in another folder, nothing is done. Otherwise it's read again by id: a 404, or a folder Terno doesn't sync (after one list refresh), removes it here; anywhere else, its flags and folder are written.
  - **An expired delta** (410 or syncStateNotFound) starts that folder's first round again and asks for the reconciliation. One already under way keeps its place, and the new one runs after it. Every stored message is read again by id (`syncedMessagePage`, 50 at a time, within the pass's share) and placed or removed by the same rule. What went during the gap is found that way, never guessed from what's missing.
    - This costs a read per stored message, paced. Expiry and a folder's deletion are the rare events that pay it.
  - **A folder gone**: its own listing or delta 404s (not the mailbox's 404), or it drops out of the list. Its place goes and the same reconciliation runs. A quick check that meets it leaves it to an ordinary pass.
  - **Live** (plan 41): Inbox mail received after the folder's first round began, or, past it, after the last finished round began (less 10 minutes for the two clocks). An old message moved into the Inbox never notifies, nor does one an undated Inbox entry turns out to be in another folder.
  - **A wider window**: when a backfill finishes, each folder whose window began later starts a new first round from the wider one, and the reconciliation runs. A filtered delta reports only read states and removals across its filter, so flag changes to backfilled mail would otherwise go unseen. The reconciliation covers what the old links would have reported between their last round and the new first one.
- **Bodies.**
  - `$value` MIME streams through the incoming pool (`ctx.incoming.acquire`/`promote`, 50-message or 4 MB batches, read credits) four at once.
  - A small plain message is parsed inline; everything else goes to the worker as `{ kind: "mime" }`.
  - Over the capture policy (`MAX_INCOMING_MIME_BYTES`), the body is cut at one byte past it and the worker reads its headers only (`captureUnavailable: "size"`), as IMAP's does, so a huge message never holds a folder's place.
  - `readBody` reads `$value` with a reader credit and releases it. `describe` reads `subject`, `from` and `receivedDateTime`.
- **Attachment capture**: a stored message missing its attachments is read by id and downloaded. One that's gone, or in no folder Terno syncs, is removed, so it never holds the head of the list.
- **Flag snapshots** (revision 8): `pendingFlagSnapshots` are answered by targeted reads (`$select=id,receivedDateTime,isRead,isDraft,flag,parentFolderId`) applied through `updateFlags`. A share goes each pass (FLAG_SNAPSHOTS_MS, then `again()`). `FlagUpdate` gained `folder` (ingest's rule), written by both engines in `updateFlags`.
- **Capture repair** (revision 3): `{ kind: "outlook", providerId }` (the immutable id) goes through `captureKey`/`captureLocator`, both validators (an Outlook locator only on an Outlook account), both engines' attachment-body skip, the repairs list's `describe`, and the backend's eviction fence. A repaired message that 404s is retired: an Outlook "gone", never `ProviderIdentityError`.
- **Quick checks** (`quickChecks: true`): one Inbox delta request when nothing is new. No folder list yet, a first sync, or an expired link asks for an ordinary pass with `again()`.
- **Search**: `GET /me/messages?$search="<KQL>"` from the query's words only. `before`, `after` and `limit` are applied to each hit's `receivedDateTime`, and stored messages are skipped. `partial` is set when the page bound or Graph's 1,000 cuts it short of the limit.
  - No date restriction is put in the KQL: its date comparisons aren't on Graph's page. `fetchHits` reads each hit's folder and downloads it as old mail; a hit in a folder Terno doesn't sync isn't stored.
- **Backfill** (plan 101): a widened window lists `/me/messages` over the asked span, newest first. Messages in synced folders that aren't stored are downloaded, the place goes in the cursor, and `backfillDone` comes at the end. It waits for every folder's first listing and round.
- **`execute`** refuses every op with `errors.outlook.actionNotYet` (non-retryable) until stage 2b.
- **The registry** gives an `outlook` account the Graph provider. The web worker keeps its not-yet provider.

### Shared changes

- `rest-provider.ts`: Gmail's request deadline, download pool (now with a width), inline-parse check and message-failure classes moved out of `gmail-api.ts` unchanged; the Gmail suites pass as they were.
- The synthetic Microsoft (`test/microsoft.fixture.ts`) is now a Graph mailbox. It has well-known and personal folders (and a search folder), messages with MIME, delta rounds per folder (5,000 with a filter, `@removed` when a message leaves, 410 or syncStateNotFound once links expire), listings newest first, `$search`, throttling with a Retry-After, a count of requests at once, and a record of any call without the immutable-id header.
- `apps/backend-dev` needed no change: `startDevServer({ providers: createRegistry({ microsoft: { endpoints, requestsPerSecond } }), microsoftClients, openExternal })` connects and syncs an Outlook account against the synthetic Microsoft (`server-outlook.test.ts`).

### Tests

- `graph-api.test.ts` (against the synthetic Graph):
  - the first sync (listing, then delta; flags, folders, the catalog without system or search folders; the immutable-id header on every call)
  - a quiet pass at one delta request per folder, and a quick check at one in all
  - live and quiet arrivals, delta paging with each page's place saved after its effects
  - a held message keeping its page, and a repair letting it go on
  - a move seen in both folder orders and across a restart, deletion and a move to an unsynced folder
  - both kinds of expiry with the reconciliation
  - four at once asserted, a 429 and a 503 with Retry-After reaching the ledger with no retry of their own, a link off Graph's root refused
  - flag snapshots with folder and a 404, `readBody`, search with `before`, `limit` and hits fetched as old mail, KQL, and the 401 path
- `registry.test.ts`: an Outlook account gets the Graph provider and verifies with a rotated token.
- `microsoft-connection.test.ts`: a full backend sync through the request policy, and a move followed. The reconnect test now uses a quiet provider, since a real one rotates the token on its own pass.
- `provider-http.test.ts` (503 rules), `net-errors.test.ts` (pause words), `provider-cooldown.test.ts` (Outlook's own pause and lanes).
- `capture-repair-store.int.test.ts` (the Outlook locator in SQLite, IndexedDB and WASM), and the `folders` conformance case (a flag update's folder) in both engines.
- The Codex regression tests in `graph-api.test.ts` (rounds 1 and 2) each fail on the code before their fix. `microsoft-connection.test.ts` holds round 1's #12. `oauth-retry.test.ts` (stage 0a #4) now uses an IMAP account: Outlook has its request policy now.
- **Perf:** `graph-sync.perf.test.ts`, Gmail's batches gate for Graph. A 20,000-message Inbox goes through:
  - the first round's 5,000, downloaded
  - the window listed: the 5,000 back as flag updates, 15,000 downloaded
  - the next round

  All of it is stored 50 at a time, within 50 µs a message of CPU, with exact request, transaction and cursor-write counts.

### For stage 2b

- **`execute`**: the ops land here. A move is `POST /messages/{id}/move` and its answer (the message in its new folder) settles the op. `settleFolderOp` and the other location ops write the confirmed folder (stage 0b's seam), and `queueFolderMoves` gets its Outlook branch.
- **`$batch`**: a throttled sub-response must reach the ledger like a top-level 429. `requestHttp`'s ticket sees only the batch's 200, so the batch's reader calls the ticket's `headers429` for its sub-responses (a descriptor hook beside `onForbidden`), and the four-slot gate counts a batch as one request (Graph runs at most four of its requests at once).
- **Settlement against deltas**: a delta read can race a settled move. The stored folder is server truth and the overlay replays pending ops (stage 0b), so stage 2b writes the move's answer and lets the next delta confirm it.
- **The fixture**: `SyntheticMicrosoft` has `move`, `setRead`, `setFlag`, `destroy` and `expireDelta`, and logs every change for the deltas. Stage 2b adds POST/PATCH/DELETE routes on `/me/messages/{id}` (`/move`, `isRead`, `flag`), `/me/mailFolders/{id}/childFolders`, `/me/sendMail` and `$batch` beside them.
- **Send**: `POST /me/sendMail` and the draft path (plan revision 9); the Sent copy arrives through the Sent folder's delta.

### What the Codex code review changed

Two rounds, each finding fixed with a regression test that fails without the fix, except where noted.

**Round 1 (12 findings, all fixed):**

1. Listing first and starting the delta after left a gap: a message listed and then deleted before the delta began was never reported. The first round's link is kept first now.
2. A sparse duplicate replaced a full entry, so a new message was skipped. Entries for one id merge, and an undated new one is read by id.
3. A mailbox-level 404 (`MailboxNotEnabledForRESTAPI`) removed messages. It never does now.
4. A deleted folder's messages stayed. Its own 404, or its leaving the list, reconciles.
5. An old message moved into the Inbox notified. Live mail must be received after the last round.
6. A widened window's mail sat outside the delta filter, so flag changes were never seen. Each folder restarts from the wider window.
7. Attachment capture never removed gone messages, so they could hold the head of the list. They're removed.
8. A relative path with `%2e%2e` escaped the prefix check. Every target is checked after normalization, at the transport.
9. The folder cap and the cursor's bound disagreed. The synced folders are the capped list.
10. A search cut short by Graph's 1,000 said it was complete. It's partial.
11. A 401 freed its slot before its body ended. The body is drained first.
12. The backend scheduled a connectivity retry beside the ledger's 503 pause. It uses `throttled()` too.

**Round 2 (12 findings):**

- Fixed:
  - #1: always list after the first round.
  - #2: a widened window's restart reconciles.
  - #3: an unreadable 404 removes nothing.
  - #4: a reconciliation asked for again keeps its place.
  - #5: a folder is gone only by its own request's 404, and a quick check hands that to a pass.
  - #6: one list refresh a pass; an undated out-of-window change is read once.
  - #7: a first round out of time stops the pass's folders.
  - #8: the live watermark is the last round's start.
  - #10: an undated entry found in another folder is stored there, quietly.
  - #11: the catalog keeps its order at the cap.
  - #12: unusable links are never saved.
- Tested: #1, #2, #3, #4, #6, #10, #12. Left untested, as each needs a minute-long pass or a 10,000-folder mailbox to show: #5's classification (#4's folder test goes through it), #7, #8, #11.
- Skipped, as rare:
  - #9: a stale replay with a conflicting value in a later entry. The next change to the message corrects it, and resolving every conflict by a read would cost a request per replay.
  - Part of #1: a deletion that shifts the listing's `$skip` between pages can skip one unchanged message until its next change. This is Graph's own paging.
  - Part of #12: a nextLink cycle across passes. A cycle within a listing is caught.
  - Part of #4: a server that lists a folder whose messages 404 every pass reconciles every pass.

### `pnpm test:all`

- **Ran once, at the end:**
  - lint, typecheck, build, web and `ui-perf` (`ui-perf` flaky on the loaded first pass) and `startup` passed.
  - Every other failure is the base's:
    - `db-wasm`: `tabs.test`. Its `store.conformance` timing passed again alone.
    - The same 17 e2e and 10 smoke.
    - Four of the base's five perf files.
  - `unit` added two failures:
    - `oauth-retry.test`: its account "with no request policy" was an Outlook one. It now uses IMAP's.
    - `idb.conformance` timeouts, which pass alone.
  - Three opening tests failed on the second pass with "no such table: message_folders" and pass alone. They run their own older schemas, so this looks like a fixture collision under the shared machine's load; noted, not changed.
- **Run per change:**
  - the mail, store, IndexedDB and backend files named above, in both engines
  - `graph-sync.perf` and `gmail-batches.perf` alone (both pass)

## Stage 3 as built

The renderer's Outlook account, on the desktop. Nothing in the provider, the store or the backend changed. The web build shows no Microsoft option (owner decision 4).

- **Add account** (`add-account-dialog.tsx`; the first run uses the same form).
  - "Continue with Microsoft" sits under "Continue with Google": the same outline button, full width, stacked. Side by side, the Microsoft label overflowed the first run's narrower column, and a longer translation would too.
  - Both glyphs come from the catalog as Hugeicons' monochrome `GoogleIcon` and `MicrosoftIcon` (`Google`, `Microsoft`). Google's button had used `Mail`; a mail glyph beside a Microsoft mark would read as two kinds of thing, so both now show their provider's mark.
  - Busy and error state are one `SignInMethod` each (`google`, `microsoft`, `password` for the IMAP form). A failure shows under the way it was tried. `BROWSER_METHODS` is `["google"]` on the web and `["google", "microsoft"]` on the desktop.
  - The outlook.com and hotmail.com IMAP presets are gone. An address on one of Outlook.com's domains (an explicit list with the best-known country versions) gets a hint under the field: "hotmail.com no longer takes passwords from other apps." It is followed by a Continue with Microsoft link, and the field is described by it. Progress and failure show beside whichever control started the sign-in.
  - The first run's subtitle names Outlook on the desktop: "Connect Gmail, Outlook, or any account with IMAP." The web keeps the old line (`firstRun.account.descriptionWeb`).
  - Settings search finds Add account by "Outlook", "Hotmail" or "Microsoft".
- **Sign-in panel** (`sign-in-panel.tsx`, `lib/sign-in.ts`). An Outlook account's action is "Continue with Microsoft". While the browser's page is open it shows Google's desktop state: "Finish in your browser" and "Open again" (the keys are now `signIn.browser.*`; the test ids are `sign-in-<method>` and `sign-in-<method>-again`). Reconnect goes through `accounts.reconnect`, so stage 1's `connectExistingMicrosoft` and its `login_hint`. Focus on the action stays on it as it changes shape: to Open again, and back after a refusal.
- **Settings → Accounts.**
  - Each row names its service: Gmail, Outlook or IMAP/SMTP (`serviceLabel`).
  - A working Outlook account's Reconnect says "Connect with Microsoft". One that needs a sign-in says "Sign in again", on its row too.
  - The owner card says "Verified with Microsoft" for `microsoft_oauth`. Making an Outlook mailbox the Terno account asks for no password and says "Verify with Microsoft". The change hint names Google or Microsoft.
- **Remove dialog** (`account-remove-dialog.tsx`). Microsoft has no endpoint for an app to withdraw its own grant, so the dialog says so and links the two places a person can. Both links were checked on 2026-11-24:
  - **Personal account:** `https://account.live.com/consent/Manage`. `microsoft.com/consent` redirects there (301), and an unsigned request lands on the consumer sign-in.
  - **Work or school account:** `https://myapplications.microsoft.com/`. This is the address Microsoft's support article "Edit or revoke application permissions in the My Apps portal" links. `myapps.microsoft.com` also answers as My Apps, but the article names the other.
  - An administrator's approval for everyone can't be withdrawn there, so the dialog says to ask the administrator.
  - The renderer's `Account` has no tenant, and adding one would touch the store's projection, so both links are shown.
  - `ConfirmDialog` now gives Cancel the initial focus explicitly, since Base UI would otherwise focus the first link.
- **i18n** (en and es): `account.continueMicrosoft`, `account.imapMicrosoft`, `account.remove.descriptionMicrosoft`, `account.remove.microsoftPersonal` and `account.remove.microsoftWork`, plus:
  - `account.owner.verifiedMicrosoft`, `account.owner.verifiedMicrosoftOn` and `account.owner.verifyMicrosoft`
  - `signIn.microsoft`, and `signIn.browser.waiting` and `signIn.browser.again` (renamed from `signIn.google.*`)
  - `firstRun.account.descriptionWeb`
  - new wording for `account.owner.changeHint` and `settings.find.words.addAccount`
- **Tests.**
  - `outlook-account.test.tsx` covers:
    - Add account: the method, the chosen window, busy, both error places, the hint, the dropped presets, the domain list, and a late finish.
    - The sign-in panel, including focus.
    - The Settings row, the owner card and the remove dialog.
  - `add-account-web.test.tsx`: the web build offers no Microsoft.
  - `settings-search.test.ts`: the new search words.
  - `e2e/outlook-connect.spec.ts`, one test of five `scenario()`s against `SyntheticMicrosoft`:
    1. Add account offers Microsoft, and the Outlook.com hint shows (axe in light and dark).
    2. A refused consent is shown in the form.
    3. An approved sign-in adds the account, which Settings names Outlook.
    4. Microsoft stops honouring the token, the row asks, and Continue with Microsoft clears it with `login_hint`.
    5. The remove dialog (axe in light and dark), with Cancel focused.
  - `fixtures.ts` gains `backendOptions.microsoft`. It starts a synthetic Microsoft with the build's registration and adds `connectMicrosoft` from `createRegistry({ microsoft: { endpoints } })`. An Outlook account gets the demo provider, refused with `errors.microsoft.revoked` while its refresh token isn't one Microsoft still honours. The sync and send checks join this spec with stage 2's provider.
  - Visual baselines `add-account.png`, `first-run-account.png` and `first-run-account-dark.png` were regenerated.
- **UI rating.** Add account and Settings aren't screens `docs/ui-rating.md` rates, so `ui:rate` wasn't run.
- **Codex code review.** Round 1 found 10 issues, all fixed with a test that fails without the fix:
  1. A late sign-in closed a later Add account.
  2. The remove dialog didn't mention an administrator's approval.
  3. A hint-started sign-in showed its progress and failure out of view.
  4. Focus was lost when the panel's action changed shape.
  5. The domain pattern matched live.fm.
  6. Settings search didn't find Outlook.
  7. Nothing proved the web build has no Microsoft option.
  8. The dropped presets were untested.
  9. The chosen window was untested.
  10. A date in the test depended on the time zone.

  Round 2 found 6:
  1. Fix 1 guarded the form rather than the dialog. When the new account's event unmounted the first run before the answer arrived, the first run was never marked finished. The guard moved to the dialog host. Fixed.
  2. A failure from the hint vanished once the address was edited away. Fixed.
  3. Focus on Open again is lost if a second account needs a sign-in during the attempt: the panel moves from one account's layout to several and remounts the action. Left: this is the panel's structure from plan 184, Google's too, and rare.
  4. The web's search finds Add account for "Outlook", and the owner hint names Microsoft on the web. Left, because the web is out of scope for now (owner decision 4).
  5. Tests added for the owner change to an Outlook mailbox.
  6. Tests added for the dialog's administrator note.
- **Still open from stage 1.** Reconnect's `login_hint` is the mailbox address, not the id_token's `preferred_username`. Keeping the latter needs the backend and the stored config, outside this UI stage.

## Stage 2b as built

The write side of the Graph provider, the store's Outlook move semantics, and stage 1's open note. Outlook mail can be read, flagged, moved, filed and sent from the desktop app.

### What Microsoft's docs say, and what each choice rests on (checked 2026-11-24)

- **Flags** ([message-update](https://learn.microsoft.com/graph/api/message-update)): `isRead` and `flag` are updatable; "returns a `200 OK` response code and updated message object". Read and unread are `{ isRead }`; star and unstar are `{ flag: { flagStatus: "flagged" | "notFlagged" } }`.
- **Moves** ([message-move](https://learn.microsoft.com/graph/api/message-move)): `destinationId` is "The destination folder ID, or a well-known folder name"; success is "`201 Created` … and a message resource". Its id survives the move ([outlook-immutable-id](https://learn.microsoft.com/graph/outlook-immutable-id)). What a move into the folder a message is already in does isn't stated, so it's never sent: every location op reads where each message is first.
- **Batches** ([json-batching](https://learn.microsoft.com/graph/json-batching)): "up to 20 requests"; a "relative resource URL"; answers "might appear in a different order than the requests"; "A `200` status code on the batch … doesn't indicate that the individual requests inside the batch succeeded"; a request over the limits "fails with a status of `429`". A Retry-After inside a sub-response isn't promised, so one is read when present and the ledger's own pause applies otherwise. Headers are per request, so each carries `Prefer: IdType="ImmutableId"`.
- **Send** ([user-sendmail](https://learn.microsoft.com/graph/api/user-sendmail)): MIME "encoded in **base64** format in the request body", `Content-Type: text/plain`; "returns `202 Accepted` … doesn't return anything in the response body"; "saves the message in the **Sent Items** folder".
- **The write limit** ([use-the-api](https://learn.microsoft.com/graph/use-the-api)): "Write requests in the Microsoft Graph API have a size limit of 4 MB", "fail with the status code HTTP 413". This corrects the plan's "no per-request size for `sendMail` is documented": it's Graph's general limit, found by the Codex code review (#2). Terno takes the smaller reading, 4,000,000 bytes.
- **Pace and concurrency with batches** ([throttling-limits](https://learn.microsoft.com/graph/throttling-limits), "Outlook service limits for JSON batching"): per app and mailbox "10,000 API requests in a 10-minute period", "Four concurrent requests" and "150 megabytes (MB) upload (PATCH, POST, PUT) in a 5-minute period"; for a batch, "Microsoft Graph sends the Outlook service up to four individual requests from the batch at a time".
- **Draft from MIME** ([user-post-messages](https://learn.microsoft.com/graph/api/user-post-messages)): base64 MIME in a `text/plain` body (the headers it lists include BCC); "`201 Created` … and message object"; saved in Drafts.
- **Upload sessions** ([attachment-createuploadsession](https://learn.microsoft.com/graph/api/attachment-createuploadsession), [outlook-large-attachments](https://learn.microsoft.com/graph/outlook-large-attachments)): for a file "between 3 MB and 150 MB"; `AttachmentItem` with `attachmentType` `file`, a name and a size (`isInline` and `contentId` for an inline one); the URL is "in the `https://outlook.office.com` domain"; "Do not specify an `Authorization` request header"; each PUT carries `Content-Range: bytes {start}-{end}/{total}` and `application/octet-stream`, "in order", "each byte range less than 4 MB"; intermediate answers are 200, the last "`HTTP 201 Created`".
- **A draft's send** ([message-send](https://learn.microsoft.com/graph/api/message-send)): "`202 Accepted`", saved in Sent Items.
- **Folders** ([mailfolder-post-childfolders](https://learn.microsoft.com/graph/api/mailfolder-post-childfolders), [user-post-mailfolders](https://learn.microsoft.com/graph/api/user-post-mailfolders), [mailfolder-update](https://learn.microsoft.com/graph/api/mailfolder-update), [mailfolder-delete](https://learn.microsoft.com/graph/api/mailfolder-delete)): `displayName` is writable; create answers 201 with the folder, a rename 200, a delete "`204 No Content`". What a duplicate name returns, and where a deleted folder's mail goes, aren't stated: a name is checked against the list first, and what a delete took is read from the list after it.
- **Permanent delete** ([message-delete](https://learn.microsoft.com/graph/api/message-delete), [message-permanentdelete](https://learn.microsoft.com/graph/api/message-permanentdelete)): Terno has no op for it (no provider is asked to delete for good), so neither is used for mail. A draft the draft path leaves unsent is removed with `DELETE /me/messages/{id}` (204).
- **The sign-in name** ([id-token-claims-reference](https://learn.microsoft.com/entra/identity-platform/id-token-claims-reference), [v2-oauth2-auth-code-flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow)): `preferred_username` is "The primary username that represents the user", "mutable … can be used for username hints"; `login_hint` is to "pre-fill the username and email address field of the sign-in page".

### The provider (`packages/mail/src/graph-writes.ts`, over `graph-api.ts`'s transport)

- **The transport.** `attempt` takes a method, a body and the op's run (dispatch marked, so a pause met first gives the attempt back), and three modes:
  - `submission` (sendMail, a draft's send): a send's deadline, never cut by `reset()`, its run marking the submission. Once it may have left, a dropped connection, a timeout or a 5xx is `ambiguous` (plan 65: never sent again); a refusal before connecting waits for the network; a 429 is retryable.
  - `empty` (202, 204): the status is the answer.
  - `batch`: `RequestDescriptor.onBatch`. `requestHttp` hands the ticket to the reader instead of settling it on the 200. The reader settles it with the longest throttled sub-response's observation (`batchThrottle`), recorded as a top-level 429 is, and `account-requests.ts` constrains the mailbox for it as for a 429. Each request in it counts against the pace, and it takes as many of the four slots as Graph runs of it at once (`min(4, n)`, taken together so two never deadlock). This deviates from stage 2a's "a batch is one slot": Graph runs four of a batch at once, which beside a sync's own requests would pass Outlook's four (Codex code review #10).
  - `graph-shared.ts` holds what reads and writes share: the roles, the catalog (now with its raw tree), the request's shape and Graph's codes.
- **Flags**: PATCHes, 20 a batch. They're idempotent, so a retry sends them all again. A 404 with Graph's own code is done.
- **Location ops**: each message's `parentFolderId` is read first (a batch of GETs), then the op's rule says what moves:
  - archive: what's in the Inbox, to `archive` (a mailbox without one says so: `errors.outlook.noArchive`)
  - trash: all, to `deleteditems`
  - spam: all but Sent's, to `junkemail`
  - not spam: Junk's, to `inbox`
  - back to the Inbox: all but Sent's and Drafts', to `inbox`
  - a filing: all, to its folder
  - its undo (`leaveFolder`): what's still in the folder, back to the Inbox, the folder it came from, or Archive or Sent (`role`)

  What's already where it's going isn't moved, but its folder is written before the moves go. Each move's answer names the folder, written at once through `ProviderStore.placeMessages` (null for a role folder), before any sibling's failure is thrown. So a partial success keeps what was done, and a retry after a lost answer finds the move made and moves nothing. A move's 404 is the destination's (the message was read a moment before), never a message to forget.
- **Folders** (plan 107): create (at the top `POST /me/mailFolders`, under a folder `…/childFolders`), rename (`PATCH displayName`; keys kept, its subfolders' too, all in `renamed`) and delete (`DELETE`; `deleted` is what the list no longer has: the folder and everything under it). The name is checked against Graph's tree and Terno's list first. A failure that isn't Graph's refusal reads the list again, and a change found made is the answer (lost-response recovery). Graph's 4xx is `errors.folder.refused` with Graph's code. A delete whose list can't be read after it still reports what went, from the list before it (Codex code review #9).
- **Send**: `POST /me/sendMail` with nodemailer's MIME (Bcc kept, as Gmail's) in base64 (`graphMimeBody`), while that base64 fits the 4 MB write limit. A message clearly over it (its files alone) isn't built whole. Over it:
  1. a draft from the MIME without its files
  2. each file: one whose request fits (its base64 and 4 KiB of JSON) with its bytes (`POST /attachments`, a `fileAttachment`); a larger one through an upload session, in 3 MiB pieces, the URL only on `https://outlook.office.com` or Graph's own root (refused anywhere else before a byte leaves)
  3. `beforeSubmission`, then `POST /me/messages/{id}/send`

  A failure before the send (`beforeSubmission`'s included), or a send Graph refused outright (a throttle, a 4xx), deletes the draft and is retryable (Codex code review #5). The send is the boundary: an unknown outcome leaves the draft alone. While a draft is being built its id is in `staging`, and a sync stores none of it: the local row waits for the Sent copy whole (Codex code review #1). Nothing comes back with an id: the Sent Items delta brings the copy, and both stores' Message-ID promotion of a non-IMAP `local:` row adopts it.
  - A file of 2,996,926 bytes to 3 MB goes through an upload session, a few kilobytes under the page's "between 3 MB and 150 MB"; its own `POST` would be over the write limit. Whether sessions refuse that is the live test's to show.
- **The registry** gives the provider nodemailer's `buildRaw` (`registry.ts`), so the Graph modules stay free of Node APIs.

### The store

- `queueFolderMoves` has an Outlook branch in both engines, from `planOneFolderMove` (`@terno/store`):
  - A message's folder is its `message_folders` row with the pending folder ops replayed (`applyFolderOpOne`).
  - One op with every message that moves, `keepInbox: false`, and nothing after it: no archive op (Codex code review #3: a filing that failed archived the mail). Your own mail stays in Sent unless it's all there is or it's in the folder this leaves.
  - The owner's decision holds: no thread is kept in the Inbox by a shown category (`kept` is empty). What the move takes out of the Inbox leaves it here at once (`fromInbox`, kept in the op's payload), and a move that fails or ends unknown puts back in the Inbox those the server didn't confirm in the folder (`settleFolderOp`).
  - The journal: `fromInbox`, `fromFolder` (`from`), and `elsewhere` (another folder; Archive; or Sent for your own mail that's out of the Inbox and in no folder), each undone to exactly there (`LeaveFolderPayload.role` for Archive and Sent).
- `placeMessages` writes a confirmed folder only for an Outlook account, and only while the row's provider id is the one the answer was for. It recomputes the threads, and the backend tells the windows. `settleFolderOp` needs nothing more: the answers are already stored, so succeeding, failing or ending unknown drops the overlay and shows what's confirmed.
- A delta read racing a settlement: while the op is on its way the overlay shows the move. Once it settled, a stale read shows until the next delta (its `@removed` and the destination's entry) says where the message is.
- Outlook joins the promotion's flag binding in both engines (revision 8).

### Deviations

- **The Inbox flag of a filing on its way has no flag-protocol op.** IMAP and Gmail carry it with the archive op after the move, which protects it from a stale read. Outlook's filing is one op (as the plan says) with no flag fields, so a delta page that read a filed message's change in the Inbox just before the move landed can show it in the Inbox again while the move is on its way. When the move lands, what the server confirmed in the folder leaves the Inbox again (Codex round 2 #6).
- **The undo journal reads a role from flags.** An Outlook message in no folder and out of the Inbox is taken for Archive, or Sent when it's your own. Graph's Sent flag is sticky (stage 2a), so your own message moved to Archive by another app goes back to Sent Items on an undo. The store keeps no role folder for a message (stage 0b).
- **A draft left over.** A lost answer to the draft's creation leaves one draft in Drafts (it syncs as a draft the person can delete); the retry makes another.

### Stage 1's open note

The id_token's `preferred_username` is kept as `OutlookAccountConfig.microsoftUsername` and is reconnect's `login_hint` (else the address). It's a hint only, never identity.

### Tests

- `graph-writes.test.ts`:
  - flags, 20 a batch with the header on each request; a gone message; a local row
  - archive reading first; trash, spam, not spam and back to the Inbox; a filing and each undo group
  - a partial failure, then a retry moving only what's left; a lost batch answer; a deleted destination; no Archive; a move and a delta in both orders
  - a throttled sub-response reaching the ledger with its wait, the ticket held until read; `batchThrottle`
  - folder create, rename and delete, each with a lost answer, and Graph's refusal
  - sendMail (MIME, Bcc, `beforeSubmission` first, Sent Items); a lost, a timed-out and a 5xx send unknown, a 429 retryable
  - the draft path (pieces in order, no Authorization, the large file not in the MIME); interruption before (an upload: draft deleted, nothing sent) and after (the draft's send: unknown) the boundary; an upload URL off Microsoft refused
- Conformance in SQLite, SQLite-WASM and IndexedDB (`folder-move.ts`, `gmail-refresh.ts`): the filing and its journal with a shown category; `placeMessages` with partial success, unknown and failed outcomes, a role answer and a changed provider id; a delta racing a settlement; a replayed source; the promotion binding.
- `microsoft-connection.test.ts`: a folder made, a thread filed and undone, archived and read through the backend's ops; a throttled sub-response pausing the mailbox; the sign-in name as `login_hint`. `microsoft.test.ts`: `preferred_username` kept, a malformed one dropped. `registry.test.ts`: the registry's provider sends, Bcc kept.
- `forwarding-delivery.int.test.ts`: Outlook joins `DELIVERIES`.
- `e2e/outlook-connect.spec.ts`, over the real Graph provider: mail synced into the Inbox with its folder under it, a message dropped on the folder and back with `z`, read when opened, a reply through sendMail promoted from Sent Items, archived; then signing in again (`SyntheticMicrosoft.revoke`) and removal.
- The fixture (`test/microsoft.fixture.ts`) gained the writes: PATCH and DELETE of a message, its move, folders, `$batch` (answered out of order, with a throttled request, and a record of each request's header), sendMail, a draft from MIME, `POST /attachments`, upload sessions (Authorization counted, ranges checked in order), a draft's send, Graph's write limit (413), lost answers before or after the change, and gates on a send.

### What the Codex code review changed

Two rounds. Each fix came with a test that fails without it.

**Round 1 (12 findings):**

- Fixed:
  - #1: a Drafts sync stored a send's draft while its files were uploading, and the local row took its incomplete copy. A draft on its way (`staging`) is never stored.
  - #2: Graph documents a 4 MB limit for every write request (`use-the-api`), which a file under 3 MiB could pass once the MIME was base64. The send now measures its base64 and goes through a draft over it, each file with its bytes or through a session.
  - #3: a filing that failed was followed by its archive op, which archived the mail. Outlook's filing is one op; what it takes out of the Inbox is journalled in it and comes back if it never lands.
  - #5: a send Graph refused outright left its draft, and the retry made another. The draft goes on a definite refusal.
  - #8: a read's "already there" was lost when the move batch failed. It's written before the moves.
  - #9: a delete whose list couldn't be read after it reported nothing, so filters kept the folder. It reports what went.
  - #10: a batch took one slot and one unit of the pace while Graph runs four of it. It takes `min(4, n)` slots, together, and `n` units.
  - #11: signing in again never learned a changed sign-in name. It's stored, while the account's sync is stopped.
  - #12: a subtree walk was quadratic at the 10,000-folder cap. It uses a children index.
- Skipped:
  - #4: undoing an ordinary location action (Move to Inbox out of a folder) restores flags, so Graph's undo goes to Archive, not the folder. IMAP's undo has the same behaviour; an exact folder in the undo journal is a change to the shared undo for both providers.
  - #6: a move's answer delayed past another client's move and a delta read, then written over it. It needs a race across two apps and a delta in a few hundred milliseconds; the message's next change corrects it.
  - #7: an undo racing another client's move between Terno's read and its move. The documented folder-scoped move doesn't say it refuses a message not in that folder, so it can't be built on.

**Round 2 (9 findings, on the fixes):**

- Fixed:
  - #1: Graph's 201 to an attachment repeats its bytes, over the answer's bound. The status is the answer.
  - #2: the Sent copy keeps the draft's immutable id, and `staging` skipped it when Sent's delta saw it while the send was still answering. Only a draft outside Sent is skipped.
  - #3: a search hit or a read by id could still store a draft on its way. The check is in the download itself.
  - #5: one malformed read dropped its siblings' confirmations. It fails only its message.
  - #6: a stale Inbox read while the filing was on its way left the message in the Inbox and the folder after it landed. A landed filing takes out of the Inbox what the server confirmed in the folder.
  - #7: a failed filing brought a message back to the Inbox over a newer move on its way, or over a folder the server had confirmed. It brings back only what has neither.
  - #8: a file's request was estimated with a 4 KiB allowance, which sent files just under 3 MB to an upload session. The request is measured.
- Skipped:
  - #4: a throttled draft send's cleanup meets the pause the throttle just set, so the draft stays. Reusing it would need the draft's id kept with the op; the leftover is an ordinary draft the person can delete.
  - #9: a delete whose list fails after it reports, from the list before, a subfolder another client moved out meanwhile. This takes another app moving that subfolder in the same seconds.

### `pnpm test:all`

- Ran once, after round 1's fixes (round 2's landed while it ran; their files ran again after, below). Lint, typecheck, build, web, `ui-perf` and `startup` passed.
- Everything else that failed also fails on the base:
  - `unit`: the base's files (`store.conformance`'s failures are its Dated items tests, plan 204/210). `w02-canonical-actions.int.test` failed on the loaded first pass only and passes alone.
  - `db-wasm`: `tabs.test`.
  - e2e: the base's 17, run again alone (account-errors, provider-errors, first-sync, print-quality, scrollbars, settings-pass, today, what-matters-feed). `hand-to`, `ask-pin` and `settings` failed on the first pass only.
  - smoke: the base's 10.
  - perf: the base's five files.
- Run per change, after round 2: `graph-writes`, `graph-api`, `registry`, `microsoft`, `provider-http`, the conformance's Outlook and folder cases in SQLite, SQLite-WASM and IndexedDB, `gmail-refresh` in both engines, `microsoft-connection`, `forwarding-delivery`, `folder-actions`, `filter-folder.perf`, `graph-sync.perf`, and `outlook-connect.spec.ts` (repeated, two and three at once).

### What an Outlook user still can't do (desktop)

- Push: Graph's change notifications need a public webhook; mail comes by the poll and quick checks (plan 176).
- Outlook's categories, Focused Inbox as tabs, and flag due dates (out of scope for v1).
- Shared mailboxes and delegate access.
- Delete for good: Terno has no such action for any provider.
- ~~An exact undo of an ordinary location action out of a folder (Move to Inbox, then Undo, goes to Archive: round 1 #4, as IMAP's).~~ Built: "Exact undo of location actions (as built)" below. IMAP's stays as it was.
- The web build (stage 4).

## Exact undo of location actions (design)

### Request (verbatim)

> can we do the 'undo after move to inbox'?

Stage 2b's round 1 #4, skipped then: for an Outlook account, a message in one of the person's folders moved by an ordinary location action (Move to Inbox, and also Trash, Spam, Not spam) is not put back in that folder by Undo. AGENTS.md: "undo is exact".

### What exists

- **The journal.** `actOn` (backend `handlers.ts`) keeps each changed message's `MessageState` (`isRead`, `isStarred`, `inInbox`, `isTrash`, `isSpam`, Gmail's `category`) in the backend's in-memory `UndoJournal`, under the undo id. Undo (`undoActs`) hands it to `threads.restore`. The renderer never sees it, so a new field in it is no RPC change.
- **The restore.** `restoreMessages` (SQLite `db/actions.ts`, IndexedDB `idb/mail.ts`) writes the snapshot's flags and queues ThreadAction ops from `restoreLocationOps(now, was)`: `moveToInbox`, `archive`, `trash`, `spam`, at most two steps.
- **Graph's rules** (`graph-writes.ts` `ruleOf`): `archive` moves only the Inbox's messages to Archive; `moveToInbox` all but Sent's and Drafts'; `trash` all; `spam` all but Sent's; `moveToFolder` all, to its folder; `leaveFolder` what's still in the folder, back.
- **So, on Outlook, an undo lands:**
  - exactly, when the message was in the Inbox, Deleted Items or Junk (one or two ops, each exact on Graph);
  - exactly, for a received message that was in Archive (`archive` from the Inbox; from Deleted Items or Junk through the Inbox, two moves);
  - **in Archive, when it was in a user folder** (the flags of a message in a folder and of one in Archive are the same: out of the Inbox, Trash and Junk);
  - **in Archive, when it was your own message in Sent Items and was trashed**: `moveToInbox` takes it from Deleted Items to the Inbox, then `archive` to Archive. Trashing a conversation trashes your replies, so this one is common.
- **The filing's undo** is already exact (`fromInbox`, `fromFolder`, `elsewhere`, `LeaveFolderPayload.role`: "Stage 2b as built" → "The store").

### Design

1. **The snapshot knows the folder (`MessageState.folder?: string | null`).**
   - Written only by a location action (archive, trash, spam, not spam, back to the Inbox) on a one-folder (Outlook) account's message, as `category` is written only by a category action.
   - It's the message's user folder once its pending folder ops are replayed (`applyFolderOpOne`, as a filing reads it), when its flags say it's out of the Inbox, Trash and Junk. Otherwise it's null: a role folder, which its flags name.
   - Absent: another provider, or an action that doesn't move mail. Its undo behaves as today.
   - An undo of a flag action (read, star) never touches a folder.
2. **One rule for where a one-folder message goes back: `restoreOneFolderOps(now, was, isSent)` in `@terno/store`.** Both engines call it in place of `restoreLocationOps` when the snapshot has `folder`. `now` is the message as it is, its folder replayed the same way.
   - Where it is is where it was (flags, and the folder): nothing.
   - It was in a user folder: one `moveToFolder` `{ folder, from: null, keepInbox: false, fromInbox }`, with `fromInbox` being those this undo takes out of the Inbox here. That's the filing's own op, so these all come from the filing:
     - the overlay shows it in the folder at once;
     - Graph moves it from wherever it is (`moves: () => true`);
     - the answer's folder is written as it comes (`placeMessages`);
     - a failure brings back the Inbox part (round 2 #7).
   - It was out of the Inbox, Trash and Junk, in no folder: one new `returnTo` op, `{ role: "archive" | "sent" }`. Sent is for your own message, as the filing's journal reads it (the stage 2b deviation stands: your own message that another app put in Archive comes back to Sent Items).
   - Otherwise (the Inbox, Deleted Items, Junk, or the mixed Trash-and-Spam): `restoreLocationOps` as today. Each of its ops is exact on Graph for these.
3. **`returnTo`, a new op kind for one-folder accounts.**
   - Payload `ReturnToPayload { role: ReturnRole }`.
   - Group `location`, so it's ordered with the action's own op and never overtakes it.
   - Flag effects `{ inInbox: 0, isTrash: 0, isSpam: 0 }` in `flag-protocol` (and `operationFlagFields`), so a read on its way can't undo it. It joins `rearmFlagEffects`' location kinds.
   - Graph: `{ to: ROLES[role], moves: () => true }`. What's already there is only placed (`relocate`'s read first).
   - Backend: `OP_KINDS`, the diag `opKind` enum, and `OP_SUMMARY` → `backend.op.move` (no new copy).
   - IMAP, Gmail and the demo provider never get one; they refuse an unknown kind already.
   - `ops.kind` has no CHECK list, and the folder-move index (`ops_folder_moves`) isn't needed: a role has no folder row to overlay. **No migration.**
4. **A landed one-folder filing agrees with its folder.** Round 2 #6 takes out of the Inbox what the server confirmed in the folder, among the filing's `fromInbox`. This generalizes it to every message of the op the server confirmed there, with nothing newer on its way: out of the Inbox, Trash and Junk.
   - A message in a user folder is in none of them: Graph's sync gives a folder without a role no such flag (`graph-api.ts`).
   - So an undo out of Deleted Items or Junk can't be left in Trash by a flag snapshot read while it was on its way.
   - A failed one changes as today: `fromInbox` comes back. A trash or spam flag comes back with the action's own flag snapshot (its intent still asks for one).
5. **The engines.**
   - SQLite `db/actions.ts` and IndexedDB `idb/mail.ts`: `stateOf` gains the folder for a location action on a one-folder account.
   - `restoreMessages` reads `is_sent`, the account's kind and the replayed folder (one-folder accounts only), calls the rule, and returns ops that may carry a payload.
   - `restore` enqueues with the payload, and recomputes the threads after a folder op is queued, because membership reads the queued op.
   - The replay ("stored folder, then pending folder ops in order") moves out of `queueFolderMoves`' Outlook branch into one helper per engine, used by the filing, the snapshot and the restore.
6. **IMAP stays as it is.**
   - An IMAP message's place is a set of locations (mailbox, uidvalidity, uid), one of them possibly a copy kept in a folder. The Inbox may hold a copy beside the folder's. A move changes the UID, which identity holds, `dispatch` and `mappedMove` follow.
   - An exact IMAP undo would have to plan copies and moves back from a snapshot of locations, through that machinery. That's IMAP's own change, with its own risks, not this seam. One folder string can't say where an IMAP message was.
   - Gmail's labels are untouched by Move to Inbox (it adds INBOX), so Gmail's undo is already exact.

### Tests

- `@terno/store` unit (`restore-location.test.ts`): `restoreOneFolderOps` for each `was` (a user folder; the Inbox; Archive; Sent; Junk; Deleted Items) against each `now`, own and received. Nothing when nothing moved.
- Store conformance (`folder-move.ts`), in SQLite, SQLite-WASM and IndexedDB, on an Outlook account:
  - Move to Inbox, Trash, Spam and Not spam out of a user folder, each undone: one `moveToFolder` back with its `fromInbox`, and the thread in the folder at once.
  - From each role: the Inbox (archive, trash, spam undone), Archive (Move to Inbox and trash undone: `returnTo` archive), Sent (your own, trashed and undone: `returnTo` sent), Junk (Not spam undone), Deleted Items (Move to Inbox undone).
  - A read or star undo never queues a move.
  - The undo landing for part only: placed, the rest failing, and `fromInbox` back for what didn't land.
  - A message moved elsewhere meanwhile (a delta read put it in another folder) still goes back to the journalled folder.
  - A landed restore filing clears a Trash flag a stale read put back.
- `graph-writes.test.ts`: `returnTo` to Archive and to Sent Items from Deleted Items and the Inbox, already there, a partial success; the restore's `moveToFolder` from Deleted Items.
- e2e `outlook-connect.spec.ts`, in the existing scenario: a message in the folder moved back to the Inbox, then `z`, lands in the folder on Graph and shows there.

### Perf

- The act reads folders only for a location action's changed messages on an Outlook account (one probe for the account's kind). IMAP and Gmail pay an account-kind lookup per action slice, which they already pay in `applyToMessages` (plan 229).
- The restore reads the same, sliced as today (`runBudgeted`, at most 500 ids a query).
- The gates touched: `filter-folder.perf` (the filing's replay moved into a helper) and the store's actions perf.

### Out of scope

- IMAP's exact undo (above).
- A one-move undo into Junk or Deleted Items from the other: `restoreLocationOps` goes through the Inbox (two moves, exact in the end), as today.

### Revisions after the Codex review

The critique made 12 points.

**Taken:**

- **#1, in part: Drafts.** A synced Outlook draft has Archive's flags and no folder, so an undone trash would have taken it to Archive (today it goes through the Inbox to Archive). `returnTo`'s role is now `"archive" | "sent" | "drafts"`: a draft goes back to Drafts, your own message to Sent Items, anything else to Archive.
  - Storing Graph's actual role per message is not taken. The store keeps no role (stage 0b), and that would be a schema change. The stage 2b deviation stands: your own message that another app put in Archive comes back to Sent Items.
- **#3: replay every location op on its way, not only folder ops.** Take a message in F with Move to Inbox and Archive still queued. Its flags say Archive, but its stored folder still says F. A trash then would journal F.
  - The replay (`applyLocationOpOne`) follows Graph's rules: `trash`, `spam`, `moveToInbox` and `returnTo` leave no user folder; `archive` and `notSpam` move nothing that's in a user folder; the folder ops as before.
  - The filing reads the same replay. A message with Move to Inbox on its way, then filed, is journalled as from the Inbox.
  - It reads `op_targets` by message (`op_targets_msg`), only for an Outlook account's messages.
- **#5 and #6: settling a restore's (or any Outlook) filing.**
  - Landed: what the server confirmed in the folder, among all its targets, is out of the Inbox, Trash and Junk.
  - Failed or unknown: `fromInbox` as before. Every target also gets a flag snapshot asked for, behind a new barrier, so the next pass reads where it really is. The action's own snapshot may already have been read, leaving nothing to correct a Trash flag this undo cleared.
  - The guard against newer work now counts only location ops: a queued read or star no longer blocks the repair. It still counts a queued location op of any kind.
- **#8: `LocalFlagField` leaves out `folder`.** It derived from `keyof MessageState`.
- **#9, #10: wiring.** `returnTo` is in both engines' `GROUP` tables (`location`), `OP_KINDS`, the diag `opKind` enum and `OP_SUMMARY`. A test shows that IMAP and Gmail restores never queue one. The demo provider accepts any kind, but only an Outlook snapshot can produce one.
- **#11: batching and the early exit.**
  - Ops are grouped by destination: account, kind and folder or role.
  - A message whose flags match but whose place differs is restored.
  - Membership is recomputed after the ops are queued, in the same transaction, in both engines.
- **#12: tests.**
  - Undo before the action's op runs, and while it's running.
  - Another app's move, to a role and to a user folder.
  - Partial success, then a terminal failure.
  - `returnTo` queued before the account's flag clock exists.
  - Not spam out of a user folder isn't reachable (a message in a user folder isn't spam), so it's tested from Junk only.
  - A 50k Outlook restore with a populated queue joins `store.perf`.

**Not taken:**

- **#2: an exact op for the Inbox, Junk and Deleted Items too.** Their ThreadAction ops carry the flag effects that protect the undo while it's on its way, and each is exact on Graph unless another app moves the message into Sent Items or Drafts between the action and its undo. Trash and Spam together (a trash of a message in Junk) goes back through the Inbox, exact in the end.
- **#4: a flag-only undo restoring location flags.** That's today's behaviour for every provider: a snapshot without `folder` takes the old path. The filing's undo is unchanged: its restore's snapshot is the Inbox, which `moveToInbox` serves as before.
- **#8, retry: a parked `returnTo` retried over a later filing.** Every parked location op (an unknown archive or trash) has this with a later effect-free filing. It needs an explicit retry of an unknown op in the outbox. It isn't new here.
- **#7** agreed that the settle change stays Outlook-only (it does), and that keeping IMAP out is justified.

## Exact undo of location actions (as built)

The design and its revisions, with what the code review changed (below).

### Where Undo now puts an Outlook message

| It was in | Undo of | Queued |
|---|---|---|
| a folder of the person's own | Move to Inbox, Trash, Spam | one `moveToFolder` back to it (`fromInbox` when it takes it out of the Inbox here) |
| Archive | Move to Inbox, Trash, Spam | `returnTo` `archive` |
| Sent Items (your own) | Trash | `returnTo` `sent` |
| Drafts (a draft) | Trash | `returnTo` `drafts` |
| the Inbox | Archive, Trash, Spam | `moveToInbox` |
| Junk | Not spam, Move to Inbox, Trash | `spam` (from Deleted Items: `moveToInbox`, then `spam`) |
| Deleted Items | Move to Inbox, Spam | `trash` (from Junk: `moveToInbox`, then `trash`) |

- An undo of read, unread, star or unstar never moves anything.
- An IMAP or Gmail undo is unchanged: its snapshot has no `folder`.

### The store (`@terno/store`)

- **`MessageState.folder`.** It's written by a location action (`isLocationAction`) on an Outlook message only: the folder once every location op on its way is replayed. `LocalFlagField` leaves it out.
- **`restoreOneFolderOps(now, was, { isSent, isDraft })`.** The place is the replayed user folder, which wins over a flag (code review #2), else the role the flags name (`samePlace`).
  - Back to a folder: `moveToFolder`.
  - Back to Archive, Sent Items or Drafts: `returnTo`.
  - Otherwise: `restoreLocationOps`, from a folder as from Archive.
  - `oneFolderFlags` restores a folder's message with no Inbox, Trash or Junk flag, whatever a stale read had saved (round 2 #4).
- **`applyLocationOpOne`** replays any location op as Graph moves it:
  - trash, spam, back to the Inbox and `returnTo` leave no user folder;
  - archive and not spam leave it as it is;
  - a `leaveFolder` moves only what's still in its folder (code review #4).
- **`returnTo`** (`RETURN_TO`, `ReturnToPayload { role: "archive" | "sent" | "drafts" }`).
  - It's in the `location` group in both engines.
  - Its flag effects are `{ inInbox: 0, isTrash: 0, isSpam: 0 }`, and it's among `rearmFlagEffects`' location kinds.
  - `OP_KINDS`, the diag `opKind` enum and `OP_SUMMARY` (`backend.op.move`) know it.
- **`requestFlagSnapshots`** asks for the next flag snapshot of messages whose place is unknown, behind a new barrier.
- **`filedArchive`**: a filing's own Inbox part keeps flags only (its undo is the filing's journal).

### The engines (SQLite `db`, IndexedDB `idb`)

- **The replay.** `oneFolderFolders` replays the stored folder and every queued or running location op, by `op_targets_msg` in SQLite, and reads each op's payload once (code review #9, round 2 #7). The filing, the snapshot and the restore read it.
- **The restore.**
  - It groups ops by destination (account, kind, folder or role).
  - It restores a message whose flags match but whose place differs.
  - It passes each payload through, and recomputes membership after queueing a folder op.
- **An Outlook trash and spam are exclusive** (code review #1): a trash takes a message out of Junk and a spam out of Deleted Items, as Graph has it in one place.
- **Membership.** An Outlook message with its Inbox flag is in no folder of its own, so Move to Inbox out of a folder leaves it at once (code review #8). The pending-move overlay reads each op's payload once.
- **`settleFolderOp` for an Outlook filing**, an undo's included:
  - However it ended, what the server confirmed in the folder is out of the Inbox, Trash and Junk (code review #6). Before, only a landed filing's `fromInbox` left the Inbox.
  - Failed or unknown: `fromInbox` comes back as before, and a flag snapshot is asked for every target.
  - The guard against newer work counts location ops only.

### The provider and the backend

- **Graph's `returnTo`** moves each message to Archive, Sent Items or Drafts from wherever it is. One already there is only placed. A role it doesn't know is refused for good.
- **The backend** wakes a flag read when an Outlook `moveToFolder` fails or ends unknown (code review #7; round 2 #6: IMAP's and Gmail's don't).

### Tests

- `restore-location.test.ts`: every place to every place, own mail, drafts, the folder winning over a flag, and the replay (a leave skipped where Graph would skip it).
- Conformance in SQLite, SQLite-WASM and IndexedDB (`folder-move.ts`, "exact undo of a location action"). Seven cases:
  1. Each action out of a folder, undone, shown back at once; a stale Trash read ended by the landing.
  2. Every role, and a read's undo never moving.
  3. Undo before the action ran (one filing back per folder, in order), and IMAP unchanged.
  4. Move to Inbox then Archive still queued, then Trash undone to Archive; another app's move followed back.
  5. The review's cases: Move to Inbox leaving the folder at once; a trashed Junk message; a stale Inbox read under a filing on its way, restored without the stale flag; a partial landing cleared.
  6. A `returnTo` queued before the flag clock, owning its flags once it starts.
  7. A partial landing with snapshots asked for.
- `graph-writes.test.ts`: `returnTo` to each role from Deleted Items, the Inbox and in place; a filing back from Deleted Items; an unknown role refused.
- `microsoft-connection.test.ts`, through the backend and Graph: Move to Inbox out of a folder and Undo; then a trash whose undo fails (its folder deleted), waking a read that puts the Trash flag back.
- `outlook-connect.spec.ts`: filed through Move to, Move to Inbox, `z`: back in the folder on Graph and in the window.
- `store.perf`: Move to Inbox of 50 and of 500 Outlook conversations out of a 25,000-message folder, and their undo, with the queue growing each pair (p95 about 26 ms of 40 and 160 ms of 300).

### What the Codex code review changed

Two rounds. Each fix came with a test that fails without it (checked by undoing the fix for #1, #7, #8, the snapshot request and `returnTo`'s effects).

**Round 1 (9 findings):**

- Fixed:
  - #1: a trashed Junk message kept its Spam flag, so an undo after it went to Junk.
  - #2: a stale Inbox read under a filing on its way lost the folder from the snapshot.
  - #4: the replay put a filing's undo where Graph would skip it.
  - #6: a partial landing's confirmed messages kept a stale flag.
  - #7: a failed filing's read waited for the next poll.
  - #8: Move to Inbox out of a folder left the message there until Graph answered.
  - #9: payloads were copied and parsed once a target.
- Skipped:
  - #3: a delayed read writing a stale folder after a move landed. This is stage 2b's round 1 #6 class, and the next delta corrects it.
  - #5: your own message Terno archived, trashed and undone goes back to Sent Items. The store keeps no role (a schema change); stage 2b's deviation.

**Round 2 (7 findings, on the fixes):**

- Fixed:
  - #4: the restore wrote a saved stale Inbox flag beside the winning folder.
  - #6: IMAP's and Gmail's failed filings woke a sync, and the test only spied. The test now shows the read repairing the flag.
  - #7: SQLite returned a filing's payload once a target; the gate also files back 500 conversations.
- Skipped, each a race of two actions or another app within one op's flight, and each older than this change:
  - #1: a Junk read started before a trash can put the Spam flag back while the trash is on its way.
  - #2: a filing's undo after another app moved the message on still queues `moveToInbox` (stage 2b's round 1 #7).
  - #3: Move to Inbox under a stale Inbox read while a filing is on its way selects nothing (stage 2b's deviation).
  - #5: a filing queued and then Move to Inbox queued shows the folder until the first lands. The overlay replays folder ops only, by its partial index.

### `pnpm test:all`

- Ran once, after round 2. Lint, typecheck, build, web, `ui-perf` and `startup` passed.
- Everything else that failed also fails on the base:
  - `unit`: the base's 36 files (`store.conformance`'s two are its Dated items tests).
  - `db-wasm`: `tabs.test`.
  - e2e: the base's 16, run again alone; `today.spec` failed on the first pass only. `outlook-connect.spec.ts` passed.
  - smoke: the base's 10.
  - perf: the base's files, plus two that passed alone right after:
    - `visible-mail-text.perf`: 15.2 ms against 15.
    - `store.perf`'s Outlook recompute: 139 ms on the loaded first pass, 58 ms of 100 alone.
- Run per change: the touched unit files, the conformance in SQLite, SQLite-WASM and IndexedDB, `microsoft-connection`, `graph-writes`, `store.perf`'s Outlook case, `filter-folder.perf`, `idb.perf`, and `outlook-connect.spec.ts` (three times in a row).

### Still not exact

- IMAP's undo of Move to Inbox out of a folder goes to Archive (above).
- Your own Outlook message that was in Archive comes back to Sent Items (no stored role).

## Review round 3: the whole branch (Fable and GPT Astra)

The owner asked for one more round over everything (`git diff main...HEAD`), by two reviewers who never saw each other's findings: Fable (9 findings) and GPT Astra (11). Each finding was checked against the code. Every fix has a test that fails without it.

### Fixed

**The store and its engines**

- **The undo of a read or star puts back that flag alone** (Astra #1). The snapshot keeps the whole state, so undoing a star after another app moved the message to Deleted Items brought it back to the Inbox. It did the same for every provider, and the plan's earlier "not taken" #4 had kept that.
  - A read or star action's snapshot now says `only: "read" | "star"` (`flagScope`).
  - The restore puts back that flag over the message as it is now (`undoTarget`, both engines).
  - Conformance: star, then another app trashes it and it's read, then undo. One `unstar`, still in Deleted Items, still read.
- **Your own message in the Inbox goes with its filed conversation** (Fable #2). A note to yourself, or a copy you were sent, has `is_sent` and stayed in the Inbox, so the conversation showed in the Inbox and in the folder. `planOneFolderMove` now keeps your own mail in Sent only when it isn't in the Inbox.
- **The owner's provider and verification are checked as written** (Fable #9). v81 took their CHECK lists away; `checkOwnerClaim` runs in both engines' claim and change (plan 267's rule).
- **v81's key check covers only the rebuilt tables** (Fable #4).
  - It checked the whole file: 0.9 to 1.5 s cold at 57k conversations, and an old orphan anywhere would stop every launch.
  - `rebuildsReferenced` now names the tables (`accounts`, `owner`); each gets `PRAGMA foreign_key_check(table)`. What references them keeps its parents: every row is copied with its id.
  - `runMigration` is the step as an upgrade runs it, and `migrations.perf` times that function.
- **IndexedDB's attachment backlog stops at its page** (Astra #10). It looked up two repair keys for every pending message before taking 50.

**The Graph provider**

- **A batch refusing one message no longer abandons the next batches** (Astra #4). A chunk's failure to try again still stops the op (the retry repeats it all). A refusal is thrown once every chunk has gone, for both PATCH and moves.
- **A 401 inside a batch drops the token** (Astra #5), as one on the batch itself does.
- **A throttled draft send leaves no second draft** (Astra #3).
  - Under the real request policy, the 429 pauses the service before the handler sees it, so its DELETE was refused and the draft forgotten.
  - The draft is now kept out of the sync and deleted before the next send's draft. This also applies to a send that never connected.
- **An attachment clearly over the write limit isn't base64-encoded to measure it** (Astra #11).
- **A draft another app edits or sends is read again whole** (Astra #2).
  - Learn's immutable-id page says the Sent copy keeps the draft's id, so a delta saw only flags change and kept the old text.
  - A delta round after the first (never a first round or a listing) re-reads a stored draft: the row goes and the message is downloaded quietly.
  - `observe` does the same for a draft now in Sent. `messageByProviderId` says `isDraft` in both engines.
- **A repair whose message is where Terno doesn't sync is retired** (Astra #6) instead of being read again every pass.
- **A folder list read for a folder change isn't fresh** (Astra #7). The next pass reads the list and hands it to the host, so a failed host write can't hide a folder for 15 minutes.
- **A search by dates alone asks Graph** (Astra #8). $search documents no range for `received`, so it's a `$filter` on `receivedDateTime`, newest first.
- **A quiet pass saves its cursor once** (Astra #9). An empty round's new link is kept in memory and saved once after the folder sweep, not once a folder. A pass cut short reads the older link again.
- **Folders inside Deleted Items or Junk Email are neither listed nor synced** (Fable #1). Their mail was live mail with no Trash or Spam flag (plan "spam triggers nothing").
  - A folder Outlook deletes into Deleted Items goes from the sidebar, and its mail from Terno.
  - Terno's Delete folder counts a folder that's no longer listed as gone, whether Graph keeps it in Deleted Items or not. Learn's page doesn't say which it does.
- **A folder that stops being synced is read again by its own messages** (Fable #3), not the whole account.
  - New `ProviderStore.folderMessagePage(folder, after)` reads `message_folders`' `(account_id, folder, message_id)` index; IndexedDB uses `account_folder`.
  - The cursor's `left` keeps the folders and the place.
  - A role folder going, an expired link and a widened window still read everything.
- **One folder Graph refuses no longer stops the pass** (Fable #5). A 4xx that isn't the mailbox's or a throttle is that folder's. The rest sync, and the pass then throws it.

**The backend**

- **A Microsoft sign-in goes through the request ledger** (Fable #8), as Google's does.
  - `initialOAuthRequests(kind)` generalizes `initialGoogleRequests` over `OAUTH_SERVICES`.
  - A throttled code exchange pauses `microsoft-token`, and the next sign-in waits without opening the browser.
  - New copy: `errors.microsoft.capacity` (en, es).

### Not changed, and why

- **Fable #6: an Outlook account whose primary address changes can't sign in again.**
  - The account's address is its identity everywhere: the mailbox binding's digest (plan 264's ledger), the owner, the own-address test, and the sender.
  - Following a rename means changing the address of a live account. That's a design of its own, not a fix, and needs the owner's call.
  - Today the person removes and adds the account.
- **Fable #7: `userPrincipalName` taken as the address when `/me` has no `mail`.**
  - Microsoft documents no other source for a personal account's mailbox address. Guessing from mail in Sent would build on undocumented behaviour.
  - A mailbox Graph doesn't open is still refused (`errors.microsoft.noMailbox`).
- **Plan note: CI's client id is a secret, not a variable.** The text now says so (stage 1's setup note already did).

### `pnpm test:all`

- Lint, build, typecheck, web and startup passed.
- `architecture.test` caught the sign-in's `net.fetch(...)` as Electron's: the variable is `reach` now.
- Everything else that failed is the base's list, run again alone:
  - unit: its 36 files;
  - db-wasm: `tabs.test`;
  - e2e: its 16;
  - smoke: its 10;
  - perf: three of its files.
- `migrations.perf` times v81 through `runMigration`: 7 ms.
- ui-perf: `autocomplete-perf`'s 200 chips dropped 1 or 2 frames. It drops the same on the commit before this round (`512f84cb0`), run twice; nothing here touches the composer.

## Review round 4: what would fail (GPT Astra 6.2 and Fable 5.2)

The owner asked for a round on failures only: mail not received or sent, misdelivery, wrong tagging, crashes, sign-in. Both reviewers got one brief that pooled round 3's knowledge (Graph's quirks the code leans on, the store model, sending, receiving, OAuth). GPT Astra found 9; Fable found 5, two of them in round 4's own first fixes. Every fix has a test that fails without it.

### Fixed

**Sending**

- **A draft the person sends from Outlook during a pause is the send** (Astra #1).
  - The cleanup's DELETE used to delete it in Sent Items (same immutable id), and the retry sent it again.
  - `removeDraft` now reads `isDraft` first. One no longer a draft is `sent`: never deleted, and its op is done.
- **A restart no longer leaves a send's draft behind** (Astra #4).
  - Each send's draft carries its op's id in a single-value extended property of Terno's own (`SEND_MARK`).
  - Before a retry makes a draft, it finds the op's drafts by that mark (documented `$filter=singleValueExtendedProperties/Any(...)`): one still a draft goes, one sent ends the op, and one it can't delete yet fails the attempt rather than make two.
- **A draft on the server is never an outgoing message's Sent copy** (Astra #4). `findIngestMessage` (both engines) adopts a `local:` row by Message-ID only for a message that isn't a draft.
- **A send's other steps have a send's time** (Fable #3). The draft, its files and its mark can carry 4 MB each, and had a read's 60 s.

**Receiving**

- **A folder Graph won't list the children of no longer stops the folder list, and with it every pass** (Astra #2).
- **A refused folder no longer fails the pass** (Astra #5).
  - Round 3 threw its error at the pass's end. Notifications are turned on only after a pass that ends well, so they never came, and a refused first round held back older mail.
  - The folder is skipped for that pass and asked again the next.
  - A folder refusal is now only a 4xx on the folder's own requests (`/mailFolders/`). Round 4's first cut also took one message's download error for its folder's (Fable #1).
- **A message whose content Graph refuses is a repair** (Fable #1).
  - A 4xx on its own `$value` (not 404, a throttle or the mailbox's) blocks it with the new reason `server-refused`, so its folder (the Inbox too) goes on.
  - Settings → Mail recovery says "Your mail server won't send this message's content." (en, es). Retry asks again.
- **A saved delta link Graph calls a 400 starts its folder again** (Fable #2), as an expired one does. A 403 is the folder's refusal.
- **Mail that arrived while a delta link expired is still announced** (Astra #8). The new round's `startedAt` is the last finished round's start.
- **A Microsoft token past 4 KiB is accepted** (Fable #4), up to 16 KiB, the id_token's bound: at sign-in, on refresh, and in the backend's check. A work account's JWT grows with its claims, and Microsoft names no maximum.

**Wrong place, wrong state**

- **Move to Inbox moves what the store marked** (Astra #6). A sent-only conversation brought back stayed in Sent Items on Graph while Terno showed it in the Inbox.
- **A batch's failure to try again wins over a refusal in the same chunk** (Astra #7), so the op is retried for the other messages rather than failed for good.
- **A draft that only moved keeps its row** (Astra #3). Round 3's refresh replaced a trashed draft's row, so Undo, and actions already queued for it, named a message that was gone. Only a draft edited in Drafts, or one no longer a draft, is read again whole.
- **Two copies of one message are one conversation** (found checking Fable #5 against the live test's profile).
  - Mail to yourself is two items on Graph: Sent's copy and the received one, with one Message-ID. The live test's profile showed them as two conversations.
  - Threading (both engines) now joins a message to one with its own Message-ID.

**Signing in**

- **Signing in again goes through the request ledger** (Astra #9), as a new sign-in does since round 3.

### Checked, not changed

- **Fable #5: the Sent copy keeps the MIME's Message-ID.** The live test's profile shows it does for `sendMail`: the outgoing row took the server's id, and nothing was left `local:`. The draft path's `/send` wasn't in the live test; Learn's immutable-id page describes that send by the draft's id.
- **What a refused folder looks like.** It's skipped quietly, with no message in Settings: there's no warning channel short of an error, and an error stops notifications. A later change could list it as unselectable.

### `pnpm test:all`

- Lint, build, typecheck, web, ui-perf (run again alone) and startup passed.
- `gmail-refresh.test` still refused a 4,097-character token; it now tests the shared 16 KiB bound.
- `perf.perf`'s quick-filters gate failed in both loaded runs and passed alone (33 of 33); nothing in this round touches it.
- Everything else that failed is the base's list: unit's 36 files, db-wasm's `tabs.test`, e2e's 16, smoke's 10, and perf's other four files.


## Show original for Outlook (plan 272)

Plan 272's Show original landed on main while this plan was on its branch, with Outlook left for when it came. The owner asked for it once both were on main.

- **The read:** `readOriginal` in `graph-api.ts` is `GET /me/messages/{id}/$value` (learn.microsoft.com/graph/outlook-get-mime-message). That's the request a sync downloads a message with, here in the reader's lane, on the click.
- **How it's read:** a new call mode, `original`, keeps the answer as its bytes:
  - bounded as incoming mail is (`MAX_INCOMING_MIME_BYTES`; one over is "too large", never a malformed answer);
  - the large-read permit past the first 256 KB;
  - nothing parsed. The backend's `Originals` describes it as it does Gmail's and IMAP's.
- **Permits and results:** the read permit is held only while it reads. A 404 on that path is `null`, which Show original calls gone. Nothing is stored.
- **Nothing else changed:** the menu, the view, the backend and the unavailable reasons (signed out, only on this computer, gone) are plan 272's own. The menu already offers Show original for every account.
- **Tests:**
  - `graph-api.test`: the bytes are the source Graph holds, from `$value`; the reader lane's permit is taken and given back; a message gone is `null`; nothing is stored.
  - `microsoft-connection.test`: through the backend's `reader.original`, an Outlook message's summary and source come from Graph; a message deleted on Graph answers `gone`.
- **What the Codex code review changed** (5 findings, all fixed, each with a test that fails without it):
  - #1: a read waiting on a mailbox proof another request started now stops waiting when it's cancelled (`untilAborted`), so a closed Show original gives its read permit back at once. The proof goes on for the rest. This is in `attempt`, for every Graph request.
  - #2: only the message's own size, one byte over the cap, says "too large". Another of the reader's bounds (one piece of the answer over 1 MiB) is an unreadable answer.
  - #3: `truncated` cancels the rest of an answer cut at its bound before its reader sees the end, and lets the source reader go. The Graph slot freed at the end is then really free (shared with sync's downloads).
  - #4: the source is copied four incoming chunks at a time, with the backend's turn given between them. Up to 75 MB never holds the event loop in one slice, and a closed view stops the copy.
  - #5: a 200 without a body, or an empty one, is an unreadable answer: never "offline", never a zero-byte original.
