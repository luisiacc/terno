# 60 · Forward regardless of the files

## Request

> when clicking 'forward' if the attachment doesn't load somehow we are not doing the forward, lets allow the forward even if there is a problem with the file, lets do internal retries if it fails, but lets do the forwardng regardless

## What exists

`openComposeNow` (`apps/web/src/lib/compose.ts`), forward branch:

- **When it refuses.** Forward doesn't open when any of these holds, and shows `compose.forwardUnavailable` ("The original files are not ready… choose Retry, then try Forward again") with a Retry action:
  - the forwarded message's `attachmentState` isn't `complete` (bytes not captured yet, `pending`, or capture failed, `unavailable`);
  - any part lacks an `assetId`;
  - `attachments.info` throws or disagrees with a part.
- **Retry** calls `attachments.retry`, which resets the message's capture flag and syncs the account, then reloads the thread. The user then has to press Forward again.
- **Bytes on the device.** `replyFields`/`convertFields` forward only the parts that have an `assetId`, meaning their bytes are stored locally (`compose-fields.ts`).
- **The account rule.** `forwardAccountMismatch` refuses a forward whose draft is on another account than the original, but only when the original has stored parts: a file's bytes belong to its account.
- **Tests that pin today's refusal.** `e2e/forward-capture.spec.ts` and `drafts-attachments-store.test.ts` (`kind === "unavailable"`).

## Design

**Forward always opens.** A file that isn't ready never blocks it. The account rule, a gone account and the size budget still do.

1. **The ready files go in at once.** A part counts as ready when it has an `assetId` and `attachments.info` agrees with it.
   - A part whose `info` throws or disagrees is treated as not ready, not as a reason to refuse.
   - The empty-From flush before adding attachment owners runs only when there are ready parts.
   - The quote uses the body when it's there and the snippet otherwise, as a reply already does.
2. **The rest arrive in the background.** After the forward draft is created or converted (or Forward is pressed on an open forward), `forward-files.ts` takes over for that draft, as long as anything is outstanding: capture not complete, or parts without a verified ref.
   - **Up to 3 attempts, about 0 s, 4 s and 15 s apart.** Each attempt calls `attachments.retry` (capture flag reset plus an account sync) and then `loadThread(threadId, true)`. Newly stored parts are checked with `attachments.info` and added to the draft. The adding works like `attachFiles`: `beginDraftWork`, a budget check, `editDraft` with `mergeAttachmentRefs` on the live draft, then `flushDraft`.
   - **Event first.** Between attempts it also watches the thread's detail in `useThreads`. A sync that captures the files on its own adds them without waiting for the next attempt.
   - **Each file is offered once.** A ref already offered (at open or later) is never offered again, so a file the user removes stays removed.
   - **When it stops:**
     - the draft is gone;
     - the draft is sending or in recovery;
     - the draft is no longer a forward of that message;
     - every file has arrived;
     - the attempts are used up, which leaves a "failed" state.
   - **Another account.** It pauses while the draft's From is another account than the original's (the account rule). The draft then says "To include the original's files, choose {account} in From." It resumes when From changes to that account.
3. **The draft says what's happening.** `DraftAttachments` shows a polite status line under the attachments:
   - **While fetching:** "Getting report.pdf from the original…", or "Getting the original's files…" when their names aren't known yet (no body captured).
   - **When the attempts run out:** "Couldn't get report.pdf, so this forward won't include it." plus a **Try again** button, which runs three more attempts. Pressing Forward again does the same.
   - **When the files don't fit the size budget:** the existing "This message is too large…" message, with no retry.
   - Sending is never blocked. What hasn't arrived simply isn't sent, and the status line says so beforehand.
4. `compose.forwardUnavailable` goes, since nothing shows it any more. New strings in `en` and `es`.

## Tests

- **Unit** (`forward-files.test.ts`, with the RPC faked):
  - Retries call `attachments.retry` up to three times on the timer schedule (fake timers).
  - Files captured on the second attempt are added once and the state clears.
  - A thread update between attempts adds the files without waiting.
  - A removed file isn't re-added.
  - It stops when the draft is sent, discarded or converted.
  - It pauses on another From and resumes on the right one.
  - The budget refusal shows the size message.
  - Exhausted attempts leave "failed", and Try again restarts them.
