# Release 4: recipient paint

## Request
Own recipient-chip rendering paint regression; restore the exact original 200-chip gate without workload, timing or visible-content changes. Preserve recipient text, authored addresses, validation, IME, selection, Undo, focus and local-only suggestions. No children, shared editor/dependency changes, builds, broad suites or landing.

## Existing evidence and design
Main 6b7b3da7; archived /tmp/terno-ac-after.log records chip p95 rounds 17.9, 17.8, 21.2 ms against 16.7 ms. Earlier baseline passed; observer fixture commit is not established causal. Plan18 and Plan34 require unchanged typing and zero chip renders; Plan29 attachments and Plans76/78 are preserved.

Investigate recipient-only serialization allocation and element reconciliation against the actual compiler/runtime. Prove avoidable work through an ordinary deterministic regression before making a minimal bounded change. Prefer immutable chips identity for reuse, with correct invalidation on chip/order/selection/description changes; no delayed state, hidden chips, geometry caches or new timers. Profile separately from qualification. If source evidence does not explain the paint failure, state that limitation even if avoidable work is fixed.

## Validation
Inherited NODE_OPTIONS plus /tmp/terno-network-guard.cjs on every test. Synthetic backend/temp profiles, externally blocked browsers; owned PID/birth/argv, finite deadlines and reaping. Direct module/caller tests, Web types, strict owned lint. Dev source-only config --no-deps, E2E_PORT=57650 WEB_PORT=57660. Original exact 200-chip test once after fix; recipient suggestion test if affected. Browser keyboard/composition/value/focus controls and scoped axe/light/dark inspected captures for recipient UI changes. Exactly one native Sol/high read-only Standards+Spec production review after focused green; no second review. No release-wide or production-build certification.

## Out of scope
Original autocomplete-perf test edits, composer/editor/ghost/autocomplete, global keyboard/focus/print, backend, dependencies, main/worklist/other owners, real profiles/secrets, push/fetch/landing. No prohibited stage2 baseline file access.

## Revisions after the Codex review
Native Sol/high read-only critique completed, 12 points (/tmp/terno-chip-plan-review.log). Preserve source-mode limitation, exact multiplier1 oracle, bounded component-local reuse, current handlers, collapse/selection/IDs invalidation, native history and IME controls. Serialization and lookup remain unchanged. Compiled source confirms the map cache depends on onChipKeyDown/onChipMouseDown, both invalidated by typing; therefore the chip element map is not independently cached. CPU diagnostic (/tmp/terno-chip-cpu.json; trace /tmp/terno-chip-trace.json) samples 58.45ms in jsxDEV, 3.81ms GC; burst layout7.89ms, paint19.22ms. These aggregate diagnostics are attribution evidence, not per-key qualification or proof of all historical variance.

Ordinary regression instruments JSX allocation while exercising an actual controlled RecipientInput. Initial runtime mock targeted only jsx, missed jsxDEV and was inadequate. Corrected pre-fix regression fails 602 allocations versus202 before typing:400 new chip elements for one text change plus async result. After fix, stable chips/selection/description IDs reuse only elements; listbox handlers remain current. No serializer, lookup, emitted value, focus, DOM structure, copy or styles change.

## Focused results and limits

- Unit/direct callers23/23 pass: new allocation regression, recipient-draft-ownership, recipient-r9, recipients helpers. The allocation test was rerun after correcting its TypeScript props narrowing;1/1 passes. Both initial Web type runs failed only at this test instrumentation (first unknown chip property, then primitive possibility for `in`); final Web types pass. Strict owned lint and whitespace pass.
- Browser12/12 pass: original recipient suite11 plus new native-CDP composition/confirmation, node continuity, exact Japanese value/caret/focus and native history Undo control. Original suite checks keyboard navigation/range selection/edit/copy/paste/Undo/Redo/collapse/full200 values/render counts, invalid addresses and axe in both themes. All six light/dark screenshots personally inspected: selected/invalid, collapsed and expanded. Captures remain at `/tmp/unica-scratch/chips-26/shots/{chips,collapsed,wrapped}-lumen-{light,dark}.png` (default design uses this existing filename convention).
- Exactly one unchanged original recipient perf invocation,2/2 pass. 200-chip round1 p50 8.8ms, p95 **16.2ms**,12 samples and zero chip renders. Suggestion round1 p50 12.9ms, p95 **15.8ms**,23 samples. The original best-of-three oracle exits after a passing round, unchanged. Multiplier explicitly1; no retries/waivers, workload edits, waits or delays changed. The parallel owner's10MB case was neither changed nor rerun.
- Source dev mode only: no production app/Vite/dist build, broad suites or package smoke. This fixes proven avoidable allocations and passes the affected source-mode gates; it does not prove all archived paint variance was caused by this allocation or certify main/release green. No attribution to4c14bb93. Serialization/suggestion traffic, model/ACK/authorship and timing behavior remain unchanged; no new caches beyond current component useMemo, timers, network or copy/styles.

