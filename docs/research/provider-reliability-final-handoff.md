# Provider reliability handoff

The release is **not green**. Every report row has a recorded disposition. The authorized S48, T09 and B35/S23 follow-ups are now landed, leaving zero needs-work report rows; broader release failures and separate optional candidates remain open. The latest focused verification passed the complete original SQL performance file on supported Node 24.3.0. It does not supersede the failed full release run or the separate cached-migration correctness failure.

## Row dispositions

The [canonical worklist](provider-reliability-worklist.md) contains the individual disposition, evidence and limits for all 153 rows:

| Disposition | Rows |
|---|---:|
| Covered by an existing reviewed change | 85 |
| Already protected in Terno | 33 |
| Doesn't apply to Terno | 14 |
| Outlook-deferred | 21 |
| Needs work | 0 |
| Total | 153 |

W01, W02, W03, W04, W06, W08, W09, W10 and W12 have no needs-work report rows. W07 remains Outlook-deferred. W05 has no remaining needs-work rows after B35/S23 landed `0478fadd`; W11 has no remaining needs-work rows: S48 landed at `bbcfaf8f` and T09 at `62532cde` after authorized follow-ups and focused integration. These are finite supported-contract dispositions, not universal provider, crash, hardware-sleep or live-service guarantees. S52's native SQLite/Gmail 50k resource contract is already protected; its ordered phases retain the original identities, assertions and per-case timeouts.

## Parked implementations

The first three rows record completed follow-up landings; the remaining optional candidates are still unlanded. Passing focused controls do not waive unrelated release failures.

| Candidate / preserved head | Reason |
|---|---|
| B35/S23 account-status owner — LANDED `0478fadd` | Five P2s, stale-syncing P3 and two follow-up review findings fixed with SQL/IDB RED→GREEN. Root integration378status/direct+6Send+1network PASS. Actual review requested changes; both post-review fixes were tested and inspected, without a second clean verdict. |
| S48 complete-body publication — LANDED `bbcfaf8f` | The three redesign findings and both follow-up review findings received RED→GREEN fixes. Root integration passed 54 native/38 WASM; original incoming 15 ms gate passed. Full bodies preserved, no cutoff. No second clean review verdict or general release clearance claimed. |
| T09 full-message reader — LANDED `62532cde` | Four original findings and two follow-up P2s fixed with RED→GREEN regressions. Root integration:62 unit/direct,42 browser,types/lint/axe PASS. Original two perf cases passed unchanged20ms limits; all7 rebased patches unchanged. No second clean review verdict claimed. |
| Optional W06 survivor recovery, `3c9a6fa3` | Clean source R3, but unchanged 16 ms performance gate failed. One focused profile found the dominant native COMMIT cost in inherited transaction/driver code; no candidate-local fix was justified. A28/S11 qualification on landed main remains separate. |
| Empty-thread deletion optimization, `t3/backend-perf-release-diagnosis`, `80bdfcea` | Work regression and 861 affected checks pass; R1 clean. Original complete reconcile file still fails orphan stall at 83.221/32 ms. Do not land the optimization on this evidence. |
| Cached migration statement metadata, `t3/fix-stale-schema-query-cache`, `b2e81792` | Diagnostic tests/docs only, no production fix. Five existing native 24.3 migration controls fail with stale cached SELECT* metadata. Fresh preparation/schema/data are correct. Enclosing rollback requires broader transaction-lifecycle invalidation; released scope and both diagnostic reviews were exhausted. Intentionally failing tests are not landed. |

Final redesign evidence: [S48 handoff](/tmp/terno-w11-s48/redesign/handoff.md), [B35/S23 handoff](/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-b35-owner-design-fty8ena9/handoff.txt), [T09 R2](/tmp/terno-w11-r1-fixes-61640/r2/verdict.txt), [migration diagnostic](/tmp/terno-migration-cache/handoff.json).

The four editor/list branches remain outside this goal and parked: `t3/prosemirror-view-reconciliation` (`aebddc5d`), `t3/huge-editor-rendering-boundary` (`9d32eb72`), `t3/prosemirror-position-bounds-dependency` (`211c7f6d`), and `t3/large-editor-typing-performance` (`0f5cbefb`). No source from these branches is credited or imported.

## Single final full release run

These results apply to frozen `be2efa231e3dbbe543e2f2cca32503fc5dedabd1`. The full suite was not repeated after focused repairs.

| Requested stage | Result |
|---|---|
| `pnpm typecheck` | FAIL: missing committed module closure at that snapshot |
| `pnpm lint` | PASS |
| `pnpm test` | FAIL: 10,701 passed, 84 failed, 3 skipped; collection errors also occurred |
| Normal additional WASM fallback | FAIL: 1,939 passed, 4 failed, 2 skipped |
| `pnpm test:e2e` | FAIL during setup; test bodies not executed |
| `pnpm test:web` | FAIL during setup |
| `pnpm test:ui-perf` | FAIL during setup; test bodies not executed |
| `pnpm test:perf` | FAIL: 218 passed, 38 failed, 1 skipped; natural completion |
| `pnpm dist:mac` | FAIL: release Google configuration absent in isolated snapshot |
| Fresh desktop smoke | NOTRUN: no fresh binary from that failed build |

