# Sixth release categorizer CPU correction

## Request and scope

Implement the release-six categorizer CPU/snapshot slice, prioritizing release-green over new report slices. Reproduce the unchanged current-source `packages/backend/src/categorize.perf.test.ts` once; preserve all budgets, inputs, samples, ordering, warmups, clocks, memory monitoring and snapshot semantics. Own only pure categorizer internals and localized tests. No public API/policy/schema, store, scheduling, UI, dependency or other owners' changes. Root owns serial integration and broader release qualification; the 153-row goal remains incomplete.

Prepared base: `7761321eb1e3db549024768b8d7a6cd50e75f04d` (matches requested base), initially clean. Historical `ae860a90`: score p95 87.458 µs > 50; snapshot-load p95 30.906166 ms > 30. Plans 02/03/26/38 and sixth inventory consulted read-only. Plan80/81/83 behavior and user licensing/package work remain untouched.

## Existing behavior and causal proposal

`packages/core/src/categorize/model.ts` creates a token-entry array and a parallel background-log array on each score. It computes `Math.log(alpha * bg + 0.1)` even for bg < 2. Both consumers of that logarithm are guarded by bg >= 2: the baseline contribution and its sparse-category subtraction. For bg < 2, supported category contributions use `statsAt` instead. Skip only the unused logarithm; preserve array ordering, every contribution, floating arithmetic order, score records, subset order, cache stamps, training and invalidation. Add no retained cache/memory or idle work. Snapshot bytes, parsing, validation, bounds and views remain unchanged.

Separate synthetic CPU profiles attribute score and load costs; they are diagnostic, never gate results. The current baseline passes the two historical target failures, so this is an independently demonstrated work reduction, not a claimed historical RED/GREEN repair. No snapshot optimization is proposed without a safe independently justified correction.

## Tests and qualification

Fail-first Math.log work regression exercises actual scoring with token bg 0 and 1, a category with sufficient support, unknown identities and no intents. Warm the legitimate per-group llr cache, then assert no unused background log. Full score records are checked, and histories cross the bg=2 boundary, remove background, train/untrain, drop categories and round-trip snapshots. Existing feature/model/policy direct tests remain required. No aggregate-only equivalence.

Run scoped core types, strict lint and direct correctness. After new causal source, run the exact original affected perf file once, without altering it. No full suites/build/smoke/UI. Append the inherited network guard to every test. Finite process supervisors capture owned identities; no name/port signaling or shared quiet window. One native gpt-6.1-sol/high read-only plan critique (≤12 points), then exactly one native gpt-6.1-sol/high Standards+Spec review only after coherent implementation and focused green; fix all findings with regression evidence. No second review.

## Revisions after the Codex review

Completed native gpt-6.1-sol/high read-only critique: seven points, all accepted. Use literal `bg < 2` skip, preserving NaN behavior accepted by the existing deserializer. Keep a parallel-array placeholder. Add interleaved [0,2,1,3] backgrounds plus background-only/absent tokens and support-one category. Include an unknown category in reordered subsets; check cold and warm results against full unchanged-source snapshots, including a NaN background snapshot. Assert zero warm logs for bg 0/1 and one for bg 2. Distinguish eliminated operations from latency attribution; no snapshot improvement claimed. Evidence: `/tmp/terno-release6-categorizer/plan-review.log`.

## Evidence and attribution

The one current-source baseline completed naturally: **13/13 GREEN**, multiplier 1. Score p50/p95 **29.542/34.417 µs**, end-to-end p95 **110.167 µs**. Snapshot-load p50/p95 **25.080/26.352 ms** (original internal batch 2); heap **25.344 MB**, snapshot **16.1 MB**, first loaded score **4.636 ms**. Original historical RED remains unreproduced; these observations do not waive it or identify its cause.

Separate diagnostic uses the original deterministic synthetic model construction (113,388 features, 10,000 backgrounds, 16,873,632 snapshot bytes, 457,541 UTF-16 header characters). Inspector profiles: 20,000 synthetic scores, 551 samples, score self 425, stats 13, statsAt 8, GC 4; 25 snapshot loads, 492 samples, deserialize self 416, GC 41. The sampled score loop allocates decoded feature views, token-entry/log/intent arrays and output records. The snapshot loader converts the UTF-16 header in 4,096-character chunks, parses JSON, creates one Entry object per feature, sparse typed-array views and 10,000 background views. Profile self time does not isolate individual logarithms or header conversion from map/view construction; no unsupported percentage speedup or snapshot correction is claimed. The bounded model heap is measured by the untouched original test, not inferred solely from object counts. The production fix adds zero retained state and leaves all allocations/layout unchanged.

The synthetic diagnostic overlapped the tail of baseline execution after both target cases had finished. The baseline's broader tail is reported honestly as an observed pass, not uncontended causal evidence. No shared quiet window was requested. Diagnostic source was archived outside the tree and removed before focused verification/qualification. No production instrumentation remains.

Fail-first: initial fixture mistakenly used the query sender for three backgrounds, correctly causing real identity evidence and failing its oracle; fixed fixture uses a different background sender. Refined unchanged-source run: **2 work regressions RED, 3 equivalence cases GREEN**, two full-record snapshots written from unchanged source. Work RED observed one unused `Math.log(0.1)` / `Math.log(0.2)` per warm score. Implementation uses `e.bg < 2 ? 0 : Math.log(...)`, preserving non-finite count behavior. Added bg=2 positive control, which requires one log; both low-background cases require zero. Changed-source focused run: **45/45 GREEN**, including all full-record references and threshold/train/untrain/drop/subset/round-trip controls. Core typecheck and strict lint of both touched TypeScript files pass.

