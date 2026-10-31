# Release 6: IDB navigation work bounds

## Request

Implement the assigned IDB private membership/scope/backfill/index-reader repair on current committed main; preserve Plan 83 hidden Inbox semantics, transactions and persistence. Original backfill.perf.test.ts and idb.perf.test.ts are read-only qualification oracles. No shared schema/core/store changes, dependency patches, production builds or broad suites.

## Base and historical evidence

Actual committed base: 7761321eb1e3db549024768b8d7a6cd50e75f04d (expected base). Sixth milestone tested ae860a90, not this base. Historical RED: million-message backfill 71.132 ms >16; 150k folder cold 32.769 >32, unread after changes 52.606 >32; twin cold 16.119 >16; empty unread folder .323 >.25; empty starred count 1.558 >1.5. The cold folder test also reported a later page at 35.2 >32, unreached after its first failure. Original current-base reproduction is running once, serially, with all assertions intact; outcomes will be recorded below.

## Investigation and proposed scope

`ScopeIndex.matching` discards its ascending filter IDs after more than 64 predicate crossings and then enumerates every thread, even when the filter's date order was just made current by a list read. This duplicates the same predicate scan for list then count, especially empty filters. Reuse an already ready filter order as the source of candidate IDs for rebuilding the ascending scope index; copy then sort numerically. If that order is not ready, retain the existing full-table path. Never force the date order to rebuild for a scope read. This is derived-index reuse, not a query-result cache; existing crossing invalidation, view/account/category/hidden predicates and read barriers stay.

Ordinary work-bound regression: prime the list's date order following bulk changes, then assert scope count/IDs do not enumerate the threads table; assert exact IDs and bounds. Exercise empty/sparse/dense, cold first scope without a ready list order, >64 invalidations, rollback, account/category/hidden changes, date ties/cursor and reopen. Existing folder/Waiting tests remain controls. No change to folder scan scheduling, backfill batches, twin envelope readers or simulator without separate demonstrated causality.

## Verification

Fail-first localized unit regression; implement minimally; run changed module tests/direct callers plus IDB package types and scoped lint. After coherent focused green run exactly one native gpt-6.1-sol/high read-only Standards+Spec review. Correct high correctness/data-loss findings with fail-first regressions; record lower post-cap backlog. Then qualify original two perf files once on causal new source, preserving failures and unreached assertions. Network guard appended to inherited NODE_OPTIONS on every test. Capture process PID/birth/argv, finite deadlines, join naturally. No real profiles or network.

## Out of scope and limits

No release-green or 153-row completion claim. Historical timing failures are not waived by current passes. A passing baseline does not establish an application cause; the ordinary redundant-enumeration regression is required independently before source changes. No edits to plans 64–68 or main/worklist; no fetch, push or land.

## Revisions after the Codex review

Native read-only plan critique (`gpt-6.1-sol`, high), `/tmp/terno-release6-idb/plan-review.log`, returned eight points. Reuse calls `current` only after checking `ready` (which permits up to 64 pending updates). Cover both first construction and >64 invalidation, exactly64 incremental control, built-but-unready fallback without invoking date rebuilding, global predicate membership independent of restricted pages/hidden categories, copied source order and tied cursors, 50k candidate bounds, and durable enqueue failure with both indexes warm followed by reopen. Folder/category/Waiting/sidebar paths remain independent controls.

Current-base baseline: `pnpm exec vitest run --project perf packages/idb/src/backfill.perf.test.ts packages/idb/src/idb.perf.test.ts`: PASS, 2 files /20 tests, 135.85s. `/tmp/terno-release6-idb/baseline.log`; owned PID68277 naturally joined (exit0). pnpm automatically materialized the frozen dependency installation on first invocation; no dependency/source/lock changes. Historical timing REDs are unreproduced here, not fixed or waived.

Independent RED: `pnpm exec vitest run --project unit packages/idb/src/scope-index-reuse.test.ts`: 4 failed /1 passed; all four predicate cases fail the zero-enumeration bound because `threads.all()` is called once after a ready filtered list. `/tmp/terno-release6-idb/red.log`. No source edits existed at RED.

## Implementation and focused verification

`ScopeIndex.matching` now copies a ready filter date order's global IDs before sorting ascending; unready orders use the original table enumeration. No extra cache, persistence/scheduling/query changes. Regression suite also includes a50k dense candidate bound and built-but-unready fallback without forcing `current`, exactly64 crossings, small pending changes, synchronous rollback and durable enqueue abort/reopen. Focused green:58 tests across scope-index-reuse, idb.store, expired-waiting and idb.persistence; `/tmp/terno-release6-idb/focused-final.log`. IDB types and scoped oxlint pass. Initial types caught the test helper's UUID-inferred parameter and was corrected to string (`types.log`, then `types-final.log`). All owned verification processes joined. This change addresses independently demonstrated redundant scope work; it does not claim to fix any historical backfill/folder/twin timing failure.

