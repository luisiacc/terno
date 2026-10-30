# Plan 28: bounded, validated Google sign-in

Status: focused implementation complete; parent integration and independent code review pending. Scope: T08, A01/A02/B03 and X05's initial-profile case from the provider reliability report. Builds on plans 04, 05 and 25. Outlook is explicitly deferred until integration.

## Request (verbatim)

> Implement focused Google-only T08 initial OAuth/token-profile deadlines and response/scope/identity validation, on current main /Users/Luis/projects/emailclient, no branch/worktree.
> Bound complete token/profile/userinfo bodies and waitswithabort/deadline and cleanup, notonly callbackwaiting. Reject invalid/non-OKmailboxidentity beforeaccount/secret persistence, reducedexplicitmailgrantactionable but don't inventgraphscope. Browser tokeninspection boundedcancellable and validateid too.

The complete task also requires failing public-seam tests before fixes, a read-only Codex plan critique, atomic owned-file commits, no real profiles or credentials, preservation of PKCE/state/random loopback and newer-flow ownership. Final independent code review and integration gates belong to the parent.

## What exists

Desktop connectGmail bounds only callback waiting; token/profile/userinfo have no cancellation/deadline or body-size limit. Profile status and parsed shapes are trusted; scope omission becomes an empty grant. Browser broker inspection checks profile status but trusts fields and silently ignores userinfo failures. Backend RPCs trust registry results, token lifetime and browser reconnect account IDs. Plan 25 already binds reconnect to a mailbox and keeps desktop flow ownership until credential writes; preserve those checks.

## Design

- One desktop deadline (default five minutes) covers callback and all subsequent requests and complete bodies. Browser inspection defaults to 30 seconds and accepts caller cancellation. Every request gets the flow signal; race pending work against cancellation even if a supplied fetch ignores abort. Clear timers/listeners on every exit, close the loopback listener and active callback sockets; no browser opening for a pre-aborted flow.
- Bound each JSON response to 64 KiB while streaming, cancel the reader on overflow/abort and never parse raw provider errors into user-visible messages. Validate object shapes before field access. Reject non-OK responses before persistence, preserving retryability for 429/5xx and transport failures without deleting credentials.
- Require nonempty access and refresh tokens and Bearer token_type on desktop; validate finite positive expires_in when supplied. Explicit scope must be a string and include gmail.modify (or the broader mail.google.com grant). Omitted scope means the originally requested scope, per RFC 6749 sections 3.3 and 5.1; do not reject standards-compliant omission. Additional optional photo grants remain reported for plan 22.
- Gmail profile must contain a plausible mailbox address. Userinfo must succeed with a nonempty bounded subject; optional name/email_verified must have correct types, and an email when supplied must match Gmail profile case-insensitively. A login hint is not proof; reconnect mailbox checks remain before writes.
- Backend validates registry identity and refresh credential before encryption/account creation, explicit mail grants, browser access token and finite positive lifetime, and positive safe-integer reconnect account ID. Browser inspection receives backend abort. Do not change refresh rotation, refresh classification, stores or shared models.
- New actionable, privacy-safe errors.google.* strings ship in English and Spanish together. No new UI surface or logs.

## Authorized seams and tests

Public connectGmail using the actual random loopback listener plus synthetic fetch responses; public browser broker inspect/inspectGmailToken with synthetic streaming fetch; backend accounts.connectGmail/connectGmailToken/reconnect RPCs using a temporary profile and scripted registry. Test each behavior red then green. Cover omitted/reduced scopes, invalid token/identity/status/shape, malformed/oversized JSON, stalled headers and bodies at each stage, pre/in-flight abort, denied/missing/forged callback, PKCE and socket cleanup. Backend refusal must preserve accounts, owner and encrypted credentials, and wrong-mailbox reconnect must leave its intended account unchanged. No live providers or real profiles.

## Performance, privacy and out of scope

Cold sign-in paths only: one bounded timer per opened flow, no polling, retries or persistent background work; 64 KiB response cap bounds parse cost and memory. Gmail REST sync/mutations, Reply-To, all Outlook work, refresh token rotation/CAS X02, send-as aliases and store changes are out of scope. Parent runs the full integration/performance/package gates and independent Codex review; this slice runs targeted tests, type checks and lint and reports limitations honestly.

## Sources

