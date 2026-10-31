# W05 B41 — onboarding quota recovery

## Request (verbatim)

“Onboarding quota exhaustion must have a recovery path.”

“Investigate actual Ternoarchitecture first: don't invent hostedtenant signupquota/projectsetupservice; if report'sarchitectureN-A, saywhy and independently qualify applicable add-account/consent/verification recovery. Do not call supported429/localcapacity gaps N-A justbecausehostedarchitectureabsent.”

“Concrete necessarycore/contractdependency→ordinaryfail-first test+Rootqueue, noworkaround/unwiredhelper.”

## Existing architecture and actual base

Actual base: `4bd1b4e3616229d9779851ea59b2a605d9303996` (expected main4bd1b4e3); initially clean isolated checkout. Read AGENTS, report B41, baseline B41, worklist B41 and Plans25/28/32/62/71. The foreign open report names Next onboarding, EmailStatsPreloader and analyzePersonaAction; none is Terno's local Electron/Web account onboarding. No hosted project/tenant service is applicable. Optional photos already fail independently in the Web helper.

Initial `accounts.connectGmail` and `accounts.connectGmailToken` hand `b.net.fetchFor("mail")` to actual OAuth/identity helpers. The latter wraps inspection failures as BAD_REQUEST/messageOf. Managed local physical capacity and durable 429 admission use `fetchGoogle`, a distinct backend capability. No public quota deadline DTO exists for an onboarding countdown. GIS rejects denied/admin/unknown errors through fixed catalogs before RPC. Add Account settles busy in finally and leaves its button available for explicit retry; existing S53 qualifies keyboard/axe/locales/themes, not actual quota/capacity witnesses.

## Design

Add dedicated public-auth integration qualification with synthetic native Request/Response transport installed before Backend construction, real inspectGmailToken, temporary SQL storage, real memory RPC. Exercise initial HTTP429, permanent403, later explicit successful connection and wrong-account refusal; verify exact routes/counts, no half-account or token installation, no unsafe provider detail, and preserved stored draft/account state. Separately probe managed capacity through its actual network capability with retained native bodies and EOF, then call public initial auth: demonstrate any bypass with ordinary fail-first gates and queue necessary backend/contract work to Root. Do not change owned-by-peers core/policy/contracts, invent renderer deadlines, parse provider text or add an unwired helper.

Existing behavior may need qualification only. No product change without genuine behavioral RED in the owned UI/helper. Fail-first dependency evidence is retained externally; passing qualification must not claim the unavailable reason/deadline contract. No UI change means no new copy or visual claim.

## Tests and performance

Only the dedicated new integration file and direct caller Google helper/connection files; inherited NODE_OPTIONS appends /tmp/terno-network-guard.cjs for every test. Touched package types and strict exact-file lint. No hot-path production change, hence no perf run. No full suites, production/app/package builds, release tests or native OS claims. No real profiles/secrets or external provider requests. All fixture resources close/join.

## Out of scope / finite disposition

Foreign hosted optional-analysis architecture: N/A. Supported local HTTP429/capacity admission: qualify, never N/A. Deferred serialized core/reason seam, durable quota403 Retry-After S23 and disabled-service B35 remain Root-owned; B38/W11/A19/editor/release work untouched. Live quota, actual GIS hosted page, native OS OAuth, crashes and fleet certification remain unqualified. Root owns worklist disposition and serial integration; no push/fetch/main edits.

## Revisions after the Codex review

Native Sol/high read-only critique is running; implementation uses actual inspectGmailToken and records the initial RPC/managed capability distinction rather than claiming managed admission is wired into initial auth. The first qualification run passed three cases and failed one fixture baseline: automatic initial sync completed after the account snapshot. Explicitly join that sync before recording the preservation baseline; this is not product RED. First pnpm invocation automatically materialized cached dependencies and ran existing ensure-electron postinstall; no dependency/lockfile changed or app build was requested.

### Critique outcome and bounded implementation

