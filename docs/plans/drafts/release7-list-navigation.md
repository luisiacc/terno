# Release 7: bounded list navigation work

## Request

Investigate historical 700 ms / milestone-7 150 ms sustained-j frames without assuming a timing cause. Own thread-list/row/virtualization/selection navigation internals and local tests only. Preserve original timing gates, workload, drafts, selection, focus, scrolling, designs and Plans 52/54/83. Make main release-green before new report slices; source-dev qualification remains limited until Root production milestone.

## Existing

Actual base: `8885840b099c32f582aa3d7b5217dc4a48e1124a` (expected 8885840b); clean at entry. Original milestone evidence: `/tmp/terno-release-milestone7-o5i3u5d5/06-ui-perf.log`, inventory `docs/research/provider-reliability-release-milestone-7.md`. Original Lumen comfortable case at perf.spec.ts:153 failed max frame 150.00000000000023 > 50 ms; 50 successors NOTRUN. Previous 16.8 ms source-dev pass does not explain production RED. Read Plans 48, 52, 54, 83 and relevant navigation history.

ThreadList supplies a new getItemKey closure on each render. The installed TanStack virtualizer includes that function identity in measurement memo dependencies; changing it resets pendingMin and re-enumerates loaded keys. This suggests avoidable work when scrolling rerenders the list, but is not attribution of historical frame spikes. Establish the work defect with a deterministic real-virtualizer component test before source changes.

## Design

If demonstrated, retain the key extractor with React useCallback keyed by the immutable items array. Replacements/reorders/pages must invalidate; same-items scroll/other rerenders must reuse measurements. Keep height remeasurement, dock padding, IDs, active-descendant, selection subscriptions and DOM unchanged. No new caches or timers.

## Tests and performance

Run original targeted sustained-j Lumen comfortable gate once on unmodified dev source using a temporary config with no dependency projects or production build, port 59210. Preserve all assertions and fixture. Then bounded separate work diagnosis and fail-first regression using actual TanStack virtualizer with 50k synthetic rows and deterministic scroll notifications. Cover items replacement/reorder, pagination and density remeasure. Focused direct-caller tests, renderer types and scoped lint only. One native Sol/high plan critique (at most 12 concrete points), one native Sol/high Standards+Spec implementation review after coherent focused green; fix every first-review finding with discriminating tests, no second review. Run original selected gate once per causal source qualification after preceding checks join. Do not claim other tests reached. Artifact directory: `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-release7-list-epu_8wkc`.

## Out of scope

RichBody, autocomplete/drop, schema/store/backend/dependencies; main/worklist/Plans64–68/user WIP/80/81/83 edits; full suites, builds, packaged/production qualification, push/landing. Historical RED stays unwaived unless causally explained; this slice alone cannot establish release-green.

## Revisions after the Codex review

One native Sol/high plan critique completed exit 0 (`plan-review.log`), seven objections. Browser run always sets E2E_PORT=59210; temporary config also pins baseURL. Archive/restore ui.json separately since the original report title incorrectly says production for this dev-only run. Strengthen work test to multiple real virtual-range crossings, exact key/offset mappings, pagination/replace/remove/reinsert and density geometry; use existing real-browser keyboard-entry (light/dark axe + screenshots), selection and design direct callers to witness navigation/anchor contracts. Installed compiler transform (in-memory, no build) confirms it skips this incompatible-library component, leaving the inline callback in both dev and production output. No timing attribution follows from that fact.

## Baseline and deterministic RED

Unchanged original Lumen comfortable sustained-j source-dev case PASS: 300 moves, 2.98 row renders/move, frame p95 16.7 ms/max 16.8 ms, 0 LoAF; all selected-case assertions reached. Exactly one case, other cases unexecuted. `baseline.log`, `baseline-ui.json`; native session 1928 naturally joined exit 0. pnpm materialized the locked dependencies (no manifest/lock changes). This does not qualify production or waive historical 700/150 ms REDs.

`thread-list-work.test.tsx` against original source FAILED at the ordinary work assertion: 50,000 extra estimates on one scroll instead of zero (`red.log`, native session 66296 exit 1 joined). Actual ThreadList + installed React virtualizer, synthetic dimensions/scroll observer and lightweight child rows; no timing oracle. Later assertions were unreached in RED. Three-line source fix retains the extractor with useCallback([items]); it removes that redundant enumeration without changing navigation.

## Focused implementation checks before code review

