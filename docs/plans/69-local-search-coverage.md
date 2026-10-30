# 69 · Local search coverage (W11 / S58)

## Request

> Scenario: Gmail API results differ from alias-expanded/thread-wide provider UI results; communicate or implement the chosen parity rather than treating absence as deletion. The worklist's selected outcome is to document and test incomplete local search/retention coverage without promising Gmail UI parity. Do not add provider-side search.

> Preserve the user's Plan64 behavior: all accounts/categories and archived/Spam/Trash included by default; explicit typed operators narrow; instant performance and spam-icon privacy remain. Existing placeholder says "Search all your accounts". Investigate whether the UI already makes local/downloaded/indexing scope sufficiently clear. If missing, add the smallest calm, accessible English/Spanish clarification when search is opened or its results are shown.

## Current behavior

At committed local main `9831549d`, Plan64 sends the typed query plus quick filter to `threads.search`, with no sidebar account/category narrowing. SearchField's placeholder names account breadth; the result statistics append `indexing` only when the existing response's `complete` is false. Neither explains local mail coverage. This completeness flag is not a full-provider retention or Gmail UI parity guarantee. Plan03 searches locally stored message documents with same-message semantics; Gmail UI alias expansion/thread-wide matching is a different contract (report scenario 58, worklist W11/S58). Absence from a result set does not establish provider deletion.

## Design

Keep the placeholder. Add a quiet, wrapping, muted paragraph immediately below the search field while it has focus or a nonempty query. With no search interaction or results it is absent, including designs with an always-visible field. The input has an explicit localized accessible name and `aria-describedby` referring to the visible paragraph. No live region, focus target, warning icon or dismissal. Use existing text tokens. Keep all existing Escape/Enter/ArrowDown behavior.

English: “Search covers mail saved in Terno, which may be incomplete. Check your mail provider’s website if something is missing.” Spanish ships with it. Do not imply all historical mail or message bodies are downloaded. Preserve actual response-driven indexing copy; no inferred status or percentage.

## Tests

Before implementation, a focused dev-only Playwright test must fail on missing contextual help/accessibility. Verify en/es, light/dark, button and always-visible search designs; keyboard opening/name/description, result and empty states, blur persistence while searching and cleanup after clearing, existing Escape and field-close focus. Observe real dev-backend RPC requests for unchanged typed operators and quick filter, no sidebar account/category scope, and no provider sync/mutations or external browser traffic caused by the clarification. Synthetic saved mail and absent older/provider-only mail demonstrate the coverage contract without live-provider claims. Scoped axe and personally inspect light/dark screenshots. Run directly affected renderer state tests and i18n tests plus touched package typechecks and focused lint. Existing Plan64 privacy/place tests remain protection; exercise appropriate focused cases through the dev config.

## Performance and out of scope

Static copy and local focus state only; no search hot-path, row/list virtualization, render subscriptions, engine or query changes. No perf reruns for static copy. No provider-side search, Gmail/IMAP/backend/core/store/schema edits, retention backfill, traffic, polling, startup work, scans, caches, status framework, completeness percentages or provider UI parity. Durable Gmail reconciliation belongs to W03, IMAP IDLE to W06; no dependency requested. No worklist/main edits, production builds or full suites. Never access the user's untracked backend test or real profiles/secrets.

## Revisions after the Codex review

Native `codex exec -s read-only -C <this worktree> -m gpt-6.1-sol -c model_reasoning_effort='"high"'` plan critique completed with four actionable points (`/tmp/terno-s58/plan-review.txt`). Accepted all four:

- `complete` in the renderer RPC combines exactness **and** zero pending bodies. Test real header-only mail and its actual false response, alongside a true response before ingesting it. Keep existing indexing wording, independent of the static coverage note.
- Assert the scroller offset/selected row across empty-field focus/blur, narrow Spanish included, and preserve the caret while typing. Local focus state must not remount the field or list.
- Use `apps/web/playwright.search-coverage.config.ts`, explicitly defining a Vite development server and only these specs. Run `E2E_PORT=54660 WEB_PORT=54670 pnpm --filter @terno/web exec playwright test -c playwright.search-coverage.config.ts ...`; never inherit the production server. Existing global setup prepares synthetic fixture data and the test incoming worker, not the app bundle.
- Gate help out of category review even if its existing field has focus/query; test review mode without changing suggestion/search behavior.

RED before implementation: one `macos, en, light` dev-only case failed at the accessible description assertion (expected scope copy, received empty string). The placeholder's existing accessible name already passed. The new test adds scope clarification; existing Plan64 semantics are protection to qualify, not newly implemented search behavior.

