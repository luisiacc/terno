# Renderer release cluster: navigation and approved visuals

## Request (verbatim excerpts)

“Carry the bounded remaining renderer release cluster through proper diagnosis and targeted verification; return actual red/green/counts and limits, not just screenshots.”
“Preserve desired current approved behavior (no reverting search coverage/folder semantics for screenshots), product design/styles unaffected unless real defect.”
“Update ONLY these 2 matching light baselines if differences are proven intentional/stable, inspect new light+dark counterpart captures and retain ordinary assertions (no masks/maxdiff increases/viewport/font/query changes).”

## Evidence and short spec

Base a5e64261, isolated T3 checkout. Ownership: designs.spec.ts exact live Settings switch, print.spec.ts exact toolbar/menu/HTML/palette case, visual.spec.ts exact light search and category-picker cases and their two light full-page baselines. Do not change production without a reproduced defect. Plans15/43/52/54/69/70/75 guide preservation; Plans64–68 and held R2 policies remain read-only.

Unchanged functional reproduction passes 3/3: live Settings switch (macOS project) and print entry points (macOS + Lumen). Early-compose 6906b10c is already in ancestry. No product RED or product change is justified by these runs; the retained earlier Lumen timeout is not reproduced.

Exact ordinary visual reproduction fails 2/2 at existing screenshot assertions. Individually inspected retained EXPECTED and ACTUAL images: search title Inbox→Search, new wrapping local saved-mail coverage explanation and corresponding list displacement; All Accounts row removed, moving account rows/Add account up one row. Search data, reader, sidebar counts, picker geometry/options remain intact. Plan69 and thread-list.tsx SearchField explain the coverage text. Plan64 search-everywhere title is implemented in thread-list ListHeader; Plan67 explicitly says “All accounts goes away”; sidebar now maps AccountEntry directly. These approved changes must remain. No styles/design tokens, source images, queries, viewport, fonts, masks, tolerances or budgets will change.

Update only search.png and category-picker.png in the macOS visual directory after the native plan critique. Keep the existing snackbar snapshot/assertion and functional cases unchanged. Capture both cases anew in light and dark; dark captures are qualification artifacts, not committed baselines. Confirm new light captures against source-run RED images and retained production milestone ACTUAL images before accepting. Run the two visual cases plus the owned direct functional cases only; web package types and scoped/package lint. No hot-path algorithm change, so no perf run. No app/package/build/full suites or release clearance; dev screenshots qualify source CSS, not a newly shipped production bundle.

## Harness and safety

Temporary untracked Playwright config overrides BOTH inherited production webServer and global setup. Vite source server port56610; WEB_PORT56620 reserved. Existing synthetic template setup/cleanup; existing backend private fixture data. NODE_OPTIONS appends --require=/tmp/terno-network-guard.cjs to every test launch. Chromium uses an unreachable loopback proxy with only loopback bypass to block external requests. Playwright owns browser/server shutdown; no unrelated PID signals. Offline frozen install with scripts disabled was needed because node_modules was absent. No real profile/secret/provider or forbidden backend test access.

## Revisions after the Codex review

One native read-only plan critique completed exit0/DONE (gpt-6.1-sol, CLI default medium; plan-review.log), eight points accepted; exactly one completed native Standards+Spec review follows the final series. No children or nested reviewers. Fix review findings fail-first; after that cap only high correctness/data-loss changes, lower backlog.

Fresh source-run RED full-page actuals are pixel-identical (2880×1800, PIL ImageChops difference bounding box `None`) to the corresponding retained milestone production ACTUALs for both cases. The title source is confirmed in committed b0680c49; no inference from copy alone. Initial functional run:3/3 pass (17.3s). Exact visual RED:2/2 fail, screenshot assertions at visual.spec.ts:88 and171. Web package main+worker types and package oxlint pass. Initial no-node_modules invocation executed no tests; offline install resolved it. The first functional grep selected only3 functional tests, so visuals were explicitly selected in a separate invocation.

All eight critique refinements accepted: copy only the two reviewed ordinary RED ACTUAL PNGs to their exact authorized destinations (no update-snapshots run, preserving snackbar); dark counterpart qualification uses a temporary dev-only extraction of precisely these two test bodies with dark mode set before navigation and screenshot capture to /tmp (no additional baseline writes). Keep existing search-stats masks unchanged, so masked totals/indexing are not qualified. Preserve e2e project identity/path resolution. Live-switch evidence covers draft text, selected thread, card focus, row geometry/anchor and measured layout shift only; it does not qualify unread filter, older-message expansion, caret continuity or all Plan75 flashes. Review regression evidence will distinguish oracle gaps from product failures. Evidence and exact commands below.

## Lumen print readiness diagnosis

