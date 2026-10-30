# Release milestone 2: IndexedDB performance attribution

## Request

Implementation assignment (verbatim): “Own packages/idb/src/idb.perf.test.ts and storage.perf.test.ts plus directly causal IDB production/tests. Four failures: attachments/starred quick-filter900,000ms native timeout; People cold firstpage19,797ms/16; cached refresh50k939.84ms/16; removeunitCPU707.73ms/15.” Preserve original datasets, workloads, budgets, identity safety, physical completion and durability. Do not edit Root's worklist, main, plans64–68, SQL/core contracts, or the forbidden backend test. Hand off concrete dependencies outside ownership.

## Existing behavior and bounded investigation

Base c9b935f835224c1b805399db232f080524948d0f. The milestone log shows both attachments and starred cold pages passing (0.45 and 0.13ms), then the quick-filter test timing out. People and cached refresh run subsequently against the same store. Vitest timeouts do not cancel the asynchronous test body. Independent cold timing is therefore needed before attributing later failures to their named algorithms.

`schema.persist` writes touched rows and waits for real request success and the transaction terminal. The physical messages index `cached_provider` is necessary for bounded cached refresh; it cannot be removed to make the fake driver cheaper. `fake-indexeddb@6.2.6` ObjectStore.storeRecord deletes old index entries with RecordStore.deleteByValue on every overwrite; deleteRecord does the same on deletion. deleteByValue iterates getAllRecords and tests every record's primary key, rather than seeking by index key. This is a concrete simulator complexity dependency, not evidence of browser IndexedDB complexity.

A temporary unit probe on fresh synthetic stores, instant search disabled, ran the unchanged generator with 1,000 then 5,000 threads, four accounts, seed69, bodyScale2. Seed took239ms and1,621ms. A public storage report selected twenty eligible threads and removal maxMessages30 removed sixteen messages in14ms and124ms respectively. A CPU profile of the 5k removal attributes most samples to fake-indexeddb tree traversal/deleteByValue. The only full Table.all thread iteration counted was building the initial report order; the observer saw no Table.all message iteration. This does not exclude other application costs. The test body restored its Table instrumentation and closed its owned store in finally. Temporary probe and profile are retained under /tmp/terno-release2-idb; this probe is characterization, not a fail-first regression or a 50k qualification.

## Design and exclusions

First run the unchanged cached-refresh test in isolation to distinguish inherited background work from the physical reader itself. Run the original storage perf file once with its declared timeouts and finite reserve. Collect deterministic source/access controls before considering a fix. Never replace asynchronous request execution with a synchronous mock, measure only part of the existing window, alter budgets, prewarm, disable physical indexes, bypass IMAP holds, or change the generated workload.

If bounded evidence establishes the simulator index maintenance as the blocker, hand Root the exact dependency: fake-indexeddb's ObjectStore index overwrite/delete → RecordStore.deleteByValue. A workspace patch/version change owns pnpm-workspace.yaml, pnpm-lock.yaml and possibly other packages using this shared dependency; it requires coordinated ownership. Do not introduce a production schema redesign solely to compensate for a test driver. Any proposed simulator correction must preserve actual requests, abort/rollback behavior, duplicate/multiEntry indexes, reopen and transaction completion. The production target-grouping correction below is independent of this simulator dependency.

## Tests and performance

All test launches append --require=/tmp/terno-network-guard.cjs to existing NODE_OPTIONS. Only touched modules/direct callers and affected perf files are allowed; no app builds or full gates. Original four failures remain release blockers unless their original tests pass with unchanged gates. Profile attribution and access counts do not close timing failures. No UI, locale, provider attempt/quota/deletion intent, schema, SQL, or application contract change is proposed.

## Results and concrete ownership handoff

Original timing gates are unchanged. The plan critique identified a separate causal production complexity correction, implemented below; the simulator dependency remains Root-owned.

