# Release 6 backend scheduling

## Request and boundaries

Assigned request: “make main release-green before new report slices”; “Attribute request/caller scheduling vs actual query time and validation yield/alloc phases before minimal fix.” Own only causal backend runtime/RPC/import/bulk-loop sources and precise tests. No children; native read-only sol/high critique and one post-implementation Standards+Spec review only if a coherent correction is justified. No test workload, oracle, budget, window, warmup, sample, delay, timeout or multiplier changes. No SQL/IDB/shared store/core contract/renderer/dependency edits, protected baseline access, production builds, full suites, fetch/push/landing or main/worklist edits.

Base: `7761321eb1e3db549024768b8d7a6cd50e75f04d`, matching expected main. Synthetic stores only. Every test appends inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs`.

## Existing paths and investigation

Historical source `ae860a90` failed: type-ahead RPC prefix `p` p95 19.595834ms versus 5ms; disconnected strict attachment draft validation stall17.808792ms versus15ms; controlled20k load action exceeded public300s deadline (native case600s). Those historical failures remain unwaived. The landed quote-converter correction does not run during strict validation.

Search handler yields before its query timer; RPC round-trip includes that admission turn and transport. Import validates draft schemas through runSliced before connected-account/attachment-content checks, quote conversion or writes. Bulk scope resolution uses ordered store pages, then runBudgeted across exact admitted IDs, with per-slice durable writes, notifications, yields and settle. Preserve latest-wins cancellation, fences, exact affected counts, order, Undo and durable effects.

Read: AGENTS.md, milestone6 inventory/report/log/lifecycle, plan03, plan29 and release2 adaptive-load investigation/qualification. Baseline qualification runs all three exact affected original perf files once, serially under their unchanged native allowances. Original full load file order is retained. Evidence directory `/tmp/terno-release6-backend/`; captured PID/birth/argv and joined exit status in baseline-process.json.

Potential diagnoses are kept separate from qualification: (1) pre-query scheduling versus query/transport work for RPC; (2) draft schema allocations/GC versus content validation for import; (3) fixed per-command costs and one-item recovery throughput versus actual store work for load. No inferred source fix or timing waiver is authorized by historical numbers alone.

## Correction and verification policy

After current-base reproduction, use a bounded separate CPU/allocation/phase diagnostic if needed. A baseline pass is an observation, not a root cause or repair. Source changes require an independent ordinary behavioral/work RED, a short scoped design and native sol/high read-only critique (at most12 points). Implement minimally, prove focused GREEN and join own verification before one affected original qualification. Preserve every downstream failure and unreached assertion. Consume the single code review only after coherent implementation and focused green; findings need fail-first regressions, with only high correctness/data-loss fixes after that cap and lower findings backlogged.

Only changed modules/direct callers' unit tests, backend types, exact-file lint and affected original perf files are permitted. UI/copy remains out of scope. Root owns integration and later release qualification; main and153-row goal remain incomplete.

## Current-base reproduction: PASS, no source correction justified

Exact command (launched once; original full load-file order retained):

```sh
NODE_OPTIONS="$NODE_OPTIONS --require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project perf packages/backend/src/backend.perf.test.ts packages/backend/src/import.perf.test.ts packages/backend/src/load.perf.test.ts
```

The Python supervisor appended the option without shell reinterpretation, captured child PID68337/birth/argv, waited with a3600s outer cap and reaped natural exit0. Total supervisor360.662s; Vitest351.24s. **3 files passed,10 tests passed, no failures/skips/notrun.** Source remained the committed base throughout. No retry, timing override, workload edit, quiet window or external signal. All three reports record multiplier1. pnpm automatically performed dependency verification/install and standard ensure-electron postinstall before the test command (7.4s); no explicit app/Vite production/dist build was invoked. Later invocations disable pnpm's redundant dependency verification only.

Evidence (archived copies, never read as replacement oracles):

- `/tmp/terno-release6-backend/baseline.log`: original stdout/stderr and terminal verdict.
- `baseline-process.json`: PID68337, birth Fri Oct30 20:16:43 2026, exact argv, start/end/exit0.
- `baseline-backend.json`, `baseline-import.json`, `baseline-load.json`: original post-measure reports copied from this checkout's test-results/perf. Reports supplement the terminal pass verdict; they do not independently establish it.

RPC: formerly failed `p` round trip p95 **0.822ms**, max0.951ms, budget5ms. Slowest current type-ahead p95 **2.870ms** (`pre`); all type-ahead strategy assertions completed. Counts p95 2.701ms and bootstrap2.706ms. Under import/filter load, list/search/open p95 **0.994/26.346/0.301ms**, respectively, all within original gates. These end-to-end observations do not separate transport/admission scheduling from query CPU; the earlier historical19.596ms cannot be attributed to a current source defect from this run.

Strict attachment validation: disconnected max stall **14.32ms**, connected **11.60ms**, original15ms budget; expected BAD_REQUEST and connected validation-complete rejection both held. These are pre-quote-validation results; do not attribute their passage to the landed quote converter. No allocation/GC/yield phase trace was collected and no phase-level cause is established.

Full load: **5/5 cases passed**, including all predecessors of the controlled restart. The public star operation returned successfully through its unchanged300s client contract (native test600s); no separate end-to-end action duration was retained. Exact result **total18,792, affected18,216**, matching independent message pre-state. Unique processed18,792, duplicates0; real uninjected prefix200 across33 slices, fresh controller20, first injected20 command78.380ms (78.029ms thread CPU,60.051ms separately measured3ms/item injection), first recovery3 command15.515ms, then1. Recovery18,570 slices; minimum actual injection3.002ms/item. Every original recovery/upper-bound/exception assertion ran, every target summary and message flag check passed, older stars preserved, Trash/Spam unchanged. Existing descheduling policy applied without edits (including a65ms wall/9ms CPU descheduled gap). This does not claim every raw wall gap is under50ms or natural growth to20. The one-item throughput hypothesis remains untested; no source defect/root cause is inferred or repaired.

There is **no ordinary new RED/GREEN regression pair**, no implementation change and no fix qualification. The current-base historical symptoms were **unreproduced in this single invocation**, not disproven. Historical sixth-milestone REDs remain unwaived; this isolated pass does not make main/release or the153-row goal complete. No unchanged-source timing rerun is justified. Separate bounded diagnostic instrumentation should be considered only when new causal evidence warrants it, rather than optimizing a currently passing path speculatively.

## Review accounting and handoff

One native read-only `gpt-6.1-sol`/high plan critique was requested over the scoped investigation and named evidence, at most12 points (`plan-prompt.txt`, `plan-review.log`, `plan-review.md`, `plan-review-process.json` under the evidence directory). The joined nine-point verdict and dispositions are recorded below. **No Standards+Spec implementation review was run:** there is no coherent source correction or focused behavioral RED/GREEN series to review. The sole implementation-review round remains unused; do not present a plan critique as a code-review PASS.

No source/tests/dependencies/UI changed. Consequently no unrelated unit/type/lint/build/e2e/smoke/full-suite/perf run is claimed or needed for this evidence-only draft. Protected baseline untouched; Plans64–68/main/worklist/other owners and live licensing WIP untouched. Root owns integration, future causal diagnosis and release qualification. Deliverable is concrete unreproduced evidence, not a proposed runtime repair.

### Revisions after the Codex review

Native plan critique completed once, PID44605, natural exit0 (53.900s), **9 points**, recommendation: evidence-only, historical failures unreproduced and unwaived. All nine dispositions:

1. Completed outcome now recorded above:3/3 files,10/10 tests,351.24s, exit0. Prospective correction steps remain conditional and were not executed.
2. Base/clean-source/guard/serial conditions are the implementing agent's recorded observations and supervisor construction, not independently captured fields in baseline-process.json. That artifact proves only captured PID/birth/argv/timestamps/exit. No stronger retroactive provenance claim and no rerun.
3. Exact `p` p95 **0.822375ms**,60 samples,multiplier1. No paired speedup or causal scheduling explanation.
4. Strict-validation log lines are unlabelled. The source's sequential `it.each([false,true])` maps first to disconnected and second to connected; this mapping comes from source/config inspection, not an explicit log label. The general-import report's **19.811792ms/50ms** is distinct and does not establish either strict15ms result.
5. Preserve actual exceptions: archive stage52.615625ms descheduled gap; slow stage78.629417ms gap overlapping the injected first command plus65ms/9ms CPU descheduled gap. All original classifications/limits remained. Passing terminal verdict does not mean all raw gaps below50ms.
6. No standalone elapsed measurement of the controlled public action was retained. The native case passed after awaiting public client.call and all its downstream state checks; source inspection confirms the client applies the existing method deadline. Thus successful return through that unchanged contract is observed, but an exact action duration, remaining headroom, repeatability or historical deadline clearance is **not** established. Historical timeout remains unwaived.
7. Path descriptions above are implementing-agent source observations. Admission/query/transport and validation-allocation/GC decomposition were not measured. All possible causes remain hypotheses.
8. Historical provenance: `docs/research/provider-reliability-release-milestone-6.md`, `/tmp/terno-release-milestone6-_epepvi4/report.md`, `07-perf.log` (RPC details1236ff; strict validation1286ff; failure stacks1547ff), and `07-perf-lifecycle.jsonl` at sourceae860a90. These are inherited source-specific evidence, not part of the new baseline artifacts and not proof of current failure.
9. Investigation stops at a single passing attempted reproduction. No source correction, regression RED/GREEN, performance improvement or release-green claim; no implementation review requested. No second critique/review/recheck or model fallback.

Both owned supervisor children were reaped normally; no signals sent and no running verification or reviewer remains. `git status` after qualification showed only this new draft. No tracked runtime, test or dependency diff exists.