## Exact commands

Each test/check uses `/tmp/terno-ac-run.py`, appending inherited NODE_OPTIONS with ` --require=/tmp/terno-network-guard.cjs`, capturing child PID/birth/argv and waiting/reaping under finite limits; no forced deadline signals were needed. Playwright manages private synthetic backend/temp browser profiles and dev server child lifecycle; browser proxy rejects external traffic. Initial pnpm invocation populated the isolated node_modules offline from its existing store; no tracked dependency/lock change. Existing global setup compiles only its backend incoming test worker; no app build occurred.

```sh
# Diagnostic, not qualification; exit0. Temporary spec archived to /tmp/terno-chip-diagnostic.spec.ts and removed from checkout.
E2E_PORT=57650 WEB_PORT=57660 python3 /tmp/terno-ac-run.py 240 /tmp/terno-chip-diagnostic.log pnpm --filter @terno/web exec playwright test -c playwright.recipient-paint.config.ts --project=e2e --no-deps e2e/recipient-paint-diagnostic.spec.ts
# Ordinary pre-fix RED; exit1, +400 chip allocations.
python3 /tmp/terno-ac-run.py 180 /tmp/terno-chip-red2.log pnpm exec vitest run --project unit apps/web/src/components/recipient-paint.test.tsx
# Focused GREEN; exit0,23/23.
python3 /tmp/terno-ac-run.py 180 /tmp/terno-chip-green.log pnpm exec vitest run --project unit apps/web/src/components/recipient-paint.test.tsx apps/web/src/components/recipient-draft-ownership.test.tsx apps/web/src/components/recipient-r9.test.tsx apps/web/src/lib/recipients.test.ts
# Browser controls; exit0,12/12.
E2E_PORT=57650 WEB_PORT=57660 PERF_BUDGET_MULTIPLIER=1 python3 /tmp/terno-ac-run.py 240 /tmp/terno-chip-browser.log pnpm --filter @terno/web exec playwright test -c playwright.recipient-paint.config.ts --project=e2e --no-deps e2e/recipient-paint.spec.ts e2e/recipients.spec.ts
# Original EXACT affected performance gates ONCE; exit0,2/2.
E2E_PORT=57650 WEB_PORT=57660 PERF_BUDGET_MULTIPLIER=1 python3 /tmp/terno-ac-run.py 180 /tmp/terno-chip-perf.log pnpm --filter @terno/web exec playwright test -c playwright.recipient-paint.config.ts --project=perf --no-deps e2e/autocomplete-perf.spec.ts -g recipients
# Final check commands, exit0 each.
python3 /tmp/terno-ac-run.py 180 /tmp/terno-chip-types-pass.log pnpm --filter @terno/web typecheck
python3 /tmp/terno-ac-run.py 120 /tmp/terno-chip-lint-pass.log pnpm exec oxlint --deny-warnings apps/web/src/components/recipient-input.tsx apps/web/src/components/recipient-paint.test.tsx apps/web/e2e/recipient-paint.spec.ts apps/web/playwright.recipient-paint.config.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-chip-unit-final.log pnpm exec vitest run --project unit apps/web/src/components/recipient-paint.test.tsx
git diff --check
```

## Single Standards + Spec production review

Native `codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . '<recorded Standards+Spec prompt>'`, via the same300s owned-process wrapper, completed exit0. Full prompt/output: `/tmp/terno-chip-production-review.log`. **Standards PASS, Spec PASS, no findings.** This is the one review of new runtime code, distinct from the earlier test-only observer review; no second review or fallback. No review fixes/backlog were required. Reviewer confirmed complete memo dependencies, live parent handlers, component-local bounded reuse and unchanged original performance oracle. It explicitly limits evidence to source-dev gates, does not explain all historical variance and notes that native composition uses CDP but Undo delivery is a synthetic `beforeinput` event exercising the native handler, not a real Electron menu interaction. No release-wide/production/packaged qualification is claimed. No product code changed after review.
