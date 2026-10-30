# Release 2 adaptive load fixture repair

Request: Repair only the slow-mid-job load case and directly causal slicer tests; distinguish unreachable injection from a controller fault, preserve 50k workload, real 3 ms/item cost, public commands, budgets and 600s timeout. One native Codex sol/high plan critique and one Standards+Spec review; no broad gates or production performance claim.

## Existing path and diagnosis

`load.perf.test.ts` → public `threads.actScope` → `handlers.ts` actOn → `core.ts` runBudgeted → `slicer.ts` SliceSizer → real store threads.act. Handlers/core are read-only. The original milestone log has no injection and 114955ms of execution; it proves only failure to reach the natural 20–50-item trigger. A slice pays real star transaction cost plus ×2 CPU and 2–8ms fixed injection. A 15ms controller need not grow to 20 on that path. The file currently seeds 20k, despite the requested 50k qualification.

## Design

First collect bounded command-size/cost diagnostics with the original trigger and ordinary assertion failure. Then use a test-local wrapper at runBudgeted to hand off, after a real prefix slice, to the real controller starting at 20 items. This explicitly controls the pre-slow state rather than claiming natural growth under load. Preserve target/floor/ceiling, scope/action, latency/CPU multiplier, workers, no added warmup/GC, and all existing upper limits. No production edits unless a separate ordinary RED identifies a controller bug.

Use a synthetic 50k mailbox for this case, preserve the other cases' existing dataset. Verify public scope count/result and public starred scope count before/after; count actual processed ids and require nonempty recovery slices. Report real injected milliseconds per item, CPU/wall/active measurements, prefix, first overrun, recovery sizes and final state. Ordinary RED must show unreachable injection; a fixed-size controller negative control must fail the recovery assertion.

## Qualification and scope

Only this file, slicer tests if needed, and this plan. Run selected case once for diagnosis with original 600s limit plus reserve, then entire affected load file once; direct slicer tests, backend types, exact-file strict lint. Every test appends the inherited network guard. No DB/IDB/store/core type or web edits, no real profiles or network. This fixture demonstrates an adaptive response to controlled load, not production performance.

## Revisions after the Codex review

Native `gpt-6.1-sol` / high read-only critique completed (9 points, evidence `/tmp/terno-adaptive-load-evidence/plan-review.md`). Accept all: explicitly label a restart (prefix history is not retained); prefix goes through original runBudgeted with yield/settle; require prefix4 then injected20, immediate half-size recovery and persistent measured injection. Use a new case-local 50k eligible mailbox, preserving the other four cases' 20k fixture; assert exact public total50k and unique coverage/no duplicates. Record injection separately from total CPU/wall. The ordinary RED only establishes natural-trigger unreachability on its observed run. The fixed-size mutation must fail the recovery assertion, not time out.

The recovery size assertion is also checked at the second injected store boundary so the fixed-size negative control fails promptly as an ordinary assertion through RPC, without spending the 50k job's full runtime. The positive qualification still requires complete public final-state checks. No production controller change is planned.

## Evidence so far

Base `02d5badc9e501899bbd8d2bd6e5bf19490ce95af`. Evidence directory `/tmp/terno-adaptive-load-evidence/`.

- Historical ordinary RED: original milestone `07-perf.log:1593–1600`, original trigger assertion `Infinity < Infinity` failed. Stage114955ms, no injected slice. No controller failure proven.
- Single original-trigger diagnostic on this checkout **passed**, not RED (232.44s total). `original-trigger-pass.json`: trigger22, first76ms, then4→17ms,2→10ms. Thus natural growth is reachable on this run; universal unreachability is not claimed. `original-red.log` is the preassigned filename, not a verdict. Snapshot `original-red.ts` is base plus console-only size/cost diagnostics, suppressed by this Vitest reporter.
- Native plan review completed once with sol/high; no child agents. Original diagnostic owned PID84611, birth Oct30 09:37:50; native critique PID83870 birth09:37:42. Both exited normally. Scoped backend base types and exact-file strict lint passed; lifecycle config is outside scope.

