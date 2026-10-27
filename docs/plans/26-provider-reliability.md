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

## Slice 2: T06 — concurrent message deletion is not expired history

### Investigation and specification

Gmail list/history enumeration is not a frozen snapshot. A message can be listed or named as newly added, then be deleted before its raw download. `fetchFull` currently propagates that message GET 404. Initial sync fails; incremental sync's broad 404 catch mistakes it for expired history and starts a full mailbox scan. Known cached minimal-message 404 handling is already scoped correctly and must remain so.

Only a 404 returned by history enumeration authorizes history-expiry recovery. A confirmed 404 downloading a newly discovered message omits that vanished item, continues good neighbors and preserves progress. Any transient, authentication or permission failure still aborts the checkpoint. Do not infer message deletion from missing raw data, invalid response shape or omitted batch entries; response-validation/poison-record work remains a separate open slice.

Use the existing fake Google HTTP server through real backend sync, injecting a one-shot deletion after enumeration and before raw GET. Cover initial and incremental passes, successful neighbor ingestion, no extra full listing/profile request on a message 404, and a real expired-history 404 still triggering full reconciliation. Keep existing cached-old-mail and transient-failure cursor tests. No new cache, loop, timer or full-mailbox lookup; skip a definitively missing fetch within the existing six-worker budget. Other T06 backfill/reset-crash work remains open.

### Slice 1 — Codex code review round 1 and corrections

Reviewed head `6331fbd` using the repository review script, through the requested Codex subagent. Two medium findings were reproduced before changing the code: a failed state write for a definitive network/auth/permanent refusal produced `unknown`, and fallback recording of an uncertain send emitted no op event. Four focused tests failed on that reviewed commit.

The worker now retries recording the captured provider outcome, preserving its original authentication/network/definitive-failure semantics. It never repeats submission to repair persistence. After successful fallback recording it emits the operation event, so the existing uncertainty warning is discoverable. Dispatched ownership still lasts through this bounded retry. Both-write failure remains a noneligible running row recovered at restart rather than an automatic send. The three backend/connectivity/sign-in files pass all 60 tests; typecheck/lint pass. The broad perf run was interrupted deliberately when review required changing the implementation, and is not claimed as passed; it will be rerun on the stable series.

### Slice 2 — plan critique revisions

Six points accepted: classify expiry only at each history request; catch only the individual raw GET 404; retain actual full/delta watermarks; give the deletion fixture stable list pages; assert raw 403/503 never advances the cursor; and verify genuine expiry reconciles cached labels/deletions before installing a replacement watermark. The raw catch must continue its worker, not exit and lose later queued IDs.

### Slice 1 — code review round 2

Codex reviewed `6331fbd..a7c784a` with the original fix context using the repository script. No substantiated findings; both prior corrections hold. Its read-only test attempt was blocked by temporary config-file writes; the parent-run green test results above remain the executed evidence. T01 implementation/review is complete; final required release/performance gates remain open for the series.

### Slice 2 — reproduction and initial validation

Two new regressions failed before the change: initial sync ended in error on a vanished raw message; incremental sync made seven unnecessary profile/list calls. The raw-download catch now skips only its own confirmed 404, and an internal marker scopes expiry to history requests. Forty-one Gmail integration/network tests pass, including raw 403/503 checkpoint retention and history expiry on a continuation page. New fixtures use an unstarted synthetic mailbox to avoid an OAuth connection's trailing sync changing the watermark under assertion; full listings are pinned during deletion so the fake's offset paging does not skip unrelated messages. Existing provider auth, send uncertainty and real history-expiry behavior remain covered. Typecheck/lint passed before the final continuation fixture; code review pending.

## Slice 3: T04 — structured Gmail quota errors and token throttling

### Investigation and specification

Gmail REST currently treats only 429/5xx as retryable, so documented 403 `userRateLimitExceeded` and `rateLimitExceeded` become permanent failures. Desktop token refresh also treats HTTP 429 as permanent. Permission, administrator-policy and disabled-service errors must remain action-required; do not make every 403 retryable or delete credentials on a quota error. A rejected quota send has a definitive response and is not ambiguous; send 5xx/network uncertainty retains existing handling.

At the provider boundary, classify the structured reason array for those two quota reasons, accepting only actual reason fields rather than substring matches over free text. Preserve HTTP status provenance. Token refresh retries 429 along with existing 5xx while invalid_grant retains sign-in recovery. Parse only on the error path; no extra requests/timers/dependency or retry loop. The following W05 slice must carry Retry-After to durable account/operation scheduling and prevent local cooldowns from extending themselves; this classification slice alone does not close T04/A09/A10.

