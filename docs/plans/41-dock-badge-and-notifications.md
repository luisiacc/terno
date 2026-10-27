# Plan 41: the Dock's unread count and system notifications for important mail

## Request (verbatim)

> makesure we also have the little count on the macos dock of the unread emails, very important, also start working on notifications for the macos system, we only notify if an important notification arrives that's not on spam and if an important notification, of course the user needs to be able to enable/disable system notifications on settings

Two features, shipped in this order: the badge first (its own commits), then notifications.

## 1. What exists

- **No badge, no notification.** Nothing calls `app.dock.setBadge`, `app.setBadgeCount`, `navigator.setAppBadge` or `new Notification` anywhere.
- **Counts.** `store.threads.counts(now)` (SQLite `getCounts` in `packages/db/src/queries.ts`, IndexedDB `getCounts` in `packages/idb/src/mail.ts`) returns `Counts.inboxUnread`: unread threads (`in_inbox = 1 AND unread_count > 0`) across all accounts, the number beside Inbox in the sidebar. The backend computes it in `BackendCore.sendCounts()` after every coalesced change (`notifyChanged` → `emitCounts`: the leading edge, then at most every `COUNTS_EVERY_MS`, trailing). It's sent to the renderer clients as the `counts` event, and the renderer's `boot.ts` stores it.
- **Inbox semantics.** Spam and Trash threads are never `in_inbox`. A filter that archives, trashes or marks read is applied inside the same ingest command (`store.sync.ingest`), so the stored row already reflects it. Terno has no "muted" state (nothing to exclude), and categories never take mail out of the Inbox.
- **Main ↔ backend.** The desktop backend is a utility process. The renderer talks to it over a direct MessagePort, and main only hears what goes over the parent port (`apps/desktop/src/ipc.ts`). The backend already reports one thing to main this way: `policy`, through `BackendCoreOptions.onPolicy`. The web backend is a dedicated worker (`apps/web/src/web/worker/backend.worker.ts`) that talks only to its tabs.
- **Arrivals.** Providers hand new mail to the backend's `SyncSink.ingest`. `ingestSliced` returns the ids of messages it actually *inserted* (not re-seen ones). A sync pass ends in `syncAccount` with `status: "idle", lastSyncAt` on success.
- **Who is a person.** `automatedLevel` (`packages/core/src/people.ts`, plan 17) reads `from_email`, `list_id`, `is_bulk` (List-Unsubscribe / Precedence / Auto-Submitted), Gmail category labels and spam: 0 means a person, 1 means a person only if you have written to them, and 2 means never a person. `correspondents(email, own, written)` exists in both stores.
- **Gmail labels** are stored per message (`gmail_labels`, JSON text) and include `IMPORTANT` when Gmail marked the message.
- **Settings** live in the backend (`AppSettings`, `DEFAULT_SETTINGS`, `settingsPatch`), and the General tab draws them (`general-tab.tsx`).

## 2. The Dock badge

### 2.1 What it counts

**The sidebar's Inbox number, across all accounts.** That is unread *conversations* in the Inbox of every account: the same `Counts.inboxUnread` the sidebar shows, so the two never disagree. Spam, Trash and archived mail never count (they aren't in the Inbox), and mail a filter archived or marked read doesn't count either. Muted doesn't exist in Terno.

There is no per-account choice: Apple Mail's default is "Inbox only", and one number matches the unified Inbox. A per-account option is out of scope.

### 2.2 How it reaches main (no new query, no polling)

