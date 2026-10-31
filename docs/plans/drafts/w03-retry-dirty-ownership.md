# W03 B07/B14 retry and dirty ownership

Actual base: `6442b1d69f8e4322388549a321ed29e4adf0cd23` (matches expected main6442b1d6). Isolated implementation worktree; no children, main/worklist/held branches untouched.

## Request (verbatim, assigned slice)

> Own W03 B07/B14 coherent retry/coalescing recovery. B07 'Failed deduplication locks can turn recoverable failures into permanent skips'—adapt to local durable sync/repair, no Redis/hosted dedupe locks. B14 'Repeated resync requests can create an idle CPU/network loop'—bound repeated reset/dirty requests, prove supported idle after failure/recovery, no timerloops/redundant fullpasses.

> Already-protected evidence may be immediateGREEN; meaningful mutation/negativeoracles, no falseproductRED. Real defect needs ordinary failfirst. If safeownership/fairness broader than B07/B14, preserveexactdependency for Root rather than expandA20/T06/S56 byaccident.

## Existing contract and investigation

Read AGENTS; report B07/B14; corresponding worklist/baseline W03 entries; Plan26 baseline, full-sync phase, cached refresh and startup ownership sections; Plan31 lifecycle; Plan62 activation/deferral scope. There is no Redis processing lock, hosted webhook fleet or Gmail watch. `BackendCore.syncAccount` owns one promise per account and one coalesced trailing intent. Its identity-checked finalizer releases ownership on failure and cannot delete a replacement's gate. Gmail commits its cursor after effects; replay relies on native store provider-ID dedupe and filter claims. Prior A04/B09/S05 startup/retirement tests already qualify these adjacent contracts; preserve them.

## Design and tests

Start tests-only: extend the existing managed Google ownership integration fixture, intercepting actual fetch before Backend construction and rejecting unexpected routes. Public sync.now drives repeated requests. Add SQL/fake-IDB cases for a failed cursor write after partial message/body/asset/filter effects, exact unchanged checkpoint, immediate later retry and native-adapter graceful reopen. Repeat successful input and assert exact message identity, asset bytes, membership and filter hit count. A second case holds the unchanged failing response, sends concurrent public requests, awaits actual pass finalizers, observes actual timer ownership with a retryable-failure negative control, and recovers on a later explicit trigger without full enumeration. Existing retired-owner/sibling/latest-intent tests remain direct controls. No process-crash claim from graceful close.

Observe behavior first. Existing protection receives explicit test-only negative oracles (temporarily suppress finalizer release or violate cursor-after-effects ordering); do not label those product REDs. A genuine discovered defect requires an ordinary behavioral RED before production edits. Any broader ownership/fairness dependency queues to Root.

## Performance and boundaries

No production change planned, hence no perf file unless a genuine hot-path fix becomes necessary. Only touched backend package types, exact-file lint, selected integration/direct lifecycle/network cases. No full tests, app/build/release gates, new timing gates, workload changes or retries until green. Tests inherit NODE_OPTIONS network guard. All data synthetic/temp; no real profiles/secrets. Plans64–68 and W05 files remain read-only. No UI, editor, IMAP identity changes, general queue or durable notification ledger.

## Revisions after the Codex review

One actual native Sol/high read-only plan critique completed exit0 with nine refinements, all accepted: precommit and postcommit-ack faults separately; enabled scheduler with an actual automatic-retry control; malformed200 distinct from503/429; bounded dynamic finalizer joins; A→B→C intent windows; fault/state/effect witness before recovery; assertion-specific negative controls; independent unexpected-route ledger; exact identities/claims before repair and reopen with outstanding cursor. Tests extend the existing registered integration file to reuse its managed fixture rather than invent a parallel provider model. No new production defect is inferred. Initial CLI invocation was rejected by argument parsing before model execution; corrected stdin invocation is the sole actual critique (`plan-native.log`).

## Behavioral qualification and negative controls

Tests-only: no genuine product RED or production fix. Initial focused qualification passed eight cases and failed two incorrect malformed200/nonretryable assumptions; changed the scenario to an explicit nonretryable400. Next run passed ten and exposed the fixture's wrong `phase:enumeration` expectation (actual durable marker is version1/stage:restart). First restored direct-caller run passed64 and failed2 because the new full-list route incorrectly omitted recoverable arrival mail after the baseline advanced; corrected the synthetic listing, preserving the exact message/effect oracle. Initial scoped types caught the settlement helper's overly narrow mock result type; it now accepts unknown result values as Promise.all does. These are test-development failures, not product defects.

Retained-owner mutation: both stores fail the exact later-history-dispatch assertion (`[100]` rather than `[100,102]`), proving B07 detection. A literal retained-dirty mutation starved microtasks; verified owned process ancestry/birth/argv was captured and only those trees SIGKILLed/reaped. A prematurely concurrent targeted run was invalidated and stopped too; it is not validation evidence. Original core bytes restored in finally. The initial dirty log contained only the run header; the later finite control reused that owned log path (initial supervision evidence remains). A finite test-only four-extra-pass control then fails SQL at the exact three-versus-seven history-request assertion; IDB is its one passing control because the module counter was consumed. Neither mutation is committed. Negative controls are characterization evidence, not product REDs. Source restoration is checked with git diff before validation.

