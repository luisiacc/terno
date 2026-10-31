# Release 7 folder upgrade

Request: repair the v23 50,000-conversation/20-label migration backfill slice failure and packaged People smoke's stale schema-30 expectation, within the assigned db folder and People fixture seams. Preserve all original workload, timing and identity assertions, historical migrations including v32, Plans80/81/83 and unrelated work. No builds, full gates, children, push or landing.

Actual committed base: 8885840b099c32f582aa3d7b5217dc4a48e1124a (expected 8885840b).

Existing: backfill expands each batch's 50 messages into label candidates, including repeated (thread,label) pairs, before INSERT OR IGNORE. This can repeat all index/trigger conflict work for a long conversation. Progress and writes already share a transaction. People uses a literal 30 although migration authority is 32; its v13 fixture is faithfully reconstructed.

Design: prove duplicate executable work with a BEFORE INSERT counter, then deduplicate candidate memberships inside the measured backfill SQL before insertion. Keep batch size and all timing windows unchanged. Test real v23 migration, rollback and close/reopen on native and WASM. Replace People literal with source migration authority and validate the packaged backend's migration list against that authority before launch, independently of runtime PRAGMA. Permit only an explicit source-app path override to run a fresh owned copy of the archived milestone7 app. No schema change unless evidence requires it.

Tests/perf: fail-first duplicate-work and fixture witness regressions; targeted native/WASM migrations, folders and direct callers; db types/scoped lint; exactly one unchanged original folders-migration perf qualification after correctness. Targeted existing People smoke only against archived 004cf999 app copy with preserved outputs. All tests append the network guard. One native Sol/high plan critique and one Standards+Spec implementation review. All review findings fixed fail-first; no second review.

Out of scope: UI/copy, shared stores, backend, IDB, identity fences, dependencies, historical migration rewrites, broad release qualification. Archived binary cannot qualify changed production source; Root's next fresh milestone remains required. Historical milestone7 RED remains unwaived.

## Revisions after the Codex review

One native Sol/high plan critique completed (exit 0, seven points; `/tmp/terno-release7-folder-upgrade/plan-review.txt`). Narrow causal claim: DISTINCT removes repeated insertion attempts/conflict checks, not JSON expansion or successful-insert triggers. Original timing qualification alone establishes timing success. Strengthened late-label, rollback, restart and selected-driver tests. Keep the original perf file byte-for-byte unchanged.

Schema witness implementation refinement: use the source migration sequence to construct an independent in-memory schema and require v31's column and v32's exact partial covering index; retain source-derived expected version. Inspect those same required objects on the actual upgraded packaged database as the built witness, alongside runtime version equality. This avoids parsing minified bundle text or evaluating it. Negative tests omit/no-op v31 and v32 independently, including a built-shaped database whose PRAGMA still claims current. No runtime value supplies the expected version.

Fail-first: native and WASM each report 1,000 BEFORE INSERT attempts vs 20 expected (`work-red.log`). People smoke fixture contract fails on the literal (`people-red.log`). Two initial command setup attempts failed because root has no tsx command and an incorrect relative path; the corrected backend-dev tsx command produced the intended assertion RED. Dependencies installed from offline frozen lockfile; no package/source edits or app build.

## Focused qualification before implementation review

- Native/WASM migration, unread and upgrade run: 62/62; folder/backfill direct callers: 62 passed, 572 unrelated cases unselected; strengthened upgrade tests: 4/4. `db-green.log`, `callers.log`, `upgrade-final.log`.
- People fixture tests: 3/3 (`people-final.log`), including faithful v13 schema/identity preservation and omitted/no-op source/built schema negative controls. First helper draft used an incorrect expected index shape; corrected against unchanged v32 authority before final passing tests (initial `people-green.log` overwritten by corrected result; first failure is not retained).
- DB typecheck and scoped lint pass. Scoped People TS check uses a temporary config extending desktop's existing config (`people-types.json`).
- Original untouched folders-migration perf ran exactly once for the DISTINCT production change: PASS 1/1, multiplier 1. Migration 268.784583 ms ≤1000; 1757 slices, p95 4.684708 ms, maximum 14.324750 ms ≤16. `perf.log`, `perf.json`, captured/reaped PID 28521 in `perf-process.json`. This demonstrates timing success here, not a claim that historical RED was machine noise. The original test and timing helpers are unchanged. A short People fixture verification overlapped the tail of this run; no quiet-window requirement or waiver was applied.
- Targeted existing packaged People smoke: PASS 1/1 (`smoke.log`, `smoke-results`). Source fixture uses this checkout; executable is a new temporary copy of archived milestone7 `004cf99943afa4055219688b0121baf130cb5f60`. Verified original executable SHA256 5824fd8bb37432466d520fbdf1f5f2d3d9c7b6f73e0704303582b34557bcc9f3 and asar b6cb371ff47361c4757cb0986f8d2b1176b09755e3ad64185ba7b42c1d595594 (`archive-hashes.txt`). Owned app path, PID/birth/argv recorded in smoke log; packaged fixture closes and joins it. Root test PID captured/reaped in `smoke-process.json`. The source archive was read only. The temporary app/profile were removed. No app builds, full smoke or other full gates.
- Existing perf/smoke outputs were checked before execution; no preexisting named files were present. Newly generated results archived under `/tmp/terno-release7-folder-upgrade`; restoration logic ran. All tests append inherited NODE_OPTIONS with the required guard. No UI changes; no screenshot/axe claim.