- `BackendCoreOptions.attention?: AttentionHost` with `badge(count: number)` and `notify(notice: MailNotice)`, the same shape as `onPolicy`.
- `sendCounts()` hands the count it just computed for the sidebar to `attention.counts(counts)`. That's not a second query: the badge rides on the sidebar's, already coalesced (leading edge, then at most every `COUNTS_EVERY_MS`).
- The `Attention` module calls `host.badge(n)` only when the shown value changes. It sends 0 when "Show unread count in the Dock" is off.
- **At start:** `Attention.start()` reads the counts once and reports them. A restarted backend (crash, update) puts the right number back within its first second. Main keeps showing the last number while the backend restarts.
- **Desktop:** `backend-entry.ts` relays `{ type: "badge", count }` over the parent port. Main validates it (a safe integer ≥ 0) and calls `app.dock.setBadge(badgeText(count))`.
- **`badgeText`:** "" at 0 (clears it), the exact number up to 9,999, and "9999+" above that. A five-digit badge covers the icon, and nobody triages by the exact count at that size.
- **Web:** the renderer already receives `counts`. In a browser that has `navigator.setAppBadge` (an installed PWA in Chromium), it calls `setAppBadge(n)` or `clearAppBadge()` when the number or the setting changes. Otherwise it does nothing. No backend change is needed for the web badge.

### 2.3 Setting

**"Show unread count in the Dock"**, on by default (`dockBadge: boolean`), in a new **Notifications** group in Settings → General, beside the notification switch. Turning it off clears the badge at once.

On the web, the row shows only where `setAppBadge` exists, labelled "Show unread count on the app icon". A switch that does nothing is worse than none.

## 3. System notifications

### 3.1 "Just arrived" (the arrival filter)

A message is a candidate only if **all** of these hold:

