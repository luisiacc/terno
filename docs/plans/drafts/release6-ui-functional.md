# Release 6 UI functional repair

Base: 7bc3b97dc040cae83db648e47e52d69e99a3f272 (clean isolated checkout).

## Request and scope
Implement the assigned sixth-milestone attachment-controls, drag/drop, reply-source, account-recovery and autocomplete functional corrections, preserving current review/snackbar/sidebar/filter behavior. Reproduce current source before fixing. Original perf.spec.ts is read-only; investigate its sustained-j lumen compact failure (historical longest frame 700 ms, threshold 50 ms) without loosening its workload or assertions. No release-green claim.

## Existing behavior and design
Plans 18, 24, 25 and 81 describe learned ghost text, list navigation, reconnect controls and current stacked offers. The historical report records missing artifact parent directories, ambiguous source text, an unread count mismatch, a PageDown visibility failure and an absent reply ghost. First run the exact affected cases on current source, once, using desktop source-dev and isolated synthetic providers. Only correct demonstrated fixture readiness or behavioral defects. Preserve row counts, Undo, accessible labels, tooltips, native IME, focus, scroll and draft contents.

## Verification
Fail-first original cases; then full five owned specs across their configured design projects. Scoped web types/lint and exact test/config type checking. Source-dev original list control once initially; qualify again only after causal source correction. All tests inherit network guard; browser external requests blocked. Unique evidence directories retain failures; no production builds or broad suites. Any renderer UI correction requires keyboard/axe and inspected light/dark screenshots. One native gpt-6.1-sol/high read-only Standards+Spec review after coherent focused green, with fail-first fixes; no second review. Lower findings discovered afterward go to backlog.

## Out of scope
Backend/store/richtext/vendor/lockfile, plans 64–68, other owners and main/worklists, production qualification and landing.

