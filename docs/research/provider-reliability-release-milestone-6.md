# Provider reliability: sixth release milestone

Not release-green. Tested committed-main snapshot `ae860a9014a53186578873a450d9c356f5f1d14e` in an isolated worktree. Live uncommitted work and later main commits were excluded. All required stages ran once serially; no retries, source changes, threshold relaxations or external termination.

| Gate | Result | Counts |
| --- | --- | --- |
| Offline install / typecheck / lint | PASS | — |
| Unit | FAIL | 11,903 passed; 3 failed; 3 skipped |
| Normal db-wasm fallback | PASS | 1,840 passed; 2 skipped |
| E2E | FAIL | 1,540 passed; 10 failed; 7 skipped |
| Web | PASS | 53 passed |
| UI perf | FAIL | 14 passed; 1 failed; 48 NOTRUN |
| Backend perf | FAIL | 261 passed; 15 failed; 1 skipped |
| Fresh macOS build | PASS | arm64 Terno0.1.0; ad-hoc signed |
| Default fresh packaged smoke | PASS | 64 passed; 7 skipped |

Backend perf completed naturally in2,665.8seconds. Unit failure prevented normal chained WASM execution; the original normal project ran once separately and does not make pnpm test pass. UI perf's48serial successors are NOTRUN, not passes/skips. Existing skip limits remain; no stable-signing update, native Keychain or notarization clearance. Full evidence: [report](/tmp/terno-release-milestone6-_epepvi4/report.md), [exact stage metadata](/tmp/terno-release-milestone6-_epepvi4/results.json), [fresh binary identity](/tmp/terno-release-milestone6-_epepvi4/build-identity.json). Fresh executable/asar hashes match the archived app; deep signature verification passed. Outputs restored without conflicts, source/index unchanged, all owned processes joined with0survivors.

## Exact failed case inventory

Signatures below are observations, not inferred product causes. Historical REDs remain unwaived.

### 03-test

- FAIL  packages/backend/src/smtp-auth-isolation.int.test.ts > S21: real SMTP authentication is isolated from receiving > 535 parks only sends while IDLE, body reads, flags and foreground receiving work across SQL reopen — AssertionError: expected { id: 2, threadId: 2, …(20) } to match object { bodyState: 'full', …(2) }
- FAIL  packages/richtext/src/richtext.test.ts > quote, signature and the document around them > a hostile quote can't nest without end or blow the stack; a 2 MB quote converts in pieces, fast — AssertionError: expected 87.789166999999 to be less than 25
- FAIL  packages/store/src/autocomplete/service.test.ts > the service > applies a commit of 12,000 new people in slices, the delta near its threshold — AssertionError: expected 127.45595800000001 to be less than 60

### 04-e2e

- 1) [e2e] › e2e/attachment-controls.spec.ts:6:1 › reader attachment controls include all visible labels and localized download purpose @design
- 2) [e2e] › e2e/dnd.spec.ts:41:3 › drag and drop to a category › one row: ghost, target highlight, dot, count, the snackbar and its undo @design
- 3) [e2e] › e2e/reply-subject.spec.ts:229:1 › untouched Reply to Reply all keeps its original source when new mail arrives
- 4) [e2e-lumen] › e2e/account-errors.spec.ts:41:3 › long account refusal (lumen, es, light, settings) @design
- 5) [e2e-lumen] › e2e/attachment-controls.spec.ts:6:1 › reader attachment controls include all visible labels and localized download purpose @design
- 6) [e2e-atelier] › e2e/account-errors.spec.ts:41:3 › long account refusal (lumen, en, dark, settings) @design
- 7) [e2e-atelier] › e2e/account-errors.spec.ts:41:3 › long account refusal (lumen, es, dark, settings) @design
- 8) [e2e-atelier] › e2e/attachment-controls.spec.ts:6:1 › reader attachment controls include all visible labels and localized download purpose @design
- 9) [e2e-atelier] › e2e/autocomplete.spec.ts:291:3 › ghost text › in a reply, Esc dismisses it and leaves the draft open; the next Esc collapses @design
- 10) [e2e-atelier] › e2e/dnd.spec.ts:41:3 › drag and drop to a category › one row: ghost, target highlight, dot, count, the snackbar and its undo @design

### 06-ui-perf

- 1) [perf] › e2e/perf.spec.ts:153:3 › lumen › sustained j at key-repeat rate (lumen, compact): frames stay smooth and the selection keeps up, with drafts around

### 07-perf