1. **It was inserted by a sync pass of an account that is *primed*.** An account becomes primed when it completes a sync pass in this backend's lifetime. This means:
   - **No initial sync:** a new account's first pass is unprimed, and so is a first sync that keeps failing.
   - **No catch-up at launch:** the first pass after Terno (or the web tab's worker) starts is unprimed. Mail that came while Terno was closed is in the Inbox and on the badge, and notifications are for what arrives while Terno runs. A backend that crashed and restarted gives up at most one pass's notifications, which is better than a flood.
   - Imports and restores never go through the sync sink.
2. **Its date is within the last 24 hours.** This keeps out backfill when the sync window grows, and mail newly added to the Inbox that is older than the window. A Mac that slept overnight still gets its overnight mail, summarized (§3.4).
3. **It is not yours:** not `is_sent`, not a draft, and not from one of your addresses (accounts plus `correspondents.own`).
4. **It is still unread, in the Inbox, and not in Spam or Trash when it is looked at.** It is read from the store after a short gather (§3.4), so the check covers all of these:
   - read on another device before it synced;
   - read in Terno during the gather;
   - archived, trashed or marked read by a filter;
   - "not in Inbox" for an IMAP folder other than INBOX.

### 3.2 "Important" (the rule)

A candidate is important if **either**:

- **(a) It's from a person**, exactly as the People filter decides (plan 17, `senderIsPerson`): `automatedLevel` is 0, or 1 and you have written to that address. Not list or bulk mail, not Promotions, Social or Forums, not a no-reply or role address you never wrote to.
- **(b) Gmail marked it Important** (`IMPORTANT` label), it isn't in Promotions, Social or Forums, and it carries no list or bulk headers. This catches what Gmail's model rates important and isn't from a person: a bank's fraud alert, a security code, a delivery problem. Newsletters Gmail rated Important still stay quiet.

Why this rule:

- **It's explainable in one sentence:** "Terno notifies you about new Inbox mail from people, and mail Gmail marks important that isn't a newsletter."
- **It reuses tested signals:** plan 17's person rule and the stored Gmail labels. It's deterministic, local, and runs on columns already in the row.

Alternatives not taken:

- **"Waiting for your reply"** is computed later by the facts engine, and it is a subset of (a).
- **Starred:** new mail is almost never starred on arrival.
- **VIP:** doesn't exist in Terno.
- **Categorizer confidence:** opaque, and it can be off.

The rule is a pure function, `importance(row): "person" | "gmail" | null` in `packages/core/src/attention.ts`, with a table of cases.

### 3.3 Reading the candidates: `store.sync.arrivals(messageIds)`

A new store method in both stores, one read unit. For each id that still exists it returns:

- `id`, `threadId`, `accountId`, `date`;
- `fromName`, `fromEmail`, `subject`, `snippet`;
- `isRead`, `isSent`, `isDraft`, `inInbox` (the message's flag and its thread's), `isTrash`, `isSpam`;
- `listId`, `isBulk`, `gmailLabels`;
- `own` and `written` for the sender's `addressKey`.

The ids are bounded: at most 200 per call, the newest kept (§3.4). SQLite reads by primary key (`json_each` of the ids, joined to `threads` by `id`) plus one `correspondents` lookup per distinct sender. IndexedDB reads with `get` on each id. It costs O(ids) and is independent of mailbox size. Conformance tests cover both stores.

### 3.4 Gathering, grouping and rate limiting (`Attention`, backend)

- **Collect.** While notifications are on, `syncAccount`'s sink passes inserted ids from primed accounts to `attention.arrived(ids)`. When notifications are off, nothing is collected, no timer runs, and no read happens.
- **Gather for 1.5 s** after the first id, so a pass's slices (50 messages each) become one decision. Then one `arrivals()` read, the arrival filter, the importance rule, and the newest-first sort.
- **Rate limit.** At most one notification every 15 s. Important mail that comes during the gap is held and merged into the next notification when the gap ends. Pending ids are capped at 200 (newest kept): a burst bigger than that is a migration, not news.
- **Group** into one notice per flush:
  - **1 message:** title is the sender's name (or address), subtitle the subject, body the snippet (up to 140 characters). A click opens that conversation.
  - **Several from one sender:** title is the sender, subtitle "3 new messages", body the newest subject. A click opens the newest conversation.
  - **Several from different senders:** title "5 new messages", body "From Ana, Bob and 3 others". A click opens the Inbox.
- **Notice payload** (`MailNotice`): `{ id, count, threadId | null, senders: string[] (≤ 3), senderCount, subject, snippet }`. It is structured, not text: main and the renderer word it with `noticeText()` in the user's current language (`t()`, en and es).

### 3.5 Delivery

**Desktop.** The backend calls `attention.notify(notice)`, and `backend-entry.ts` relays `{ type: "notify", notice }` to main. Main (`apps/desktop/src/attention.ts`):

- **Validates:** strings capped at their lengths, ids safe integers, at most 3 senders.
- **Shows** `new Notification({ title, subtitle, body, silent: false })` when `Notification.isSupported()`. It keeps a reference (bounded at 20) so the click handler survives garbage collection.
- **On click:** shows and focuses the window. If none is open (macOS keeps the app running), it creates one. Then it sends `terno:open-thread` with the thread id, or null for the Inbox.
- **A window that is still loading** asks for it once its page listens (`onOpenThread` in the preload sends `terno:open-ready`, the same handshake as the draft flusher), so the open is never lost.
- **The renderer** goes to the unified Inbox (`navigate({ view: "inbox", accountId: null })`), then calls `openThread(id)`.

**Web.** There is no host hook, so the backend emits the RPC event `notify` (renderer origins only, never agents). The tab shows `new Notification(title, { body, tag: notice.id })` only if:

- notifications are on, and the permission is `granted`;
- `document.visibilityState === "hidden"`: a visible tab already shows the mail.

The `tag` makes two tabs of the same mailbox replace each other's notification instead of doubling it. A click focuses the tab and opens the thread the same way. The web is limited to an open tab: nothing is pushed while no tab runs (`backgroundSync: false`), and there is no service-worker push.

### 3.6 Settings

- **"System notifications"** (`notifications: boolean`), **on by default**. Hint: "New mail from people, and mail Gmail marks important, while Terno is open. macOS asks the first time." The badge switch sits under it in the same group.
- **Permission.**
  - **Desktop:** macOS asks the first time Terno posts. If the user said no, the switch can't tell (Electron has no permission query on macOS). The hint names where to change it: System Settings → Notifications → Terno.
  - **Web:** the switch reads on only when the setting is on *and* the permission is `granted`. Turning it on asks for permission inside the click. If permission is denied, the setting stays off and a snack explains how to allow it in the site settings. Where `Notification` doesn't exist, the row is hidden.
- **No "Show message preview" switch.** macOS already has a per-app "Show previews: Always / When Unlocked / Never" (default: When Unlocked), which is exactly the lock-screen question, and it applies to Terno's notifications. A second switch in Terno would only duplicate or contradict it. The hint points to it. On the web the browser's notification settings play the same role.
- Turning notifications off drops what's pending and clears the timers.

### 3.7 Privacy and resources

- **Notifications are local OS notifications only.** No network is involved, local mode included, and nothing is logged beyond counts. Diagnostics get `notify.shown { count }` (a number), never a name or subject.
- **Idle means idle.** No timer runs unless a gather or a gap is pending. Collection is one `if` per ingest slice. The badge adds no query.
- **Packaged app.**
  - The packaged app is a real bundle (`dev.terno.mail`), signed with a stable identity, or ad-hoc for local builds. macOS lists it under its own name in System Settings → Notifications.
  - `pnpm dev` runs `Electron.app`, so dev notifications appear as "Electron" (or not at all if Electron was never allowed).
  - Notifications from an ad-hoc-signed copy depend on macOS accepting that signature. This is documented in the smoke's header, and the smoke asserts the calls, not the OS's rendering.
  - Nothing is needed in `Info.plist` for local notifications.

## 4. Tests

**Unit (vitest)**

- `core/attention.test.ts`:
  - **`importance`:** a table of person, role address written-to and not, no-reply, list, bulk, Promotions, Gmail `IMPORTANT` with and without bulk, spam.
  - **The arrival filter:** too old, yours by `is_sent` and by address, draft, read, not in the Inbox, trash, spam.
  - **`summarize` / `noticeText`:** one message, one sender, several senders, more than 3 senders, empty subject, long snippet.
  - **`badgeText`.**
- `backend/attention.test.ts` (fake store, clock and timers):
  - the badge only on change, and 0 when it's off, at start and after a setting change;
  - the gather merges slices;
  - **the gap:** at most one notification per 15 s, with held mail merged;
  - **the cap:** 200 ids, the newest kept;
  - **off:** nothing collected, no timer, no read;
  - not primed means nothing.
- `backend/notify.int.test.ts`, through the real `Backend` with a fake host and a scripted provider:
  - the first pass (initial sync) notifies nothing;
  - a second pass with a person's mail notifies once;
  - its read-elsewhere twin, spam, own sent mail, a filter that archives and list mail stay quiet;
  - **restart:** a new backend's first pass stays quiet;
  - the badge follows reads and arrivals.
- `imap.int.test.ts`: real imapflow ↔ imapkit. After the initial sync, a message added to INBOX arrives through IDLE and reaches `host.notify`.
- Store conformance (`sync.arrivals`), in SQLite and IndexedDB: the fields, own and written, the thread's Inbox flag after a filter archive, and missing ids skipped.
- `apps/desktop/src/attention.test.ts` (fake electron):
  - validation;
  - badge text;
  - notification options;
  - a click focuses or creates a window and delivers the open, with the open queued until the page is ready;
  - the live set stays bounded.

**e2e (`apps/web/e2e/notifications.spec.ts`)**

- Settings → General → Notifications: both switches persist. Tagged `@design` so the row holds in every design.
- **Web permission.** `Notification` is stubbed: turning the switch on asks, and a denial leaves it off with a snack.
- **A real arrival.** The test provider's sync delivers a person's message on its second pass. With the tab "hidden" (stubbed `visibilityState`), one `Notification` is created with the sender as title. Clicking it opens the conversation. A visible tab gets none.
- **Badge.** With `navigator.setAppBadge` stubbed, the call follows `counts.inboxUnread`, and turning the setting off clears it.
- **Screenshots** of the Notifications group in light and dark for macOS, Lumen and Atelier, copied to `/tmp/unica-scratch/notify/`.

**Desktop smoke (`apps/desktop/e2e/notify.smoke.ts`, the packaged app)**

- **Setup:** a demo profile plus a synthetic IMAP account on an in-process imapkit, with a local smtp-server for its verification. The packaged demo may use plain IMAP to loopback only behind `TERNO_TEST_IMAP_INSECURE`, honoured only in demo mode, like `TERNO_TEST_SMTP_PORT`.
- **Badge:** `app.dock.getBadge()` equals the sidebar's Inbox count, and it clears when the switch is off.
- **Notifications:**
  - After the account's first sync, a person's message added to INBOX produces one `Notification.show` (recorded by patching `Notification.prototype.show` in main), with the sender as title.
  - Emitting its `click` focuses the window and opens the conversation.
  - A list message produces nothing.
- **Screenshot:** a `screencapture` of the real banner if macOS lets the copied bundle post (best effort).

**Perf.** No query is added to a hot path: the badge uses the sidebar's count. `sync.arrivals(200 ids)` gets a gate in both stores at 50k threads (bounded, independent of mailbox size). The existing `load.perf`, `pnpm test:perf` and `test:ui-perf` suites must hold.

## 5. Out of scope

- A per-account badge or notification choice.
- Withdrawing a notification when its mail is read elsewhere.
- Notification actions (Archive, Reply from the banner).
- Do Not Disturb or Focus handling, which macOS already applies.
- Web push with no tab open.
- A VIP list.
- Sounds other than the system default.

## 6. Strings (en and es together)

| Key | English |
| --- | --- |
| `settings.general.notifications` | Notifications (group title) |
| `settings.general.notify` | System notifications |
| `settings.general.notify.hint` | Hint (desktop) |
| `settings.general.notify.hintWeb` | Hint (web) |
| `settings.general.notify.denied` | Snack when the web permission is denied |
| `settings.general.badge` | Show unread count in the Dock |
| `settings.general.badge.hint` | Hint for the badge switch |
| `settings.general.badgeWeb` | Show unread count on the app icon |
| `settings.general.badgeWeb.hint` | Hint for the web badge switch |
| `notify.count` | Plural: "# new message" / "# new messages" |
| `notify.from.one` | "From {name}" |
| `notify.from.two` | "From {a} and {b}" |
| `notify.from.many` | "From {a}, {b} and # others" (plural) |
| `notify.noSubject` | "(no subject)" |

## 7. Commits

1. **Badge:** `AttentionHost` and `badge` (core types, backend `Attention` badge half, `sendCounts` hook, start), the IPC relay, main's `setBadge`, the setting and its UI (en/es), the web `setAppBadge`, and tests.
2. **Notifications, core:** `importance`, `summarize`, `noticeText`, and the store's `sync.arrivals` with conformance.
3. **Notifications, backend:** collection in `syncAccount`, priming, gather, gap, cap, and the integration tests.
4. **Notifications, desktop:** main's notifications, the click-to-open handshake, the preload, and the smoke.
5. **Notifications, web:** the `notify` event, the tab's Notification, the permission flow, e2e, and screenshots.
6. Codex review fixes, each with its regression test.

## 8. Revisions after the Codex review

The read-only critique (`/tmp/unica-scratch/notify/plan-review.txt`) made 12 points. Every one was accepted, either as a design change or as documented behaviour.

1. **"Inserted in a primed account" isn't proof of a live arrival.** Gmail's full resync after expired history and an IMAP UIDVALIDITY reset insert recent historical mail.
   - **Change:** `SyncSink.ingest(messages, { live })`. Only a provider can tell, so it says so. Gmail marks only `incremental()`'s history additions live. IMAP marks only new UIDs past a stored `uidnext` with the same UIDVALIDITY (not the first sync, not a reset).
   - Anything not marked live (the demo provider, imports, attachment re-fetches) never notifies.
   - IMAP's stored date prefers the Date header. The 24-hour window stays as a second guard: a message whose Date is more than a day old won't notify, and that is documented.
2. **A gather from the first insert can't see the end of the pass.** IMAP scans Sent after the Inbox and fetches bodies (body filters run in `setBody`) in the same pass, and Gmail applies label changes after additions.
   - **Change:** candidates are evaluated only after the pass that inserted them has ended (success or failure), then reread from the store at delivery. A read flag, a body filter's archive, or an alias learned later in the pass are all seen.
3. **"Person" alone is too loose, and `is_bulk` drops transactional alerts.** `automatedLevel` is 0 for any unknown human-looking address, and `bulkHeaders` counts Auto-Submitted as bulk.
   - **New rule.** A candidate is important if any of these holds:
     - **(a) You have written to the sender** and the sender isn't a machine (`automatedLevel` ≤ 1).
     - **(b) A reply in a conversation you took part in** (the thread has your sent mail), from a person (`automatedLevel` 0, or 1 and written to).
     - **(c) Gmail marked it `IMPORTANT`**, it carries no `List-Id`, and it isn't in Promotions, Social or Forums. `is_bulk` is not used here, so a security code with `Auto-Submitted` still notifies.
   - A stranger's first mail notifies only when Gmail rates it important. That is the price of "only important".
   - The tests cover a cold sender, a role address, a list, an Auto-Submitted alert and a reply in your thread.
4. **Ids returned after the whole input finishes can't be collected per slice, and the newest 200 by id isn't the newest by date.**
   - **Change:** `ingestSliced` reports each committed slice's inserted ids as it goes.
   - Pending ids are capped at 2,000 per pass (a bigger live pass isn't news).
   - The evaluation reads them in chunks of 200, filters each chunk, and keeps only important rows. Nothing important is evicted by newsletters.
5. **Settings lifecycle.**
   - The cached flags are loaded before any sync (`start()` is awaited before accounts start) and refreshed after `settings.update` persists.
   - A generation counter makes an evaluation that was already reading when notifications went off deliver nothing.
   - `stop()` and account removal drop pending work.
   - Other windows learning of the change is out of scope, the same as every other setting today.
6. **Badge semantics are conversation-level.** It is the sidebar's number: unread conversations in the Inbox, where a conversation counts when any of its non-trash messages is unread and the conversation is in the Inbox. This is documented as parity with the sidebar, and no store semantics change.
7. **Start cost.** There is no separate badge query: `start()` publishes through the existing coalesced counts publisher (one counts read, the same as a bootstrap). Setting changes use the cached counts. `load.perf.test.ts` and `pnpm test:perf` cover counts at 50k.
8. **The click-to-open race.** `navigate()` reloads the list, and that reload selects row 0.
   - **Change:** one renderer operation, `openFromNotice(threadId)`:
     1. close any dialog;
     2. go to the unified Inbox;
     3. select the thread;
     4. reload with `keepSelection` (it supersedes the navigation's own reload).
   - The open listener is registered only at the end of `boot()`, so main's queued open waits for history restore and the first list.
9. **Electron.**
   - Listeners are registered before `.show()`.
   - `failed` and `close` release the reference, and `notify.shown` is recorded from the `show` event.
   - Eviction past 20 only drops Terno's reference: the banner stays in Notification Center, and a click on an evicted one activates Terno without opening a conversation (documented).
   - The smoke says what it proves: the calls and their payload (mocked), plus a best-effort screenshot of a native banner.
10. **Web: the saved preference vs. permission and capability.**
    - At boot and when the permission is revoked, a web tab whose permission isn't `granted` saves `notifications: false`. The worker then does no notification work, and the switch shows the truth. Turning it on asks first.
    - `new Notification` is wrapped: where the constructor throws (mobile), nothing is shown and the row is hidden.
11. **Web takeover.** The tag is scoped to the mailbox (`<mailbox>:<id>`). A page that loses its backend (takeover, worker restart) closes the notifications it created, so a click never drives a page without a backend.
12. **Previews.** Browser permission isn't consent to previews, and the web has no lock-screen control.
    - **Change:** a **"Show sender and subject"** sub-option (`notificationPreview`, on by default, the same as Mail).
    - When it's off, the *backend* redacts the notice before it leaves: `senders: []`, `subject: ""`, `snippet: ""`. The text is then only "New mail" / "3 new messages".
    - A test checks the payload carries no sender, subject or snippet.
    - On macOS the system's own "Show previews" still applies on top.


## 9. What the Codex code review changed

The review (`/tmp/unica-scratch/notify/code-review.txt`, on `d47555a..0cd1507`) made 10 findings. Every one was fixed with a regression test that fails without the fix: the renderer ones were checked by running them against the pre-fix files.

1. **Import lost the notification preferences** (the web's storage switch goes through export/import), which could turn previews back on.
   - **Fix:** a file carries `notifications` and `notificationPreview` *off, never on*, like local mode. `dockBadge` travels both ways.
   - `Attention` refreshes after an import.
   - Test: `settings-edits.test.ts`.
2. **Main rejected redacted notices** (`senders: []`), so turning the preview off silenced desktop notifications.
   - **Fix:** `parseNotice` accepts zero senders.
   - Test: `attention.test.ts` (desktop), redacted through `notify()`.
3. **A pass's end doesn't mean body filters ran:** IMAP fetches at most 500 bodies per pass.
   - **Fix:** `ArrivalRow.bodyPending` (the body is still to come, the same rule as IMAP's capture). While any enabled filter reads bodies, such mail waits for the account's next pass, up to `BODY_WAITS` (3) passes, then it is let go quietly.
   - Without such a filter it is said at once.
   - Tests: backend unit tests and store conformance.
4. **Removing an account didn't cancel its work.**
   - **Fix:** an epoch per account, bumped by `forget()`.
   - A pass that began before it, mail already queued and a screen in flight all drop it. The delivery re-checks the epoch.
   - Tests: three cases.
5. **Later newsletters could evict queued important mail**, because the global pending set was trimmed before the rule ran.
   - **Fix:** each finished pass is *screened* (read in chunks of 200, filtered) into a bounded queue of important mail only (200, newest by date). The queue is read once more when the notice is due.
   - Test: an important message, then a 2,000-newsletter pass in the gap.
6. **The smoke's plain-IMAP seam applied to every account.**
   - **Fix:** `imap-seam.ts` uses the insecure registry only for an account whose IMAP *and* SMTP hosts are loopback. Any other account keeps TLS and certificate checks.
   - Test: `imap-seam.test.ts`.
7. **Split, a selection in the Inbox:** the click left the selection bar in the reader.
   - **Fix:** `openFromNotice` ends the selection (checked and scope).
   - Test: `notify.test.ts` (web).
8. **List, a page covering the Inbox:** a summary's click (no thread) left it covered.
   - **Fix:** `closePage()` (a draft is kept the way Esc keeps it).
   - Tests: a thread page and a new-message page.
9. **A browser whose page constructor throws** (mobile) kept the switch on and the backend working.
   - **Fix:** the first refusal marks page notifications unsupported, saves `notifications: false` and hides the row.
   - Test: e2e with a throwing stub.
10. **The switch cached the permission:** a grant in the site's settings while Settings was open left it stuck.
    - **Fix:** the permission is read live on every render, repainted on the Permissions API's `change` event and after each toggle.
    - Test: e2e.

**Re-review of the fixes** (`/tmp/unica-scratch/notify/code-review2.txt`, on `12ef459`) found 3 more, all medium. Each is fixed with a regression test, and each test fails on `12ef459`:

1. **Two passes ending back to back both retried the same body-waiting message**, which could produce a second notice. Now a screen takes the waiting ids when it *runs*, so only the first retries it.
2. **A flush due between a screen's chunks saw the queue past its bound** (201 ids). Now a screen collects privately and merges and trims in one step.
3. **A body filter turned on during the gap was ignored at delivery.** Now `flush()` checks the filters again and puts body-pending mail back to wait.
