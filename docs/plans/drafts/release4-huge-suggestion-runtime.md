# Release 4: bound huge suggestion runtime

## Request

Own 10MB autocomplete paired-typing runtime repair. Preserve authored data, IME, selection/caret, undo, ACK/autosave, public grouping mappings and default-off behavior. Original autocomplete perf oracle is read-only. No recipient/backend/global-focus changes, builds, broad suites, push or landing.

## Evidence and design

Read Plans18/16 and release4-autocomplete-latency.md. Observer correction 4c14bb93 removes 18,006 observer geometry reads; the subsequent whole-file run still fails 10MB end paired typing (1.565/1.637 vs original 1.165/1.294 bounds). Placement passes at reached positions; heap +1.49MiB passes. Native profiles identify flattenSiblingGroups/restoreSiblingGroups/preMatch but do not establish paired causation.

Trace actual suggestion metadata and topology invalidation first. Add a deterministic ordinary work-bound regression before minimal causal runtime change. Do not bypass dirty/decorations/composition work or serialize whole bodies per key. If dependency correction is necessary, preserve ESM/CJS/source parity and offline frozen installation, with unrelated patches byte-exact.

## Verification and limits

All tests append inherited NODE_OPTIONS with /tmp/terno-network-guard.cjs. Finite runner records PID/birth/argv, joins/reaps and signals only verified owned PIDs. Synthetic providers, temp profiles, external-blocked browsers. Only changed module/direct callers, Web types, strict owned lint, exact affected browser/perf. One unchanged exact 10MB original test after causal change at E2E_PORT57610 (WEB_PORT57620/21), dev source config --no-deps, original global setup. Original 2MB editor gate only if grouping hot path changes. Complete saved text/HTML, accept/dismiss/nativeUndo/caret/autosave light/dark controls. No production qualification claim from profiles/dev runs. Exactly one native sol/high read-only Standards+Spec production review after focused green; findings fail-first, no second review.

## Revisions after the Codex review

Native sol/high read-only critique completed with nine points (`/tmp/terno-huge-plan-review.log`): distinguish metadata from edits, bound actual operations, preserve dirty/deco/composition invalidations, cover grouping thresholds/mappings if touched, use native composition, supplement misleading original midpoint, preserve calculated bounds, observe ACK and exact saves, and establish dependency parity if touched.

Live probes (`/tmp/terno-huge-diagnostic.log`, `...-large.log`) show clean ghost metadata does NOT call root updateChildren; real typed keys reconcile once on both sides. No grouping-engine shortcut is supported by that evidence; dependency files remain unchanged. RichBody does, however, recompute toolbar state for ghost-only metadata. Ordinary mounted-RichBody work regression fails: show+dismiss cause **2 formatState calls vs 0 expected**, while document/draft identity stays unchanged. The formatting routine scans the document via indentation eligibility even for a caret at the end. Scope the repair to RichBody's format inputs: document identity, selection, stored marks, history depths, editability. Keep bubble positioning live. This fixes demonstrated redundant work, without asserting it accounts for the entire historical paired differential. The unchanged original single 10MB invocation determines that outcome.

Initial original10 command used a start-anchored grep that did not match Playwright's full title: no tests ran and no measured result existed (`/tmp/terno-huge-original10.log`). Corrected only the grep to match the exact 10MB title suffix; the single executable invocation is `/tmp/terno-huge-original10-valid.log`. No original workload, settings, delays, samples, bounds or assertions changed.

## Implementation and deterministic evidence

Only runtime change is RichBody's formatting publication. Its bounded last-input record avoids recomputing formatState for ghost-only state changes; document edits, selection, stored marks, undo/redo depth and editability invalidate it. Link-bubble updates still execute. No timer, cache collection, document serialization, suggestion policy, transaction, ACK behavior, grouping or dependency change. The record holds at most one immutable editor state, replaced on the next formatting update and released with the editor closure.

RED `/tmp/terno-huge-work-red.log`: actual mounted RichBody, show/clear ghost via real plugin transactions, expected zero formatState calls, got two. GREEN `/tmp/terno-huge-work-green.log`: same command and runtime candidate, zero ghost formatting calls; text edit recomputes. Extended controls add selection, stored bold marks, undo/redo and sending editability invalidation. Original document/draft identity is asserted across ghost-only updates. No qualifying production build or full-suite result is claimed.

## Commands

