# Plan 42: IndexedDB transaction termination before admission

Status: in progress. This is a prerequisite correctness correction discovered while designing small operation-state writes. No overlay, migration or whole-outcome journal is approved by this plan.

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


## Existing behavior and observed RED

Plan04 requires one atomic store method; plan26 requires failed writes not to publish partial durable work. `schema.persist` installs `done(tx)` then queues every touched row. A synchronous second `put` error exits before aborting or waiting for transaction termination. `IdbMailStore.command` immediately reverts memory and releases its fence, while the first real queued request can commit. In a public `threads.act(markRead)` probe, making the second real `put` clone an uncloneable value produces the actual DataCloneError; the command rejects, but `debug.verify` subsequently reports `messages: row 1 differs between IndexedDB and memory`. The external probe/log are retained under `/tmp/terno-provider-hardening.x0emTS/idb-enqueue-atomicity-probe*`. This injects a storage-boundary failure and does not claim ordinary authored messages contain functions.

The current `done` also rejects on nonterminal `error`, and the command fence is the raw persistence promise rather than memory reconciliation. A read or later command must not see reverted or tentative state before the actual transaction ends. No normally occurring oncomplete-then-promise-rejection is established; caller ACK loss after a successful command is distinct and must leave confirmed memory intact.

## Narrow private design

Keep schema versions, MailStore, provider APIs, row encodings and command ordering unchanged. Give persist its own terminal event handling attached before enqueue: request/transaction error records the first error but is not a terminal event; only complete or abort settles the persistence promise. Guard all request enqueueing. A synchronous enqueue exception requests abort immediately and awaits the terminal event even if abort throws. Definite abort rejects with the original enqueue/request error so command reverts after termination. Transaction creation failure has no transaction and is safe to revert. A complete event after an enqueue/request error is a partial commit: reject with a private committed-write marker, never report successful whole-command persistence or revert as though aborted. Do not invent a timer outcome.

The command publishes an independent inflight fence before awaiting persistence; release only after confirm, definite-abort revert, or fail-closed decision. On the committed-write marker, mark the adapter unusable and close its IDB connection before releasing the fence. All ordinary and early reads, queued/new exclusive units and isOpen must respect that state; the normal close path still joins its resources. Return the original error to the caller; reopening reloads actual durable state. Do not retry a provider action to repair a local outcome. No new public error/ACK token, recovery timer or network request.

## Test-first qualification

Public store regressions in both IDB modes must prove synchronous second-enqueue failure causes no partial durable flag action, memory/physical verification and reopen agree, and the rejected method waits for actual abort. Include initial transaction-creation refusal, first-enqueue refusal, ordinary successful writes and the existing aborted accepted-send completion. A real request error must not release the fence before abort; a deliberately prevented request error followed by native complete, or deliberately failed abort with native completion, must poison before pending reads/queued writes can proceed. Label that last defensive fault injection accurately; it is not evidence native abort normally fails. Preserve exact flags, operations, feed consistency and no-dispatch semantics. Normal lost caller response after a committed method cannot cause memory rollback. Every failed test must release owned gates/handles in finally.

Source-only Codex critique (at most six points) precedes production. Implement one coherent atomic correction with observed RED/GREEN, IDB/store types, targeted lint and relevant adjacency; get a fresh independent code review and fix its findings. Full browser contract and global/resource gates remain required.

## Resources and out of scope

One terminal promise and one command fence per existing command, no history scan, extra row serialization, polling or schema version. This does not establish speedup or whole-runtime boundedness. The unchanged full-row IDB writes, whole-operation flag settlement, deletion cascades, fair scheduling, durable wakeup journal, base startup getAll, shared independent writers and the retained incoming/UI/SQL performance failures remain open. Any overlay migration needs a separately critiqued design and explicit version reservation.

## Revisions after the Codex critique

The source-only critique completed actual `CODEX_EXIT=0`/`DONE` with six accepted refinements before production: preserve original request/enqueue error identity; independently test prevented request error and failed abort followed by real completion; recheck admission after later awaits (search, delayed loading and existing provider handles); guard early-open and metadata persistence with connection cleanup; keep poison separate from cleanup completion and join late loading without self-deadlock; move physical debug verification inside its exclusive snapshot. All introduced gates/handles need finally cleanup. No additional schema or public API is authorized.

The checked-in-source regression prepared before production now records all outcomes rather than stopping at verify: both IDB modes reject before any terminal event, memory retains two unread flags, but reopen shows the first message read and debug verification disagrees. The retained two-case RED is `idb-termination-red.txt`; the storage failure is the actual second put DataCloneError. The earlier external one-case probe is separate. All six critique requirements are accepted for this correction; focused results are not yet claimed.

