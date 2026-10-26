# Plan 30: Local search date boundaries (S57 / W11)

Status: parser fixes green; boundary qualification green; final checks and parent-assigned implementation review pending, 2026-10-26.

## Request and evidence

Implementation assignment (verbatim):

> Implement/qualify report S57 local date search boundaries (W11), main checkout /Users/Luis/projects/emailclient no branch/worktree/push. User explicitly requires every applicable reportiteminvestigated/spec/testfirst/fix/atomiccommit/separateCodexreview. Read AGENTS.md, relevant search plans/domain ADRs, docs/research/provider-reliability-report.md and baseline S57. Ownership only: docs/plans/30-search-date-boundaries.md; packages/core/src/search/parse.ts anddate-relatedpublictests (existingparse.test.ts okay); NEW dedicated SQL/IndexedDB/RPC integrationtests fordatequeries. Do NOTedit core model/schema/RPCtypes/storeimplementation/conformance/store.ts/DB/IDBmigrations/handlers/UI; attachmentworker owns those and parent owns backendcore/auth/Gmail. If actualSQL/IDBquerybug requires a storefix, send exact patch toparent forcoordination instead ofediting sharedstorefiles. You are not alone; preserveotheredits; stageonlyownedfiles underexclusivefcntl /tmp/terno-provider-hardening-commit.lock, roothelper /tmp/terno-provider-hardening.x0emTS/commit.py --subject --body explicitfiles. Footer Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>. Scope: date-range local AST exact epoch boundaries acrossmidnight/DST/timezones including non-PST; explicit inclusive/exclusive before/after/on semantics (readexistingUX first); parseinvaliddates safely, preservekeysetquerysemantics andstoreparity, do notaddremoteGmailUIsearchdependency. Publicseammeaningfultestsatparser→queryresultinbothstores usingtemporarysyntheticfixtures; spawnprocesseswithTZ toavoidglobaltimezonecross-test races whereappropriate. No realprofiles/secrets/liveproviders. Writeplanwithuserrequestreference/spec/existingbehavior/tests/perf/outofscope, read-onlycodexplancritiqueandrecordrevisions beforefix. Provefailuresbeforefix; ifalreadycorrect, addnecessaryqualificationtestsandrecordhonestdispositionnotinventfeature. Atomiccommitsonlyno push. Maintainperformance no newscans/iteratingdatefiltersinJSat50k; noUIstringsunlessneededthenen/escoordinate. Runappropriate targetedtests/type/lint. Do notspawnfinalreviewer:parentwillassign distinctCodexreviewofexactcommits. Returnbase/head/ownedfiles/red-green/exacttestresults/perfimplications/limitations andanyparentintegrationpatch.

References: report acceptance scenario 57; baseline S57 (`provider-reliability-baseline.md`); W11; plans 03, 04 and binding 03–04 reconciliation; `docs/PLAN.md` and `docs/STORAGE.md`. No separate domain CONTEXT/ADR files exist in this checkout.

## Existing behavior

`parseSearch` supplies the local AST to both stores. `SearchQuery.after` is inclusive (`>=`), `before` exclusive (`<`), and absolute dates are constructed in the runtime's local timezone. Negated bounds complement those predicates. Relative dates subtract elapsed days/weeks/30-day months/365-day years from the supplied clock. `docs/PLAN.md` lists only `before:` and `after:`; there is no `on:` operator or date-specific UI flow. Existing tests explicitly accept JavaScript calendar rollover (February 30 becomes March 2). SQL and IDB apply date predicates to one message before deduplication and page threads by `(lastDate DESC, id DESC)`. Cursors retain the typed query key, scope, and revision.

## Specification

- Preserve `after:D` as at or after local midnight on D, and `before:D` as strictly before local midnight on D. `-before:D` equals `after:D`; `-after:D` equals `before:D`.
- “On D” means the existing range `after:D before:next-calendar-day`. Do not introduce an `on:` operator. The end is the next local midnight, never `start + 24h`: DST days can last 23 or 25 hours. Unknown `on:` remains literal text.
- Preserve absolute forms `YYYY-MM-DD` / `YYYY/MM/DD` (one- or two-digit months/days remain supported). Accept real Gregorian dates only. Reject zero/out-of-range month/day and non-leap February 29; do not silently roll into another month. Handle years 0000–0099 literally rather than JavaScript's implicit 1900 offset. A skipped local midnight may normalize within that calendar date; a wholly skipped date is invalid.
- Invalid date operators retain their existing literal-term fallback, including negation/prefix behavior. Never emit NaN or Infinity into the AST, including relative overflow or an invalid supplied clock.
- Relative units remain elapsed durations, including across DST; this task does not redesign them as calendar arithmetic.
- Exact millisecond fixtures must prove both bounds and complements, same-message conjunction, thread deduplication/recency ordering and tie-safe keyset pages through public APIs in both stores. Use independently specified UTC instants, including UTC, a non-PST fixed-offset zone and spring/fall DST zones. No global `process.env.TZ` mutation inside shared test workers.

## Tests and implementation sequence

