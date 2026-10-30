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
