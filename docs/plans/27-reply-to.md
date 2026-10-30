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

Per parent steering, optional broader tests do not delay this owned slice's handoff. The paired ingestion benchmark completed immediately before the cancellation attempt: `pnpm exec vitest run --project perf packages/db/src/ingest.perf.test.ts` **1 passed** in 45.87 s. The final process result is exit 0; its completed log supersedes the initial cancellation note. Whole-repo lint passes at handoff (`pnpm lint`); previous temporary Gmail auth warnings are resolved by the parent. Final typecheck passed; all targeted functional results and the two default-gate failures above remain recorded honestly. Remaining series gates (full unit/e2e/performance and packaged desktop verification as applicable) and the distinct final T10 Codex code review are parent-owned. No push, new branch, worktree, real secrets/profile access, new strings, background work or extra provider requests.


## W09: own-message recipient identity qualification (2026-10-29)

Request (verbatim excerpt): “Select ONE coherent existing-supported recipient/self/list/linkage slice; do not invent send-as/provider capabilities or arbitrary identity UI.” “Tests-only already-protected is fine, no fabricated product RED.”

Base: `430f406b`, isolated branch `t3/reply-recipient-identity`. This slice qualifies Plan 34 §3.4's existing own-message behavior for A18/S35 and the local reply linkage subset of S37. `identitiesIn` recognizes configured account addresses and sent From addresses; `answered` chooses the last received non-self message, falling back to the latest own message. `replyFields` shares that source for recipients, quote and numeric reply/forward source. Account selection is accountId; Account and compose RPC expose no authorized send-as catalog or selected alias field. An inferred identity is an exclusion rule, never permission to send from it.

### Short spec

- Independently qualify reply and reply-all for all-own threads (including an alias copy not marked sent), sent note-to-self, and a received message followed by own alias copies. Subject text does not decide identity or recipients.
- Own continuation uses the selected source's original To; reply-all adds its Cc, with existing case-insensitive identity exclusion/deduplication. Ignore its Reply-To and original Bcc. Keep the existing Plan 27 received Reply-To list tests unchanged.
- Forward starts with empty automatic To/Cc/Bcc and forward source only. Its manually entered recipient must be the sole queued/delivered destination.
- Dedicated helper tests assert recipient arrays, auto markers, quote source and reply/forward source IDs. A dev-only browser matrix (reply/reply-all/forward × light/dark) asserts chips against the exact durable send payload and captured real SMTP envelope, and valid replies' RFC linkage. Use temporary synthetic accounts/mail only. Personally inspect screenshots.
- Tests-first qualification: run new assertions on unchanged product code. If protected, report GREEN without inventing a RED. Change helpers only for a demonstrated gap. No UI/string changes are planned.

### Scope and limits

Only dedicated reply helper tests, relevant dev e2e/config/setup, and this plan are expected to change. Dev config is standalone, without production globalSetup/build. Run changed-module/direct-caller tests, web types and touched-file lint; no full gates/builds. No hot production file changes means no additional performance suite. Native Codex plan critique precedes implementation; Standards/Spec native code review has at most two code rounds.

B29 authorized alias selection/signature replacement and S42 permission revocation remain unqualified: there is no send-as capability API. This slice does not add one or claim provider authorization from historical From. S37 deliberate subject changes/provider-native threading, List-Post and Mail-Followup-To remain outside this own-message slice. Backend/store/provider/MIME paths are read-only dependencies, not edit targets.

### W09 revisions after the Codex plan critique

Native command: `codex exec -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-80bd0e1c -m gpt-6.1-sol -c model_reasoning_effort='"high"' - < /tmp/terno-w09/plan-prompt.txt` (exit 0; `/tmp/terno-w09/plan-review.log`). Nine qualification points, no demonstrated product defect. Accepted all:

1. Dedicated temporary demo template setup supplies `TEMPLATE_ENV`, closes its backend and removes its own directory; no inherited build setup.
2. Standalone config launches `VITE_TARGET=desktop VITE_RENDER_PROBE=1 pnpm --config.verify-deps-before-run=false vite --mode development --port 55010 --strictPort --host 127.0.0.1`, matching baseURL. Execute with `E2E_PORT=55010`.
3. Own To filters self; all-self retains the first original To, empty To falls back to From. Qualify each exception independently.
4. Alias copies have an earlier sent-From witness. Add a no-witness negative control. Neither establishes authorization to send as that alias.
5. Distinct candidate IDs/recipients/body sentinels make latest received versus latest own source independently observable.
6. Browser fixture has valid distinct RFC Message-IDs and References; assert exact queued and transmitted reply headers, absent for forward.
7. MessageDetail has no Bcc. Real original Bcc privacy is checked from IncomingMessage ingest through empty composer Bcc, queue, MIME and SMTP rather than claiming the helper-only assertion proves storage behavior.
8. Literal expected recipients per mode are checked independently against chips, queue and SMTP. Exact field equality, not just matching systems to one another.
9. Tests-only GREEN is valid existing protection; any demonstrated production fix would require actual fail-first evidence and revised focused validation.

