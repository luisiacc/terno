# Plan 35: preserve work when a saved draft disappears

Status: design before critique. Scope: B27 and the terminal-save portion of S38/A16, under plan26. Provider drafts remain local; this adds no remote-draft API. Read plans16/29/34 for rich editor, attachment ownership and recipient chip contracts, plus plan11's reload barrier.

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
6. `draftsSaved()` remains false while recovery is unresolved, so ordinary update/reload coordination holds instead of claiming a safe reload. This is retained unsaved work, not an acknowledged durable backup: forced quit/crash before successful copy still has the existing failed-save limitation. Do not introduce localStorage mail copies or claim new crash durability. First-create lost acknowledgement/idempotency is an existing A16 qualification and remains active separately; this change must not add silent creation retries or treat a failed acknowledgement as proof nothing was stored.

## Tests before fixing

Public writer tests first replace the existing loss expectation: save, externally delete/send the stored draft, edit, receive null while additional body/recipient/attachment edits arrive, and assert exact latest state remains visible. Advance fake time and call resume/retry/flush repeatedly: no further save against the old ID, no timer spin, draftsSaved false and no compose.send. Cover rich editor materialization, UI-only edits, deletion during a pending send, and normal unrelated drafts continuing.

Use real SQL and IndexedDB autosave/RPC fixtures for the null boundary and explicit copy: old ID stays absent, new ID differs, exact body/recipients/quote/refs survive copy/reopen, stale concurrent revision is not overwritten. Gate copy acknowledgement, type more, double-activate recovery and verify serialized creation/next revision; failed copy and missing assets preserve text. A null response from an otherwise successful local send must not produce a second provider submission.

Add actual @design browser cases for retained text, inline recovery action, keyboard focus/caret/selection, successful copy/autosave/reload and refused Send/shortcut. Exercise all three designs; inspect light/dark screenshots and axe. Include an attachment-bearing recovery with exact bytes and recipient chip text. Avoid changing existing layout tokens or motion.

## Performance and release

The ordinary typing path adds only constant status checks. Do not serialize the editor per keystroke, scan all drafts or allocate recovery data until the terminal event/action. No new entry dependency, polling, network provider call or idle timer. Preserve existing2000-draft render/typing and rich-document serialization budgets; run focused perf/UI qualification for changed paths and all mandatory aggregate gates before calling the series complete. Atomic commits on main under the shared fcntl lock; no branch/worktree/push. A read-only Codex plan critique and a fresh distinct code-review subagent are required, with every finding fixed through a meaningful failing regression.

## Revisions after the Codex review

Pending. No implementation or passing gate is claimed by this plan.
