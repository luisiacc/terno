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

## Exact verification and handoff commands

All commands ran in this isolated checkout; each test/discovery command inherited `NODE_OPTIONS` and appended `--require=/tmp/terno-network-guard.cjs` (not replaced). No unchanged retry for green. Baseline restorations and the one test-only mutant used try/finally and restored exact input bytes.

```sh
# Focused final source and direct callers: 42 cases / 4 files
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project unit apps/desktop/src/backend-retirement.test.ts apps/desktop/src/shutdown.test.ts apps/desktop/src/preload-shutdown.test.ts packages/core/src/rpc/rpc.test.ts --reporter=verbose
# Explicit native target: 2 cases / 1 file, no application build
TERNO_TEST_ELECTRON=/Users/Luis/projects/emailclient/apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run -c apps/desktop/vitest.retirement.config.ts --reporter=verbose
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm --filter @terno/desktop typecheck
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec tsc --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target es2023 --types node apps/desktop/vitest.retirement.config.ts
pnpm exec oxlint --deny-warnings apps/desktop/src/app.ts apps/desktop/src/backend-retirement.ts apps/desktop/src/backend-retirement.test.ts apps/desktop/src/backend-retirement.native.ts apps/desktop/src/test-fixtures/retirement-main.cjs apps/desktop/src/test-fixtures/retirement-utility.cjs apps/desktop/vitest.retirement.config.ts
git diff --check
```

Each critique/review used exactly `codex exec -s read-only -C "$PWD" -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -o <output> - < <prompt>`; prompt/run logs/output are in /tmp/terno-w05-desktop. One plan critique, R1 then R2 only; no fallback/nested work.

Finite recommendation to Root: A09's desktop single-owner replacement boundary is qualified for logical ACK/kill versus actual exit, conservative held ownership after expiry/failed signalling, late physical exit restart, and native utility/body terminal control. Keep A09 needs-work for foreground/project policy and Web retirement (peer-owned), and do not generalize this into arbitrary crash/send recovery, packaged supervisor/preload proof or release-green. W05 remains open. All existing held round-two findings and branches, W10 repair99836679 and S48 remain held and are not dependencies.

No renderer/UI/copy/assets, backend core/netpolicy/mail/stores, reminders/schema, protected plans, worklist/main, user WIP, real profiles or secrets were touched. No perf hot path changed, so no perf file applies. No full repo gates, production app/Vite build, packaging or smoke ran. Installed Electron45 is only the utility runtime dependency; changed helper is compiled into a disposable fixture, not an old Terno executable. Root owns serial rebase/retest/fast-forward/worklist/removal.

## Final R2 verdict and held findings

Actual native Sol/high read-only Standards+Spec R2 reviewed41e7fd76..ed655d34de23c55dccfdf392999c7b38a141c248, exit0/substantive DONE. Transcript /tmp/terno-w05-desktop/review-r2.txt. No P0/P1/data-loss finding in physical-exit authority. Two residual P2s are **held**, not fixed or approved by this child; no R3/reset:

- Standards P2: native runner installs its failure cleanup deadline after identity capture. If `ps` fails while Electron stays alive, awaiting closure first has no unconditional bound. Arm cleanup before capture while retaining exact-identity signalling rules. R1 pre-ACK cleanup is fixed and proven, but this additional failure boundary means R1 cleanup is only partially closed overall. The actual runs captured identities, joined successfully and removed profiles; arbitrary identity-capture failure is unqualified.
- Spec P2: connectWindow awaits readiness before rejecting retirement. Retirement before ready suppresses subsequent ready messages; if termination also fails, repeated window creation may retain readiness continuations/documents indefinitely. Cancel/deduplicate readiness waits without releasing physical ownership. Physical no-overlap remains protected, but bounded handoff continuation cleanup is unqualified for this combination.

These are the new R2 lower-severity backlogs explicitly required to remain held. Existing held P2s and exhausted series remain untouched. Earlier R1 “all corrected” refers to the implemented fixes/evidence at that checkpoint; R2's partial cleanup assessment above is authoritative. No source change followed R2.

Final finite disposition: recommend the demonstrated desktop physical-exit/no-reuse sub-boundary as qualified with these two named cleanup limits, **not** closure of all desktop retirement/liveness or A09/W05. Retain A09 needs-work for these cleanup boundaries plus peer-owned Web and foreground/project policy. Neither held P2 grants permission to resume implementation in this exhausted series.

