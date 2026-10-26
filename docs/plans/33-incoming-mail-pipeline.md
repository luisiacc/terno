# Plan 33: bounded incoming mail processing and durable repair

Status: critique complete; phased implementation pending. Scope: W03/W10/W11, X03 and the incoming resource portions of T02/T06. Outlook remains user-deferred. Plan32 owns credentials; plan29's outgoing fixes and resource semantics remain intact.

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

## Investigation and existing behavior

The12-point read-only investigation `/tmp/terno-mail-pipeline-design.md` examined the actual installed PostalMime4.1.3, provider/core/store seams and desktop/web packaging. Its recommendations and proposed tests are design evidence, not executed validation. Gmail currently calls unbounded `Response.json()`/`text()`, decodes large base64 strings on the backend loop, and retains up to50 parsed messages before ingest. Six downloads can therefore retain six large envelopes plus decoded data;50 supported18MiB attachment results alone can retain900MiB. The existing raw-validation perf test starts with an already allocated string and fails before decode/parse/store. It is a narrow regression, not a whole-pipeline gate.

Awaited `SyncSink.ingest` is the durable acknowledgement boundary: core lifetime fencing, asynchronous asset staging and SQL/IDB atomic persistence already occur there. Store Platform must remain independent of mail/parser concepts. Plans26/29/31 establish typed Gmail resource404s, exact decimal checkpoints, complete base64 padding validation, partial/unavailable capture and generation cancellation. Preserve them.

## Design and staged implementation

### A. Bounded HTTP consumption and byte-bounded producer flushing

Extract a portable bounded response reader. Count delivered decompressed bytes, regardless of absent or inaccurate Content-Length. Initial local endpoint budgets:64KiB profile/minimal/send/error,256KiB selected metadata,2MiB list/history, and `4*ceil(75MiB/3)+256KiB` raw JSON. These are local transport policies, not provider limits. Consume bounded chunks, split UTF-8 correctly, race ignored abort on fetch/read, cancel and release without awaiting a potentially stuck cancel. Never fall back to unbounded body helpers. Deadline cleanup includes body consumption; accepted-send unreadable/oversized success remains ambiguous with one POST. Preserve OAuth versus resource status provenance and RequestNotDispatchedError.

Replace fetchFull's retained result array with an awaited producer/consumer operation. Keep six ordinary small downloads and count50 batching; add a4MiB completed-small-result threshold. Large results flush individually through the durable sink. Record explicit per-ID outcomes so a missing result is never mistaken for a confirmed404. Stop dequeuing on systemic failure, settle admitted work, retain cursor until all required durable effects complete. A partial neighbor commit followed by failure is safe replay, not permission to advance a cursor.

### B. Backend-owned admission and actual host workers

Introduce one incoming runtime per backend instance, through a mail-owned contract injected in BackendCoreOptions/ProviderContext. It owns a bounded descriptor queue, six small reader prefixes (initial256KiB each), and one shared large-pipeline lease across accounts. Unknown-size readers stop pulling when promoted. The large lease spans remaining HTTP read, JSON validation, decode, MIME result and awaited durable staging. Waiting readers cannot incrementally reserve the entire pool or retain completed large bodies. Small completed work can flush while a large job owns capacity; no flusher waits on capacity that only its own acknowledgement can release. Account fairness and cancellation are event-driven, with no polling/timer while idle.

For promoted jobs, move collection flattening, large JSON.parse/TextDecoder, complete resource/base64 validation, aligned bounded decode and MIME mapping off the backend event loop. A worker around only PostalMime leaves major stalls untouched. Transfer owned ArrayBuffers, never pooled Buffer neighbors; return attachment buffers with deduplicated transfer lists. Discard stage references before subsequent stages when possible. Small parsing stays inline only after byte and structural preflight and measured qualification; many empty parts can be small but expensive.

