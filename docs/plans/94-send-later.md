# 94: Send later

## Request (verbatim)

> implement 'send later', we must have a really nice ui there quick, easy and very intuitive to use, options are 'send now' , 'send tomorrow at 8:00 am' or 'custom'
> the ui for date/time and shortcuts can be similar to the 'remind me' ui
>
> the 'sendme later' i think it can be cleanly done having a clock and a caret as a right-button to the 'send' button in the composer, should look clean enough

## What exists

- **Sending** (`lib/compose.ts` `send`). The renderer waits for the draft's save (`draftForSend`), validates the recipients, builds the exact payload (`bodyParts`, the signature through `sendBody`/`sendHtml`, `sentRefs` for the images kept), and calls `compose.send`. The backend's `store.compose.queueSend` checks the draft fences (`draftId`, `draftGeneration`, `draftRevision`), inserts the local sent copy, enqueues the `send` op (plan 65 receipts for IMAP) and deletes the draft, all in one transaction.
- **Ops** have `next_attempt_at`, but a queued send has already inserted its sent copy and reserved its receipt and wire budget (plan 65, at most 128). Holding one for hours would show a message as sent that isn't, and hold a scarce reservation. Not the place for a schedule.
- **Drafts** are local rows in both stores (`drafts`, early in IndexedDB). The renderer loads them with `drafts.list` at boot and on the `drafts` event (`loadDrafts` merges ids it doesn't know). The strip above the list (`DraftsStrip`) shows the drafts that aren't on screen otherwise.
- **Plan 87's reminders** give the pattern: a small local table, one backend timer for the soonest pending row (none when there are none), a refresh on start, wake and focus, a snapshot event, and `RemindPicker`: presets with their moments, then a themed calendar and a 15-minute time list.

## Design

### 1. The model

A **scheduled send** is a stored draft plus a row in `scheduled_sends`:

- `draft_id`: the draft (primary key; deleting the draft removes the row).
- `send_at`: when it goes (ms).
- `set_at`: when it was scheduled.
- `params_json`: the exact `compose.send` parameters the renderer prepared when the user chose the time, including the draft fences.

The draft stays as it was, so nothing is lost: unscheduling gives back the very draft. At `send_at` the backend sends the stored parameters through the same path as `compose.send`; the fences make it all or nothing (the draft goes with the send). If the draft changed since (another window edited it), the send is refused as stale and the draft simply stays a draft.

Scheduled drafts are not editable drafts: `drafts.list` leaves them out, so no composer, inline draft or autosave touches them. They show as scheduled items instead (§5).

The schedule is local, like reminders: Terno sends it from this device. If Terno isn't running at `send_at`, it goes as soon as it starts. At most 100 scheduled sends (`SCHEDULED_MAX`); over that the backend refuses with `errors.scheduledFull`.

### 2. Stores (`MailStore.scheduled`)

- **SQLite** migration v38: `CREATE TABLE scheduled_sends (draft_id INTEGER PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE, send_at INTEGER NOT NULL, set_at INTEGER NOT NULL, params_json TEXT NOT NULL)`. A rowid table (the params can be large).
- **IndexedDB**: an early `scheduled_sends` table keyed by `draft_id`, cascading from `drafts`. `IDB_VERSION` 23, `LOGICAL_SCHEMA` 38 (renumbered from 22 and 35 after rebasing onto plan 86, the capture repair and the Hugeicons swap).
- **Methods:**
  - `put({ draftId, generation, revision, sendAt, setAt, paramsJson }, cap)` → `"ok" | "full" | "stale"`. Stale: the draft is gone or its generation or revision differ. Replaces an existing row of that draft.
  - `list()` → `{ draftId, sendAt, setAt, accountId, threadId, mode, to, subject }[]`, soonest first, read from the rows and their drafts (no params).
  - `get(draftId)` → the row with its params, or null.
  - `reschedule(draftId, sendAt)` → boolean.
  - `delete(draftId)` → boolean.

### 3. Backend

`ScheduledSends` (`packages/backend/src/scheduled.ts`), shaped like `Reminders`:

- `refresh()`: list; send every due row, one at a time (oldest first); emit the snapshot if it changed; arm one timer for the soonest pending row (capped at 2³¹−1 ms, unref'd). Runs at start, on wake (before the `autoSync` check), on `sync.now` (focus on the web) and after every change. Nothing runs when there are none.
- **Sending a due row** reads its params and calls the same function `compose.send` uses (`b.queueComposeSend`, extracted from the handler) with `recordReply: true`, as the user's own send. On success the draft and its row are gone (the transaction deleted the draft), the thread is announced and the worker kicked; offline, the op waits like any send. On any failure the row is deleted (the draft stays), a `drafts` event tells the windows to load it back, and `scheduledFailed { draftId, subject, message }` says what happened.
- **RPC:**
  - `compose.schedule({ ...compose.send params, draftId, draftGeneration, draftRevision required, sendAt })` → `{ ok: true }`. `sendAt` must be finite; a past one means "now".
  - `scheduled.list()` → `ScheduledSnapshot` `{ items: ScheduledInfo[] }`.
  - `scheduled.reschedule({ draftId, sendAt })`, `scheduled.cancel({ draftId })` (the draft becomes an ordinary draft again; `drafts` event).
- `drafts.list` leaves out the scheduled drafts.
- **Event** `scheduled: ScheduledSnapshot` after every change.

### 4. The composer: Send and its clock

The Send button gets a joined right part: a clock and a caret (`compose-send-later`), the same primary fill, split by a hairline in `primary-foreground/20`. Its tooltip is "Send later" with `⌘⇧↩`. It opens a popover above it, `SendLaterPicker`:

- **Send now**, with `⌘↩` on the right.
- **Tomorrow at 8:00 AM**, with its day on the right ("Sat, Nov 1").
- **Custom…**: expands, in the same panel, the date (themed calendar) and time (15-minute list) of plan 87's picker, defaulting to tomorrow 8:00, and a **Schedule** button. A past moment disables it and says "Pick a time in the future."
- A quiet foot line: "Sends from this device. If Terno is closed then, it goes out when you open it."

↑/↓ move through the choices, Enter picks, Esc closes. `⌘⇧↩` in the composer opens the popover.

Choosing a time runs the same preparation as Send (save, recipient checks, the exact payload) and calls `compose.schedule`. The composer closes like after Send, and a snack says "Scheduled for Tomorrow 8:00 AM · Undo". Undo cancels the schedule and reopens the draft.

The date and time controls move out of `RemindPicker` into one shared `WhenFields` component, so both pickers look and behave the same.

### 5. Seeing and changing a scheduled send

- **The drafts strip** lists scheduled sends first, each with a clock (accent), who it goes to, the subject, and its moment on the right ("Sat 8:00 AM"). A click opens the same `SendLaterPicker` anchored to the item, with a header "Sends Sat, Nov 1 at 8:00 AM" and, below the times, **Edit message** (unschedules and opens the draft). Picking a time reschedules ("Rescheduled for …"); Send now sends at once.
- **The reader**: a conversation with a scheduled reply shows, where the reply bar sits, a quiet line "Reply scheduled · Sat 8:00 AM" with the same picker on click.

### 6. Strings

Every string in `en` and `es`: the button's name and tooltip, the picker's items, the foot line, snacks, `errors.scheduledFull`, the failure snack and the reader line.

## Tests

- **Store conformance** (both stores, `conformance/scheduled.ts`): put/list/get/reschedule/delete round-trip; stale on a missing draft or a different revision or generation; the cap; the cascade when the draft is deleted (and with its account); reopen persists; the migration and IndexedDB upgrade tests.
- **Backend** (`scheduled.test.ts`, fake timers): nothing until `sendAt`, then the op is queued and the draft gone; a past `sendAt` sends at once; a stale draft keeps the draft and emits `scheduledFailed` and `drafts`; cancel puts the draft back in `drafts.list`; reschedule re-arms; a wake re-arms; `stop()` clears the timer; the cap refuses.
- **Web unit**: the picker's presets (tomorrow 8:00 across a day and DST); `send` with a time calls `compose.schedule` with the same payload as `compose.send`.
- **e2e** (`apps/web/e2e/send-later.spec.ts`, `@design`): schedule from the composer's clock with Tomorrow; the strip shows it with its moment; Undo brings the draft back; Custom date and time; Edit message reopens it; Send now sends it; `⌘⇧↩`; axe in light and dark.
- **Screenshots** of the split button, the open picker and the strip in light and dark.

## Perf and resources

One timer only while something is scheduled; no polling. The list is bounded (100). The send at due time is the ordinary send path.

## Out of scope

Server-side scheduling (Gmail has no API for it), a Scheduled folder, recurring sends, per-recipient time zones.

## Revisions after the Codex review

The plan critique (`codex exec -s read-only`) raised twelve points; all were taken.

1. **A cancel or new time during the due send.** `SendCommand.scheduledAt` fences `queueSend` inside its transaction: the row must still exist with that exact `send_at`, else STALE `"unscheduled"`, which the sweep treats as nothing to say. Test: a cancel landing between the row's read and the queue sends nothing (fails without the fence).
2. **Other windows editing a scheduled draft.** `drafts.save` of a scheduled draft unschedules it (the edit wins) and emits `drafts`; a `scheduled` snapshot drops the scheduled drafts from every window's composers unless they hold unsaved edits or are that window's own send in flight (`forgetScheduledDrafts`).
3. **Writer retirement.** Scheduling runs `send`'s own preparation (`draftForSend` stops the writer) and then `forgetDraft`, exactly as a send does; a failure resumes the draft.
4. **Old hydrations.** `loadDrafts` skips ids the scheduled snapshot lists (`scheduledDrafts.has`).
5. **Post-commit effects.** `BackendCore.queueComposeSend` separates the queue (whose failure is the send's) from the announcing (logged, never a failure).
6. **Transient failures.** Only STALE and NOT_FOUND give a send back. Anything else keeps it scheduled with `error` and `retry_at` (columns on the row) and tries again after 1, 5, 15 then 60 minutes; the strip shows the time in the destructive ink and the picker says why.
7. **Shutdown.** `ScheduledSends.stop()` clears the timer and awaits the sweep in flight; `BackendCore.stop()` awaits it before the store closes. Test with a send held mid-queue.
8. **Memory.** A byte budget (`SCHEDULED_BYTES_MAX`, 64 Mi UTF-16 units over all params) beside the count cap. The table stays early in IndexedDB: drafts, which hold the same bodies, are early already, so the budget bounds the duplicate.
9. **Cascades.** `notifyChanged` and `drafts.delete` call `scheduled.touched()` (a look only while something is scheduled), so a deleted draft or account takes its row out of the windows and disarms the timer.
10. **`⌘⇧↵`.** Both composers test it before `⌘↵`; the e2e asserts it opens the picker and sends nothing.
11. **Portaled form.** `SendLaterPicker` has no form; its Schedule button is a plain button.
12. **Durable failure.** A send given back is kept in the setting `scheduled:failed` (at most 20), carried in every snapshot, shown as a snack with "Open draft" and acknowledged by the window (`scheduled.ackFailed`).

Also: the reader's "Reply scheduled" line (§5) and the `lib/when.ts` split, so the strip doesn't pull the reminders' list code (unit tests run without a DOM).

## Codex code review

One read-only review of the series (`git diff cadc8f0f HEAD`) reported six findings; all are fixed, each with a regression test that fails without its fix:

1. **The byte budget scanned the bodies** (`SUM(length(params_json))`, 26 ms near the cap) and counted SQLite characters, not UTF-16 units as IndexedDB does. A `params_len` column holds the length; both stores sum it. Conformance: 30 emoji are 60 units in both stores.
2. **A custom moment that passed while the picker stayed open** was sent at once. Schedule (and Remind's Set, same pattern) reads the clock again and shows "Pick a time in the future." Component test with a moving clock.
3. **A store failure mid-sweep left no timer.** Each row's send is isolated (a row that can't even note its failure waits a minute in memory) and a look that fails re-arms in a minute. Two backend tests.
4. and 5. **A draft coming back could miss other windows** (a cancel emits no `drafts`; a `drafts` event before the snapshot was skipped by the hydration filter). Any id leaving the snapshot reloads the drafts in every window. Unit test with the event before the snapshot.
6. **A reply whose original is gone retried forever.** `errors.replySourceGone`, `attachments.tooLarge` and `attachments.unavailable` give the send back like a stale draft. Backend test.

Verification: typecheck and lint clean; store conformance (both stores), backend, core and web unit suites pass; `send-later.spec.ts` passes in all three designs, with `compose`, `composer`, `composer-send` and `reminders` specs. Known failures not from this series (they fail on cadc8f0f too): four IndexedDB version-pinned upgrade tests and `i18n` scan's `w02-action-fixture.ts:69`. Full `test:e2e`, `test:web`, `test:ui-perf` and `test:perf` were not run (relevant specs only).
