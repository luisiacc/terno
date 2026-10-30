# Release sender-icon clearing admission

## Request

> Fix the first-milestone sender-icon clearing failure in your T3-created isolated worktree from currentmain7d82744f.
> Diagnose actual source: eventpropagation/cache/requestlifetime vs stalecontrolledfixture/transport. Don't assumeproductiondefect; use deterministic public forget + heldold/newanswers.
> Preserveprivacy: lateoldgenerationresponsecannotresurrectcleared state, settingsdisable/consent/accountscopes stillapply, normal cacheforgetmayrequestagainunderexistingconsent.

## Existing contracts and diagnosis

Plan 22 defines reset invalidation; its later default-on revision supersedes the original default-off text. Plan 75 explicitly supersedes immediate clearing: *every* reset, including Forget, retains visible icons until replacement bytes or a null answer. The renderer tests explicitly enforce that behavior. The perf case's zero-icon assertion expects the older behavior. The test transport is actually passed to Backend and its hold is live; it is not a copied fixture.

The renderer also lacks a generation check on pending lookup/data RPCs. Old replies can reinstall refs after a reset; backend fetch generation checks cannot cancel an already delivered RPC answer.

## Design and dependency

Add renderer generation checks to discard old lookup/data successes and failures, including delayed `again` retries. Preserve Plan 75's visible-icon hold behavior for ordinary resets. Deterministically hold old/new RPC answers in unit tests, prove failure first, then verify current-generation recovery.

Immediate public Forget clearing requires a typed distinction between destructive Forget and routine revalidation in `RpcEvents.icons`. Both currently send exactly `{ icons: {}, reset: true }`. Shared RPC types are explicitly outside this child's ownership. Do not introduce magic entries, untyped payload extensions, or clear all resets (which would regress Plan 75). Root must authorize/own that contract extension if immediate clearing is desired. Until then retain the exact browser zero-icon assertion and report its failure.

## Tests and performance

Run only sender-icon renderer/service tests; touched web types and lint; exact Lumen sender-icons perf case via own dev-only config on E2E_PORT=56510, WEB_PORT=56520. Append the network guard to every test launch. Block browser external traffic in this config. No production/app build, budget change, baseline update, sample reduction, full suite or production performance claim. Preserve existing frame, row-render, zero-icon, arrival-render and host-count assertions.

No controls/copy/layout changes; keyboard/axe and en/es changes are unnecessary. Inspect light/dark screenshots if UI behavior is changed. Out of scope: Plans 64–68, held R2, all unrelated child ownership, shared types/stores/transport, landing/push.

## Revisions after the Codex review

Native read-only plan critique completed (8 points; `/tmp/terno-sender-icon-clear/plan-review.log`). Confirmed live fixture and Plan75 conflict; no sound global Forget distinction within ownership. Scope is a renderer stale-RPC fix, **not milestone clearance**. Keep request accounting unchanged, test same-key reuse and current-generation recovery, and invalidate delayed retries. Backend await-boundary races/forget publication ordering require separate service investigation; renderer-only checks make no global generation-safety claim. Document exact commands and external browser blocking. The exact zero-icon assertion remains unchanged and failing pending root's contract decision.

## Evidence and exact commands

Base: `7d82744f`. Every test command used `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs"`.

- RED: `pnpm exec vitest run --project unit apps/web/src/lib/sender-icons.test.ts -t 'reset generations'` — two assertion failures: old lookup replaced `none` with `ref`; old data populated the new generation with `data:old`.
- GREEN: `pnpm exec vitest run --project unit apps/web/src/lib/sender-icons.test.ts` — 13 passed, including all existing Plan75 contracts.
- Direct regression/privacy: `pnpm exec vitest run --project unit apps/web/src/lib/sender-icons.test.ts packages/backend/src/icons/service.test.ts packages/backend/src/icons/cache.test.ts packages/backend/src/icons/google.test.ts` — 53 passed.
- Types: `pnpm --filter @terno/web typecheck` — passed (both renderer and worker projects).
- Lint: `pnpm exec oxlint --deny-warnings apps/web/src/lib/sender-icons.ts apps/web/src/lib/sender-icons.test.ts apps/web/e2e/perf.spec.ts apps/web/playwright.sender-icons-admission.config.ts` — passed.
- Exact browser RED and final: `SENDER_ICON_ADMISSION=1 E2E_PORT=56510 WEB_PORT=56520 pnpm --filter @terno/web exec playwright test -c playwright.sender-icons-admission.config.ts --project=perf --no-deps e2e/perf.spec.ts -g 'continuous scrolling with website icons arriving'` — both reproduced expected 0 / actual 24. Dev frame and DOM gates passed; execution stops at the unchanged zero-icon assertion, so later row/arrival/network assertions remain unqualified. No claim about the 38 serial successors or production timing.

