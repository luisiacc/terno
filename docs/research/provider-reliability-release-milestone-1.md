# Provider reliability: first release milestone

The complete release gates ran once, serially, on clean main `2ac773241eca16e0926539bc66ff7099adfb6760` on 2026-10-30. Main remained unchanged and clean. **This milestone failed; no release clearance is claimed.** Passing targeted workgroup checks did not establish integration correctness.

## Results

| Gate | Result | Observed counts | Seconds |
|---|---|---|---:|
| Typecheck | PASS | Command exit 0 | 5.3 |
| Lint | PASS | Command exit 0 | 0.3 |
| Unit | FAIL | 11,609 passed; 66 failed; 3 existing skips | 140.5 |
| SQLite-WASM, separately after unit stopped the normal chain | FAIL | 1,806 passed; 4 failed; 2 existing skips | 41.5 |
| E2E | FAIL | 1,499 passed; 20 failed; 7 existing skips | 645.0 |
| Standalone Web | FAIL | 45 passed; 3 failed | 239.5 |
| UI performance | FAIL | 23 passed; 1 failed; 38 serial successors not run | 563.1 |
| Backend performance | INCOMPLETE / FAIL | At least 33 passed and 1 failed; remaining counts unknown | 1,877.6 |
| macOS package | PASS | Command exit 0; ad-hoc signature only | 29.7 |
| Fresh packaged smoke | FAIL | 62 passed; 2 failed; 7 existing skips; one additional teardown error | 689.8 |

The backend performance run was interrupted after a CPU-bound process and approximately29minutes without console output. Only captured owned PIDs were signalled and reaped. Later artifact inspection found reports progressing through05:28 local time despite the silent reporter; some cases explicitly allow1,200–3,600seconds. Therefore the interruption is an incomplete gate, not proof of a hung loop or an exceeded timeout for the active case. The only console-reported completed file was `packages/db/src/perf.perf.test.ts` (33passed, one account-folder navigation failure); intermediate reports are not test pass verdicts. Remaining counts are unknown.

Full argv, timestamps, exit status, captured PIDs, before/after HEAD, logs, traces and individual failure names are preserved in `/tmp/terno-release-milestone-b8pxg8w6/report.md` and `results.json`. External network traffic was blocked with `/tmp/terno-network-guard.cjs`; guard rejections are failures to investigate, not permission to contact real endpoints. Existing package/stage/test artifacts were restored. The fresh package is retained under that evidence directory's `milestone/apps/desktop/release/`. No signed-update or notarization clearance is claimed.

## Repair order and file overlap

These are observed signatures, not established root causes. Each fix requires an ordinary failing regression, a concrete diagnosis, targeted checks, one completed Codex code-review round and serial landing. Existing thresholds, inputs, safety assertions and skips stay unchanged. No full gate is rerun merely to seek a better result.

1. **Storage conformance and upgrades.** Investigate successful-operation attachment pin retirement across SQL, WASM and IDB; then migration/persistence fixtures and disk storage failures. This owns the shared store hot files; no concurrent workgroup may edit `sql-store.ts`, `idb/store.ts` or shared store contracts.
2. **Renderer draft admission and retention.** Investigate unit failures and direct browser callers in `drafts.ts`, attachment/Forward support and Send reservation. This owns renderer draft files and their fixtures; storage-production dependencies must be reported rather than edited in parallel with item 1.
3. **Backend performance hang.** Identify the unfinished test and reproduce with a finite captured-PID supervisor. Diagnose before proposing changes; never repeat the full suite. Renderer draft production files and shared store hot files are owned by items 1/2, so report any dependency instead of editing them concurrently.
4. **Protocol, icon and source checks.** IMAP mocks lack `locations.dispatch`; one unreachable-server archive stays unknown; icon fixtures hit the network guard. Localization, portability, untranslated strings, selection writes, oversized Gmail response and IDB scheduling also fail.
5. **Browser and package follow-ups.** Resolve remaining direct UI failures, sender-icon cleanup, CID timing and smoke startup after their store/renderer dependencies land. Inspect visual differences before considering baseline updates.

