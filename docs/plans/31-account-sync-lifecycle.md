# Plan 31: account sync lifecycle

Status: implemented; parent handler integration and independent review pending; X06 / S16 / S28 of plan 26. Outlook remains deferred.

## Request (verbatim)

> Implement report X06/S16/S28 account-removal/trailing-sync lifecycle fence main /Users/Luis/projects/emailclient. Userrequires eachreportitem spec/investigate/failingtests/fix/atomiccommits/separateCodexreview/fixfindings. Outlookdeferred.

The complete implementation brief is the parent task's account lifecycle assignment. Its constraints are binding: no real profiles/secrets, preserve concurrent edits, no identity/auth/UI/store changes, parent owns the accounts.remove integration, and core changes wait for parent readiness. Final independent Codex review is assigned by the parent.

## Investigation

Plans 20 and 25 establish connectivity retries, push coalescing and credential-generation refusal handling. Plan 26 and baseline X06 identify an additional account-lifetime race. `dropAccount` untracks and stops watching, then waits for the current sync before closing its provider. The sync finalizer can start `syncAgain` before drop resumes. That pass re-tracks the account and retains a globally signalled sink. Provider context cursor/secret callbacks are also not account-lifetime scoped. Existing network removal tests concern jittered scheduling, not callbacks from a pass already running. Existing identity stamp and sign-in flow fences (c81c7f2) must remain intact.

## Specification and design

An account generation owns an AbortController and a bounded set of durable commands already started. Invalidate it synchronously before untracking or awaiting anything. Stop watches, clear trailing sync intent, remove cached provider ownership and close/reset reads before waiting. Late completion must neither ingest nor write bodies/flags/locations/cursors/secrets/auth state, re-track, restart watchers, schedule retries or invalidate a fresh reconnect generation. Account removal waits for already-started durable commands before row deletion; active store failures propagate normally. It does not wait for an uncooperative network pass after invalidation.

Keep a closed lifetime only while removal/reconnect is underway. The removal handler calls a cleanup method immediately after successful `store.accounts.remove`; a failed deletion retains the fence. Reconnect explicitly creates a fresh generation after verified credentials are stored. Old callbacks compare lifetime object identity, including finalizers. Missing-account lookups do not leave permanent tombstones. Per-account maps remain proportional to connected accounts and actual in-flight work.

Fence provider construction before and after asynchronous account/config reads. Fence provider context reads/writes, and all mutable location-store methods. Cancel safe reads using provider reset/close and the account sink signal; preserve the provider's send ambiguity/acceptance contract. Never make an accepted or ambiguous send eligible again (definitive pre-acceptance refusal keeps existing safe retries), or bind the read abort signal indiscriminately to fetch used for sends. Operations awaiting provider creation must recheck lifetime before dispatch; old auth refusals cannot affect a new account generation. Unrelated accounts remain active.

Implementation should reuse sliced ingestion rather than bypass filters/model updates. Add a cancellable guard at each slice and immediately before durable mutation. Recheck after asynchronous classifier/encryption preparation; durable command ownership covers asynchronous staging/persistence after the store call is admitted, so deletion cannot race that command. Read and mutation checks must never swallow valid active-store errors.

## Tests

New `packages/backend/src/account-lifecycle.test.ts` uses synthetic temporary profiles, public Backend/RPC and scripted ProviderRegistry contexts with explicit gates. First reproduce X06: block a sync, send push, remove account, release old sync, and assert no trailing provider call or retrack. Assert removal cancels/closes before waiting; late sink/cursor/secret/auth writes cannot repopulate data; sibling account still syncs. Gate provider construction, durable ingestion and credential encryption to prove those boundaries. Reconnect over a blocked old sync must create a new generation whose cursor/auth state survives late old completion. Verify store-write failure is visible and accepted-send call counts never grow after removal/reconnect.

Use gates and bounded event-loop turns, not wall-clock sleeps as race oracles. Assert public store/RPC results and provider invocation counts; private maps alone are not proof. Run targeted backend/network/sign-in/provider suites, backend typecheck and lint. Parent runs full release gates (unit, WASM, e2e, web, UI perf, desktop packaging/smoke and hot-path performance).

