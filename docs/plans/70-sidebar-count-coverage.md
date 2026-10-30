# 70 · Sidebar unread count coverage (W11 / A13)

## Request

> Folder counts must know whether local coverage is complete. Determine precisely what current count badges mean (unread threads/messages/local saved view vs provider totals), how retention and incomplete sync affect them, and what presentation currently promises. Goal truthful understandable local coverage, not provider-parity fetches or new global completeness flags.

## Evidence and design

Plan 68 describes unread thread membership per listed custom folder; SQLite `getCounts`/`folderUnreadCounts` and IndexedDB `getCounts`/`folderUnreadCounts` count locally stored unread threads. Inbox and categories also count unread threads. Folder membership uses thread unread state, including when its unread message is elsewhere in the thread; spam/trash exclusion follows membership. Initial sync and the configured sync window can leave mail absent; existing saved older mail may remain, so the window is not a hard cutoff. No count response proves provider completeness or freshness. Sidebar numbers are bare and zeros absent. Account badges are Inbox counts except while an expanded multi-account row delegates that count to its Inbox child. Suggestion badges are a different count.

Add one shared accessible description and concise on-demand tooltip for unread count rows explaining that counts are unread conversations saved in Terno and may be incomplete. Do not describe suggestion badges as unread or assert an empty provider folder. Do not change count data, requests, focus, row batching or navigation. English and Spanish together. Preserve existing search help.

## Verification and limits

Fail first on missing accessible description/tooltip. Focused dev-only synthetic tests cover a folder's local unread thread count (including multiple messages in a thread), zero/loading and ordinary inbox/account/category controls, English/Spanish, keyboard and scoped axe, and light/dark screenshots inspected outside the checkout. No provider calls, schema/query changes, global completeness status, remote totals, new polling, or production builds. Run only touched-package types/lint and directly affected tests. No perf gate unless rendering algorithm changes.

## Revisions after the Codex review

Native read-only Codex critique (`gpt-6.1-sol`, high; `/tmp/terno-a13/plan-review.txt`) returned eight points. Accepted: describe account badges as Inbox counts; attach descriptions independently of zero/missing counts, excluding suggestion and grouping rows; distinguish folder membership from thread-level unread state (spam may contribute to unread, trash does not); retain a persistent accessible description and test tooltip focus, dismissal, pointer interaction, portal axe and unchanged navigation. Existing inbox shortcut tooltip must remain usable, and any trigger must reach the actual button. Test old cached and header-only saved mail as well as absent provider mail; do not infer empty provider state. Use an explicitly selected dev-only test and guard production discovery. Both stores' existing count implementations were inspected; new store tests are outside this slice's ownership, so renderer fixtures and existing store conformance are the available boundary.

## Investigation status

The first dev-only UI test failed on the missing Inbox accessible description (`/tmp/terno-a13/red.log`). The change associates a shared persistent description with eligible rows and renders the on-demand help through a trigger on the actual button. Account rows name Inbox; the expanded multi-account row delegates help to its Inbox child. The Inbox shortcut is retained. SQLite and IndexedDB public count API fixtures cover empty, older header-only, unread elsewhere in the conversation, spam and trash. Synthetic UI tests cover missing and positive badges, en/es, light/dark, keyboard, pointer, tooltip portal axe and no provider or external browser calls. Four screenshots were inspected in `/tmp/terno-a13/screenshots/`. Code review and final checks follow.

## Code review

R1 (native read-only Codex, `gpt-6.1-sol` high, `ccfa0291..645d3df7`; `/tmp/terno-a13/review-r1.txt`) reported five findings. The P1 focus loss was reproduced by Enter on an account (`/tmp/terno-a13/r1-red.log`) and fixed by keeping the tooltip tree mounted while disabling it on the expanded multi-account parent; the same test passed (`/tmp/terno-a13/r1-green.log`). The other points strengthened dismissal and pointer-only popup tests, added two unread messages in one conversation to both store fixtures, and covered missing counts, a grouping row, suggestions and single-account disclosure. Those test-only additions protect existing behavior; no separate product RED is claimed for them. The review's full-suite and production UI-perf recommendation conflicts with the user's explicit bounded verification instructions. Row batching and render-probe calls were not changed, but no new rendering-cost measurement is claimed.

R2 (native read-only Codex, `gpt-6.1-sol` high, `ccfa0291..043c9ece`; `/tmp/terno-a13/review-r2.txt`) returned Standards PASS and Spec PASS, zero findings. No R3 or post-R2 product change.

## Final targeted verification

- `E2E_PORT=55320 WEB_PORT=55330 pnpm --filter @terno/web exec playwright test -c playwright.count-coverage.config.ts`: 5/5 pass (`/tmp/terno-a13/r1-e2e.log`). The test intercepts the managed `google.request` and direct fetch seams in the synthetic provider context, records no provider calls or external browser requests, and includes scoped sidebar and popup axe checks. The simulated empty-count state is the renderer's initial `EMPTY_COUNTS`, not a delayed real bootstrap.
- `pnpm exec vitest run --project unit apps/web/src/lib/count-coverage-config.test.ts packages/i18n/src/i18n.test.ts packages/db/src/count-coverage.test.ts packages/idb/src/count-coverage.test.ts`: 4 files, 23/23 pass (`/tmp/terno-a13/unit-final.log`). The dev spec is excluded from production discovery.
- `pnpm --filter @terno/web --filter @terno/i18n --filter @terno/db --filter @terno/idb --filter @terno/store typecheck`: pass (`/tmp/terno-a13/typecheck-final.log`).
- `pnpm exec oxlint --deny-warnings apps/web/src/components/sidebar.tsx apps/web/src/lib/count-coverage-config.test.ts apps/web/e2e/count-coverage.dev.ts apps/web/playwright.count-coverage.config.ts packages/i18n/src/locales/en.ts packages/i18n/src/locales/es.ts packages/db/src/count-coverage.test.ts packages/idb/src/count-coverage.test.ts packages/store/src/conformance/count-coverage.fixture.ts`: pass (`/tmp/terno-a13/lint-final.log`).

Four screenshots in `/tmp/terno-a13/screenshots/count-{en,es}-{light,dark}.png` were personally inspected after R1. No production build, full suites, packaged smoke, provider request, real profile or secret was used. Existing batching is unchanged; the cost of the additional tooltip roots was not independently benchmarked. No status field determines provider completeness or freshness.