The remaining report scenarios and held round-two backlog remain distinct from milestone regressions. This inventory adds no scenario closure.

## Unit failures

### packages/core/src/localized.test.ts

- catalog messages from the backend > a catalog message survives a free-text column; plain text, and text that only looks like JSON, stays as it is — AssertionError: expected { …(2) } to deeply equal { …(2) }

### packages/backend/src/network.int.test.ts

- plan 20: mail comes back after the network changes > an archive made while the server is unreachable waits for the network (never failed), then runs after the change — AssertionError: expected 'unknown' to be 'succeeded' // Object.is equality
- plan 20: the IMAP provider's own connections > two callers asking for a session together share one connection, and later calls reuse it — ProviderError: IMAP: locations.dispatch is not a function
- plan 20: the IMAP provider's own connections > a reset while the password is being read never connects on the old network (the call still succeeds) — ProviderError: IMAP: locations.dispatch is not a function
- plan 20: the IMAP provider's own connections > a reset while connecting abandons that session; the next one is kept and reused — ProviderError: IMAP: locations.dispatch is not a function
- plan 20: the IMAP provider's own connections > a reset closes the cached session at once (no LOGOUT on a dead socket) and the next call opens a new one — ProviderError: IMAP: locations.dispatch is not a function

### packages/db/src/portable.test.ts

- the portable layers (core, store contracts, db without the node driver, the backend and providers the web worker hosts) import no node: modules — AssertionError: expected [ …(4) ] to deeply equal []

### packages/db/src/store.conformance.test.ts

- attachment conformance: SqlMailStore (node-sqlite) > releases only the definitive successful operation pin (complete), through restart and cleanup — AssertionError: promise resolved "{ …(5) }" instead of rejecting

### packages/i18n/src/scan.test.ts

- the repo walk > no hard-coded user-facing strings in apps/*/src and packages/*/src — AssertionError: expected 'apps/web/src/lib/forward-raw-obligati…' to be '' // Object.is equality

### packages/idb/src/flag-parked-reads.test.ts

- rebuilds the memory index when opening physical 8 logical 21 metadata

### packages/idb/src/idb.uncertain-upgrade.test.ts

- adds empty Sent recovery stores to physical12 while preserving Plan68 folder membership and counts
- upgrades populated physical14 reply context and folders without inventing recipient receipts
- upgrades physical15 recipient evidence and copy ownership without losing its parts — ConstraintError: A mutation operation in the transaction failed because a constraint was not satisfied. For example, an object such as an object store or index already exists and a request attempted to create a new one.
- preserves a complete canonical physical9/logical23 fixture through the physical11 downgrade barrier — AssertionError: expected { physical: 19, logical: 30 } to deeply equal { physical: 17, logical: 29 }
- preserves a complete canonical physical10/logical23 fixture through the physical11 downgrade barrier — AssertionError: expected { physical: 19, logical: 30 } to deeply equal { physical: 17, logical: 29 }

### packages/idb/src/idb.conformance.test.ts

- attachment conformance: IdbMailStore (fake-indexeddb, exact scan) > releases only the definitive successful operation pin (complete), through restart and cleanup — AssertionError: promise resolved "{ …(5) }" instead of rejecting
- attachment conformance: IdbMailStore (fake-indexeddb, instant index) > releases only the definitive successful operation pin (complete), through restart and cleanup — AssertionError: promise resolved "{ …(5) }" instead of rejecting

### packages/idb/src/idb.persistence.test.ts

- closes the acquired connection when early load fails — AssertionError: expected UncertainWriteError: Could not verify the… { …(2) } to be Error: early load // Object.is equality
- restored instant index rechecks admission after delayed loading — AssertionError: expected null to deeply equal ObjectContaining{…}

### packages/idb/src/idb.uncertain-migration.test.ts

