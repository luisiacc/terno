# W03 B13: omitted Gmail outcomes

Base: `bef6418ecb8c5c97777eb516b793c9bbce7a9dd3` (actual clean HEAD).

## Request (verbatim)

> Own mail-only Gmail outcome handling for W03 B13: 'An omitted batch result is not evidence of deletion; extend actual Gmail/local batch outcome controls before advancing recovery.'
> Seek a coherent completed B13 disposition this slice: real defect minimalmailfix or existing protection/N-A with precise executable evidence and source witnesses, not another broad sync redesign.

## Existing behavior and design

The report's B13 is external source B's multipart batch omission repair. Terno has no multipart read batch endpoint or missing-subresponse representation: `fetchFull` schedules individual `/messages/{id}?format=raw` GETs; refresh and incremental labels use individual minimal GETs. `/messages/batchModify` is a mutation with void response, unrelated to read recovery. Do not introduce a batch service or ledger.

Plan26 resource-scoped 404 and checkpoint semantics and Plan33 awaited ingest apply. `readMessage` rejects foreign/missing IDs and incomplete raw; `fetchFull` returns a set containing only explicit GET404s. Full enumeration does not remove cached mail omitted from a list: refresh checks known IDs separately. Page progress follows awaited message work. Incremental history deduplicates IDs across pages and saves only after effects. These are source witnesses, not new defect claims.

Add dedicated mail qualification through actual `createNetworkPolicy.fetchGoogle` native Request construction with injected synthetic fetch. Script a minimal request policy (no durable cooldown claim), reject the fallback ctx.fetch, reject unexpected URLs and replace global fetch with a throwing external-call sentinel. Test omitted/mismatched successful GETs, transient/permission failures versus confirmed404, list omission with known mail, duplicate/reordered history and replay, terminal empty list page, durable sink refusal and resumed page. Observe exact cached bytes/identity/flags, removals and phase/cursor writes. Use in-memory synthetic store/sink, honestly not SQL/IDB crash durability.

## Tests and negative controls

Existing-protection qualification may be GREEN immediately; no product RED claimed. Execute oracle negative controls by temporarily mutating only owned gmail-api.ts, run selected new cases and restore exact source: accept missing/foreign IDs, swallow raw failure as absence, delete cached IDs on list omission or promote progress prematurely as applicable. Keep ordinary failed-test evidence. Run the new file plus direct Gmail response/batch callers, mail typecheck and exact-file lint with inherited NODE_OPTIONS plus `/tmp/terno-network-guard.cjs`.

## Performance and out of scope

Tests/docs only unless a genuine mail defect is demonstrated. No hot-path or perf-budget changes. No full suites, app/package builds, UI, editor, IMAP, backend production, stores, shared contracts, worklist edits or release milestone changes. Root owns reconciliation/landing. External multipart architecture N/A; recommend already protected for qualified supported behavior only after tests/review. Do not claim all34done.

## Revisions after the Codex review

One native Sol/high read-only plan critique exited0, with six points (full transcript `/tmp/terno-w03-b13/plan-review.log`). Accepted provenance, pending attachment recovery, phase-specific cursors, mixed batches and correctly ordered page watermarks. Added supported controls without a multipart service. Cursor-write refusal/reopen is not newly qualified here: the in-memory sink does not establish durable-store atomicity or crash behavior; Plan26's separate checkpoint/ownership qualification remains the witness, outside this mail-only change.

The provenance control demonstrated a genuine defect before production changes: identity proof `/profile`404 during raw capture resolved successfully instead of rejecting, allowing cached removal. Preserve error resource path in the private GmailApiError; only matching raw/minimal endpoint404 may mark absence, matching history404 may reset history, and matching list400/404 may invalidate its continuation. Profile/token errors must propagate without those resource effects. No changes to external error text, stores or checkpoints.

Initial test fixture failures were expected-body newline and an incorrectly configured synthetic snapshot case; these are harness corrections, not product REDs. The corrected test covers refresh instead. Existing-protection cases were immediate GREEN. Ordinary baseline re-execution of the new profile404 controls supplies genuine fail-first evidence for the fix. Tests use a scripted Google proof/request policy around actual fetchGoogle/native Request, not the durable savedGoogleRequests identity-binding implementation. This explicitly qualifies propagation through the transport boundary, not all saved-account policy lifecycle behavior.

## Validation before code review

`/tmp/terno-w03-b13` retains commands, complete logs, exit records and captured PID/birth/argv. All supervised commands finish naturally and are joined; no signal used. Initial pnpm invocation auto-installed this prepared checkout's missing dependencies (including the existing postinstall), then ran only the selected test; it was joined through its exec session but did not capture a separate PID identity. No app/Vite/package production build was requested.

- Genuine RED: `vitest run --project unit packages/mail/src/gmail-outcomes.test.ts -t profile404` against actual base mail source: five failed, one passed; then fixed source passes all24cases.
- Existing-protection negative controls: temporarily accepting foreign minimal IDs and swallowing raw503 as absence each produce an ordinary selected-test failure. Exact source restored in finally; no mutation remains.
- `pnpm exec vitest run --project unit` with exact paths `gmail-outcomes.test.ts`, `gmail-response.test.ts`, `gmail-batches.test.ts`, `gmail-net.test.ts`, `gmail-flag-snapshots.test.ts`, `gmail-history-expansion.test.ts`: 163 passed.
- `pnpm --filter @terno/mail typecheck`, `pnpm exec oxlint --deny-warnings packages/mail/src/gmail-api.ts packages/mail/src/gmail-outcomes.test.ts`: exit0.
- One affected perf file only: `pnpm exec vitest run --project perf packages/mail/src/gmail-control.perf.test.ts`: four passed, existing budgets unchanged.

Every test/type/lint/perf invocation appends inherited NODE_OPTIONS with `--require=/tmp/terno-network-guard.cjs`. No full suite/release clearance follows. All historical release REDs and other owners' files remain untouched.
