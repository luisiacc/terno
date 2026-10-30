# Release 5: IndexedDB expired Waiting folder reads

## Request

Own IndexedDB expired Waiting-folder fast path. Investigate the fifth full perf failure at `idb.perf.test.ts:192`: correct empty result, 0.273417 ms against the unchanged 0.25 ms cap. Establish a discriminating work witness before a minimal correction. Preserve Plan68, workload, timing policy, lifecycle fences, membership, identity, views, filters and kept rows.

## Existing behavior and design

Plan68's folder order already contains `(last_date, thread_id)`. The reader nevertheless fetches thread rows to seek the cursor and test expiration. The expired first page reads one thread; an expired deep page reads logarithmically many. The cold path still builds/selects from memberships. Public reads remain behind `early`/`settled` and closed-store checks.

Use the existing dated order to seek and stop before loading expired rows. Do not add a cache, schema, index, timer, transaction shortcut, or change the cold selection path. Kept IDs still pass account, membership, view and cursor predicates even outside the Waiting window. This removes provable redundant work; attribution of the archived timing failure depends on the unchanged baseline, not inference from a small overage.

## Validation and limits

Fail first on counted thread gets for expired first/cursor pages while counting membership iteration and IDB transactions separately. Verify inclusive cutoff, tied dates/IDs, account/folder isolation, keep IDs, read/star/trash, date/membership mutation and reopen/closed reads. Run precise direct callers, IDB types/lint and the actual original `idb.perf.test.ts`; no changes to its assertion or timing inputs. No UI or persistence contract change, so browser correctness is unnecessary unless implementation widens. No full suites, build, smoke, Plan64–68 edits or other-owner changes. All tests inherit NODE_OPTIONS plus the external network guard, synthetic data only. Finite process deadlines with captured PID/birth/argv and join/reap.

## Revisions after the Codex review

Native gpt-6.1-sol/high read-only critique completed with nine correctness/control points (no implementation defects claimed). Adopted explicit warm access witnesses, strict date/ID cursor comparison, unchanged keeps/keepIds handling, cutoff/tie/pagination and rollback controls. Shared cursor controls include ordinary and Unread pages. Keep cold selection and lifecycle fences untouched. Baseline: the original file passed all 10 tests; archived overage is unreplicated, and redundant thread access is an independent work defect. Review transcript: `/tmp/terno-idb-waiting-review/plan-review.log`.

## Evidence and qualification

All test commands below inherited `NODE_OPTIONS` with `--require=/tmp/terno-network-guard.cjs` appended. Each ran under `/tmp/terno-idb-waiting-review/run.py` with owned PID/birth/argv capture, finite deadline (120 seconds unit, 1800 seconds perf), and wait/reap. Review CLI deadlines were 600 seconds. No deadline expired or signal was needed.

- Unchanged baseline: `pnpm exec vitest run --project perf packages/idb/src/idb.perf.test.ts`: **10 passed**, 58.45 s. No numeric expired sample was printed by this run. This did not replicate the archive.
- Fail-first: `pnpm exec vitest run --project unit packages/idb/src/expired-waiting.test.ts`: **2 failed**, with 1 first-page and 7 cursor thread gets; both had zero membership key/row enumerations and zero IDB transactions. The initial behavioral control passed. Expanded controls still failed only those two work assertions before production edits.
- Focused: `pnpm exec vitest run --project unit packages/idb/src/expired-waiting.test.ts packages/idb/src/idb.conformance.test.ts -t 'expired|dated|shared dated|reopening|folders \(plan 68\)'`: **65 passed**, 602 unrelated tests deselected by the name filter, 2.88 s. No test skip annotations were added. Expired gets are now zero; live control confirms the spy sees qualifying-row reads. Includes tied cursors, null/expired Waiting facts, inclusive cutoff, next-window expiry, account/folder/kept identity, public read/star/trash, date change/rollback, membership removal, deleted anchor and reopen/closed controls.
- `pnpm --filter @terno/idb typecheck`: **pass** after fixing the test helper's inferred UUID parameter type. The first typecheck caught that test-only type error.
- `pnpm exec oxlint --deny-warnings packages/idb`: **pass**. `git diff --check`: **pass**.
- Post-change qualification, original public perf file and assertion unchanged: `pnpm exec vitest run --project perf packages/idb/src/idb.perf.test.ts`: **9 passed, 1 failed**, 60.72 s. Expired Waiting was correct/empty but **0.30808299999989686 ms > 0.25 ms**, line 192. No retries. This run overlapped the read-only production reviewer after focused green; no timing failure is waived on that basis.

