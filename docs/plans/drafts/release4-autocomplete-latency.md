# Release 4: huge-draft autocomplete latency

## Request

“Own ONLY autocomplete huge-draft latency/pairedtyping failure.” Restore the unchanged Plan18 gates: 5 MB suggestion placement ≤120 ms and 10 MB paired typing, preserving workloads, local-only suggestions, draft contents, native undo, caret and autosave. No dependency/grouping-engine changes or unrelated owners' files.

## Existing behavior

Main a11afb2 includes the sibling grouping patch and Plans64–68/78. Archived milestone4 completed two failures: 5 MB start placement 352.7 ms; 10 MB start paired median 1.522 and tail 1.725. The heap case was interrupted, not an established failure. Archived perf output has error contexts but no Chromium performance trace (perf project disables Playwright tracing).

Ghost context is bounded to 1000 characters, requested after 60 ms. Replies dispatch a metadata transaction then place a sibling layer using caret geometry and binary-search DOM measurements. Draft serialization remains at autosave cadence.

## Design / investigation

Separate diagnostic CDP profiling from qualification. Attribute readiness, native CPU/layout and serialization before changing code. Add an ordinary deterministic behavioral regression at the causal seam, then the smallest bounded fix. Preserve all editor/model, serializer, IME, image/drop behavior and existing timing oracles.

## Tests and performance

Only owned module/direct callers, web types, strict owned lint, unchanged autocomplete-perf file via dev-only source server and --no-deps, serial on E2E_PORT=57550. Every test inherits NODE_OPTIONS plus the network guard; synthetic backend and temporary profiles, browser external traffic blocked. Dev results are evidence with an explicit production-build limitation. No production build/full suites or timing waivers. If placement changes, verify trusted text, acceptance/undo/caret/autosave plus keyboard, scoped axe, personally inspected light/dark screenshots.

## Out of scope

Print/frame/global focus/shared keyboard, backend changes, dependencies/lock/grouping engine, real profiles/providers, landing/push, main/worklist edits and new report slices.

## Revisions after the Codex review

Native gpt-6.1-sol/high read-only plan critique completed (12 points, /tmp/terno-ac-plan-review.log). Add explicit phase attribution and deterministic invalidation/acceptance criteria; keep fitted text authoritative and body-source identity unchanged. Inspect geometry and layout before considering caches; avoid new geometry caching. Existing pending blur/off-on invalidation and full-text announcements are noted as adjacent correctness concerns, outside the latency fix unless made causal. Qualification uses actual executable gates rather than historical prose budgets. Source-only dev results cannot certify production.

Baseline setup correction: first launch served 57550 but inherited baseURL 5180 and failed before app loading. Reran once with E2E_PORT=57550; no measured product result existed in that setup failure. Correct baseline reproduces 5 MB start latency at 361.3 ms (>120); paired typing there passes (1.152 median / 1.220 tail).

## Causal evidence and implemented change

Baseline source-server file: 2 failed / 8 passed, 4.3 min (`/tmp/terno-ac-baseline-portfixed.log`). 5 MB start 361.3 ms; 10 MB paired median 1.433 (limit 1.161), tail 1.619 (1.286). Heap +1.49 MiB passes. Original milestone failures are reproduced without attributing them to main movement or noise.

Separate diagnostic captures (not qualification): `/tmp/terno-ac-latency-trace.json`, `/tmp/terno-ac-chrome-trace.json`, `/tmp/terno-ac-cpu-true.json`, `/tmp/terno-ac-cpu-false.json`. With the original pending-ghost assertion, sampled stacks include `isElementHiddenForAria`, `getCSSContent`, `processElement`, `toAriaNode` and repeated `getBoundingClientRect`. Request→shown 322.5 ms, shown→placed 18.3 ms. This is a renderer observer effect: Playwright's missing-locator assertion generates a whole-page ARIA error snapshot on misses. It delays delivery of the suggestion, beyond the native suggestion work. Autosave serialization remains separately visible (69–75 ms in that capture); it was not moved or suppressed.

The original wait is replaced with `expect.poll` over the ghost's visible attribute value. Same default assertion polling intervals, 10,000 ms timeout, `/^ look/` content assertion, and the unchanged request→placement +60 ms latency calculation/cap. No production editor, model, body, recipient, network or UI code changes. No suggestion caching, fixture conditioning or deferred work.

Ordinary regression: a pending ghost beside 3,000 draft paragraphs, instrumenting native body geometry reads in Playwright's utility world. RED: expected 0, received 18,006 (`/tmp/terno-ac-red-utility.log`). GREEN: zero reads (`/tmp/terno-ac-green.log`). Initial attempts instrumented only the main world and passed on old code; they were inadequate, replaced by the utility-world test. The synthetic ghost delay in this new regression is 500 ms; every existing workload/delay is unchanged.

10 MB diagnostic handoff: native profile's editor transaction stacks are dominated by sibling-group `flattenSiblingGroups`, `restoreSiblingGroups`, and `preMatch`. In one diagnostic on/off burst, editor dispatch incl. readDOMChange was 328.8 / 282.3 ms total, while placement was ~6 ms sampled total, each placement callback <1 ms; layout total 10.5 ms, max 0.474 ms. This identifies an expensive engine path but does not establish why all of the paired differential occurs. No dependency/grouping-engine change is justified within this ownership without handoff. The diagnostic profiles are not substituted for the original paired gate.