## Single final code review and dispositions

Native `codex exec -m gpt-6.1-sol -c model_reasoning_effort=\"high\" -s read-only` final Standards+Spec review ran once after focused green; `/tmp/terno-release6-idb/code-review.log`, process19538 naturally joined exit0. Verdict: Standards PASS; Spec FAIL, two P2 regression coverage gaps; no production correctness defect found. No second review or model fallback.

Per the user's post-cap rule (high correctness/data-loss fixes only; lower findings backlogged), both P2 items remain explicitly open:

- First ascending scope construction from a warm date order with <=64 pending membership updates needs an explicit bounded-read test. Current small-update test takes the existing incremental scope branch, not the new reuse branch.
- The tied-cursor test uses `.every()` and can accept an empty next page. Add exact list and next-page IDs before/after ascending scope construction to detect accidental sorting of the shared date array in place.

Neither is represented as resolved or as a clean Spec verdict. No production or test changes after review. The source copies the array and calls `current` after checking readiness, as inspected by the reviewer. Review also confirmed global membership, downstream hidden/account/category predicates, rollback notifications, and unready fallback.

## Final original qualification and handoff

After focused checks and the single review were joined, ran exactly once on new source:

`pnpm exec vitest run --project perf packages/idb/src/backfill.perf.test.ts packages/idb/src/idb.perf.test.ts`

PASS:2 files,20 tests, all original assertions retained; `/tmp/terno-release6-idb/qualification.log` and `qualification.json` contain result/argv/PID/birth/deadline supervision metadata. PID23430 naturally exited0 and was joined. No failures, skips or unreached checks in this scoped run. Both oracle files and dependency/workspace/lock files are unchanged. Historical six failures (plus the historically unreached later-page assertion) remain historical/unreproduced; no root-cause claim for them. No qualification retry, quiet window, timing adjustment or displaced measured work.

Exact focused commands (each test appended inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs`):

- RED: `pnpm exec vitest run --project unit packages/idb/src/scope-index-reuse.test.ts` (4 failed /1 passed on original source).
- GREEN: `pnpm exec vitest run --project unit packages/idb/src/scope-index-reuse.test.ts packages/idb/src/idb.store.test.ts packages/idb/src/expired-waiting.test.ts packages/idb/src/idb.persistence.test.ts` (58 passed; focused-final.log). Earlier focused pass was repeated only after the type helper correction and hidden-toggle assertion addition.
- `pnpm --filter @terno/idb typecheck` (PASS after fixing test-only UUID-inferred helper parameter; types-final.log).
- `pnpm exec oxlint --deny-warnings packages/idb/src/mail.ts packages/idb/src/scope-index-reuse.test.ts` (PASS, lint-final.log).
- `git diff --check` (PASS).

No UI/copy, schema, persistence contract, shared store/core, SQL or backend source changed. No full suites, app builds, e2e, native smoke or browser parity run; none authorized/needed for this private derived-index reuse. No secrets/real profiles, external requests, children, fetch/push/land or process signals. Native read-only plan critique and final code review were the only Codex subprocesses. All owned processes naturally joined; no teardown signal required. Review Spec remains FAIL with the two explicit P2 backlog items above; main release-green and153-row goal remain incomplete. Root retains serial integration and broader qualification responsibility.

## Root first-review corrections — 2026-10-30

The two P2 findings belonged to the allowed first review and require correction; they are not post-cap new findings. Their earlier backlog disposition is superseded. Root added four first-construction cases (unread/people/attachments/starred): warm the date order, leave8membership crossings plus a date change pending while ready stays true, then construct a fresh ascending scope. Exact membership, current() call,0table scans and≤64thread gets are asserted. Root also replaces the vacuous every() pagination check with exact nonempty first/next page IDs and full page equality before/after fresh ascending-index construction, including reopen.

11/11localized tests pass with the implementation. A stale-current inverse fails all4new pending cases; a no-copy/in-place-sort inverse fails the exact next-page test. These are controlled oracle REDs, not new product defects. Both experiments restored production/test bytes exactly before verification. Evidence `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/` under the path recorded in `/tmp/terno-root-idb6-current` (inverse logs/results). No second native review; the actual R1 verdict remains Standards PASS/Spec FAIL with both requested test gaps now regression-verified corrected.
