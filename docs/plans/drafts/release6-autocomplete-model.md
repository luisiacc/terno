# Release 6: autocomplete model

## Scope and request
“Own packages/store/src/autocomplete/ service, phrase/model builders and exact direct tests/perf.” Repair the sixth snapshot's 12,000-person commit stall and 100,000-message phrase CPU gate only after current-source reproduction and causal work attribution. Actual clean base: 7bc3b97dc040cae83db648e47e52d69e99a3f272. Main remains not release-green.

## Existing behavior and design
Plan18 owns bounded contact delta merges, sliced startup/incremental learning, quote/privacy filtering, fixed phrase tables and snapshots. Current exact service case passes once; historical 127.456ms remains unreproduced, not waived. Phrase baseline is pending. Profile CPU and allocations separately from qualification before choosing a change. Preserve all learned counts/model equivalence, scheduler yields, readiness/rebuild/close, bounded memory and idle resources. Any optimization needs an ordinary fail-first work or behavior regression. Do not infer timing causality from a passing isolated baseline.

## Verification and exclusions
Exact service/phrase tests and direct contact tests only as affected, store types and exact-file lint; unchanged original phrase perf file once after genuinely causal new source. No oracle, threshold, workload, timeout, warmup, retry, UI/backend/core/SQL/IDB/dependency/lockfile or plans64–68 edits. No full gates/builds. Tests append inherited NODE_OPTIONS with /tmp/terno-network-guard.cjs; synthetic fixtures only. Capture PID/birth/argv and finite deadlines, join/reap. Separate diagnostics from qualification. No push/fetch/main/worklist edits.

One native gpt-6.1-sol/high read-only plan critique (≤12 points), then exactly one Standards+Spec code review after coherent implementation and focused green. Fix findings fail-first without another review; afterward only high correctness/data-loss fixes, lower issues backlogged. Commit with required co-author.

## Revisions after the Codex review
Native sol/high read-only critique completed: nine points (/tmp/terno-r6-ac-plan-review.log). Keep service's waiting/GC/descheduling ambiguity explicit; no contact correction justified by the passing reproduction. Preserve startup versus incremental pruning and publication, scheduler and service code unchanged. Demonstrate removed duplicate language/learning tokenization and assert complete model state equivalence, including casing, language, learned bits and continuation errors. Bounded per-message scratch remains inside the monitored learn call; no page prebuffer/model copy. Baseline phrase perf RED: 33.73128µs/message, best stall1.9ms,13.0MiB; four other cases pass, subsequent build-case assertions unreached.

## Coherent correction and focused validation
Separate100k inspector diagnostic (/tmp/terno-r6-ac-{cpu,heap}-before.json, source archived /tmp/terno-r6-ac-profile-source.ts): observe1722 CPU samples, learn1018, tokenize752, fold521, detectLanguage399, hashContext251; GC313. Retained allocation sampling reports match85,640bytes and split205,200bytes, not total allocated bytes (do not treat this as a complete allocation tally). Exact work regression proves the removable allocation/scan: short two-line message tokenized three times before, two afterward. Reuse line token arrays only for text≤2000characters; larger text retains exact tail tokenization including cut words/combining sequences. Scratch is bounded by the existing own-text cap, allocated inside learn and the original monitor, with no prebuffered pages, model copies, timers, caches or pruning changes. No contact source changes.

Work RED: /tmp/terno-r6-ac-work-red.log (3 scans vs2). Focused GREEN:20/20 in phrases+service (/tmp/terno-r6-ac-final-unit.log). Complete-state equivalence compared new and actual committed-base implementation byte-for-byte over96messages, duplicates, tiny-table pruning, Unicode/name/casing/privacy,2000/2001character boundaries; /tmp/terno-r6-ac-equivalence-boundaries.log. Baseline code removed; permanent SHA256 snapshot witness plus exact roundtrip remains. Initial store typecheck failed on Node crypto import (store intentionally has no Node globals); replaced test adapter with narrow WebCrypto host declaration. Final store types,18phrase tests and exact-file strict lint PASS (/tmp/terno-r6-ac-final-{types,test-adapter,lint}.log). No product API/config change. Original performance qualification pending; no gate clearance claimed.

## Single code review
Exactly one actual native gpt-6.1-sol/high read-only Standards+Spec review completed after coherent source and focused green, exit0: **Standards PASS, Spec PASS, zero findings**. Prompt /tmp/terno-r6-ac-code-review-prompt.txt, full result /tmp/terno-r6-ac-code-review.log. No fallback/second review, no findings requiring fixes or deferred new lower issues. Existing contact slicing/peak and startup/incremental prune observations in the plan critique are unchanged preexisting questions, not causally established fixes in this slice. The review explicitly grants no full gate or release clearance.

