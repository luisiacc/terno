# W06 A33: local draft / expunge applicability

## Request

“IMAP draft replacement should append before deletion; legacy expunge fallback can delete unrelated mail.” Determine remaining remote-draft replacement applicability against Terno's local drafts; do not add remote autosave merely to mirror another client.

## Existing architecture and evidence

Actual base: `266e59dc832ea1c85efae5ea84816000bf189305` (matches expected main266e59dc). Report A33 describes another client's createDraft APPEND/replacement and blanket EXPUNGE fallback. Baseline A33 explicitly says “No remote draft replacement”; the worklist leaves applicability open after Plan45 targeted expunge and uncertain-mutation protection.

Plans29/44 govern durable local attachments and draft presentation. Public `drafts.save/list/delete` in `packages/backend/src/handlers.ts` delegate to local store draft commands. `compose.send` delegates to atomic `store.compose.queueSend`, passing the saved draft generation/revision and attachment references. Plan65 captures immutable send wire and separates SMTP acceptance from optional Sent-copy recovery. `packages/mail/src/imap.ts` appendCopy/send/repairSentCopy file or reconcile Sent copies; they do not autosave remote Drafts. Remote Drafts folder ingestion is not a provider draft replacement API.

Existing `packages/backend/src/imap.int.test.ts` already qualifies no-UIDPLUS refusal and UIDPLUS COPY/STORE/UID EXPUNGE fallback preserving unrelated Deleted mail, plus uncertain mutation no-replay. Those are existing controls, not fresh all-store coverage.

## Design and tests

One dedicated backend integration file, using actual Backend/public RPC, temporary SQLite, installed ImapFlow and synthetic loopback ImapKit/SMTP. Save/edit a local draft with sealed binary attachment, reopen, check identity/revision/body/bytes, discard a neighbor draft, queue and dispatch the saved draft, and reopen again. Capture bounded actual IMAP mutations throughout. No Drafts APPEND/STORE/delete/EXPUNGE may occur; Sent APPEND after SMTP is explicitly expected, with exact SMTP/Sent bytes and decoded binary attachment checks. Seed remote Drafts plus unrelated already-Deleted INBOX mail; assert exact mailbox UIDVALIDITY/UID/raw/flags remain intact through local operations. Parameterize UIDPLUS versus absent MOVE/UIDPLUS, then exercise public archive on a synced control: exact targeted fallback when UIDPLUS exists, otherwise safe refusal without mutation. This integrates the local-draft boundary with an existing supported expunge contract rather than inventing remote autosave. Use negative oracle mutations only to qualify assertions, never call immediately passing tests product RED.

Recommend N/A for remote draft replacement and already protected for the applicable collateral-expunge hazard, subject to executable qualification. Finite native SQLite/loopback contract only: no new IDB, UI wiring, arbitrary server certification, remote concurrency/APPEND replacement recovery, or broad release clearance.

## Validation and exclusions

Only dedicated/direct-caller test files, backend package types and scoped lint. Every test inherits NODE_OPTIONS plus `--require=/tmp/terno-network-guard.cjs`; fixtures use random loopback ports, synthetic credentials and temporary profiles. No production source, store/schema, Gmail, renderer/editor, dependencies, worklist/main, Plans64–68/80/81/83 or licensing edits. No hot path change/perf, app/Vite/package builds or full suites. One native Sol/high read-only plan critique and at most two Standards+Spec code review rounds. Root owns serial integration/disposition/landing.

## Revisions after the Codex review

One native read-only `gpt-6.1-sol`/high plan critique completed exit0 (`/tmp/terno-a33/plan-critique.txt`). Accept all five refinements: explicitly witness effective capabilities (neither MOVE nor folded IMAP4rev2; UIDPLUS only in supported branch), bound mutation capture including destinations, prove exact draft consumption rather than delete ACK alone, assert targeted COPY/STORE/EXPUNGE and durable public archive outcomes, and make final reopen assert no replay plus exact protected state. No provider draft API or production change is warranted.

## Qualification so far

Dedicated native SQLite/real loopback protocol lifecycle controls pass 2/2 on unchanged production. Full raw-byte/flags/UIDVALIDITY/UID snapshots protect both external Drafts messages (including an already-Deleted draft) and unrelated Deleted INBOX mail. Local attachment bytes survive save/edit/discard-neighbor, reopen and send; immutable payload survives second reopen. Exactly one SMTP message equals exactly one Sent APPEND, with independently decoded body and binary part. UIDPLUS archive uses exact UID COPY/STORE/UID EXPUNGE and records the destination identity; absence of effective targeted capabilities refuses with unsafeMove and no mutation.

Negative controls (`/tmp/terno-a33/negative-blanket-expunge.log`, exit1: 1 failure/1 pass; `negative-attachment-drift.log`, exit1: 2 failures) temporarily changed ONLY this new test: expunge all preexisting Deleted INBOX messages at the UID EXPUNGE boundary, or upload a different first attachment byte. Exact remote snapshot and reopened byte assertions respectively fail. Source restored byte-for-byte afterward; no production RED is claimed. Initial authoring run had one incorrect assumption that public ops.list omits succeeded Sent receipts; corrected to assert both send and archive outcomes. The unchanged-production test then passes (`dedicated-green.log`, `refined-green.log`). Backend main+lifecycle types and owned-file strict oxlint pass so far. pnpm bootstrapped missing local dependencies from its existing content-addressed store; no manifest/lockfile edits or application/package production build. Normal existing test-worker setup only.