- FAIL  packages/backend/src/backend.perf.test.ts > idle: RPC round trip adds little over the query itself — AssertionError: expected 19.59583399999974 to be less than or equal to 5
- FAIL  packages/backend/src/categorize.perf.test.ts > classifies a thread against 20 categories in ≤ 50 µs p95 (featurizing its 2 KB body: ≤ 150 µs end to end) — AssertionError: expected 87.45799999996962 to be less than or equal to 50
- FAIL  packages/backend/src/categorize.perf.test.ts > a 20-category, 100k-feature model stays ≤ 30 MB and loads from its snapshot in ≤ 30 ms — AssertionError: snapshot load p95 (p50 27.9 ms): expected 30.906165999998848 to be less than or equal to 30
- FAIL  packages/backend/src/import.perf.test.ts > strict validation of 5,000 attachment-bearing drafts stays within the 15 ms slice budget (connected: false) — AssertionError: expected 17.808792000000267 to be less than or equal to 15
- FAIL  packages/backend/src/load.perf.test.ts > a disk that turns slow mid-job: a controlled controller restart overruns once, then shrinks back under budget — RpcError: The mail engine took too long to answer. Try again.
- FAIL  packages/db/src/perf.perf.test.ts > navigation > lists an account's own folders (plan 68): big, sparse, deep, filtered, scopes — AssertionError: the longest rebuild slice: expected 113.30579099999886 to be less than or equal to 16
- FAIL  packages/db/src/perf.perf.test.ts > navigation > computes sidebar counts — AssertionError: sidebar unread counts (accounts + categories + folders) p95 7.47ms > 5ms: expected 7.471167000003334 to be less than or equal to 5
- FAIL  packages/db/src/perf.perf.test.ts > the quick filters (plan 15): with attachments and starred > hold at 50k+ threads for People and Waiting: as computed, twenty far from every view, everyone, no one — AssertionError: 50k sparse: counts with the waiting count p95 5.62ms > 5ms: expected 5.617624999998952 to be less than or equal to 5
- FAIL  packages/idb/src/backfill.perf.test.ts > 1,000,000 messages, 1 in 20 labelled: every rebuild slice of the backfill within a frame, every label a membership — AssertionError: expected 71.13208299999997 to be less than 16
- FAIL  packages/idb/src/backfill.perf.test.ts > Codex R48: a folder of 150,000 threads opened cold, and read again after an arrival, within a frame — AssertionError: expected 32.76866600000358 to be less than 32
- FAIL  packages/idb/src/backfill.perf.test.ts > Codex R49: Unread in a folder of 150,000 unread threads, cold and after many changes, within a frame — AssertionError: expected 52.60554200000479 to be less than 32
- FAIL  packages/idb/src/backfill.perf.test.ts > Codex R49: a Message-ID twin lookup among 150,000 sharing it, cold and after a write, within a frame — AssertionError: expected 16.118709000002127 to be less than 16
- FAIL  packages/idb/src/idb.perf.test.ts > an account's own folders (plan 68) page from their members: big, sparse, empty, deep, filtered, select all and counts within a frame — AssertionError: folder unread only, all of it read: expected 0.3232919883739669 to be less than or equal to 0.25
- FAIL  packages/idb/src/idb.perf.test.ts > the quick filters (plan 15) page from their own orders: with attachments and starred, cold, every page, counts and walks within a frame; 5,000 stars at once — AssertionError: nothing starred: count: expected 1.5579580505436752 to be less than or equal to 1.5
- FAIL  packages/store/src/autocomplete/phrases.perf.test.ts > the phrase model from 100,000 sent messages > learns within its CPU and stall budgets, in bounded memory — AssertionError: build CPU per message (µs): expected 46.073470000000185 to be less than or equal to 31

## Current-main repair sequence

Current main has later committed review/sidebar/snackbar/filter changes; preserve them. Licensing/package-documentation WIP remains user-owned and untouched. Reproduce on current main before choosing a correction; later source changes are not qualified by the old snapshot.

First parallel slices: UI functional failures plus the affected list-scroll gate; store autocomplete service/phrase CPU; SMTP authentication/receiving hydration. Queued separately: richtext quote slicing, SQL navigation/counts, IDB rebuild/empty scopes, backend RPC/import/load deadlines and categorizer CPU/snapshot. Hot core/store/SQL/IDB changes remain serial. Only targeted files/direct callers/types/lint and affected original perf files; no app builds/full suites until the next announced milestone. One actual native Codex review per fix series, fail-first corrections, post-cap lower findings backlogged. Report153row dispositions/counts remain unchanged.
