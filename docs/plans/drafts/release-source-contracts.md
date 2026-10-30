# Release source/catalog contracts

## Request and scope

Fix the four remaining milestone source/catalog failures: localized free-text roundtrip, portable public-entry graph, hardcoded fixture label, and test-only selection setter classification. Preserve approved SMTP copy, persisted references/params/plaintext/legacy decoding and renderer localization. Do not change transport behavior, keyboard/compose-focus, database production, worklist or plans 64–68. Run targeted tests and touched package types/lint only, with the network guard; one native read-only plan critique and exactly one completed Standards + Spec review.

## Evidence and design

Baseline 8da884d8; `/tmp/terno-source-red.log`: four failures, 30 passing tests. Existing plans 04 and 14 define browser portable entries and source scanning. The requested draft was absent in this checkout.

The regex scanner mistakes TSImportType nodes for dynamic imports: backend/core.ts's ProviderOp reference follows @terno/mail's native barrel; mail/types.ts's RecipientOutcome reference follows SMTP and compose. An independent Babel AST traversal of actual value imports from backend/portable.ts reports no node edges. The browser worker imports backend/portable and mail/portable directly; vite has no mail stubs or aliases. Correct the scanner by stripping erased TypeScript syntax before following imports, retaining every current public-entry assertion and native-entry controls. Add fail-first synthetic graph controls for type-only references versus actual value imports, re-exports and dynamic imports. No production seam change is warranted by this evidence.

The forward helper contains only fixture setup/mocks and is imported by three .test.tsx callers. Move it to lib/test/forward-raw-obligation.tsx, the existing skipped test-directory convention; fix relative imports including mocked paths. It cannot match Vitest's .test pattern. Add temporary repository controls proving i18n and selection scans skip helpers but still catch equivalent production violations. Keep i18n scanner unchanged; selection scanner adopts the existing test-directory convention.

Update localized expectations to approved English SMTP text; assert exact stored bytes, legacy decode and Spanish renderer translation.

## Validation and limits

Target the four failing files, the three helper callers, and web worker provider tests. Run core/db/i18n/web typechecks and lint touched files. No app build, full suite, e2e, packaged smoke or performance runs: explicitly out of this task's scope. No UI behavior change. Synthetic temp fixtures only; append /tmp/terno-network-guard.cjs to NODE_OPTIONS for all tests.

## Revisions after the Codex review

One read-only native critique completed (`/tmp/terno-source-plan-review.log`), six points accepted: preserve syntactic value imports even when bindings occur only in types, including inline named type imports; cover side-effect imports; use soft assertions so independent graph controls all execute; distinguish i18n characterization from fail-first selection coverage; update all static/mock/type/dynamic relative helper paths and run all three callers; use exact serialized bytes, independent legacy JSON and translate() in Spanish. The graph scanner remains a literal-import guard (computed specifiers and import-shaped comments/string contents are outside its existing contract); stripping corrects the proven erased-type bug without claiming bundle clearance.

## Implementation evidence

No production files changed. Node's strip-only mode cannot parse constructor parameter properties in this graph; use `stripTypeScriptTypes(..., { mode: "transform" })` instead. Controls preserve ordinary imports used only in types and empty runtime imports after inline named type removal. Added side-effect and single-quote matching without allowlists. Re-running the complete controls against the original graph scanner (`/tmp/terno-source-portable-controls-red.log`) demonstrates both erased-type false positives and its missed side-effect import. i18n directory coverage is characterization; selection directory coverage failed before the fix (`/tmp/terno-source-controls-red.log`).

Exact checks (all test invocations prefix `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs"`):

- RED: `pnpm exec vitest run --project unit packages/core/src/localized.test.ts packages/db/src/portable.test.ts packages/i18n/src/scan.test.ts apps/web/src/state/selection-write-source.test.ts` — four failures, 30 passes, `/tmp/terno-source-red.log`.
- GREEN: same command plus `apps/web/src/lib/forward-author-admission-controls.test.tsx apps/web/src/lib/forward-empty-owner-seal.test.tsx apps/web/src/lib/forward-raw-obligation-transfer-r10.test.tsx apps/web/src/web/worker/providers.test.ts` — `/tmp/terno-source-green.log`.
- `pnpm --filter @terno/core --filter @terno/db --filter @terno/i18n --filter @terno/web typecheck` — passed, `/tmp/terno-source-types.log`.
- `pnpm exec oxlint --deny-warnings packages/core/src/localized.test.ts packages/db/src/portable.test.ts packages/i18n/src/scan.test.ts apps/web/src/state/selection-write-source.test.ts apps/web/src/lib/test/forward-raw-obligation.tsx apps/web/src/lib/forward-author-admission-controls.test.tsx apps/web/src/lib/forward-empty-owner-seal.test.tsx apps/web/src/lib/forward-raw-obligation-transfer-r10.test.tsx` — passed, `/tmp/terno-source-lint.log`.

## Final review and disposition

Exactly one native read-only Standards + Spec code review completed against 8da884d8 (`/tmp/terno-source-code-review.log`): Standards 0 findings; Spec 0 findings. No follow-up review, no delegates, and no review-driven fixes required. The reviewer inspected the moved helper explicitly and did not run repository tests or access the prohibited backend test.

Final combined GREEN: 8 files / 66 tests passed. Final db typecheck and lint also passed after the scanner's transform-mode change (`/tmp/terno-source-final-db-types.log`, `/tmp/terno-source-final-db-lint.log`). `git diff --check` passed. No production mail seam, catalog text, keyboard/controller or database production changes; no build clearance claimed. Full suite/build/e2e/perf intentionally not run under this task's explicit limits.