1. Run a read-only Codex plan critique before implementation; record revisions here.
2. Add qualification tests for local midnight/ranges with literal UTC expectations in separate `TZ` processes. Exercise SQL and IDB exact fallbacks and the caught-up instant engine; include dedicated RPC `threads.search` coverage with synthetic accounts/messages and no providers.
3. Add a failing public parser regression for invalid calendar rollover, fix minimally, run green. Repeat for early years and non-finite relative boundaries as needed. Keep already-correct midnight/DST behavior an honest qualification, not a claimed fix.
4. Run targeted parser/store/RPC suites, package type checks and lint. Run relevant existing search perf gates without new scans, timing budgets or dependencies. Parent coordinates full repository gates and the distinct final Codex review of exact commits. Report any failures and exclusions.

Fixtures use temporary SQL databases and isolated fake IndexedDB databases with cleanup. Assertions inspect public search results, not internal tables. Test-only process orchestration may launch Vitest with a fixed `TZ`; no production timezone state changes.

## Performance and scope

Parsing remains constant work per operator; no new timers, network, result scans, store changes or persistent data. Existing SQL index/IDB and instant query plans stay intact. No models, schemas, migrations, RPC contract, handlers, UI, locale strings, Gmail search syntax/dependency or live provider work. Any store bug is escalated as an exact proposed patch to the parent, never edited here. Owned files only are staged/committed with the shared fcntl helper; no branch/worktree/push.

## Revisions after the Codex review

Read-only `codex exec -s read-only -C /Users/Luis/projects/emailclient -` completed before any production fix (transcript `/tmp/terno-s57-plan-review.txt`). Ten points accepted:

1. Include São Paulo's skipped midnight (01:00 start) and Apia's skipped calendar date. A skipped date is invalid; expressing the previous day uses the next existing date. No new operator/API.
2. Negation complements message predicates, not sets of conversations: a spanning conversation can match both complements.
3. Specify UTC instants and expected ordered fixture labels independently of the production parser/oracle, including mixed-message conjunction and newer out-of-range thread messages.
4. Cover disabled-index fallback and explicitly settled/asserted instant routes; exercise date-only, text and exact-sender SQL plans.
5. Preserve mixed separators and last-assignment-wins repeated effective bounds.
6. Cover leap centuries, years 0000–0099, month/day limits, non-finite clocks and relative arithmetic overflow; absolute dates remain independent of `now`.
7. Assert full literal fallback terms (positive/negative/quoted/trailing space/Spanish) and prove invalid date text remains searchable through stores.
8. Exercise real RPC handlers/transport/store with an injected fixed backend clock, absolute/relative ranges and account scope.
9. Freeze the clock for pagination. Relative cutoffs may move between requests without invalidating the existing query key; no frozen-bound cursor changes.
10. Name dedicated test files and use process-isolated TZ runs for both `unit` and `db-wasm`. These fixtures qualify Node/fake-IDB, not real browser timezone execution.

Dedicated fixtures: `packages/db/src/test/search-dates.ts`; SQL `packages/db/src/search-dates.test.ts`; IndexedDB `packages/idb/src/search-dates.test.ts`; RPC `packages/backend/src/search-dates.int.test.ts`; isolated-TZ driver `packages/db/src/date-timezones.test.ts`. The driver passes `TZ` only to child processes, covering eight zones in the appropriate Vitest project. Suites select independently specified fixtures using the runtime's reported zone (normal direct runs also exercise supported zones). IDB's existing sliced fallback scan remains unchanged; no additional production scanning.

## Execution and disposition

### Parser red/green

- Calendar validation: `pnpm exec vitest run --project unit packages/core/src/search/parse.test.ts` failed **9/21** before the fix (`/tmp/terno-s57-calendar-red.txt`), then passed **21/21** (`calendar-green.txt`). These tests supersede the old explicit acceptance of February 30 rollover; assert full invalid literal tokens and preservation of previous valid bounds.
- Early years: the next public regression failed **1/22** (`/tmp/terno-s57-years-red.txt`), then passed **22/22** (`years-green.txt`) after removing the constructor's implicit 1900 mapping for four-digit years below 100.
- Non-finite relative cutoffs: the next regression failed **1/23** (`/tmp/terno-s57-finite-red.txt`), then passed **23/23** (`finite-green.txt`) after validating the computed boundary. Absolute dates do not depend on the supplied clock; elapsed-unit behavior is unchanged.

### Boundary qualification and disposition

The existing local-time and query implementations already implement S57's valid-date boundaries. No SQL/IDB query defect was found and no store patch is required. Dedicated fixtures prove exact start inclusion/end exclusion, complements, same-message date/text predicates, deduplication, recency ordering when the latest message is out of range, tied keyset pages, changed-query cursor refusal, absolute/relative RPC clock behavior, and literal invalid input search.

Eight isolated zones cover UTC, Costa Rica, Kathmandu, New York/Berlin spring and autumn, Lord Howe's 30-minute changes, São Paulo's skipped midnight and Apia's skipped date. “On D” uses existing date bounds; the end is the next existing local date if a calendar date was skipped. Negated bounds complement message predicates, so the same conversation may match both complements through different messages. Relative-date cursors retain existing moving-clock behavior; exact pagination here freezes the clock.

Commands and final results are recorded below as checks complete. Initial fixture failures caused by concurrently incomplete attachment ingestion edits were reported to the parent; the attachment owner repaired those shared files. They are not claimed as date-search defects.

The parent will assign a distinct Codex code review of the exact commits. No final reviewer was spawned by this implementation agent. Full repository/e2e/web/UI performance and desktop packaging gates remain parent integration responsibility; no UI or desktop-only path changed.
