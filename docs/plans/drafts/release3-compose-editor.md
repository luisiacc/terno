# Release 3: compose focus and huge editor

## Request
Own remaining frontend cluster: repair the rapid Reply/Escape collapse failure and the original 2 MB short-line typing gate. Preserve latest user intent, authored content, ACKs, selection, focus, scroll, native early typing and Undo. Held displayed-stored-open P2 in compose.ts is out of scope.

## Existing
Base 2885530e. Original release logs: atelier rapid reply ends without draft-collapsed; huge draft transaction p95 25.7 ms passes30, frame p50 101.5 ms fails50. Deferred editor, native early-input receiver and pending focus move have separate ownership; huge paragraphs use content-visibility. Relevant plans16 (huge drafts/editor),29 (attachment ownership),43 (focus intent),54 (Tab-only rings).

## Design
First reproduce each exact browser case once with source-only dev config and blocked external network. Inspect original trace and separately attribute CPU/layout/allocation for the unchanged workload. Add fail-first regressions at the actual causal focus/editor seam before minimal changes. Do not impose blanket focus delays or change save cadence, debounce or measured work. Keep production ownership within directly causal frontend modules; no backend/store/db/idb/mail edits.

## Tests
Native read-only Sol/high plan critique (<=12 concrete points), then ordinary regression RED/GREEN; one completed Sol/high Standards+Spec code review for the coherent series. Direct module/caller unit tests, web types, scoped strict lint, original atelier case and original huge draft perf case only, plus direct early-input/reveal/focus controls. Inspect light/dark captures and composer axe. Every test inherits NODE_OPTIONS plus /tmp/terno-network-guard.cjs. Ports57140/57150; synthetic temp profiles only. Original unit globalSetup compilation unchanged.

## Perf
Preserve exact original2 MB generator, actual text count, keystroke input/delays,50ms frame p50,30ms transaction p95, serialization/one-save, toolbar, DOM and indent assertions, multiplier and timeouts. Attribution is separate from qualification. No unchanged reruns seeking green or quiet windows. Source-only runs cannot certify production compilation parity; preserve full gate failures.

## Out of scope
Plans64–68; held stored-open issue; other workers' slices; full gates, builds, packaging, push/landing, new workgroup features. Root owns serial landing and worklist.

## Revisions after the Codex review
Native read-only gpt-6.1-sol/high plan critique completed DONE,10 points (`/tmp/terno-release3-compose-editor/plan-review.log`). Pin trusted Escape to the published/bound focus interval; retain pre-source Escape, focus/navigation, reentrant and lazy stand-in controls. Preserve both handoff implementations and run their direct tests; no cold-chunk/Undo architecture rewrite in this repair. Keep initial huge-layout regression and record post-frame assertions unreached on perf failure. Profile after-transaction work separately, use explicit ports/--no-deps, archive fixed perf report, assert shortcut versus Tab focus behavior. Additional cold chunk composition and held real ACK qualification remain limits unless directly exercised.

Both original source-only baselines passed once (focus1/1; huge frame49.4ms, transaction23.1ms p95, autosave29.4ms, toolbar1.3ms p95, indent1313ms). No original RED claim. Pinned publication-before-focus Escape reproduces missing collapsed draft2/2 light/dark. Scope the correction to that ready target interval; existing pre-admission Escape cancels remain unchanged. No independent performance defect is established yet.

## Implementation and attribution
The early receiver now yields Escape only when its destination is published and the pending target is ready; the existing key-during-move handoff accepts its still-valid armed destination even when the initiating collapsed button remains active. It completes ownership checks, transfers native text/selection and replays Escape through the composer. Other focus targets still supersede the lease. Pinned light/dark RED2/2 missing draft-collapsed; GREEN2/2 collapsed with exact Rápido. Strengthened controls add durable saved bytes, native Undo/Redo and Tab versus shortcut ring checks.

