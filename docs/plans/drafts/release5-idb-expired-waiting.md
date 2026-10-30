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
