# W01 recipient evidence dependency

Phase-one evidence base: `f9a9ceac`. Branch: `t3/durable-smtp-recipient-outcomes`. The original evidence-only stop is retained below. The SAME series now implements only a compact proven-acceptance replay fence; full recipient evidence/discovery/rejected-only recovery remains open and no retry control is added. Code R1 was consumed by evidence review; final code R2 reviews the entire series.

The first proposed operation-target ledger is rejected. The concrete prerequisite is a bounded recipient-evidence admission/publication/retention/query seam independent of Sent-copy receipts, with a durable whole-send replay prohibition that survives detail retirement. `packages/db/src/repos.ts:listRecentOps` excludes old successful operations, `packages/backend/src/handlers.ts:ops.list` caps retrieval at100, and `packages/idb/src/schema.ts` loads operation history eagerly. Existing `send_copies` only covers appendToSent and has its own pruning/repair/forget lifecycle. The native critique identifies the remaining transactional, normalization and draft-admission requirements. No large archived receipt framework is adopted.

## Reproduce the RED evidence

Use a disposable checkout at f9a9ceac. The patch is pinned to that base and may not apply to the later marker implementation HEAD; do not rewrite it into an allegedly completed recipient ledger. The patch adds tests to the three actual module locations, with no production edit:

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

Final unchanged-source controls pass21/21 mail/store and16/16 real SMTP (122 other cases filtered). The final patch applies cleanly, scoped whitespace passes, and only documentation/patch artifacts differ from f9a9ceac. Actual native Sol/high read-only code review R1 exited0 over f9a9ceac...34e2c2cb: Standards no findings; Spec no findings within the authorized evidence-only stop. The reviewer checked the fixtures/oracles against source and recorded logs but did not rerun tests. Its final answer is retained at `/tmp/terno-w01-recipients/review-r1.md`, complete transcript `.log`. One plan critique and one code round are consumed; R2 is unused, with no R3. There are no outstanding evidence-review findings; the entire production recipient-storage/discovery/retry feature remains a dependency, not completed work. No touched production packages need a new typecheck/lint for this documentation/patch artifact handoff. No UI, new strings, schema, process timers, providers, real profiles or secrets are changed. No E2E, WEB, full suites, builds, packaging, performance gates, fetch/push, main/worklist changes or user untracked-file operations are performed. Root owns any later implementation and landing.


## Same-series compact marker continuation

The root selected a26-character `submissionAccepted:true` target discriminator, not the rejected address ledger. Existing complete/markUnknown result channels publish proof transactionally; accepted receipt cleanup transfers legacy proof before deletion. A private control-only point read and an SMTP pre-transport hook defend stale queued state after MIME preparation. Receipt-first → fresh operation proof reads avoid retirement races. No new schema, RPC/detail/history API, automatic resend or frontend presentation ships. New backend refusal copy is present in en/es. User markSent, warning text and pending copies do not manufacture proof. See the active refinement at the top of Plan65.

Executed commands and logs under `/tmp/terno-w01-recipients/`:

```sh
# Before the fix: 16 failed / 2 passed after correcting fixture-only mistakes.
pnpm exec vitest run --project unit packages/backend/src/send-submission-store.int.test.ts
# Before the fix: 9 failed; 138 other cases filtered.
pnpm exec vitest run --project unit packages/backend/src/imap.int.test.ts -t 'proven SMTP acceptance|rechecks proven acceptance'
# Production inverse: 3 behavioral failures, including actual IDB DATA2.
pnpm exec vitest run --project unit packages/backend/src/backend.test.ts packages/backend/src/send-submission-store.int.test.ts packages/backend/src/imap.int.test.ts -t 'real SMTP plus IDB|receipt retirement between proof reads|retains the synchronous'
# Final qualified targeted run: 152 passed.
pnpm exec vitest run --project unit packages/backend/src/backend.test.ts packages/backend/src/send-submission-store.int.test.ts packages/backend/src/sent-copy-store.int.test.ts packages/backend/src/smtp-auth-isolation.int.test.ts packages/mail/src/smtp-acceptance.test.ts packages/mail/src/compose-wire.test.ts packages/mail/src/outgoing-wire.test.ts packages/mail/src/smtp-starttls.test.ts
# 27 passed / 122 other cases filtered.
pnpm exec vitest run --project unit packages/backend/src/imap.int.test.ts -t 'sending through SMTP'
# 2 passed / 34 other cases filtered.
pnpm exec vitest run --project unit packages/backend/src/account-lifecycle.test.ts -t 'a send accepted after reconnect'
# 7 passed; no other perf file or global quiet window.
pnpm exec vitest run --project perf packages/mail/src/outgoing-preparation.perf.test.ts
pnpm --filter @terno/store --filter @terno/db --filter @terno/idb --filter @terno/mail --filter @terno/backend --filter @terno/i18n typecheck
pnpm exec oxlint --deny-warnings packages/store/src/send-submission.ts packages/store/src/send-copies.ts packages/store/src/index.ts packages/store/src/mail-store.ts packages/db/src/send-copies.ts packages/db/src/sql-store.ts packages/idb/src/send-copies.ts packages/idb/src/store.ts packages/mail/src/types.ts packages/mail/src/smtp.ts packages/mail/src/imap.ts packages/backend/src/core.ts packages/backend/src/backend.test.ts packages/backend/src/imap.int.test.ts packages/backend/src/send-submission-store.int.test.ts packages/i18n/src/locales/en.ts packages/i18n/src/locales/es.ts
git diff --check
```

Logs: `marker-store-red-corrected.log`, `marker-protocol-red.log`, `marker-inverse-red.log`, `marker-scoped-approved.log`, `marker-wire-green.log`, `marker-lifetime-approved.log`, `marker-perf.log`, `marker-types-final.log`, `marker-lint-final.log`. The first store RED attempt had a nonexistent queue return field and double-close cleanup; only its corrected run is qualified. The inverse uses `/tmp/terno-w01-recipients/marker-production.patch` to reverse only this series' owned production edits, then an EXIT trap restores them. It changes no other worker edits.

An initial broader targeted command also included the entire existing account-lifecycle file: `marker-scoped-final.log` records184 pass/4 fail. Four existing Gmail cancellation cases spy fetchFor while the managed route uses fetchGoogle. The two MIME cases also fail with production edits removed (`lifecycle-baseline-control.log`:2 fail/34 filtered). Two request-dispatch cases timed out and were not baseline-repeated. No repair or green claim is made for those fixtures. Provider-network isolation was not established for that attempt; only synthetic data/credentials were used, but zero external-provider requests cannot be asserted. Subsequent qualified witnesses are loopback/native temporary stores. The SMTP change does not alter Gmail request routing or the frontend workers' auth/connection paths.

Proof is submission acceptance, not delivery or a recipient result. Confirmed rollback with no surviving proof stays unknown after recovery; existing deliberate proof-absent retry policy is unchanged. Native IDB abort+backend fallback is covered with real SMTP and reopen. Hidden IDB request success leaves the adapter poisoned and reopening blocked by the uncertainty guard; no public accepted result is invented. The unavoidable acceptance→first successful commit window, full17-case recipient ledger/discovery/rejected-only retry, prior saved/unknown cleanup P2 and the stale managed-Gmail fixture qualification remain open.

Final native code R2 results follow after review; no R3 is permitted for this series.
