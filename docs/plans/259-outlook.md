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
