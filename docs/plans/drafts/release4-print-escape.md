# Release 4: print sheet Escape and focus

## Request
Repair the milestone4 print.spec.ts:130 Escape failure; qualify current main a11afb2d while preserving diagnostics, image/drop/first-sync and Plans64–68. Own print paths only, no landing/push/full gates/builds.

## Existing
Plan09 requires Escape dismissal and initial primary-action focus, then return to the opener. Archived trace records successful frame print dismissal, palette click, visible sheet, Escape 1.3ms after visibility completes, sheet retained for 8s. Source palette closes and immediately opens print; both dialogs have asynchronous focus management. Exact focus/key ownership needs a diagnostic witness before attributing cause.

## Design
Find the key receiver and competing focus restore. Add a deterministic public behavior regression before a minimal local print fix. Preserve native composition, draft/ACK/Undo/focus/scroll, selection, content and remote consent. Do not rewrite shared keyboard or global focus.

## Tests and performance
Changed/direct print unit tests, Web types, strict owned lint, dev-only print Playwright across macOS/lumen/atelier with unchanged budgets and fixtures; light/dark axe, keyboard and personally inspected screenshots. External browser traffic blocked; every test inherits NODE_OPTIONS with network guard. No heavy startup work, polling or idle timers added. Process ownership recorded, bounded commands and joined cleanup. Native sol/high read-only plan critique <=12, exactly one completed Standards+Spec production review after targeted green, findings fail-first.

## Out of scope
Composer/ghost/autocomplete, backend, full suites/perf, production/dist/packaged builds, real profiles/secrets. Bundle assertion requires an existing production build and is not qualified by dev mode. Original once-only failure stays recorded unless causally reproduced.

## Revisions after the Codex review
Native gpt-6.1-sol/high read-only critique: nine points, /tmp/terno-print-escape/plan-review.md. Corrected timing; initial focus and Escape readiness are separate contracts. Preserve the warm frame→close→palette sequence, both print/PDF primary focus, connected iframe return destination and reader position. No generic palette delay or shared keyboard change. Diagnostic listeners/DOM logging removed before qualification (synthetic fixture only). Native parent dismissal is document-level: focus outside alone is insufficient; an iframe document is the causal boundary. Dev config replaces (does not merge) inherited webServer; bundle assertion excluded by command. Existing synthetic global setup compiles the incoming backend worker, not an app/Vite production bundle.

## Causal witness and RED
Diagnostic current-main run passed, recording palette input→command-list→reader iframe→print primary. Thus palette restore has an interval with frame focus. The archived snapshot does not itself identify the key receiver; exact original attribution remains inferred from this matching handoff. A regression pins only deferred sheet rAF focus after the warm actual-frame print/close, opens palette with native keys, clicks print, proves the reader iframe owns focus and presses native Escape: sheet remains, expected0/actual1 after unchanged8s. This is the original public symptom at the demonstrated source boundary. Direct print-open test independently fails dialog expectednull/actualprint. Initial unit harness lacked matchMedia; fixed before the behavioral RED. Browser/unit RED logs retained under /tmp/terno-print-escape.

## Implementation
The already-installed mail-frame print key bridge consumes non-composing, unconsumed Escape only while print owns the dialog and clears dialog+target together. Existing parent dialog focus restoration remains responsible for return focus. No listeners, timers, content/privacy changes, startup imports, translations or visual styling added. Nav bridge already ignores defaultPrevented, so dismissal cannot also navigate.

## Qualification commands and results
All commands were wrapped by `python3 /tmp/terno-print-escape/run.py <label> <finite seconds> <command>`, which appends inherited `NODE_OPTIONS` with `--require=/tmp/terno-network-guard.cjs`, records owned PID/birth/argv, validates identity before signaling and joins the command. Browser environment: `E2E_PORT=57510 WEB_PORT=57520`; synthetic providers/temp per-test backend, browser external HTTP(S) blocked (later per-test mocked responses retain precedence). Logs, manifests, RED trace and screenshots are in `/tmp/terno-print-escape/`.

