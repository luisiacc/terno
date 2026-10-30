# Release 2: archive recovery network boundary

## Request

Own the recurring network.int.test.ts archive-unreachable recovery case and directly causal IMAP/network files. Establish command/ACK/reset/claim/lifetime evidence; preserve W06 unknown/no-replay and durable identity fences. Do not force unknown to success or change production retry policy. Root owns integration/worklist; Plans64–68 are read-only; the prohibited baseline test must not be accessed. No nested agents.

## Existing behavior

The milestone log proves unknown instead of succeeded, but contains no protocol trace; previous 30 focused passes do not explain it. The fixture opens the proxy before posting a network event whose reset settles 100ms later. A successful sync can release parked work before that reset. IMAP marks a dispatched non-idempotent mutation ambiguous if the ACK or subsequent mapping validation is lost. Core correctly publishes unknown and never automatically claims it again.

## Design

Add optional test-proxy line observation/filtering, scoped to synthetic IMAP traffic, with per-connection buffers. Capture UID command/tag and server ACK witnesses plus backend reset/execute and operation attempts/state. Control the pre-mutation recovery by keeping the proxy refused until the actual provider reset executes; assert no UID mutation before that boundary. Preserve source/destination exact raw bytes, UIDs, epochs, identity and attempts. Add a real post-MOVE mutation/withheld-ACK reset control that must remain unknown across explicit sync/worker recovery, with one UID MOVE and no replay. First expose the overlapping reset under a controlled command/ACK interleaving using an ordinary assertion failure; attribute it as a fixture/oracle defect unless production evidence demands otherwise.

## Tests / perf

Only network.int.test.ts and direct proxy checks; original timeouts/workloads unchanged. Every test appends the native guard. Backend typecheck uses a temporary explicit include configuration for the touched test (no prohibited baseline inclusion), scoped strict lint and diff check. No production hot path change expected, hence no perf gate. One native read-only plan critique (<=12 points) and exactly one completed native gpt-6.1-sol/high Standards+Spec code review. No nested review agents or second round; only high correctness fixes after review.

## Exclusions

No production retry workaround, shared DB/IDB/store/core edits, UI, full gates, app builds, package/smoke, arbitrary waits, widened assertions, remote providers, real profiles/secrets, fetch/push/landing.

## Revisions after the Codex review

Native read-only gpt-6.1-sol/high plan critique completed exit0 (`/tmp/terno-release2-network/plan-review.log`, ten points). Accepted actual reset-completion gating, separate terminal contracts, exact mailbox/tag/session/UID/COPYUID evidence, source/destination bytes at suppression, attempt/claim distinctions, preserved unresolved identity and non-vacuous recovery. Reused ImapKit's existing parsed command/response script hooks instead of extending the shared byte proxy, so no parser/buffer/lifetime infrastructure was added. Spies delegate to the real provider and restore during teardown; account/provider lifetime stays identical.

The milestone's original overlap remains unproven: one unchanged isolated baseline passed. Controlled real MOVE + dropped tagged ACK + settled network-event reset reproduces unknown with exactly one mutation, but cannot identify the historical timing retrospectively. The pre-mutation success test now keeps the proxy refused until the real provider reset completes; it asserts zero UID mutations at that boundary. The post-mutation case is an additional safety control with an explicitly different contract, not a weakened recovery expectation. No production change is justified by this evidence.

A proposed extra mapping-validation control suppressed only the tagged STATUS completion, after the untagged UIDVALIDITY data had already arrived. It observed succeeded, not unknown (`native-script-green.log`, 1 failed/2 passed). That does not establish absence of mapping evidence or a product bug; removed this unqualified extra case rather than broadening production semantics. Lost validation with genuinely absent evidence remains outside this bounded qualification; existing direct IMAP ambiguity tests remain intact.

## Evidence so far

All evidence is under `/tmp/terno-release2-network`. `original.log`: unchanged archive1/1 passed, no repeated unchanged attempt. `controlled-red.log`: fixture-authoring failure, two failures because parked network attempts were incorrectly expected1; actual0, consistent with outage refund. `ack-red.log`: initial byte-proxy experiment1 failed/1 passed, real ACK loss produced unknown vs succeeded. The byte-proxy experiment was removed in favor of existing ImapKit scripting. `controlled-green.log`: initial fixture incorrectly required a resolved Archive locator for an unknown op; existing durable fence correctly retained it unresolved. `native-script-green.log`: the extra tagged-STATUS experiment described above. Final-seam `script-oracle-red.log`:1 failed/1 passed, exactly unknown vs succeeded after server mutation/withheld ACK/settled network reset. This is an oracle counterexample, not a claimed production RED or a reproduction of the historical uninstrumented schedule.

The final two-case contract preserves successful pre-mutation recovery and requires unknown/no replay after real ACK loss. It checks parked attempts0, each actual archive claim running/attempt1, terminal attempt1, stable attempts/execution/mutation counts through recovery, successful explicit sync plus a fresh SMTP operation through the recovered worker. Exact source/destination raw bytes, UIDs, epochs, COPYUID, original local/provider identity, and unresolved locator fencing are asserted. Original8s parking/5s completion windows remain unchanged; no sleeps, retries, skips or budgets added.
