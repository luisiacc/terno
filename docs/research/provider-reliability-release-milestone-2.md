# Provider reliability: second release milestone

Main `59b3661b193281c07e170cdabe49525546214fc2` remained clean and unchanged throughout. All required gates ran once; no supervisor interruption. **Not release-green.** Original logs, lifecycle, traces, fresh binary identities and preservation records: `/tmp/terno-release-milestone2-zknp9dnl/report.md`.

| Gate | Result | Counts |
|---|---|---|
| Typecheck | PASS | exit0 |
| Lint | PASS | exit0 |
| Unit | FAIL | 11,698 pass /38 fail /3 skip;10 additional errors |
| WASM fallback | PASS | 1,822 pass /2 skip |
| E2E | FAIL | 1,514 pass /5 fail /7 skip |
| Web | PASS |49pass |
| UI perf | PASS |62pass |
| Backend perf | FAIL |270pass /6fail /1skip |
| macOS package | PASS | ad-hoc; no notarization/update clearance |
| Fresh packaged smoke | FAIL |51pass /6fail /7skip /7not-run |

The normal unit shell chain prevented WASM; its unrun project ran once separately. Existing skips/not-run successors are not passes. Performance completed normally in3,772s, including one actual900,000ms test timeout; reporter silence was never used to terminate it. No general hang correction is claimed. Original outputs restored; captured owned processes gone. Fresh executable SHA256 `fd0b4ff9d1291588f641d8e30c4ff4b9deb3d6a91169907f4464595b1f767884`; asar `2d42124e8bde52e146d39817b50087d9ba0cd49845cbf0a842562ddb365f4246`. Archived under the evidence directory's `artifacts/final/apps/desktop/release`.

## Repair order and ownership

1. Renderer focus/admission: six unit files plus focus/subject/Forward E2E. Diagnose genuine focus regressions separately from obsolete EventTarget fixtures; preserve intent and draft/ACK fences. Renderer source serial; native-reload smoke follows this owner if shared.
2. IDB performance: four failing quick-filter/People/cached-refresh/removal cases, with actual timing, access-count and persistence attribution. Shared IDB/store changes serial, no weakening identity safety or budgets.
3. IMAP archive recovery: recurring unknown operation after unreachable-server recovery. Diagnose command/ACK/lifetime boundary; never convert uncertain mutation into automatic replay for a test.
4. SQL navigation and adaptive backend load gates after store ownership permits; packaged native reload/print fixtures after renderer work. Reuse fresh archived binary for fixture diagnosis; no per-fix new package build.

All repairs use isolated worktrees, fail-first tests, targeted checks, one completed code-review round per coherent series and atomic commits. Lower post-cap findings enter the worklist. No report scenario closes from these gate results alone.

## Exact failed tests

### 03-test.log

- |unit| packages/backend/src/network.int.test.ts > plan 20: mail comes back after the network changes > an archive made while the server is unreachable waits for the network (never failed), then runs after the change
- |unit| apps/web/src/components/draft-presentation-app-r1.test.tsx > Strip coordinates the real Reader frame (later user control false)
- |unit| apps/web/src/components/draft-presentation-app-r1.test.tsx > stored open cannot cancel a successor created by its synchronous UI publication
- |unit| apps/web/src/components/new-message-send-r8.test.tsx > split: an earlier Send respects same-key strip
- |unit| apps/web/src/components/new-message-send-r8.test.tsx > list: an earlier Send respects same-key strip
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > honors reply focus with the Reader frame true loading
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > honors reply focus with the Reader frame false loading
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > a pending reply focus false a newer gated forward
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > an old bulk-canceled lookup cannot cancel a newer deliberate open
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > preserves a pending reply through StrictMode Reader setup after the request starts
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > does not let old Reader cleanup cancel a replacement Reader's pending reply
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > does not let retired Reader cleanup cancel a newer request during replacement
- |unit| apps/web/src/components/reader-compose-focus.test.tsx > keeps a synchronous existing-draft open begun during a same-thread Reader replacement
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late edit without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late account without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late discard without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late navigation without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late intent without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late recovery without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late sending without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late capture without overwriting work or Undo
- |unit| apps/web/src/lib/forward-capture.test.ts > asset validation fences late focus without overwriting work or Undo
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences UI roundtrip while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences source roundtrip while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences account roundtrip while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences mode roundtrip while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences attachment roundtrip while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences quote roundtrip while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences forged auto while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences selection intent while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences navigation roundtrip while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences recovery while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences reentrant restoration while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences missing response while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences rejected save while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences recipient while retaining authored work
- |unit| apps/web/src/lib/forward-empty-owner-phase.test.ts > forward empty-owner flush fences body while retaining authored work
- |unit| apps/web/src/lib/page.test.ts > what the fourth Codex review found > r on a conversation still loading, then Back: no draft is created and nothing takes focus later

