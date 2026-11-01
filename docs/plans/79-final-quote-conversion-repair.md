# Final quote-conversion repair

## Request (verbatim task constraints)

“Prepare focused repair of final be2efa23 unit failure packages/richtext/src/richtext.test.ts 'a hostile quote can't nest without end or blow the stack; a 2 MB quote converts in pieces, fast', measured71.109ms vs unchanged25ms.”

“PHASE NOW: source/plan/evidence preparation ONLY, since mail child owns serial timing slot.”

“No unnecessary new broad measurement design; keep original2MB workload, structure, exact HTML, slicing, depth, assertions, timeout25ms budget intact.”

## Baseline and evidence

Prepared base `768aa752ebf0683cb731f524802ddf5bb893b5c1`, clean committed checkout; includes d5e35c4b and ca0d1437. Root owns integration. No user WIP imported. Saved final evidence: `/tmp/terno-final-gate-7ukzyk6i/03-test-failure-inventory.txt`, lines329–330: original hostile-quote case expected71.10925000000043 to be less than25. This inventory does not identify which input, iterator step, CPU work, GC or scheduling produced that maximum. No reproduction, new RED, or established cause in this phase.

Read current AGENTS.md; relevant sending/slicing/output provisions of plans04,16,29 and landed `drafts/release6-quote-conversion.md` (integration record7761321e). Earlier correction bounded whole-line scanning, with indexed-read and bounded-slice regression, 2,352-case frozen HTML hash and exact-output controls. Its diagnostic CPU was higher and attributed most samples to encodeSpaces; some slow steps had little CPU. Historical findings are hypotheses for this failure, not proof. Preserve all earlier controls; no reversion/import of parked source.

## Candidate cause and minimal ownership

`quote.ts:17–38` encodeSpaces runs `/ +/g` with a callback for every isolated space, including ordinary interior spaces that remain unchanged. Both original workloads contain many such spaces. Avoidable callback/string allocation is the leading source-based candidate; runtime flattening/GC and external scheduling remain alternatives. None is established as the71.109ms cause. The already bounded scanner is not evidence of an unbounded step now.

Prospective ownership: only encodeSpaces in `packages/richtext/src/quote.ts`, new direct work/output tests in `packages/richtext/src/quote.test.ts`, and this plan. `richtext.test.ts` is read-only, especially lines288–318. Keep escapeHtml, URL recognition, cut positions, iterator budget/flush points, nesting/depth32, newlines, output chunks, cancellation and eager/lazy boundaries unchanged. No production edit now. Broaden source ownership only with causal evidence and Root agreement.

## Discriminating ordinary-work regression (planned, unexecuted)

After Root releases the serial slot, add one deterministic direct regression through real textToHtmlChunks using ordinary alternating word/isolated-space text from the original workload pattern. Temporarily spy on String.prototype.replace in the synchronous test, forwarding to the native method and counting function replacement invocations; restore in finally before assertions and do not touch clocks. Require unchanged joined HTML AND chunk boundaries, plus callbacks proportional to runs needing encoding rather than every ordinary interior space. Expected baseline callback work is high by inspection, not an executed RED. Pair direct encodeSpaces expectations for lineStart/lineEnd/afterSpace, leading/trailing spaces, two/three-space runs, tabs, escaped entities, link-adjacent spaces and empty text. Literal independent expected output; existing frozen hash remains an independent compatibility check.

This separates ordinary needless work from already-covered scan bounds; it does not alone establish wall-time causality. If it does not discriminate or evidence points elsewhere, stop and report rather than widen measurements or make a speculative production change. Candidate fix, only after RED: bypass callbacks for unchanged isolated interior spaces while retaining exact state at edges and runs. No cache, initialization displacement, new dependency, reduced budget or input-size change.

## Deferred validation and process/artifact discipline

