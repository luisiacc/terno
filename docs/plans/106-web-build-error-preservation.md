# 106. Preserve the original failed Web build error

## Request (verbatim, scoped ownership excerpt)

> OWNERSHIP: build/bootstrap/integration configuration only, not backendruntime/migrations/rendererdrafts.
> Do not introduce genericguards tohide missingbuildoutputs; preserve actualrooterror if meaningfulsourcebugconfirmed.

The full task and exclusions are in the implementation handoff. No broad gates, backend scans, protected baselines, user WIP or secrets may be read. No children.

## Current evidence and design

Base a9970d9dae888ea899a1bdbe4afc7445a3f66c8a. The committed handlers import ./account-label; the module is not committed. Do not supply it. Frozen typecheck, E2E and UI-perf collection share this dependency. Frozen Web reports sourcemap ENOENT during closeBundle. Plan 78 requires debug IDs and private map archives after successful builds; plan 99 requires release Google configuration. Existing release configuration is present when loaded opaquely via withDotEnv with the root .env path (both required booleans true).

Reproduce Web hook behavior with the actual Vite config and a synthetic entry failing resolution, without importing backend code. If reproduced, archive only after successful output writes through Vite writeBundle; preserve missing-output failures on successful writes. Confirm normal build archives maps and tags debug IDs, and failures leave existing archives untouched.

## Checks and limits

Run Node test runner on the exact new regression before and after repair with inherited NODE_OPTIONS plus network guard. Run exact-file lint and both complete web package tsconfigs; record the expected unresolved committed dependency without shims. One native Sol/high read-only plan critique, one combined source R1; R2 only for actual findings, at most two rounds. No changed budgets, skipped tests or unchanged timing reruns.

No full gate repeat. Packaging NOTRUN until committed module closure exists; no fresh binary means smoke NOTRUN. No runtime/migration/draft repairs, UI changes, perf gates, parked candidates, remote publication or real account activity.

## Revisions after the Codex review

Completed native gpt-6.1-sol/high read-only critique (3 points; receipt in /tmp/terno-build-d316944f/critique.log).

1. The regression explicitly aligns the CLI outDir captured by the existing config and programmatic output override; no stale directory is shared. Programmatic outDir inference is a pre-existing separate concern and is not redesigned in this focused fix.
2. The guarantee is for failures before output is written, including module resolution failures. This does not promise transactional rollback if a later output hook fails. No existence guard suppresses errors.
3. Cover failure with stale output and existing private archive as well as absent output. Check the LATEST pointer is unchanged, without creating or replacing an existing pointer.


## Executed repair evidence

The ordinary Node regression failed before the source edit: absent output replaced the missing-import diagnostic with sourcemaps ENOENT; stale output reset the previous private archive. After moving the hook from closeBundle to writeBundle all three cases pass (two failure paths and successful debug-ID/archive processing). The test is exposed as `pnpm --filter @terno/web test:build`.

The complete web and worker tsconfigs remain blocked by TS2307 in committed handlers.ts importing ./account-label. Exact-file lint passed. No package/runtime closure or credentials were fabricated. Release configuration presence check: TERNO_GOOGLE_DESKTOP_ID=true, TERNO_GOOGLE_DESKTOP_SECRET=true via withDotEnv; no values emitted. dist:mac and fresh default smoke NOTRUN because complete committed closure is unavailable. No new release status is claimed.

## Source review

One combined native gpt-6.1-sol/high read-only R1 completed with no actionable P1/P2/P3 findings. Review restricted to the changed configuration, regression, plan, sourcemap implementation and exact scoped logs; no blocked browser bodies or package runtime was qualified. R2 unnecessary and NOTRUN. No children or parked source imported. Private review receipts: /tmp/terno-build-d316944f/r1.log and r1.json.