### 07-perf.log

- |perf| packages/backend/src/load.perf.test.ts > a disk that turns slow mid-job: one slice runs over, the next ones shrink back under budget
- |perf| packages/db/src/perf.perf.test.ts > navigation > opens threads
- |perf| packages/idb/src/idb.perf.test.ts > the quick filters (plan 15) page from their own orders: with attachments and starred, cold, every page, counts and walks within a frame; 5,000 stars at once
- |perf| packages/idb/src/idb.perf.test.ts > People and Waiting (plan 17) page from their own orders: every page, counts and walks within a frame; dense, empty, every waiting date expired but twenty
- |perf| packages/idb/src/idb.perf.test.ts > cached refresh keyset traversal at 50k never stalls a frame
- |perf| packages/idb/src/storage.perf.test.ts > a removal unit's synchronous part fits a bulk slice (its IndexedDB write is asynchronous)

### 04-e2e.log

- 1) [e2e] › e2e/composer-account-recovery.spec.ts:45:5 › background OAuth recovery preserves authored composer and caret (dark) @design
- 2) [e2e] › e2e/list-layout.spec.ts:139:3 › the List layout › r opens the inline draft on the page (also from the list); Esc collapses it, a second Esc goes back @design
- 3) [e2e] › e2e/reply-subject.spec.ts:22:5 › normalized subject forward (light): chips, queue and SMTP keep recipients and source
- 4) [e2e-lumen] › e2e/list-layout.spec.ts:139:3 › the List layout › r opens the inline draft on the page (also from the list); Esc collapses it, a second Esc goes back @design
- 5) [e2e-atelier] › e2e/list-layout.spec.ts:139:3 › the List layout › r opens the inline draft on the page (also from the list); Esc collapses it, a second Esc goes back @design

### 09-smoke.log

- 1) e2e/native-reload.smoke.ts:65:45 › real stopped-engine modal permits keyboard Review of missing work (lumen)
- 2) e2e/native-reload.smoke.ts:65:45 › real stopped-engine modal permits keyboard Review of unknown work (lumen)
- 3) e2e/native-reload.smoke.ts:203:54 › native menu and CmdR/CmdShiftR retain missing work, and only disclosed override discards it
- 4) e2e/native-reload.smoke.ts:203:54 › native menu and CmdR/CmdShiftR retain unknown work, and only disclosed override discards it
- 5) e2e/native-reload.smoke.ts:258:1 › native reload holds the exact saved ACK through changed focus and document commit
- 6) e2e/print.smoke.ts:103:3 › long-urls: real PDFs with headers and content only, on Letter and A4


## Landed repair: archive network fixture boundaries

`76f30095` retains succeeded for controlled pre-mutation recovery and adds a real applied-MOVE/withheld-ACK unknown/no-replay witness. Provider-reset completion is observed before reopening refused traffic. Exact remote identity/content, attempts, recovery and unresolved fences remain asserted; no production edit. Root passes19network+5directambiguity controls, scoped types/lint/whitespace. One code review: Standards0/Spec0. Historical uninstrumented timing is not attributed or waived. [Details](../plans/drafts/release2-network-archive.md). Full milestone remains failed until later integration qualification.


## Landed repair: renderer compose focus and readiness

`49e8b822` prevents successful focus placement from triggering Reader fallback and preserves displayed sending-compose identity. Native EventTarget fixtures and revealed-field readiness checks preserve original scenarios. Root161direct+60three-design browser cases/types/lint/axe pass after rebase; light/dark captures inspected. One review leaves a P2 older-stored-open race backlogged; no second round or clean review claim. Separate rapid cross-field reveal-focus and native smoke dependencies remain. [Commands, counterexamples and limits](../plans/drafts/release2-renderer-focus.md). No full-renderer or release clearance.


## Landed repair: bulk IDB grouping

`8f520ff0` replaces repeated target-array copies with bounded per-account append. Root676direct checks/reopen/Undo, types/lint and3original selected perf cases pass after rebase. One review0findings. Original quick-filter timeout remains unqualified; storage removal still fails840.14ms/15ms, with fake-indexeddb index deletion scans identified as a concrete shared-dependency handoff. No index/safety/timing waiver or original all-four-green claim. [Exact attribution and limits](../plans/drafts/release2-idb-performance.md).


## Landed repair: repeated SQL navigation

`2c494cb8` adds a single bounded private thread cache with mutation isolation, real autocommit/version guards, race-bracketed retention and close disposal. Root90native/WASM checks/types/lint and unchanged34-case perf file pass;5,000-message repeated-read p95is1.5305ms/5ms, random0.11175ms/5ms. One review0findings. Cold materialization and exact heap measurement remain unqualified; no payload, schema, sample or budget changes. [Design, commands and limits](../plans/drafts/release2-sql-navigation.md).