Source: stable key extractor keyed by items, no other production change. Final expanded unit/direct-caller run: 21/21 passed (`focused-final.log`); renderer `tsc --noEmit -p apps/web/tsconfig.json` and strict owned lint pass. Earlier typecheck caught an incomplete synthetic ThreadSummary assertion; fixture now constructs a complete typed summary (no source defect).

Dev-only browser correctness: **31 passed / 2 failed**, no skips (`browser-correctness.log`, `correctness-results/`). All 18 keyboard-entry/scrolled-entry cases and their full-page axe assertions passed across three designs, two themes and layouts; all 12 unique screenshots personally inspected (`visual-audit.json`). Row-height/j navigation, full-width List/Back/Forward, and same-length folder paging passed in every design. Live Settings design switching passed in macOS but failed selected-row viewport at designs.spec.ts:209 for Lumen and Atelier. Controlled original-source replay of just those two cases also failed at exactly the same assertion, viewport ratio 0 (`design-baseline-control.log`, `control-results/` traces). These inherited failures remain open and are not waived or attributed to the work fix. Existing dev console flushSync lifecycle warnings are recorded in the browser logs.

The inverse control reran the strengthened work regression on byte-exact original production source: 1 failed / 1 passed, with **250,000** extra estimates across scroll/stop/rerender rather than zero (`inverse-work.log`). Fixed source restored byte-exactly in finally; both owned control processes naturally joined. The unit test checks exact keys/offsets and retained DOM identity on a same-count reorder, append/removal, compact spacer/row geometry and next scroll geometry, and a held actual pagination trigger with one RPC, appended keys and unchanged cursor. Browser tests supply real rows/navigation/focus/anchors rather than claiming these from mocked children.

Bounded model diagnosis: installed virtualizer includes getItemKey identity in measurement dependencies; changing it resets the recomputation start and estimates every loaded row. In-memory dev/production compiler transforms both skip ThreadList optimization as incompatible with useVirtualizer (`compiler-diagnosis.json`), so implicit compiler memoization does not remove this work. No full render/layout trace of historical spikes is available from this scoped source run; frame aggregate evidence cannot establish attribution. No claim that callback work caused 700/150 ms frames.

## Single final implementation review

Exactly one native `codex exec -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high` Standards+Spec review completed naturally exit0, PID57013, 61.92s (`code-review.log`, `code-review.json`). **Standards PASS; Spec PASS for this fix; no P1/P2/P3 findings.** Reviewer confirmed items dependency, installed virtualizer work regression, reorder identity, append/removal, density geometry and pagination coverage. No second review. Historical timings and inherited two design-switch REDs explicitly remain unwaived. No production/test source changed after review; later additions are evidence documentation only. Reviewed production/test/oracle SHA256s saved in `reviewed-identity.json`.

## Final original qualification and handoff

After all prior checks and the single review joined, ran the original perf.spec.ts:153 Lumen comfortable sustained-j case exactly once on the reviewed fixed source, source-dev only, E2E_PORT59210. **PASS**, 1/1 selected test, all its assertions reached: 300 selection moves, 2.98 row renders/move, DOM bound passed, frame p95 16.8 ms/max 33.3 ms, 0 LoAF (`qualification.log`, `qualification-ui.json`, `qualification.json`). PID58651 naturally joined exit0 after15.08s. A development Vite ResizeObserver-loop unhandled-error message is retained in the successful run log; no retry or suppression. The original perf report title still says production, but this was development only, with no app/Vite production/dist build. Other perf cases were not selected; historical50NOTRUN successors remain uncovered. This is no evidence of historical timing causation or main release-green.

Final scope is exactly ThreadList, its new local regression file, and this new scoped draft spec. No production/test changes after independent review. Temporary dev configs archived then removed; own generated ui.json archived and removed because none existed at entry. No preexisting shared /tmp artifacts replaced. All owned sessions naturally joined; later argv/PID/birth/deadline metadata and final process/port checks in `cleanup.json`. Early baseline, RED and plan critique were joined through tool sessions but parent PID/birth was not captured; that supervision evidence limitation is explicit. No manual process signals. No full suites/build/package clearance, push/fetch/land, main/worklist/peer edits, or claims over the153-row goal. Root owns integration and production qualification. Final known failures remain the two inherited live-design-switch viewport checks and historical milestone REDs; local work regression, focused correctness/types/lint, implementation review and selected source-dev timing gate are green.
