# Plan 45: prevent collateral IMAP expunge

## Request (verbatim)

> I want you to go through every item to fix here in this report. For each item that needs fixing you already have, in that report, what needs to be done but for each item you need to:
> 1. Go for that item.
> 2. Spec it out a bit more.
> 3. Do maybe a better investigation on it to see what's truly needed for us.
> 4. Build a test case reproducing that scenario, that potential scenario, or multiple test cases.
> 5. Fix it.
> 6. That will do it.
> 7. Spawn a subagent with Codex doing a code review of that fix, of that code you have just fixed and/or added.
> 8. Fix any findings.
> create atomic commits as you are fixing things.
> That way there is a double check on what you're doing and this can be better. Of course we need to maintain our performance while doing this and follow the directives that we have. You're going to do this for each and every one of the items that you have done here.
> Let's not create a separate branch or anything like that. Let's just do the fixes right here in the main branch. You should not stop until everything in that report is done.


## Existing behavior and first slice

Read plans03/04,20 and26 and the installed ImapFlow2.8.0 implementation. The source investigation is `/tmp/terno-imap-capability-investigation.md`, including its correction: the installed pnpm package is valid, and effective IMAP4rev2 folds MOVE and UIDPLUS only under the library's active-version rules. ImapFlow messageMove falls back to COPY, STORE Deleted and messageDelete when MOVE is unavailable. Without effective UIDPLUS, UID-targeted messageDelete issues ordinary EXPUNGE, which also removes unrelated messages already marked Deleted. Terno currently enters that fallback and the Gmail-style All Mail path ignores false deletion outcomes.

Use the real Backend/RPC, installed ImapFlow and in-process ImapKit with private synthetic mail, dynamic loopback ports and temporary SQL profile. Existing `imap.int.test.ts` owns this public fixture seam; extending its setup only supplies server capabilities. Observe server-side command names and remote UID/raw/flags, not a mock of the provider method. Capture the original behavioral RED before production.

## Contract

A true move with targets requires effective MOVE or UIDPLUS on the exact connected session before any implicit destructive fallback. A delete-only Gmail-style archive requires effective UIDPLUS. Refuse permanently with calm paired English/Spanish guidance before COPY, STORE, EXPUNGE or local location removal if safe targeted semantics are unavailable. Empty target sets do nothing, including when no Inbox locations remain. A false qualified delete result is a failure and does not remove local locations. Preflight capability requirements for the operation before beginning any source mutation; UIDVALIDITY is still verified after each mailbox lock. Capability checks must match installed library semantics, including rev2-only, dual-advertised and enabled-rev2 cases, without a private deep import.

Retain native MOVE and UIDPLUS-targeted fallback. This is prevention of collateral expunge only. Partial MOVE/COPYUID, ambiguous application and automatic retry, orphan recovery, durable per-folder authority, arbitrary folders, UIDVALIDITY reset, IDLE fairness and broader report work remain open. This slice must not claim safe general MOVE or activate IMAP plan38 flag observation.

## Design, bounds and qualification

A constant-time capability preflight uses existing session capability/enabled sets; no new request, index, migration, timer, scan or network outside the action. A tiny helper may encode the pinned public session semantics with parity tests, but tests must observe actual ImapFlow wire choices. Error strings use existing provider-error localization conventions in both catalogs. Read all mutation paths before editing.

First public RED: archive on a rev1 server without MOVE or UIDPLUS while another Inbox message is Deleted; require both exact remote messages untouched, no destructive wire command and a permanent failed public operation, with local body retained. Follow with UIDPLUS fallback, native MOVE, no-target and Gmail-style All Mail refusal/false-result controls. Account for multiple source mailboxes and do not mistake a truthful partial failure for atomic remote rollback. Reopen checks retain local target identity/content and failed operation. Keep normal test timeouts, synthetic credentials only, bounded command transcript and unconditional backend/server/profile cleanup.

Before production, one read-only Codex plan critique of at most8points must complete with Python-recorded actual exit0/DONE, and revisions are recorded here. Each behavior fix gets an observed RED and atomic commit with the required footer; fresh independent Standards and Spec code reviews follow. Root owns any later browser/native/global/performance windows. No current gate or performance failure is waived. Existing .879296 incoming ratio,102.4ms UI median,19.6ms coldSQL, unbounded terminal flag settlement and IDB uncertainty remain open.


## Initial observed RED

The real Backend/RPC + ImapFlow + capability-limited ImapKit case fails at the intended safety boundary. Archiving one target issues `UID COPY`, `UID STORE`, then plain `EXPUNGE`; target and unrelated Deleted UID both disappear from Inbox, one target appears in Archive, and ops.list reports succeeded. Exact local target body remains readable. Log `/tmp/terno-provider-hardening.x0emTS/imap-targeted-expunge-red.txt`, actual Vitest exit1. The preceding initial capture failed at test setup because an observational script rule lacked the required action; that setup log is retained separately and is not behavioral RED. The rule now has `run:true` and its false predicate observes names without intercepting protocol behavior. No production fix has been applied.


## Revisions after the Codex review

