Reviewed `f9a9ceac...81986e71` at actual HEAD.

**High correctness/data-loss blockers:** none found.

**Standards:** no new actionable findings.
**Spec:** no new actionable findings against the active compact-marker refinement. Current-target merges, atomic proof transfer, retry refusal and the final SMTP fence match that scope. The inactive recipient-ledger patch was not treated as implemented.

**Unchanged lower-priority backlog:**

1. **P2 — Spec/UX:** Saved receipt plus unknown operation remains blocked from repair and Clear: [repair guard](packages/backend/src/core.ts:1772), [cleanup guard](packages/backend/src/core.ts:1811). Provide deliberate completion/cleanup while preserving the replay fence.
2. **P2 — Standards/qualification:** [Gmail cancellation fixtures](packages/backend/src/account-lifecycle.test.ts:282) intercept the obsolete `fetchFor` seam. Root should repair isolation before counting them as qualification. Two MIME failures reproduce on baseline; the two dispatch timeouts remain unattributed. Zero external-provider requests was not established for that earlier run.

The supplied logs support the targeted passing results, not full release qualification. Acceptance-to-first-local-commit crash exposure and full recipient recovery remain explicitly unresolved.

No tests, writes, delegation or external-provider calls performed. The excluded file and user untracked files were not accessed. Both P2 items remain backlog under the post-R2 high-only fix rule.