Cleanup audit /tmp/terno-w05-desktop/cleanup-audit.json confirms the recorded parent/utility PIDs absent and synthetic directories removed for original native witness, final body, final pre-ACK and failure mutant. Test-generated packages/backend/dist/incoming.worker.cjs and its newly created directory were removed (directory birth matched first test02:44:22). Original report/working artifact state is restored; dependencies remain installed/ignored. All command sessions were joined; no user process was signalled. No full gates/build/smoke was run. Final handoff is a clean committed branch after this documentation-only record; Root owns all integration.


## Authorized R2 follow-up (2026-10-31)

New request (verbatim): "desktop retirement R2 P2s (identity-capture cleanup, pre-ready handoff waiter retention)."

Actual base: 89123bfe18f4689623ec62a56190cac963baface, clean T3-prepared isolated checkout. Source4495d681 is already landed. Earlier critique/R1/R2 history above remains authoritative; this is explicitly authorized follow-up with exactly one native gpt-6.1-sol/high read-only Standards+Spec review after fixes, no review loop. Any remaining/new P1/P2 parks only this item, committed/unlanded for Root.

Design: arm native supervision before identity capture and keep cleanup unconditional; capture failure uses the fixture handshake to end its own Electron/utility without signalling unverifiable identities. Keep PID/birth/argv equality before any fallback signal. Release pending renderer readiness on retirement and reject new retiring handoffs before awaiting readiness. Retain exact UtilityProcess ownership until observed exit.

Tests: ordinary failing behavioral cases first for actual identity-capture failure and source-extracted pre-ready connectWindow/stopBackend with failed termination, repeated requests, suppressed ready and no port allocation. Then existing 42 direct controls plus native 2 and added cases, desktop full-package and dedicated config types, exact-file lint, serial. Append inherited NODE_OPTIONS network guard to every test. Synthetic profiles only; archive/restore original generated artifact state.

Perf: cold lifecycle only; no mailbox/list/request hot path change, so no perf file applies. No polling or new idle activity.

Out of scope: all shared backend/core/RPC/store/incoming code, S48 ownership, editor/list/UI, protected user plans and WIP, full repo gates, production app/Vite builds, packaging/smoke, broad A09 closure, push/fetch/landing. Root owns integration.


### Follow-up implementation and pre-review evidence

Readiness regression RED 1/1: zero of 21 handoffs completed after failed pre-ready retirement (expected21); actual extracted connectWindow/stopBackend, no synthetic ready rescue. GREEN43/43 across original four direct-control files. stopBackend marks retirement first, then resolves the generation readiness promise; connectWindow rejects a retiring/destroyed owner before retaining a document. Existing post-await generation/document checks remain. Physical ownership is unchanged.

Capture regression RED1/1: actual injected invalid `ps` invocation fails, and the old runner exits0 instead of required abort2 (initial throw-only RED also retained). GREEN3/3 native cases: original body, original pre-ACK, new identity failure. Runner arms12s supervision before capture and joins in finally; EOF denies the fixture work handshake and utility exits naturally before parent exit2. One-second bounds on identity subprocesses keep synchronous capture finite. No fabricated identity or unverified PID signal; all three final runs recorded zero fallback signals. stdin errors and partial output cannot bypass cleanup. Main and utility identities are recorded by the fixture; runner records launch PID immediately. `/tmp/terno-w05-desktop-r2-followup/cleanup-audit.json` confirms all recorded parent/utility PIDs absent and profiles removed.

Desktop full touched-package config typecheck, dedicated retirement config types, five exact changed-code file lint and diff-check pass. Native final rerun followed additional finite identity-probe/error-handling changes; no unchanged retry to seek green. All tests appended inherited NODE_OPTIONS with the required guard. No Backend is instantiated in selected tests, so managed Backend Request mocks are inapplicable. No unexpected external routes observed. Dependency auto-provision on first pnpm invocation reused720 local packages and ran ensure-electron; no app build was requested. The selected unit setup generated incoming.worker.cjs from an initially absent worker/dist; both were removed after checks. A RED run used the legacy body-witness path; its output is archived separately and the preexisting witness restored from Root's archived prior bytes. No real profiles/secrets were accessed. Installed Electron45 fixture only, no full app/preload/package or arbitrary crash recovery coverage; no full A09/W05/release-green claim.

One authorized follow-up Standards+Spec read-only Sol/high review follows this coherent result. Evidence directory: /tmp/terno-w05-desktop-r2-followup. Earlier held findings outside these two remain held.