The sole source critique completed with Python-recorded actual `CODEX_EXIT=0`, `CODEX_EXIT0` and `DONE` in `imap-targeted-expunge-critique.txt`. All eight refinements are accepted: mirror exact rev2 capability folding; preflight actual nonempty destructive targets before destination creation and preserve copy-only paths; retain epoch checks and explicitly reject read-only sources before fallback copy; independently guard All Mail delete and false results; do not infer no remote work from a false/ambiguous outcome; qualify public localized refusal, identity/location/reopen and Undo rather than claim optimistic Inbox rollback; use each callback's exact live session; and script consistent wire capabilities with failure-safe cleanup. Only the new capability predicate is constant-time. The existing grouping/sync/resource costs and partial-application retry problem remain open.

The first vertical correction addresses the observed true-MOVE fallback refusal. Subsequent empty-role/Create, All Mail delete, read-only, reconnect, rev2 and refusal/Undo qualification remain required; this first commit must not be reported as the completed IMAP slice.


## First atomic correction qualification

The true-move guard refuses the reproduced unsupported fallback before COPY/STORE/EXPUNGE and preserves exact target/unrelated raw bytes, the unrelated Deleted flag, local target body and a failed public operation. The existing native MOVE control also passes:2focused cases in `imap-targeted-expunge-first-green.txt` (normal test budget, no globalSetup/worker emission). Mail, i18n and both backend typechecks, owned oxlint and scoped diff check pass. This first boundary adds the paired localized refusal and matches pinned ImapFlow's effective rev2 semantics without a deep import. No ordinary-path request or migration is added. The capability matrix, UIDPLUS wire fallback, empty-role/Create, read-only sources, All Mail delete, refusal/reopen/Undo and reconnect qualification remain open; fresh independent whole-slice review follows those corrections. No broader IMAP or performance approval.


The no-MOVE/UIDPLUS successful-path control passes through the real public backend: the wire is exactly UID COPY, UID STORE and UID EXPUNGE for the requested UID, from Inbox. The unrelated Deleted UID, exact raw bytes and flag survive; the target's raw bytes reach Archive, its operation succeeds once and its local body remains exact after sync. `imap-targeted-expunge-uidplus-control.txt` is a new GREEN control, not claimed old-product RED. It does not qualify an interrupted/partial fallback or missing COPYUID recovery.


The first UIDPLUS-control capture is not sufficient evidence: owned lint caught a single-backslash source literal, which JavaScript interpreted as the keyword Deleted rather than the system flag. Preserve that passing capture and lint failure; it is a fixture error, not a product result. Correct the literal and require the actual remote system flag before the operation in both refusal and UIDPLUS cases, then rerun the paired controls before claiming qualified preservation.


The corrected paired system-flag controls pass2/2 in `imap-targeted-expunge-system-flag-green.txt`; both first require the remote unrelated UID to carry the actual system flag. The refusal case preserves both messages with zero mutations. The UIDPLUS case preserves that unrelated UID/flag/raw while UID EXPUNGE names only the target. Corrected owned lint passes. The prior malformed-flag control is retained solely as a disclosed fixture failure of qualification.


## All Mail delete-only archive correction

Two public cases independently reproduce the delete-only path's collateral expunge with and without advertised MOVE but no UIDPLUS. Real remote Inbox loses both exact target and unrelated Deleted bytes and the op succeeds; `imap-all-mail-archive-red.txt` retains actual exit1/2failed. All Mail's target copy remains, demonstrating why MOVE permission alone cannot qualify the separate delete operation. Require effective UIDPLUS before locking/mutating Inbox and skip an empty Inbox target set. The false deletion result, role creation/no-op, read-only and reconnect controls remain separate open refinements.


The All Mail capability guard passes both new cases plus the original refusal, true UIDPLUS fallback and native MOVE controls:5/5 in `imap-all-mail-archive-green.txt`. Mail and both backend typechecks and scoped oxlint pass. This boundary prevents the observed broad-expunge path; it does not yet fix or qualify false STORE/EXPUNGE results, interrupted application, read-only source handling or the remaining critique cases.


## Explicit deletion refusal correction

Both actual tagged-NO controls fail before the correction (`imap-all-mail-refusal-red.txt`,2failed): qualified UID STORE refusal or UID EXPUNGE refusal still removes the cached Inbox location and reports succeeded. The latter control explicitly observes the target already marked Deleted, so no remote rollback or untouched-message promise is made. Retain source locations and fail permanently when messageDelete returns false; paired guidance asks the user to inspect their provider before retrying. No automatic replay or inferred remote non-application is permitted by this correction.


The explicit-refusal correction passes both tagged-NO cases together with the five prior capability/MOVE controls:7/7 in `imap-all-mail-refusal-green.txt`. Exact local source locations remain after a false deletion result, the op fails once with the new paired guidance, and the EXPUNGE-refusal control truthfully retains the remote Deleted side effect. Mail, i18n, both backend typechecks and scoped lint pass. No remote rollback, partial MOVE recovery or full-slice review approval is implied.


## Read-only true-move source correction