Separate instrumentation (not qualification) copied the unchanged workload and sampled CDP CPU/heap/timeline around original typing. First diagnostic erroneously inherited Playwright tracing:50.7ms frame failure, with CPU visitNode snapshot overhead. Corrected diagnostic explicitly disables Playwright trace/device scale2; frame53ms failure under CDP profiling, later serialization/toolbar/indent assertions unreached. Timeline totals across typing: intersection observers368.29ms, layout118.89ms, native TypingCommand281.18ms (nested totals are not additive). CPU dominated browser native/program samples; JS includes React development work, PM position lookups and DOM parsing. Sampled allocation includes JSX232292B, React hooks196800B, slice140920B; no independent per-key whole-body serialization demonstrated. Artifacts cpu.json/heap.json/timeline.json and diagnostic source/logs in /tmp/terno-release3-compose-editor. No production editor change or performance RED→GREEN claim; original release101.5ms remains recorded, not waived. Baseline source-only49.4ms is near the gate and does not certify a production gate.

## Targeted checks before code review disposition
All test commands prepend inherited `NODE_OPTIONS` with `--require=/tmp/terno-network-guard.cjs`; browser commands set E2E_PORT57140 and WEB_PORT57150. Config is source-only, external-network-blocked and does not build the app.
- Exact first baseline atelier case:1pass; exact first baseline perf case:1pass (49.4ms p50), all later assertions reached.
- New ordinary trusted-key regression RED:2fail, missing draft-collapsed. Initial GREEN:2pass. Expanded scenarios include both list/body start and still-focused collapsed control; queued focus-frame count and not-yet-focused body are asserted.
- `pnpm exec vitest run --project unit` with exact files focus-move-reentrant-r5, reentrant-compose-focus-r3/r4, reader-compose-focus, composer/lazy-focus, composer/lazy-collapse-focus-r3, compose-conversion and focus-ring:61pass/8files (`unit.log`).
- Atelier scoped composer/early-input/new regression controls:11pass (`controls.log`). Separate e2e new regression4cases plus initial huge layout and direct native Tab/ShiftTab/Subject reveal:8pass (`focus-expanded.log`). New cases assert exact collapsed bytes, durable saved bytes, Undo/Redo, focus, shortcut/Tab ring and scoped axe0violations. Personally inspected light/dark screenshots: intact authored collapse, no stray ring or layout defect.
- `pnpm --filter @terno/web typecheck`:PASS; strict oxlint on the three owned TS/TSX files:PASS; git diff --check:PASS.
- Final original perf spec (no dependencies, no profiling, original input/window/assertions unchanged):FAIL, frame p50 **55.9ms >50**; transaction p95 **26.1ms <=30**, opening568ms <=2000. Later serialization/toolbar/indent checks unreached in this final invocation. No repeat seeking green. Renderer editor production code remains unchanged. This is an unresolved release blocker; initial passing source run is not a waiver.

Earlier artifact-path lookup incorrectly assumed original04-e2e/original06-ui-perf subdirectories (actual04-e2e/06-ui-perf); corrected read-only. One exact filename lookup did not exist; no prohibited file was accessed. First pnpm invocation populated this worktree's node_modules from local store with no downloads; normal test helper compilation remained unchanged. Test runners own their child teardown; no manual process signals, port/name kills, real profiles or secrets used. Initial runners used tool session lifecycle rather than an explicit PID/birth ledger, a process-evidence limit.

## Single code-review disposition
Exactly ONE native read-only `codex exec -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -s read-only -C <checkout> -` Standards+Spec code-review round completed exit0/DONE (`code-review.log`). Standards: no actionable findings. Spec: no actionable findings in the focus fix/config/regressions; performance explicitly remains unqualified. No second review or fallback. No findings required post-review production edits. Lower-priority unqualified matrix: before-target/inert Escape intervals, cold-chunk IME/selection/Undo and a held real save ACK across the pinned transition; existing adjacent controls passed but do not certify those combined cases.

## Handoff
Safe focus correction is ready for Root serial rebase/recheck/landing; no push or landing performed. Performance remains blocked at original unchanged50ms gate (final55.9ms), and no broader release-green claim is made. Full gates intentionally not run per task scope; original full-gate failures remain recorded in milestone3. Root owns worklist and cleanup separately. Evidence directory `/tmp/terno-release3-compose-editor`; screenshots under shots; no public/provider traffic.