Use a shared pure worker protocol with Node and browser entries. Web uses a literal nested Worker URL emitted/pre-cached by Vite. Desktop adds an explicit esbuild worker entry resolved beside the shipped backend bundle; no workspace/node_modules/runtime-TS dependence. Test copied packaged app execution, not a parser imported in the smoke test process. One lazy worker, Node unref, explicit backend shutdown, no idle timeout. Worker unavailable/crash is a visible resource failure with bounded later-demand recovery, never a silent large inline fallback.

Queued cancellation removes only its descriptor. Active noncooperative parsing can terminate only the worker owned by that job, invalidates incarnation IDs and settles leases once. Removing A must not terminate B's active work. Already-admitted durable writes finish before account deletion; stale parser replies cannot reenter storage. No tokens, URLs, config, network or DB capability enter the parser worker.

### C. MIME limits and large text persistence

Set explicit installed parser limits for total parts, charged headers, MIME depth, nested RFC822 and forwarded addresses. Qualify compatibility for many attachments/containers; the100 captured-file policy is not a MIME part-count limit. Known resource/parser limits produce genuine unavailable/repair state, not a fabricated complete empty body. Preserve exact binary/zero/CID, Reply-To, alternatives, nested mail, charsets and dates. Visible-text normalization X04 is separately specified work; isolation does not fix it automatically.

The whole-path guarantee includes large text SQL binds/FTS/rule preparation and IDB structured clones. Before release, compare real SQL/WASM/IDB timings for increasing combined text/HTML sizes and unbroken-token bodies. Choose and document a measured captured-text resource ceiling, or implement chunked body persistence/resumable exact index/filter preparation with an atomic revision boundary. Do not claim75MiB arbitrary text support from a75MiB raw parser input policy. If a local text ceiling is necessary, preserve genuine bounded envelope and prior complete body/assets, expose explicit partial resource state and retry, do not silently truncate or evaluate body filters on incomplete content. New reason/copy must distinguish size/resource limits, malformed content and worker availability, with matching en/es and reader/search semantics. The text writer decision and measured gate are prerequisites for closing W11.

### D. Durable work, poison repair and bounded page state

Until durable per-message repair ownership exists, malformed items leave the cursor behind. To advance past one, atomically retain account/provider ID, observed version, phase, stable reason and pending/blocked state before checkpoint promotion. Deduplicate and index rows. At capacity stop new promotion/enumeration; never evict unresolved obligations. Deterministic poison parks after bounded attempts, reopened by explicit retry or genuinely newer observation, with no polling/redownload every pass. Catch only known parse/resource faults; never quarantine arbitrary programmer/store errors. Storage failures retain old complete body/assets and pending work.

On raw transport-policy overflow, cancel and fetch separately bounded selected metadata. Validate complete metadata ID, thread, labels, dates/sizes and consumed headers; never regex a truncated JSON prefix into authority. If metadata also fails, retain provider-ID repair ownership rather than inventing full mail. Only an actual message-resource404 authorizes removal. History404 still triggers reconciliation; token/profile/shape/worker errors do not authorize deletion.

Persist enumeration phase, original baseline/floor, opaque continuation and per-ID obligations through common store commands. Bound reconciliation with keyset pages and durable epoch/work instead of full-mailbox sets. History page entry counts do not bound IDs inside one entry. Preserve final-state ordering across overlapping pages so old fetches cannot resurrect later deletions; use observed revision/tombstone fences. Page acknowledgement follows durable ownership; final checkpoint follows all required work or retained repair. Crash replay remains idempotent and atomic filter/action claims do not duplicate automation. Full-window expansion and summary-only history cases retain explicit acceptance tests.

## Tests, performance and release requirements

Every behavior starts with an observed failure. Use real ReadableStream JSON through public provider/backend/sink/store and synthetic temp data, not only helpers. Required matrices:

