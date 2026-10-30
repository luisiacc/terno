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

## Scoped validation commands and results

All launches use synthetic temporary databases/providers and append the existing native guard. The first command below ran once unchanged (`original.log`,1 selected passed); pnpm initially materialized the worktree's dependencies and ran its existing ensure-electron postinstall. No app production build was invoked. Existing test globalSetup compilation is unchanged.

```sh
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project unit packages/backend/src/network.int.test.ts -t 'an archive made'
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm --config.verify-deps-before-run=false exec vitest run --project unit packages/backend/src/network.int.test.ts -t 'an archive made'
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm --config.verify-deps-before-run=false exec vitest run --project unit packages/backend/src/network.int.test.ts
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm --config.verify-deps-before-run=false exec vitest run --project unit packages/backend/src/imap.int.test.ts -t 'does not replay after losing'
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm --config.verify-deps-before-run=false exec vitest run --project unit packages/backend/src/network.int.test.ts -t 'an archive made' --silent=false
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm --config.verify-deps-before-run=false exec tsc -p /tmp/terno-release2-network/types.json
pnpm --config.verify-deps-before-run=false exec oxlint --deny-warnings packages/backend/src/network.int.test.ts
git diff --check
```

The second command is the exact command used for all intermediate authoring/RED observations named above, on their respective source versions. Final whole-file `network-green.log`:19/19 passed. Direct IMAP `imap-ambiguity.log`:5 selected passed/146 deselected; no test skip annotation added. `archive-timeline.log`:2 passed/17 deselected, rerun solely with passing-console output enabled to retain the actual successful protocol evidence (the previous default reporter hid passing traces), not a repeat-until-green attempt. `types.log`, `lint.log` and whitespace:exit0. The temporary type config extends backend tsconfig with explicit network.int.test.ts and css-tree-subpaths.d.ts includes, absolute workspace typeRoots, DOM lib, empty exclude; imports bring in direct production dependencies without the prohibited baseline or broad backend test inclusion.

Captured timeline: refused connection(s) reject before UID mutation; parked attempt0; real settled provider reset completes while still refused; proxy reopens; one running claim at attempt1 sends exact UID MOVE from INBOX to Archive; server emits matching COPYUID. Successful case forwards tagged ACK and publishes succeeded/attempt1. Loss case snapshots empty source and exactly one destination UID/raw byte sequence before suppressing tagged MOVE ACK; a real networkChanged event runs the settled reset; execute rejects ambiguous and publishes unknown/attempt1. A later completed reset, explicit sync and fresh SMTP send prove recovery without replay or spending another archive attempt. The same account/provider object remains live throughout; unknown identity remains unresolved and no destination locator is invented.

No production hot path changed, so no perf file applies. No UI/e2e/build/dist/smoke/full gate, real profile/secret, shared production file, user-owned plan, main/worklist, push/landing or other worktree edits. No process signals were needed; scoped runners exited normally. These checks qualify the repaired fixture and actual ACK-loss safety, not release-green or the exact historical milestone scheduling.

## Sole code-review disposition

Exactly one completed native read-only CODE review, gpt-6.1-sol/high, exit0, reviewed c9b935f8..c2db43c8 with Standards+Spec axes (`/tmp/terno-release2-network/code-review.log`). Standards0 findings/pass; Spec0 findings/pass. Reviewer explicitly confirmed delegated real-provider instrumentation, bounded polling, retained pre-mutation success, actual withheld-ACK unknown, stable attempts and no replay, exact remote contents, unresolved identity fence and the fresh worker recovery witness. No fixes required and no lower-severity review backlog. No second review or provider/model fallback. Plan critique is separate from this sole code-review round. Only this evidence record changed after review; reviewed test code is unchanged.

Finite handoff: test-only recovery-fixture correction plus real ACK-loss qualification; original historical scheduling still unattributed. No demonstrated production bug and no production retry/unknown behavior change. Root owns serial integration/rechecks and all release/worklist disposition.
