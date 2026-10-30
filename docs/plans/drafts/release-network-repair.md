# Release milestone 1: network integration repair

## Request

Fix the first release milestone’s coherent network integration failures: five network integration failures and ten icon fetcher failures. Preserve durable IMAP identity/dispatch fences, proven provenance, shared sessions, reset/no-logout/no-stale-network behavior and all icon privacy/size/connection assertions. Keep the native network guard active; no external endpoints. Scope is the two owned tests, direct fixture helpers, and transport source only for a demonstrated regression. No full gates, main/worklist edits or unrelated ownership expansion.

## Existing behavior and design

Base dadc7f46 includes storage repair. Plans 20, 22 and 45 define network recovery, icon policy and safe IMAP moves. The connection-only provider stub lacks locations.dispatch. Icon HTTPS fixtures supply synthetic domain DNS to loopback, but the native guard rejects the pre-DNS hostname. The archive recovery ambiguity requires inspection of the actual remote UID mapping/provenance before choosing a fixture or source repair.

Repair mocks at their current API seams. Session probes must use valid, fresh remote locators and a real temporary store rather than waive dispatch admission. Route only synthetic icon HTTPS hosts through localhost at the test request seam, preserving Host, TLS servername/certificate validation and the production guarded lookup; refuse any unexpected host. Do not change production security policy or disable the native guard. Diagnose archive evidence before editing production.

## Tests and performance

First reproduce all 15 ordinary failures with NODE_OPTIONS appending --require=/tmp/terno-network-guard.cjs. Preserve all existing assertions. Add exact locator/remote outcome assertions where needed. Run only the two files and directly affected callers, backend/mail types and scoped lint. No hot path expansion, app build, smoke, e2e, full tests or perf gate. One native read-only plan critique (at most 12 points), then exactly one completed native read-only Standards+Spec code review. Fix findings fail-first; subsequent work limited to high severity correctness/data loss, with lower backlog recorded.

## Out of scope

Shared core/types/store implementations, renderer drafts, Plans64–68, worklist and main. Report a concrete hot-file dependency before expansion.

## Revisions after the Codex review

Native plan critique completed exit 0 (eight points; /tmp/terno-release-network-repair/plan-critique.txt). Accept: seed session probes via real sync/store admission, assert exact remote Seen flag, assert archive local identity/destination locator and remote source removal; keep seeded connections out of measured proxy counts; route via localhost (not an IP literal) to retain guarded DNS; exact host/ephemeral-port allowlist; preserve Host/SNI/CA; assert lookup execution on strict-address refusal. Baseline reproduced 14 failures; archive passed five isolated runs, so no production ambiguity fix is yet justified.

## Diagnosis and implementation

Tests only; no production transport or shared hot-file dependency was demonstrated. The four session failures were API drift: the old `locations.of → []` mock omitted dispatch and represented an identity the current fence correctly refuses. The helper now syncs a synthetic remote message into a temporary backend/store over the direct fixture port, closes that seed provider, and probes the measured cold proxy using the real SqlProviderStore. It validates the captured UID/UIDVALIDITY and remote Seen flag. Watch-only probes use a temporary synthetic account without connecting during setup. Connection-count, latency, reset, no stale-network, IDLE and SMTP assertions remain unchanged.

The ten icon failures were fixture/guard interception mismatch before DNS. The test-local HTTPS request mock accepts only the exact example-domain fixture hosts and ephemeral server port, routes the socket host through localhost while invoking the original production guarded lookup with the original domain, and retains Host, SNI, CA verification and streaming request destruction. Lookup witnesses prevent strict-address refusal from passing vacuously. All existing policy, size, redirect, header, spoofing, timeout and unreachable assertions remain.

Archive limitation: the original unknown-after-recovery failure did **not** reproduce on dadc7f46: it passed the original combined run, 30 focused attempts, and the later combined runs. No artificial network interruption, weakened expectation, timeout increase or production ambiguity bypass was introduced. Added qualification checks assert the synced source locator/epoch is real, exact source UID disappears, the original local identity remains, and its destination UID/epoch equals the server’s Archive state. This is stronger passing coverage, not a demonstrated archive fix; the milestone’s intermittent unknown outcome remains unexplained. The supplied milestone log retains the original ordinary failure.

## What the code review changed

Exactly one native Codex read-only Standards+Spec code review completed exit 0 (`/tmp/terno-release-network-repair/code-review.txt`). Standards: no findings. Spec: one P2, proxy-port fixture registrations survived teardown. Added an ordinary regression (`review-red.log`, exit 1, expected false/received true) proving a closed proxy could still seed from the former fixture. Bind registration retirement to proxy.close before closing the listener; the regression then passes with the full owned files. No second reviewer/recheck. No remaining code-review findings or lower-severity review backlog.

## Commands, evidence and limits

All test launches appended the native guard:

```sh
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project unit packages/backend/src/network.int.test.ts packages/backend/src/icons/fetcher.test.ts
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm exec vitest run --project unit packages/backend/src/network.int.test.ts -t 'closing a fixture'
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs" pnpm --filter @terno/backend typecheck
pnpm exec oxlint --deny-warnings packages/backend/src/network.int.test.ts packages/backend/src/icons/fetcher.test.ts
git diff --check
```

Evidence directory: `/tmp/terno-release-network-repair`. Original combined RED `red.log`: 14 failed/14 passed (four dispatch failures, ten icon failures). First combined GREEN `green.log`: 28/28. Final post-review GREEN `final-green.log`: 29/29, including the new lifetime regression. Backend main+lifecycle types `types-final.log`, scoped lint `lint-final.log`, and whitespace pass. Focused archive commands used the first command with only network.int.test.ts and `-t 'an archive made'`; `archive-1.log` through `archive-30.log` all passed. Filtered-run “skipped” counts are unselected existing tests; no skip annotations were added.

Authoring evidence retained honestly: `archive-red.log` records an unsupported Vitest --repeat option (not a RED); shell iteration replaced it. `network-green.log` was interrupted through its owned exec session after account validation hit the intentionally refusing watcher endpoint; `network-green-2.log` exposed missing fixture SMTP validation. Both were fixture-authoring failures, corrected by creating watch-only accounts locally and a real loopback SMTP server for seeded accounts. Neither is claimed as production RED.

No full gates, UI, app build, smoke, e2e or perf suite; no mail production change, so no mail typecheck needed. No main/worklist/Plans64–68 edits, real secrets/profiles, external network permissions, pushes, landings or other worktrees. No release-green claim.
