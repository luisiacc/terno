# Plan 35: preserve work when a saved draft disappears

Status: critique complete; implementation pending. Scope: B27 and the terminal-save portion of S38/A16, under plan26. Provider drafts remain local; this adds no remote-draft API. Read plans16/29/34 for rich editor, attachment ownership and recipient chip contracts, plus plan11's reload barrier.

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


## Investigation and actual loss

The coverage investigation `/tmp/terno-existing-protections-qualification.md` found that `apps/web/src/lib/drafts.ts` drops the entire local draft and writer when drafts.save returns null. The store correctly returns null for a previously saved ID that was sent/deleted; it must not resurrect that ID. However, current editor/recipient edits can be newer than the submitted save. `drafts.test.ts` explicitly expects deletion on this response, so an existing passing test encodes loss of recoverable authored work.

The renderer serializes one save per logical key, debounces800ms/max5s, and materializes the current rich editor before saves/sends. Acknowledgements belong to a key and local revision. Assets are immutable account-scoped references and remain available under unlink grace; missing assets fail closed. Plan34 changes recipient interaction but retains the same draft field/source contract. UI recovery must preserve that document, selection, focus, logical key and typing performance.

## Behavior and design

1. A null save response is terminal for its old storage target. Materialize the current editor once, retain the latest body text/HTML, recipients including unfinished chips, subject, quote, mode/context and attachment refs. Keep the local draft visible with explicit `missing` save status. Never call drop/forget or mark it Saved. Keep the editor and logical key intact, including newer edits typed during the in-flight save.
2. Stop automatic saves/retries to the old ID, including timers already scheduled by later typing. Continued typing updates retained local content while status stays missing; resume/flush/visibility changes cannot restart old-target writes. No polling or idle timer. Explicit discard may remove local work; its existing Undo is a deliberate new draft.
3. Show calm inline English/Spanish recovery copy in existing SaveState with a keyboard-reachable **Save a copy** action. Send/shortcut paths refuse while the original target is missing, without clearing work. The source may already have been sent; no automatic send or ambiguous-send retry is authorized by a save failure.
4. Save a copy is explicit user intent to create a fresh local draft through the existing save contract. Preserve the active editor key and exact latest authored fields; reset only storage identity/revision, serialize one creation per recovery action and keep Send blocked until its acknowledgement. Success adopts the new ID and resumes normal revisioned autosave; edits during creation save afterward against the acknowledged new revision. Repeated clicks share the same in-flight action. Failure retains all recoverable fields and visible unsaved/error state, never silently drops attachments or overwrites another revision.
5. Validate referenced assets and account/context through the existing atomic store command. Missing/foreign/incomplete assets or a removed account cannot cause submission or false saved status. Retain text and unavailable metadata so the user can remove/replace a file or choose a usable account. Do not revive the old ID, overwrite a competing saved revision, or fabricate complete attachment bytes.
6. `draftsSaved()` remains false while recovery is unresolved. Enforce that outcome in ordinary update/reload paths rather than assuming every caller already honors it. This is retained unsaved work, not an acknowledged durable backup: forced quit/crash before successful copy still has the existing failed-save limitation. Do not introduce localStorage mail copies or claim new crash durability. An uncertain copy-create acknowledgement is part of this feature: keep a distinct unknown outcome, block Send and automatic creation retries, and provide either exact request-identity reconciliation or an explicitly disclosed further-copy action. Broader initial-compose creation qualification remains A16; the new recovery path cannot defer its own uncertainty behavior.

## Tests before fixing

Public writer tests first replace the existing loss expectation: save, externally delete/send the stored draft, edit, receive null while additional body/recipient/attachment edits arrive, and assert exact latest state remains visible. Advance fake time and call resume/retry/flush repeatedly: no further save against the old ID, no timer spin, draftsSaved false and no compose.send. Cover rich editor materialization, UI-only edits, deletion during a pending send, and normal unrelated drafts continuing.

Use real SQL and IndexedDB autosave/RPC fixtures for the null boundary and explicit copy: old ID stays absent, new ID differs, exact body/recipients/quote/refs survive copy/reopen, stale concurrent revision is not overwritten. Gate copy acknowledgement, type more, double-activate recovery and verify serialized creation/next revision; failed copy and missing assets preserve text. A null response from an otherwise successful local send must not produce a second provider submission.

Add actual @design browser cases for retained text, inline recovery action, keyboard focus/caret/selection, successful copy/autosave/reload and refused Send/shortcut. Exercise all three designs; inspect light/dark screenshots and axe. Include an attachment-bearing recovery with exact bytes and recipient chip text. Avoid changing existing layout tokens or motion.

## Performance and release

The ordinary typing path adds only constant status checks. Do not serialize the editor per keystroke, scan all drafts or allocate recovery data until the terminal event/action. No new entry dependency, polling, network provider call or idle timer. Preserve existing2000-draft render/typing and rich-document serialization budgets; run focused perf/UI qualification for changed paths and all mandatory aggregate gates before calling the series complete. Atomic commits on main under the shared fcntl lock; no branch/worktree/push. A read-only Codex plan critique and a fresh distinct code-review subagent are required, with every finding fixed through a meaningful failing regression.

## Revisions after the Codex review

The read-only critique completed with12concrete points (`/tmp/terno-provider-hardening.x0emTS/missing-draft-plan-review.txt`); all are accepted. Its source probes are design evidence, not a passing feature suite.