- [RFC 6749 sections 3.3 and 5.1](https://www.rfc-editor.org/rfc/rfc6749#section-5.1): scope may be omitted when unchanged from the request; token_type is required and expires_in recommended.
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app#exchange-authorization-code): PKCE, Bearer tokens and granular consent checks.
- [Gmail getProfile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile): successful response contains emailAddress; me selects the authenticated mailbox.
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect#obtainuserinfo): userinfo subject is stable identity evidence; profile and email claims may be optional.

## Revisions after the Codex review

Read-only Codex CLI critique completed (12 concrete points, /tmp/terno-plan28-critique.txt). Taken:

1. Parent will extend GmailTokenBroker.inspect with optional signal/timeoutMs; this slice threads backend abort. No persistence/domain interface changes.
2. Snapshot the scopes actually sent; only absent scope falls back, not null/empty/non-string. Test custom grants and case-insensitive Bearer.
3. Browser scope evidence stays in the existing GIS renderer consent check; do not infer gmail.modify from successful profile inspection.
4. Absolute deadline starts before callback page setup, spans callback/headers/bodies, and has cumulative-delay coverage.
5. Cancel late response bodies and active readers; never await cleanup indefinitely. Exercise ignored abort, streamed overflow and late rejection.
6. Explicit one-shot callback settlement; require a code and use fixed localized errors, preserving forged-state waiting and PKCE.
7. Mailbox strings are at most 254 characters, have local@dotted-domain form and exclude whitespace/control/address delimiters; compare case-insensitively. Subjects are nonblank, at most 255 characters, without whitespace/control characters. Missing optional userinfo claims are allowed; incorrectly typed values fail; verified false stays false.
8. Validate desktop add, reconnect and Google owner re-verification before credential/owner persistence, including scripted registry results.
9. Check HTTP status first and cancel non-OK bodies; malformed error bodies cannot turn a 429/5xx into a permanent identity failure. No revocation on generic 403.
10. Preserve superseded desktop ownership and add backend shutdown checks after provider/encryption awaits before persistence.
11. Derive browser expiration from receipt time, preserve existing RPC 60–86,400 second limits and reject expired inspection results before installation.
12. Parent must add token_type: Bearer to FakeGoogle's authorization-code success fixture. Public-seam assertions cover unchanged owner/accounts/credentials, closed listener and no installation/encryption after refusal.


## Implementation and verification: mail flow

Implemented an absolute desktop deadline from entry, including callback-page setup and complete token/profile/userinfo requests; a 30-second browser inspection deadline; external abort propagation; streamed 64 KiB JSON caps; status-first failures; late-response/body cancellation and reader release; listener/socket teardown; and fixed privacy-safe errors. Token responses require Bearer and valid token/lifetime/scope shapes. Effective scopes preserve the authorization-request snapshot only when scope is absent. Gmail identity uses core.isValidEmail plus length/control checks and requires a valid stable subject; optional claims remain optional with strict types and matching email when supplied. Refresh classification/provider code is unchanged.

Public-seam red/green observations (`pnpm exec vitest run --project unit packages/mail/src/gmail-auth.test.ts`):

- Omitted scope: red returned []; green retains the requested grant.
- Explicit reduced scope: red connected; green refuses before profile lookup with actionable mail-permission copy.
- Token shapes: seven red cases exposed coercions/property errors or acceptance; green uses the fixed invalid-response error.
- Token body deadline: red still waited 500 ms after a 100 ms budget; green times out and cancels/releases the body. Header/body stalls at every stage, cumulative timeout, external abort, late responses, 64 KiB overflow and HTTP status classification also pass.
- Identity: nine red cases accepted missing/numeric mailbox or subject, invalid optional fields and a mismatched mailbox; green refuses. Separate red control-character and address-delimiter cases are fixed using the existing core email validator.
- Missing callback code and blank browser token: red proceeded; green refuses before exchange/network. Forged-state recovery, denial, unknown-error privacy, callback listener closure and partial-socket cancellation pass.

Mail validation: 60 auth tests plus the existing compose-portable tests pass; @terno/mail typecheck and targeted oxlint pass. New error keys were committed with plan/spec separately, including the parent's reserved errors.gmail.invalidResponse key with its exact requested English/Spanish copy.

## Integration notes

Parent patch required in packages/mail/src/types.ts: extend GmailTokenBroker.inspect(accessToken, netFetch, options?: { signal?: AbortSignal; timeoutMs?: number }). Optionally clarify GmailConnectResult.grantedScopes's comment to describe effective scopes when the response omits scope. Parent must add token_type: "Bearer" to FakeGoogle's authorization-code success fixture. No shared type or fixture files were edited here.

Full unit/WASM, e2e/web/UI perf, packaged macOS smoke and the independent final Codex review are owned by parent integration. No UI layout changed. All tests use synthetic responses and temporary databases; no real profiles, secrets or live provider requests were used. Outlook and refresh rotation/persistence CAS remain deferred.


## Implementation and verification: backend boundary

Added runtime validation before account creation, token installation, credential replacement and Google owner re-verification. Invalid mailbox/name/subject/verification/grant/refresh results cannot become persisted identities. Explicit reduced mail grants have actionable errors. Browser input rejects blank/control tokens and unsafe reconnect IDs; existing RPC lifetime bounds remain intact. Expiration is based on receipt before inspection; an expired inspection result is never installed. Shutdown is checked after provider and pre-write awaits. Plan 25's superseded-flow ownership and mailbox matching remain in place.

Public-RPC red/green observations (`pnpm exec vitest run --project unit packages/backend/src/google-connection.test.ts`): invalid desktop mailbox was persisted before the fix; invalid browser subject was installed before the fix; inspection extended expiration by 20 seconds before the fix; malformed owner evidence changed ownership before the fix. These now refuse before encryption/installation/persistence. Twenty new RPC cases pass, including reduced scopes, invalid IDs, expired inspection, wrong-mailbox desktop/browser reconnect and unchanged owner/credentials after refusal. Existing initial account sync is awaited before preservation snapshots, so background sync timestamps do not confound those assertions.

Final focused validation:

- `pnpm exec vitest run --project unit packages/mail/src/gmail-auth.test.ts packages/mail/src/compose-portable.test.ts packages/backend/src/google-connection.test.ts packages/backend/src/identity.test.ts packages/backend/src/resign-in.test.ts`: **103/103 pass**, five files.
- `pnpm --filter @terno/backend typecheck`: **pass** after parent's inspect type integration.
- `pnpm lint`: **pass** across apps/packages.
- `pnpm --filter @terno/mail typecheck`: passed before the concurrent parent Gmail REST test was added; latest check reports only `gmail-response.test.ts(44,132)` (nullable string fixture). Exact finding sent to parent; its file was not edited here.
- Parent has applied the inspect signature and FakeGoogle Bearer fixture patches; no integration patch from this slice remains outstanding. The optional effective-grant type comment was also applied by parent.

Independent final review is intentionally left to the parent's separately assigned Codex reviewer, as requested. Full integration/e2e/performance/packaging gates were not run by this worker. No hot sync/list/store path or UI layout was changed by this slice.

## Independent Codex code review — round 1

Reviewed exact head `7507b7c` plus spec/locales `2023c8e`, required script completed exit0/DONE. One medium finding: reconnect's final checks run before setSecret's asynchronous encryption, so cancellation/shutdown or a newer reconnect during encryption can still persist the stale result. Parent adds public-RPC regressions gating encryption during shutdown, supersession and account removal. Encrypt before final identity/flow checks; preserve same-mailbox validation across dropAccount, then check cancellation/shutdown immediately before the store write. Existing newer-flow ownership remains through completion; no token values enter diagnostic output. A second distinct review is required after the correction.

### Round 1 correction and validation

All three encryption-gated regressions failed before the correction: shutdown/superseded flows could complete and account removal left an orphan stale secret. Reconnect now encrypts before final checks, verifies the mailbox before and after dropping its provider, then rechecks flow supersession and backend cancellation immediately before putting the encrypted blob. Both Gmail and IMAP share the final cancellation fence. The five auth/identity/reconnect/Gmail integration suites pass 136 tests; backend typecheck and repository lint pass. Independent second review pending; release gates remain pending.

## W04/T08/S22 initial Google permission qualification

Request: "W04/T08/S22 coherent supported-provider permission slice. Report: consent granting read but not send, or admin denying a permission, must expose appropriate scope and next action; Outlook permission models stay deferred." The full child brief restricts this slice to initial Google OAuth helpers and targeted verification.

Google documents `gmail.modify` as one scope covering read, compose and send ([Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). Terno requests that scope rather than separate read and send grants. Granular consent can omit Gmail altogether or optional contacts scopes, but cannot split this requested scope into read-only and send-denied capabilities. Existing loopback tests cover omitted, reduced and broader grants, malformed scope, and no identity request on reduced grant. Browser consent validation is in `apps/web/src/web/google.ts`; the mail broker only inspects identity and cannot establish scope. Browser callback error classification is a separate dependency outside this mail slice.

Google documents `admin_policy_enforced` for Workspace administrator restrictions ([desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app#errors)). Google may display this at the authorization endpoint rather than redirecting; where the loopback callback receives this exact code, report that Google Workspace policy blocked requested access and ask the user to contact their administrator. Do not claim which individual scope was blocked. Preserve unknown-error sanitization, `access_denied`, exact state checking, callback cleanup, and no token exchange. Test with the real temporary loopback callback and synthetic fetch; no real provider traffic. This is cold sign-in only; no new timers or hot path changes.

### Revisions after the Codex review

Native read-only plan critique (sol unavailable at capacity; terra/high completed) identified three points: show the administrator action on the loopback page as well as in Terno, test forged administrative state followed by a legitimate callback, and reject duplicate error or simultaneous code/error parameters as malformed before classification. The implementation and loopback regressions cover all three. The existing invalid-state handling remains first and unknown errors remain sanitized.

The administrator refusal regression was RED against the original helper (1 failed, 70 passed: invalid-response copy instead of administrator action) and GREEN after the change (71 passed). It drives the actual loopback and asserts both localized response-page strings, no token exchange and listener closure. The forged-state and ambiguous-parameter tests passed before the change and guard the classification boundary; they are not product REDs. Mail/i18n typechecks and scoped lint passed. No Outlook or generic capability model is implied.