No tests, timed benchmarks, original25ms rerun, production changes, build, cache generation or code review during preparation. Native read-only plan critique only. Snapshot artifact state before generating reports/workers/cache; unique small evidence retained, existing artifacts preserved. All eventual tests append inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs`. Own finite child PID/birth/argv and join; signal only after exact own identity verification. No profile, secret, env dump, backend inventory, forbidden stage2 test, account-label access or parked editor/list/ProseMirror/huge-editor source. No deletion, fetch/push/main/worklist/stash/reset/revert.

After release: fail-first ordinary-work regression, smallest evidence-supported fix and direct tests; touched richtext package typecheck and strict scoped lint; one affected original gate invocation after the candidate change passes deterministic work/output checks, preserving original2MB fixture, big.repeat(3), 5M alternating line, all assertions and terminal next measurement. No unchanged timing rerun, budget/window/payload/sample/skip/.fails change or broad sweeps. Any failure is retained and reported, not retried for green. At most two actual Standards+Spec code reviews after implementation; zero used in preparation. No release-green claim.

## Revisions after the Codex review

Actual native `codex exec --ephemeral -m gpt-6.1-sol -c model_reasoning_effort="high" -s read-only -C <checkout> -` completed exit0, seven concrete points. Header confirms OpenAI/gpt-6.1-sol/high/read-only. Verdict: sound scoped preparation with refinements. All seven accepted:

1. Count callback executions by wrapping function replacements, preserving native arguments/return values; restore in finally before assertions.
2. Concrete planned fixture: budget8, literal `x x x x x x x x x x x x `; at most1 callback (necessary trailing-space encoding), versus12 by source inspection. This has NOT been executed.
3. Independent literal expected chunk array: `["<div>x x x x ", "x x x x ", "x x x x&nbsp;</div>", ""]`. Preserve the empty final yield; joined comparison against the converter itself is insufficient.
4. Pin afterSpace-at-offset-zero, overlapping leading/trailing flags, alternation reset after NBSP, single spaces and runs across chunk boundaries.
5. Literal escaped-entity/tab/link-adjacent outputs plus the unchanged frozen compatibility hash; do not use lineHtml as the new oracle.
6. Source ownership stays encodeSpaces only. Callback reduction does not prove allocation reduction or historical wall-time cause.
7. Removed “after causal fix” certainty from qualification wording; terminal next, original timing and workload stay intact. A future pass is not proof of historical cause.

This was a plan critique, not an implementation code review. Code reviews used:0 of maximum2. No implementation, tests, new RED, timing result or release qualification in this preparation phase.


## Retained preparation evidence

Unique evidence directory: `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-quote-final-prep-7zz9mcsl`. Contains before-artifact metadata/status, failure excerpt, source hashes, critique prompt/full transcript, PID/birth/argv/deadline and joined exit0. Only unique small report files were generated; no worker/cache/build/test reports generated or old artifacts removed. Final inventory original remains in place. Snapshot comparison below checks existence/mtime metadata, not recursive cache contents.

- `packages/richtext/src/quote.ts` SHA-256 `dd5a4713aa8821f3151decf1291ec318382956cfa9d7b074599a1ab157379ff2` (unchanged).
- `packages/richtext/src/quote.test.ts` SHA-256 `eed80ada73c2de6ada28a173bf98104bd0afbdda3cbc7286c505fafe07f8bade` (unchanged).
- `packages/richtext/src/richtext.test.ts` SHA-256 `1354e8bb6127ffc8c6f47b50f3199ec65bf3b2f6d527669e85d5ff16b1c06701` (unchanged).

Known artifact existence/mtime metadata matches preparation snapshot; restoration unnecessary. Final scoped check: git diff whitespace only, no test/build invocation. Disk observed629MiB free during preparation; no cleanup attempted. Root must release the next phase before any RED/test or production edit.


## Released implementation phase (2026-11-01)

Root released source/test-first work after mail timing joined. Safely rebased the sole preparation commit onto current committed main `9086a71f665a9e0e7105ec44977855e272f48e36`; rebased preparation head `a672b3123b01c0f4314e3524f816d007e13a52a1`. Earlier seven critique points retained; no new plan critique. Exact ownership remained encodeSpaces, direct quote tests and this plan. No editor/list/ProseMirror or other production source imported or changed.

Actual deterministic RED: first new six-test run failed callback work (12 >1) and a mistaken new multi-space chunk oracle. Corrected only that oracle to respect existing budget8 split, then reran before production edit: 1 failed/5 passed, solely12 callback invocations versus ceiling1; literal ordinary chunks/joined HTML passed. Both logs retained. This proves redundant ordinary-space callback work, not historical71.109ms causality.

Minimal source change: select a space-run expression matching multiple spaces plus only edges requiring encoding. Existing callback, alternation, tab replacement, escape ordering, scanner, cut/budget/flush/depth and public signatures remain unchanged. Regression now passes with <=1 callback, required final encoding retained. Literal edge-state/tab/entity/link controls, chunk arrays and original frozen2,352-case compatibility hash retained. No allocation or historical timing attribution claimed.

Checks in order, all child processes captured with PID/birth/argv/finite deadline and joined, all inheriting NODE_OPTIONS plus network guard:

- Corrected source functional: exact `quote.test.ts`, 6/6 PASS.
- `tsc -p packages/richtext/tsconfig.json`: PASS, no config changes.
- `oxlint --deny-warnings packages/richtext/src/quote.ts packages/richtext/src/quote.test.ts`: PASS.
- After timing-readiness notification and joining own CPU checks: original `richtext.test.ts -t "a hostile quote"`, exactly once, 1/1 PASS (29 filtered); complete unchanged test reached its later CR/LF and link-boundary assertions. No timing values exposed by original passing test, and no instrumentation/extra timing rerun added. Historical71.109ms cause remains unproven.

Focused Vitest config is external evidence only: node environment, original20,000ms test timeout, exact two richtext filenames, cache:false. It omits unrelated backend worker globalSetup; no worker build is required for pure richtext tests. No original source, fixtures, clocks, per-next25ms assertion or initialization boundaries changed. Direct resolved tool entrypoints used after first pnpm exec unexpectedly auto-linked9 locally reused packages (zero downloads), despite shared dependency symlinks; this setup event is retained, no install retry/generator run. Scoped types use the real richtext config, including normal compiler discovery. Shared dependency source is not imported from user WIP.

Known output existence/symlink snapshot preceded dependency linkage and test/report generation. Worktree root and richtext node_modules symlinks were absent initially and created by this actor to existing local dependency trees; remove only these exact owned links at handoff. No old artifacts/evidence/user data deleted. No full gates, build, e2e, profile, broader package sweep or release-green claim.

Implementation evidence: `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-quote-final-fix-n3fumak4` (`before.json`, `base.txt`, external config and run.py, RED/confirmed RED/functional/types/lint/original-once logs with per-command process and exit records).

## Combined code review

R1 completed exit0; implementation code-review rounds used1 of maximum2. Both Standards and Spec PASS, no actionable findings. No regression repairs or R2 needed; no source changes after review. The seven-point preparation critique is separate and unchanged. The shared review shell script is absent, so use equivalent actual native read-only Sol/high Standards+Spec prompt with explicit checkout/base and exact scope. No reviewer test runs.


## Final handoff

Actual native R1 header confirms gpt-6.1-sol/OpenAI/high/read-only; full transcript `review-r1.log`, prompt and finite process metadata retained in the implementation evidence directory. No findings to repair or park. R2 unused. Preparation critique count remains1 with seven accepted points.

Final scope:6-line encodeSpaces diff, two new direct tests and plan. Original richtext.test.ts remains byte-identical to committed base (SHA-2561354e8bb6127ffc8c6f47b50f3199ec65bf3b2f6d527669e85d5ff16b1c06701). All monitored commands exited and joined; no timeout fired or signals sent. Only two exact actor-created dependency symlinks removed to restore their original absence; shared dependency trees, user data and old evidence untouched. Known output existence/symlink state matches the recorded pre-execution snapshot after restoration; recursive shared dependency contents were not snapshotted/restored, and pnpm's automatic9-package local linkage remains disclosed above. Whitespace check passes. No broad gates or release clearance claimed. Root owns integration from base9086a71f; historical71.109ms cause remains unproven.

Root main advanced during review with mail repair/documentation commits. Final safe rebase preserved both own commits onto `75181a797644b535876c12d4488b30d41b804cdc`; main introduced no richtext or owned-plan changes. Exact owned source/tests compare byte-identically against tested/reviewed pre-rebase headf172d953. No timing rerun or new review round; the recorded functional/timing/review evidence was executed on base9086a71f, not misrepresented as fresh post-rebase execution. Final integration base75181a79, Root owns landing.