The redundant-read correction is independently established, but the release gate is **not green** and the archived timing cause is **not established**. No new cache or lifecycle bypass is justified by these measurements. Full suites, builds, other perf files, e2e and browser checks were not run, as scoped. No UI or native IDB persistence contract changed. Logs: `/tmp/terno-idb-waiting-review/` (baseline, red, red-controls, focused, qualification, plan-review and production-review).

## Production review

Exactly one native `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only -C <this checkout> -` production Standards+Spec review, after implementation and focused green. Actual verdict: **approve; Standards PASS, 0 findings; Spec PASS, 0 findings**. No high correctness/data-loss findings or lower-priority backlog observations, so no review-driven implementation changes. It confirmed tuple seeking, date maintenance/rollback and unchanged keepIds/cold/lifecycle behavior. Limits: static read-only review, no independent tests; its final text said qualification was pending, while the separately completed qualification failed as recorded above. No second review or model fallback. Transcript: `/tmp/terno-idb-waiting-review/production-review.log`.

## Original-reader completion after f4839ace

Request: continue the same reader repair, keep it unlanded, profile the remaining public path, preserve all fences/semantics, and permit one original affected perf qualification only after a deterministic regression and new correction. The single production review is consumed; no further critique or production review was run. The following correction is regression-verified completion of the original performance contract, not independently re-reviewed.

### Separate diagnostic evidence

Temporary `waiting-path.diagnostic.test.ts` used synthetic seed 42, 28,400 threads / eight accounts / bodyScale 2, and the largest account's messages labeled in batches of 2,000. It called the actual public `threads.list` with an expired Waiting window. This is a diagnostic fixture, not the entire qualification sequence. It counted parameter reads, table resolutions, JSON serializations, order calls and native IDB transactions, with phase markers wrapping `early`, `read`, `settled`, the reader callback and `folderByDate`. Wrappers, spies, Proxy and the additional promise continuation perturb timings. None of these values establish the cause of the original 0.273417 or later 0.308083 ms failures; no failure is attributed to another process.

The first trace found an order still building (`null`), hence the cold selector's membership work. The cached trace explicitly completed/verified order construction outside the trace (diagnosis only). This distinction prevents confusing a cold selector with a validated cached empty result. Both traces and their source are preserved under `/tmp/terno-idb-waiting-review/`; the temporary diagnostic test was removed before qualification.

Cached path before this completion:

- `early -> read -> settled(inflight=false) -> reader -> folderByDate -> reader return -> public resolution`.
- 8,683 dated members; one scope-order validation; two table resolutions (`threads`, `folders`); one composite JSON key `[accountId, folder]`; **zero native IDB transactions**. No evidence that key computation dominates; it remains necessary to validate the listed folder.
- Four filter reads, two clock reads/cutoff calculations, one view read, one cursor read and two limit reads on the first-page path. The deterministic cursor regression observes 17 cursor property reads on its 64-member fixture.
- Instrumented elapsed boundaries (microseconds): public 294.250; settled 11.833; reader callback 104.500; order validation 4.833. These are boundary observations with instrumentation overhead, not independent costs to sum or timing qualification.

The empty result was still allocating `keeps` and cursor predicates plus a mapping callback and candidate array, and resolving a thread table it would never read. These allocations follow directly from executed source; no heap-byte attribution is claimed.

### Narrow correction and regression