Tests exercise real provider verify/send and desktop refresh over a synthetic fetch boundary: both quota reasons, unrelated permission/policy/daily-limit reasons, malformed bodies, a definitive quota-rejected send, HTTP 429 token failure, and preservation of existing ambiguous-send/auth tests. Add a real-backend fake-Google case showing a quota response leaves the operation retryable rather than terminal. No UI copy changes in this slice; richer action-specific recovery copy belongs to the auth/capability workgroup.

### Slice 2 — Codex code review

Reviewed `a7c784a..88f9094` with the required script in a Codex subagent: no substantiated findings. The review's test attempt was blocked by read-only temporary-file creation; parent executed the 41 passing tests. T06's disappearing-message slice and S10 are implemented/reviewed; window expansion, interruption recovery and other W03 scenarios remain open.

### Slice 3 — critique, reproduction and validation

Five critique points accepted: exact reason fields/status precedence; malformed-shape handling; status-driven token 429 including contradictory invalid_grant; definitive quota send rejection versus 5xx/unreadable-success ambiguity; and no hidden retry/invalidation machinery. Ten provider-boundary regressions failed before implementation. Both documented quota reasons now preserve retryability, permission/policy/daily-limit/disabled-service controls remain permanent, and token HTTP 429 keeps its status even with malformed/null/contradictory bodies. A genuine HTTP 400 invalid_grant still requests sign-in. Sixty-seven provider/integration tests plus typecheck/lint pass. Code review pending. Durable Retry-After/account admission remains open.

## Slice 4: T05 — Gmail restore is a bounded label transition

### Investigation and specification

Current moveToInbox calls untrash once per message, swallows every failure, then submits all captured IDs in one batchModify without its 1,000-ID bound. A failed untrash can therefore be reported as success while TRASH still hides the message; large restores exceed the documented limit.

The provider's [label contract](https://developers.google.com/workspace/gmail/api/guides/labels) permits manual INBOX/SPAM/TRASH changes, and [batchModify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchModify) supports add/remove label IDs with at most 1,000 message IDs. Implement restore as add INBOX + remove SPAM/TRASH through the existing chunked label path, preserving unrelated flags/custom labels. This is idempotent for already-restored messages and partial-chunk replay. No swallowed untrash request or per-message probe is needed; N+ceil(N/1000) requests become ceil(N/1000). Keep captured IDs fixed, including when another message arrives.

BatchModify has an empty success body. Accept either HTTP 200 with no body or HTTP 204 for this explicit void response, while retaining JSON/ambiguity validation for sends and resource reads. A failed chunk propagates the actual provider error and never settles the operation as success; subsequent chunks wait for a later replay. Replaying this set-to-state transition does not create messages or copy mail. Future delivered-intent observation fencing (X01/W02) remains open.

Tests use a synthetic HTTP mail server state model through createGmailApiProvider.execute: mixed Trash/Spam/Archive restoration, preserving unrelated labels, already-inbox no-op semantics, 1,001 captured IDs, a later uncaptured arrival, chunk2 failure/replay, empty 200 and 204 responses, and permanent/transient refusal. The oracle is final remote label membership plus bounded network count. Fake-server/backend integration additionally restores a trashed message then syncs to verify list membership. No live mail or new background work; no UI/string changes.

### Slice 3 — Codex finding and error-provenance correction

Codex reviewed `88f9094..c11d93f` and found one medium issue: newly exposed OAuth status 404 could be mistaken for a missing Gmail message (or expired history) after a resource 401. Four regressions reproduced the issue in cached full sync, cached delta, new raw fetch and history enumeration. A dedicated Gmail-resource error type now carries resource statuses; only that type's 404 can delete/skip a message or trigger history expiry. OAuth errors retain their public status without acquiring resource-deletion authority. Seventy-one Gmail/network tests and typecheck/lint pass. A second code review is pending.

### Slice 4 — critique and red cases

Six critique points accepted: use the shared label path, compare exact captured provider IDs, test a remotely applied chunk whose response is lost, propagate all refusal outcomes, select void success only for batchModify (never send), and retain sequential bounded bodies/requests with the existing O(N) provider-ID list. Five initial restore regressions fail: TRASH remains after swallowed untrash failure, empty 200 is rejected, and 1,001 IDs exceed the request bound. Additional late-arrival/lost-response tests are added before implementation.

