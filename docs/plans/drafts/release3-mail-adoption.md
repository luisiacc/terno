# Release 3: mail adoption index

## Request

Own the mail adoption index slice of the provider-reliability release baseline: diagnose the original 25,000 late candidates plus 25,000 waiting gate (12.574917 ms against 10 ms, total cap 200 ms), preserve workload, matching, ownership and real yielding. Only mail source/tests; Plans 64–68 remain read-only. Root owns landing and release worklist.

> Own mail adoption index slice. packages/mail/src/adopt.perf.test.ts:76 '25,000 candidates added later, older than25,000 waiting in same bucket, merge in linear time' fails longest12.574917ms<10, original total200ms cap also retained. Inspect directly causal adoption index source and test plus plan references. Preserve25k+25k candidate workload/generator, oldest-first exact matching/take order, account/identity/signature semantics, candidate deletion/ownership and actual async yielding. Diagnose algorithmic allocation/sort/merge cost before minimal fix; no new warmup/GC, threshold/window/multiplier edits, dropping candidates, stale cache/global state or fake yield. Ordinary source/access/allocation regression should discriminate bounded/linear work independently while original timing gate remains unchanged. Native public API/direct caller tests and mail types/scoped lint, affected adopt perf FILE only. SQL lifecycle owner separate; don't edit db/idb/backend/store/RPC/shared types or frontend. Spec release3-mail-adoption.md; E2E_PORT57200 WEB_PORT57210 reserved (likely no UI). If original sample doesn't reproduce, classify honestly and avoid repeat-until-green; do not manufacture production claim. Complete coherent correction if bounded evidence supports one.

## Existing and evidence

Base `2885530e18e9667288a27c515dd7c6713bf2e2a6`. Release evidence: `docs/research/provider-reliability-release-milestone-3.md` and bounded adoption excerpt of `/tmp/terno-release-milestone3-p8jfaol3/07-perf.log`. Plan 68 R4/R5/R12–R14/R43 explains the index and sliced sorting. Waiting candidates already stay in separate sorted runs: no whole-bucket merge remains. `sortIds` nevertheless copies ordered input into a number list, sorts typed runs, allocates a second full typed buffer and merges them. Every add calls it, including already ordered 25k odd IDs.

The original unchanged adoption perf FILE ran once here: 6/6 PASS (5.71 s). The reported stall did NOT reproduce; this series does not claim its root cause or a release-green baseline. Independent avoidable sorting/merge allocation on ordered IDs is directly observable and safe to remove.

## Design

Detect nondecreasing order while copying the iterable, retaining the existing 5,000-item budget checks and real timer yields. After creating the owned typed result, return it directly for ordered input; otherwise retain existing sliced typed sorting/merge behavior. No cache, shared state, changes to envelopes, signatures, bucket insertion, claims or take. Duplicate IDs remain in sort output (add deduplicates); arbitrary order and generator inputs remain supported.

## Tests

Fail-first public API regression: ordered 25,000 IDs plus 25,000 waiting, detect typed sorting work with a restored spy, exhaust exact oldest-first results; verify duplicates, iterator-once inputs, and ordered input yielding with actual timers. Unordered permutation direct sort regression and cross-boundary add coverage retain fallback sorting and exact matching/ownership. Run changed-module and native mail direct caller tests, mail typecheck, exact-file strict lint; append inherited NODE_OPTIONS network guard for every test. Existing unit helper compilation unchanged.

## Perf

Run only `packages/mail/src/adopt.perf.test.ts` after correction. Leave it byte-for-byte unchanged: all sizes, inputs/generators, windows, warmups, samples, caps, thresholds and timeouts. No GC, skips, retries or conditioning. The optimization reduces ordered-input work to a linear copy/check and removes its merge destination allocation; unchanged unsorted path still uses budgeted sorting. Timing results are observations, not proof of the original intermittent failure's cause.

## Out of scope