- protects legacy move migration writes on healthy completion — AssertionError: expected { writes: +0, errors: +0, …(1) } to deeply equal { writes: 2, errors: +0, …(1) }
- protects legacy move migration writes on abort completion — AssertionError: expected { writes: +0, errors: +0, …(1) } to deeply equal { writes: 2, errors: 1, …(1) }
- protects legacy move migration writes on prevented completion — AssertionError: expected { writes: +0, errors: +0, …(1) } to deeply equal { writes: 2, errors: 1, …(1) }
- does not clear the migration marker after unconfirmed child success — AssertionError: expected { hits: 1, terminal: 'abort', …(1) } to deeply equal { hits: 1, terminal: 'complete', …(1) }
- does not clear the migration marker after unconfirmed cursor exhaustion — AssertionError: expected { hits: +0, terminal: 'abort', …(1) } to deeply equal { hits: 1, terminal: 'complete', …(1) }
- does not clear the migration marker after unconfirmed callback throw — AssertionError: expected { hits: +0, terminal: null, …(1) } to deeply equal { hits: 1, terminal: 'abort', …(1) }
- retains uncertainty after a real prevented drafts migration error
- retains uncertainty after a real prevented settings migration error
- retains uncertainty after a real prevented messages migration error — AssertionError: expected { hits: 1, errors: 1, terminal: null } to deeply equal { hits: 1, errors: 1, …(1) }
- confirms the exact reply-child migration write in mixed v1: healthy — AssertionError: expected { markerSuccess: 1, …(5) } to deeply equal { markerSuccess: 1, …(5) }
- confirms the exact reply-child migration write in mixed v1: abort — AssertionError: expected { markerSuccess: 1, …(5) } to deeply equal { markerSuccess: 1, …(5) }
- confirms the exact reply-child migration write in mixed v1: prevented — AssertionError: expected { markerSuccess: 1, …(5) } to deeply equal { markerSuccess: 1, …(5) }

### packages/idb/src/ops-scale.test.ts

- ops scheduling at scale (IndexedDB) > a parked bulk archive and a trash over the same 100,000 messages: scheduling doesn't walk them — AssertionError: expected 10.116624999999999 to be less than 10

### packages/mail/src/gmail-transport.test.ts

- an oversized successful send response stays uncertain after exactly one submission — AssertionError: expected ProviderError: Gmail returned an incomple… { …(4) } to match object { retryable: false, ambiguous: true }

### apps/web/src/state/selection-write-source.test.ts

- keeps production app-store writes on the selection-aware setter — AssertionError: expected [ Array(1) ] to deeply equal []

### packages/backend/src/icons/fetcher.test.ts

- fetching a site's icon over HTTPS (plan 22) > the homepage's apple-touch-icon, fetched without query string, cookies or referrer, every request asked of the policy
- fetching a site's icon over HTTPS (plan 22) > falls back to /favicon.ico (its largest PNG entry) when the page names nothing usable
- fetching a site's icon over HTTPS (plan 22) > an icon on another site (a CDN, a tracker) is never requested: zero requests there, the domain's favicon instead
- fetching a site's icon over HTTPS (plan 22) > redirects: within the site freely, to one other site once, never a second one, never to http
- fetching a site's icon over HTTPS (plan 22) > bodies over the cap aren't read: a huge page is skipped, a huge icon refused
- fetching a site's icon over HTTPS (plan 22) > content-type spoofing: an HTML 'image/png' or a GIF is not an icon
- fetching a site's icon over HTTPS (plan 22) > a name resolving to a private or loopback address is never connected to (the real address check)
- fetching a site's icon over HTTPS (plan 22) > a discarded answer (an error page, a redirect) is never read to its end: its connection is closed at once (Codex review) — Error: External network blocked by test guard
- fetching a site's icon over HTTPS (plan 22) > a site that doesn't answer in time is a timeout (retried later), not 'no icon' — AssertionError: expected Error: External network blocked by test g… to match object { name: 'IconNetworkError', …(1) }
- fetching a site's icon over HTTPS (plan 22) > an unreachable site is a network error (nothing cached) — AssertionError: expected Error: External network blocked by test g… to be an instance of IconNetworkError

