# W05/A09 desktop physical retirement

## Request (verbatim scope)

“W05/A09 desktop utility/backend physical retirement, new plan docs/plans/drafts/w05-desktop-backend-retirement.md.”
“when old backend/utility is closing, stalls, exits or is replaced, old OS process/native requests must have physically terminated or remain conservatively owned BEFORE replacement may reuse request/storage authority.”

## Existing

Actual base 41e7fd76 (expected main41e7fd76), clean isolated checkout. Read AGENTS, report A09, W05 worklist, Plans31/43/62 and current87. app.ts holds the single-instance lock; utility owns DB, requests and direct renderer ports. Crash restart waits for exit, but stopBackend clears backend and calls kill without joining exit. Late shutdown-result then restarts immediately. Old messages/exit callbacks can affect global waiters. Shutdown ACK only proves logical closure. No shared interface dependency is needed.

## Design

Retain the exact UtilityProcess object through physical exit. A small source-level lifetime helper owns retirement, calls only that object's kill, and observes exit registered before termination. Retirement observers have a bounded grace wait; expiry reports false and never clears ownership. No PID lookup/signalling. Gate network, renderer transport and side effects during retirement and after stale generation. Deliberate exit clears ownership, resolves that generation and may restart only while running. Quit/update cannot release authority based solely on ACK/kill/timeout; bounded failure defers exit/install while ownership remains. Do not alter provider, store, receipt, draft or schema semantics. No unknown-send retry.

## Tests

Use existing source lifecycle harness conventions, deterministic exit/kill race tests and app source wiring assertions, ordinary fail-first for the actual clear-before-exit defect. Add a narrow installed Electron utility fixture executing the changed helper without an app build: synthetic temp profile, captured PID/birth/argv, loopback native fetch body held through logical ACK and actual utility kill/exit, server socket terminal witness before replacement authority. No generic Node process presented as utility proof. Exact direct shutdown/preload/reload/RPC controls only; desktop full-package types and exact lint. Every test inherits NODE_OPTIONS plus /tmp/terno-network-guard.cjs. Restore incoming-worker artifacts after checks.

## Performance

Cold process lifecycle only; one bounded observer timer per retirement, cleared on exit/expiry, no polling, no mailbox/request hot-path changes. No perf file applies.

## Out of scope

Foreground fairness, web worker, shared core/netpolicy/mail/stores, all held findings/branches, release repair, UI, packaging, native crashes outside owned utility, OS shutdown and durable receipt crash recovery. Preserve W03/W02/W05 and user feature/schema state. No full suites/builds or real profiles. At most two native Sol/high Standards+Spec reviews after coherent implementation; no children, fetch/push/landing/worklist changes.

## Revisions after the Codex review

One actual native Sol/high read-only plan critique returned11 points (external transcript /tmp/terno-w05-desktop/plan-review.txt). Physical failure maps to timeout, not closed; hidden windows return and the instance lock remains held. Overlapping install calls defer. Identity guards precede global waiter settlement; guarded starts/crash timers cannot run during shutdown. Renderer handoff captures generation/document across readiness and closes failed ports. Irreversible retirement gates host messages/network/new ports; existing direct RPC remains physically owned until exit. Reversible sending/update timeout retains the live utility. Flush commitment follows retirement, otherwise releases. Late init/ready cannot authorize replacement: only observed exit can. Idempotent helper shares one bounded observer and retains ownership after failed/throwing kill or observer expiry; late exit can restart once while running. Child entry remains unchanged: stop/init logical details cannot grant main process reuse authority.

## Implementation qualification before R1

Implemented physical exit observer and host ownership gates; no backend-entry/shared changes. Initial structural RED1/1 on original host. Functional source harness executes actual extracted host functions: original stop releases ownership before exit, original shutdown reports closed on physical failure, overlapping install reports closed. Baseline actual-function RED3/3, restored implementation GREEN8/8 (includes5 helper/structural cases). Installed Electron45 real utility/native fetch fixture passes1/1: a synthetic held body survives logical closed notification; captured utility kill then exit and loopback server socket terminal are observed before completion. This is changed-helper/native-boundary proof, not full application lifecycle qualification or unknown-send crash persistence. Utility and Electron parent PID/birth/argv and natural exit are recorded in /tmp/terno-w05-desktop/native-witness.json; no real profiles, app build or PID signalling.

Scoped direct controls pass28/28 across4 actual files (backend-retirement, shutdown, preload-shutdown, core/rpc/rpc). An extra native-reload.test.ts filter named a nonexistent file and selected no additional suite; no native-reload qualification claimed. Desktop package types and six exact-file lint pass. New actual host cases and final checks are recorded below. No UI or request hot path changes; no perf, broad gates/build/packaging runs. Offline frozen dependency install used ignore-scripts. Incoming worker normal test setup only.

## Code review R1 and corrections

Actual native gpt-6.1-sol/high read-only Standards+Spec R1 reviewed41e7fd76..45d456c3; four findings (Standards P1 native discovery, P2 failure cleanup; Spec P2 waiter retention, P2 host coverage). Transcript /tmp/terno-w05-desktop/review-r1.txt. All corrected:

1. Native case moved from default `.test.ts` to explicit `.native.ts` plus dedicated vitest.retirement.config.ts. Before-discovery lists the native case; after-discovery selects zero. No skip or assertion weakening. Target explicitly needs installed Electron45 and network guard; it provisions evidence dir itself.
2. Utility waits for a captured-identity parent handshake. Unexpected pre-ACK exit now closes its loopback server and naturally exits Electron with2; watchdog owns finite failure finalization. Outer runner joins captured launch and cleans its synthetic directory in finally; its12s failure cleanup signals only exact captured PID/birth/argv for its own utility/parent. Removing pre-ACK finalization makes the unchanged native regression fail1/1 (expected2, watchdog3), with natural process join and all temp cleanup. Mutant witness retained separately. Restored native cases pass2/2. No generic Node substitution or old app binary claim.
3. Failed forced retirement clears logical waiters before returning timeout, independently of retained physical ownership. New ordinary regression was RED1/1 before the one-line fix; three repeated failed quits now remain bounded at zero waiters.
4. Source-extracted actual callbacks now exercise stale/retiring message refusal, stale exits, observer timeout then late exit/restart exactly once, shutdown/generation crash-timer refusal, deliberate exit during shutdown, generation/document/retirement readiness refusal and failed-quit restoration. Original-generation wiring negative run and final current controls are retained. These do not boot the full app. Expanded controls pass42/42 across4 files (19 retirement +23 adjacent).

Initial expanded package types found one fixture ProcessEnv inference error; explicit NodeJS.ProcessEnv fixes it. Desktop package types, dedicated config types and seven exact-file lint pass after correction. No product UI or hot path changed. Second/final Standards+Spec review follows coherent corrections; no third review is authorized.
