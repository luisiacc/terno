# Fifth provider-reliability release milestone

Announced 2026-10-30 after print Escape, autocomplete measurement, recipient paint and huge-suggestion runtime repairs landed. Run each required gate once, serially, on the recorded clean main: typecheck, lint, unit plus normal WASM, E2E, standalone Web, UI performance, backend performance, macOS build and fresh default packaged smoke. Preserve original workloads, thresholds, windows, samples, timeouts and existing skip policy. Report failures and not-run cases separately; no retries seeking green.

Use inherited network isolation, synthetic providers/temp profiles, distinct ports and captured owned process identities. Record stage source/index identities and fresh package hashes. Preserve earlier archives and restore preexisting generated outputs. Stop safely on source drift. No source edits during verification; repair failures afterward in isolated worktrees. Previous fourth-milestone passes apply only to their recorded source, and its interrupted/unrun stages remain unqualified.

## Actual result: four failures, all required gates completed

NOT RELEASE GREEN. All gates ran once at193e705a. Typecheck/lint,13,730combined unit+normalWASM tests(5existing skips),53Web tests, fresh ad-hoc macOS build and defaultsmoke64pass/7skip pass. E2E1543pass/1fail/7skip, UIperf62pass/1fail, backendperf274pass/2fail/1skip fail. Backendperf completed naturally in1822.5s; no required stage was NOTRUN. Fresh executable/app.asar hashes and skip limits are in `/tmp/terno-release-milestone5-d8__6urj/report.md`. Outputs restored without conflicts, zero live owned processes.

Exact failures:

- `e2e/autocomplete.spec.ts:376`: near-line-end fitted ghost expected` you have`, received` you have any questions.`
- `e2e/autocomplete-perf.spec.ts:189`:10MBstart paired typing median1.660 vscomputed1.163,tail1.781vs1.275; later positions/placement unreached in that test.
- `packages/idb/src/idb.perf.test.ts:192`:expired Waiting folder result empty but elapsed0.273417ms exceeds0.25ms.
- `packages/backend/src/load.perf.test.ts:228,263`:exclusive move5000threads×20categories/Undo recorded52mswall/6msCPU gap without a single-item command witness; attribution assertion failed.

Main advanced after completion/restoration to79ef813e, then05a6652f; current diff from tested193e705a is README-only. Preserve these user's documentation commits. Recorded gate identities remain193e705a; no old failure is waived or attributed to that post-run change. Next isolated repair owners: autocomplete fit+paired runtime, IDB expired Waiting-folder reader, and exclusive category-move/load-gap ownership. Original budgets, workloads and oracles remain unchanged. Broader report dispositions/counts and held feature backlog remain unchanged.
