# Plan 28: bounded, validated Google sign-in

Status: implementation in progress. Scope: T08, A01/A02/B03 and X05's initial-profile case from the provider reliability report. Builds on plans 04, 05 and 25. Outlook is explicitly deferred until integration.

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