After the existing folder-list check and `folderByDate` validation (including applying queued date/membership changes), if Waiting has no kept IDs and the validated order is empty or its newest date is **strictly below** the caller's cutoff, return a fresh empty page. By descending order and `waiting_since <= last_date`, no member can qualify, regardless of cursor or view. Equality does not return early. A building/invalidated order still takes the original cold selector. Kept IDs still use all the original predicates and merge; no empty-result cache is introduced. Defer resolving the threads table and constructing predicates until after this proof. Resolve the request's filter once in this reader.

Fail-first command (guard inherited): `pnpm exec vitest run --project unit packages/idb/src/expired-waiting.test.ts --reporter=verbose`, log `setup-red.log`: **2 failed, 7 passed**. It observed one threads-table resolution, one view read, and respectively 1/17 cursor reads, while requiring the existing order validation. The same assertions pass after the correction. Existing cutoff/ties, date mutation/rollback, membership/account identity, kept rows, deleted anchor, read/star/trash, reopen and closed controls remain. Two additional synthetic in-flight fence controls verify no order read before release and unusable-store rejection after release. They exercise the public read fence state, not a claim of native failure injection.

Cached diagnostic after correction (`phase-cached-after.log`): same 8,683-member order validation, one folder-table resolution, one composite key, zero IDB transactions, one filter and one clock read, **no view/cursor/limit reads**. Instrumented public 277.083 us; settled 11.625 us; reader 71.334 us; order 3.417 us. The measured `settled` boundary was an idle resolved promise, not a native transaction; it cannot safely be omitted because a write or uncertain outcome must be observed before even an empty read. The fence regression verifies this necessity. The correction removes the proven setup work; it does not bypass or rewrite `early/read/settled`.

### Completion validation

All test invocations append inherited `NODE_OPTIONS` with `--require=/tmp/terno-network-guard.cjs`; only synthetic mail/database names were used. The same captured PID/birth/argv deadline runner was used (180 seconds diagnostics; 120 seconds focused tests); all diagnostic and validation processes completed and were joined/reaped before original qualification. No reviewer is running and none was started again.

- `pnpm exec vitest run --project unit packages/idb/src/expired-waiting.test.ts packages/idb/src/idb.conformance.test.ts -t 'expired|dated|shared dated|reopening|folders \(plan 68\)|empty Waiting read'`: **69 passed**, 602 unrelated cases deselected, 3.17 s (`completion-focused.log`).
- `pnpm --filter @terno/idb typecheck`: **pass**.
- `pnpm exec oxlint --deny-warnings packages/idb`: **pass**.
- `git diff --check`: **pass**.
- Original full affected perf file on this new code: one run, results below. No workload, oracle, budget, window, warmup, sample, timing, delay, deadline or multiplier changed; no gate-local warming, skip annotations or unchanged retry.

Completion qualification: `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" python3 /tmp/terno-idb-waiting-review/run.py 1800 /tmp/terno-idb-waiting-review/completion-qualification.log pnpm exec vitest run --project perf packages/idb/src/idb.perf.test.ts`.

**9 passed, 1 failed**, 97.27 seconds. The original account-folder test, including the exact expired Waiting assertion at line 192, **passed**. Vitest did not print the successful test's numeric sample, so no specific new expired runtime is claimed. The file remains **RED** on `the unread filter's counts and select-all walks read the unread threads only: none in the view, a few, or a read crossing at a time`, line **375**, `count after a read`: **1.5087510064913658 ms > unchanged 1.5 ms**. This separate Unread scope-count failure is handed back unchanged; no noise attribution, timing waiver or retry. No broad release-green claim follows from the repaired Waiting assertion.

The qualification process completed and was joined (exit 1); no owned process remains running. Earlier baseline 10/10 and 0.308083/0.25 failure are historical evidence, not current passes. The original full perf file and its workload/assertions remain untouched. Only the same folder reader, its precise regression file and this spec changed. Main/Plan64–68, SQL/backend/frontend, workspace/dependencies and other-owner files were not edited. No build, other perf file, full suite, e2e, native browser test, smoke, new review, fetch/push or landing was performed.