All test commands use `python3 /tmp/terno-ac-run.py LIMIT LOG COMMAND...`; the runner appends inherited NODE_OPTIONS with ` --require=/tmp/terno-network-guard.cjs`, captures root PID/birth/argv, waits to a finite native-aware deadline, verifies identity before any signal, and joins/reaps. No run has needed deadline signals. Playwright owns and closes its browser/worker/dev-server children. Frozen offline install: `pnpm install --offline --frozen-lockfile --ignore-scripts` (717 reused, 0 downloads, lock/workspace/patches unchanged).

```sh
# sol/high plan critique, exit 0; complete prompt/result in log
python3 /tmp/terno-ac-run.py 300 /tmp/terno-huge-plan-review.log codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . 'Read AGENTS.md and docs/plans/drafts/release4-huge-suggestion-runtime.md plus scoped ghost/editor/grouping code. Critique this plan with at most 12 concrete points. Do not read/search packages/backend/src/provider-cooldown.stage2-baseline.int.test.ts or broad backend globs. No changes, children, tests or network. This is a plan critique, not production review.'
# RED exit 1 / GREEN exit 0, same test invocation before/after runtime edit
python3 /tmp/terno-ac-run.py 180 /tmp/terno-huge-work-red.log pnpm exec vitest run --project unit apps/web/src/components/composer/rich-ghost-work.test.tsx
python3 /tmp/terno-ac-run.py 180 /tmp/terno-huge-work-green.log pnpm exec vitest run --project unit apps/web/src/components/composer/rich-ghost-work.test.tsx
# diagnostic only, 1 pass each, no timing qualification
E2E_PORT=57610 WEB_PORT=57620 python3 /tmp/terno-ac-run.py 240 /tmp/terno-huge-diagnostic.log pnpm --filter @terno/web exec playwright test -c playwright.huge-local.config.ts --project=perf --no-deps e2e/huge-suggestion.dev.ts
E2E_PORT=57610 WEB_PORT=57620 python3 /tmp/terno-ac-run.py 240 /tmp/terno-huge-diagnostic-large.log pnpm --filter @terno/web exec playwright test -c playwright.huge-local.config.ts --project=perf --no-deps e2e/huge-suggestion.dev.ts
# single measured original10 invocation, original globalSetup and oracle unchanged
E2E_PORT=57610 WEB_PORT=57620 python3 /tmp/terno-ac-run.py 1700 /tmp/terno-huge-original10-valid.log pnpm --filter @terno/web exec playwright test -c playwright.huge-local.config.ts --project=perf --no-deps e2e/autocomplete-perf.spec.ts -g 'a 10 MB draft: suggestions at the start, middle and end cost typing nothing beyond the paired gate, and appear in time$'
```

The diagnostic dev file was subsequently replaced by owned authored-content/control tests; diagnostic output remains archived. The source-only config starts Vite dev on 57610 with `VITE_RENDER_PROBE=1`, one Chromium worker, original native globalSetup, perf trace off/deviceScaleFactor 1, loopback-only proxy bypass and an external rejecting proxy. No app production/dist build, normal globalSetup replacement, original e2e edit, dependency patch or original 2MB grouping gate invocation.

## Qualification results

Single original10 measured run: **1 PASS**, every position reached, 2.7 minutes. Start median/tail 0.962/0.979 (computed bounds 1.147/1.267); middle 0.961/0.952 (1.149/1.278); end **1.036/1.039 (1.158/1.279)**. Placement **61.8/61.3/61.7ms**, original 120ms cap. Pooled on/off p50 start 19.1/21.1ms, middle 20.2/20.5ms, end 16.8/17.3ms. Off-state work was not changed or deliberately slowed; no oracle changes, extra retries, timing waivers or altered multipliers. The pass is targeted source-dev evidence, not a claim of full release-green main or proof that all historical differential was caused by toolbar scans.