## Code review and qualification

Native code review R1 (`9831549d..f53dc219`, same read-only model/high-effort command) returned Standards PASS and one Spec P2: default production Playwright discovery would collect the Vite-only spec. Fixed by naming it `search-coverage.dev.ts` and selecting it explicitly in the dev config. The new `search-coverage-config.test.ts` first failed with production discovery listing eight cases instead of zero (`/tmp/terno-s58/r1-red.log`), then passed with production discovery at zero and dev discovery at eight. `--list` only collects the matching file; it does not start a server, build the app or execute the production suite.

Test-only corrections during qualification: await the actual scroll event before measuring focus-induced layout changes; use Lumen's existing Unread chip; navigate back to Inbox before expecting Inbox rows after clearing an empty narrowed scope; distinguish connectivity notification `sync.network` from requested synchronization `sync.now`; mark synthetic messages read on arrival so the reader's existing delayed mark-read is not mistaken for a search-triggered mutation. These were harness assumptions, not product regressions or extra provider behavior. Only the missing scope description and the R1 discovery issue have claimed RED evidence.

The new UI cases observe real WebSocket requests/responses against isolated synthetic backends: the default query has only `query`/`limit`, even after setting both account and category; explicit `in:all account:… subject:…` plus `filter: unread` arrive unchanged. An absent provider-only token has zero local results with `complete: true`; saved header-only mail remains in the database and is found by subject, while its absent body token does not match and actual response `complete: false` retains the existing localized indexing text. No provider sync/execute, external browser request, sync.now, thread mutation or body-load RPC is observed in the coverage cases. No deletion or provider-parity inference is made.

Scoped header axe passes in en/es, light/dark, macOS/Lumen; existing Plan64 populated-list axe and spam icon transition tests also run. Personally inspected all eight generated coverage screenshots, including 980px Spanish. The paragraph wraps without clipping and keeps the input name/description, selected row, scroll offset and keyboard flow. Existing empty-list `aria-required-children` outside the header was observed during an initially broader axe check; that unchanged listbox has no option children. It remains a separate accessibility limit; this slice claims scoped header coverage, not empty-list axe cleanliness.

R2 (final, `9831549d..b5c6c0a4`) returned **Standards PASS / Spec PASS, zero findings**, confirming R1's discovery fix. Review output: `/tmp/terno-s58/code-review-r2.txt`. No R3, unresolved review objections, shared-file dependency or post-R2 code change. The separate empty-list accessibility limit above is outside this slice, not an R2 finding.

## Final targeted verification

All executed final checks passed (53 tests total; no skipped UI cases):

```sh
pnpm exec vitest run --project unit apps/web/src/lib/search-coverage-config.test.ts apps/web/src/state/list.test.ts apps/web/src/lib/sender-icons.test.ts packages/i18n/src/i18n.test.ts
# 4 files, 34/34 tests; /tmp/terno-s58/unit-final.log

E2E_PORT=54660 WEB_PORT=54670 pnpm --filter @terno/web exec playwright test -c playwright.search-coverage.config.ts
# 19/19 tests, 31.8s; /tmp/terno-s58/e2e-final-green.log

pnpm --filter @terno/web --filter @terno/i18n typecheck
# Both packages pass (including web worker types); /tmp/terno-s58/typecheck-final.log

pnpm exec oxlint --deny-warnings apps/web/src/components/thread-list.tsx apps/web/src/lib/search-coverage-config.test.ts apps/web/e2e/search-coverage.dev.ts apps/web/e2e/search-coverage.setup.ts apps/web/playwright.search-coverage.config.ts packages/i18n/src/locales/en.ts packages/i18n/src/locales/es.ts
# Pass, no warnings; /tmp/terno-s58/lint-final.log

git diff --check
# Pass
```

Eight inspected screenshots are retained independently of this checkout in `/tmp/terno-s58/screenshots/search-coverage-{macos,lumen}-{en,es}-{light,dark}.png`. The focused setup removes only its own synthetic template after each run; each coverage case closes its backend and removes its own temp data. Playwright owns its dev server/browser lifecycle. The earlier interrupted failing harness run was stopped by its captured owned runner PID only.

Installation used `pnpm install --offline --frozen-lockfile --ignore-scripts` (no downloads). No app/Vite production build, packaged path, full suite, perf suite, live provider, real profile/secret, main/worklist edit, fetch, push or landing was performed. No new latency/render-count measurement is claimed: search/list algorithms and row rendering are unchanged, and existing targeted controls were qualified. Remote Gmail UI parity, full historical/body coverage and durable reconciliation remain unclaimed; there is no shared-file dependency for this clarification.
