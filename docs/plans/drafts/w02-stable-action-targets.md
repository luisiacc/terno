# W02 B38: stable local action targets

## Request (verbatim)

> Own W02 B38: 'Scheduled actions can lose stable IDs and report success without doing work.' Current rationale validate deleted/renamed/invalid LOCAL actiontargets against newfoldermodel; no hosted scheduled-mailservice requested.

> Seek completed finite B38disposition backed by evidence, not endless qualification of all possibleactions. If no supported relevantarchitecture, onelineN-Awithsourcewitness and tests for applicablelocal invariant; if genuinebugoutside purevalidation ownership, clean failfirsthandoff for serialRootfix.

## Existing architecture and base

Actual base: `6442b1d69f8e4322388549a321ed29e4adf0cd23` (matches expected main). Report B38 cites an external scheduler, not Terno source. Baseline B38 adapts this to durable local category/filter actions; worklist still needs work. Plans05/38/45/68/83 were consulted. Plans64–68 remain read-only; user category-delete UI and held/editor branches are excluded.

`packages/core/src/rules/schema.ts` defines the closed FilterAction union: fixed flag/location actions and addCategory with positive numeric categoryId. There is no arbitrary folder-move filter action. Plan68 explicitly excludes moving to custom folders. `packages/backend/src/handlers.ts` filters.save stores the payload, filters.apply captures rule JSON and calls transactional store applyChunk. SQL sql-store.ts and IDB store.ts compare current rule before claims/actions; a missing category aborts the transaction. Existing ai-filter-output.test.ts already tests stale-category rollback and repair.

## Design

Initial proposal: tests-only qualification in one NEW backend test file through actual BackendCore/RPC with temporary native SQLite and fake-IDB. The final SQL-only scope and shared dependency below supersede this initial proposal. Use store ingestion solely to seed synthetic mail; no provider connection, worker preparation, managed Google traffic, or real profiles. Assert a renamed category retains its stable ID even when another category takes its old name. Delete a destination and recreate the same name: applying the saved rule must reject with all earlier actions, operations, claims, hit counts and timestamps rolled back, also after reopen; exact replacement/sibling memberships stay unchanged. Malformed action IDs/missing destination/name-only/folder action payloads must be refused by the real RPC schema without saving. Saving a numeric nonexistent destination is currently permitted; execution rejection is the safety contract, not save-time validity.

A successful mixed markRead/category action must persist exact rule, message/neighbor identity, queued operation payload/targets, claims and hit count across reopen and avoid double application. Deleted/edited filters during execution retain existing transaction-owned protection; qualify a captured-rule edit via a deterministic matchWindow gate only if needed for the finite contract. No production fixes unless a pure validation defect is reproduced; any core/store defect is a fail-first handoff to Root.

## Tests and performance

Run only the dedicated file and relevant existing direct caller controls, touched backend package types and exact-file lint, all test commands inheriting NODE_OPTIONS plus --require=/tmp/terno-network-guard.cjs. Use an exact-file temporary Vitest config without worker globalSetup: this entrypoint seeds store directly. No hot-path production edit means no perf run. No full suites, UI, app/build/package/dist/smoke runs, workload or timeout relaxations. Native Codex Sol/high read-only plan critique once; Standards+Spec code review at most twice. Record actual verdict, corrections and later unreviewed limits.

## Out of scope and disposition boundary

No scheduler, autonomous AI engine, side ledger, hosted service, custom-folder move action, provider UIDVALIDITY/reused-UID requalification, account removal/reconnection protocol, renderer changes or release milestone. Categories are local cross-account IDs, not account-local folder labels. Initial conditional recommendation (not met): B38 already protected for the supported finite local filter contract if controls pass; external scheduled-service incident is not applicable. Do not claim every action, all28 rows, process-crash durability or release green. Root owns worklist, serial dependency fixes and landing.

## Revisions after the Codex review

One actual native `gpt-6.1-sol` high read-only critique completed (8 points, artifact `/tmp/terno-w02-b38/plan-review.txt`). Accept all: qualification is explicit filters.apply, markRead plus numeric category ID, one failing chunk with an unclaimed match; previous committed chunks are not rolled back. Zero matches/already claimed work legitimately returns zero and is not destination validation. Automatic ingestion is excluded. Invalid discriminator/missing ID are rejected; surplus properties may be stripped. Save before deletion, reopen, delete/recreate same name and repair explicitly. Read ops.get and persisted exact claims/timestamps rather than relying on debug counts. Rule JSON equality (not generic revision) fencing is source-observed only. Use unrelated message/thread neighbors; no same-thread sibling claim. Tests below control finite local filter semantics, not all rule/action paths.


## Investigation result: serial shared-store dependency

The ordinary new case fails on unchanged production at the actual public filters.apply entrypoint: save a rule while category ID1 exists, reopen, delete that highest category, create the same-name replacement. SQLite assigns ID1 again. Apply resolves `{matchedMessages:1, affectedThreads:1}` instead of refusing the retired target. This is a genuine target-lifetime alias, not the absent external scheduler. Witnesses: packages/db/src/migrations.ts categories has `id INTEGER PRIMARY KEY` (no monotonic allocation contract); repos.ts createCategory inserts without an explicit ID; sql-store.ts runFilterActions verifies current category existence only. There is no surviving identity/generation distinction for that reused ID. Core validation of numeric syntax cannot recover the lost identity.