Focused unit/direct callers: **5 files pass, 29 tests pass, 1 pre-existing conditional test skipped** (`rich-read-failure.test.tsx`'s existing `it.runIf(import.meta.env.VITE_RENDER_PROBE)`), unchanged. No new skip/conditioning. Extended work-bound/invalidation controls pass with unchanged body identity across ghost metadata, real edits marked dirty, stored marks, selection, undo/redo and sending editability refreshed. Dependencies and grouping code untouched, so no grouping-engine/2MB gate or dependency parity rerun is required. 5MB and heap are not rerun: placement, suggestion lifetimes and retained collections are unchanged; the cache is a single bounded last-input record.

Owned browser controls: **2 PASS**, light and dark. Complete persisted plain text and independently generated HTML, DOM paragraphs and exact native caret offset checked after Tab acceptance, native undo/redo, Escape dismissal and native CDP IME commit. Editor keeps keyboard focus. Scoped editor axe: zero violations in each theme. Personally inspected `/tmp/terno-huge-light.png` and `/tmp/terno-huge-dark.png`: authored line and fitted ghost are aligned and legible, no visual change/copy introduced. No en/es catalog change needed. Source Web + worker types pass; strict owned lint passes; diff whitespace check passes.

```sh
# exit 0; 29 pass, one existing probe-only conditional skipped
python3 /tmp/terno-ac-run.py 180 /tmp/terno-huge-unit.log pnpm exec vitest run --project unit apps/web/src/components/composer/rich-ghost-work.test.tsx apps/web/src/components/composer/ghost.test.ts apps/web/src/components/composer/rich-body-supersession.test.tsx apps/web/src/components/composer/rich-read-failure.test.tsx apps/web/src/components/composer/rich-send-r10.test.tsx
# exit 0; two browser controls pass
E2E_PORT=57610 WEB_PORT=57620 python3 /tmp/terno-ac-run.py 450 /tmp/terno-huge-controls.log pnpm --filter @terno/web exec playwright test -c playwright.huge-local.config.ts --project=perf --no-deps e2e/huge-suggestion.dev.ts
# exit 0 each
python3 /tmp/terno-ac-run.py 240 /tmp/terno-huge-types.log pnpm --filter @terno/web typecheck
python3 /tmp/terno-ac-run.py 120 /tmp/terno-huge-lint.log pnpm exec oxlint --deny-warnings apps/web/src/components/composer/rich.tsx apps/web/src/components/composer/rich-ghost-work.test.tsx apps/web/e2e/huge-suggestion.dev.ts apps/web/playwright.huge-local.config.ts
git diff --check
```

## Single production Standards + Spec review

Exactly one completed native read-only production review after implementation, focused unit green, original10 green, browser controls green, types/lint green. Invocation below exited 0; CLI header records **gpt-6.1-sol / openai / high / read-only**, no model/provider fallback or children. Complete prompt is `/tmp/terno-huge-review-prompt.txt`; full result `/tmp/terno-huge-production-review.log`.

**Actual verdict: Standards PASS; Spec PASS. No actionable findings.** Reviewer found the actual format inputs covered, cache updated before listener notification for reentrancy, bubble updates preserved, bounded retention and no introduced data/IME/selection/undo/ACK/autosave interference. Review changed no code and required no fail-first finding fixes; no lower findings/backlog and no second review.

Review limits: source inspection of the four owned code/test/config files against base, using recorded evidence; reviewer ran no tests/builds and did not review the prior observer correction. The reviewer notes its own session metadata cannot independently verify exact native model settings; the launching CLI header and exact invocation above/below record the requested native sol/high configuration. Source-dev timing pass does **not** qualify production performance or prove the entire historical differential is explained. No full release-green main claim: full suites, production/dist builds, packaged smoke and unrelated recipient paint were intentionally not run or claimed cleared. Existing first-sync, Plans64–68, diagnostics Plan78 and image/drop Plan76 code remain untouched. No fetch/push/landing or main/worklist/other-owner edits.

```sh
# Single completed production review, exit 0, Standards PASS / Spec PASS
python3 /tmp/terno-ac-run.py 600 /tmp/terno-huge-production-review.log codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . - < /tmp/terno-huge-review-prompt.txt
# Initial grep setup error, exit 1, NO TESTS / no measured product failure (corrected executable command recorded above)
E2E_PORT=57610 WEB_PORT=57620 python3 /tmp/terno-ac-run.py 1700 /tmp/terno-huge-original10.log pnpm --filter @terno/web exec playwright test -c playwright.huge-local.config.ts --project=perf --no-deps e2e/autocomplete-perf.spec.ts -g '^a 10 MB draft: suggestions at the start, middle and end cost typing nothing beyond the paired gate, and appear in time$'
# Preservation check, exit 0, empty diff
git diff --exit-code -- apps/web/e2e/autocomplete-perf.spec.ts pnpm-lock.yaml pnpm-workspace.yaml patches
```
