# Packaged notification and People smoke fixtures

## Request and scope

Repair the two remaining milestone `09-smoke.log` failures: notification account admission and shutdown, and People v13 startup. Preserve the exact notification count, person/list distinction, click and Dock assertions, populated legacy data, real migration/backfill and People filtering. Only the two owned smoke files and directly needed local helpers may change. Plans 17/41 supply the product contracts; plans 64–68 and held R2 policy remain read-only. No new binary/build, backend/store edits, release clearance, pushes or landing.

## Existing evidence

Current checkout starts at dbf9c38a. Reused milestone package is source HEAD 2ac773241e, ad-hoc signed arm64 dev.terno.mail, no TeamIdentifier. Electron executable SHA256 96f44af7abf5ab7beca5e7a61b25ba8e8794c601f27d6b79d27685e8c73f4dd4; app.asar SHA256 d99d07318ce12c726701bbe6dc8680a5801dd11fb407335a127736a7a035e8d7. Copied with ditto into this worktree's ignored release path, and each test copies again to its own temp directory. Original package untouched.

Ordinary baseline command, externally supervised for 360 seconds (original 120-second test/hook budget unchanged):
`python3 /tmp/terno-smoke-supervise.py red pnpm --filter @terno/desktop exec playwright test -c playwright.smoke.config.ts notify.smoke.ts people.smoke.ts`
Supervisor appends `--require=/tmp/terno-network-guard.cjs` to NODE_OPTIONS and unsets ELECTRON_RUN_AS_NODE, TERNO_DEV_URL and TERNO_SMOKE_SCREENSHOT. Captures owned process tree and signals only those PIDs. Log `/tmp/terno-fixture-red.log`.

Dock passes; ordinary notification test fails at dialog disappearance after 30 seconds. Original milestone also records afterAll exceeding 120 seconds and People startup lacking a thread row after 60 seconds. Current-source createRegistry with the same loopback fixture verifies successfully, so SMTP auth policy is not assumed to be the cause. People currently strips v14/v15 columns from a v30 seed while leaving future objects.

## Design

Capture the actual account error before adjusting synthetic transport setup. Preserve transport security in production. Reconstruct v13 with the existing DB legacy-copy test helper, copying the populated current seed into the exact old schema, deleting only facts backfill progress so the real backfill runs. Assert meaningful data survived, v13 has no future objects, and migration reaches current SCHEMA_VERSION. Pin Lumen as an explicit fixture precondition before retaining the greeting and People assertions.

Track only the launched application's process; attempt normal close, then use a finite owned-process fallback and join it. Cleanup must attempt all owned resources even after an earlier cleanup error. Stop synthetic IMAP/SMTP listeners and their connections, then remove temporary profiles/copies. Block external renderer requests before navigating mail.

## Validation and limits

Only affected packaged cases, directly needed helper tests, desktop package types and touched lint. No product hot path or perf change. No app/package/full-suite build or run. Package is older than current source: fixture success proves the reused package only; a product change would require source controls and a fresh final milestone binary. Native banner drawing/signature trust is not asserted. One native read-only plan critique (at most 12 points), then exactly one completed native Standards+Spec review; findings fixed fail-first, with only high correctness/data-loss fixes after cap and lower findings backlogged.

## Revisions after the Codex review

One native `codex exec -s read-only` plan critique completed (`/tmp/terno-fixture-plan-review.txt`), eight points accepted: bound error capture at submission; fresh legacy destination/checkpoint; exact row counts and representative data comparisons; fixed package schema v30 (same as current source); capture owned descendants before close; independent cleanup deadlines; Node guard plus renderer barrier; targeted smoke type check.

Baseline completed exit 1 in 345 seconds: Dock green, notification dialog red, afterAll and worker teardown each exceeded 120 seconds, People thread-row red. Native sample of captured diagnostic main PID 9395 (`/tmp/terno-notify-main.sample.txt`) shows main blocked in SecItemCopyMatching → SecKeychainItemCopyContent → SecurityServer decrypt. Current-source loopback verification succeeded. No production TLS/auth changes are justified. Use an in-memory synthetic safeStorage adapter installed via Electron API before submitting the account; this smoke does not validate native credential storage and must never access the user's keychain. Diagnostic trace run stopped at its captured main PID after collecting this evidence.

## Implementation and scoped verification

No product code changed. Native sample proved Keychain blocking, so the notification fixture installs a synthetic reversible safeStorage adapter before account submission. Real loopback IMAP/SMTP verification and IDLE, exact notice payload/count, list suppression, click-to-conversation and Dock assertions remain. This is expressly not native encryption coverage. Renderer external HTTP(S) is aborted; the supplied Node guard remains appended by the supervisor. No whole-desktop screenshot taken.