The requested gate tally was 1 PASS / 7 FAIL / 1 NOTRUN, with the extra WASM stage reported separately. [Original report and failure inventories](/tmp/terno-final-gate-7ukzyk6i/report.md) preserve exact commands, timings and failures. Later focused successes are scoped to their own source and runtime identities.

## Focused repairs and subsequent evidence

Reviewed fixes landed for renderer fixture body readiness, Web map-archive error propagation, WASM cached columns/historical IDB fixtures, MIME capture expected-error classification, isolated-space quote work, localization source scanning, checkpoint-worker fixture cleanup, and all native numbered-query bindings. The worklist records each landing and its fail-first controls.

The supported-runtime binding correction passed root integration on actual native Node 24.3.0, native 24.21.0 and SQLite-WASM: 27/27 for ingestion and 48/48 for the remaining query slice. The complete original fresh-schema SQL file then passed **34/34 cases and all 309 measurements**, unchanged budgets at multiplier 1, in one natural 66.39-second invocation at `b61fad6d`. No performance instrumentation or product edits were added. [Full SQL verification report](/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-full-db-59df930d-2t8zqz6z/report.md).

Committed-closure Backend, Web and Desktop type configurations later passed targeted checks. At frozen `92e9871b`, the authorized release build and **local ad-hoc package** passed; default fresh smoke recorded **68 passed / 8 skipped / 1 failed**. The failure was the older-mailbox upgrade-cover assertion. One corrected standard-launch focused baseline subsequently passed all original assertions, with clone preparation 304 ms below the unchanged 400 ms cover threshold; the historical suite failure remains unexplained, not fixed. [Local package/smoke report](/tmp/terno-local-92e9871b/report.md), [focused cover evidence](/tmp/terno-cover-corrected-d8844e3e/report.md).

Local packaging deliberately omitted the upload hook under the user's authorization. It is not an exact upload-bearing root `dist:mac` pass. The binary is arm64, ad-hoc signed, with verified build/package hashes. Six updater skips require a stable signing identity; two render-fatal probes require a source-test build. No notarization, native Keychain or signed-update clearance is claimed.

## Remaining known release issues

The worklist preserves the historical dropped-image ordering, 5 MB paired suggestion typing, sustained-j frame, and v23 migration slice failures. Scoped fixture/runtime corrections and selected passing diagnostics are recorded without relaxing budgets or crediting parked editor work as resolution.

Separate observed failures also remain recorded:

- Native cached migration row shape: five existing controls fail on Node 24.3.0; no production repair landed.
- IDB million-label rebuild: observed 25.586/16 ms, with no avoidable mechanism isolated; exact final audit was unreached.
- IDB Unread after mutation: observed 34.325/32 ms; intended invalidation/fallback was observed, but no causal defect isolated.
- Native lifecycle/reset/reconcile stalls: profiles attribute substantial time to native COMMIT and/or recomputation; no justified driver/checkpoint workaround or budget change was made.
- Original full unit/E2E/Web/UI-perf gates have no current-main replacement pass. Individual passing cases/files are not a suite result.
- The original whole packaged-smoke cover failure remains open despite its focused passing baseline.

Selected passing diagnostics for other IDB, search, instant-index, history, parser, recipient and migration cases establish only their measured contexts. Unreproduced historical failures and unchecked sibling cases remain explicit in the worklist; they are not silently marked green.

## Preservation

User WIP was left untouched. Candidate branches and evidence remain preserved; no pushes were made. Latest SQL verification restored its source/dependency/output paths and joined all captured processes naturally without signals. Process audits are sampled rather than exhaustive; earlier install/cache and observation limitations remain disclosed in each report. No new full milestone or additional parked-item review is implied by this handoff.



## Authorized follow-up completion — 2026-11-02

All four requested rows landed serially by fast-forward: S48 `bbcfaf8f`, T09 `62532cde`, B35/S23 `0478fadd`. Current tally85covered/0needs-work/33protected/14N-A/21deferred=153. No body cutoff or performance-budget change. All three follow-up reviews produced findings that received executed failing regressions and fixes; no independent clean rereview was performed or claimed. Root inspected corrections and isolated integration checks passed.

B35/S23 integration385 newly passing bodies at exact0478fadd, while four broader failures were reproduced on pristine committed main with matching candidate signatures. These known issues are two IDB explicit-renewal authority/removal failures and two reader-reconnect payload/detail-state failures; later assertions remain unqualified. See [integration report](/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-b35-verification-ar9jycah/report.md). The foreground backfill pacing fixture and prior native migration-cache/lifecycle performance holds remain recorded separately. No full release gates were repeated; the release is still not green. User WIP and unrelated parked branches were preserved; no push.
