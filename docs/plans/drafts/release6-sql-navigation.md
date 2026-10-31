# Release 6: SQL navigation and counts

## Request

> Own packages/db internal query/repo/facts/folder readers, localized tests and affected perf.perf.test.ts verification (oracle read-only). New spec release6-sql-navigation.md. No IDB/backend/core/types/store-contract/conformance/dependencies/lockfile/renderer writes.

Repair the assigned SQLite navigation/sidebar/People and Waiting failures from the sixth release milestone, reproducing the affected original gate once on the current committed base. Preserve current Plan 83 hidden-Inbox semantics, exact counts/pages/Undo, transactions, UID and credential fences. Own DB internal query/repo/facts/folder readers and localized tests only; do not mutate shared schema/conformance/core/store files. No broad gates or changed timing oracles.

## Base and existing behavior

Actual committed base: `7761321eb1e3db549024768b8d7a6cd50e75f04d` (the expected base). Historical evidence at `ae860a9014a53186578873a450d9c356f5f1d14e` is not qualification of this base. Plans 64–68 remain read-only. Plans 80/81/83 and licensing/package work are untouched.

`folders.ts` rebuilds memberships in transactional slices with a durable UIDVALIDITY/UID cursor. `queries.ts:getCounts` reads unread Inbox threads, category totals/unread, pending suggestions, Waiting and folder tallies. Hidden-Inbox predicates apply only to the relevant Inbox counts; categories remain independent.

## Current-base reproduction

`pnpm exec vitest run --project perf packages/db/src/perf.perf.test.ts`, inherited NODE_OPTIONS appended with `--require=/tmp/terno-network-guard.cjs`, ran once, naturally exited 1: **33 passed, 1 failed**. Full log and owned PID/birth/argv metadata: `/tmp/terno-release6-sql/baseline.{log,json}`. No workload/oracle/budget/warmup/window/sample/multiplier changes.

- Historical longest folder rebuild slice 113.306 ms: current 13.071 ms, passed the unchanged 16 ms assertion. No root-cause or fix claim.
- Historical sidebar p95 7.471 ms: current 3.557 ms; overlapping-folder successor 4.273 ms. Passed. No fix claim.
- Historical sparse Waiting counts p95 5.618 ms: current 4.551 ms, passed. The same test reached its previously unreached `everyone` phase and failed at 5.054167 ms > 5 ms. Its `no one` phase remains **unreached**, not passed.

## Separate bounded diagnosis

Synthetic 29,500-thread / eight-account / seed-2026 dataset; no real profiles. Diagnostic tests seeded once per different probe, captured SQL plans and one-call wall time, and were joined. These are diagnostics, not perf qualification or repeated original timing runs. Source archived at `/tmp/terno-release6-sql/diagnostic-source.ts`; raw statement plans/costs at `statements.jsonl`; commands/lifecycles in `diagnostic*.{log,json}`. Temporary diagnostic test removed from the checkout.

The category aggregate scans the covering `thread_categories_c(category_id,thread_id)` index, then performs a primary-key lookup in the wide `threads` table **per membership** to read `in_trash`, `in_spam`, `unread_count`. First observed category call 5.349 ms; Inbox unread 0.316 ms; Waiting 0.234 ms; folder tallies 0.024 ms. Single-call cold costs are not p95 claims.

Tested alternatives:

- `NOT INDEXED` on this WITHOUT ROWID membership table still chooses `thread_categories_c`, no plan correction.
- Thread-first CROSS JOIN scans every thread, probes membership and sorts grouping: 6.818 ms. Rejected; work would scale with unrelated unfiled mail.
- Force membership primary key order: scan memberships, primary-key probe per member plus temporary grouping sort: 3.802 ms. No elimination of the relevant work.
- **Synthetic-only covering-index control**: `CREATE INDEX diagnostic_category_counts ON threads(id,unread_count) WHERE in_trash=0 AND in_spam=0`; same aggregate with `threads INDEXED BY diagnostic_category_counts` seeks this covering index by id, eliminating wide-table probes; 2.216 ms. This is a candidate dependency, not a production fix or qualification.

## Design and ownership dependency

No causal source correction is yet justified within ownership. This is a concrete blocked candidate, not proof that every possible local rewrite requires schema changes. The demonstrated useful control requires a durable schema/index migration, which this slice is explicitly prohibited from editing. Root must own or authorize that integration before it can become a production correction. Exact interface: a versioned partial covering threads index on `(id, unread_count)` with predicate `in_trash = 0 AND in_spam = 0`, plus the category-count join selecting it. Existing thread indexes do not cover this predicate, id seek and unread value together. Do not add an ad-hoc index on read/open or change migration history in place.

