# Release categorization throughput investigation

## Request and scope

“Investigate existing categorization throughput failure: packages/backend/src/categorize.perf.test.ts 'classifying at import costs ≤ 10%' ratio1.1093942905>1.1 in /tmp/terno-perf-hang-evidence/categorize-full*.”

“New main ingestion may change ratio; run affected perf FILE ONCE on current candidate, record if original failure doesn't reproduce. Do not invent production bug if baseline passes.”

Ownership starts with `packages/backend/src/categorize.perf.test.ts`. No production or direct-test edits are proposed; name directly causal files before any such change. Baseline HEAD is `5ff1e8c4462b61f2b7758636ce3f3eb60d26525c`, containing ingestion dependency `e43b611df1085a4bf032a43cefe655a16036313e`.

## Existing behavior and design

The original full-file observation was 12 pass / 1 fail, naturally completed; it did not reproduce a hang. `importAB` compares process CPU for three off/auto pairs against independent copies of the same seeded mailbox, scoring with the real persisted model. The ratio is minimum auto CPU / minimum off CPU, with >50 decisions required; worst-case inbox import has two pairs and >1,000 decisions. Preserve payloads, classifier, mailbox sizes, rounds, warmups, work, assertions, event-loop windows, budgets and multiplier. Add no GC or conditioning. No wall/CPU criterion change.

Run that unchanged full file once with the mandatory appended network guard and an owned-PID external supervisor. Respect each declared 600-second test/hook allowance plus a finite setup reserve. Preserve logs, lifecycle and report evidence. If the failure reproduces, use separate bounded SQL/time/CPU diagnostics before considering a failing regression and minimal in-scope correction. If it passes, document source-supported dependency relevance and attribution limits; do not retry or invent a fix.

## Validation, performance and exclusions

The affected perf file is the sole qualification run. No full suite, builds, browser, real profiles, external traffic, shared hot-module edits, settings/content logging, pushes or landing. Evidence-only changes require no production code review or untouched-package checks. Any actual code fix requires a fail-first regression, targeted direct tests, package typecheck, scoped strict lint and exactly one completed native read-only Standards+Spec review. No gate relaxation.

## Revisions after the Codex review

Completed below; seven concrete points.

Native plan critique completed with seven points; transcript `/tmp/terno-categorize-throughput/plan-review.log`. Accepted clarifications: no benchmark source append; guard is appended to inherited NODE_OPTIONS as `--require=/tmp/terno-network-guard.cjs`, loaded before static imports and inherited by test children. It blocks non-loopback Socket.connect and global fetch; it is not a universal DNS/UDP security sandbox. Violations throw and are failures, never permission for traffic. Existing GC/internal retries remain unchanged. Hash/byte identity is recorded before/after. No budget environment overrides.

Temporary supervisor `/tmp/terno-categorize-throughput/supervise.py` captures descendant PIDs by parent relationship and birth identity, uses identity checks before signals, and reaps its launcher. Each test/hook lifecycle start gets 600 seconds plus a 120-second finite reserve; aggregate cap 9,120 seconds (13 tests + two hooks + startup/exit reserve). TERM grace 3 seconds, then KILL only if needed; no delayed watchdog remains after natural exit. This temporary diagnostic supervisor is not shipped or independently qualified. Lifecycle reporter is external and does not modify timed code. Report freshness and natural completion are checked separately; generic budget-zero report crosses do not determine ratio verdicts.

Exact sole qualification command:

```sh
python3 /tmp/terno-categorize-throughput/supervise.py /tmp/terno-categorize-throughput/baseline 9120 pnpm exec vitest run --project perf packages/backend/src/categorize.perf.test.ts --reporter=verbose --reporter=/tmp/terno-perf-hang-evidence/lifecycle.mjs
```

Record assertion/setup/deadline/exit failure distinctly; no automatic rerun. The project's existing globalSetup prepares its incoming test worker; no app/package/Vite production build is invoked.

## Source support and attribution boundaries

Read-only causal call-path inspection additionally used explicit files `packages/backend/src/core.ts`, `packages/db/src/index.ts`, `packages/db/src/portable.ts`, `packages/db/src/sql-store.ts` and `packages/db/src/categorize.ts`; none is proposed for editing. `BackendCore.ingestSliced` (`core.ts:764`) starts slices at 50 and calls `store.sync.ingest` with the real classifier. `SqlMailStore.sync.ingest` (`sql-store.ts:425`) calls `ingestMessages` then filters and `classifyNewThreads` inside one transaction. Thus the changed ingestion SQL is shared by both measured modes. `classifyNewThreads` (`categorize.ts:968`) returns immediately in off mode; auto mode batches changed-message/thread and eligibility reads, skips old roots before reading bodies/scoring, and returns committed deltas. `Categorizer.noteBackfill` (`categorizer.ts:102`) defers old-mail background rebuilding until import settles. These are source-supported paths, not a newly diagnosed defect.