- Missing/lying length, split encoding/escapes, over-cap single chunks, endless/stalled/ignored abort, malformed status bodies, canceled401, accepted-send response failure, bounded genuine metadata fallback.
- Six unknown large responses: one progresses beyond prefix, others stop; small neighbors progress; no deadlock; credits remain until gated durable sink ACK; count/byte/end flush; sink failure and cancellation settle ownership exactly once.
- Valid large attachment-heavy36/70MiB raw, dense tiny parts, nesting/aggregate header limits, exact binary/empty/CID, alternatives/charsets/RFC822, large plain/HTML/unbroken-token body. Real emitted Node/browser workers, transfer detachment, no hidden neighboring bytes.
- Crash after staging/ingest/page ownership and before/after cursor; poison/restart/explicit retry; malformed later history page; overlap/deletion ordering; exact beyond-Number history IDs; blocked repair survives healthy sync; no duplicate filters/actions/operations.
- Gate removal/reconnect at response, admission, worker, classifier, staging and persistence. No stale cursor/state/body writes, sibling cancellation, leaked leases or accepted-send resubmission.

Start event-loop watch before first body bytes and stop after final durable sink. Keep existing15ms raw-validation and slicer constraints; foreground RPC/load budgets remain unchanged. Measure deterministic live-owner high-water plus Node process RSS/isolate/external memory and browser transfer/RPC latency. Worker resourceLimits exclude ArrayBuffers; one worker is not a small-memory proof. Buffered worker JSON can temporarily hold chunks, flattened bytes, JSON text and extracted raw simultaneously, so no unsupported256MiB process claim. Establish an explicit peak budget from the chosen implementation and repeated-run retention measurements before closing W11.

Before changing batching, measure a repeated isolated50k-small-message six-way baseline on Node SQL and browser OPFS/IDB, then retain numeric throughput, transaction count/size and foreground p95 guards. No per-small-message transaction or forced worker serialization regression. Idle50k complete mail has indexed repair/pending lookups and no parser worker/timer/network. Production cold startup creates no parser worker; nested worker works offline; copied desktop package launches its bundled worker and shuts down cleanly.

Each coherent phase is committed atomically on main under the shared lock and receives a distinct Codex code review; fix every finding with regression tests. Final typecheck/lint/test/e2e/web/ui-perf/perf and desktop dist/smoke gates are required, serialized after integration. Full series coverage remains active; this plan does not close Retry-After scheduling, SMTP recipient/Sent repair, arbitrary IMAP folders, aliases or other separately recorded work.

## Primary references