## Final implementation qualification before review

Scoped types also exposed that Backend intentionally does not accept injected connectivity timers. Removed that test instrumentation entirely. Final tests inspect the production `backend.connectivity.timers` ownership getter; the503 negative control waits for the actual default backoff timer to dispatch a second real managed history request without any manual trigger, then asserts zero remaining timers and exact recovery. No timer policy, delay, window or timeout was changed. Both stores qualify unchanged400 rejection with A/B/C trigger windows, expired-history reset/catchup refusal with one full enumeration per explicitly requested pass, precommit checkpoint failure with live/reopen replay, and postcommit lost acknowledgement with a later public request. Existing retirement/replacement tests remain unchanged.

Final commands (all inherit original NODE_OPTIONS plus `--require=/tmp/terno-network-guard.cjs`), logs and process identity/results in `/tmp/terno-w03-retry-6442/`:

- `pnpm exec vitest run --project unit packages/backend/src/sync-ownership.int.test.ts packages/backend/src/account-lifecycle.test.ts packages/backend/src/network.test.ts -t 'local ownership|account lifetime|network'`: 66 passed, two existing crash cases unselected, exit0 (`targeted-native-timers`). Includes12 new B07/B14 cases and54 existing controls.
- `pnpm --filter @terno/backend typecheck`: both normal/lifecycle programs pass, exit0 (`types-native-timers`).
- `pnpm exec oxlint --deny-warnings packages/backend/src/sync-ownership.int.test.ts`: exit0 (`lint-native-timers`); `git diff --check` clean.

No production bytes change, so no hot-path perf run is warranted. No full suites, app/Vite/package builds, UI, release milestones or held branches touched. Native fixture worker setup is the ordinary selected-test setup. All successful command children completed naturally and were waited/reaped; the explicitly invalidated mutation/check processes have separate supervision records.

## Recommended finite dispositions (Root owns the ledger)

- **B07: already protected.** No hosted/Redis lock applies; independently qualified local gate release, retained cursor obligation, exact idempotent effects/filter/asset replay, lost-ack distinction and graceful SQL/fake-IDB reopen. Existing A04/B09 ownership/crash tests retain their prior provenance; no new process-crash guarantee is claimed here.
- **B14: already protected for the supported finite contract.** Repeated public requests during each active pass coalesce once; a fresh request during trailing work remains legitimate. Repeated expired history performs one reset per requested pass, retains restart obligation, and does not recursively enumerate indefinitely. Nonretryable400 settles with zero owned connectivity timers; legitimate503 schedules and actually executes default backoff recovery. Recovery consumes the obligation. Eight event-loop turns after finalization are a finite additional witness, not a universal idle guarantee.

Limits: no Gmail watch/webhook service, Redis/distributed locks, native-browser crash/lock handoff, arbitrary malformed-provider census, real external service traffic, or physical process-crash/restart witness added. Periodic sync, scheduled retry and explicit later requests remain legitimate. A20/T06/S56 invocation fairness, poison handling and broader pending-attachment recovery remain outside these two dispositions; no new shared dependency found and no generic queue/notification ledger justified. This does not dispose of all28 outstanding report rows or establish release green.

## Actual native code review and handoff

Exactly one native read-only Standards+Spec review completed naturally, exit0/reaped, pinned to `6442b1d6..c846a309`. Transcript header confirms OpenAI/gpt-6.1-sol/high/read-only; full prompt/output/process evidence is `review1.*` in the evidence directory. **Standards PASS; Spec PASS; zero actionable findings.** No finding-driven fixes, second round or third review. The reviewer read the complete committed scope and relevant direct source but did not rerun tests/mutations. It confirms precommit versus postcommit-ack distinctions, native-adapter graceful replay identity/effects and A/B/C/reset counts with enabled production default-backoff dispatch.

Review limits retained verbatim in substance: eight event-loop turns establish finite quiescence only; the production timer getter covers connectivity ownership rather than all process timers; graceful reopen adds no crash/native-browser guarantee; fairness, poison and broader pending-attachment recovery remain outside scope. Later changes are this evidence-only record, not independently reviewed production/test changes. No in-scope shared dependency or outstanding finding remains for this finite handoff. Root retains sole authority for serial integration, any rerun and worklist dispositions.

The invalidated owned process identities were checked after reaping: none remained alive with the captured identity (`supervised-tree-final.json`). Successful selected tests closed their synthetic fixture backends/stores and temporary profiles; no user process, port or real profile was touched. Broader milestones and the remaining provider report rows remain pending.


## Root integration

Rebased series onto committedmain2d19f82c; no conflicts or production changes. Root66selected tests, backend both types, owned lint/whitespace pass; two existing crash cases intentionally unselected, not new skip annotations. Evidence `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-root-w03-retry-j26kvs3o`, exact guardedargv/PID/results. All processes naturally joined. Fast-forward landed82f7c96f. One actual nativeSol/high review PASS/PASS0, no further review/source/test changes. Root records B07/B14alreadyprotected with the finite post-finalizer/connectivity-timer/graceful-reopen limits above. No fullgate/build/perf/releaseclaim.