- Unchanged original `storage.perf.test.ts`: report passes33ms; removal reproduces RED, median840.14ms versus15ms. Completed normally in61.74s, exit1. The native declared timeouts were retained (beforeAll900,000ms, each test600,000ms); no silence-based termination.
- Unchanged cached refresh selected in isolation: GREEN,1 test,1,795ms; entire invocation8.47s. Unselected tests reported9 skips because of the CLI name filter; no skip was added to source. This does not qualify the whole file or reproduce the939.84ms milestone failure.
- Unchanged People/Waiting selected in isolation: GREEN,1 test,5,289ms; invocation11.92s. All original cold/page/count/walk/dense/empty/search/expired gates passed. The other9 tests were unselected. This does not reproduce the19,797ms milestone cold failure.
- A second, temporary ordinary driver regression established a fail-first dependency counterexample: on5,000 synthetic threads a real public removal of16 messages inspected138,328 unrelated cached-provider index records through fake-indexeddb's getAllRecords. It fails an independent1,000-access bound in1.75s. The observer delegates every original iteration, so actual requests and transaction terminals still execute; public debug.verify passed before the failing access assertion. This new bound is a diagnostic control, not a replacement or relaxation of any original perf limit. Source/log retained externally, no failing regression left in the repository.

The shared dependency handoff is `fake-indexeddb@6.2.6`, ObjectStore.storeRecord/deleteRecord → RecordStore.deleteByValue → binarySearchTree.getAllRecords. Every message overwrite/deletion scans the entire physical cached-provider index. The profile aggregates53 samples in tree traversal and4 in deleteByValue, versus one in removeStorage. A coordinated upstream dependency update or workspace patch should delete index entries using the old record's extracted index key and primary key, covering missing keys, multiEntry, duplicate keys, tombstones/cursors, rollback, errors and aborts; do not optimize only this one index or disable index maintenance. Root owns whether/how to patch this shared package and its lock/workspace files. Exact dependency correctness and original gates must be retested after that correction. No IMAP-held rows were cleared or altered for this investigation.

The quick-filter timeout was not rerun for another15minutes: original log plus bounded mutation attribution are the evidence. The later isolation passes support, but do not prove, contamination by an uncancelled timed-out test. No statement here closes any of the four milestone failures. No post-fix GREEN for the original quick-filter/storage failures, native browser proof, original whole-file IDB qualification or release-green result is claimed.

Commands, all tests prefixed with `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs"`:

1. `pnpm exec vitest run --project=unit packages/idb/src/release2-probe.test.ts` — passed characterization, console suppressed by default reporter; repeated with `--reporter=verbose --disableConsoleIntercept` to obtain the1k attribution (not a timing gate retry). Then the5k profile probe ran once with `--disableConsoleIntercept`. Temporary source retained externally.
2. `pnpm exec vitest run --project=perf packages/idb/src/idb.perf.test.ts -t 'cached refresh keyset' --reporter=verbose --disableConsoleIntercept` — isolation GREEN, cached-isolated.log.
3. `pnpm exec vitest run --project=perf packages/idb/src/storage.perf.test.ts --reporter=verbose --disableConsoleIntercept` — original RED, storage-original.log.
4. `pnpm exec vitest run --project=unit packages/idb/src/release2-driver-probe.test.ts --disableConsoleIntercept` — deterministic dependency RED, driver-counterexample-red.log.
5. `pnpm exec vitest run --project=perf packages/idb/src/idb.perf.test.ts -t 'People and Waiting' --reporter=verbose --disableConsoleIntercept` — isolation GREEN, people-isolated.log.

Evidence directory: `/tmp/terno-release2-idb`. Scoped package types/lint and direct caller suites are recorded below. No full gates, app builds, profiles/secrets, user ports or foreign processes touched. The draft, mail.ts target grouping, and its regression are committed.


## Revisions after the Codex review

