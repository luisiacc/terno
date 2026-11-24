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
   - `build.mjs` defines it, `backend-entry.ts` passes it into `oauthClients.microsoft`, and CI passes it as a variable.

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
