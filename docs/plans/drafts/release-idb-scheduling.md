# Release slice: IDB scheduling

## Request and boundary

Investigate the milestone `ops scheduling at scale (IndexedDB) > a parked bulk archive and a trash over the same 100,000 messages: scheduling doesn't walk them` failure (10.116625 ms against unchanged 10 ms). Preserve the original timing gate and workload; distinguish timing qualification from demonstrated complexity. Own only the scale test and directly causal IDB scheduler code/direct tests. Plans38/58 govern ownership; Plans64–68 and held R2 policies remain read-only. No SQL/shared-contract changes, broad suites, builds, real profiles, push or landing.

## Baseline and source findings

Committed base: 8d767888. Once-only unchanged run with the network guard: `pnpm exec vitest run --project unit packages/idb/src/ops-scale.test.ts -t 'a parked bulk archive and a trash over the same 100,000 messages'` passed (1 passed, 1 name-filtered). Log: `/tmp/terno-idb-scheduling-baseline.log`. No RED/GREEN timing claim is justified. Default unit configuration/concurrency; no exclusivity or added conditioning. Existing single nextAttempt warm call is unchanged; no claim warmup is added. pnpm initially materialized dependencies from its local store; no source change.

`locationBlockers` uses `targets.by('fk_op_id', id).some(...)`; MemDb Table.by eagerly reads every indexed row before some can stop. Thus 100,000 target materializations happen even with a blocker at the first target. Per-message predecessor lookup remains indexed and cached only for this scheduler pass. No stale global cache. Queue readiness/state/account admission, grouping and seq semantics remain as currently implemented. Unknown/failed/succeeded operations do not block; queued (including parked) and running location predecessors do. Targets use globally unique message IDs; account admission filters candidates, not the ownership dependencies. Source identity holds are enforced separately at command/provider dispatch, not invented as scheduler filters. The fixture has 200,000 target rows, two operations, one minimal account and no message rows: MemDb op_targets has an op FK, no message FK. This is a memory scheduler test, not native IndexedDB persistence qualification.

## Proposed minimal fix and discrimination

Add an access-count oracle over the same 100,000-message fixture, separately testing nextAttempt and claim. Count target rows actually fetched, assert exact blocked results and no operation changes. Demonstrate ordinary RED on the eager implementation, then replace only the outer eager target lookup with existing live keysBy plus per-key get and early return. Resolve current rows by key; no new indexes, persisted layout, payload parsing, caching, timers or quota changes. Preserve the original timing test byte-for-byte.

Direct safety controls cover queued/parked/running/unknown predecessors, group isolation, later-target overlap, ordering/readiness, claim limits/attempt increments, and account admission. Existing identity controls exercise the provider dispatch boundary. No wrapper change is planned.

## Validation and limits

Only affected scale/direct tests, IDB package types and focused lint. Existing default unit scheduling; keep all fixture sizes, budgets and slice defaults. No SQL/WASM run is needed for a memory-only algorithm change. Exactly one native read-only plan critique (at most 12 points) before test/code changes, followed by exactly one completed native Standards+Spec code review. Fix concrete findings fail-first; after the cap high correctness/data-loss only, lower findings backlog. Root owns serial integration and release qualification. Baseline pass does not resolve the milestone timing failure or clear release.

## Revisions after the Codex review

One completed native read-only critique (9 points, exit 0), `/tmp/terno-idb-scheduling-plan-review.log`. Accepted: spy on underlying target rows.get (Table.get alone misses by), independently assert three accesses for each scheduler, restore instrumentation before assertions, cover both group filters and later overlap, retained-target state matrix, out-of-order insertion/readiness/limits/attempts, real Gmail admission with zero rejected-target reads, and per-call cache freshness. Preserve inner lookup and encoded keys. Claim only bounded early-blocked candidate reads, not constant-time scheduling overall. Source identity stays at the existing dispatch seam. Native CLI used its configured gpt-6.1-sol/medium; no fallback or nested reviewer.

## Implemented evidence before code review

Production delta: only `locationBlockers`' outer candidate lookup now consumes `keysBy('fk_op_id', id)` synchronously, resolving one current target at a time. Existing per-message lookup, state/group/sequence filters and per-call cache are untouched. No wrapper/storage/layout/shared/SQL code changed.

