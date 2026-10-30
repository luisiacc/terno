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

## Implementation and verification in progress

Shared extraction returns normalized index keys for both insertion and exact old-record deletion. Normalization previously validated but discarded the returned converted key for non-multiEntry keys; retaining it is required for typed-array views (including compound keys) to reach the normalized tree comparator correctly. Exact deletion checks primary-key ownership even for unique trees, preserving failed-write rollback. Existing tombstone/rebuild machinery remains unchanged. No special case for cached_provider; no production adapter changes.

Direct ESM/CJS regressions cover invalid/missing and compound keys, structural Date/array/binary keys, mixed duplicate multiEntry keys, duplicate index keys, overwrite, nonexistent deletion, ranges/clear/recreation/reopen, unique prevented errors and automatic abort, partial-index-write rollback, explicit abort after writes/deletion/clear, and cursors across tombstone rebuilding. Additional access observer counts getRecords on a 2,048-entry duplicate index during overwrite/missing deletion. Public removal additionally checks the physical cached_provider cursor against expected message rows and repeats after close/reopen.

Earlier implementation checks: first driver run had two binary-key exceptions/timeouts and CJS range-class fixture failures; normalization and per-format key ranges corrected these. Second run failed two expected-key assertions because public primary keys normalize typed arrays to ArrayBuffers; the fixture now expects the normalized key. Third run passed9 tests in1.72s before adding reverse cursor and physical-index checks. These are retained as green.log, green2.log, green3.log under /tmp/terno-fake-idb.

Whole-file perf invocation preserves every native timeout. Allowance: setup900s per file, nine IDB tests900s plus final default600s, storage two default600s, plus120s reserve =11,820s. Own pnpm PID38329, born Fri Oct30 09:50:10 2026, captured in perf-pid.log. No signals issued. No silence-based timeout inference. No multiplier override, workload changes, warmup, retries or GC added.

Frozen offline workspace install succeeds. Fresh isolated temp dependency-only reproduction also installs the patch offline from its frozen lock; all package file bytes match the workspace. Relative to original locked package, only build/{esm,cjs}/lib/{Index,ObjectStore}.js differ. Every other file hash (exports, entries, types, package metadata included) matches. Original package ships no source maps. Postal-mime patch unchanged versus ce649997; lock changes only fake-indexeddb patch registration and the three existing consumers' patch hashes.

## Original performance qualification

Guarded `pnpm exec vitest run --project=perf packages/idb/src/storage.perf.test.ts packages/idb/src/idb.perf.test.ts --reporter=verbose --disableConsoleIntercept` completed exit0:12passed,2files,95.59s. Original quick-filter actually completed in44,767ms (native900,000ms deadline), within full original shared-store progression. People/Waiting5,800ms; cached refresh1,824ms; storage report34ms and removal99ms test durations. The removal duration includes its original multiple samples; it is not the measured per-unit budget value. Passing the original assertions closes these simulator perf failures for this checkout; it is not release-wide clearance. All source bytes of both perf files match ce649997. No skips, .fails, extra repeats, fixture changes, forced GC, prewarming, or scheduling/window/budget changes.

Touched @terno/idb typecheck and scoped oxlint pass (types-final.log, lint-final.log). Browser/native behavior has not been independently qualified; the dependency is only the simulator and production adapter/schema are unchanged. No full Web/native/global gates or builds run, per assignment. No signals issued to any process.

Final scoped caller invocation (all guarded): `pnpm exec vitest run --project=unit packages/idb/src/fake-indexeddb-locality.test.ts packages/idb/src/test/fake-indexeddb-index-deletion.test.ts packages/idb/src/idb.store.test.ts packages/idb/src/idb.conformance.test.ts packages/idb/src/cached-refresh.test.ts packages/idb/src/storage.test.ts packages/idb/src/bulk-action-locality.test.ts` — exit0,6files,684passed and2existing historical-binary skips,62.00s. `storage.test.ts` does not exist, so it did not select an extra file; the existing public `remove-many.test.ts` was then run separately: exit0,1passed,332ms. The two driver files now contain11 passing tests total. No test source skips added. Own caller pnpm PID51978, born Fri Oct30 09:51:52 2026 (callers-pid.log). Evidence in /tmp/terno-fake-idb. Scoped types/lint pass after final regression edits. No behavior/schema/adapter changes outside the patched test dependency.

## Sole code review and final scope

Exactly ONE native `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only -C <checkout> -` Standards + Spec code review completed exit0 over ce649997..6287df47. Standards0, Spec0, lower-risk backlog0. Reviewer independently traced installed driver rollback/cursor/key behavior and examined the retained RED/GREEN, package reproduction and final perf/caller evidence. No findings required fixes; no second round or model/provider fallback. Evidence /tmp/terno-fake-idb/code-review.log. Documentation after that review only records completed checks.

No browser conformance run: ESM/CJS simulator semantics are qualified by the direct and public-store regressions; browser/native semantics and full release gates remain unqualified here. This assignment's original two affected performance files pass unchanged. Earlier840.14ms removal and900s quick-filter failure remain historical RED evidence, now followed by complete original-file GREEN. Root owns serial integration/retest/FF documentation and cleanup. This branch was committed only, never pushed or landed.
