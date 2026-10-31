# W02 A19: reconnect query identity and local intent

Actual prepared base: `e1db269578dffaf0afe3947f2752506bdf960956` (matches requested e1db2695).

## Request (verbatim scope)

> W02 A19: 'Browser reconnect must invalidate fresh caches and retire only settled optimistic overrides.' Current rationale: versioned optimisticintent/localqueryinvalidation exist; qualify overlapping reconnect/accepted-unconfirmed observations without clearing newer edits.

The implementation assignment also requires real public RPC/cache coverage, old fetch/ACK exclusion, unchanged query parameters, bounded lifetimes, no mutation replay, no fabricated authoritative revisions, no backend/core/store writes, no broad gates/builds and at most two native Sol/high code-review rounds. Root alone edits the worklist and lands the branch.

## Existing architecture and evidence

Read AGENTS.md, the report A19, baseline and worklist A19, Plan04 storage/Web RPC, Plan38 local flag intent and Plan43 transport identity sections. The report's foreign-client optimistic manager is not Terno architecture. RpcClient increments connectionVersion on attach/close, unregisters transport listeners and rejects pending calls. Web detail cache has 150 entries but no connection identity. List uses query/fetch sequences and a bounded 5,000-entry edit guard, not retained read/star/move value overlays. Boot subscribes to changes/counts but not reattach. Durable Plan38 ownership is authoritative backend/store work, excluded here.

## Design

Qualify the actual RpcClient with memory transport (cloned microtask delivery, no native/browser lifecycle claim). Reconnect invalidates every cached detail while retaining the selected object until replacement to avoid reader remount. Old-connection resolved answers and errors must not publish. A dedicated recovery adapter subscribes after initial boot; on attach it invalidates details and outstanding list queries, reloads visible query/detail even for identical parameters, and reloads counts through the existing public read method. Gate old results by the actual connectionVersion. Do not clear edit marks or replay mutations. No synthetic backend versions or renderer settlement framework.

## Tests

Dedicated public-RPC tests hold real requests/replies, warm unchanged-key caches, replace transports and release old snapshots/ACKs out of order. Exact IDs, flags, counts, connection identity and request parameters are asserted. Negative oracles must distinguish original code. Run dedicated and direct-caller tests with inherited NODE_OPTIONS plus /tmp/terno-network-guard.cjs, no globalSetup/build. Web types and strict owned lint only. No UI markup/copy change; no editor/list performance work.

## Perf and bounds

No polling, timers, history or mutation retry. Recovery runs only on attachment. Existing cache/mark bounds remain. Version comparisons are constant work at asynchronous publication boundaries. No performance optimization or new hot loop; no global/perf gates authorized.

## Out of scope and disposition boundary

No backend/provider/store/contract edits, process-crash/lost-wire proof, browser worker lifecycle, editor, categories, release gates or other worklist rows. Public DTOs do not expose per-field durable intent settlement; equal flags and a local RPC success do not certify provider observation. A19 cannot be called fully protected merely from renderer recovery tests. Record the finite proven boundary and exact remaining authoritative dependency for Root.

## Revisions after the Codex review

Sole native Sol/high plan critique completed exit0, 11 points; transcript `/tmp/terno-w02-a19/plan.log`, PID71596 naturally reaped. Accepted: counts event/read ordering needs a publication guard; protect resolved as well as pending RPC continuations, all list sequences/cursors/counts and detail gone/pending state; dispose recovery listeners; preserve covered-list/reader policies and existing bounds. Recovery uses counts.get (not bootstrap), retains selected object only within the same logical store and leaves bootstrap-before-readiness and explicit RpcClient.close outside this series. The installed ready-state recovery does not qualify browser worker reattachment. No remount/focus claim is derived from state-only tests. Action ACK callers and durable accepted-but-unconfirmed settlement are separate evidence obligations, not established by raw RPC exclusion or retained edit marks. Plan38 has landed authority protection; absent Web evidence is a qualification dependency, not evidence of a missing backend version API. No new authoritative version is required or invented.

## Executed implementation evidence (before code review)

Original public-adapter tests: three ordinary failures (warm cache returned without RPC; received old detail published after attach; received old list published after attach), one existing-protection pass (pending mutation rejected/no replay), `/tmp/terno-w02-a19/red.log`. Public action test after fixture cleanup: one failure for a detached pending action starting a new-connection list read; received ACK control passed (`action-red-clean.log`). The earlier action run leaked a cleanup snack between cases; its second failure is not product evidence. New guards retire only old-transport action continuations; they neither resend the command nor claim remote rollback.