### apps/web/src/lib/attachment-admission.test.ts

- an adopted upload is retained after a refused save acknowledgement
- an adopted upload is retained after a missing save acknowledgement — AssertionError: exact predeclared refusal request: expected [ 'drafts.save', …(1) ] to deeply equal [ 'drafts.save', …(1) ]

### apps/web/src/lib/attachment-upload-store.test.ts

- SQL: upload completion validates latest Forward union and cleans only unadopted refs (99 files)
- SQL: upload completion validates latest Forward union and cleans only unadopted refs (100 files) — AssertionError: expected [] to have a length of 1 but got +0
- SQL: upload completion validates latest Forward union and cleans only unadopted refs (99 files) — AssertionError: complete fixture RPC trace: expected [ …(199) ] to deeply equal [ …(200) ]
- SQL: upload completion validates latest Forward union and cleans only unadopted refs (100 files) — AssertionError: complete fixture RPC trace: expected [ …(201) ] to deeply equal [ …(302) ]
- IDB: upload completion validates latest Forward union and cleans only unadopted refs (99 files)
- IDB: upload completion validates latest Forward union and cleans only unadopted refs (100 files) — AssertionError: expected [] to have a length of 1 but got +0
- IDB: upload completion validates latest Forward union and cleans only unadopted refs (99 files) — AssertionError: complete fixture RPC trace: expected [ …(199) ] to deeply equal [ …(200) ]
- IDB: upload completion validates latest Forward union and cleans only unadopted refs (100 files) — AssertionError: complete fixture RPC trace: expected [ …(201) ] to deeply equal [ …(302) ]

### apps/web/src/lib/draft-idb-upgrade.test.ts

- upgrades a minimal v8 drafts+meta row fixture to physical11 without rewriting work and refuses v8 reopen — NotFoundError: The operation failed because the requested database object could not be found. For example, an object store did not exist but was being opened.

### apps/web/src/lib/drafts-attachments-store.test.ts

- SQL: From-B Forward refusal preserves exact work and subsequent autosave/reload (binary)
- SQL: From-B Forward refusal preserves exact work and subsequent autosave/reload (empty) — AssertionError: expected { id: 1, account_id: 1, …(22) } to match object { Object (account_id, mode, ...) }
- SQL: From-B Forward refusal preserves exact work and subsequent autosave/reload (binary) — AssertionError: complete fixture RPC trace: expected [ [ 'attachments.info', …(1) ], …(1) ] to deeply equal [ [ 'attachments.info', …(1) ], …(2) ]
- SQL: From-B Forward refusal preserves exact work and subsequent autosave/reload (empty) — AssertionError: complete fixture RPC trace: expected [ [ 'attachments.info', …(1) ], …(1) ] to deeply equal [ [ 'attachments.info', …(1) ], …(2) ]
- IDB: From-B Forward refusal preserves exact work and subsequent autosave/reload (binary)
- IDB: From-B Forward refusal preserves exact work and subsequent autosave/reload (empty) — AssertionError: expected { id: 1, …(23) } to match object { Object (account_id, mode, ...) }
- IDB: From-B Forward refusal preserves exact work and subsequent autosave/reload (binary) — AssertionError: complete fixture RPC trace: expected [ [ 'attachments.info', …(1) ], …(1) ] to deeply equal [ [ 'attachments.info', …(1) ], …(2) ]
- IDB: From-B Forward refusal preserves exact work and subsequent autosave/reload (empty) — AssertionError: complete fixture RPC trace: expected [ [ 'attachments.info', …(1) ], …(1) ] to deeply equal [ [ 'attachments.info', …(1) ], …(2) ]
- SQL: terminal delete retains current rich work and exact files through explicit copy and reopen
- SQL: terminal send retains current rich work and exact files through explicit copy and reopen
- IDB: terminal delete retains current rich work and exact files through explicit copy and reopen
- IDB: terminal send retains current rich work and exact files through explicit copy and reopen — AssertionError: exact predeclared refusal request: expected [ 'drafts.save', { id: 1, …(20) } ] to deeply equal [ 'drafts.save', { id: 1, …(19) } ]

