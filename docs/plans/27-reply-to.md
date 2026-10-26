# Plan 27: Reply-To retention and reply recipients

Status: investigation / implementation on main. Report items T10, A18 (addressing subset), B45.

## Request (verbatim)

The original user request is reproduced verbatim in [plan 26, Request](26-provider-reliability.md#request-verbatim). This plan implements its investigate → specify → reproduce → fix → atomic commits → distinct Codex review sequence for T10/A18/B45. Parent integration owns the final independent Codex review and report ledger.

Task assignment (verbatim):

> Implement T10 / A18 / B45 Reply-To support on current main checkout /Users/Luis/projects/emailclient, no branch/worktree.

## Investigation

The report's T10 scenario is a helpdesk message whose From is a no-reply address and whose Reply-To is the operational session address. B45 extends it to multiple destinations and quoted names containing commas. PostalMime already parses structured replyTo, but ParsedMessage discards it. Gmail maps ParsedMessage without Reply-To. IMAP already fetches a parsed envelope but drops envelope.replyTo. IncomingMessage, SQL and IDB rows and MessageDetail omit the addresses. The composer consequently selects From. Existing `answered()` chooses the last received message, otherwise the last sent message; retain that conversation behavior. Own sent continuations use original To, never the sent message's Reply-To or Bcc.

Read plans 04 (shared store seam and bounded migration/load), 16 (inline compose, draft conversion and actual MIME delivery), 25 (existing identity and authorization boundaries), 26 and report T10/A18/B45.

## Design and public seams

- Retain structured `replyTo: Address[]` in parsed MIME, incoming messages and thread detail. Incoming field is optional for old synthetic/providers and old backups; persistence defaults absent data to `[]`.
- SQL v15 adds `reply_to_json TEXT NOT NULL DEFAULT '[]'`. New ingestion stores it; refresh ingestion updates it only when supplied, preserving old metadata during partial updates. IDB mirrors logical schema 15 with physical version 5 and fallback decoding of existing message rows; no all-mail rewrite in its upgrade transaction. Thread detail and debug exports retain arrays. Store reopen/migration retains metadata; app.export/import excludes cached mail and must retain the resulting draft recipients.
- Gmail's owned-by-parent incoming mapper needs exactly `replyTo: p.replyTo` adjacent to `from: p.from`; MIME parser supplies the list. IMAP maps `envelope.replyTo` using its existing structured address conversion.
- Received reply To uses all Reply-To when nonempty, otherwise From. Deduplicate case-insensitively across To/Cc in first-seen order. Reply-all adds original To/Cc except current account; never copy original Bcc. Own sent continuation starts from original To, including note-to-self, and adds original Cc on reply-all. No unsupported aliases or From identity inference; W09 remains separate.
- Preserve names and parsed list boundaries through format/parse and queued send. Do not add new strings, UI controls, dependencies, timers or network work.

## Tests and red/green sequence

Authorized public seams: parseRaw; real IMAP/Gmail sync against synthetic mail servers; MailStore.sync.ingest / threads.get / compose.queueSend / backup; compose replyFields / convertFields; browser recipient chips through send into a captured SMTP envelope. One seam/slice is reproduced before its implementation.

Cover From/Reply-To mismatch; two Reply-To addresses with quoted commas and duplicates in To/Cc; empty fallback; case-insensitive own exclusion and dedupe; sent-only continuation and note-to-self; original Bcc excluded; no regression to last-received selection; both stores update/reopen/legacy migration/backup; actual queued envelope matches UI. Gmail integration test and one-line mapping coordinated with parent because those files are concurrently owned.

## Performance and privacy

Only existing per-message ingest and thread point lookup paths change. No search/list projection or index changes, parsing in entry chunks, mailbox scan, idle timer or extra requests. IDB defaults only at read boundaries, preserving exact persisted/memory row verification. SQL migration is an additive default column. Test data and screenshots are synthetic, temporary profiles only. Run targeted suites, typecheck, lint, required e2e/web and light/dark screenshot inspection; parent may aggregate whole-repo/performance release gates while concurrent work continues.

## Out of scope

Aliases/signatures and selecting unsupported sending identities (W09), native provider draft APIs, general address-parser replacement and historical data re-fetch are separate work. Existing mail missing Reply-To cannot recover the original header without a later provider refresh. Parent performs final distinct Codex subagent code review after integration; do not substitute self-review.

## Revisions after the Codex review

The read-only `codex exec -s read-only -C /Users/Luis/projects/emailclient -` critique returned seven amendments (artifact `/tmp/terno-plan27-critique.txt`). Accepted all:

1. Backup excludes cached mail: test draft recipients through existing app.export/import, preserving format 2.
2. IDB defaults at decoding boundaries only, so legacy rows still pass debug.verify; no load-only normalization or mailbox rewrite.
3. Received Reply-To excludes the account case-insensitively, including all-self lists (empty To; no unintended From fallback); sent note-to-self retains original To.
4. Omitted Reply-To preserves stored data, explicit [] clears, and supplied lists replace; verify after reopen and flag refresh.
5. Known-message provider refresh normally updates flags only; historical metadata requires actual full reingestion. No automatic refetch in this slice.
6. Parent-owned Gmail tests must inspect captured send MIME from desktop/portable builders as well as incoming mapping. This is coordinated, not a reason to edit concurrent Gmail files.
7. Conversion covers manual To/Cc/Bcc alongside multiple automatic addresses, forward conversion, and draft save/reopen/export/import retention.


## Implementation and validation log

MIME red: `pnpm exec vitest run --project unit packages/mail/src/mime.test.ts` failed because `replyTo` was missing (1 failed / 1 passed). Green: 2 passed after preserving PostalMime's structured list.

Store red: `pnpm exec vitest run --project unit packages/db/src/store.conformance.test.ts packages/idb/src/idb.conformance.test.ts -t 'reply destinations'` failed all 6 cases (SQL and IDB scan/instant) because thread detail omitted the list. Green: same 6 passed after model, SQL v15, IDB v5/logical15 and decode/refresh changes. SQL migration and IDB storage suites: 36 passed, including legacy defaults, real v4 IDB upgrade and exact persisted/memory verification across reopen. Search schema remains 7.

IMAP red: the synthetic real ImapKit sync case returned `replyTo: []` instead of both addresses with the quoted comma. Green: it passes after envelope mapping; full body download and repeated known-message sync retain the list. No extra fetch.

Composer red: 6 new unit cases failed (From selected, duplicates retained, wrong conversion). Green: 15 tests pass after recipient selection/deduplication; no strings changed. Draft lifecycle coverage on SQL and IDB passes 4 cases for reply/reply-all, save/reopen, format-2 backup restore, auto markers, exact queued envelope and explicit-vs-original Bcc. Source mailbox content is intentionally absent from app.export.

Plan critique completed, final distinct Codex code review remains parent-owned. Broader targeted suites and UI verification in progress.


### Composer and UI validation

`E2E_PORT=55984 pnpm --filter @terno/web exec playwright test reply-to.spec.ts --project=e2e --project=e2e-lumen --project=e2e-atelier --workers=1`: **12 passed** (reply/reply-all × light/dark × macOS/Lumen/Atelier). Assertions compare the visible To/Cc fields, persisted send payload, delivered MIME headers and real SMTP envelope; original Bcc is absent. Screenshots were captured and inspected in all six design/theme combinations: recipients fit, quoted comma names remain intact, and Cc is visible. Retained copies: `/tmp/terno-reply-visual/`.

Typecheck and lint passed. The ten-file targeted unit run finished with **598 passed, 2 skipped, 1 failed**: pre-existing exact-scan IndexedDB search `-factura` exceeded 20 s; an initial focused rerun also timed out. No search query or index code changes in this slice. Further isolation is in progress; this is not claimed as a clean full unit gate. The SQLite-WASM equivalents (ingest, migrations and shared conformance) passed all **175 tests**.

Initial e2e harness errors were corrected: backend theme changes require reload (matching existing tests), and `ops.recent` intentionally omits completed operations older than the real clock while e2e backend time is fixed. The final test uses the public debug snapshot plus `ops.get` and passes. These were test setup failures, not production fixes.


Full web gate: `WEB_PORT=61709 pnpm test:web` **31 passed**, including complete shared store conformance on both native browser engines (IndexedDB and SQLite-WASM/OPFS), migrations, backup/import and worker lifecycle. Existing compose/send regression suite: `E2E_PORT=55984 pnpm --filter @terno/web exec playwright test compose.spec.ts composer-send.spec.ts --project=e2e --workers=1` **22 passed**. Portable/localized MIME builder suites **7 passed**. Final typecheck passed again after integration edits. Owned-file lint passes; whole-repo lint currently sees unused declarations in concurrent parent-owned Gmail auth work.

The isolated fake-IndexedDB `-factura` diagnostic passes with a 90-second command-line timeout (suite 25.71 s including seed); the repository's default 20-second case still timed out. The timeout was not changed or hidden. Native IndexedDB browser conformance passes at its normal limits.

Implementation commits (shared lock, explicit files only): `56e6725d6e02b6ae914f8a73e5fbe9d091133873..185cb940a760d4ce85563fdd8013ef48a1a0da14` (model/ingest/persistence) and `ee84ebfa9c6d3829276136d619405a2819a2db8f..3f83a8ae661fe54bf667da6be67aa3361ffc1cbf` (composer/lifecycle/e2e). Exact owned paths and base/head manifest: `/tmp/terno-reply-owned-files.txt`, `/tmp/terno-reply-commit-pairs.jsonl`. Parent has applied the separate Gmail mapping; parent owns its regressions and final distinct Codex review.


Full UI performance attempt: `E2E_PORT=55984 pnpm test:ui-perf` stopped after **12 passed, 1 failed, 43 not run** because serial Lumen compact sustained-j navigation recorded a 99.9 ms longest frame against 50 ms. All nine autocomplete performance cases (including 5/10 MB drafts, heap stability, recipient painting and regression canaries) passed. The gate is not claimed green; no thresholds changed. A focused navigation/reply-opening rerun follows.


Focused UI performance rerun: `E2E_PORT=55984 pnpm --filter @terno/web exec playwright test perf.spec.ts --project=perf --no-deps --grep 'sustained j at key-repeat rate \(lumen, compact\)|inline reply:'` **2 passed**. Lumen compact navigation max frame 33.3 ms, p95 16.8 ms, 300 moves and 2.96 row renders/move. Inline reply's first frame p95 12.6 ms, max 28.6 ms (limit 50); expansion p95 116.3 ms (limit 133). The earlier full-run navigation spike remains recorded; the 43 unrun cases are not claimed as executed. Parent's separate Gmail integration commit is `24bf111` (read-only confirmation; no parent files staged here).


### Handoff

Per parent steering, optional broader tests do not delay this owned slice's handoff. The paired ingestion benchmark was started but intentionally terminated by its captured process tree before completion; **no ingestion performance result is claimed**. Whole-repo lint passes at handoff (`pnpm lint`); previous temporary Gmail auth warnings are resolved by the parent. Final typecheck passed; all targeted functional results and the two default-gate failures above remain recorded honestly. Remaining series gates (full unit/e2e/performance and packaged desktop verification as applicable) and the distinct final T10 Codex code review are parent-owned. No push, new branch, worktree, real secrets/profile access, new strings, background work or extra provider requests.
