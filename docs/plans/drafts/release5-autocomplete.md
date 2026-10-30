# Release 5: autocomplete fit and runtime

## Request and scope
Own autocomplete UI/runtime cluster. Make release failures concrete without changing original fit/no-wrap or 10 MB paired/120 ms placement oracles. Preserve fitted acceptance, full document/HTML/autosave, native Undo/Redo, IME, focus and scroll. Plans18/16 and release4 latency/runtime evidence apply. Plans64–68, recipients, backend/store, grouping engine and other owners are read-only. No full suites/builds/push/landing.

## Evidence and proposed work
Milestone5 source193e705a fails macOS-design near-line fit (full phrase instead of ` you have`); lumen/atelier pass. Establish actual editor/block/caret/layer bounds before deciding fixture versus product. Original10 fails start paired 1.660/1.781 after existing toolbar-input reuse; previous isolated pass does not clear it. Trace actual on/off transactions/layout/work separately from qualification. Add ordinary fail-first regression at demonstrated seam, then minimal bounded fix; hand off a concrete interface conflict if outside ownership. Keep placement live and acceptance authoritative; never broaden metadata bypasses or slow off baseline.

## Validation
Only owned/direct-caller tests, scoped types/lint, full original autocomplete functional file and single exact original10 after causal runtime fix, source dev --no-deps at E2E_PORT57810 WEB_PORT57820/21. Original perf read-only. Synthetic providers/temp profiles and rejecting external browser proxy. All tests append inherited NODE_OPTIONS with --require=/tmp/terno-network-guard.cjs; finite native deadlines, captured PID/birth/argv, verified owned signals and joined root. UI changes require keyboard/axe and personally inspected light/dark captures; no new copy planned. One native sol/high read-only plan critique (<=12 points), exactly one production Standards+Spec review after implementation/focused green; findings fail-first; no second review. Source-dev evidence cannot certify production or full release-green.

## Revisions after the Codex review
Native sol/high read-only critique completed, nine points (/tmp/terno-r5-plan-review.log). Record actual geometry and explicit placement invalidations; acceptance/data controls use real views; distinguish metadata, edits, geometry and serialization before engine handoff; preserve no-layout mount barrier. Keep exact source/oracle and unreached checks explicit. Conditional tests follow changed seam.

Archived trace establishes fixture conflict: first paragraph stays empty while second becomes `Below.Let me know if`; width computed from BR instead of Text is invalid, root style retains only flex and layer stays 752px wide. Thus intended width never existed. Current diagnostic happens to navigate correctly (177.391px root, caret x753.703, then original exact-fit passes); it is not qualification or a product fix. Fix fixture caret deterministically and assert authored paragraphs before measuring.

## Implemented fixture correction and fail-first evidence
The archived actual release failure is a fixture geometry failure, not evidence of failed product trimming. Original native Up sometimes leaves the caret in paragraph two. Selection now explicitly collapses into paragraph one before native typing. Assertions require both exact authored paragraphs, actual post-layout room between widths of ` you have` and ` you have any`, original exact fitted ` you have`, original no-wrap bound, and both paragraphs after Tab. No product source, copy, budget, workload, or original perf oracle changed. An additional blocked-native-Up twin makes the archived navigation fault deterministic; removing the explicit collapse fails it.

Separate ordinary baseline regression replay (/tmp/terno-r5-fit-red-valid.log) blocks Up and runs the old navigation with the new paragraph precondition: FAIL, actual empty paragraph then `Below.Let me know if`. Same fixture replay with explicit collapse: PASS (/tmp/terno-r5-fit-green.log). This is controlled behavioral reproduction, not a timing qualification. Temporary replay source archived at /tmp/terno-r5-fit-regression.ts. Permanent blocked-Up twin is in the functional file.

## Runtime attribution and unresolved interface
Diagnostic source /tmp/terno-r5-diagnostic.ts (never qualification) profiles real native on/off typing on the existing 10 MB body. First capture: suggestions-on p50 21.8 ms; element geometry reads 298 / 3.4 ms; sampled placement 3.8 ms total. Expensive stacks remain `readDOMChange → dispatchTransaction → updateState → updateChildren → flattenSiblingGroups/restoreSiblingGroups/preMatch` in the existing read-only patched view dependency.

Second capture wraps public updateState and root reconciliation per actual transaction. ON: 16 edits, 16 reconciliations, 337.0 ms total; one metadata update 0.1 ms and zero reconciliations. OFF: 16 edits, 16 reconciliations, 315.9 ms total. Toolbar format probe is approximately 0–0.1 ms per key beyond initialization. Profiles /tmp/terno-r5-cpu-{true,false}.json and /tmp/terno-r5-transactions-valid.log. This rules out a metadata-root-reconciliation shortcut in this capture; it does NOT explain the historical 1.660/1.781 differential or establish a causal engine fix. Existing grouping loops traverse all root descriptors for every real edit, on both sides. Ownership conflict: changing those engine loops requires source handoff; bypassing required UI metadata or slowing OFF would be unjustified. No runtime fix claimed, no original10 source gate run because user requires a causal new runtime fix first. Historical full-run failure stays open, all later placement/positions remain unqualified. Parent must continue attribution or explicitly hand off engine work; this commit is only the safe fixture correction.

