# Release perf hang investigation

## Request and scope

Verbatim constraint: “Identify exactly which test/file/loop is CPU-bound, by read-only sources, reporter/order and finite targeted reproduction (NEVER full perf).”

Investigate the first release milestone's CPU-bound `pnpm test:perf` hang using read-only sources, reporter ordering and finite targeted reproduction; preserve timed payloads, 15 ms windows, assertions, count gates and default scheduling. Only a directly causal perf fixture/local helper correction is authorized. Production dependencies belong to the store/renderer owners. No full gates, builds, push, landing, worklist edits or Plans 64–68 changes.

## Specification

Identify the unfinished test and exact blocking loop before proposing a fix. An external supervisor must bound every potentially blocking reproduction and signal only captured owned PIDs. Every test inherits the existing network guard. A guard rejection is a fixture failure, never permission to contact a provider. A correction must expose an ordinary RED assertion and preserve the original GREEN workload; killing a child is not GREEN. If production is causal, document the exact source function and required contract instead of a workaround. Do not consume the sole code review on an incomplete diagnosis.

## Observations so far

Milestone `2ac77324`: `/tmp/terno-release-milestone-b8pxg8w6/07-perf.log` ends with Forward admission/refusal and attached-draft validation diagnostics, after one completed SQLite file (33 pass/1 fail). These diagnostics alone do not identify the running test. Cache order is dependent on prior results and file sizes; it is not alphabetical. Original counts remain incomplete.

Evidence directory: `/tmp/terno-perf-hang-evidence/`. `run.py` captures descendants using parent PID relationships, bounds runtime to 60 seconds, and samples only an owned busy child after 15 seconds. It appends the guard to existing NODE_OPTIONS. All initial targeted runs exit naturally: Forward 8 pass, import 3 pass, Gmail response 6 pass, Gmail control 4 pass, legacy resource model 3 pass, first load case 1 pass (4 filtered). Three-file Forward/import/control run: 15 pass. Paired ingestion finishes in 33.69s but fails its existing throughput assertion; that is a separate observation, not a hang or a correction. No inputs/budgets/scheduling were changed.

## Revisions after the Codex review

One native `codex exec -s read-only -C <this worktree> -` plan critique completed successfully (11 points); prompt and full transcript: `/tmp/terno-perf-hang-evidence/plan-prompt.txt` and `plan-review.log`. No nested reviewer or code review was started. All 11 concerns are accepted:

- Agent reporter suppresses successful modules and console logs; stderr is not a lifecycle trace. Cache values are older scheduling inputs, never milestone pass counts. The mixed known/unknown-file comparator depends on input enumeration and file sizes; a guessed prefix cannot prove the original order.
- Preserved artifact provenance matters. `/tmp/terno-release-milestone-b8pxg8w6/07-perf-test-results/perf/` contains db (05:09), import (05:10), load (05:15), facts (05:26), and categorize (05:28) reports dated Oct 30. The latter three contain complete stage measurements after the log tail. Reports precede teardown and are **not** pass verdicts. They invalidate inferring 29 minutes of execution inactivity from 29 minutes of log inactivity. The original 600-second-timeout observation alone also does not identify the active test: some cases explicitly allow 1,200–3,600 seconds.
- The load report includes all nine stages across its five cases; it is written after terminating its contention workers, before backend shutdown. High process CPU alone cannot identify a blocking loop, especially with intentional contention workers.
- Added an external lifecycle reporter for module/test/hook start/end. Kept it out of test bodies; no workload/scheduling changes. Later runs use candidate-specific external bounds and identity-checked PID signaling, bounded `ps`/`sample` commands, and descendant cleanup after wrapper exit. Those temporary diagnostic tools are **not** a tested repository supervisor fix. The initial 60-second prefix bound truncated legitimate progress and must not be called a reproduced hang.
- Inspected the rejection-only-livelock possibility in `backend.perf.test.ts`'s `while (!done)` probe. Its complete isolated file passes; no rejection-driven livelock was witnessed. Do not change production or that helper on this hypothesis.

## Final bounded observations

**No hang/root loop was reproduced, and no fixture or production correction is justified.** No test/helper source was edited. In particular, there is no evidence here connecting durable renderer Send acknowledgement to the milestone interruption. The sole code-review round remains unused as explicitly required for incomplete diagnosis without a fix.

Exact invocation prefix for the initial runs:

```sh
python3 /tmp/terno-perf-hang-evidence/run.py /tmp/terno-perf-hang-evidence/NAME pnpm exec vitest run --project perf FILE --reporter=verbose
```

`run.py` appends `--require=/tmp/terno-network-guard.cjs` to existing `NODE_OPTIONS` before spawning. Initial supervisor stdout (captured PIDs/status) is in this thread's tool transcript; logs/profiles are in the evidence directory. Results are observations on unchanged source, **not** a fail-first regression pair or qualification of a fix:

| NAME | FILE / extra arguments | Observed result |
| --- | --- | --- |
| forward-red | `apps/web/src/lib/attachment-admission.perf.test.ts` | 8 pass, 3.10s Vitest duration |
| import-red | `packages/backend/src/import.perf.test.ts` | 3 pass, 2.91s |
| gmail-red | `packages/mail/src/gmail-response.perf.test.ts` | 6 pass, 5.92s |
| control-red | `packages/mail/src/gmail-control.perf.test.ts` | 4 pass, 1.71s |
| resource-red | `apps/web/src/web/worker/legacy-op-storage.resource.perf.test.ts` | 3 pass, 1.93s |
| ingest-red | `packages/db/src/ingest.perf.test.ts` | 1 fail at line 93, paired throughput 0.8815008901 < 0.97, 33.69s; naturally finished |
| load-red | `packages/backend/src/load.perf.test.ts` plus `-t 'a scope mark-read'` | 1 pass, 4 filtered, 9.26s |
| prefix-red | `apps/web/src/lib/attachment-admission.perf.test.ts packages/backend/src/import.perf.test.ts packages/mail/src/gmail-control.perf.test.ts` | 15 pass, 6.45s |
| prefix-db | `packages/db/src/perf.perf.test.ts apps/web/src/lib/attachment-admission.perf.test.ts packages/backend/src/import.perf.test.ts` | Externally stopped at 61.08s; incomplete. Account-folder assertion failed (0 vs 1); Forward 3 MiB CPU gate failed (15.165 > 15). No unfinished pass count credited. |
| backend-red | `packages/backend/src/backend.perf.test.ts` | 2 pass, 16.94s |
| instant-red | `packages/db/src/instant.perf.test.ts` | 31 pass, 40.92s |
| categorize-red | `packages/backend/src/categorize.perf.test.ts` plus `-t 'worst case: every imported'` | 1 pass, 12 filtered, 30.13s |

The initial instant/categorization probes overlapped in time, as did part of the backend/prefix probes; treat their timing numbers accordingly, never as serial perf clearance. Existing GC calls/warmups in those files were preserved, with none added.

Final focused commands (serial):

```sh
python3 /tmp/terno-perf-hang-evidence/supervise.py /tmp/terno-perf-hang-evidence/categorize-full 180 pnpm exec vitest run --project perf packages/backend/src/categorize.perf.test.ts --reporter=verbose --reporter=/tmp/terno-perf-hang-evidence/lifecycle.mjs
python3 /tmp/terno-perf-hang-evidence/supervise.py /tmp/terno-perf-hang-evidence/backfill-first 90 pnpm exec vitest run --project perf packages/idb/src/backfill.perf.test.ts -t '1,000,000 messages' --reporter=verbose --reporter=/tmp/terno-perf-hang-evidence/lifecycle.mjs
```

`supervise.py` also appends the mandatory guard. Categorization: **12 pass / 1 fail**, exits naturally in 79.42s external / 78.68s Vitest; `classifying at import costs ≤ 10%` ratio 1.1093942905 > 1.1. Lifecycle confirms afterAll/module completion. Backfill: **1 pass / 8 filtered**, 3.78s Vitest, module completion. Separate `.json` metadata preserves argv, elapsed time, exit and identity-checked owned PIDs. No thresholds, windows, count gates, inputs or default scheduling were altered, and no repeated run was used to erase a failure.

## Boundaries and unresolved work

- **Unresolved:** the exact milestone active test/file/loop. The preserved log, cache and reports cannot supply a missing lifecycle trace or JS stack. No production dependency is proven, so there is no responsible function-level production fix to prescribe. Do not convert these exclusions into a guessed scheduler diagnosis. A future authorized run should target a source-supported remaining candidate with the external lifecycle reporter and bounded ownership supervisor; do not rerun the whole perf project.
- **Separate account-folder failure:** witnessed again in `packages/db/src/perf.perf.test.ts` navigation (0 memberships vs 1), log `prefix-db.log`. Relevant fixture assertion is `thread_folders` membership after the 5,000-message conversation location updates/relist. No shared cause with a hang established; leave to the storage owner. No production store/test or Plan 68 change made here.
- **Separate throughput failures:** ingestion ratio and categorization classification ratio remain RED. The Forward 15.165 ms sample remains a recorded failure too. They are not repaired by a supervisor, retries, GC or budget relaxation.
- The network guard only intercepts socket connect/global fetch, not timers/SQLite/CPU clocks. All listed probes inherited it and the isolated candidates finish; no guard rejection or pathological native fallback was observed in them. This does not prove an overhead bound across the entire unfinished project.
- No ordinary RED/GREEN correction, no completed Standards+Spec code review, and no release readiness claim. The instruction “Do not spend your review round on incomplete diagnosis if no fix” controls this disposition. This is an evidence-only handoff, not successful completion of the requested root-cause investigation.
- No full gates, application/package builds, UI changes, types/lint of untouched packages, worklist edits, main edits, push or landing. The only repository change is this draft. All test launches used synthetic fixtures and temporary stores/profiles.
