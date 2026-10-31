# 87: Remind me

## Request (verbatim)

> do we have a 'remind me' feature, a small folder on the left, inside the collapsed menu, for things the user wants to be reminded of, they would stay there, and when the time comes up they would show on top of the inbox, do we have that?

> yes the thread jumps to the top until opened, it does not show a notification.
>
> - implement 'remind me' list of messages, nice intuitive ui for assigning it, the remind me action can be can be 'remind me' and 'remind me if they don't answer'
> where to set it? in the right click menu, more close to the top than to the bottom, and also on the buttons bar in the thread details in the top
>
> lets build this

## What exists

- Nothing about reminders or snooze. PLAN.md lists snooze as deferred, and plan 17 §226 notes that a future snooze must keep its threads out of the waiting count. A reminder doesn't take a thread anywhere, so that note doesn't apply.
- **Views and the sidebar.** `VIEWS` (core `types.ts`) is a closed tuple, and both stores implement each view (`VIEW_WHERE` in SQL, `VIEW_TEST` in IndexedDB, the conformance oracle). The sidebar shows Inbox and Starred, and folds Sent, Archive, All Mail, Spam and Trash into `MoreFolders` (`nav-more`, saved in `terno:sidebar-more`). "Revisar" is a list that is not a view: `reviewCategoryId` in app state, one bounded page in `fetchPage`, and no "select all" scope (`currentScope()` returns null).
- **The list** (`state/list.ts`). One `items` array feeds selection, keyboard navigation, the context menu and virtualization. `fetchPage` pages with a `(lastDate, id)` cursor. `loadNextPage` drops ids it has already seen. Filtered lists keep the open and checked rows (`keptIds`, `heldOnly`).
- **Opening a thread.** The `Reader` effect calls `scheduleMarkRead` after a 450 ms dwell. Split auto-selects the first row of a new list (`setListAutoSelection`, which skips `markSelectionIntent`), and that row is marked read too. Nothing records whether a selection was the user's or automatic.
- **Thread facts.** Messages carry `is_sent`, `is_draft`, `is_trash`, `is_spam`, `date` and `thread_id` (index `messages_thread(thread_id, date, id)` in SQL, `fk_thread_id` in IndexedDB). `threads.summaries(ids)` exists in both stores.
- **Merges and deletes.** SQL `mergeThreads` (`ingest.ts:151`) moves `thread_categories` to the surviving thread with `INSERT OR IGNORE`, and `ON DELETE CASCADE` removes the rest. IndexedDB does the same in `mail.ts:693`, with the `FOREIGN_KEYS` cascades.
- **Backend timers.** `BackendCore` sets one `setTimeout` for the next due time and re-arms it (`scheduleRetry`, `cooldownChanged`); every timer is cleared in `stop()`. `b.now()` is injectable. Wake from sleep reaches only `networkChanged(_, "wake")`, which returns early when `autoSync` is off. The web sends `sync.now {reason: "focus"}` on focus.
- **UI pieces.** `Popover` (`packages/ui`), `ToggleGroup`, `Input`, `Dialog` and the `ContextMenuSub` pattern from `thread-menu.tsx`. There is no date or time picker. The reader's `ToolButton` row has organize, mark, respond and print groups. Rows show their marks (category dots, paperclip, star) in a `marks` fragment.
- **Undo.** `registerUndo` with a snack (`undoAction`).

## Design

### 1. The model

A **reminder** belongs to one thread and has these fields:

