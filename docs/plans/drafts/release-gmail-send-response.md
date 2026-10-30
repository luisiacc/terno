# Release Gmail send-response regression

Request (verbatim): “Fix the remaining first-milestone oversized successful Gmail send-response regression in your T3-created isolated worktree from currentmain8c435ece.” “Repair the actual cause, preserving exactly one submission and no replay, real bounded response consumption and ambiguous accepted-send handling.”

Scope: gmail-transport.test.ts, direct fixture helpers, and Gmail API decoder only if reproduced. Plans26/65/62 retain their acceptance, no-replay and admission contracts. User Plans64–68 and worklists remain read-only. No backend/store/renderer changes, children, pushes, builds or full gates.

Baseline: 8c435ece. Original ordinary guarded unit test is RED: oversized successful send expects ambiguous:true but receives false. The fixture uses empty payload and a synthetic one-byte raw builder; first prove actual fetch and bounded reader entry independently of classification before interpreting the error.

Design: add dispatch and reader-entry assertions, prepare a complete synthetic SendPayload through the public portable MIME builder, inspect exact Gmail JSON envelope/decoded MIME, stream real oversized bytes in bounded chunks and assert cancellation/lock release. Include accepted unreadable body, ordinary success, invalid pre-dispatch input and definitive provider rejection controls. If post-dispatch oversized handling is proven defective, narrow the decoder classification so accepted sends retain uncertainty without altering read limits or unrelated read errors. No permissive network/identity bypass.

Validation: append --require=/tmp/terno-network-guard.cjs to existing NODE_OPTIONS on every test launch. Run changed module and necessary direct callers; mail types and strict owned lint. Preserve backend accepted-after-write-failure fence through existing explicit direct-caller tests, read no broad backend globs. If production hot path changes, run only affected perf. Record exact RED/GREEN and one completed read-only native Codex Standards+Spec review, fix findings fail-first, then only high correctness/data-loss after cap; lower findings remain backlog.

Out of scope: Gmail/People/auth architecture, durable stores, general release clearance, UI/copy, full suite/e2e/package builds. Root owns serial rebase/retest/landing/cleanup.

## Revisions after the Codex review

The native read-only plan critique completed exit0 with seven points (/tmp/terno-gmail-response/plan-critique.log), all accepted. Phase guards on the ORIGINAL fixture pass one fetch and one getReader before failing ambiguity; stale input is ruled out. A complete buildRawPortable payload independently reproduces the same defect with actual chunk/cancellation/lock assertions. Exclude sending from the message-read overflow catch; preserve history/incoming/read behavior. Add message-list overflow and400/403/429/503 controls. Unreadable2xx means uncertain, not proven acceptance or invented IDs. Exact POST/envelope and decoded MIME assertions exercise the small string wire path; Blob is unchanged. The code-review cap is exactly ONE completed native read-only Standards+Spec review. Direct callers are backend.test.ts accepted completion/recovery cases and gmail.int.test.ts truncated accepted-response case; no backend source expansion is needed. The decoder catch is a cold failure path; no performance hot path changes.

## RED evidence

At8c435ece, guarded original command `pnpm exec vitest run --project unit packages/mail/src/gmail-transport.test.ts -t 'an oversized successful send response'` fails ambiguous false versus true (/tmp/terno-gmail-response-red.log). Guarded instrumented rerun passes fetch=1 and getReader=1, then fails the same classification (/tmp/terno-gmail-response/phase-red.log). Full valid public preparation run before production change has2 failures and24 passes, both oversized sends fail only ambiguity after exact request,9 pulls/73,728 bytes,65,536-byte cancellation and unlocked-body guards pass (/tmp/terno-gmail-response/valid-preparation-red.log). All commands append the required guard to existing NODE_OPTIONS. The cause is responseMode=json plus path.startsWith('/messages') catching send overflow before sending uncertainty.

## Implementation and validation

Production change is a single !sending predicate on the generic message-read overflow branch. Successful send overflow now reaches the existing uncertain-send handling, with the same bounded reader/limit/deadline and no replay. No acceptance proof is invented. All non-send failure branches remain intact.

Commands (each test prefixed with `NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=/tmp/terno-network-guard.cjs"`):

- `pnpm exec vitest run --project unit packages/mail/src/gmail-transport.test.ts packages/mail/src/gmail-response.test.ts packages/mail/src/gmail-net.test.ts packages/mail/src/gmail-history-bounds.test.ts packages/mail/src/outgoing-wire.test.ts`
- `pnpm exec vitest run --project unit packages/backend/src/backend.test.ts -t 'an accepted send|repeated recovery write failures|a proven accepted send'`:6 pass,39 filtered, backend-fence.log.
- `pnpm exec vitest run --project unit packages/backend/src/gmail.int.test.ts -t 'an accepted send whose response is cut off'`:1 pass,42 filtered, gmail-caller.log; real synthetic loopback Google, temporary SQL, unchanged identity path.
- `pnpm --filter @terno/mail typecheck`; `pnpm exec oxlint --deny-warnings packages/mail/src/gmail-api.ts packages/mail/src/gmail-transport.test.ts`; `git diff --check`.

Initial expanded run:152 pass,1 failed because the new list-read control incorrectly expected no cursor writes. Full sync correctly records its reconciliation obligation before listing. Corrected oracle requires exactly that initial enumerate/pages0 write, no completed checkpoint or effects. Initial mail types caught an untyped fixture URL; now explicitly typed. Both attempts retained, not counted as passes. Scoped final results below supersede them. No production hot path changed (only failure classification); no perf run warranted. No full suite/UI/e2e/package builds or release clearance claimed.

Final pre-review results:153/153 across five named mail/wire files pass (green-module-final.log),7/7 selected backend caller cases pass across two named files, mail typecheck/types-final.log and strict owned lint/whitespace exit0. All evidence under /tmp/terno-gmail-response plus original /tmp/terno-gmail-response-red.log. Code review pending.

## Sole code review and final disposition

Exactly one native `codex exec -s read-only -C <this-worktree> -` Standards+Spec code review completed naturally with exit0 against8c435ece (code-review.log). Standards: zero substantive findings. Spec: zero substantive findings. It confirmed the !sending predicate preserves bounded reading/non-send behavior, the independent dispatch/reader/consumption oracles and uncertainty without invented IDs or acceptance proof. No finding-driven fixes or new backlog entries; no second review. Reviewer did not run tests or delegate or read the prohibited backend file. The separate plan critique also completed naturally exit0. No process signals were used.

Final change ownership: this draft plan, gmail-api.ts and gmail-transport.test.ts only. Existing worklist/heldR2 backlogs unchanged. Source checks are finite scoped evidence, not general release clearance. Identity/auth architecture and Blob preparation remain unchanged; decoder tests use the public low-level injected-fetch seam, while the unchanged real-backend truncated-response test qualifies the managed identity path. No broader interface dependency or expansion was necessary. Root retains serial rebase/retests/FF/cleanup ownership.