People now uses `writeLegacyCopy` with a separate destination and closed/checkpointed handles. It checks account configuration, thread IDs, message IDs/content/recipients, body rows and draft IDs via deterministic digests and counts across reconstruction and packaged migration. Explicit `app.design=lumen`; schema target v30 matches both package and checkout. Direct helper regression compares the complete old sqlite_master schema, then migrates with current source. Original conversion was restored only as a negative control in the owned helper and produced **duplicate column name: attachments_captured**. Fixed helper passed. No DB production/helper source changed.

Commands (each test invocation uses existing NODE_OPTIONS plus `--require=/tmp/terno-network-guard.cjs`):

- Ordinary RED: supervisor command above, exit 1, 1 passed/2 failed, 345.45 seconds. Original test and hook timeouts unchanged.
- Diagnostic RED: `python3 /tmp/terno-smoke-supervise.py trace pnpm --filter @terno/desktop exec playwright test -c playwright.smoke.config.ts notify.smoke.ts --trace on`, exit 1 after native sample; captured main PID 9395 explicitly stopped. Diagnostic account-error capture subsequently moved to a bounded submit catch per critique.
- Packaged GREEN: `python3 /tmp/terno-smoke-supervise.py green1 pnpm --filter @terno/desktop exec playwright test -c playwright.smoke.config.ts notify.smoke.ts people.smoke.ts`, 3 passed, 18.3 seconds; supervisor exit 0 in 18.91 seconds.
- Legacy helper RED/GREEN: `pnpm --filter @terno/backend-dev exec tsx --test ../../apps/desktop/e2e/people-profile.test.ts`: original conversion negative control failed on duplicate attachments_captured; final conversion 1 passed.
- Cleanup RED/GREEN: `pnpm --filter @terno/backend-dev exec tsx --test ../../apps/desktop/e2e/packaged-fixture.test.ts`: removing the finally join failed because child.signalCode remained null (test finally kills/joins its owned child); restored helper 2 passed.
- Desktop package types: `pnpm --filter @terno/desktop typecheck` passed. Targeted smoke types: `pnpm exec tsc -p /tmp/terno-smoke-types.json`, using repo base config, Node/DOM and explicit smoke/helper test files (desktop's ordinary tsconfig excludes e2e).
- Touched lint: `pnpm exec oxlint --deny-warnings apps/desktop/e2e/notify.smoke.ts apps/desktop/e2e/people.smoke.ts apps/desktop/e2e/packaged-fixture.ts apps/desktop/e2e/people-profile.ts apps/desktop/e2e/packaged-fixture.test.ts apps/desktop/e2e/people-profile.test.ts`.

Source negative control logs: `/tmp/terno-people-source-red.log`, `/tmp/terno-cleanup-red.log`. Packaged logs and captured PID manifests: `/tmp/terno-fixture-{red,trace,green1}.{log,json}`. No hot path changed, therefore no affected perf gate; no full suites/builds run. Fresh final milestone build remains root's responsibility; no release clearance.

## Single Standards+Spec review disposition

Exactly one native read-only Standards+Spec review completed on `dbf9c38a..e52d17b4`, output `/tmp/terno-fixture-code-review.txt` (CLI transcript `/tmp/terno-fixture-code-review-run.log`). One finding, P2: `alive(pid)` and signal can race; ESRCH would abort the rest of owned-process cleanup. Fixed because it violates the explicit owned-process join requirement. Added a regression first: the captured child exits as the signal is sent, the injected ESRCH must not interrupt joining or mask the original close error. It failed before the fix (`/tmp/terno-cleanup-review-red.log`), then all three cleanup tests passed after handling only ESRCH at the signal operation. No additional review/reviewer, no remaining findings or lower-priority backlog.

After this cleanup change, re-ran only affected packaged files:
`python3 /tmp/terno-smoke-supervise.py green-final pnpm --filter @terno/desktop exec playwright test -c playwright.smoke.config.ts notify.smoke.ts people.smoke.ts`
Result: **3 passed (18.2s)**, exit 0, supervisor 18.59s. Final log/manifests `/tmp/terno-fixture-green-final.{log,json}`. Targeted smoke/helper types and touched lint passed again. Desktop package types passed earlier; no desktop source changed afterward. Helper regression counts: legacy 1 passed, cleanup 3 passed.

Strict `codesign --verify --deep --strict` passed on the copied app; signing remains ad-hoc (no TeamIdentifier), not distribution/notarization clearance. Original package hashes rechecked unchanged. All PIDs in the final captured manifest confirmed gone after completion. The reused worktree release copy and the two baseline/diagnostic temporary app/profile directories were removed after validation; original milestone package and user release outputs remain untouched. No builds, pushes, real profile access, whole-screen captures, or full gates. Native Keychain/encryption is intentionally outside this synthetic smoke; a fresh final milestone binary has not been tested here.