## User scope update: defer Outlook

The user instructed: “for the outlook related things, just take note on them to do them later on after outlook integration is done”. All Graph/Microsoft-specific implementation is therefore deferred to [the future checklist](../research/outlook-reliability-checklist.md). Mixed provider-independent scenarios remain active for current Gmail/IMAP/SMTP and local storage. This supersedes the baseline audit's W07 capability implementation recommendation. Deferred is not implemented/verified.

### Slice 3 — code review round 2

Codex reviewed `c11d93f..b8e8a2d`: no substantiated findings. Its read-only test launch was blocked; parent-run 71 passing tests and type/lint are the executed evidence. T04 classification/provenance is implemented/reviewed, while durable provider Retry-After/admission remains open.

### Slice 4 — implementation and validation

Restore now uses the shared sequential ≤1,000-ID label transition, preserving unrelated labels and propagating all failed chunks. Explicit void response mode accepts batchModify's empty 200/204 success and releases its body; JSON endpoints still parse their response. The new send-204 regression failed before the change (untyped TypeError, risking normal retry), and now has the existing typed ambiguous-send outcome. A 2,001-message test applies chunk2 then loses its response, verifies chunk3 waits and exact-target replay converges without touching a late arrival. Backend restore→sync verifies real fake-server label/list state. Eighty-two targeted mail/Gmail integration tests, mail typecheck and lint pass. Full project typecheck remains part of series verification while the independent Reply-To model change is being completed. Code review pending.

### Slice 4 — Codex code review

Reviewed `185cb94..ee84ebf` with the required Codex subagent/script: no substantiated findings. Parent executed the 82 passing tests; reviewer read-only startup could not create Vitest's temporary file. Gmail restore/empty mutation acknowledgment handling is implemented/reviewed. T05's IMAP partial-move and capability-fallback cases remain active.

### T10 — Gmail integration of the independent Reply-To slice

The independent worker committed the shared MIME/store/migration support (`185cb94`) and composer behavior (`3f83a8a`). Parent's Gmail integration regression reproduced an empty Reply-To array from the public reader despite two raw header addresses. The Gmail raw-to-incoming mapping now carries parsed Reply-To; the focused fake-Google/backend/reader test passes. Worker plan 27 and its remaining UI verification plus a distinct whole-slice Codex review are still required before closing T10.

## Slice 5 — validate successful Gmail resource responses (X05/B47)

A successful HTTP envelope is not proof of a usable provider result. Current JSON casts allow `null` send results to throw an ordinary TypeError after remote acceptance (eligible for resend); `{}` silently succeeds without an ID. Missing raw data can ingest an empty message, a mismatched returned ID can ingest another message, and malformed list/history/minimal responses can erase flags or advance an invalid cursor.

Validate the fields consumed at each resource boundary without adding a schema dependency: profile/history checkpoints are nonempty decimal strings (kept as strings beyond Number precision); list/history records and opaque continuation tokens have the expected shapes; message reads match the requested ID, carry a thread ID and valid label arrays when supplied; raw reads require nonempty base64url source. Missing labelIds remains the legitimate empty-label state. Send success requires a nonempty message ID and, when present, a nonempty thread ID. Unusable successful send responses become typed ambiguous outcomes, never ordinary retryable errors. Unusable read responses are retryable and cannot promote a cursor or apply destructive updates from that response. Do not include response bodies/addresses in validation errors. Detect repeated continuation tokens with a per-enumeration set to stop an invalid page cycle; valid opaque tokens remain untouched.

Tests call the public provider sync/execute with a synthetic HTTP boundary and observable sink/cursor. Cover null/scalar/object send bodies, valid send, absent/invalid/mismatched raw message data, malformed minimal labels and IDs, malformed profile/list/history/checkpoints, absent optional arrays, large decimal cursor, repeated page tokens. Assert no local ingestion/flag deletion/cursor promotion for rejected data, and typed ambiguous send outcomes. JSON parse/deadline behavior stays covered by existing Gmail network tests. The checks add O(page size) bounded validation and token-set storage proportional to pages; the existing larger resumability/memory work remains W03/W11. Parent owns gmail-api and this new test; independent auth/Reply-To workers remain untouched.

### Slice 5 — revisions after the Codex plan review

