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

Native read-only Standards+Spec code review R1 (`codex exec -s read-only -C <worktree> -m gpt-6.1-sol -c 'model_reasoning_effort="high"' --ephemeral`, commit `d7520057` against `ccfa0291`) completed with zero actionable findings; static review only. No second round was needed. The browser GIS helper's handling of malformed scope and provider error copy was not changed or runtime-qualified in this mail-owned slice; root owns any follow-up and row disposition.


### Root rebase and callback presentation check

After rebase, Root passed all71gmail-auth cases, mail/i18n typechecks, strict four-owned-file lint and whitespace with an external no-globalSetup Vitest config. Root captured the actual public callbackPage output, then rendered it at600×420 in fresh en-US/es-MX browser contexts with both light/dark preferences. All four captures retain the complete administrator action without horizontal overflow or external requests; the callback keeps its existing plain white presentation under either preference. Four screenshots are retained and the two byte-identical locale pairs were visually inspected. This is callback-HTML presentation, not actual Google-hosted authorization, native packaged-app or Web/GIS qualification.

The collaborative preview read the correct language/text/geometry but screenshot capture timed out; Root switched to repository Playwright for the captures after those failures. An initial artifact-capture command found no tsx executable; a temporary one-case Vitest capture emitted actual HTML and was removed without changing source. Native browser and local replay server closed naturally; no real profile/provider was accessed. Root evidence: `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-root-w04-oauth-landing-4l3snncq`. No product/test change follows the one clear native code review.

## Browser GIS callback boundary (W04/T08/S22)

Request: validate and sanitize synthetic GIS callbacks before RPC or state changes, preserve popup and known denial distinctions, and retain legitimate mail sign-in when optional photo access is absent. Desktop loopback and backend identity authority remain unchanged.

GIS returns untrusted callback values. Both public helpers will share one callback handler: reject malformed values with the existing invalid-response copy, map exact `access_denied` and `admin_policy_enforced` codes and popup types to fixed catalog messages, and map other provider errors to a fixed unavailable message. Never expose provider descriptions. Require a valid explicit scope string with the Gmail grant; missing scope is not evidence of optional contact consent. Require a printable nonempty token within the RPC's 4,096 character limit, an integer lifetime between its 60 and 86,400 second bounds, and, for photo authorization, scope within that RPC's 2,000 character limit. Reduced contact scopes do not prevent mail connection. Photos use the backend's existing account verification, including the own-photo case when contacts are absent. No deadline, retry broker or new authorization model is introduced.

Synthetic public-helper tests stub GIS before invocation and assert malformed callback settlement, safe errors, no RPC/state mutation on invalid required grants, and valid add/reconnect/photo cases. Targeted web/i18n typechecks and lint qualify the cold path; no live Google, real profiles, production builds or broad gates. UI uses existing catalog copy; Google may show policy denial on its own page.

### Browser revisions after Codex plan review

Native Codex sol/high read-only critique returned nine points. Applied: retain mail when scope exceeds the photo RPC cap (skip optional photo setup), preserve automatic versus explicit own-photo behavior and best-effort photo setup, settle both malformed callbacks, classify fixed errors before success fields, accept decimal integer lifetimes at RPC bounds, preserve distinct consent prompts, distinguish GIS omission from the desktop fallback, and exercise both public helpers. An error response takes precedence over success fields; malformed error values are invalid. Explicit photo scope remains limited to 2,000 characters by its RPC contract.

Browser qualification: the initial synthetic public-helper suite was RED (23 failed, 6 passed); the final targeted suite passes 19 parameterized tests, including loops through both helpers. Native Codex sol/high Standards+Spec review R1 of `5e9cd402` against `18067c49` found zero actionable findings and independently exercised 78 synthetic in-memory cases. The subsequent test-only commit expands both-path error coverage; no R2 was necessary. Web and i18n typechecks, scoped lint and diff whitespace checks pass.

A dev-only isolated add-account component used synthetic GIS callbacks and blocked external requests. The policy error was inspected in English and Spanish, light and dark (`/tmp/terno-gis-{en,es}-{light,dark}.png`); keyboard Tab/Enter reached and activated the Google control, and axe reported no violations in each case. The harness supplied its own document language and bypassed dev CSP for Vite's React preamble; it is not a full app or Google-hosted-page check. The full web demo failed to initialize with `Illegal invocation`, so full-app visual qualification remains for integration.

## W04 T08/B05 identity and timeout qualification

Request: qualify Google identity authority, reconnect, token inspection deadlines and automatic mailbox rename for the local client; do not introduce hosted-user architecture or change shared backend/store/protocol ownership. Outlook remains deferred.