### Commands and evidence

All test commands are launched with inherited `NODE_OPTIONS` plus `--require=/tmp/terno-network-guard.cjs` by `/tmp/terno-release6-categorizer/supervise.py`. Logs/JSON include argv, PID/birth identity, finite deadlines and exit status. Initial baseline/diagnostic supervisor version recorded PIDs/births but omitted per-process argv; later focused/review/qualification version records argv too. That initial lifecycle evidence limit is retained, not reconstructed. Test data is synthetic/temp; no real profiles/secrets accessed. Native incoming test worker setup ran normally; first pnpm invocation materialized cached dependencies (no manifest/lock edits).

- Baseline and sole post-change qualification: `pnpm exec vitest run --project perf packages/backend/src/categorize.perf.test.ts --reporter=verbose` (external cap 9,120 s, phase cap 720 s, declared native 600 s test/hook budgets untouched).
- Separate diagnostic: `pnpm exec vitest run --project unit packages/core/src/categorize/release6-diagnostic.test.ts --reporter=verbose` (temporary test removed; source retained in evidence directory).
- Refined fail-first: `pnpm exec vitest run --project unit packages/core/src/categorize/model-work.test.ts --reporter=verbose --update` (ordinary new reference snapshots only, never perf oracle).
- Focused: `pnpm exec vitest run --project unit packages/core/src/categorize/model-work.test.ts packages/core/src/categorize/model.test.ts packages/core/src/categorize/features.test.ts packages/core/src/categorize/policy.test.ts --reporter=verbose`.
- Types/lint: `pnpm --filter @terno/core typecheck`; `pnpm exec oxlint --deny-warnings packages/core/src/categorize/model.ts packages/core/src/categorize/model-work.test.ts` (same guard appended).
- Plan critique and sole implementation review: `codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -s read-only -C <checkout> -`, separate saved prompts/transcripts, no model fallback.

Evidence directory: `/tmp/terno-release6-categorizer/`, including baseline/qualification logs and reports, red/refined/focused logs, inspector profiles, diagnostic source, review prompts/transcripts, and process metadata. No full gates, e2e, UI, app build, dist, smoke, unrelated tests or benchmark edits. Root must integrate/retest serially; release-green and the wider 153-row goal remain incomplete.

## Sole Standards + Spec review and final qualification

Exactly one completed native **gpt-6.1-sol/high**, read-only Standards + Spec review: **Standards: none. Spec: none.** No review findings to fix or backlog; no second review/model fallback. Transcript `code-review.log`, prompt `code-review-prompt.txt`; native CLI exited 0 naturally. No source/test changes after that review.

Sole changed-source qualification: **13/13 GREEN**, exit 0, 74.79 s Vitest / 75.38 s external, no deadline fired. Multiplier 1. Score p50/p95 **31.000/38.292 µs**; end-to-end p95 **113.875 µs**; snapshot-load p50/p95 **25.574/26.831 ms** (first original internal batch); heap **25.340 MB**, snapshot **16.1 MB**, first loaded score **4.457 ms**. These are qualifying gate observations, **not measured speedup evidence**: scoring p95 is higher than baseline. No repeat run or posthoc noise waiver. Proven benefit is eliminated unused log work in the low-background case; there is no demonstrated end-to-end latency improvement and no snapshot-load fix.

Original benchmark bytes match prepared base exactly, SHA-256 `980ee9d5bb567cecaecade34f78c1b2ec2977bb6edfdeada8cd88ce53d9f463b`. Native oracle internal settling/retry batches remained untouched. Generic report ratio rows with budgetMs=0 show formatting crosses; original assertions and Vitest exit are authoritative (both import cases pass).

All supervised launches were reaped via their exec sessions; final birth-checked survivor audit records zero surviving captured processes. No process name/port signals. Initial supervisor omitted per-process argv, and it did not receive lifecycle reporter markers, so its effective whole-run cap was 720 s despite 9,120 s aggregate configuration; both perf files finished naturally under 83 s, so no test timeout was shortened in execution. Core types/lint ran directly to exit 0, without per-process supervisor metadata. These lifecycle evidence limitations remain explicit.

Final disposition: safe coherent pure-kernel correction with fail-first work evidence, exact output controls, focused green, unchanged full affected perf green, and one clean code review. Historical sixth-milestone CPU/snapshot failures remain unreproduced on prepared base, not causally closed. No snapshot source changes, broader interface dependency, release-green claim, or 153-row completion. Root owns rebase/retests/FF/docs cleanup; this branch has no pushes.


## Root integration

Rebased the complete reviewed series onto committed main `a8b8fba9` and fast-forward landed as `31affaa1`. Root reran the four exact correctness files (45/45), core typecheck, strict owned-file lint and whitespace check: all passed. The unchanged full categorizer performance file ran once after rebase: 13/13 passed in 79.88 seconds, with all downstream assertions reached. Snapshot load p95 was 26.55 ms against 30 ms; model heap remained 25.34 MB. Evidence: `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-root-categorizer6-dg8tdsde`, including guarded command/PID records and results.json. The supervisor session completed and was joined normally.

The sole native Sol/high review reported no Standards or Spec findings; Root made no source/test changes afterward. This removes independently demonstrated unused logarithms. It does not establish a latency improvement or a cause for the historical scoring/snapshot failures, which remain recorded. Full current-main release gates are pending; the wider report goal remains open.