Historical milestone7 RED and broader release status remain open. The archived binary does not qualify the production SQL change; selected-driver native/WASM green plus Root's next fresh milestone are required. No push, landing, root worklist, peer or user WIP edits.

## Single native Standards + Spec implementation review and fix

Exactly one actual native `codex exec -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high` implementation review completed, exit 0, reviewing `8885840b..a5e5ea00`. Standards: zero findings. Spec: one P3 — the required index witness did not bind the index to its owning table. Full output and captured/reaped process metadata: `code-review.txt`, `code-review.log`, `code-review-process.json` under the evidence directory. No second review.

Fixed that finding after two fail-first executable fixture regressions: both source and packaged-database witness paths accepted a matching index on a decoy table (`review-decoy-red.log`, 2 failed). The helper now checks sqlite_master type = index and tbl_name = threads before checking the predicate. Post-review People fixture tests pass 5/5 (`people-post-review.log`), scoped People types and scoped lint pass (`people-types-post-review.log`, `lint-post-review.log`). Targeted existing archived People smoke was run once again for this witness change: 1/1 pass (`smoke-post-review.log`, `smoke-post-review-results`), using a NEW temporary app/profile copy and separate fresh result directory. PID/birth/argv captured in log; runner captured/reaped in `smoke-post-review-process.json`.

Post-review source changes are limited to `people-profile.ts` index ownership validation and its two fixture regressions. They were tested as above, **not independently rereviewed**. No new lower findings to backlog; all review findings addressed. Production DB SQL has not changed since its one passing original perf qualification, so no perf rerun. No final failing focused checks remain. Expected fail-first REDs and setup errors remain documented; historical milestone7 RED is not waived.

Exact focused command inventory: `/tmp/terno-release7-folder-upgrade/checks.json`; perf and smoke native argv in their `*-process.json` files. Each test invocation appended `--require=/tmp/terno-network-guard.cjs` to inherited NODE_OPTIONS. Artifact scope: synthetic temp DBs/profiles only; no real profile/secrets, builds, full suites, fetch/push/landing, or peer edits. Root still owns serial integration and fresh release qualification.


## Root integration

Series c519c833 was already based on current committed main8885840b. Root checked the complete diff, clean status and whitespace, then fast-forward landed it. Production SQL deduplicates equal membership candidates within the existing slice before INSERT OR IGNORE; progress and writes keep their transaction. Original workloads and timing assertions are unchanged.

Root verification passed 62 native/WASM upgrade/migration/unread cases, 62 selected backfill/folder direct-caller cases, five People fixture tests, DB and scoped People types, owned strict lint. Unselected tests receive no pass credit. The unchanged original folder-migration perf file ran once: 1/1 pass, opening/migration248.169ms against1000, 1757 backfill slices with maximum8.850958ms against16. Evidence and guarded PID/argv/results: `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-root-migration7-kjj9xafg`. Processes exited naturally and were joined; no gate retries or changes.

The sole native review returned Standards0/Spec1P3; the decoy-table witness finding received fail-first corrections and checks without a second independent review. Root made no further source/test changes. Worker packaged People verification used an owned copy of archived004cf999 and passed after the fixture correction; Root did not rerun that unchanged binary check. This does not qualify the changed SQL in a fresh package; the next complete milestone must do so. Historical seventh-milestone RED remains recorded. No main-green or broader153-row completion claim.
