# Checkpoint worker fixture cleanup — preparation only

Base `d6dadc6581a1d88e728698e2c816697cd17cc407`, initially clean branch `t3/checkpoint-worker-cleanup-plan`. IDB R48 owns measurement. **No implementation or test release; source reviews0/2.**

## Request and source evidence

Task scope: “SOURCE/PLAN PREPARATION ONLY now”; “Proposed fix scope ONLY failure-safe cleanup of the test's already-owned worker”; “no edits until Root serially releases your implementation after measurement”. Queue includes a common-word SQL diagnostic in the same perf file; preserve its source hash/evidence. No historical-cause claim or full-file replay.

Inspected committed exact DB sources and Plan68’s round11 checkpoint actor note, plus `docs/plans/drafts/release-native-sql-counts-preparation.md` and `release-native-sql-counts-diagnostic.md` on `t3/sqlite-perf-gate-repair` (observed head `8de6f8fb217d88b84fcd0c64b38c6e1f59ebaa02`). No parked source imports. Rootworklist lead comes from the task; no committed rootworklist path found or edited.

In `perf.perf.test.ts`, navigation / “lists an account's own folders (plan 68): big, sparse, deep, filtered, scopes” starts the worker at line91 and stops only at success line247. Earlier operation/assertion failure bypasses stop. This establishes a source lifetime gap, **not historical counts/ingest/COMMIT causation**. Native explicit stop joins but suppresses the unexpected-exit callback restoring autocheckpoints; writer pragma therefore stays0. Restore native default1000 after joined cleanup on either outcome, outside the body. No custom-setting restoration promised for this default fixture.

Unchanged perf blob `6086ae368b5560c050872f2e0b723d588bbab7f8`, SHA256 `7a963909f876f4ba6f92fe1a5b832a70eac5dda671bd18d617da0f33097bf6ef`, matching SQL receipt. Recheck Root’s current hash at release; coordinate conflicts, never overwrite peer evidence/edits.

## Proposed boundary and exact ownership

Prefer a tiny test-only `packages/db/src/test/checkpoint-fixture.ts`: start the existing worker and immediately register Vitest `onTestFinished` to await that exact handle’s stop, then restore writer autocheckpoint1000 before global DB close. This avoids a broad catch around the body. Justification for the shared utility: ordinary fixtures can execute the real registration/teardown boundary without executing perf or copying a finally block; no resource manager or production API.

Own only that helper, `packages/db/src/checkpoint-fixture.test.ts`, `packages/db/src/test/checkpoint-fixture.fixture.ts`, this plan/critique, and the named perf case’s acquisition/finish boundary plus necessary import. Replace acquisition with helper and remove success-only stop. Every intervening body statement/assertion/timer/operation, gate/sample/budget/workload/metadata, monitored window, worker actor and default cadence stays unchanged. No injected wait/checkpoint/GC. Production checkpoint/driver/WAL/durability, seed, timing helper, other cases and whole-suite cleanup are excluded. Body timer/data restoration failures are separate leads.

Primary body error remains with Vitest; cleanup rejection must be separately visible. Stop rejection fails teardown and restoration is not claimed; restoration rejection fails teardown. Ordinary coverage must establish both body and cleanup errors survive together, plus cleanup-only failure. If runner semantics cannot do this, revise before implementation; no swallowed error/console-only report. Startup failure before a handle exists is outside scope.

## Future ordinary RED/GREEN (not executed)

A parent ordinary test launches only an explicit synthetic fixture through existing local Vitest. Child opens a tiny real native file DB, no mail dataset, and uses the shared helper. Child-owned partial Worker constructor observation delegates unchanged to the real constructor/options; capture exact object, initial positive threadId, parent PID and exit event. Decorate test driver’s returned real handle to record delegated stop invocation/resolution; correlate unique path/acquisition, fail on ambiguity. Delegating writer exec observation records restoration. Require **stop-called < same-object exit <= stop-resolved < restoration**, final threadId=-1 and pragma1000 on the still-open writer; reject unexpected/pre-stop exit/error. No fake worker/stop or production observation seam.

Sequential body/witness pairs: tiny real SQL operation then unique thrown Error; actual failed assertion; successful completion exactly once. Each body first verifies pragma0/live worker; each following witness verifies joined exit/restoration. Parent checks exact test identities/outcomes and original errors, all witnesses passing, no unrelated failure. Additional narrow cases inject a cleanup error only after real stop/join: body+cleanup and success+cleanup must report both errors or cleanup alone respectively.

For meaningful RED, stage the shared boundary with old success-only cleanup, run these ordinary cases and retain failing live-worker/pragma witnesses; apply failure-safe cleanup and run identical GREEN. **No new RED/GREEN now.** Reverting helper cleanup must reproduce RED. This covers helper lifecycle, not reverting only perf wiring: source review must verify helper use/removal of old stop and byte-equivalent body. No finally-token/mocked-call-count oracle or executed perf integration claim.

Child unconditional afterAll safety finalizer joins only its captured handles **after witnesses**, then closes DB/removes owned temp files, even on RED; safety cleanup cannot satisfy witnesses. Parent owns/supervises only its child process, never child Worker/DB objects. Capture process PID/birth/argv and Worker identity; finite joins, exact-owned-PID signals only after identity check; no name/port kills. Native2000-ms stop fallback unchanged.

Exact future parent command: `pnpm exec vitest run --config <owned-temp>/parent.config.mts packages/db/src/checkpoint-fixture.test.ts`. Temporary parent config includes only that file, Node/serial, test/hook deadlines60000/20000ms; child config selects only the fixture, Node/serial, deadlines10000/10000ms, parent finite45000-ms child join. Neither uses repository projects/globalSetup/WASM/backend builds. Owned temporary configs/artifacts only, no root-config edits. Bounded report/log evidence; snapshot/restore exact preexisting config/cache/artifacts.

Every future test appends inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs`; unset ELECTRON_RUN_AS_NODE. Existing local deps/owned links only; no installs, old-evidence deletion, real profiles/mail/secrets/env dump. Protected backend file, account-label WIP, all user/site/peer and parked S48/B35/T09/W06/editor/list/dependency sources stay untouched. No fetch/push/main/worklist/stash/reset/revert.

After Root’s serial release only: ordinary RED, targeted tests/types/exact lint; max2 combined source reviews, R2 P1/P2 park-only rule. No full gates, unchanged timing retries or release-green claim.

## Revisions after the Codex review

One actual native `gpt-6.1-sol`/high read-only critique completed exit0 with five points, all accepted: child-owned safety cleanup; explicit real stop/join witness; restoration ordering; honest helper-versus-perf coverage; isolated parent entry/deadlines. Verbatim findings/process receipt in `checkpoint-worker-fixture-cleanup.critique.md`. No second critique, tests/profiles/benchmarks/installs/generators/production edits or source reviews. Runner cleanup-error semantics remain an execution acceptance criterion, not verified fact. **Source reviews0/2.**