Plan critique completed exit0: eight points. Adopted same-Backend managed saturation, separate durable recording RED, explicit target account for wrong-mailbox recovery, HTTP403 safe-refusal terminology, and browser-token-only scope. Desktop code exchange, actual GIS/UI quota presentation and prior-active-constraint admission/expiry remain open. Contrary to critique point4's hypothesis, the actual serialized error-reference gate PASSED: messageOf preserves the safe localized reference. No localization defect is asserted. The critique was read in full before the dependency probes; initial test authoring overlapped its read-only run.

## Root queue / reproducible fail-first dependency

Two ordinary assertions, without product changes, fail against the actual base:

- Same Backend's `net.fetchGoogle` pool is filled to its real refusal (64 native bodies, derived by attempting admission, not a client cap). A managed inspect refuses without dispatch; public `accounts.connectGmailToken` unexpectedly resolves with an account. Initial handler uses unmanaged fetch, bypassing local capacity. `/tmp/terno-w05-b41/dependency-red.txt` records this real RED.
- Initial public HTTP429 rejects safely, but `decodeCooldown(await backend.store.providerCooldown.read()).rows.length > 0` fails with actual0. `/tmp/terno-w05-b41/durable-red.txt` records this separate RED. The command selected just this added gate; Vitest reports other cases as unselected, not authored skips.

Full reproducible desired test patch (no .skip/.fails or UI workaround): `/tmp/terno-w05-b41/root-dependency.patch`. From this checkout apply it with `git apply /tmp/terno-w05-b41/root-dependency.patch`, then run `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project unit packages/backend/src/onboarding-quota-recovery.int.test.ts`. The patch is deliberately queued rather than installing a permanently failing suite or changing the disallowed seam. Root must serialize changes to initial Google handlers (`packages/backend/src/handlers.ts`), BackendCore's admission lifetime (`packages/backend/src/core.ts`), existing typed reason projection and any necessary public contract. This series owns none of that production seam. Do not merge quota403 Retry-After or disabled-service fixes from the unlanded B35/S23 evidence branch into B41.

Passing tests retain the actual public HTTP429/403 safety and explicit reattempt witnesses, saved account/config/owner/draft preservation under targeted reauth refusal, wrong-mailbox rejection and later same-account success, a real managed native-body EOF recovery control, and a serialized safe error-reference check. Registry inspection is real inspectGmailToken, not a mocked result; mailbox sync provider is inert, so no existing-message preservation/fleet-sync claim. The managed control uses its own policy ledger with the SAME Backend network pool; it is NOT evidence the initial auth handler uses that policy. All allowed routes are enumerated; unexpected requests fail before native transport. No real Google traffic, real token, local profile, UI edit, locale edit or new timer.

## Checks and disposition recommendation

`NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project unit packages/backend/src/onboarding-quota-recovery.int.test.ts packages/backend/src/google-connection.test.ts apps/web/src/web/google.test.ts`:63passed/1failed. All5new qualification cases pass. Existing desktop native identity setup timed out at its existing100ms contract; no retry, deadline change or green claim. Log `/tmp/terno-w05-b41/targeted.txt`. `pnpm --filter @terno/backend typecheck` passed (main+lifecycle); `pnpm exec oxlint --deny-warnings packages/backend/src/onboarding-quota-recovery.int.test.ts` passed. No broad gates or app/package builds; selected tests used their normal incoming-worker preparation. No perf run because no production hot-path code changed.

Recommend B41 remain **needs work, dependency queued**, not covered or wholly N/A. Foreign hosted optional-analysis architecture is N/A only. Browser-token initial safety and managed EOF recovery have finite synthetic coverage; public local-capacity/durable429 wiring is demonstrably missing. Reason-aware quota versus capacity UI, authoritative retry admission and quota-specific busy/keyboard/axe/en-es/light-dark remain open until the public backend capability is serialized. Existing Plan71 S53 is not re-certified or substituted. Desktop OS/browser consent, real provider limits, userinfo-stage refusal matrix, crash/restart and prior-active-deadline expiry remain unqualified. This is no all26-row completion or release-green claim.