The dependency `e43b611d` batches qualifying new body writes (<=200-message batches, <=32 bodies per write) and reverse-reference writes (<=128 tuples), preserving read visibility via flush boundaries. That is relevant to this import's new server identities; actual fast-path coverage was not instrumented in the qualification run. An optimization of common ingestion can change the ratio in either direction. Existing ingestion-owner SQL diagnostics are described in `release-ingest-throughput.md`; they use a different workload and do not quantitatively attribute this categorization ratio. No comparison of that ingestion throughput ratio to this CPU ratio is valid.

The unchanged CPU measurement wraps `b.ingestSliced(extra)` only, excludes setup/stop, and includes process/worker CPU plus any within-process incidental work. Snapshot readiness and actual decision-count assertions remain in place. Minimums are taken independently across off and auto samples; no paired causal estimate or variance interval is emitted. One post-dependency observation cannot establish the original failure's root cause or reproducibility rate. Separate instrumentation, cold/pre-dependency controls and repeated unchanged runs are deliberately not substituted for the sole gate.

## Sole candidate result and disposition

**Original failure UNREPRODUCED on `5ff1e8c4462b61f2b7758636ce3f3eb60d26525c`; unchanged affected file GREEN, 13/13.** The one full-file invocation above exited naturally with code 0 in 78.04 seconds external / 72.81 seconds Vitest. Lifecycle log confirms afterAll and module completion. Multiplier **1**. No filtered cases, skipped assertions, workload edits, added conditioning/GC, or repeat qualification runs.

- Normal synced import: **1.0436242585028335 <= 1.1**, 14,027 messages, minimum off CPU **3.31 s**, minimum auto CPU **3.45 s** (report-rounded), **589 decisions > 50**, three rounds.
- Worst-case new inbox import: **1.3371374668963565 <= 1.5**, same 14,027 messages, minimum off CPU **3.11 s**, minimum auto CPU **4.16 s** (report-rounded), **5,235 decisions > 1,000**, two rounds.
- Prior observed **1.1093942905 > 1.1** remains recorded in the original hang draft/evidence. It is not waived or relabeled as GREEN. This is a later candidate containing a landed dependency, not a RED/GREEN fix pair authored here.

Evidence: `/tmp/terno-categorize-throughput/baseline.log`, `baseline.json` (argv, exit, owned PID/birth identities, lifecycle phase timing, finite limits), `categorize.json` (fresh archived report), `before.json`, `after.json` (source hash/freshness), `supervise.py`, `plan-prompt.txt`, `plan-review.log`. Original benchmark SHA-256 before/after **538fc979217328aa199b4e5dc932aa31d3f186b63a587456eba30164b0b1026d**, **29,932 bytes**. Git also shows no benchmark diff. No profiler/SQL instrumentation was added to the sole qualification run. Report `budgetMs: 0` crosses are generic formatting, not failed ratio assertions; runner outcome is authoritative.

The first pnpm invocation automatically materialized dependencies from its local content-addressable cache (**728 reused, 0 downloaded**) and ran the existing ensure-electron postinstall. No production build command was issued. The test's normal incoming-worker globalSetup remained intact. Network guard was inherited throughout. No real profile, provider settings, tokens or content were logged.

No actual categorization defect reproduced, so no production or test fix, speculative SQL rewrite, extra diagnostic test or production code review is justified. Review usage: **one completed native read-only plan critique (seven points); zero Standards+Spec code-review rounds**, as authorized for evidence-only work. The plan critique used the CLI's default gpt-6.1-sol/medium; the requested high-effort code review was not needed or consumed. `git diff --check` passes. Untouched-package types/lint, full gates, production builds, browser, push and landing were not run.

Root retains serial integration/retest/landing. This single post-dependency native-SQL observation does not qualify SQLite-WASM, IDB, web pendingSend, desktop smoke, release-wide performance, noise distribution or a causal explanation for the earlier ratio. No concrete shared-interface defect or dependency handoff is established. The evidence-only handoff is complete; release-green baseline beyond this affected file remains Root's responsibility.
