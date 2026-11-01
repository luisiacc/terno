# Single read-only plan critique

Base `d6dadc6581a1d88e728698e2c816697cd17cc407`; model `gpt-6.1-sol`, high effort, read-only sandbox (confirmed in run.log). Exit0, finite300-second supervisor join, no signals; PID/birth/argv captured below. No tests or source reviews. Raw evidence retained at `/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-checkpoint-plan-ifw0auyq`. Five findings accepted in the plan; no rerun.

```json
{
  "pid": 47589,
  "identity": "47589 47588 Sun Nov  1 17:53:48 2026     node /Users/Luis/Library/Caches/fnm_multishells/37447_1793577096775/bin/codex exec --model gpt-6.1-sol -c model_reasoning_effort=\"high\" -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-7070a723 --ephemeral -o /var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-checkpoint-plan-ifw0auyq/critique.txt -",
  "argv": [
    "codex",
    "exec",
    "--model",
    "gpt-6.1-sol",
    "-c",
    "model_reasoning_effort=\"high\"",
    "-s",
    "read-only",
    "-C",
    "/Users/Luis/.t3/worktrees/emailclient/t3-7070a723",
    "--ephemeral",
    "-o",
    "/var/folders/_h/cy6nv52s2lj7n18v_mlcb3y40000gn/T/terno-checkpoint-plan-ifw0auyq/critique.txt",
    "-"
  ],
  "base": "d6dadc6581a1d88e728698e2c816697cd17cc407",
  "deadline_seconds": 300
}
```

## Verbatim findings

1. **Cleanup ownership crosses an impossible process boundary.** The plan launches a child Vitest fixture, then assigns the parent responsibility for joining captured Workers and closing the DB. Those objects live in the child. Assign an unconditional safety finalizer to the child, after witness observations; the parent can supervise and join its owned process. Otherwise RED can leak actors. ([Plan:23–29](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/docs/plans/drafts/checkpoint-worker-fixture-cleanup.md:23))

2. **Exit plus pragma1000 does not prove explicit stop/join.** Unexpected worker exit also restores autocheckpoints. The plan requests a stop-join witness but does not define it. Specify observation of the real stop invocation and resolution, tied to the captured Worker, and reject exit preceding stop. Constructor interception alone cannot observe the returned handle’s stop promise. ([Plan:25](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/docs/plans/drafts/checkpoint-worker-fixture-cleanup.md:25); HEAD [checkpoint.ts:18](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/packages/db/src/checkpoint.ts:18), [node-driver.ts:163](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/packages/db/src/node-driver.ts:163), [node-driver.ts:186](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/packages/db/src/node-driver.ts:186))

3. **The restoration oracle misses incorrect ordering.** Checking pragma0 during the body and pragma1000 in the next test would pass if cleanup restored autocheckpoints *before* awaiting stop. Add a test-owned observation establishing real stop resolution before the restoration statement, without touching the perf body. ([Plan:17,25](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/docs/plans/drafts/checkpoint-worker-fixture-cleanup.md:17); HEAD [node-driver.ts:186](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/packages/db/src/node-driver.ts:186))

4. **The claimed regression reach exceeds the proposed harness.** The ordinary fixture exercises the shared helper, so changing that helper can demonstrate RED. Reverting only the perf call site to its original acquisition/success-only stop leaves the helper regression GREEN. Distinguish helper lifecycle coverage from perf integration coverage, and define precisely which reverted boundary must fail; source review must verify the perf wiring unless another narrow integration check is specified. ([Plan:19,27](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/docs/plans/drafts/checkpoint-worker-fixture-cleanup.md:19); HEAD [perf.perf.test.ts:247](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/packages/db/src/perf.perf.test.ts:247))

5. **The parent’s native-only execution entry is unspecified.** The proposed parent filename matches both ordinary projects; the unit project has backend global setup, while db-wasm selects it again with WASM setup. An isolated child config does not isolate the parent invocation. Specify an owned standalone parent config and exact command, with explicit selection and finite test/hook deadlines, within the existing ownership boundary. ([Plan:19,23,29](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/docs/plans/drafts/checkpoint-worker-fixture-cleanup.md:19); HEAD [vitest.config.ts:13](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/vitest.config.ts:13), [vitest.config.ts:24](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/vitest.config.ts:24), [package.json:19](/Users/Luis/.t3/worktrees/emailclient/t3-7070a723/package.json:19))