Gmail `users.getProfile` supplies the mailbox for the token; userinfo supplies `sub` and optional email/verification. The current helper requires any supplied userinfo email to match the profile, accepts omission and retains `email_verified` as evidence. It does not use `hd` as authorization. Reconnect checks the saved mailbox address, and no automatic address rename exists. Subject evidence is stored on the local owner, not generally on each account. A changed address with the same subject must therefore be refused, not treated as a rename. Establish the actual different-subject/same-address behavior through public RPC, without calling it a protected refusal if it succeeds. A subject-bound account migration or provider authority policy would require a separate shared-model/store decision; do not implement it here. Google-owned Gmail/Workspace authority must not be inferred merely from a third-party verified email, and the external hosted primary/secondary-user migration is inapplicable to this local single-user client.

Qualify the shared real identity reader through browser inspection and actual desktop loopback: mismatched profile/userinfo, omitted email, verification flags and ignored hosted-domain claim. Qualify public RPC refusal and duplicate collisions with exact account stamp, owner and credential snapshots; probe same-address/different-subject separately. Test provider lookup failure and deadline cleanup only where existing tests leave a meaningful gap. Use synthetic traffic only, focused tests and touched-package type/lint. No production hot path, UI, provider traffic, broad suites or release gates. Run native read-only plan critique before tests and at most two native Standards+Spec review rounds after coherent work. Existing protections need no manufactured RED.

### Revisions after native plan critique

Native sol/high read-only critique returned nine points (transcript `/tmp/terno-w04-identity/plan-review.log`). Accepted: targeted reconnect refuses changed address, but adding another address may create another account; fresh-token and browser reconnect differ from omitted-refresh renewal's retained-token subject proof; `hd` is ignored and verification is evidence, not a classified authority. Desktop duplicate add rejects, whereas browser add can renew an existing Gmail account. Exact owner evidence/history, account stamp and raw secret bytes are needed for preservation claims. Test both identity entry points, stalled userinfo headers, cumulative browser inspection and cleanup, and public RPC lookup failures. The browser deadline covers inspection only, not GIS popup or persistence. Google documents [profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), [stable subject and hosted-domain claims](https://developers.google.com/identity/openid-connect/openid-connect), and [third-party email limits](https://developers.google.com/identity/gsi/web/reference/html-reference); this is not an ID-token validation implementation.

### W04 observed boundary and focused qualification

Public desktop RPC RED (`/tmp/terno-w04-identity/subject-red.log`: one failed, 27 skipped) expected refusal for a changed Google subject with the same synthetic Gmail profile address. Instead reconnect succeeded. A characterization now proves the replacement refresh credential is installed under the existing local account. This is not proof that Google will issue the synthetic combination, nor a verified third-party email rename: it demonstrates the existing mailbox-only reconnect rule cannot enforce subject continuity. The owner has subject evidence, but other accounts do not have a durable subject. A policy requiring subject continuity for all accounts needs a shared per-account identity/backfill and recovery decision, outside this ownership; do not silently infer it from the address or change core/store here. Omitted-refresh renewal separately compares consent and old-credential inspection subjects. No automatic mailbox rename is implemented.

Focused protection tests cover both real desktop loopback and browser inspection for omitted email/verification, false verification, case-insensitive match, ignored hd, and verified third-party mismatch even with hd. Browser userinfo header timeout cancels a late response and removes the caller abort listener. Desktop public RPC refuses same-subject changed mailbox and provider failure with unchanged account stamp and raw secret bytes; browser inspection refusal installs no replacement token and retains stamp. Bootstrap account/owner snapshots do not prove raw owner evidence or history, queued work, rules, or behavior in every store. Existing tests cover many other deadline and callback cases; no new broad identity safety claim is made. Google scope is one combined gmail.modify grant, not separate read/send capabilities. Hosted primary/secondary user migration is not Terno's architecture; Outlook remains deferred.

Focused validation: `pnpm exec vitest run --project unit packages/mail/src/gmail-auth.test.ts packages/backend/src/google-connection.test.ts` passed 108 tests; mail and backend typechecks and changed-test oxlint passed. No real provider, profile or secret, UI, hot path, broad suites, packaging or performance gates. The red was a policy counterexample, not a fixture failure; the other tests qualify existing behavior and are not represented as product REDs. Additional planned exact owner-history/queued-work and duplicate-collision qualification remains uncompleted pending the shared identity decision; the shared subject policy remains blocked.


### Focused native code review R1