## Revisions after the Codex review
Native gpt-6.1-sol/high read-only plan critique: /tmp/terno-release6-ui/plan-review.txt (10 points). Adopt unique per-test artifacts, pinned drag identity/read-state preconditions, message-scoped arrival witness and explicit design selection. E2E_PORT is always exported, making inherited baseURL correct; set it explicitly in the dev config as well. No blanket production qualification from source-dev. Current account-errors.spec.ts is still the original PageDown case (the critique's references to composer-account-recovery do not replace it). Keep original draft/focus/selection assertions. No autocomplete warming or IME claims without a reproduced defect.

Initial reproduction: 22 selected cases, 21 PASS/1 FAIL (Lumen drag count expected4 received3). Other historical failures unreproduced in this pass. Source-dev sustained-j Lumen compact: PASS, 300 moves, 2.96 row renders/move, frame p95 16.7/max16.8ms. No list source change or second qualification justified.

Evidence handling limitation: the initial attachment reproduction wrote its existing hardcoded evidence files before the directory was archived; pre-run versions of those particular files were not preserved. The initial perf invocation also reused the initial functional outputDir, losing that failure's trace; its full log remains. Subsequent runs use stage-specific outputDirs and per-test artifacts. These are evidence preservation errors, not product clearance.

## Causal findings and repair
- Original drag case failed on current source: opening its unread row starts the existing 450ms read dwell, racing a category-unread count assertion. Pin the ID, open it and observe the one-shot dwell complete, restore unread through the normal threads.act RPC, then drag that same already-open row. Preserve before+1, unread state, category membership and exact Undo assertions. No read/dwell runtime change.
- Missing artifact parent was masked by a preexisting /tmp directory. Archive the directory, then the original test fails ENOENT on current source. Use Playwright testInfo.outputPath for both JSON and screenshots; Playwright creates the parent and isolates each design.
- Original global new-source locator passed before both updates painted; requiring the reader body and row snippet makes its strict-mode ambiguity fail. Retain both witnesses and scope the body witness to reader; retain all SMTP original-source assertions.
- The owned-spec run reproduced account-errors line172 false visibility. Personally inspected historical and current final trace screenshots: native PageDown overshoots the marker into settings sections below it. Current trace has four presses at60974.633,61032.429,61091.659,61133.737ms. The loop measures intermediate smooth-scroll positions and queues another page before completion. Observe scrollend for each actual key-driven page before evaluating whether to continue; do not extend waits, mutate scroll positions/focus or relax the visibility assertion.
- Initial and full-run ghost coverage remains the original cold first-use path. No absent-ghost defect established; no warmup, sleep or runtime correction.
- Scoped test type RED: autocomplete event.key on Event and original shared config's design fixture type. Narrow the event with instanceof KeyboardEvent; use a scoped standalone typed source-dev config with the original project filters, expectations, workload and native test limits. App types and scoped lint pass.

Initial source-dev baseline and historical production timing remain separate. Original perf.spec.ts bytes unchanged; no qualification rerun without a causal runtime change. Full milestone successors remain NOTRUN historically; no blanket timing waiver.

## Verification progress before code review
- Current original-case baseline: 21PASS/1FAIL (drag); isolated absent-directory/two-witness controls: 2FAIL (ENOENT and strict-mode ambiguity).
- Corrected attachment/drag/reply focused selection: 7PASS.
- First full five-file selection: 163PASS/6FAIL; all six are account-errors line172 visibility (Lumen settings combinations), not autosave failures. Intermediate expect.poll callback failures in trace are not final failures. Later assertions after line172 were unreached for those six.
- Event-based native-scroll correction retains PageDown, the20-page cap, the exact marker visibility and scroll-progress assertions, and native test/expect deadlines. Browser scrollend is observed per page; no delayed retries, direct scroll assignment or focus restoration introduced.
- App typecheck PASS; final scoped five-test/config typecheck PASS; scoped strict lint PASS. Test-only changes have no product runtime/perf/memory/network cost. No product UI/copy changed. Personally inspected Lumen attachment light/dark shots (labels and offline tile readable), plus historical/current account trace end frames. Existing keyboard and axe cases remain enabled.

## Exact commands and evidence
All test/type/lint commands run via `/tmp/terno-release6-ui/run.py` with inherited `NODE_OPTIONS` appended by ` --require=/tmp/terno-network-guard.cjs`, `E2E_PORT=58210`, `WEB_PORT=58220`, `npm_config_verify_deps_before_run=false` (after initial invocation), and distinct `R6_STAGE`. Browser proxy/resolver rules block external requests. Ports58210/58220/58221 checked free; no occupant signalled.

- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e --project=e2e-lumen --project=e2e-atelier attachment-controls.spec.ts dnd.spec.ts reply-subject.spec.ts account-errors.spec.ts autocomplete.spec.ts --grep 'reader attachment controls|one row: ghost|untouched Reply|long account refusal \(lumen, (es, light|en, dark|es, dark), settings\)|in a reply, Esc'` — baseline; log `/tmp/terno-release6-ui/baseline.log`; exit 1.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=perf perf.spec.ts --grep 'sustained j at key-repeat rate \(lumen, compact\)'` — perf-baseline; log `/tmp/terno-release6-ui/perf-baseline.log`; exit 0.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e attachment-controls.spec.ts reply-subject.spec.ts --grep 'reader attachment controls|untouched Reply'` — artifact-locator-red; log `/tmp/terno-release6-ui/artifact-locator-red.log`; exit 1.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e --project=e2e-lumen --project=e2e-atelier attachment-controls.spec.ts dnd.spec.ts reply-subject.spec.ts --grep 'reader attachment controls|one row: ghost|untouched Reply'` — focused-green; log `/tmp/terno-release6-ui/focused-green.log`; exit 0.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e --project=e2e-lumen --project=e2e-atelier attachment-controls.spec.ts dnd.spec.ts reply-subject.spec.ts account-errors.spec.ts autocomplete.spec.ts` — full-owned; log `/tmp/terno-release6-ui/full-owned.log`; exit 1.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e --project=e2e-lumen --project=e2e-atelier account-errors.spec.ts --grep 'long account refusal \(lumen, (es, light|en, dark|es, dark), settings\)'` — recovery-green; log `/tmp/terno-release6-ui/recovery-green.log`; exit 0.
- `pnpm --filter @terno/web exec tsc -p tsconfig.release6-ui.json` — test-types; log `/tmp/terno-release6-ui/test-types.log`; exit 1.
- `pnpm --filter @terno/web exec tsc -p tsconfig.release6-ui.json` — test-types-corrected; log `/tmp/terno-release6-ui/test-types-corrected.log`; exit 0.
- `pnpm --filter @terno/web exec tsc -p tsconfig.release6-ui.json` — final-test-types; log `/tmp/terno-release6-ui/final-test-types.log`; exit 0.
- `pnpm --filter @terno/web typecheck` — app-types; log `/tmp/terno-release6-ui/app-types.log`; exit 0.
- `pnpm exec oxlint --deny-warnings apps/web/src apps/web/e2e/attachment-controls.spec.ts apps/web/e2e/dnd.spec.ts apps/web/e2e/reply-subject.spec.ts apps/web/e2e/account-errors.spec.ts apps/web/e2e/autocomplete.spec.ts apps/web/playwright.release6-ui.config.ts` — lint; log `/tmp/terno-release6-ui/lint.log`; exit 0.
- `pnpm exec oxlint --deny-warnings apps/web/src apps/web/e2e/attachment-controls.spec.ts apps/web/e2e/dnd.spec.ts apps/web/e2e/reply-subject.spec.ts apps/web/e2e/account-errors.spec.ts apps/web/e2e/autocomplete.spec.ts apps/web/playwright.release6-ui.config.ts` — final-lint; log `/tmp/terno-release6-ui/final-lint.log`; exit 0.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e --project=e2e-lumen --project=e2e-atelier attachment-controls.spec.ts dnd.spec.ts reply-subject.spec.ts account-errors.spec.ts autocomplete.spec.ts` — final-owned; log `/tmp/terno-release6-ui/final-owned.log`; exit 0.

Plan critique: native `codex exec -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C <this checkout>`, output `/tmp/terno-release6-ui/plan-review.txt`. The one Standards+Spec code review uses the same native model/settings, prompt `/tmp/terno-release6-ui/code-review.prompt`, output `/tmp/terno-release6-ui/code-review.txt`. No second review.

## Single Standards + Spec code review
Actual native gpt-6.1-sol/high, read-only, exit0: `/tmp/terno-release6-ui/code-review.txt` (model/settings header in code-review.log). Exactly one round. Finding: P2, Promise.all can dispatch PageDown before asynchronous locator resolution registers scrollend. No other actionable findings or suggestions. Add a synthetic delayed-locator/immediate-scrollend control before fixing; await observer handle registration before dispatch, then await completion. The100ms synthetic readiness timer injects the review's race only; it changes no original workload, readiness timeout, scroll duration or gate budget. No second review/fallback.

Final five-file pass before the review correction:169PASS,0FAIL,0SKIP (2.6m). This includes original cold ghost path, keyboard/axe, original snapshots (no updates), and all configured design filters (untagged reply cases run in the default project). The post-review helper correction requires its own control plus the affected account-errors file, not another unchanged full five-file run.

Limits/backlog: historical Atelier absent ghost not reproduced, so no behavioral fix claimed; production list700ms failure not reproduced/qualified by this source-dev16.8ms result. Preserve historical48NOTRUN successors. Vite emitted ResizeObserver-loop warnings during some reader operations; no causal product change or blanket noise waiver made. No product runtime/native IME/build/package/full-suite qualification. Main remains not release-green.

Review disposition: P2 confirmed fail-first. The delayed-locator/immediate-scrollend control failed at the native45s test deadline under the concurrent helper, then passed in264ms with explicit observer registration. The helper holds a browser-side promise in a JSHandle, awaits handle creation, dispatches PageDown, awaits completion and disposes the handle. No production/source-runtime changes or second review. Post-review strict lint/typecheck PASS. Full affected account-errors file is the final focused verification.

Additional exact commands (same guarded environment):
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e account-errors.spec.ts --grep 'PageDown observes completion'` — review-ordering-red; log `/tmp/terno-release6-ui/review-ordering-red.log`.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e account-errors.spec.ts --grep 'PageDown waits for locator readiness'` — review-ordering-green; log `/tmp/terno-release6-ui/review-ordering-green.log`.
- `pnpm --filter @terno/web exec tsc -p tsconfig.release6-ui.json` — reviewed-types; log `/tmp/terno-release6-ui/reviewed-types.log`.
- `pnpm exec oxlint --deny-warnings apps/web/src apps/web/e2e/attachment-controls.spec.ts apps/web/e2e/dnd.spec.ts apps/web/e2e/reply-subject.spec.ts apps/web/e2e/account-errors.spec.ts apps/web/e2e/autocomplete.spec.ts apps/web/playwright.release6-ui.config.ts` — reviewed-lint; log `/tmp/terno-release6-ui/reviewed-lint.log`.
- `pnpm --filter @terno/web exec playwright test -c playwright.release6-ui.config.ts --no-deps --project=e2e --project=e2e-lumen --project=e2e-atelier account-errors.spec.ts` — reviewed-account; log `/tmp/terno-release6-ui/reviewed-account.log`.

## Supervision and preservation limits
Guarded command roots have PID/birth/argv metadata in stage.process.json; descendant identities were sampled for long-running passes/review, not exhaustively captured at every fork. The initial tool-managed plan critique has its native session log but no separate shell PID ledger. No signals or external deadline terminations were used; each test/review command returned naturally. Screenshot restoration manifest: `/tmp/terno-release6-ui/artifact-restoration.json`. Autocomplete/reply original hardcoded directories restored after archiving generated passes; attachment directory restored to its preserved post-initial-run state (the initial overwrite limitation above remains). All later failure traces retained in unique stage-results directories.

## Final disposition
Post-review account-errors:61PASS/0FAIL/0SKIP (1.2m), including the new immediate-scrollend regression and all existing recovery/keyboard/axe cases. Before that one review correction, all five owned files:169PASS/0FAIL/0SKIP. Final scoped test/config types and lint PASS; app types PASS. No further implementation changes or review rounds. Captured owned identity audit: `/tmp/terno-release6-ui/final-process-audit.json` (no matching survivors, no signals).

Safe coherent outcome is a test-fixture repair only: no demonstrated renderer product defect, no new list runtime optimization, no ghost first-use workaround, no release-green claim. Root retains serial integration and full production qualification responsibility.

## Root integration — 2026-10-30

Rebased onto main1a8f21f9with all current user changes preserved, then Root passes the entire five-file set **170/170**, including the post-review PageDown ordering regression. Web main/worker types, exact test/config types, strict owned lint and whitespace pass. Root inspected light/dark attachment controls and long-error end markers; keyboard/axe and exact unread/count/Undo/source-link controls remain. Evidence `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-root-ui6-i57i8mqx`, unique browser results referenced there. Shared autocomplete/reply screenshot directories restored to their pre-Root state.

The single native review's P2 received the recorded fail-first fix; no second review or runtime change. Original production700ms list failure and historical ghost absence remain unqualified/unattributed. Root did not rerun the unchanged scroll gate without causal runtime source; worker source-dev16.8ms is only its recorded baseline. The sixth milestone's48NOTRUNsuccessors remain NOTRUN. No snapshots, performance oracle or broad-gate changes. Full release remains not green.