Fixed-size controller negative control: `slicer.ts`'s current assignment temporarily retained its current size instead of applying `next` (snapshot `slicer-fixed-size-mutant.ts`). Same controlled fixture (`controlled-red.ts`), public RPC and real store/injection failed in25.55s with `RpcError: the first recovery slice shrinks at least by half: expected20 to be less than or equal to10`. Seed/public scope50k assertion had already passed. Production slicer restored byte-for-byte before positive qualification; no controller edit remains. Owned PID5198, birth09:42:14, normal exit.

Positive qualification started once for the whole load file, owned PID5780 birth09:42:47, default600s case/hook limits retained. Direct slicer tests7/7 passed; `tsc -p packages/backend/tsconfig.json` and exact `oxlint --deny-warnings packages/backend/src/load.perf.test.ts` passed. Tests append inherited `NODE_OPTIONS` with `/tmp/terno-network-guard.cjs`. No overrides of load workers, perf multiplier, GC, warmup, or network policy.

## Single code review

Exactly one native read-only `gpt-6.1-sol` / high Standards+Spec review completed: Standards PASS0, Spec PASS0. No findings to fix or defer. Evidence `code-review.md`/`code-review.log`, owned PID6106 birth09:43:02, normal exit. No second review. Post-cap high correctness/data-loss issues would be fixed fail-first; lower findings would be handed to Root's backlog (none identified).

## Final disposition: NOT QUALIFIED — concrete public deadline dependency

The one full-file positive qualification **failed**:4 passed /1 failed,361.74s total. Adaptive case317.839s, ordinary `RpcError: The mail engine took too long to answer. Try again.` The public `threads.actScope` contract in `packages/core/src/rpc/contract.ts:576` explicitly sets300,000ms; `packages/core/src/rpc/client.ts:86` selects that method deadline before the client's default and rejects at expiry. This is earlier than the unchanged600,000ms test timeout. It is not a controller recovery assertion or test-timeout failure.

The 50k eligible public scope assertion and the immediate recovery boundary passed (otherwise the recorded RPC failure would have occurred there); the operation did not return before300s. Complete50k unique coverage, public affected/total/final starred state, measured full recovery/upper-bound checks and end-of-stage CPU/wall/injection report **remain unproven**. No GREEN is claimed for the candidate. Full failed log `load-file-green.log` retains its originally assigned filename; filename is not a verdict. Report `load-file-failed.json` contains only the eight completed stages of the other four cases, all passing. No rerun or polling until green.

The requested 50k real writes under the original load and public300s deadline expose a separate capacity/deadline dependency. A slower fixture cannot be made to pass by increasing the timeout, lowering work, suppressing the public command response, or waiving final state. Root must first decide/assign how a50k public scope action under this real injected load should satisfy the existing300s contract, or explicitly authorize a different qualification contract. This owner has no concrete production controller fault and no authorization for shared RPC/core/store changes; none were made.

The reviewed candidate is preserved at `/tmp/terno-adaptive-load-evidence/unqualified-candidate.ts` and `unqualified-candidate.patch` (base02d5badc9e501899bbd8d2bd6e5bf19490ce95af). It is **not landed or staged**. The named load source and slicer are restored to this worktree's original HEAD bytes; the committed deliverable is this diagnosis/handoff only. Owned full-file PID5780 exited normally; no signals, real profiles, secrets, external traffic, other-owner edits, broad gates, builds, fetch, push or landing. No background test/review remains. Root owns serial integration, retesting, main/worklist and cleanup.

The single code review's0/0 result describes the candidate's standards/spec construction; it does not override the subsequent failed runtime qualification. No second round, fallback model/provider or post-cap finding was introduced. Production performance is not established by these fixture observations.
