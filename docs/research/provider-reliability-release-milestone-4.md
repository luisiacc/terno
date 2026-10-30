# Fourth provider-reliability release milestone

Announced 2026-10-30 after supported huge-editor view grouping landed. Run all required gates once, serially, on the recorded clean main commit: typecheck, lint, unit plus WASM, E2E, standalone Web, UI performance, backend performance, macOS package and fresh default packaged smoke. Preserve native runner deadlines, workloads, budgets and existing skips; report failures and not-run cases separately. No retries seeking green.

Preserve earlier milestone logs and generated outputs. Use synthetic providers and temporary profiles only, the inherited network guard, distinct ports, captured owned process identities and fresh package hashes. Default native tracing and development overrides remain unset. No source/HEAD changes during this run. Root will record the actual result and repair remaining failures in isolated worktrees.

## Actual result: incomplete on source drift

NOT RELEASE GREEN. Initial clean main `ac4235f1`; main changed to `ec51bd3d` during UI performance. The runner stopped only its captured owned processes, restored preexisting generated outputs, and left source/index untouched. No remaining process, artifact restoration conflict or fresh package. No backend-perf, macOS-build or fresh-smoke result exists.

| Gate | Actual result |
| --- | --- |
| Offline setup, typecheck, lint | PASS |
| Unit and normal SQLite-WASM | PASS:11,863+1,840 tests;3+2 existing skips |
| E2E | FAIL:1,539 pass,1 fail,7 skips |
| Web | PASS:49 |
| UI performance | Incomplete:3 observed passes,2 completed failures; remaining counts unknown |
| Backend performance, macOS build, fresh packaged smoke | NOT RUN |

Print failure: `e2e/print.spec.ts:130`, print sheet remained after Escape when opened through the HTML-frame/palette path (expected0,actual1). UI perf completed two failures in `e2e/autocomplete-perf.spec.ts:166`:5MB start-suggestion latency352.7ms/120ms and10MB start typing paired gate false. The subsequent300-suggestion heap case was interrupted by source drift; its closed-channel artifacts are not a third established product failure. No timing/noise waiver, retry or root-cause attribution.

Complete logs, exact stage identities, cleanup and dependency checks: `/tmp/terno-release-milestone4-ofu_bc1t/report.md`. Next repairs use isolated current-main worktrees: print Escape/focus and autocomplete latency. The main update belongs to the user's diagnostics work and is preserved. No completed stage on the older commit qualifies the changed main; remaining full-release qualification stays open.


## Landed print repair

`435b550c` closes the frame-focused print Escape gap through the existing bridge. Root67unit+42browser cases/types/lint pass after local rebase, including the original path and pinned deferred-focus regression. One review finding on port configuration was regression-fixed; no second round. [Spec/evidence/limits](../plans/drafts/release4-print-escape.md). This does not complete the interrupted release milestone; autocomplete and remaining full gates stay open.