Native read-only sol/high Standards+Spec review of `f30fada5` returned no Standards finding and one P2: browser cumulative deadline lacked its own regression. The added test delays each successful stage by 70 ms under one 110 ms budget; it rejects on the combined deadline, whereas independently reset budgets would allow success. This protects existing behavior, not a product RED. The focused suite passes 109 tests. The review did not run tests and did not access the excluded file. Its log is `/tmp/terno-w04-identity/code-review.log`. This review does not resolve the subject-policy dependency.

## W04 T08/B05 supported Google subject authority implementation

Request: persist verified Google subjects for new accounts; explicit same-mailbox reconnect alone may pin a legacy row. Every replacement must preserve canonical mailbox and exact subject, with pin and credential committed conditionally together. No automatic rename, merge, alias capability, background pinning or hosted-user architecture. Preserve current duplicate-add policy. Root owns serial integration and release gates.

Design: store `googleSubject` in Gmail provider config (no schema bump). Extend the existing secret intent with an optional Google admission (expected old pin, inspected subject, synchronous current-flow/generation predicate). SQL and IDB check stamp, old pin, exact old ciphertext and predicate at the actual transaction, then merge only the pin into current config and publish credential together. Owner change uses the same intent/transaction. Confirmation checks resulting pin as well as resulting bytes. Browser uses the same admission without a durable secret, serialized explicit-flow ownership through token installation. Capture identity/generation before inspection; legacy pinning is limited to explicit inspected consent. Reuse invalid-response/replace-failed localized errors.

Tests: ordinary public RPC REDs for desktop and browser different-subject refusal, exact preserved config/credentials/account/owner; store transaction tests for SQL/WASM/IDB reopen, competing first pins, stale stamp/bytes/predicate, rollback and confirmation. Direct callers cover omitted-refresh, removal, supersession and uncertain commit. Existing public helper deadline/contradictory userinfo tests remain qualified. Cold explicit-sign-in only; no polling or hot-path changes. Scoped types/lint/tests only; no full builds or suites.

### Revisions after the Codex review (subject implementation)

Native Sol/high critique completed with nine points (`/tmp/terno-google-authority/plan-review.txt`). Adopt execution-time IDB persistence checks, complete flow/lifetime/generation eligibility, browser photo-consent coverage, pre-inspection browser ordering, separate durable browser pin admission from volatile token installation, read-only resulting-pin confirmation, guarded recovery and malformed-present-pin refusal. Existing explicit owner/photo consent is inspected same-mailbox consent and is authorized by the selected policy; the review's narrower suggestion to forbid all such legacy consent is not adopted. Implicit duplicate-add renewal may continue for pinned rows only. No background lookup/refresh gains pin authority.

### Implementation qualification before production review

Implemented `googleSubject` in Gmail provider config, compound secret/pin CAS in both stores, resulting-pin confirmation, and browser consent serialization/admission (including photo consent). SQL/logical IDB30/physical18 remain unchanged. IDB rechecks eligibility after asynchronous preparation immediately before opening persistence; rejection reverts staged memory and returns refusal. Explicit flow versions prevent a late duplicate-add inspection from overtaking a newer completed/failed targeted flow; removal retires the version entry. Malformed present pins refuse. New accounts pin on creation; legacy rows pin through explicit same-mailbox inspected consent only, while implicit browser duplicate-add refuses legacy rows. Refresh/sync never writes a pin. No new UI strings/layout, background request, timer or hot sync/list query.

Ordinary REDs: public desktop/browser different-subject same-mailbox tests both failed against recovered evidence (`red.log`: 2failed/30skipped); store first-pin tests initially failed without atomic pin handling (`store-red.log`); the IDB persistence-preparation supersession regression fails when its final admission hook is removed (`idb-admission-red.log`: 1failed/2skipped). All are ordinary future-green assertions, not a characterization of protection. Native loopback fixtures drive actual public desktop OAuth and browser inspection through the backend's mail fetch/native request path, including finite userinfo timeout and changed-subject refusal; external traffic is blocked by `/tmp/terno-network-guard.cjs`.

The focused 9-file unit run passes300tests (`final-targeted.log`). SQL/WASM adapter tests, five package typechecks (including lifecycle config), and strict explicit-file lint pass; exact commands/results are retained under `/tmp/terno-google-authority`. Existing Plan32 tests delayed before actual store admission now require superseded credential preservation and explicit recovery. Genuine after-commit uncertainty still accounts for durable bytes without publishing superseded success; accepted sends remain non-resubmitted. No full suite/build/dist/Vite/e2e/perf gate was run: this changes cold explicit auth/store admission only, with no UI rework. Ports55960/55970 were reserved but unused. Production review follows exactly once for this implementation series; historical evidence R1 is distinct.