[Gmail Message](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages), [messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [Workspace receiving limits](https://knowledge.workspace.google.com/admin/gmail/gmail-receiving-limits-in-google-workspace), [Vite workers](https://vite.dev/guide/features.html#web-workers), [Node24 workers](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html). Installed PostalMime4.1.3 source is the parser contract used in the investigation. The local resource/admission/repair design is an engineering choice, not a provider guarantee.

## Revisions after the Codex review

The read-only critique completed successfully with11concrete points (`/tmp/terno-provider-hardening.x0emTS/incoming-plan-review.txt`). All are accepted; no implementation or passing gate is claimed by the critique.

1. Separate bounded producer enqueue admission from durable acknowledgement. One serialized flusher owns staged batches, flushes on count/bytes/end and makes capacity available without all six producers waiting for an unfillable50-result batch. Checkpointing waits a separate durable completion barrier. This also prevents concurrent pre-transaction attachment staging of the same message revision.
2. Account for complete backing buffers and outstanding reads, not subarray lengths. A delivered chunk can exceed the prefix threshold. Explicit overshoot policy must either refuse a chunk exceeding the qualified per-read backing-buffer allowance before retaining it or admit/transfer its full allocation under separate bounded ownership. Test six simultaneous chunks between the prefix and total-response cap; do not claim a six-prefix bound while retaining six whole backing buffers.
3. Preserve typed endpoint/status overflow through API classification. Use response field projection and smaller pages for over-budget collections; an indivisible oversized history entry transitions to bounded authoritative reconciliation with the original checkpoint floor retained. Never retry the same oversized successful page forever or convert it into empty success. Raw metadata fallback applies to message resources only.
4. Include IMAP source materialization in the same backend-wide admission and parser routing, acquired before BODY fetch and retained through setBody acknowledgement. Preserve folder/UIDVALIDITY identity. Until this is implemented and qualified, W11 remains unresolved for IMAP even if Gmail passes.
5. Body-dependent rules are ineligible while body capture is incomplete. Both stores must defer claims, including negated body predicates and mixed conditions, until complete eligible content arrives. Test initial partial insert, repair, restart and exactly-once application; null body is not proof of a negative body condition.
6. Unavailable setBody replacement must preserve previous complete text/HTML and index data, matching preserving upsert semantics. Add a state-only unavailable transition or guard the body setter; preserve assets too. Test both stores and restart rather than relying only on ingestion fallback.
7. Repair and legacy pending-capture eligibility transition atomically under one authoritative owner. Blocked poison cannot remain in the first50 automatic capture rows and starve a healthy51st message. Explicit retry and removal update both repair and capture ownership; qualify across restart.
8. Replay ingestion must preserve unsettled local flag intentions inside its atomic command, as updateFlags already does. Test crash after ingestion/filter action before cursor, then replay while archive/read/star work remains unsettled. A later slice also retains version fencing after accepted operation settlement; an unsettled-only guard does not close X01 by itself.
9. Bind durable enumeration to the requested window and generation. Compare persisted coverage floor, invalidate incompatible continuation when the window expands, schedule bounded backfill and retain outstanding repair. A valid old history cursor alone cannot certify newly requested older coverage.
10. Worker failures use a plain structured protocol with allowlisted stable codes and explicit RFC822 depth-fallback semantics. structuredClone(Error) drops custom code, so never depend on transporting the Error object. Unexpected faults remain bugs; raw parser messages never enter user errors or diagnostics.
11. Emit/inject the real Node worker for direct-source tests and backend-dev as well as desktop packaging. Reusable build setup must precede source-host worker use, and tests must exercise that emitted entry. Portable exports remain free of Node imports; copied packaged execution remains separately required.

## PhaseA.1: control/error transport boundaries

The first implementation intentionally bounds small control/error responses before changing collection or raw processing. Profile, send acknowledgement and userinfo use a64KiB delivered-byte ceiling with strict incremental UTF-8, bounded decode buffering and cooperative work for extremely fragmented streams. HTTP error bodies use the same cap; their untrusted text is used only for structured quota reason classification and never placed in returned errors. Request status and typed resource-error provenance remain intact. New fixed request failure/offline copy ships in en/es.

Fetch headers and body consumption honor the existing cleaned-up request deadline even when fetch/source cancellation is ignored. A late response is canceled. Native reader cancellation settles pending reads without awaiting the source cancellation promise; locks/listeners are released. A stuck401 cleanup cannot block the single fresh-token attempt. Unreadable/over-budget accepted-send responses remain ambiguous/nonretryable after exactly one submission.

Six new public-provider cases failed before implementation: actual/lying response length, ignored body abort, blocked401 cancellation, oversized successful send answer and private error detail. Added controls cover split UTF-8/JSON escapes, ignored header abort with late response cleanup, and malformed UTF-8 remaining an unusable response rather than an offline account. Five related suites pass145tests; mail typecheck and owned lint pass. Tests use actual ReadableStream/Response boundaries and request/effect counters.

Two focused15ms gates cover a60KiB control resource delivered in one-byte and whole-body chunks, including provider consumption and JSON validation. Initial runs included the fake server's first native Response constructor, which independently takes about24ms in a cold Node process. Response/chunk fixture construction now occurs before monitoring, consistent with the other synthetic wire fixtures; the monitor still begins before body pulling/consumption. The corrected isolated gate passes both cases without budget changes. Fragmented-body processing uses one abort listener, a reusable16KiB decode buffer and bounded yields; no idle timers exist.

Collection/history/raw/People body admission and large JSON parsing remain pending phasesA.2/B. Their existing JSON path is raced against cancellation but is not yet byte-bounded or off-thread. Applying a2MiB collection cap before typed overflow recovery would introduce a new permanent retry loop, so that cap is withheld until its recovery path is implemented. This phase does not close W11, raw MIME memory, durable repair, text writers, IMAP or full release gates. A fresh independent code review follows this coherent control/error fix.