- **Unit** (`drafts-attachments-store.test.ts`): unavailable files no longer refuse. The draft converts to a forward (From b, no files), and the status asks for From a.
- **e2e** (`forward-capture.spec.ts`, rewritten, `@design`):
  - Forward on a message whose files aren't captured opens at once with focus in To, and the status says the files are on their way.
  - Capturing the files (`setBody` with attachments plus `notifyChanged`) adds them to the draft.
  - A capture that keeps failing ends in the "Couldn't get…" line with Try again, and sending works without them.
  - axe in light and dark; Spanish strings.
- Visual: screenshots of both status lines, light and dark.

## Perf and resources

At most 3 attempts per Forward press, then idle: no timer survives a stop. The thread watch is one `useThreads` subscription per pending forward, removed on stop. Nothing on a hot path.

## Out of scope

- Fetching across a reload: a forward reopened after a reload shows the files it has. Pressing Forward again starts the fetch.
- Refilling a snippet quote when the body arrives later (replies behave the same today).

## Revisions after the Codex review

The critique's 12 points, and what changed:

1. **Verified refs are passed explicitly.** `replyFields`/`convertFields` take `forwardRefs`, the parts `attachments.info` confirmed, instead of every part with an `assetId`. A rejected part never enters the draft.
2. **The empty-From barrier applies to background adoption too.** Adding the first files to a draft first flushes it. Adoption goes ahead only when the draft is then saved (`status === "saved"`, `savedRev === localRev`) on the source account; otherwise it waits for the next attempt or thread update.
3. **Adoption is fenced.**
   - Snapshot: id, generation, localRev, bodyVersion, body, attachments, account, mode and `forwardOfMessageId`.
   - Then the budget check, then a compare against the live draft before `editDraft`. Any difference waits for the next attempt.
   - Each session carries a token, so results that land after a stop or restart are dropped.
   - Nothing is adopted while a compose open is in flight (`openInFlight()` from compose.ts), so no open's acknowledgement proof is disturbed.
4. **Pinned to `forwardOfMessageId`.** Background work reads that message by id. A different `answered` message or a missing message stops it.
5. **The account rule uses verified refs.** `forwardAccountMismatch` takes them.
   - If verified files exist and From is another account, Forward refuses as today.
   - If no file is verified, the forward opens on the draft's account without files and doesn't fetch. The draft says: "The original's files belong to {account}. Choose it in From, then press Forward again to include them." (When existing attachments lock From, the user removes them first, as `attachments.senderLocked` already says.)
6. **Off-screen drafts.** The `useThreads` watch only helps while the conversation is open (the usual case, since the forward is inline there). Each attempt reloads the thread itself with `loadThread(threadId, true)`, so a draft off screen still gets its files on the next attempt. The plan no longer promises event-only delivery.
7. **Sync storms.**
   - `attachments.retry` runs once per message at a time, shared by every draft forwarding it (a per-message in-flight map). The backend already coalesces syncs per account.
   - A session makes at most 3 attempts, and Try again or Forward again starts at most one more session per draft.
   - Capture is the backend's bounded batch, so an attempt may not reach the message. The failed state then offers Try again; nothing loops on its own.
8. **The offered set's lifetime.** It's kept per draft key and source message for the app session, across Try again and Forward again. A file is marked offered only after `editDraft` succeeds; the refs placed at open are marked when the draft is made. After a reload the set starts from the draft's current files (documented). Undoing a conversion makes the draft a reply, which stops the session.
9. **Forward again restarts.** The same-mode path (Forward on an open forward) calls `ensureForwardFiles(key)` after its own ownership and focus checks, so a failed or never-started fetch (for example after a reload) runs again.
10. **`beginDraftWork` only around adoption.** It's held for the short adoption transaction alone, never across timers or the sync. Timers are cleared on stop.
11. **Sending.** `sending` suspends adoption without stopping the session. A send that fails validation clears `sending`, and the next attempt or thread update adopts. A sent draft disappears, which stops the session. Background fetching never touches `useAttachmentUploads`, so Send is never blocked by it.
12. **Tests updated deliberately:**
    - `forward-capture.test.ts`: pending capture now opens a forward; missing or mismatched refs open without that file; the Retry snack test becomes the background retry test.
    - `drafts-attachments-store.test.ts`: unavailable capture now converts to a forward without files and allows the retry RPC.
    - `forward-capture.spec.ts` keeps its authored-body, autosave and reload coverage.
    - A real-store test covers background adoption.