Before adopting: establish deterministic native/WASM work regression (actual aggregate plan has no table probe), exact category count equivalence for read/unread, spam/trash, overlapping and hidden categories, mutation and rollback; legacy upgrade/reopen compatibility; bounded index size and ingest cost. Keep the current readiness barriers and hidden-Inbox queries intact. If measurements reject it, leave the original query unchanged.

## Verification and next qualification

No production source, oracle, dependencies or migration edits. No timing waiver. No broad tests/builds, no E2E or UI changes. The baseline gate remains RED and the historical failures remain unwaived. No post-source qualification is authorized until a causal correction has focused green, its own verification joined, and one read-only Standards+Spec review; then run this original affected file exactly once, preserving downstream failures and unreached checks.

Main release-green and the 153-row goal remain incomplete.

## Revisions after the Codex review

One actual native `codex exec -s read-only -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -C "$PWD" - < /tmp/terno-release6-sql/critique-prompt.txt` completed naturally, exit 0. Full verdict: `/tmp/terno-release6-sql/critique.log` (six points; this was plan critique, not implementation review).

1. Evaluate a split aggregate using existing indexes: done in a separate bounded synthetic 50,500-thread `everyone` diagnostic. Exact total/unread record equality passed. Totals forced over the covering `threads_all` index cost 8.122 ms / 8.124 ms CPU, unread over `threads_unread_id` 2.666 ms / 2.683 ms CPU. Original category aggregation in that same probe is recorded with all other component costs in `everyone-statements.jsonl`. Reject this candidate: 48,744 clean thread visits/probes versus 11,717 memberships, and temporary grouping sort. It displaces work onto uncategorized mail.
2. Distinguish eliminating wide-table access from bounded membership work: revised dependency language; existing-index split is possible but failed the work criterion. A new index is a candidate requiring Root, not a proven universal necessity.
3. Preserve result shape for splits: equality checks drive results from totals, default unread to zero. Omit only-spam/trash categories and retain hidden categories. No production split adopted.
4. Do not subtract only Boolean spam/trash: no subtraction rewrite. Exact `in_trash=0 AND in_spam=0` predicates retained, including schema-permitted non-Boolean values.
5. Make executable-work criterion precise: any implementation regression must inspect actual table-column reads/deferred seeks on native and WASM, not rely solely on an EXPLAIN label. Current diagnostic plans do not replace that regression.
6. Keep causality conditional on failed phase: the new diagnostic reconstructs the 50,500-thread all-unread/People/Waiting state, records per-statement CPU, and asserts candidate equality. It is not the full original test mutation sequence and does not qualify any repair.

No implementation review spent on unfinished diagnosis. No source regression or post-source qualification claimed. The single reserved Standards+Spec review remains required after a causal implementation and focused green.


## Final bounded handoff

The local split diagnostic passed one exact result-equivalence assertion pair on each engine:

- `pnpm exec vitest run --project unit packages/db/src/navigation-diagnostic.test.ts`: 1 passed, natural exit 0; `/tmp/terno-release6-sql/diagnostic-everyone.{log,json}`.
- `pnpm exec vitest run --project db-wasm packages/db/src/navigation-diagnostic.test.ts`: 1 passed, natural exit 0; `/tmp/terno-release6-sql/diagnostic-everyone-wasm.{log,json}`.

Both commands appended the inherited network guard, used synthetic data, retained finite diagnostic deadlines, and were joined before cleanup. Exact source snapshots and plans remain in `/tmp/terno-release6-sql/`; temporary checkout tests were removed. Earlier bounded diagnostic commands used the same unit-project invocation and each naturally passed once (`diagnostic`, `diagnostic-statements`, `diagnostic-orders`, `diagnostic-cover`). Their result is diagnostic only, never a source RED/GREEN regression.

In the synthetic everyone state the original category statement consumed 4.249 ms wall / 4.250 ms CPU, versus Inbox unread 0.295 ms, Waiting 0.598 ms, suggestions 0.047 ms, folder tallies 0.024 ms. This supports the category access-path candidate; it does not prove a production correction. Native/WASM split equality alone does not prove all semantic cases, non-Boolean flags or migration compatibility.

**Disposition:** concrete causal investigation and blocked schema candidate; no source fix, no independent source regression GREEN, no implementation review, no post-source original qualification. The original gate is RED (33/34); historical source failures are unwaived. Root should own the migration/index experiment or explicitly extend schema ownership, then add failing native/WASM executable-work and semantic regressions before adopting it. The candidate must also pass migration/reopen and bounded ingest/index-cost checks. Do not treat this evidence-only commit as release-green.

Only the new draft spec is committed. No package source changes means package typecheck/lint were not run; no full gates/builds/E2E/UI/smoke were run. `git diff --check` passed. Main/worklist and other owners remain untouched; no fetch, push or landing.
