# Plan 26: provider reliability

Status: in progress on `main`. Baseline: `11092b6e48c947e2bde60d2b1b3dd34abb19cb5d` (application code unchanged from research snapshot `35509d2`).

## Request (verbatim)

> I want you to go through every item to fix here in this report. For each item that needs fixing you already have, in that report, what needs to be done but for each item you need to:
> 1. Go for that item.
> 2. Spec it out a bit more.
> 3. Do maybe a better investigation on it to see what's truly needed for us.
> 4. Build a test case reproducing that scenario, that potential scenario, or multiple test cases.
> 5. Fix it.
> 6. That will do it.
> 7. Spawn a subagent with Codex doing a code review of that fix, of that code you have just fixed and/or added.
> 8. Fix any findings.
> create atomic commits as you are fixing things.
> That way there is a double check on what you're doing and this can be better. Of course we need to maintain our performance while doing this and follow the directives that we have. You're going to do this for each and every one of the items that you have done here.
> Let's not create a separate branch or anything like that. Let's just do the fixes right here in the main branch. You should not stop until everything in that report is done.

## Scope and accounting

The research report contains 10 Terno follow-ups, 83 external evidence entries and 60 acceptance scenarios. The [coverage ledger](../research/provider-reliability-worklist.md) accounts for every ID. Related entries may share a fix, but each retains its own disposition, evidence, review and commit references. Existing protection requires actual test evidence; an old plan deferral does not dispose of newly authorized work. Hosted-service details are translated to Terno's local architecture rather than introducing a mail proxy.

Each fix proceeds through investigation, a concrete specification, failing behavior tests, implementation, Codex subagent review, regression tests for findings and an atomic commit. Follow-up specifications and validation results are recorded here or in linked feature plans as their scope becomes concrete. No push or branch creation.

## What exists

Read plans 03–04 reconciliation, 04 storage/web, 10 diagnostics, 16 composer, 20 connectivity and 25 sign-in before changes in those areas. The research snapshot has local durable operations, two stores with shared conformance, scripted providers and real-library fake IMAP/SMTP/Gmail servers, sign-in generation fencing and conservative network send ambiguity. Full report evidence is in [provider-reliability-report.md](../research/provider-reliability-report.md).

## Slice 1: T01 — accepted sends survive local completion failures

### Investigation and behavior

`BackendCore.executeOp` wraps provider execution, operation completion and local notification/categorization in one catch. A local storage failure is therefore classified like a provider failure. Both stores' `fail` operations currently permit a succeeded operation to return to the queue. The outer worker fallback can also retry a running send if error recording fails. Startup's running-send recovery does not protect an operation already requeued in the live process.

The invariant: after submission may have occurred, local completion/notification failure never makes the provider call automatically eligible again. A successfully committed operation remains succeeded. An uncommitted/uncertain completion remains unknown until explicit reconciliation or user resolution. Provider failures with definitive rejection, authentication requirements or pre-submission network failure retain their existing recovery semantics. Undispatched sends remain queued when quitting.

### Design

- Distinguish provider success from local completion failure within execution.
- Preserve terminal state when recording late failures in SQL and IndexedDB. Failure/unknown recording applies only to a claimed running operation; explicit unknown resolution remains the only manual transition back to a send retry.
- Make the outer unexpected-error fallback conservative for a dispatched send, including a failure of the first error-recording attempt.
- Keep existing op events, account sequencing, quiesce and network/auth behavior. No new polling, persisted timer, message payload copy or provider request.

### Tests and public seams

Use existing backend RPC (`compose.send`, `ops.list`, worker execution) with scripted provider acceptance and storage-boundary fault injection. Assert one accepted submission after advancing time, reconnecting and restarting. Exercise completion rejection before commit, rejection after commit and error-recording failure. Also use shared `MailStore.ops` conformance on SQL and IndexedDB to verify terminal results cannot be changed by stale failure/unknown callbacks. Existing real SMTP/Gmail ambiguity and quiesce tests remain mandatory.

Tests are written and observed failing before each implementation change. A provider invocation counter is the external submission oracle, not an assertion about private helper calls. Local store fault injection models the actual durable-store boundary.

### Performance and out of scope for this slice

This changes a low-frequency operation transition, not mailbox list queries. Use point lookups by operation ID only, no history scan or recurring work. Run targeted backend/store tests, typecheck/lint and relevant perf gates; complete all repository-required suites for the finished series. This slice does not yet add automatic send reconciliation, attachment transport, native Microsoft support or Sent-copy repair; those remain open ledger items.

## Revisions after the Codex review

The read-only Codex critique made nine concrete points. All are accepted: capture success immediately after execute resolves; make stale fail/unknown callbacks complete no-ops (including queued/auth/network states); isolate fallback persistence failures so the rest of a batch proceeds; retain in-flight send ownership through fallback so quiesce waits; preserve explicit unknown resolution; distinguish real transaction rollback from an adapter rejection; test post-completion failures separately; retain a submission oracle across a real reopen/reconnect; and assert no retry scheduling for settled/unknown operations. Additional regression cases are added as each boundary is implemented. Running sends remain noneligible if persistent storage is unavailable even for recovery; recovery attempts are bounded and do not strand the rest of the batch.

## Implementation, review and validation log

Initial red tests: backend completion failures before/after commit each produced two accepted submissions rather than one. A rejected unknown-state write also produced two submissions. Nine shared conformance cases failed because succeeded/unknown/failed rows returned to queued. Command: `pnpm exec vitest run --project unit packages/backend/src/backend.test.ts packages/db/src/store.conformance.test.ts packages/idb/src/idb.conformance.test.ts -t 'accepted send is never|late failure callbacks'`.

### Slice 1 implementation validation (before code review)

The backend now retains dispatched-send ownership through worker recovery and records provider acceptance before result processing. Local completion failures bypass provider retry classification. Both stores ignore stale fail/unknown callbacks, including settled, queued and parked operations, without recomputing thread state. The outer recovery is bounded: a second storage error leaves the running send noneligible, logs diagnostics, and allows other claimed operations to settle; startup recovery remains conservative.

Red: both completion cases and a lost unknown-state write produced two provider acceptances. Green: 26 focused cases; 549 tests passed (2 skipped) across backend operations, connectivity, sign-in, SQL/IDB conformance and IDB storage. Typecheck and lint passed. The new IDB case aborts a real fake-IndexedDB transaction; the SQL case throws before COMMIT, then reopens the real temporary store. Existing quiesce and provider network tests remain unchanged. Code review pending; full release/performance gates remain open for the series.