### apps/web/src/lib/forward-capacity-store.test.ts

- SQL: Forward admits exactly 100 refs and refuses 101 before mutation; later autosave survives reopen (99 authored) — AssertionError: expected { showSourceContext: false, …(18) } to deeply equal { showSourceContext: undefined, …(18) }
- IDB: Forward admits exactly 100 refs and refuses 101 before mutation; later autosave survives reopen (99 authored) — AssertionError: expected { showSourceContext: false, …(18) } to deeply equal { showSourceContext: undefined, …(18) }

### apps/web/src/lib/send-reservation-r9.test.ts

- reserves Send before synchronous subscriber reentry (reenter=true)
- reserves Send before synchronous subscriber reentry (reenter=false) — Error: Test timed out in 20000ms.

### apps/web/src/lib/ui-publication-writer.test.ts

- SQL: UI publication retains Writer work through nested stopping
- IDB exact: UI publication retains Writer work through nested stopping
- IDB instant: UI publication retains Writer work through nested stopping — AssertionError: expected [ { id: 1, …(20) } ] to have a length of +0 but got 1

## Other failing integration cases

- SQLite-WASM: attachment pin conformance repeats the unit failure. `packages/db/src/storage.test.ts` has three failures: database opening, restart-VACUUM state and `noRoom` expectation.
- `apps/web/e2e/compose.spec.ts`: collapsed draft focus, mode conversion preserving authored text, and pending Send reopening (multiple designs).
- `apps/web/e2e/composer.spec.ts`: immediate typing after reopen.
- `apps/web/e2e/designs.spec.ts`: draft retention during live design switching.
- `apps/web/e2e/draft-normalization.spec.ts`: missing original context across three designs.
- `apps/web/e2e/draft-checkpoint-recovery.spec.ts`: rich authored checkpoint in Atelier.
- `apps/web/e2e/cid-render.spec.ts`: maximum CID final serialization timing.
- `apps/web/e2e/gmail-wire.spec.ts`: missing `window.TernoSend`.
- `apps/web/e2e/reply-subject.spec.ts`: changed/normalized subject Forward produces zero SMTP submissions.
- `apps/web/e2e/visual.spec.ts`: light search results and category picker/snackbar baselines differ.
- `apps/web/e2e/print.spec.ts`: Lumen toolbar/menu/palette print focus timeout.
- `apps/web/e2e-web/storage-send.web.spec.ts`: pending Send storage-switch refusal assertion.
- `apps/web/e2e-web/conformance.spec.ts`: OPFS SQLite and native IDB attachment pin assertion.
- `apps/web/e2e/perf.spec.ts:234`: sender icons remain after `icons.forget`; 38 following serial cases unrun.
- `apps/desktop` `notify.smoke.ts:116`: IMAP account dialog does not close; teardown times out.
- `apps/desktop` `people.smoke.ts:83`: v13 People-profile startup does not show its first thread within 60 seconds.

The original report contains exact project variants, full test names, expected/received values and retained traces. No missing count or unfinished oracle is credited as a pass.

## Landed repair: storage conformance and IDB upgrades

`df46ed46` addresses the stale unknown-operation completion expectation and IDB historical schema, migration fault activation, delayed loading and early-load exception identity. Root's rebased targeted qualification:84upgrade/persistence +62adjacency +12Node/fake-IDB +4WASM cases pass; store/db/idb/web types, scoped package lint and whitespace pass. One native code review: no Standards/Spec findings. See [Plan76](../plans/76-store-release-repair.md). This does not replace the failed milestone result.

OPFS remains unverified after worker timeouts. Native IDB's unintentionally expanded608-pass/2-existing-skip observation is separately recorded. The three Node-disk/WASM-adapter storage failures remain open. No full gate was replayed, no thresholds or safety assertions relaxed, and no held feature backlog was reworked.

## Landed repair: renderer admission