Ordinary complexity RED: `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project unit packages/idb/src/ops-scale.test.ts -t 'early-blocked'`: 2 failed, 2 name-filtered; both actual 100002 vs expected 3 target reads on the eager implementation. Log `/tmp/terno-idb-scheduling-red.log`. This is the fail-first negative control, not a reproduced 10ms failure. Counts include 100000 candidate materializations + 2 per-message ownership rows; after fix 1 + 2 = 3. Existing fixture conditioning/effective timing budget multiplier remains unchanged (10ms, multiplier 1); access-count tests add no conditioning and are separate cases.

Pre-fix safety run: `... pnpm exec vitest run --project unit packages/idb/src/ops-scale.test.ts -t 'retained|checks both groups|claims in sequence|candidate admission'`: 12 passed, 1 failed, 4 filtered. The failure was an incorrect test expectation, not a product defect: a future queued predecessor blocks its successor but schedules its own wake at 1000. Corrected assertion. Log `/tmp/terno-idb-scheduling-controls.log` retained; no product claim from that failure.

Post-fix GREEN: same guarded NODE_OPTIONS, `pnpm exec vitest run --project unit packages/idb/src/ops-scale.test.ts packages/idb/src/imap-identity.test.ts`: 20 passed, no skipped tests (17 scheduler/scale + 3 existing fake-IDB identity abort/upgrade/concurrent-dispatch controls), default unit concurrency/config. Log `/tmp/terno-idb-scheduling-green.log`. Original timing case and 300000-settled history case preserved. The new state controls retain exact predecessor target rows; group/later-overlap control contains group mismatches and discriminates later-target overlap and refresh after predecessor settlement; it does not independently discriminate removal of each group filter (see review disposition). Admission controls use real Gmail kind metadata and a non-Google control; rejected candidates read zero targets. Ordering/limits/attempts include a predecessor claimed into running in the same pass.

`pnpm --filter @terno/idb typecheck`: passed; `/tmp/terno-idb-scheduling-types.log`. `pnpm exec oxlint --deny-warnings packages/idb/src/mail.ts packages/idb/src/ops-scale.test.ts`: passed. `git diff --check`: passed. All tests used synthetic data and external-network guard; no browsers, real profiles, new timers, warmups, forced GC, concurrency changes or quiet windows. Unit globalSetup is unchanged; it may compile its incoming-worker helper, not an app/package build request. No native IndexedDB/browser/WASM qualification or broad suites were run. Main remains not release-green.


## Sole completed Standards + Spec review and disposition

One native `codex exec -s read-only -C "$PWD" -` code review completed with exit 0, configured gpt-6.1-sol/medium, against base8d767888; no fallback/nested reviewer or second review. Full report: `/tmp/terno-idb-scheduling-code-review.log`, session `01a18cf2-3a55-76e1-bf5d-9face359ff01`.

- Standards: 0 findings.
- Spec: one P3 coverage finding at ops-scale.test.ts:106. The combined group/later-overlap case still blocks on message3 if either group filter is removed; settling the predecessor clears all blockers. Thus it discriminates later overlap/first-target-only errors and cache freshness, not independent nonblocking group isolation.
- Disposition: accepted lower-priority backlog under the explicit post-cap rule (only high correctness/data-loss changes after the single completed review). Future scope should add two independent nonblocking controls: predecessor location/candidate read, and predecessor read/candidate location, each asserting immediate readiness and claim; demonstrate failure by removing its corresponding filter. No production correctness/data-loss defect was reported. No review-driven source change or additional test run was made. This finding remains open, not silently waived or claimed fixed.

Exact existing timing fixture/cases were compared mechanically to base and are byte-identical (except the import adding vi). No retry of unchanged timing baseline. The fix addresses a demonstrated eager linear candidate materialization; it does not prove the precise cause of the prior 10.116625ms timing observation, guarantee timing under full-suite contention, make all scheduling constant-time, or qualify durable/native/browser behavior. Existing source-identity dispatch controls passed but exhaustive ownership/admission permutations are not claimed. Root retains serial rebase/retest/FF, documentation and cleanup ownership. No general release clearance.