### W09 implementation and qualification evidence

Tests-only: product helpers, providers, stores, UI and strings are unchanged. New `reply-identity.test.ts` has 14 cases separating own continuation, known-alias received-source selection, no-witness alias control, three self-address fallbacks, and forward source/empty recipients. The browser matrix adds six reply/reply-all/forward × light/dark cases, independently comparing literal expected recipients with chips, durable queue, parsed MIME and real SMTP envelope. Original Bcc enters via synthetic ingestion and stays absent from all outgoing destinations. Reply headers exactly reference the latest own copy and its ancestor; forward has no reply headers.

Actual first helper run: **14/14 GREEN on unchanged product code** (`/tmp/terno-w09/unit-first.log`). No product RED or production fix is claimed. First browser run had a harness timeout: `recipientEmails` waited for the deliberately hidden Cc field in reply mode. Open that control before reading it; corrected matrix **6/6 passed**. This is test setup evidence, not a fabricated product regression. Screenshot timing then waits for Send enabled and scrolls it into view; final matrix **6/6 passed** (`e2e-final.log`). Development Vite reported `ResizeObserver loop completed with undelivered notifications` in some cases; assertions passed, and no production change suppresses that diagnostic.

Exact focused commands (run from this worktree):

- `pnpm exec vitest run --project unit apps/web/src/lib/reply-identity.test.ts` — 14 passed.
- `pnpm exec vitest run --project unit apps/web/src/lib/reply-identity.test.ts apps/web/src/lib/compose-fields.test.ts apps/web/src/lib/reply-all.test.ts apps/web/src/lib/reply-to.test.ts apps/web/src/lib/compose-conversion.test.ts` — 61 passed; `/tmp/terno-w09/unit-targeted.log`.
- `E2E_PORT=55010 pnpm --filter @terno/web exec playwright test -c playwright.reply-identity.config.ts reply-identity.spec.ts` — 6 passed, final `/tmp/terno-w09/e2e-final.log`.
- `E2E_PORT=55010 pnpm --filter @terno/web exec playwright test -c playwright.reply-identity.config.ts reply-to.spec.ts` — existing T10/B45 list/chip cases 4 passed, unchanged; `/tmp/terno-w09/e2e-reply-to.log`.
- `pnpm --filter @terno/web typecheck` — passed; `/tmp/terno-w09/typecheck.log`.
- `pnpm exec oxlint --deny-warnings apps/web/src/lib/reply-identity.test.ts apps/web/e2e/reply-identity.spec.ts apps/web/e2e/reply-identity.setup.ts apps/web/playwright.reply-identity.config.ts` — passed; `/tmp/terno-w09/lint.log`.
- `git diff --check` — passed.

Personally inspected all six screenshots in light/dark (macOS design): recipient rows fit, quoted comma name is one chip, empty Bcc is visible, and quote source agrees. Artifacts retained under `/tmp/terno-w09/screenshots/`. No product UI changed; no new copy, network requests, timers or hot-path work. Per assignment, no full gates, production app/Vite build, native-provider auth, performance, packaged smoke or distribution was run. `WEB_PORT=55020/55021` was reserved but unused; browser matrix uses the desktop development renderer and synthetic local SMTP. Native code review follows before handoff.

### W09 native code review and handoff

R1 command: `codex exec -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-80bd0e1c -m gpt-6.1-sol -c model_reasoning_effort='"high"' - < /tmp/terno-w09/code-r1-prompt.txt > /tmp/terno-w09/code-r1.log 2>&1` — **exit 0**. Reviewed `430f406b..dd76c1a2`, changed files plus explicit permitted direct context, with **Standards: no actionable findings; Spec: no actionable findings**. No review fixes or fail-first regressions were needed. The reviewer performed no edits, tests/builds or delegation. **One code round used; R2 unused; no R3.** Plan critique was a separate earlier step, not a code review round.