- RED: `pnpm exec vitest run --project unit apps/web/src/lib/print-open.test.ts`:1 failed/1 passed, expected null/actual print. Initial harness-only matchMedia error separately retained.
- RED: `pnpm --filter @terno/web exec playwright test -c playwright.print.dev.config.ts print.spec.ts --project=e2e --no-deps -g 'Escape during'`:1 failed, expected0/actual1 after native Escape with iframe focused.
- GREEN: `pnpm exec vitest run --project unit apps/web/src/lib/print-open.test.ts apps/web/src/lib/print.test.ts`:27 passed (both intents plus composition/consumed-key guards and existing print content tests).
- GREEN: `pnpm exec vitest run --project unit apps/web/src/lib/page.test.ts apps/web/src/lib/page-history.test.ts`:38 passed.
- GREEN: `pnpm --filter @terno/web exec playwright test -c playwright.print.dev.config.ts print.spec.ts --project=e2e --project=e2e-lumen --project=e2e-atelier --no-deps --grep-invert 'startup bundle'`:42 passed/0 skipped,40.2s.
- GREEN final added reader-position witness and screenshot capture: same command with `-g 'Escape during|accessible'` instead of grep-invert:9 passed/0 skipped,11.5s. No production edits between these runs.
- GREEN: `pnpm --filter @terno/web typecheck`.
- GREEN: `pnpm exec oxlint --deny-warnings apps/web/src/lib/print-open.ts apps/web/src/lib/print-open.test.ts apps/web/e2e/print.spec.ts apps/web/playwright.print.dev.config.ts` (again after final test additions).
- `git diff --check`: clean.

Personally inspected six light/dark screenshots across macOS/Lumen/Atelier. Sheet controls, labels, footer and contrast are intact; five captures show white preview paper before its content painted, while macOS light shows the fixture contents. These are UI-control inspection artifacts, not print-content visual qualification; unchanged content is asserted in the full scoped print spec. Development server logs ResizeObserver-loop notifications; all scoped behavioral assertions pass, no retries/waivers/timeouts changed.

No full gates, packaged smoke or performance suites run. Builder/layout are untouched; no startup or per-frame work introduced, only a constant key/state check in the existing keydown bridge. Bundle separation and release performance remain unqualified. The first diagnostic incorrectly combined base and dev webServer configs and inadvertently ran Vite build before a same-port collision; it is retained as an execution error, never qualification evidence. Subsequent config replaces webServer explicitly and all browser qualification used dev mode. No fetch/push/landing, desktop dependency or real-profile access.

## Single Standards+Spec production review
Exactly one completed native `codex exec -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C <checkout> -o /tmp/terno-print-escape/code-review.md <Standards+Spec prompt>` after implementation and targeted green: **Standards1 P2 / Spec0**. Finding: dev server port hardcoded57510 while inherited baseURL followed E2E_PORT. Added `print-dev-config.test.ts`, ordinary RED2/2 (default and alternate57530 both mismatched). Derive browser/server/command from one port, default57510; GREEN2/2. Exact command `pnpm exec vitest run --project unit apps/web/src/lib/print-dev-config.test.ts`. No second review. No remaining review findings/backlog.

Post-review harness change validation: original focused browser command `... --project=e2e --no-deps -g 'Escape during'`:1 passed,4.4s. Final Web types and strict owned lint (including print-dev-config.test.ts) pass. A static config import in the new test initially widened renderer typechecking to Playwright's custom fixture config and failed; runtime test loading keeps the dev runner out of the renderer compilation, then both config regressions and Web types pass. Product fix unchanged.

Screenshot output was cleared by Playwright's subsequent harness check, so regenerated only the six existing axe/capture cases with `... --project=e2e --project=e2e-lumen --project=e2e-atelier --no-deps -g accessible --output /tmp/terno-print-escape/retained-visual`:6 passed,9.2s. Artifact regeneration, not a retry seeking green. Prior visual inspection and all original qualifications remain recorded. Removed the accidental owned dist-e2e-57510 output. No no-op background processes retained.
