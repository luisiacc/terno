# Release 2: fake IndexedDB index deletion

## Request

Implement the remaining fake-indexeddb 6.2.6 index-deletion simulator blocker after bulk grouping (8f520ff0), starting at ce649997. Own only the shared dependency patch/lock/workspace, direct regression tests and this plan. Preserve production schemas, real requests and transaction terminals, original performance workloads and budgets, existing postal-mime patch, and unrelated settings. No children, broad upgrades, app builds or global gates. Exactly one native gpt-6.1-sol/high code review after implementation.

## Evidence and design

Read release2-idb-performance.md and /tmp/terno-release2-idb/release2-driver-probe.test.ts first. The earlier public removal inspected 138,328 unrelated cached-provider records for 16 deletions. RecordStore.deleteByValue scans the full index on overwrite/delete. Inspect the installed locked source before choosing the minimal fix: pass each removed old record's extracted index keys and primary key to existing tree deletion rather than scan by primary value. Retain key conversion, comparison, uniqueness, tombstones, cursor ordering and rollback behavior. Patch both public CJS and ESM implementations; leave entrypoints, maps and types intact. No runtime monkeypatch in production.

## Tests and performance

First retain an ordinary fail-first access-bound regression using actual public store removal and physical verification. Add direct driver tests for key shapes, duplicates/multiEntry, overwrite/delete/range/clear, uniqueness, prevented request errors, abort rollback, open cursors and reopen. Run affected original storage.perf.test.ts and idb.perf.test.ts unchanged, including quick-filter completion with its native 900-second timeout and finite setup reserve. Run touched package types and scoped lint. All test commands append the existing NODE_OPTIONS with --require=/tmp/terno-network-guard.cjs. Synthetic temporary databases only. Frozen offline install must reproduce the patch; compare all package files to ensure only the two implementation files changed. Browser conformance, if needed, is bounded and separately reported; simulator success alone does not qualify browser behavior.

## Exclusions

No production DB/IDB/store/schema changes, native driver substitution, performance budget/workload/window changes, skipped gates, user profiles, providers, foreign processes, backend files, plans64–68, release worklist, fetch/push/landing. Preserve postal-mime patch byte-for-byte. Commit footer as requested.

## Revisions after the Codex review

Native read-only gpt-6.1-sol/high plan critique completed exit0 with ten points (/tmp/terno-fake-idb-plan-review.log). Accepted: unique primary-key ownership guard, shared key extraction, exact tree deletion rather than index-key range deletion, physical-index assertions beyond debug.verify, partial-update rollback, deliberate tombstone threshold, both public module formats, and unchanged whole-file perf execution. The patch changes Index.js and ObjectStore.js in both formats (four implementation files, not two); no package maps are shipped or changed. The 138,328 count is observed yielded index records, not a proven count of exclusively unrelated records.

RED: ordinary public store regression on unpatched 6.2.6 removed16, inspected138,328, failed the independent1,000 bound in2.54s. Evidence /tmp/terno-fake-idb/red.log. Actual request/terminal execution and debug.verify retained. No perf assertion modified.
