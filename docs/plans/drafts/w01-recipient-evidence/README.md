# W01 recipient evidence dependency

Base: `f9a9ceac`. Branch: `t3/durable-smtp-recipient-outcomes`. This is the evidence-only stop explicitly allowed by the worker brief. No recipient implementation is complete or approved, and no retry control is added.

The first proposed operation-target ledger is rejected. The concrete prerequisite is a bounded recipient-evidence admission/publication/retention/query seam independent of Sent-copy receipts, with a durable whole-send replay prohibition that survives detail retirement. `packages/db/src/repos.ts:listRecentOps` excludes old successful operations, `packages/backend/src/handlers.ts:ops.list` caps retrieval at100, and `packages/idb/src/schema.ts` loads operation history eagerly. Existing `send_copies` only covers appendToSent and has its own pruning/repair/forget lifecycle. The native critique identifies the remaining transactional, normalization and draft-admission requirements. No large archived receipt framework is adopted.

## Reproduce the RED evidence

Use this isolated checkout or a disposable checkout at the base. The patch adds tests to the three actual module locations, with no production edit:

```sh
git apply --check docs/plans/drafts/w01-recipient-evidence/regressions.patch
git apply docs/plans/drafts/w01-recipient-evidence/regressions.patch
pnpm exec vitest run --project unit packages/mail/src/smtp-recipients.test.ts packages/backend/src/sent-copy-store.int.test.ts
pnpm exec vitest run --project unit packages/backend/src/imap.int.test.ts -t 'durable recipient evidence'
git apply -R docs/plans/drafts/w01-recipient-evidence/regressions.patch
```

The intended assertions use a candidate result shape and optional fallback argument that do not exist in the current types. Vitest transpiles those test-only assertions; they are not a typechecked API proposal. Future implementation may adapt the vocabulary while preserving the independent wire/store oracles. Do not apply this intentionally RED patch to main or represent it as passing regression coverage.

Final executions, outside-worktree logs under `/tmp/terno-w01-recipients/`:

- `final-evidence-red.log`:35 cases,15 failed/20 passed. Eight SMTP result cases plus the post-DATA lost-final-reply case fail because the result/hook does not exist. Four SQL/IDB accepted-result reopen cases and two immutable-completion cases fail because complete/markUnknown discard recipient evidence. The20 existing Sent-copy cases pass. Native temporary SQLite and fake-indexeddb close/reopen are used; no SQL/IDB persistence rollback is injected.
- `final-protocol-red.log`:two failed/138 filtered, with no skipped/expected-failure definitions added. appendToSent=true reaches missing per-recipient evidence after restart while existing replay refusal holds. appendToSent=false proves no receipt and no APPEND, one real partial DATA (accepted `ana@example.com` and hidden `hidden@example.com`, rejected permanent `nadie@example.com` and temporary `luego@example.com`), local completion failure and reopen, then an explicit retry produces a second DATA. This is manual replay, not automatic replay. Capture arrays are actual smtp-server envelope/DATA observations, not provider invocation counters.
- Earlier `protocol-red.log` and `protocol-red-corrected.log` do not establish the false-setting path: account.update cannot change provider configuration, and changing persisted config alone leaves the cached provider alive. The final fixture uses dropAccount → setProviderConfig → signedIn; its no-APPEND witness is reached. These invalid earlier qualification attempts are retained separately.
- `plan-review.md`/`.log`:one actual native gpt-6.1-sol/high read-only critique, exit0, nine concerns. The committed critique is its unmodified final answer. No child agent was spawned.

Bounds proved by this evidence are the finite fixture sizes only. It does not qualify aggregate retention, new storage quotas, native rollback/commit-after-ack/IDB uncertainty, mailbox scale/performance, UI persistence/accessibility, real providers, or delivery. The candidate result vocabulary distinguishes submission acceptance from delivery and treats malformed/post-DATA results conservatively; it has no production implementation. Exact rejected-only retry and the prior accepted/saved unknown-operation cleanup P2 remain unimplemented and separate.

## Unchanged-source controls and review

After preserving the patch, all three source/test paths are restored byte-for-byte to HEAD. Scoped existing controls:

```sh
pnpm exec vitest run --project unit packages/mail/src/smtp-acceptance.test.ts packages/backend/src/sent-copy-store.int.test.ts
pnpm exec vitest run --project unit packages/backend/src/imap.int.test.ts -t 'sending through SMTP'
git diff --check
git apply --check docs/plans/drafts/w01-recipient-evidence/regressions.patch
```

Final counts and native code-review disposition are recorded after execution. No touched production packages need a new typecheck/lint for this documentation/patch artifact handoff. No UI, new strings, schema, process timers, providers, real profiles or secrets are changed. No E2E, WEB, full suites, builds, packaging, performance gates, fetch/push, main/worklist changes or user untracked-file operations are performed. Root owns any later implementation and landing.
