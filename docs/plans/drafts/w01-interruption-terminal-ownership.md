# W01 S27 interruption terminal ownership

Base: `bef6418ecb8c5c97777eb516b793c9bbce7a9dd3`. Worklist/main owned by Root.

## Request (verbatim)

> Own W01 remaining row S27: sleep/VPN/captive-portal/reconnect interrupt work; cancellation closes only relevant reads and uncertain submission never automatically resends. Plan31 lifecycle, Plan65 receipts and Plan62 physical ownership govern behavior.
>
> First qualify current protection with meaningful regression or fail-first oracle control. Implement a genuine net-policy/body-ownership defect only if within scope; if shared core/store expansion is needed, park clear regression/dependency for serial Root scheduling, no workaround. Row disposition may be already protected if supported finite invariants hold; list exact OS-native/process-crash limits separately, don't leave S27 open solely for every environment permutation or call untested paths protected.

## Existing behavior and design

Plan31 and account-lifecycle tests cover dispatch admission before MIME completion, non-aborted dispatched Gmail sends and retired-generation late results. Plan62's network policy retains physical slots after abort/cancel; only independently observed EOF or error without abort proves termination. Retired successful native responses drain without buffering. Plan65 and send-submission tests preserve accepted/unknown no-replay across reopen. S27 needs finite qualification of these boundaries together, not a new provider architecture.

Add a dedicated backend integration file using public Backend/RPC and real managed Google/native Request dispatch, synthetic fetch intercepted before Backend construction, temp SQL and fake-IDB. Explicit gates hold late response body EOF after account replacement; sibling account/read continues. Exercise request/body errors representing interrupted transport/proxy HTML, dispatched send uncertainty and reopen, asserting attempts, exact MIME/attachment bytes and zero duplicate POST. Reuse existing targeted loopback SMTP and lifecycle controls for acceptance/ACK-loss/no-replay and pre-dispatch gating rather than claiming new coverage there. Tests use signal/lifetime events, not actual OS sleep.

First run new qualification on unchanged production. Negative controls deliberately corrupt response/content or terminal expectations and must fail the real assertions; no product RED is claimed for an existing-protection test. If a genuine owned defect appears, prove RED before fixing. Shared core/store dependencies remain parked with exact failing regression.

## Tests and performance

Only new module and direct callers: account-lifecycle, net-policy, network, send-admission-cancellation and selected send-submission protocol cases. Backend package typecheck and strict lint of new TS only. Append inherited NODE_OPTIONS with `/tmp/terno-network-guard.cjs` for every test. Supervised processes record captured PID/birth/argv and join; release gates and join pending workers before closing stores. No production/hot-path changes planned, hence no perf run.

## Out of scope

Actual OS sleep/VPN/captive portal/TLS installations; native process crash between remote acceptance and first local durable proof; worker/WebLock and desktop host handoff (W05/W11); IMAP implementation (W06); UI/snackbar/editor/release gates; Plans64–68 edits. No main/worklist/store/core changes, builds, full suites, traffic or real profiles.

## Revisions after the Codex review

One native `codex exec -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high` critique completed (nine points), transcript `/tmp/terno-w01-s27/plan-review.log`. Accepted: assert capacity before and after gated EOF; distinguish cancel/abort from independent terminal; hold sibling concurrently; use real portable MIME with a successful control and binary negative control; join fixture drain/pending workers; distinguish automatic replay from explicit unproven-unknown resolution. New SQL tests cover late acceptance, transport rejection, body error and status200 portal HTML across replacement/reopen. Existing lifecycle tests qualify both SQL and IDB dispatch boundaries. Host-event/reset composition is qualified by existing network and Gmail network tests; the new managed fixture itself exercises explicit account reconnect, not OS wake or a combined host-event/native-body scenario. This limit must remain visible.


## Qualification ledger (before code review)

No production defect reproduced; production files are unchanged. Initial fixture run:5 failures because `openExternal` was omitted, not a product RED. Corrected fixture:5/5 pass. Strengthened matrix:7/7 pass before adding cancel/abort controls. Negative controls reject altered subject and attachment bytes through the same parsed-wire oracle; premature EOF challenges the held-slot oracle and an aborted sibling challenges the signal oracle. No false RED→GREEN product claim.