Logs: `/tmp/terno-sender-icon-clear/{unit-red,unit-green,direct-tests,types,lint,browser-red,browser-final,plan-review,code-review}.log`. The initial browser reproduction used the Node guard; the final run additionally installs a context route blocking browser external HTTP requests. No application/Vite/package production build was run; the pre-existing test setup builds its incoming-mail test worker.

Light/dark screenshots personally inspected: `/tmp/terno-sender-icon-clear/browser-results/perf-sender-icons-plan-22--b86cc-ooth-icons-re-render-no-row-perf/sender-icons-{light,dark}.png`. Both show the retained icons with stable row layout. No controls/copy/baselines changed.

## Root dependency / remaining limit

`packages/core/src/rpc/contract.ts:902` declares only `reset?: boolean`; the service emits identical reset payloads for Forget and revalidation. Root must coordinate a typed destructive-clear distinction (and publication after cache clearing) while retaining Plan75 for routine refreshes. This child did not edit shared contracts or backend core. Pending backend await-boundary concerns from the plan critique are not claimed fixed. The milestone remains RED; do not land as a release clearance.

## Completed code review and disposition

Exactly one native `codex exec -s read-only -C "$PWD" -` Standards + Spec review completed against `7d82744f`; full output: `/tmp/terno-sender-icon-clear/code-review.log`. It reported one P2 finding (missing fail-first coverage of stale rejection handlers and both delayed retry branches), no additional Spec findings, and confirmed the shared-contract blocker. Fixed that finding with four deterministic regression cases plus a two-occupied-slots recovery case. Temporarily removed only those four guards: all four targeted regressions failed by assertion (not fixture errors); restoring them passes. Evidence: `review-red.log` and `review-green.log`. No second review/delegate/fallback; no remaining review findings.

Final direct command (same four explicit test paths above): **58 passed**, including 18 renderer tests. Final touched web typecheck and scoped lint passed again (`direct-tests-final.log`, `types-final.log`, `lint-final.log`). The last changes after the exact browser run were tests/documentation only, so the browser result remains the recorded RED; there was no retry-until-green. This branch fixes stale renderer completions and records the contract dependency; it does not fix or clear the requested milestone.

## Root integration: preserve the approved Plan75 contract

Root read Plan75's original user request and confirmed Forget intentionally participates in stale-while-revalidate. A new destructive-reset RPC would change that approved policy and is unnecessary for this repair. The legacy zero-icons-after-Forget oracle is therefore superseded: record exact nonempty image data URLs, prove actual new network requests enter the existing held transport after Forget, and assert those same URLs remain until release. The original 2,000-row workload, frame/DOM budgets, host-count bound and zero ThreadRow render assertions remain unchanged. After release the original positive SenderIcon-render assertion remains. A final actual Settings switch-off flow retains the zero-icon assertion where that is the intended behavior. No shared contract or backend change.

Root's first extra switch-off check used a direct dev-origin settings RPC, which leaves renderer settings unchanged; its two failures are retained in browser.log/browser-final.log. Diagnostic browser-disable-diagnostic.log confirmed renderer senderIcons=true. The final fixture uses the real Settings switch, then asserts all sender-icon nodes disappear; no narrowed visible-only assertion remains. The first URL snapshot mistakenly addressed the wrapper span; it was corrected to its actual img source and positively requires data:image URLs before qualifying the final run. These are Root fixture-authoring errors, not additional product regressions.

After rebase Root passed 58 direct icon tests, web types and lint. The exact dev browser case passes in browser-ui-final.log: 31 maximum DOM rows, frame p95 16.80ms against unchanged20ms, zero long frames, zero row rerenders and14 icon renders on arrival. Development evidence does not claim shipped-production timing or the 38 serial successors. A controlled inverse temporarily restores unconditional clear-on-reset: clear-mutation.log fails exactly at the retained image-URL assertion while the request gate and earlier frame checks pass. The original production image is restored byte-exact in finally, with SHA256 in clear-mutation.json. No repeat-until-green or policy/budget waiver.

Evidence: `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-root-sender-icons-ivy5m6pe`. This completes the original fixture-contract repair alongside the worker's stale-RPC generation fixes. The sole completed native review remains the one recorded above; Root's later test-oracle correction and mutation are integration verification, with no second native review or independent post-correction review verdict. No production change followed that review. Root owns serial landing and remaining release gates.