- `dueAt`: when it comes back (ms).
- `kind`:
  - `"always"` (Remind me)
  - `"noReply"` (Remind me if they don't answer)
- `setAt`: when it was set (ms). A `"noReply"` reminder counts only replies after this time.

A thread has at most one reminder, and setting another replaces it.

A reminder is **pending** until `dueAt` and **due** from then on. A due reminder stays until one of these ends it:

- The thread is **opened** (§4).
- The user **archives, trashes, marks as spam or moves** the thread while it is due (§5).
- The user **clears** it.
- The thread disappears (its last message is gone).

A `"noReply"` reminder is **answered** when the thread has a message after `setAt` that is not yours, not a draft, and not in spam or trash: `is_sent = 0 AND is_draft = 0 AND is_spam = 0 AND is_trash = 0 AND date > set_at`. An answered reminder ends by itself, whether it was pending or due. The ending is noticed whenever reminders are read; nothing is written at ingest (§3).

Reminders are local: neither Gmail nor IMAP has an API for them, so they don't sync, and backups don't carry them (thread ids are local). The backend refuses more than 1,000 reminders at once, which bounds every read below.

### 2. Stores (SQLite and IndexedDB, behind `MailStore.reminders`)

- **SQLite** migration v34: `CREATE TABLE reminders (thread_id INTEGER PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE, due_at INTEGER NOT NULL, kind TEXT NOT NULL, set_at INTEGER NOT NULL) WITHOUT ROWID`.
- **IndexedDB** gets an early `reminders` table keyed by `thread_id`, with a `FOREIGN_KEYS` cascade to `threads`. `IDB_VERSION` goes to 21, which creates the store for existing databases, and `LOGICAL_SCHEMA` to 34.
- **Methods:**
  - `set(threadId, { dueAt, kind, setAt })`: an upsert that returns false if the thread is gone.
  - `delete(threadIds)`: returns the rows it removed, so Undo can put them back.
  - `list()`: every row, each with `answered: boolean` computed from that thread's messages. The bound of 1,000 rows keeps this cheap: one indexed probe per row in SQL (`EXISTS … messages_thread`) and one index read per row in IndexedDB. It waits for the late tables.
  - `count()`
- **Merges.** The reminder moves to the surviving thread when that thread has none. If both have one, the earlier `dueAt` wins. A delete cascades.

### 3. Backend

**RPC methods:**

- `reminders.list()` → `{ reminders: ReminderInfo[], now }`, where `ReminderInfo` is `{ threadId, dueAt, kind, setAt, due }`. Answered reminders are deleted first and never listed.
- `reminders.set({ threadIds, dueAt, kind })`:
  - `threadIds` holds at most 1,000 ids. `dueAt` must be finite. A past `dueAt` is accepted and means "due now"; the UI never offers one.
  - Every id gets the same reminder, with `setAt = now`.
  - Over the cap it refuses with `L("errors.remindersFull")`.
  - Returns the previous reminders of those ids so the renderer's Undo can restore them.
- `reminders.clear({ threadIds, reason? })` → the removed rows.
- `reminders.restore({ rows })`: Undo puts back exactly the captured rows, `setAt` included.
- `reminders.threads({ dueOnly, accountId? })`: summaries of the listed reminders' threads, leaving out threads in trash or spam. With `dueOnly`, only due ones are included, and `accountId` narrows them to one account. Due rows are newest due first; the Reminders list is soonest due first.

**The event.** `reminders: { reminders: ReminderInfo[], now }` is emitted after every change and whenever a reminder becomes due. A reminder becoming due also calls `notifyChanged([], true)`, so an open Inbox reloads.

**One timer.** `armReminders()` reads the list, deletes and announces answered reminders, and sets a single `setTimeout` for the soonest pending `dueAt`. The delay is capped at 2³¹−1 ms, and a cap that runs out simply re-arms. When the timer fires it emits the event and re-arms. `armReminders()` runs:

- at `start()`
- after set, clear and restore
- on `networkChanged(_, "wake")`, before the `autoSync` check, because reminders don't depend on sync (a timer runs late across sleep)
- on `sync.now` (focus on the web)
- when `notifyChanged` touches a thread that has a `"noReply"` reminder, through the in-memory set of reminder thread ids, coalesced to one pass per flush

Nothing runs when there are no reminders. The timer is cleared in `stop()`.

**Hooks into other handlers:**

- `threads.act` with `archive`, `trash`, `spam`, or a category move: the renderer clears due reminders itself (§5); the backend does nothing extra.
- Thread deletion cascades in the store. The next arm pass drops the id from the set.

### 4. Due reminders on top of the Inbox

Due reminders show at the top of the **plain Inbox**: all accounts or one account's, with or without a quick filter, but not a category tab, a folder, Revisar or a search. They show there wherever the thread lives (Inbox or Archive), because the user asked to see it again.

**In the renderer** (`state/list.ts`):

- `fetchPage` for the plain Inbox's first page asks for `reminders.threads({ dueOnly: true, accountId })` alongside the page. It puts those rows first and removes them from the page's own rows.
- Later pages and window refreshes drop the ids that are on top.
- `heldOnly` keeps the top rows under any quick filter.
- The top set is held in a module object, and it includes the open thread while it stays selected (§ below). The rows are ordinary items, so selection, j/k, the menu, checking and drag all work on them unchanged.

**The row.** A due row shows an accent bell in its marks, named "Reminder" for screen readers, and keeps its date. A pending reminder shows a muted bell in every list. Rows read this from a small renderer store, `useReminders` (threadId → info), which is filled from `reminders.list` at boot and from the `reminders` event. Nothing is added to the stores' list queries.

**Opened ends it.** A due reminder ends once the user opens the thread. That means an explicit selection (click, Enter, j/k, a palette or notification open) that stays for the same 450 ms dwell as mark-read. Split's passive auto-select of the first row doesn't count, so the reminder stays on top until the user really looks at it.

- `setListAutoSelection` records the id it selected in a module object (an object property, because of the React Compiler note). Any intent write clears it.
- `scheduleReminderDone(id)` runs beside `scheduleMarkRead` in the Reader effect and skips an auto-selected id.
- Once opened, the row stays where it is while it is selected. When the selection moves on, the next refresh puts it in its date position, or takes it out if it is archived. There is no snack, because opening is not an action to undo.

**The count.** The sidebar's Reminders row shows the number of due reminders in the unread tone, and nothing when there are none. The Inbox's unread count is unchanged.

### 5. Acting on a due row

If the user archives, trashes, marks as spam or moves a thread while its reminder is due, the reminder ends. Otherwise the row would jump back to the top on the next refresh.

- `act()` and the category move capture the due reminders among their ids and clear them once the action succeeds.
- Their Undo restores both the action and the reminders.
- Pending reminders are untouched. The classic flow, setting a reminder and then archiving, keeps the reminder.

### 6. Setting a reminder: the UI

**Presets** come from a pure function, `remindPresets(now: Date, kind)` in `@terno/core`, which is unit-tested across days and hours in local time:

- **Remind me:**
  - Later today: in 3 hours, rounded up to the hour. Offered only before 6 pm.
  - Tomorrow, 9:00
  - This weekend, Saturday 9:00: Monday to Thursday. On Friday through Sunday it becomes **Next week**, Monday 9:00.
  - Next week, Monday 9:00. Not shown when it would equal the previous entry.
- **If they don't answer:** In 1 day, In 3 days, In 1 week, In 2 weeks. Each keeps today's time rounded up to the next hour.

Each preset shows its moment on the right in the locale's short form ("Tue 9:00 AM", "Sat 9:00 AM"). Then comes **Pick date & time…**.

**The picker** (`RemindPicker`, lazy-loaded, one component used in two places):

- A segmented control: **Remind me** | **If no reply**. It switches the presets.
- The preset list. Arrow keys move through it and Enter sets.
- **Pick date & time…** expands an inline form in the same panel: a native date input and a time input, defaulting to tomorrow 9:00, and a **Set reminder** button. A past moment disables the button and says "Pick a time in the future."
- With an existing reminder, a header line reads "Reminds you Tue, Nov 3 at 9:00 AM" (plus " if they don't answer"), with a **Clear reminder** item.

**Where it is set:**

1. **The context menu.** Two submenus right after Reply/Reply all/Forward/Print, before the read/star block: **Remind me ▸** and **Remind me if no reply ▸**, each with its presets, then "Pick date & time…", which opens the picker in a dialog with that kind selected. With one thread that already has a reminder, both submenus start with its moment and offer **Clear reminder**. Multi-selection sets them all. A "select all N" scope disables them, because reminders need ids.
2. **The reader's toolbar.** A bell `ToolButton` (`action-remind`) in the mark group, after Star. It is filled and accented when a reminder is set, and its tooltip reads "Remind me" or "Reminder: Tue 9:00 AM", with shortcut `h`. It opens the picker in a `Popover` below it.
3. **Keyboard.** `h` (`thread.remind`) opens the picker for the selected thread: the reader's popover when the reader shows it, otherwise the dialog. `g r` goes to Reminders.
4. **The palette.** "Remind me…" (opens the picker) and "Go to Reminders".

**After setting**, a snack reads "I'll remind you Tue 9:00 AM · Undo", or "I'll remind you Tue 9:00 AM if they don't answer". Undo, or `z`, restores the previous reminders exactly. Clearing works the same way: "Reminder cleared · Undo". A failure keeps the previous state and says why.

### 7. The Reminders list

- **The sidebar row.** `Reminders` (Bell icon, `nav-reminders`) is the first row inside **More**. Like the other More rows, it shows while More is open or while it is the current list. It also shows when More is closed but a reminder is due, so a due count is never hidden.
- **App state** gets `reminders: boolean`. When true, `view` is `"all"`, with no account, category, folder or review.
  - `navigate({ reminders: true })` turns it on; every other `navigate` turns it off.
  - `listKey`, the list's reload subscription, `page.ts`'s `otherList`, the search-close check and `tabs.ts` include it.
  - `currentScope()` returns null: no "select all N", the same as Revisar.
- **The list.** `fetchPage` returns one bounded page from `reminders.threads({ dueOnly: false })`, soonest due first, with due rows at the top. Each row's date slot shows its reminder moment, with "if no reply" as a small muted suffix in the title attribute, and a bell. Quick filters don't apply; the header hides them, as Revisar does.
- **Empty state.** "No reminders. Right-click a conversation or press H to be reminded of it later."
- **Updates.** The list reloads on the `reminders` event.

### 8. Strings

Every string goes into `en` and `es` together:

- view, menu and palette items
- presets and the picker
- snacks
- `errors.remindersFull`
- the empty state
- screen-reader labels

## Tests

- **Core:** `remindPresets` across every weekday at 8:00, 17:59 and 23:30, and across a DST change (America/New_York, by setting `TZ` in the test). Kinds and labels.
- **Store conformance** (both stores, `conformance/reminders.ts`):
  - set, list and delete round-trip; set on a missing thread is false
  - `answered`: an inbound message after `setAt` counts; one of yours, a draft, spam, trash, or a message before `setAt` doesn't
  - the cascade when the thread's last message goes
  - a merge moves the reminder (earlier `dueAt` wins); reopen persists it
  - the SQLite migration test (v34) and the IndexedDB upgrade tests (new pinned versions)
- **Backend:**
  - with fake timers, setting `dueAt` in 1 h emits nothing until then, then emits `reminders` with `due: true` and `changed`
  - clear and restore round-trip
  - over 1,000 is refused
  - a `"noReply"` reminder ends when a reply is ingested, and the event fires
  - `reminders.threads` leaves out trash and spam and narrows by account
  - a wake re-arms even with `autoSync: false`
  - `stop()` clears the timer
- **Web unit:**
  - the list merge: due rows on top, removed from later pages and from window refreshes, kept under a quick filter, and kept while selected after being opened
  - auto-select does not end a reminder, an explicit selection does after the dwell
  - archiving a due row clears its reminder and Undo restores both
- **e2e** (`apps/web/e2e/reminders.spec.ts`, `@design`):
  - set from the context menu (Tomorrow): the snack shows, the row shows a bell, Reminders lists it with its moment, Undo removes it
  - from the toolbar popover with "If no reply" and a picked date and time
  - a reminder made due (dev-origin `reminders.set` with `dueAt = now`) shows at the top of the Inbox with the accent bell even when archived; opening it and moving on takes it out
  - the sidebar count, keyboard `h` and `g r`
  - axe in light and dark
- **Screenshots** of the menu, the popover and the list in light and dark.

## Perf

- No change to any list or count query. The plain Inbox's first page adds one RPC, bounded by the due count (at most 1,000) and answered by one indexed read per reminder.
- Idle: no reminders means no timer. Otherwise there is one timer for the soonest one; it never polls.
- The picker is lazy-loaded, so the entry chunk doesn't grow beyond the bell icons.
- A perf test in each store: `reminders.list` with 1,000 reminders over 50k threads stays under 20 ms.

## Out of scope

- Notifications when a reminder is due (the user asked for none).
- Sync across devices, and reminders in backups.
- Recurring reminders, and reminders on single messages.
- MCP tools.
- Search operators (`is:reminder`).

## Revisions after the Codex review

### Plan critique

These revisions replace the matching parts of the design above.

1. **"Not yours" needs more than `is_sent = 0`.** A copy of your own message that arrives without the Sent flag must not count as their answer. A message counts as an answer only when its `from_email`, normalized with `addressKey`, is not one of your addresses (`ownAddresses`, which each store's facts already keep). Conformance tests cover self-mail and an alias without the Sent flag.
2. **An open must be reactive.** Enter, or a click on the row that is already selected, leaves `selectedId` unchanged, so clearing a module flag would not re-run the Reader effect. The explicit open paths now call `noteOpen(id)`:
   - `pressRow`
   - `list.open`
   - `list.next` and `list.prev`
   - opening from the palette or a notification

   `noteOpen` bumps `{ id, seq }` in a small store, and the reminder's 450 ms dwell runs from that, not from `selectedId`.
3. **Automatic moves are not opens.** These don't count, so they never end the next row's reminder:
   - `leaveList`'s advance after an archive
   - a reload's auto-select
   - a moved selection

   A web unit test covers two due rows in a row.
4. **"Select all N" while reminders are on top.** The backend scope wouldn't count rows that are only there because of a reminder. The scope offer stays as it is (it is the Inbox's), and while the list has extra reminder rows, a scope selection leaves them out: the rows aren't checked (`thread-row`'s `inScope` tests membership), and the count names only the Inbox.
5. **Due reminders end in the shared action path.** `actOn` (`handlers.ts`) handles every archive, trash and spam: `threads.act`, `actScope`, the similar sweep and agents. After each slice's store act, it calls `store.reminders.endDue(chunk, now)`, which deletes only reminders with `due_at <= now` and returns them. The undo journal's entry carries those rows, and `threads.undo` restores them. No renderer-side clearing is needed.
6. **Atomicity.** The reminder end is the next store unit after the act, not part of it. If the end fails after the act committed, the effect is benign: the row shows on top again, the reminder still due, and nothing is lost. A reminder replaced in between with a future time survives, because `endDue` deletes only rows that are due.
7. **The cap is enforced atomically.** `reminders.put(rows, cap)` is one store unit. It dedupes the ids, counts the existing rows not among them, refuses the whole batch over the cap, skips missing threads, and returns the rows it replaced. `restore` uses the same call.
8. **A sweep never deletes a replacement.** `reminders.deleteExact(rows)` deletes a row only when its `set_at` and `due_at` still match. The answered sweep and an open both use it.
9. **Merges, cascades and account deletion.** Rather than tracking every store path that can touch a reminder, the backend re-reads reminders after each `changed` flush while any exist. That read is throttled to at most once per second, trailing, and an event is emitted only when the snapshot differs from the last one sent. Merges, cascades, answers and account deletion therefore all reach the renderer.
10. **No quick filter in Reminders.** `activeFilter()` returns undefined when `reminders` is on, as it does for Revisar, so All Mail's saved filter never applies. A web unit test enters Reminders with All Mail filtered to unread.
11. **Bounded work for long conversations.** The answered check runs in budgeted slices, `b.runBudgeted` over the reminder ids with `store.reminders.answered(ids)` per slice, so it never blocks for one big unit. In IndexedDB it reads the thread's message ids from `fk_thread_id` and checks each one's date first, which is cheap. Perf tests run in both stores with 1,000 reminders, including 20 conversations of 500 messages each.