SQL/IDB/backend/store/RPC/shared types, frontend/UI/copy, workgroup features, protected baseline file, full suites/builds/smoke, real profiles/secrets, fetching/pushing/landing. No release waiver. One completed native gpt-6.1-sol/high Standards+Spec code review only, after the plan critique.

## Revisions after the Codex review

Native read-only gpt-6.1-sol/high plan critique completed (six concrete points; `/tmp/terno-mail-adoption-review/plan-result.txt`). Preserve the post-typed-copy budget check on the ordered branch. Direct sort tests use deterministic budget clocks with real timers, including final partial chunks; they do not rely on add's own yields. Cover late single inversions at 5,000/16,384/final pair, duplicate IDs across slices, single traversal, owned typed storage, signature differences and claimed/drop behavior. Restrict performance claims to removed operations, not elapsed improvement or the original stall's cause.

Plan CLI startup inherited plugin configuration and logged an unsolicited marketplace clone timeout plus MCP auth errors. No repository fetch was requested or run by the implementation. Subsequent code review uses `--ignore-user-config` to avoid that startup side effect; model/provider/reasoning remain unchanged.

## Validation

All test commands append inherited `NODE_OPTIONS` with `--require=/tmp/terno-network-guard.cjs`. After initial pnpm local dependency linking (728 packages, zero downloads; unchanged helper compilation), subsequent commands disable dependency verification explicitly. Synthetic IDs/envelopes only; no application/profile/server launched, no signals or port operations.

- Baseline: `pnpm exec vitest run --project perf packages/mail/src/adopt.perf.test.ts`: exit 0, 6/6, 5.71 s. Original failure did not reproduce. No baseline retry.
- RED: `pnpm --config.verify-deps-before-run=false exec vitest run --project unit packages/mail/src/adopt.test.ts`: exit 1, 1 failed / 5 passed; expected typed sort not called, actual **2 calls**. `/tmp/terno-mail-adoption-review/red.log`.
- GREEN same module after fix and expanded semantic/budget coverage: exit 0, **9/9**, 402 ms. The ordered add makes **zero typed sort calls and one 25,000-element typed allocation** (previous code also allocated a full merge destination). `/tmp/terno-mail-adoption-review/green.log`.
- Unchanged adoption perf FILE after fix: exit 0, **6/6**, 4.60 s; both 200 ms total and 10 ms longest-stall assertions retained. `/tmp/terno-mail-adoption-review/perf-after.log`. Whole-file duration is not a paired latency claim. No retries or new conditioning; unchanged file diff against base is empty.
- `pnpm --config.verify-deps-before-run=false --filter @terno/mail typecheck`: exit 0. `/tmp/terno-mail-adoption-review/types.log`.
- `pnpm --config.verify-deps-before-run=false exec oxlint --deny-warnings packages/mail/src/adopt.ts packages/mail/src/adopt.test.ts`: exit 0. `/tmp/terno-mail-adoption-review/lint.log`.
- `git diff --check`: exit 0.

Scope is `sortIds` and its native public API/adoption caller in the same module tests; account/provider call sites are unchanged. No UI changes, so UI/e2e/screenshots are inapplicable. Full gates, builds, package/smoke, other perf files and root landing are deliberately not run. Release milestone failures (E2E, UI perf, four backend-perf assertions) remain recorded and unwaived; this slice does not establish release readiness.

## One code-review round and disposition

Exactly one native read-only **gpt-6.1-sol / high**, Standards+Spec round completed against base `2885530e18e9667288a27c515dd7c6713bf2e2a6`; output `/tmp/terno-mail-adoption-review/code-result.txt`. **No actionable Standards or Spec findings.** It confirmed unchanged perf file and preserved duplicates, single traversal, owned storage, budget/timer yields, fallback sorting, signatures, candidate order and claims/drop semantics. No follow-up review or model/provider fallback. No findings to fix or defer. Earlier plan critique was separate and all six points were incorporated before code review.

Final scope: seven added production lines, regression coverage and this draft spec only. Root performs serial rebase/recheck/FF landing, worklist docs and cleanup separately. No main/worklist edit, push or landing here.