1. Storage identity must not be reused. Both SQLite INTEGER PRIMARY KEY and IDB's reconstructed allocator can reuse a deleted highest ID. Implement durable non-reuse or an immutable generation fence across save/send; document migration and legacy caller behavior. Test delete-highest, copy, reopen and delayed old revision1 update/send: the old identity cannot target the copy.
2. Copy creation can commit after an RPC timeout. Use distinct copying/unknown outcomes, no automatic creation retry and no Send until an acknowledgement or explicit reconciliation resolves identity. If exact reconciliation is unavailable, disclose possible prior creation before a further explicit copy; never silently adopt a row by matching body/subject alone.
3. Recovery metadata is independent of transient save status, survives edits/collapse/errors, and resolves only on acknowledged copy or deliberate discard. Gate schedule/save before writer allocation or materialization, clear existing timers, and stop flush/resume/retry loops at the terminal target.
4. Save/copy/send/discard share one per-key writer arbitration and operation identity. Discard waits a bounded current operation, deletes an acknowledged resulting copy if appropriate, and cannot permit endless successor autosaves. A copy acknowledgement applies only its captured revision and merges identity into the latest local fields.
5. Refuse sending both before editor lock and after a pending save settles. Distinguish missing-target STALE from revision conflict when an otherwise clean externally deleted draft goes directly to compose.send; enter recovery without a provider request. Null is a save result, not a send result.
6. Validate/normalize vanished reply/forward/thread context atomically. Preserve authored recipients, body, quote and valid RFC reply context, while removing unusable local links and presenting an unavailable conversation as a recoverable standalone draft. Do not reject deliberate cross-account reply context merely because a provider-local thread ID cannot be reused. DraftsStrip must fall back when its conversation no longer exists.
7. Terminal ownership cannot wait forever for an impossible empty save acknowledgement. After deliberate removal of all references, release the old target's attachment lock; retain it for actual refs and in-flight/uncertain copy ownership. Show account selection even with one remaining account when the original account is gone. Never silently discard unavailable files.
8. Structured refusal reasons distinguish missing assets/account/context/size from uncertain transport. Missing bytes must not display Too long to save. Definitive refusal stays recoverable without a five-second retry loop; arbitrary storage error details never enter UI/logs.
9. Adopt acknowledgement metadata only: keep key, exact recipient text, bodyVersion, canonical-source trust, editor history/selection/stored marks and loading stand-in. Do not replace the document via fromServer or recipient-string normalization on copy success.
10. Preserve existing dirty-source coalescing: first edit marks/counts, later keys stay in the editor, scheduling alone is suppressed. Materialize only on the terminal event and explicit operation boundaries, not per keystroke or every rerender.
11. Audit actual reload callers. Service-worker update, different-build leader takeover and user-requested update restart must honor unresolved recovery. Wire a meaningful saved/not-saved result where needed; distinguish explicit forced quit/crash and existing bounded shutdown policy rather than promising a hold from a predicate nobody checks. Desktop-only wiring needs packaged smoke.
12. Define matching en/es missing/copying/refused/unknown copy states, action purpose, busy deduplication and acknowledgement. Use named type=button controls and transition-only live announcements. On action removal restore focus only if that action still owns it; never steal focus from continued typing, and keep exact editor selection.

## R5 correction plan

The independent R5 review found a failed Send body read can clear the dirty source before adoption, allowing a stale save and transition; it also found native reload recovery hidden behind healthy Settings and Shortcuts modals. The correction plan and exact evidence are in `/tmp/terno-missing-draft-r5-corrections.md`. Regression tests must demonstrate both failures before their separate fixes. Preserve all twelve revisions above, all earlier corrections, editor continuity, and the existing stopped-engine modality. Shared modal coordination must handle nested and other dialogs, not only these two. The unresolved UI performance failure and aggregate gates remain open.

### Revisions after the R5 source-only Codex review

The fresh critique completed successfully (`/tmp/terno-plan35-r5-critique.txt`). Preserve unread sources on exceptions and settle missing/copy outcomes independently, release failed discard arbitration, and investigate editor cleanup/remount safety. Modal ownership distinguishes fatal and ordinary dialogs, tracks only active committed popups with nested restoration and identity-safe cleanup, and tests Review/Back, focus and StrictMode. The full accepted refinements and approved shared UI seam are in the R5 correction plan.

R5 source corrections: failed reads retain the dirty source, terminal/copy outcomes and discard arbitration; the shared modal host tracks active popup ownership separately from the fatal host. Real writer/store/admission and ReactDOM regressions were observed failing first. Focused source tests and type checks pass; actual application Review/Back, native/packaged runs and performance remain for the coordinated qualification window. A persistent body-reader failure during Review still needs a safe editor handoff qualification; do not treat it as resolved by these source tests.

Follow-up: a failed Send preflight releases its writer without scheduling another read, and Review keeps the warning open when reading fails. Both had observed failing regressions and pass focused tests. F1 is not fully qualified: actual rich-editor disposal and remount after unread work and bounded state-cache eviction require further source tests and correction.

Rich editor refinement: actual ProseMirror tests reproduced document loss and lost caret/history after failed disposal and eight-entry cache eviction. A source-only critique (`/tmp/terno-plan35-r5-rich-critique.txt`, exit 0) requires transactional transfer of a compact immutable editor-state checkpoint in the existing draft source, identity and body-version fencing, and release on discard. This retains at most one checkpoint per live unread draft; its byte size follows the user's retained work and is not a fixed byte cap. No separate unbounded pin cache or per-keystroke serialization is introduced.

The checkpoint is only for a failed editor disposal, and leaves the ordinary eight-entry LRU behavior for successfully materialized editors unchanged. The real RichBody tests cover persistent and transient failures, nine intervening and nine independently unread editors, exact rich document, selection, stored marks, undo/redo, subsequent editing, explicit body replacement, constructor failure, stale handles and forget cleanup. Source checks do not qualify the actual application transitions or native packaging.