### Code review

Codex reviewed `main...HEAD` and made eight findings. Each one is fixed, and each fix has a regression test.

1. **Undo overwrote a newer reminder.** Setting R1 over R0, then R2 from another window, then undoing R1 put R0 back over R2. `reminders.put` now takes `ifAbsent`, which only fills threads that have no reminder now. Undo of both a set and a clear uses it. Tests: store conformance and a backend test.
2. **An archive's Undo refused at the cap lost the reminders it ended.** `undoActs` now restores the reminders first. If the cap refuses them, it throws `errors.remindersFull` before taking any mail back, and the Undo stays in the journal for a retry. Test: backend.
3. **An open could end a replacement.** The dwell now sends the exact row it saw (`reminders.clear { exact }`, through `deleteExact`), and a reminder set in the meantime stays. Tests: backend and web unit.
4. **Reminders went stale after cascades and merges.** The backend now looks again after every `changed` flush while any reminder exists (throttled to once a second), not only when the change names a reminded thread. Test: backend (a thread deleted under its reminder with `notifyChanged([])`).
5. **Filing into a category hidden from the Inbox didn't end a due reminder.** The conversation left the Inbox and then came back on top. `categories.addThreads` and `categories.moveThreads` into a hidden category now end the due reminders of what they filed, and `categorize.undo` restores them first, again refusing at the cap. Test: backend.
6. **"Select all N" checked and acted on rows the Inbox shows only for their reminder.** That means archived rows, or rows in a hidden category. `onlyOnTop` (`state/list.ts`) now leaves them out of `scopeRows` and the rows' scope check. Test: web unit.
7. **The menu's "Remind me if no reply ▸ Pick date & time…" opened on the existing reminder's kind.** The kind asked for now wins, then the existing reminder's kind, then Remind me. Test: e2e.
8. **A due reminder's new time didn't reorder the top.** The comparison now includes each due reminder's time. Test: web unit.