Native read-only plan critique completed exit0 with eight concrete points (/tmp/terno-release2-idb/plan-critique.log). Accepted: isolate production grouping cost from driver writes, do not locate the timeout from cold-page logs alone, label isolation's disabled instant index and absent earlier mutations, distinguish read-side gates from driver writes, retain the awaited persistence window, and avoid exclusive attribution from small probes. Isolation passes are characterization with different prior state; they do not prove timeout contamination or close any original failure.

The critique found a viable production defect in applyToMessages: `[...previousIds, id]` copied the account's accumulated target list for every changed message, O(sum(accountMessageCount²)). Replace this with one private array per account and push. Keep account insertion order, per-account ID order, before-state capture, actual message updates, intent operations, persistence and undo unchanged. No schema or shared contract changes.

The ordinary real-store regression bulk-action-locality.test.ts instruments numeric Array iteration without replacing data or requests. At512 distinct Gmail threads the original command traverses137,987 numeric elements, exceeding an independent32N access bound (bulk-red3.log). The fixed command passes the same bound, checks the exact persisted provider target IDs, verifies physical memory/disk equality, closes/reopens, and restores the exact original message snapshot using the returned undo preimages. The observer is restored in finally before assertions; the store closes in finally. No performance timing gate is replaced by this control.

Earlier observations: the first observer used vi.spyOn on Array's iterator and recursively overflowed (bulk-red.log); direct delegation corrected that harness. The second fixture put512 messages in one thread, where star intentionally changes only the latest message; the all-star assertion failed (bulk-red2.log). Using distinct threads produced the actual complexity RED. The first post-fix assertion incorrectly read OpRow.target rather than JSON-parsing target_json (bulk-green.log); corrected actual stored shape passes (bulk-green2.log). The first typecheck rejected the observer generator's void return; explicitly returning undefined matches ArrayIterator. These are fixture/type corrections, not passing original failures.

Scope: this correction removes demonstrated quadratic grouping. It is not a claim that the four original perf failures are repaired; the physical driver scan remains. No changes to perf fixtures, budgets, windows, conditioning, workloads, identity holds, attempts, quotas or deletion intent.

## Final checks and sole code review

`pnpm --filter @terno/idb typecheck` passes (types-final.log). `pnpm exec oxlint --deny-warnings packages/idb/src/mail.ts packages/idb/src/bulk-action-locality.test.ts` passes (lint-final.log).

Guarded `pnpm exec vitest run --project=unit packages/idb/src/bulk-action-locality.test.ts packages/idb/src/idb.store.test.ts packages/idb/src/imap-identity.test.ts packages/idb/src/cached-refresh.test.ts packages/idb/src/idb.conformance.test.ts` completes exit0:676pass,2 existing historical-binary skips,5files,65.60s (callers.log). No skips were added. This covers store conformance, identity/legacy upgrade holds, cached-reader upgrade/durability and the public grouping/Undo regression. No broad suite or build was invoked.

Exactly ONE native read-only code-review round completed exit0 with `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only -C <checkout> -`: Standards0 findings, Spec0 findings, no lower backlog. Evidence code-review.log. No second review or provider/model fallback. The reviewer checked the revised spec, the complete three-file diff from c9b935f8, and retained RED/GREEN evidence. No review fixes were needed.

Final affected-file command (guarded): `pnpm exec vitest run --project=perf packages/idb/src/idb.perf.test.ts -t 'the unread filter pages|People and Waiting|cached refresh keyset' --reporter=verbose --disableConsoleIntercept`. Final exit0:3passed,7unselected,174.73s; unread160,854ms, People5,550ms, cached1,732ms (idb-targeted-final.log). The bulk-read page is1.83ms versus16ms. This selects the original bulk-read mutation caller plus People/cached gates; it is not whole-file qualification. Native deadlines remain setup900,000ms, unread900,000ms, People900,000ms, cached600,000ms; finite total allowance is3,420s including120s reserve, with no silence-based cutoff. Own invocation identities captured: pnpm60466/node60469, both born Fri Oct30 09:34:06 2026. No processes were killed. The original quick-filter timeout is not replayed again before the shared simulator bottleneck is corrected; no all-four-green claim.