Added ready-state recovery at boot's existing counts registration. It refreshes list/detail/counts, resets both list sequences/cursors/loadingMore, clears negative and offscreen detail entries while retaining the selected object as stale, and gates received results/errors by real connectionVersion. A same-connection counts event advances a local publication revision so an older recovery read cannot replace it. No durable intent state is touched.

Nine real BackendCore/public-RPC/native SQL and IDB exact/instant cases combine read/star/archive acceptance, old matching observation, newer inverse intent, held old transport detail response and replacement query recovery. The existing store protocol retains a pending snapshot after matching old observation; replacement reads show exact inverse flags, both thread IDs, counts2, exact queued message targets, unchanged operation identities and a higher real observation epoch with the same protocolId. Completing the inverse still needs a later authoritative full flag observation to retire the obligation. Acceptance is deliberately simulated via the existing store operation-completion command with autoSync disabled; no provider-wire acceptance is claimed. An archive fixture initially omitted trash/spam fields owned by moveToInbox, correctly leaving an obligation; adding all authoritative location fields fixed the fixture, not product code (`intent.log`).

Before final resource-bound test, seven exact test files passed74/74 (`green5.log`). Pagination fixture cleanup was corrected after old loadingMore state prevented the next case from dispatching; this is not a product RED (`green4.log`). Web main+worker types and strict eight-file lint passed. No worker globalSetup/build, browser/app build, provider traffic, global suite, perf or release gate ran. pnpm's first invocation populated the prepared worktree's absent node_modules from its local store and ran the existing Electron ensure postinstall; no dependencies/lockfile changed and no package/application build ran.

## Finite proposed disposition and limits

Recommend A19 **covered by this reviewed change** only for initialized same-store public renderer RPC reattachment plus the existing Plan38 durable authority contract, subject to code review below. Terno has no renderer value-overlay manager to retire: durable settlement stays with the authoritative store. Evidence now combines real backend/stores with the Web cache adapter; there is no demonstrated need for backend/API expansion. The browser host currently attaches its worker on startup, while automatic replacement is a desktop host path; this series qualifies the shared adapter, not automatic browser worker restart. Explicit RpcClient.close (which does not increment the core version), bootstrap-before-ready replacement, different-store reused numeric identities, process crash/lost wire ACK and arbitrary remote consistency remain outside that finite boundary. Root must decide the worklist disposition; other rows/counts remain untouched. No full A19 environment matrix or release-green claim.

## Native code review R1 and fail-first corrections

R1 native Sol/high read-only review completed exit0, PID27139 naturally reaped (`review-r1.log`, process identity JSON alongside). Actual verdict: Standards FAIL (one P2), Spec FAIL (two P2). No other finding. All three are accepted and corrected before R2:

1. Received valid success had discarded the exact usable Undo token across a same-backend reattach. A nonquiet public action now retains its own acknowledged token before suppressing old-connection cache/notification effects, without replacing a newer global Undo. The regression captures the old Undo, registers a newer one, then proves the old one dispatches exactly its own token via public RPC. It failed before correction.
2. Scoped actions delegated before the normal action fence. Pending and received public scope cases both reproduced an extra new-connection list call. Scope now retains received Undo in its own deferred owner, suppresses stale completion/error/cache/reload effects, and always disposes its progress listener and exact progress snack. These two regressions failed before correction. All three REDs are retained in `r1-red.log` (two existing controls passed). An initial incomplete text edit still left catch/finally unguarded; the two scope failures remained (`r1-incomplete-correction.log`) until that edit was completed; no fixture relaxation or retry without correction.
3. Original integration detail could match retained initial state. It now explicitly awaits a forced adapter read started AFTER the stale observation, requires the published cache object to be that returned replacement, and independently reads public RPC after the observation. The exact same assertion rejects the retained original object and deliberately corrupted starred data in all nine SQL/IDB cases. These discriminating oracle controls correct the evidence gap; there was no new product RED for this test defect.

Final post-correction checks:78/78 across the same seven files, one worker and no file parallelism; Web main+worker types; strict eight-file lint; whitespace all pass. Captured native processes59755/59780/59798 were reaped after the incomplete correction; final60211/60227/60273 naturally exited0 and were reaped. NODE_OPTIONS inherited the network guard on every check. Exact commands/process records and latest final logs remain in `/tmp/terno-w02-a19/`. The earlier frozen pre-review pass was75/75. No prohibited broad gate/build/provider request occurred. R2 is the final review; after it only high correctness/data-loss corrections may be applied, with lesser new findings recorded as backlog and no R3.