**Root serial queue:** category allocation/lifetime persistence and any required migration/contracts belong to the shared-store owner. Preserve the ordinary failing reserve-higher-ID=false test; do not paper over it with sentinel allocation, a side ledger or pure validation workaround. Consider legacy/reopen behavior when fixing allocation; a test-only new-allocation fix cannot certify preexisting aliased references. Root must coordinate with live category-delete work and W03 store ownership. No W02 production fix is authorized or applied.

Final new test is native SQL-only (10 cases): one behavioral RED for reused category ID, nine passing controls for rename/old-name decoy, genuinely missing ID with higher surviving category, and seven malformed action payloads. The reserve-higher-ID=true case tests rollback twice across reopen, exact messages/neighbor/memberships/queue, claims/hits/timestamps and deliberate rule repair. The false variant deliberately has no sentinel and exposes the defect. No .fails, skip, budget adjustment or retry-until-green. Saving malformed string labels cannot redirect a category ID. Normal duplicate apply returns explicit zeros.

The initial dual-store version passed9/9 IDB cases but SQL's preliminary distinct-ID assertion failed before apply (not counted as product RED). Importing IDB into backend main types also correctly failed for absent DOM types. Removed those imports instead of editing shared type configuration. Existing ai-filter-output.test.ts provides28 passing direct-caller controls across SQL/fake-IDB; its worker is lazy and this execution used no worker preparation/build. No new IDB allocation/reuse qualification is claimed.

## Targeted checks before code review

Artifacts: `/tmp/terno-w02-b38/` (PID/start/argv and output per command). All test commands append the network guard to inherited NODE_OPTIONS. First invocation initialized this isolated worktree's pnpm dependencies and ran the existing ensure-electron postinstall, then failed temporary-config import resolution before tests. Corrected the temporary config to plain export; no app/package/worker build ran. All processes joined naturally.

- `pnpm exec vitest run --config /tmp/terno-w02-b38/vitest.config.ts packages/backend/src/stable-action-targets.test.ts packages/backend/src/ai-filter-output.test.ts`: **37 passed, 1 failed, zero skips**, 38 cases /2files. Sole failure is ordinary reused-ID apply resolving success; preserved intentionally as authorized serial handoff, not a release-green claim.
- `pnpm --filter @terno/backend typecheck`: both configured projects pass after removal of new IDB imports (`types-sql.log`). Initial DOM-discovery failure retained (`types-first.log`).
- `pnpm exec oxlint --deny-warnings packages/backend/src/stable-action-targets.test.ts`: pass (`lint.log`).
- No production edit, perf, UI, build, full suite, real profile, fetch/push/landing or worklist change.

## Proposed finite row disposition

**B38 remains needs work: shared-store serial dependency.** External scheduled-mail service incident is N-A to Terno's closed local action architecture; applicable local explicit filters are protected for rename, genuine missing IDs and malformed payloads, but native SQLite category ID reuse can silently redirect a saved action and mark it successful. Root must fix allocation/lifetime identity and rerun the dedicated ordinary failing case before marking B38 protected. No other row disposition is proposed. Automatic ingest, whole multi-chunk rollback, UIDVALIDITY, arbitrary folders, account/message lifecycle and process-crash consistency remain outside this qualification.

## Code review R1 and fail-first oracle correction

Actual native Sol/high read-only Standards+Spec R1 verdict: **Standards PASS / Spec NEEDS REVISION**, one P2. Duplicate apply checked hit count before, not after, the second invocation. Fixed with filters.list equality after duplicate apply and again after reopen; clock advances by1s before duplicate apply so existing exact timestamp assertions also detect unintended updates.

Test-only negative oracle (temporary wrapper around the existing applyChunk, incrementing persisted hits when applied=0; restored owned test source in finally, no production change): old oracle let rename/duplicate case pass (9pass/1known-IDreuse-fail); corrected oracle fails on **hits2 vs1** (8pass/2fail, the second remains known IDreuse). Artifacts `r1-hit-old-oracle.log`, `r1-hit-new-oracle.log`, archived originals and `hit-oracle.py` under evidence directory. This is oracle RED, not a new product defect or a claimed production fix. With the mutation removed, final scoped command is again **37pass/1ordinary-IDreuse-fail**, no skips (`scoped-after-r1.log`); both backend types and strict owned lint pass (`types-after-r1.log`, `lint-after-r1.log`). Whitespace clean. R1finding fixed; shared-store blocker unchanged.

## Final review and handoff

Exactly **one** actual native Sol/high read-only plan critique and **two** actual native Sol/high read-only Standards+Spec code reviews completed. R2 (`code-r2.log`) verdict: **Standards PASS / Spec PASS for the final SQL-only fail-first handoff**, zero new findings; R1 P2 explicitly verified resolved. No remaining review backlog. Reviewers read evidence but did not independently rerun checks. Review cap exhausted; no third review or reset. This final verdict/process note is documentation added after R2 and is not independently reviewed; no test/runtime edits followed R2.

Deliver the whole committed branch `t3/validate-stable-action-targets` to Root from actual base `6442b1d69f8e4322388549a321ed29e4adf0cd23`: `c5604dd0` reproducer/spec and `c9c52645` oracle correction, plus this final documentation commit. Shared production fix remains unimplemented by design; B38 stays needs work. Exact rerun is the scoped command above; expect one ordinary failing reused-ID case until Root fixes the shared dependency. No main/worklist/peer changes, push, landing, UI, full gates or performance claims.