A genuine ImapKit ACL fixture grants the login only lookup/read in Inbox and insertion into Archive. The public precondition confirms a selected read-only source. The actual fallback case issues COPY/STORE twice, creates two Archive copies, and remains queued; `imap-readonly-source-red.txt` retains the original RED. Adding the native MOVE variant also fails at the intended no-mutation/permanent-failure boundary (`imap-readonly-source-both-red.txt`,2failed). Require selected-source writability after each lock and UIDVALIDITY validation, before a true move. This applies per source; a later source refusal remains a truthful partial failure rather than remote rollback. Copy-only actions are not blocked by this predicate; their matched qualification remains required.


The read-only source guard passes both native MOVE and UIDPLUS fallback cases together with seven prior controls:9/9 in `imap-readonly-source-green.txt`. Mail, i18n and both backend typechecks plus owned oxlint pass. It prevents the observed duplicate copies before either true-move path and reports a permanent localized refusal; copy-only and All Mail delete-only read-only controls remain to qualify independently. No remote rollback or full-slice clearance.


## Read-only delete and copy controls

The All Mail read-only Inbox case is RED only at the specific diagnostic: ImapFlow already returns false without sending a mutation, and the current false-result guard fails permanently with generic change-refused guidance. No additional remote mutation or lost-location defect was observed. Require the precise read-only guidance after lock/epoch validation. The matched read-only All Mail-to-Inbox copy succeeds without MOVE or UIDPLUS and issues only UID COPY; do not apply destructive-write eligibility to copy-only sources. Original paired capture `imap-readonly-delete-red.txt`:1failed/1passed.


Both new read-only controls and the nine earlier cases pass11/11 in `imap-readonly-all-green.txt`; mail and both backend typechecks, owned lint and diff check pass. All Mail deletion now reports read-only rather than the generic false-result diagnostic. The copy-only control requires exactly UID COPY, both exact remote copies and a succeeded operation, with local body retained. No broader MOVE ambiguity or final review approval.


## Lazy role creation correction

Four public REDs in `imap-empty-role-red.txt` show CREATE before unsupported archive/trash/spam failure, plus CREATE Junk for an operation whose only source is Sent and deliberately excluded from spam. Exact original remote/local bodies and final operation outcomes otherwise hold. Resolve missing role destinations lazily inside moveLocations after nonempty-target/capability admission. Known destinations still skip already-present locations without requiring destructive capabilities. This also avoids the extra moving-array snapshot; existing grouping costs are unchanged and remain outside a throughput claim.


Lazy role creation passes the four new RED cases and eleven preceding controls15/15 (`imap-empty-role-green.txt`). Two additional positive controls require CREATE followed by native UID MOVE or the UIDPLUS COPY/STORE/UID EXPUNGE fallback and verify exact destination bytes and succeeded operation (`imap-empty-role-positive.txt`,2/2). Scoped mail/backend types, lint and diff check pass. Existing target and unsupported/no-op paths are qualified without weakening the original remote-content assertions. Capability/session matrix and fresh whole-slice review remain pending.


## Capability and recovery qualification

Six real-wire rev2 cases pass in `imap-rev2-matrix.txt`: missing standalone MOVE/UIDPLUS tokens, dual-advertised but unenabled refusal, dual-enabled and rev2-only success, each for true MOVE and All Mail UID-targeted deletion. ImapKit runs its real rev2/folded handlers; capability output removes explicit MOVE/UIDPLUS, the rev2-only fixture omits rev1 in every CAPABILITY response, and the unenabled case receives no ENABLE grant. Exact remote content/unrelated system Deleted flag, public operation and local body remain asserted. These are qualification controls, not newly observed old-product defects.

Both safe-to-unsafe and unsafe-to-safe reconnect cases pass in `imap-reconnect-capabilities-corrected.txt`, requiring a new server session identity and the new session capability outcome. The first reconnect capture used the wrong public session property (`id` rather than `session`), failing its fixture precondition; it is retained as setup failure, not a product RED.

Refusal/Undo/reopen qualification passes in `imap-refusal-reopen-undo-corrected.txt`: exact same message/body/location, restored Inbox, remote target/unrelated system Deleted bytes, and persisted operation records. The initial test attempted an old in-memory Undo handle after restart and then double-stopped the already closed backend; both failures are retained in `imap-refusal-reopen-undo.txt`, not claimed product defects. The corrected oracle performs explicit Undo within its originating session and verifies its durable result across reopen. The synthetic fixture now has an exact stop guard and sequential cleanup continues all registered disposers while collecting errors. No durable cross-restart Undo window is claimed.


The complete existing real IMAP/SMTP integration file passes52/52 with no globalSetup or worker emission in12.86seconds (`imap-targeted-expunge-full.txt`), including all new capability/ACL/Create/reconnect/refusal/Undo/reopen controls and the pre-existing send/SMTP cases. Mail, i18n and both backend typechecks, all four changed-code-path lint targets and diff check pass. This is finite correctness evidence, not fresh browser/native/performance/global approval. Independent whole-slice Standards and Spec review is required next; partial MOVE/ambiguous replay, missing UID mappings, arbitrary folders and broader IMAP remain open.