## Commands and process safety
Commands run in this isolated checkout. Every invocation uses `python3 /tmp/terno-ac-run.py LIMIT LOG COMMAND`, which appends inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs`, captures owned PID/birth/argv, enforces finite deadline, and waits/reaps. All completed naturally; no signals, port occupancy changes, quiet window, browser/Electron/profile use or external mail traffic. Initial pnpm dependency verification cloned missing local dependencies (downloaded0); no lockfile edit. No existing screenshot/result paths were replaced. Diagnostic outputs use unique release6 prefixes; transient diagnostic and baseline modules archived outside checkout and removed. No runtime instrumentation in final source.

```sh
python3 /tmp/terno-ac-run.py 240 /tmp/terno-r6-ac-baseline-service.log pnpm exec vitest run --project unit packages/store/src/autocomplete/service.test.ts -t 'applies a commit of 12,000'
# Remaining pnpm invocations set npm_config_verify_deps_before_run=false.
python3 /tmp/terno-ac-run.py 1500 /tmp/terno-r6-ac-baseline-phrases.log pnpm exec vitest run --project perf packages/store/src/autocomplete/phrases.perf.test.ts
python3 /tmp/terno-ac-run.py 420 /tmp/terno-r6-ac-plan-review.log codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . '<critique prompt retained in log>'
python3 /tmp/terno-ac-run.py 240 /tmp/terno-r6-ac-profile-before.log pnpm exec vitest run --project unit packages/store/src/autocomplete/release6-profile.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-work-red.log pnpm exec vitest run --project unit packages/store/src/autocomplete/phrases.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-focused-green.log pnpm exec vitest run --project unit packages/store/src/autocomplete/phrases.test.ts packages/store/src/autocomplete/service.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-equivalence.log pnpm exec vitest run --project unit packages/store/src/autocomplete/phrases.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-equivalence-boundaries.log pnpm exec vitest run --project unit packages/store/src/autocomplete/phrases.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-final-unit.log pnpm exec vitest run --project unit packages/store/src/autocomplete/phrases.test.ts packages/store/src/autocomplete/service.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-types.log pnpm --filter @terno/store typecheck
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-lint.log pnpm exec oxlint --deny-warnings packages/store/src/autocomplete/phrases.ts packages/store/src/autocomplete/phrases.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-final-types.log pnpm --filter @terno/store typecheck
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-final-test-adapter.log pnpm exec vitest run --project unit packages/store/src/autocomplete/phrases.test.ts
python3 /tmp/terno-ac-run.py 180 /tmp/terno-r6-ac-final-lint.log pnpm exec oxlint --deny-warnings packages/store/src/autocomplete/phrases.ts packages/store/src/autocomplete/phrases.test.ts
python3 /tmp/terno-ac-run.py 600 /tmp/terno-r6-ac-code-review.log codex exec --disable plugins -s read-only -m gpt-6.1-sol -c model_reasoning_effort=high -C . - < /tmp/terno-r6-ac-code-review-prompt.txt
python3 /tmp/terno-ac-run.py 1500 /tmp/terno-r6-ac-qualification-phrases.log pnpm exec vitest run --project perf packages/store/src/autocomplete/phrases.perf.test.ts
```

An initial digest-capture script could not find Vitest's suppressed console output and raised TypeError; it had already written the source change, did not alter the oracle, and its following focused tests passed. Corrected capture used a separate explicit byte-for-byte comparison against the actual base module, then froze the resulting SHA256 witness. These experiments are not qualifications or timing retries.

## Qualification and handoff
**Original phrase perf remains RED**, one unchanged-file invocation after new source, exit1,4/5cases PASS. Best CPU34.57029µs/message exceeds31 (individual builds40.4,34.6,36.5); best measured stall14.2ms; memory13.0MiB measured/counted. The CPU assertion fails first, so subsequent stall, memory, counted-vs-measured and learned-habit assertions in that case are **unreached**, despite logged values. Suggestion latency, huge-window regression twin, slowdown twin and snapshot-roundtrip cases pass. Full log /tmp/terno-r6-ac-qualification-phrases.log. Preserve both baseline and new-source REDs. Descheduled wall gaps are reported by the unchanged oracle; they neither waive this CPU failure nor prove its cause. The change removes demonstrated duplicate work but **does not establish a CPU improvement or repair the performance contract**.

The original service case passed once on current source (the filtered invocation excludes its other case); the later whole direct service+phrase unit invocation passed20/20. Historical service127.456ms remains **unreproduced and unresolved**, with no service/contact source edit. Nothing here qualifies the old full-snapshot RED or main release status.

Review cap is consumed. No further performance correction/review or unchanged gate retries were attempted. Remaining release work: investigate the still-failing phrase CPU under the next explicitly authorized causal repair/qualification series; retain the original service-stall evidence pending causal attribution. Root owns serial rebase/integration/retest/landing and full milestone; no fetch/push/main/worklist/other-owner edits here. No broader model/report/backend/full tests, UI/e2e/perf suites or app/production/dist/package/smoke builds run. No UI/copy change. Main remains **NOT release-green**.