New native managed fixtures are SQL only; existing lifecycle dispatch protections run in both adapters. New read cases enter actual `ctx.google.request`/`fetchGoogle`/native Request dispatch after synthetic proof, without real mailbox enumeration. All unrecognized routes throw and are counted; there is no fallback transport. A detached retired body is gated at native pull, joined through a fixture terminal signal, and observed through physical pending reaching zero. Cancel/aborted EOF retains one bounded slot for the session, by existing Plan62 contract; it is not called physical termination. No new timers, loops or polling are added to production.

Proposed S27 disposition: **already protected in Terno**, limited to the supported finite contracts: pre-dispatch lifetime gate; dispatched sends not aborted by reconnect/reset; logical retired-generation refusal with physical drain/capacity accounting; sibling-account independence; exact portable MIME/attachment preservation; no automatic uncertain-send replay after reopen; existing real loopback SMTP acceptance/ACK-loss controls. Root must reconcile the worklist in a separate commit. No claim that all34 rows are done.

Limits: real OS sleep, actual VPN/routing/proxy/TLS/captive portal installations, a combined host-event plus managed-native-body fixture, new Gmail IDB reopen cases, cross-worker/WebLock/desktop physical handoff, remote exactly-once and process-crash acceptance→first local durability are not newly qualified. Portal HTML is a synthetic status200 HTTP response after dispatch, not a real captive portal. Existing supported public reset paths are composed from separate direct-caller tests; broader W05/W11 ownership remains separate. Unknown with no durable acceptance proof still permits existing deliberate manual resolution; only automatic replay is prohibited.

Targeted results:118/118 across the new file (9), account-lifecycle, net-policy, network, send-admission-cancellation and mail gmail-net;9/9 selected real SMTP/rejected-RCPT cases (86 unselected by `-t`, no test skips added). Backend `pnpm --filter @terno/backend typecheck` passes both configs; `pnpm exec oxlint --deny-warnings packages/backend/src/interruption-terminal-ownership.int.test.ts` and `git diff --check` pass. No production/hot-path edit, perf run, full gate or build. Logs and captured process identities are `/tmp/terno-w01-s27/{targeted,smtp,types-final}.*`.

Exact validation commands (each test invocation inherited and appended `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs"`):

```sh
pnpm exec vitest run --project unit packages/backend/src/interruption-terminal-ownership.int.test.ts packages/backend/src/account-lifecycle.test.ts packages/backend/src/net-policy.test.ts packages/backend/src/network.test.ts packages/backend/src/send-admission-cancellation.int.test.ts packages/mail/src/gmail-net.test.ts
pnpm exec vitest run --project unit packages/backend/src/send-submission-store.int.test.ts -t 'real SMTP|deliberately recovers only rejected RCPT'
pnpm --filter @terno/backend typecheck
pnpm exec oxlint --deny-warnings packages/backend/src/interruption-terminal-ownership.int.test.ts
git diff --check
```

`/tmp/terno-w01-s27/supervise.py` captured PID, `ps` birth/argv identity and joined each launched command under a600s supervisor. No timeout fired or process signal was sent. pnpm materialized the prepared worktree dependencies on first invocation; no dependency/lockfile changes resulted. No real profile or secret was read. The held SMTP/Google fixtures use only synthetic data and loopback or in-memory native-fetch interception.

## Native code review R1 corrections

Actual read-only Sol/high Standards+Spec R1 completed exit0 (`/tmp/terno-w01-s27/code-review-r1.log`): two P2 findings, both fixed. Teardown previously unconditionally joined a pull never started when a pre-reconnect assertion failed, and a close failure prevented remaining cleanup. Extracted the actual cleanup paths; two fail-first harness regressions reproduce zero native pulls and an unclosed remaining owner. RED:2 failures,9 filtered; GREEN after correction:11/11. This is a fixture RED, not a product defect. Fulfilled unread responses are consumed, only started native drains are joined, all registered cleanup executes, and collected errors still fail teardown.

Cancel/abort cases now dispatch and gate the sibling request before the event; they assert the actual sibling Request signal remains live while both requests are pending, then release and consume its exact body. The negative signal control now aborts that captured Request's own controller after its normal completion and verifies the same signal oracle rejects it. Reconnect already had an independently gated concurrent sibling. No production changes follow R1.