The first combined post-baseline run passes4/5 but reproduces the retained Lumen locator.fill timeout at print.spec.ts:120 (green.log; green-results/print-print-sheet-from-the-b4b58-n-HTML-mail-and-the-palette-e2e-lumen/trace.zip). The final accessibility snapshot still contains the **Print** dialog, not a palette. Trace timings: frame ⌘P at15260ms, sheet-visible at15275ms, scope-thread at15278ms, Escape at15280ms, blur at15282ms, ⌘K at15295ms. Visibility/scope do not establish initial focus transfer. PrintSheet explicitly sets DialogContent.initialFocus to primaryRef; Escape in the mail iframe does not bubble to the sheet. Ranked hypotheses: initial-focus readiness race; close-state race; stale prior sheet. The minimal caller correction asserts print-submit focus after the iframe chord before Escape and asserts sheet absence after each intermediate close, so later actions cannot accidentally operate under a retained sheet. No arbitrary waits or product changes. This is test-sequencing RED→GREEN, not evidence of lost product focus or a renderer repair. Existing toolbar focus, scope, output text/counts and keyboard entry assertions remain.

Dark counterpart extraction passes2/2 (dark.log,5.8s), including zero-violation scoped axe scans of search header and category picker. Both new light full-page images and corresponding dark captures were personally inspected: wrapping explanation, intact sidebar/account hierarchy, selected row/reader and centered usable picker; no clipping. Existing search-stats mask remains, so exact search totals/indexing are not qualified. The dark capture uses the same queries, target query, selected thread, readiness helpers and picker-focus assertion, dark mode before navigation. It writes PNGs directly to /tmp, no dark baseline. The first attempted dark run overlapped the still-running combined test server and failed port acquisition before any tests; after it completed the actual dark run passed. No process was signaled.

## Exact commands and evidence ledger

Run from this isolated worktree. Temporary config retained at `/tmp/terno-release-navigation-visual/config.ts` (copy to `apps/web/playwright.release-navigation.local.config.ts` to replay); dark extraction at `dark-capture.dev.ts` (copy to `apps/web/e2e/release-dark.local.dev.ts`). Neither is a product/discovery change. Common test prefix:

```sh
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" E2E_PORT=56610 WEB_PORT=56620 pnpm --config.verify-deps-before-run=false --filter @terno/web exec playwright test -c playwright.release-navigation.local.config.ts
```

Append these exact selectors:

- Initial unchanged functional (`red.log`): `--project=e2e --project=e2e-lumen designs.spec.ts print.spec.ts visual.spec.ts --grep 'live, from Settings|from the toolbar|light › search results|light › category picker'` →3pass; the visual terms selected no tests.
- Ordinary visual RED (`visual-red.log`): `--project=e2e visual.spec.ts --grep 'light search results|light category picker'` →2fail at screenshot assertions, no product failure. Images in `red-results/visual-light-search-results-e2e/search-actual.png` and `red-results/visual-light-category-picker-and-the-snackbar-after-filing-e2e/category-picker-actual.png`.
- Combined post-baseline (`green.log`, RELEASE_RESULTS=/tmp/terno-release-navigation-visual/green-results): `--project=e2e --project=e2e-lumen designs.spec.ts print.spec.ts visual.spec.ts --grep 'live, from Settings|from the toolbar|light search results|light category picker'` →4pass/1Lumen print timeout, preserved trace above.
- Final GREEN (`final.log`, RELEASE_RESULTS=/tmp/terno-release-navigation-visual/final-results), identical selector after the print readiness correction →5pass/15.2s. No repeated unchanged run-until-green.
- Dark qualification (`dark.log`, RELEASE_DARK=1 RELEASE_RESULTS=/tmp/terno-release-navigation-visual/dark-results): `--project=dark-capture` →2pass/5.8s; no committed dark baselines. `dark-search.png`, `dark-category-picker.png`, `dark-category-snackbar.png` stay outside checkout.

The two committed destinations are `apps/web/e2e/__screenshots__/visual.spec.ts/search.png` and `apps/web/e2e/__screenshots__/visual.spec.ts/category-picker.png`. Each equals its ordinary RED ACTUAL and matching production milestone ACTUAL at `/tmp/terno-release-milestone-b8pxg8w6/04-e2e-test-results/e2e/<same-test-directory>/<name>-actual.png` pixel-for-pixel. Only those PNGs changed; category-snackbar.png is unchanged and its final ordinary assertion passes. No image editing or snapshot-update batch occurred.

Checks (all with the same NODE_OPTIONS append):

```sh
pnpm --config.verify-deps-before-run=false --filter @terno/web typecheck
# types.log: main+worker pass
pnpm --config.verify-deps-before-run=false exec oxlint --deny-warnings apps/web
# lint.log: pass
pnpm --config.verify-deps-before-run=false exec oxlint --deny-warnings apps/web/e2e/print.spec.ts apps/web/e2e/release-dark.local.dev.ts apps/web/playwright.release-navigation.local.config.ts
# scoped-lint.log: pass after print correction
git diff --check
# pass
```

Distinct normal coverage:5 owned project/case combinations plus2dark capture counterparts. Development executions:3initial pass,2visual fail,4pass/1Lumen fail,2dark pass,5final pass =17executions (14pass/3fail); missing-dependency and occupied-port invocations executed0. Final correctness is limited to those assertions, source-run rendering and scoped axe, not production packaging, entire Plan15/43/75, real providers or release readiness. No hot-path source changed, so no perf gate was run. No UI copy changed; en/es remain untouched. Root owns serial landing and downstream verification.