No known failing assertions remain. Limits/backlog: B29 authorized destination alias/selected From/signature and S42 revocation require an actual provider-authorized send-as capability model; inferred sent From identities do not grant send permission. S37 deliberate changed-subject context/provider-native linkage, List-Post/Mail-Followup-To and broader mailbox/provider/browser-engine matrices remain unqualified. The six screenshots retain existing UI (the forward's file-preparation status can still be visible while Send is enabled); no changed UI behavior is claimed. Development ResizeObserver diagnostics remain recorded above. No lower-severity R1/R2 findings were deferred because none were returned.

Implementation commits: `37787fc5` (reviewed spec), `dd76c1a2` (tests/config/setup and evidence). This final documentation commit records the completed review. Worktree `/Users/Luis/.t3/worktrees/emailclient/t3-80bd0e1c`, branch `t3/reply-recipient-identity`; clean committed handoff for parent serial integration. No fetch, push, reset, main landing, worklist or out-of-ownership production edits.

## W09 S37: reply subject and context (2026-10-29)

Request: “a valid provider reply maintains conversation linkage; a deliberate subject change starts the intended new context.” Scope is renderer compose/reply helpers and focused tests; provider, store and backend implementations remain outside ownership.

The inline draft retains source ID and `subjectEdited` independently. Send currently submits that ID even when the subject changes. Mode conversion retains authored subject/body and typed recipients, while replacing automatic recipients, quote and source. Forward has its own source and no reply ID. MIME builders consume immutable send payload `inReplyTo`, `references`, and `providerThreadId`; omission of the reply ID must be verified against the real queue and SMTP, not inferred from a renderer mock.

Proposed policy: compare the send subject with the source conversation subject after trimming surrounding whitespace and repeatedly removing case-insensitive `Re:` prefixes and adjacent whitespace; preserve all other characters and case. An unchanged or Re-normalized reply/reply-all keeps the reply source; a genuinely changed subject sends without reply linkage. Do not clear the draft's source, quote, recipients, authored content or focus while editing; restoring the original subject restores linkage. Forward remains a forward regardless of subject and carries no reply headers. Use actual source context, not `subjectEdited`, which also records edits later undone. Missing source must never silently sever linkage. Test a real synthetic source through selector, editing, durable queue and captured SMTP; distinguish setup failure from a real RED. No new UI, strings, provider drafts, aliases or generic conversation architecture.

Before implementation, verify whether the renderer can obtain a stable source subject at send without compromising existing source/recovery fences and whether the backend honors omission with a persisted reply draft. If either cannot be guaranteed within ownership, retain evidence and request scope expansion. Run only targeted tests, web types and touched-file lint; no build or full suites.

### Revisions after the Codex plan critique

Native `codex exec -s read-only -C /Users/Luis/.t3/worktrees/emailclient/t3-ebbca201 -m gpt-6.1-sol -c 'model_reasoning_effort="high"' - < /tmp/terno-w09-s37/plan-prompt.txt` completed exit 0, eight points and DONE (`/tmp/terno-w09-s37/plan-review.log`). The generated baseline is the thread subject, not necessarily the selected message subject. Follow the exact reply source instead of re-running `answered`, preserve draft revision/generation and active-mode semantics, compare only the specified Re normalization, and test change/restore, forward, delayed lookup, focus and source failures. Queue omission uses only the supplied reply ID; SMTP is RFC evidence, not proof of Gmail threading. A source can disappear after renderer lookup: both queues currently accept the missing reply ID and create an unlinked send, so atomic source validation is needed to guarantee linkage, beyond renderer ownership.

A further unresolved baseline ambiguity prevents a safe renderer-only implementation: the draft persists its current subject and an edit boolean, but not the thread subject from reply creation. If a thread subject changes while a draft is open or before reopening, a current thread lookup is not the original baseline. For example, persisted `subject="Re: A", subjectEdited=true`, source ID X and current thread subject B can represent either an unchanged A reply after its thread changed to B, or a deliberate change from B to A. These identical persisted inputs require opposite decisions. Neither `subjectEdited` nor the current selected message resolves it. A durable baseline or equivalent authoritative context must be added through the draft contract and both stores, with an atomic source-existence check at queue time. Request scope expansion; do not silently guess or strip headers.

### Actual synthetic counterexample and limits

`E2E_PORT=55440 pnpm --filter @terno/web exec playwright test -c playwright.reply-identity.config.ts reply-subject.spec.ts` against unchanged code: reply and reply-all each delivered `In-Reply-To: own-latest@example.test` after editing the subject to `New synthetic topic`, failing the new-context expectation. Forward's first run timed out because the test tried to reveal its already-visible subject; this is a fixture error, not product RED. The corrected diagnostic asserted observed behavior, and all 3 cases passed: reply/reply-all retain exact original queue and SMTP `In-Reply-To`/`References`; forward has neither; displayed and queued recipients and quote match. Source provider thread ID was null, so no native provider-thread conclusion follows. The diagnostic is retained outside the checkout at `/tmp/terno-w09-s37/observed.spec.ts`, logs `initial.log` and `observed.log`. It is not installed as a regression that blesses the defect. No production fix or GREEN for the intended new-context behavior is claimed. No code review round has run because no fix series exists.