## Performance and scope

O(1) lifetime checks per durable command/slice; no mailbox scan, extra network request, polling, permanent removed-ID set or timer. SQL/IndexedDB work uses existing commands, preserving 50k mailbox complexity and sliced processing. No UI/string changes. Outlook, auth identity redesign, account-store schema and operation reconciliation remain out of scope.

## Revisions after the Codex review

Read-only Codex critique completed (12 concrete points; full transcript in the parent scratch directory). Accepted refinements: distinguish dispatch from acceptance/ambiguity and preserve late durable send outcome recording; give removal an explicit mode that aborts sign-in and prevents reconnect reopening while deletion is pending; never await unbounded provider construction/close; identity-check old sync finalizers/watch callbacks; gate account/config construction reads and evict rejected factories; track complete durable command promises including attachment staging, encryption and IDB persistence; wrap every mutable location method including resetMailbox; propagate admitted store failures to their caller and removal; inspect provider internal retry/late-secret lookup and the browser signedIn handoff; test failed/repeated removal cleanup. Provider-internal terminal cancellation may need a separately owned follow-up if core fences cannot prevent network establishment; report that limit rather than editing mail-provider files without coordination. Parent owns any identity/handler integration changes.

## Evidence and review

Five clean failing tests reproduced before core edits with `pnpm exec vitest run --project unit packages/backend/src/account-lifecycle.test.ts`: close count 0 while blocked; stale ingest invoked after removal; reconnect could not finish before old network; delayed provider construction blocked removal; deletion raced an admitted ingestion and caused a foreign-key failure. The initial harness used a nonexistent accounts.list RPC; corrected to app.bootstrap.accounts. Backend typecheck then passed. Red transcript: `/tmp/terno-provider-hardening.x0emTS/account-lifecycle-red.txt`. Implemented lifetime identity/abort ownership, per-command durable draining, all provider-store/location and sink/context fences, old watch/finalizer guards, read reset/close before waiting, and fresh generation after explicit reconnect. The existing active-provider signedIn token-renewal contract remains intact; the browser explicit-reconnect handler must drop first (parent integration). Removal has an explicit `{ remove: true }` mode that cancels sign-in and prevents reopening until durable deletion. `accountRemoved(id)` releases the fence and credential counter only after successful deletion.

Expanded baseline qualification: eight red lifecycle cases plus one already-correct accepted-send case; SQL and IndexedDB share the real RPC/scripted-provider harness. A newly discovered closed-account worker loop was separately reproduced in both adapters: releasing an undispatched op let the next claim reclaim it repeatedly. Closed-lifetime operations now park through the existing awaitingAuth/resumeAuth state and incur no timer/poll. Late accepted sends retain durable outcome recording and never become retries.

Current targeted validation: 84 passing tests across account-lifecycle (24), backend operations, network and re-sign-in suites. The dedicated browser-store test has its own DOM-enabled `tsconfig.lifecycle.json`; the existing Node config excludes that one test, and package typecheck runs both. Dev dependencies are exactly @terno/idb workspace:* and fake-indexeddb 6.2.6, with six importer lines added to the lock. Backend typecheck and owned-file lint were rerun; their final result is recorded with the implementation commit. A transient shared attachment.retry interface error was reported to its owner and not patched here.

Parent integration required (no handler/identity changes in this slice): accounts.remove calls `await b.dropAccount(id, { remove: true })`, then calls `b.accountRemoved(id)` immediately after successful `await store.accounts.remove(id)`. Browser existing-account connectGmailToken calls `await b.dropAccount(existing.id)` immediately before tokens.set. Desktop identity already drops before saving its verified credential and retains the c81c7f2 stamp/supersession fences.

No UI changes or screenshots apply. No new timers, scans or mailbox queries are introduced; lifetime checks and pending-command accounting are O(1). Parent owns full release/performance gates and a distinct Codex review of exact commits. Neither is claimed complete by this implementation handoff.