`4a945b1b` normalizes new draft representation and permits read-only pending-Send reopening while retaining strict edit/Send admission. Root's rebased266unit/direct cases,8affected perf cases and18selected browser cases pass; web types/lint and light/dark visual inspection pass. One code-review P2 dev-port finding received a failing regression and fix. See [the renderer repair record](../plans/drafts/release-renderer-admission.md). Immediate-typing and lazy-browser interception failures remain open, and the original full milestone remains failed.

## Performance interruption investigation

Evidence-only `c74cda0b` records bounded probes and external lifecycle reporting. No hung loop or production cause was reproduced, so no speculative correction or code-review clearance is claimed. Silent console output did not mean execution stopped: preserved load/facts/categorization artifacts postdate the last log line. The original gate remains incomplete. See [the exact investigation](../plans/drafts/release-perf-hang.md).

Separate actual failures were observed: database account-folder membership, ingestion throughput, categorization throughput and one Forward CPU sample. Overlapping diagnostic runs are not serial timing qualification. No threshold/input/scheduling change or full-gate replay occurred. Future milestone supervision must observe test/hook progress and respect each actual declared timeout; a longer unobserved run is not itself a correctness fix.

## Landed repair: isolated network fixtures

`c5c950ad` repairs four IMAP session fixture/API mismatches and ten icon fixture/guard mismatches. Root passed29targeted tests and backend types/lint after rebase. Production is unchanged; valid synced source identity, guarded original-host DNS, TLS policy and external isolation remain asserted. One review P2 lifetime finding received a failing regression and fix. [Details](../plans/drafts/release-network-repair.md).

The archive-unknown observation remains unexplained. Stronger exact source/destination and stable local identity witnesses pass, but repeated passing attempts do not count as its correction.

## Landed repair: driver contracts and folder perf fixture

`19e46fc4` preserves the three native disk/fault tests, routes them to the native project with actual discovery regression, and supplies explicit WASM image reclamation/reopen/legacy-space tests. No runtime skips or production changes. The 5,000-message folder recovery fixture now uses fresh trusted source identities while proving prior reset identities remain held; original timing and membership/removal gates remain. Root's 9 storage/discovery + 82 direct-caller + 1 affected perf cases, db types, lint and final whitespace pass after rebase. One native review: no findings. [Details](../plans/drafts/release-db-driver-folder.md).

This resolves the identified native-disk/WASM image mismatch and account-folder fixture failure, not OPFS, throughput or the incomplete full perf gate.

## Landed repair: source/catalog contracts

The localized roundtrip, portable graph, fixture-label and selection-source failures now pass. The scanner ignores erased TypeScript import types but still follows runtime imports, including side effects; the test helper follows the existing test-directory convention with production-violation controls. Approved catalog copy is preserved. Root's 66 targeted tests, core/db/i18n/web types, lint and whitespace pass after rebase. One native review: zero findings. No production mail or scanner allowlist bypass. [Details](../plans/drafts/release-source-contracts.md).

## OPFS terminal verification

The missing direct OPFS verification is now complete on unchanged conformance/runtime source at `3e0beb36`: the original Chromium-worker SQLite-WASM sahpool case passes, with 304 nested passes, one existing legacy-schema skip, zero failures and done=true/error=null. Complete/markSent pin release and independent ownership/reopen/crash controls pass. No source edits or full gate replay. Evidence: `/tmp/terno-opfs-verification-43935e92/README.md` and `state.json`. Later source/catalog test-only changes do not alter this graph. Main still has other release failures.

## Landed repair: early Reply typing

`6906b10c` preserves native text/caret/range across asynchronous source admission and the validated focus handoff. The original immediate-typing case is unchanged; 29 selected browser cases pass across macOS/Lumen/Atelier, including faithful deferred-editor controls. Root's direct, stored-view and reentrant-focus controls, types, lint and whitespace pass after rebase. All three findings from the single native code review were addressed; no extra round. [Exact scope and limits](../plans/drafts/release-early-compose-input.md). Full renderer/performance/release clearance remains open.