## Focused implementation and qualification

The implementation records the first request error and waits for complete or abort, guarding enqueue for command and metadata writes. A partial completion poisons and closes the connection before the independent reconciliation fence releases; it returns the original error and leaves memory untouched. Startup closes its acquired handle on failure; normal close joins late loading and queued work even after poison. Search rechecks after loading, and physical verification reads under exclusivity.

The original two-case RED is `/tmp/terno-provider-hardening.x0emTS/idb-termination-red.txt`. Against 6ee115a, the added baseline regressions recorded eight failures for both defensive completion paths, physical verification interleaving, and the three failed-open boundaries in `idb-termination-refinements-red.txt`, and four failures for late admission and request error identity in `idb-termination-await-red.txt`. The later startup enqueue and close-join assertions were added after production implementation; their individual pre-fix RED was not captured. The request-error test uses an actual duplicate-key ConstraintError; failed abort and prevented request errors are defensive injections, not assertions about normal browser behavior. The delayed-load test gates request delivery, not browser disk latency. Caller ACK loss is simulated only after successful command completion.

Focused GREEN: `idb-termination-final.txt` (23 persistence cases and four adjacent cases, 27 total); `idb-termination-type.txt` and `idb-termination-lint.txt` pass. The first lint attempt used unavailable eslint; the repository uses oxlint and that scoped check passed. Independent code review and all broad, browser, performance, and resource gates remain open; frozen renderer results at the pre-fix commit do not qualify this patch. Whole-flag settlement and the previously identified performance blockers remain open.

## R1 correction investigation (in progress)

R1 identified four source candidates: the inherited post-`settled()` point-read gap; the inherited late-load close ordering gap; a missing restored-index test oracle for the new search guard; and potentially stale persisted instant cache after a defensively injected partial commit. Public probes precede production. The candidate correction for point reads rechecks `inflight` synchronously after every awaited settlement, looping before invoking the synchronous read callback; it must not queue nested reads behind their own exclusive unit. Close should await late loading before its final queue drain, so already registered load-dependent units enqueue before the drain; preserve pre-close admitted work, prevent new work from escaping shutdown, and avoid awaiting the queue from within an exclusive unit. A restored snapshot control must prove index restoration and fail if the post-load search check alone is removed. Investigate durable data, search revision and snapshot before proposing any recovery; incomplete prefixes can affect arbitrary logical tables, so invalidating just search cannot prove coherence. No durable marker, schema change, extra write or public interface is approved. Source-only critique of this refinement precedes production.

### R1 evidence and source critique

Fresh source-only correction critique finished `CODEX_EXIT=0`/`DONE` in `/tmp/terno-provider-hardening.x0emTS/idb-r1-correction-critique.txt`: synchronous post-await rechecks must cover other point-read consumers; shutdown needs a defined admission boundary; the restored-index control must prove the index path; partial durable reload is not logical recovery. The point-read correction keeps reads off the exclusive queue and applies the synchronous recheck to direct search/scope reads as well. The restored-index control confirms a saved snapshot, an index current while late loading is held, and a healthy instant result; removing only the original final search guard fails the control. Both public failure probes are inherited from the base, not newly introduced by plan42. The close ordering correction joins the demonstrated late-load waiter; defining and testing an admission boundary for all work racing shutdown remains open, including callers that have started but have not yet entered `exclusive`. This is not a claim that all shutdown races are fixed.

At d5b4631, point-read and close regressions failed in `idb-r1-point-red.txt` and `idb-r1-close-red.txt`; both pass with the correction. The restored-index check passes at d5b4631 and its single-guard mutant fails in `idb-r1-restored-mutant.txt`. The defensive partial-completion probe (`idb-r1-cache-probe.txt`) proves actual completed body persistence, unchanged search head, a restored index missing the term and scan finding it. This is an expected-failure regression until separately approved recovery is designed. It is not evidence ordinary native abort fails, and does not establish generic logical coherence after a partial prefix. Resolving that case may require durable admission/dirty state and atomic repair or refusal on reopen, with a protocol for every logical table; any marker, extra per-write operation, schema or public interface needs explicit parent approval. A search-cache-only fix is insufficient to prove consistency.

Focused no-global-setup results: `idb-r1-green.txt` 27 passed and one expected failure; `idb-r1-type.txt` and `idb-r1-lint.txt` pass. R2 independent review and all broad, browser, performance, whole-terminal and resource gates remain open.