## Qualification and remaining limits

One full affected-file run after the causal change: **2 failed / 9 passed**, 6.4 minutes (`/tmp/terno-ac-after.log`), no retries or timing waivers.

- 5 MB paired gates pass at every existing position; placement start/middle/end **61.8 / 67.2 / 62.0 ms**, cap 120 ms.
- 10 MB start and middle pass paired and placement (61.8 / 61.7 ms). **End paired still fails:** median 1.565 vs 1.165; tail 1.637 vs 1.294. Its placement check is not reached. This is not a release-green candidate and the paired failure is not claimed fixed.
- The unchanged 200-chip recipient paint case fails: best p95 **17.8 ms >16.7 ms** (rounds 17.9,17.8,21.2). It passed baseline, but this run fails; no noise waiver or retry. Recipient implementation is outside ownership.
- 1 MB paragraph typing, mid-paragraph eligibility, DOM/no-paste-request behavior, heap (+1.49 MiB), recipient suggestion paint, both injected regression twins, and the new pending-ghost regression pass.
- Web types pass, strict owned lint passes, diff whitespace check passes.

All browser evidence uses a dev source server because production builds were explicitly prohibited. No production performance certification, all-suite release certification, independent fix of 10 MB paired cost, or UI/visual change is claimed. UI/catalog/keyboard/axe/screenshots are inapplicable to this test-only change. Original trusted keyboard typing and heap accept/dismiss/undo workloads are preserved. No product source, profiles, secrets, providers, dependencies, lockfile or grouping engine changed. Main and other branches are untouched. No landing/push.

## Single Standards + Spec review

After implementation and the ordinary targeted GREEN: native `gpt-6.1-sol`, high effort, read-only, plugins disabled; **no findings in Standards or Spec** (`/tmp/terno-ac-production-review.log`). It explicitly notes that paired cost is not established fixed. No second review. Review changed no code; there were no findings to fix. Review is scoped to the implemented observer-effect fix, not a release approval.

## Exact validation commands

All commands ran from this checkout. `/tmp/terno-ac-run.py` captures root PID/birth/argv, gives a finite native-timeout-respecting deadline, joins/reaps the root, and appends inherited `NODE_OPTIONS` with ` --require=/tmp/terno-network-guard.cjs`. Playwright manages and reaps its own worker/browser/dev-server children on completion. All completed without forced deadline signals. Browser launch used a rejecting loopback proxy for external URLs and bypassed loopback only. No real provider/profile.

Temporary source-only config was `apps/web/playwright.ac-local.config.ts` during execution; archived at `/tmp/terno-ac-playwright.config.ts`, removed from checkout. It imports the existing config, uses one worker, replaces only webServer with `VITE_RENDER_PROBE=1 pnpm vite --host 127.0.0.1 --port 57550 --strictPort`, and keeps perf project settings, no deps, no builds.

```sh
# RED, before helper implementation; exit 1, 18,006 body measurements
E2E_PORT=57550 WEB_PORT=57560 python3 /tmp/terno-ac-run.py 180 /tmp/terno-ac-red-utility.log pnpm --filter @terno/web exec playwright test -c playwright.ac-local.config.ts --project=perf --no-deps e2e/autocomplete-perf.spec.ts -g 'waiting for a pending ghost'
# GREEN, after helper implementation; exit 0, zero measurements
E2E_PORT=57550 WEB_PORT=57560 python3 /tmp/terno-ac-run.py 180 /tmp/terno-ac-green.log pnpm --filter @terno/web exec playwright test -c playwright.ac-local.config.ts --project=perf --no-deps e2e/autocomplete-perf.spec.ts -g 'waiting for a pending ghost'
# Single valid unchanged baseline; exit 1, 2 failed / 8 passed
E2E_PORT=57550 WEB_PORT=57560 python3 /tmp/terno-ac-run.py 2200 /tmp/terno-ac-baseline-portfixed.log pnpm --filter @terno/web exec playwright test -c playwright.ac-local.config.ts --project=perf --no-deps e2e/autocomplete-perf.spec.ts
# Single complete affected-file run after change; exit 1, 2 failed / 9 passed
E2E_PORT=57550 WEB_PORT=57560 python3 /tmp/terno-ac-run.py 2200 /tmp/terno-ac-after.log pnpm --filter @terno/web exec playwright test -c playwright.ac-local.config.ts --project=perf --no-deps e2e/autocomplete-perf.spec.ts
# exit 0 each
python3 /tmp/terno-ac-run.py 180 /tmp/terno-ac-types.log pnpm --filter @terno/web typecheck
python3 /tmp/terno-ac-run.py 120 /tmp/terno-ac-lint.log pnpm exec oxlint --deny-warnings apps/web/e2e/autocomplete-perf.spec.ts
git diff --check
```

The two native Codex invocations (plan critique, single implementation review) and their full prompts/results are in `/tmp/terno-ac-plan-review.log` and `/tmp/terno-ac-production-review.log`. Review command: `python3 /tmp/terno-ac-run.py 300 /tmp/terno-ac-production-review.log codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . '<Standards+Spec prompt recorded verbatim in log>'`. Both exited 0. Plan critique initially triggered Codex's automatic marketplace-update attempts (timed out); no manual fetch/push was issued. Plugins were disabled for the production review, which reports no network access.