### Single production review and final disposition

Exactly one native production read-only Sol/high combined Standards+Spec review completed exit0 for `6290c40c` versus `a09f61fe` (`production-review.txt` and transcript in `/tmp/terno-google-authority`). Standards PASS; Spec required two P2 corrections. It was static and did not rerun tests. Both findings are fixed, without a second production round:

1. IDB owner eligibility included proof expiry independently of secret identity eligibility, but the final persistence hook checked only the latter. It now rechecks both. Ordinary regression stages a legacy first pin/credential/owner transition, expires the proof during preparation, then requires refusal and unchanged pin/bytes/owner/history after physical reopen.
2. Browser photo-token expiration was calculated after awaited account/admission reads. It is now calculated at function entry. Public-RPC regression advances30seconds during account lookup and31seconds at actual admission for a60second token; it must not install the expired token or clear old account authentication state.

`review-red.log`: **2failed/41skipped**, both product REDs. Initial corrected run:301passed/1fixture failure because the raw-history check opened the logical name instead of the physical `terno-` database name. Correcting that fixture name yields `review-final-green.log`: **302/302passed,9files**. Backend/IDB typechecks (including lifecycle), strict four-correction-file lint and diff checks pass. Previous unchanged SQL/WASM tests remain **4/4passed**. No further production review or unrelated lower-priority production fix was started.

Exact final verification commands (all exit0):

```sh
NODE_OPTIONS='--require=/tmp/terno-network-guard.cjs' pnpm exec vitest run --project unit packages/backend/src/google-connection.test.ts packages/backend/src/explicit-renewal.test.ts packages/backend/src/identity.test.ts packages/backend/src/resign-in.test.ts packages/backend/src/icons/google.test.ts packages/mail/src/gmail-auth.test.ts packages/db/src/secret-cas.test.ts packages/db/src/credential-owner.test.ts packages/idb/src/secret-cas.test.ts
NODE_OPTIONS='--require=/tmp/terno-network-guard.cjs' pnpm exec vitest run --project db-wasm packages/db/src/secret-cas.test.ts packages/db/src/credential-owner.test.ts
pnpm --filter @terno/backend --filter @terno/db --filter @terno/idb --filter @terno/store --filter @terno/mail typecheck
pnpm --filter @terno/backend --filter @terno/idb typecheck
pnpm exec oxlint --deny-warnings packages/backend/src/handlers.ts packages/backend/src/identity.ts packages/backend/src/icons/google.ts packages/backend/src/icons/google.test.ts packages/backend/src/google-connection.test.ts packages/backend/src/explicit-renewal.test.ts packages/db/src/sql-store.ts packages/db/src/secret-cas.test.ts packages/idb/src/store.ts packages/idb/src/schema.ts packages/idb/src/secret-cas.test.ts packages/store/src/mail-store.ts packages/store/src/conformance/google-identity.ts packages/mail/src/types.ts packages/mail/src/gmail-auth.test.ts
pnpm exec oxlint --deny-warnings packages/backend/src/icons/google.ts packages/backend/src/google-connection.test.ts packages/idb/src/store.ts packages/idb/src/secret-cas.test.ts
git diff --check
```

Finite disposition: recommend closing the supported local T08 subject-continuity/B05 no-rename authority gap after root serial integration/retest. `gmail.modify` remains combined read/send; no separate denied-send capability is invented. Same subject with changed mailbox refuses targeted replacement; no auto-rename/merge/rules/history/queue identity migration. Synthetic conflicting subject/profile is a local authority test, not evidence Google issues that combination. Browser inspection deadline does not qualify GIS script/popup or total persistence duration. Full release, e2e/web/UI-perf/packaging and live-provider qualification remain root-owned and unrun by this task. No high correctness/data-loss finding remains identified by the single review after its two corrections. Lower self-audit backlog: sign-in version entries for invalid positive nonexistent account IDs can remain until backend disposal; normal UI supplies existing accounts and removal clears their entries. Bound/retire this developer-facing invalid-RPC bookkeeping in a future resource-hardening slice.

Scope incident: one investigative `nativeRequest` search inadvertently used a backend `*.ts` expansion, which included the explicitly excluded test. The search returned no matches; that file was not copied, edited, staged or removed. This violated the read restriction and was disclosed immediately when recognized. Subsequent tests/lint/staging use explicit owned filenames; neither native reviewer accessed the excluded test. Old evidence branch/worktree, main, worklist and user-owned plans were not changed; nothing was fetched/pushed/landed.