## Validation and runner corrections
All invocations below use /tmp/terno-ac-run.py, which appends inherited NODE_OPTIONS network guard, records actual PID/birth/argv and finite deadline and joins/reaps. All roots completed without deadline signals; test framework owns server/browser teardown. No real profiles or providers, no network beyond synthetic loopback. Browser launch rejects external traffic with loopback-only bypass. No builds/full suites/smoke/native dependency modifications.

Initial full functional run: 53 PASS / 1 FAIL (teardown ENOENT trace artifacts, not an assertion). I mistakenly started another runner with the same output directory while it ran; that launch failed on occupied port and cleared artifacts. Both results retained; not counted green. Temporary config now uses a unique process output directory; final run is serial, includes the new deterministic twin and real-room assertions. No unchanged retry for a measured timing failure.

Diagnostic setup failure /tmp/terno-r5-transactions.log: dynamic module URL discovery undefined; no measured transaction result. Corrected only instrumentation URL. First red launch /tmp/terno-r5-fit-red.log: occupied owned server; no tests. Valid red above runs after that server was joined.

Personally inspected /tmp/unica-scratch/autocomplete-18/ghost-macos-{light,dark}.png: readable, aligned ghost and authored text, calm controls; original per-theme axe/keyboard cases pass in first run. No shipped UI or new strings, so no catalog changes. Runtime/data implementation unchanged; full original functional cases cover native accept/undo, consume/dismiss, IME and settings. No new source types warrant package typecheck; scoped lint and whitespace pass. No full-run historical failure is waived.

Exact commands (all from this worktree):
```sh
python3 /tmp/terno-ac-run.py 300 /tmp/terno-r5-plan-review.log codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . '<plan critique prompt recorded in log>'
E2E_PORT=57810 WEB_PORT=57820 python3 /tmp/terno-ac-run.py 300 /tmp/terno-r5-diagnostic.log pnpm --filter @terno/web exec playwright test -c playwright.autocomplete-r5.config.ts --project=perf --no-deps e2e/autocomplete-diagnostic.dev.ts
E2E_PORT=57810 WEB_PORT=57820 python3 /tmp/terno-ac-run.py 300 /tmp/terno-r5-transactions-valid.log pnpm --filter @terno/web exec playwright test -c playwright.autocomplete-r5.config.ts --project=perf --no-deps e2e/autocomplete-diagnostic.dev.ts
E2E_PORT=57810 WEB_PORT=57820 python3 /tmp/terno-ac-run.py 180 /tmp/terno-r5-fit-red-valid.log pnpm --filter @terno/web exec playwright test -c playwright.autocomplete-r5.config.ts --project=e2e --no-deps e2e/autocomplete-r5.dev.ts
E2E_PORT=57810 WEB_PORT=57820 python3 /tmp/terno-ac-run.py 180 /tmp/terno-r5-fit-green.log pnpm --filter @terno/web exec playwright test -c playwright.autocomplete-r5.config.ts --project=e2e --no-deps e2e/autocomplete-r5.dev.ts
E2E_PORT=57810 WEB_PORT=57820 python3 /tmp/terno-ac-run.py 450 /tmp/terno-r5-functional-final.log pnpm --filter @terno/web exec playwright test -c playwright.autocomplete-r5.config.ts --project=e2e --project=e2e-lumen --project=e2e-atelier --no-deps e2e/autocomplete.spec.ts
python3 /tmp/terno-ac-run.py 120 /tmp/terno-r5-lint-final.log pnpm exec oxlint --deny-warnings apps/web/e2e/autocomplete.spec.ts
git diff --check
```
Source-only config retained at /tmp/terno-r5-playwright.config.ts after execution (original globalSetup, no deps, one worker, original base project settings, VITE_RENDER_PROBE source server 57810). Diagnostics/replay are removed from checkout after archival. No fetch/push/landing/main/worklist/other-owner changes.

Final qualification: **57 PASS, 0 FAIL**, 1.5 minutes, exit0 (/tmp/terno-r5-functional-final.log), full original autocomplete functional file plus blocked-Up twin in macOS/lumen/atelier. All exact fit/no-wrap, keyboard/native Undo, IME, settings, light/dark axe and captures passed. Scoped lint exit0; diff check exit0. Product runtime and original perf file byte unchanged. No unit test/typecheck invoked because only Playwright fixture and documentation changed; app tsconfig includes src only.

## Single production Standards + Spec review
Exactly one native gpt-6.1-sol/high read-only production review after actual fixture implementation and focused green; exit0. **Standards PASS (0 findings), Spec PASS (0 findings)**. Full prompt /tmp/terno-r5-review-prompt.txt, full result /tmp/terno-r5-production-review.log. No findings required fixes/backlog; no second review or fallback. Review changed no code. Reviewer inspected AGENTS, scoped plan/diff/context, ran no tests/builds/network, and explicitly limits approval to fixture correction, not unresolved runtime/exact10. At its evidence snapshot remaining design projects were pending; final independent run subsequently finished57/57 green. No production-build/full-release certification.

```sh
python3 /tmp/terno-ac-run.py 420 /tmp/terno-r5-production-review.log codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . - < /tmp/terno-r5-review-prompt.txt
```