Accepted all nine critique points. Minimal reads require only the consumed ID/labels; raw ingestion alone requires thread/raw. Sparse history references remain ID-only and unknown extra fields are allowed. Validate supplied raw date/size metadata rather than ingesting NaN or a string size; omission keeps existing fallbacks. Add exact one-request/non-network send assertions, valid padded/unpadded base64 and headerless source, large raw data without an extra decode/re-encode/parse, monotonic exact-string history checkpoints, and late-page failure/replay preserving valid prior ingestion without cursor promotion. Stop dequeues after a worker failure and await the six existing workers settling, so retries cannot overlap leftover downloads. Complexity is O(raw bytes + page entries), not only O(page entries). Existing checkpoint strings are also checked before use; malformed saved cursors trigger full reconciliation rather than a request containing undefined. Summary-only history processing (B12) remains a separate tracked sync slice; it is not silently claimed by these validators.

Initial public-boundary run: 44 failing / 6 passing cases establish the missing validation and continuation-loop behavior. The first two vertical fixes turn all 10 send and 15 raw/minimal cases green. Existing net timer fixture is updated to a valid profile, retaining its timer oracle. OAuth integration fixture independently needs token_type Bearer following plan28's validation; omitted scope remains legitimate and is not fabricated.

### Slice 5 — implementation and verification

Resource-specific validators now refuse unusable successful envelopes before their effects/checkpoint. Send responses without a valid ID (or with malformed supplied thread ID) are explicitly ambiguous/nonretryable/non-network. Raw/minimal identity/labels, raw source/date/size, profile/history decimal checkpoints and list/history shapes are checked; sparse references and omitted optional fields remain valid. Persisted malformed cursors reconcile from a valid baseline. String comparison rejects checkpoint regression without converting to Number. Continuation sets stop cycles while preserving opaque tokens. A shared six-worker downloader stops taking work after the first failure and waits for in-flight work to settle; indexed iteration also removes repeated array.shift from large cached reconciliation.

The second red run reproduced invalid metadata persistence, decreasing/invalid saved checkpoints and continuing downloads. Test fixture corrections preserve PostalMime's existing headerless/final-newline behavior rather than changing MIME interpretation. Final 156 tests across response validation, Gmail network/operations and backend fake-Google integration pass; project typecheck and lint pass. Raw-body validation scans encoded bytes once and decodes/parses once, with a 1 MiB single-download regression. Full release/perf gates remain later series checks. Independent slice review pending.

Provider contract references: [Message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages), [message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [history list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list). Minimal reads intentionally use only consumed ID/labels; raw reads alone require thread/raw.

### Slice 5 — independent code review round 1

Dedicated Codex reviewer pinned `343e0d9`; required script exit0/DONE; parent and reviewer both ran 156 passing tests. Two medium findings: whole-raw validation scans exceed the 15ms slice target on 25–35MiB payloads, and history-expiry reconciliation can regress an otherwise well-formed checkpoint because it forgets its previous baseline. The independent Reply-To review also flagged the same raw scan (its Reply-To verdict was clear). Add a large-message responsiveness regression and bounded validation yields with constant-time padding inspection; carry the prior checkpoint into expired-history reconciliation and refuse regression before effects. Full series performance gates remain pending.

### Slice 5 — review corrections and red/green evidence

The history-expiry regressions failed for both cached and uncached mail: recovery resolved with a lower decimal checkpoint. Full reconciliation now accepts the previous history floor, validates profile baseline before any local effects, and retains the previous cursor until recovery succeeds. Retrying a failed recovery therefore cannot forget its floor. Both two-attempt tests pass without ingestion/flag removal/cursor writes.

Large raw validation now inspects padding in constant time and validates ≤256KiB chunks with an event-loop yield between chunks; small messages create no yield timer. Invalid final-byte fixtures exercise all encoded bytes without including preexisting decoding/MIME parsing in this new-work budget. The 25/35MiB six-worker performance regressions were run against the pre-review implementation in temporary source copies (removed afterward): stalls 267ms/820ms, both fail the 15ms target. Both cases pass with bounded validation. The public sync regression also proves a foreground event runs before large-message ingestion; all 159 focused Gmail tests pass. Mail typecheck/lint pass. Original full MIME decode/parse and aggregate retained-byte budgets remain the broader W10/W11 work and are not claimed by this validator-only gate.

### Independent slices — review outcomes

T10 Reply-To: separate Codex review pinned `8016c62` found no substantiated Reply-To findings; its nested broader script's raw-validation concern is handled by slice5 above. Worker e2e/web/SQLite-WASM/paired ingestion benchmark and visual evidence remain in plan27. Full release checks, earlier fake-IDB search timeout and incomplete full UI-perf run remain pending.

T08 initial Google sign-in: second separate review pinned `c81c7f2` found no substantiated findings; it independently reran 136 tests including encryption cancellation/supersession/removal. Required script exit0/DONE. Initial-flow validation is implemented/reviewed; refresh rotation/omitted replacement handling remains X02, separate from the completed initial-flow scope.

Performance follow-up: the initial two 25/35MiB cases passed after bounded validation. A later repeat failed (35MiB gap243ms); a diagnostic repeat with smaller256KiB chunks/pre-collected fixture failed on repeated off-CPU holds (25MiB gap128ms with1.94ms threadCPU, many similar1–3ms CPU gaps). The existing timing classifier intentionally does not excuse repeated holds, so the latest scoped gate is **unresolved**, not passed. Keep its15ms target and rerun when integrated tests can run in isolation; do not weaken the gate. Functional159tests pass. Global lint currently fails only concurrent attachment-worker no-control-regex warnings; prior parent-only lint passed, and parent-owned files are checked separately.

## Attachment integration of plan 29 — parent-owned dispatch/provider seams

Worker plan29 owns durable account-bound immutable assets, drafts/queued refs, SQL/IDB storage and MIME/UI handling. Parent integration resolves bytes only immediately before provider.execute for a send, keeping the persisted op as immutable asset references. Missing/incomplete/foreign/corrupt local data is a definitive pre-submission failure, never a smaller submitted message or ambiguous send; accepted-send safety from slice1 is retained. Hydration gets the platform's yielding function, and its time counts as in-flight/quiescing work. SyncSink.setBody's optional fourth attachment list is forwarded into the store's body hydration command.

Public tests queue an attachment-backed draft, restart before dispatch, compare provider bytes/identity with the queued immutable refs, and prove postqueue local-read failure makes no provider call and no automatic retry. Body hydration uses the captured provider sink, public thread reader and chunk RPC to verify downloaded bytes. No live profiles/providers. Gmail additionally needs bounded legacy asset-body capture via indexed pendingAttachmentBodies(50), including old inline-only mail; this requires the worker's durable captured-state schema and will be separately tested before its parent mapping change. Late lifecycle work is coordinated with plan31; its worker waits for these core integration hunks before editing core.ts.

### Attachment parent integration — revisions after Codex plan critique

All six points accepted. Hydration stays inside executeOp's protected preparation after dispatch ownership enters sendsInFlight; quiesce cannot release the op while local bytes are read. Add a post-hydration hold/provider-promise/credential-generation check before network submission, releasing an invalidated unsent op. JSON/preparation exceptions normalize to a fixed definitive local error without raw sensitive details. Extend tests for gated hydration/quiesce, generation invalidation, accepted-send completion-write failure with exact immutable refs, and omitted/empty/failing body attachment staging. Worker owns helper/large-byte sizing and responsiveness corrections. Parent's initial3send and1body-hydration regressions all failed before these core hunks.

### Attachment parent core integration — first validation

Foundation `75d7f2e` provides the helper/store contracts. Core now hydrates send refs inside the accepted-send protected path, after claiming dispatch ownership, and rechecks stop/offline/provider identity/credential generation before submission. Unclassified local JSON/hydration errors become a fixed definitive preparation failure; immutable op JSON is unchanged. Body hydration forwards optional attachments exactly. Four new integration tests (restart/no-restart bytes, local-read refusal, incoming body bytes through public reader/chunk RPC) pass. Two existing sign-in tests used incomplete fake send payloads; their helper now constructs canonical send fields so they still test actual authentication/parking. All56dispatch/backend/re-signin tests pass; parent-owned lint passes. Whole backend typecheck currently reports only concurrent attachment export test's missing chunks property. Remaining critique tests and whole attachment-series review remain required; plan31 worker receives core after this atomic integration commit.

### Slice 5 — independent second review

Pinned `c81c7f2..3182acb`: no substantiated findings; required script exit0/DONE. The raw validation and recovery-floor corrections hold. Latest loaded-machine scoped performance gate remains failed/unresolved, and all release gates remain pending; no completion claim replaces that evidence.

## Gmail legacy attachment-body recovery integration

Plan29 adds indexed durable pendingAttachmentBodies(limit), marking old raw captures incomplete (including legacy inline-only mail) and fresh zero-attachment raw captures complete. After ordinary full/history reconciliation, one ≤50-message batch is downloaded with existing six-worker fetchFull and ingested, preserving existing local IDs; confirmed message-resource404s remove those captured cached messages, while other failures retain their durable pending capture state. A failure may occur after an ordinary history checkpoint has advanced: pending capture state is the separate durable work owner, so retry cannot lose the byte-recovery obligation. No new timer/polling; larger catch-up scheduling/fair admission remains W03/W05/W11. Signal checks avoid effects after cancellation; plan31 adds generation fencing to sinks/contexts. Tests cover fresh raw bytes, legacy cached bytes, inline-only old mail, missing raw and transient refusal retention/restart, exact50 batch bounds and confirmed disappearance. Store rows outside the active sync window stay eligible. Parent owns Gmail provider integration/test; asset/storage/schema are worker-owned.

### Gmail legacy capture — red/green evidence

Six of seven new fake-server/public-reader cases failed before provider integration (legacy/inline cached bytes absent, raw refusal not attempted, confirmed deletion retained, no bounded capture progress); fresh raw bytes were already green from plan29. Provider sync now drains one indexed ≤50-row batch after ordinary history/full reconciliation, ingests exact parsed bytes, and removes only known captured messages absent due to confirmed resource404. Signal checks fence local effects after cancellation. Public tests verify exact binary base64, stable local IDs, old full bodies outside retention, inline-only legacy mail, refusal retry/pending ownership, one-time capture and51messages across two passes. All7 new cases pass. Broader Gmail/net/response/operation run:165pass,1 existing reconnect test fails because it assumes dropAccount must wait for blocked network; plan31 deliberately removes that wait. Parent will replace its timing dependency with an encryption gate while retaining the exact older-flow rejection/newer-credential oracle. Do not call the broad gate passed until corrected and rerun.

## Plan31 parent integration — deletion and browser credential admission

Worker `218d75c` hands back bounded per-account lifetimes with24both-store cases. Parent removes with deletion ownership (`dropAccount(...,{remove:true})`) and calls accountRemoved only after durable row deletion. Browser renewal explicitly drops the old provider before signing in. Additional public regressions exposed two pending-result gaps: removal after a targeted identity lookup could fall through to creating a new account, and token installation before signedIn's awaited mailbox check could reinstall a removed token. Both fail before the parent correction. Recheck targeted account identity after enumeration; move synchronous browser credential installation into signedIn's admitted lifetime write after its mailbox/current-generation checks, with cancellation/expiry checked at installation. Successful deletion forgets the real browser broker's in-memory token; a public-broker regression fails before cleanup and preserves a sibling token. Existing encryption supersession test is gated on encryption (not a blocked network wait), preserving the older-flow rejection and exact newer credential. No additional timer or persistent removed-account tombstone.

### Plan31 parent integration — validation

All109tests across Google connection,24SQL/IDBlifecycle, re-signin, network, Gmail and browser-token lifecycle pass. Both backend typecheck configs, mail typecheck and parent-owned lint pass. Three newly reproduced browser/broker failures are fixed, and the existing two-OAuth-flow oracle now uses encryption gating with the blocked network still independent. A real backend close/reopen test confirms failed Gmail attachment capture stays in the indexed pending work set and recovers exact bytes. Whole X06/lifecycle review is next; no full release gate is yet approved.

### Incoming resource handoff from plan29

Resource commit `a519bee` separates75MiB local incoming capture policy from25MiB outgoing MIME policy and returns bounded complete-header metadata with captureUnavailable:size above the incoming policy. This is a local resource policy, not a claim about Gmail's provider limit. Official receive/import distinctions are recorded in plan29. Parent's public-provider regression failed because Gmail still marked header-only output full and dropped the unavailable reason. Gmail now maps partial/unavailable state, leaves prior attachment replacement unspecified, and decodes only a bounded header prefix when encoded length proves full capture over policy. A valid neighbor still captures and the cursor advances with durable per-message unavailable state. The81response/dispatch/body tests pass against current integrated work; mail typecheck/owned lint pass. The expanded body test also proves optional omission preserves existing bytes, an explicit empty list clears them, and staging failure preserves both body and assets; its fifth-argument forwarding is owned by the concurrent lifecycle-correction core commit, so that test change waits for that dependency commit. Whole HTTP JSON-read/backpressure, full MIME parse responsiveness and batch retained-byte limits remain W03/W10/W11; the prefix change alone does not close them.

### S57 third review

Exacthead `32de1e9` clears epoch seed hours before assigning literal year, retains final midnight/calendar checks, and qualifies the Azores second-round correction alongside SãoPaulo. Independent third Codex review/script exit0/DONE: no new substantiated findings. Worker nine-zone unit62outer+597child andWASM21outer+156child tests pass, four-package type/lint pass. Latest full search/performance gates remain unapproved.

### Attachment dispatch qualification and malformed saved snapshots

The parent integration now has public cases for quiesce during gated local byte reads, removal during hydration, completion failure before/after durable commit, failed unknown-outcome recording, real reopen with immutable refs/no resend, and fixed privacy-safe local-read errors. Body hydration distinguishes omitted attachments, explicit empty replacement, size-unavailable metadata, and staging failure preserving prior body/assets. All10initial qualification cases passed.

Additional malformed persisted payload cases exposed unreadable outbox summaries (`null` payload) and the wrong size classification for malformed preparation. The send preparation boundary now checks consumed body/attachment shapes and uses a fixed definitive local error; outbox subject extraction accepts only an object/string subject. Three failing regressions become green; no provider call or retry follows malformed preparation. All65dispatch/backend/re-signin tests and both backend typecheck configs pass. These tests/fixes are part of the whole pending T02 code review, not a replacement for it.


## Recovery test workflow integration

The three React recovery suites use `.test.tsx`, while the default Vitest unit project includes only `.test.ts`. Their scoped R5/R6 passes therefore do not prove they participate in `pnpm test`. Before expanding the integrated run, verify actual unit discovery, then include both TS and TSX under the same package/app roots. Preserve existing test exclusions, each suite's jsdom annotation, global worker setup, assertions and timeouts. This is test workflow integration, not a product or performance change. A short source-only critique precedes the configuration fix; retain default-project discovery and direct three-suite execution evidence.

The source-only critique completed exit0/DONE with three accepted points: expand only the unit patterns, retain the existing JSX transform and alias, and use actual files-only discovery (which does not execute globalSetup). Before the fix all three expected suites were absent; afterward the default unit project discovers them. Direct execution through that default project passes17tests across the three files, with existing jsdom annotations and one-worker scheduling. Its normal globalSetup may rebuild the ignored standalone worker; no app build/browser/performance gate was run. The configuration and this integration note will accompany the next independent whole draft-recovery review.


## Integrated functional fixture corrections

The first serial full unit project finished with8551passes,11failures and3skips across270files. All failures remain in `integration-unit-serial.txt`. Source diagnosis identifies three fixture candidates, not approved product fixes: historical IDB fixtures derive their table names from today's TABLES and accidentally create v8 flag stores inside nominal v1/v2/v4/v6 databases; Reply-To import/send fixtures omit the fresh draft generation now required by queued-send identity admission; the facts shutdown fixture polls until four slices but can let the entire400-thread backfill finish before stopping, invalidating its expected pending state.

Correct each independently after a short source-only critique. Pin historical store-name manifests to actual introduction versions rather than weakening production migration guards; preserve all upgraded rows/defaults and old-ID fencing. Forward the exact restored draft generation without changing Reply-To/envelope assertions or permitting generation omission in production. Gate the fourth real facts slice, initiate stop while it is in flight, prove stop waits, then release and require pending durable progress plus exact restart completion. Keep original timeouts/assertions, real stores and cleanup. Each observed full-run failure is retained, focused qualification follows, and a fresh full run plus independent review remains required.

### Revisions after the integrated fixture critique

The source-only critique completed actual exit0/DONE with five accepted points. Historical manifests must exclude correspondents beforev4 as well as assets beforev6, counters beforev7 and flags beforev8; preserve production migration guards. Reply-To must forward the exact restored generation. Facts stop must be observed inside the actual backfill runner while its fourth real slice is gated, with unconditional release/cleanup and a durable cursor comparison across reopen. Strengthen the legacy fixtures' existing claims by checking persisted Reply-To absence and rejected edit content/erased-ID fencing after reopen; do not relax their behavioral assertions.

The four Reply-To integration failures now pass by forwarding `restored.generation` with its existing draft ID, matching the production sender's identity contract. Recipient names, selected Reply-To, Bcc privacy, backup/reopen and exact queued-envelope assertions are unchanged. No generation check was loosened in either adapter. This is the first independent fixture correction; six legacy-upgrade failures and the backfill timing failure remain pending below.

The facts shutdown fixture now gates the fourth real five-item slice and observes entry into `FactsBackfill.stop` before asserting its promise is pending. After release it records the exact committed public settings cursor, compares it across reopen, requires remaining work and exact final facts, and forbids later old slices. All4facts tests, backend types and lint pass. The first new cursor assertion incorrectly treated the decoded public settings value as JSON text; that failed capture is retained and the corrected typed getter/fallback passes. There is no backfill production change or timeout increase.

Historical IDB fixtures now use an explicit version-1 object-store name manifest, adding correspondents only fromv4 and attachment stores only fromv6. Nominal v1/v2/v4/v6 fixtures no longer contain v8 flag stores or a v7 counter; the production upgrade logic is unchanged. All13tests in the two formerly failing IDB files pass, including unchanged move/draft upgrade results and strengthened persisted Reply-To absence, rejected-content preservation and erased-ID fencing after reopen. Raw fixture handles have failure-safe cleanup. An initial added content assertion used RPC's camel-case field against the store's snake-case row; its retained failure was corrected to the actual public row shape. IDB typecheck, changed-file lint and diff checks pass. The full11-failure capture remains retained; a fresh broad run is still required.

### Fixture review correction: observe the runner stop result

Both fresh fixture reviews identify the same P2 test-oracle gap: the entry signal precedes promise settlement, so the outer backend-stop pending assertion does not prove that the runner waits. Capture settlement of the actual `FactsBackfill.stop()` promise inside the forwarding spy, keep the fourth real slice gated across a complete event-loop turn, and require the runner promise and outer shutdown to remain pending. Release the slice unconditionally and retain the committed cursor, reopen, remaining-work and exact final-results assertions. Qualify this oracle with an external test transform that removes only the production runner's await, without modifying tracked production files; the strengthened assertion must fail under that mutation and pass with the real implementation. A short source-only critique precedes this test-only correction, followed by focused checks, an atomic commit and a fresh distinct review.

The fresh serial unit rerun passed8,562tests with3skips across270files; the separate full SQLite-WASM leg passed1,728 with2skips across31files. The original11-failure unit capture remains retained. These functional results do not resolve the known performance failures or the whole-operation settlement finding.

The correction critique completed actual `CODEX_EXIT=0`/`DONE`: observe both fulfillment and rejection of the real runner promise, join all started work with unconditional release, and require the mutation to fail at the pending-runner assertion rather than a timeout or later closed-store error. The external transform removes exactly one await in `facts.ts`; the strengthened test fails at `runnerSettled` (true rather than false) while the fourth slice is held. The unchanged runner passes all4facts cases; backend typechecks, focused lint and diff checks pass. Both configs disable globalSetup, so these checks do not rebuild the ignored worker. An initial external-config import error is retained separately and is not behavioral evidence. Production backfill code is unchanged; fresh distinct fixture review remains required.

### Shared browser conformance assertion portability

The full normal web gate at `b231394` ended with42passes/2failures: both Chromium MailStore suites report `expect.soft() can only be used inside a test`. The shared durable-flag regressions added five Vitest soft-assertion call sites; the browser harness deliberately exports real expect but supplies its own test runner, without Vitest test context. Retain the actual OPFS/IDB failure logs and traces. Replace only those five calls with ordinary expect, preserving all matchers, expected values, awaited rejection checks, hooks and subsequent successful-path assertions. No adapter, runner, skip or timeout changes. The diagnostic tradeoff is fail-fast within a failing test, not a weaker pass condition.

The source-only critique completed actual exit0/DONE with no blocking findings: awaited rejects remains required, later checks still run on passing predecessors, and the existing afterEach closes registered stores after thrown assertions. Observe native/IDB/WASM controls, then rebuild and rerun real browser conformance; no browser green is implied until that run completes. The first full web capture also records a harness provenance limit: the extra CLI separator left Playwright using its normal output directory, copied into the unique artifact directory afterward; conformance asset hashes were captured after the run, while tracked source stayed unchanged throughout. Future runs use the literal normal test:web command and capture both output trees during execution.

Fresh fixture/workflow reviews of the earlier five-commit series at `b231394` now find Standards0/Spec0 within scope; both source-only Codex reviews completed actual exit0, and their exact archives were unchanged. The stop-oracle P2 is resolved for the exercised wait contract. No broader provider or performance approval follows.

After the five-call replacement, focused durable-flag conformance passes108native SQL/IDB cases and36SQLite-WASM cases; store typecheck, changed-file lint and diff checks pass. These configs have globalSetup disabled. The actual Chromium gate remains failed pending a fresh build/run; this atomic correction changes only shared assertions and this plan.
