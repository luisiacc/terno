# 76 · A calm first sync

## Request

> lets work a bit on our first sync experience once they connect an account, lets make htat experience really simple and nice, when they connect their account , lets ask for how many days they want to fetch email from the past for that account, and use that. the default should be 180days.
>
> also here fix the port fields, needs to be a bit wider, the humbers look cutted
>
> also when fetching , lets fetch the most recent first and then the rest, and then have a nice indicator that's subtle indicating the the initial sync is in progress.

## What exists

- **The window.** Each account can have its own `syncWindowDays` (kept in its provider config, `AccountPrefs`), else the General setting (`settings.syncWindowDays`, default 90). `BackendCore.syncAccount` turns it into the sink's `windowStart`/`windowDays`. Both are editable in Settings (General and Accounts), but not when connecting: `accounts.addImap`, `accounts.connectGmail` and `accounts.connectGmailToken` take no window.
- **Order.** Gmail's full sync lists `after:<window>` newest first, 500 a page, and ingests 50 at a time: already newest first and progressive. IMAP reads the Inbox first, then the other role folders, then custom ones; within a folder it searches `SINCE <window>`, fetches the envelopes **oldest first** in batches of 250, and ingests the whole folder **once, at the end**: a large Inbox shows nothing until every envelope is read. Bodies (both stores) are already fetched newest first (`pendingBodies … ORDER BY date DESC`).
- **Indicator.** A ping on the account's dot in the sidebar while any pass runs (every sync, not only the first). Nothing says "your mail is still coming".
- **Ports.** `w-16` number inputs: with the input's padding and the native spinner, "993"/"465" are clipped.

## Design

### Asking for the window

- The Add account dialog gets one row above the sign-in choices: **"Download mail from" [Last 180 days ▾]**, applying to whichever way the user connects (Google or IMAP). Options: last 30, 90, 180 days, last year (365), last 2 years (730). Preselected: the General setting, which now defaults to **180**; a customized General value not in the list is added as its own option ("Last 45 days").
- The choice is sent as `syncWindowDays` (7–3650, optional) with `accounts.addImap`, `accounts.connectGmail` and `accounts.connectGmailToken` (only for a new account: a reconnect keeps its window). The backend stores it in the new account's config (`AccountPrefs.syncWindowDays`), so the first pass uses it and Settings → Accounts shows it. Omitted: unchanged behavior (the General setting).
- General's default moves from 90 to 180. Profiles that saved a value keep it; ones that never touched it read the new default (existing accounts already synced their window; a later resync would use 180).

### Newest first (IMAP)

- A **new account's** first pass (no cursor saved yet) starts with a **preview read** of the Inbox: its newest 250 UIDs in the window (the most recently arrived), ingested at once, then their bodies (`syncBodies`, newest first), so the list fills with recent mail with snippets within moments.
- The preview writes no cursor. The full read that follows is unchanged: it finds the preview's messages by their exact location (`locations.at`, the first check, before any key or twin logic) and goes on with the rest; other folders follow as before.
- A preview message that would need telling apart (a twin, only possible when an interrupted first pass left rows) is skipped and left to the full read.
- An interrupted first pass runs the preview again: what it stored is found by location, nothing new is written.

### The indicator

- **First sync** = an account that has never completed a pass (`syncState.lastSyncAt === null`) and isn't offline, signed out or in error.
- A quiet pill in the sidebar, where the connection and update pills live: a small spinner (none when motion is reduced or off), **"Downloading your mail"** and, below, **"Newest first · last 180 days"** (several accounts: "2 accounts"; one of several: its name). `role="status"` on the title only. It disappears when the pass completes. Lazy cost: none; it reads the accounts already in the store.
- The dot's ping stays as is (any pass).

### Ports

Each server gets its own full-width row (host, then port), the port `w-16 shrink-0`, centered `tabular-nums`, no spinner (`appearance: textfield`): five digits fit, and the host isn't cut either (it was, at half width, before this change).

### Copy

New `en`/`es` keys: `account.window.label`, `account.window.days` ("Last {days} days"), `account.window.year`, `account.window.years`, `firstSync.title`, `firstSync.detail`, `firstSync.accounts`.

## Tests

- **Backend** (`handlers` tests): `addImap` and `connectGmailToken` with `syncWindowDays` store it on the account and the first sync's sink gets `windowDays`; without it, `null` (General); reconnect leaves it.
- **Settings default**: 180 on a fresh profile.
- **IMAP** (`imap.int.test.ts`, ImapKit): a new account with 300 Inbox messages ingests the newest 250 (with bodies) before the rest; the end state equals a plain read (300 rows, one location each); a second pass runs no preview; an interrupted first pass re-run writes no duplicates; same Message-ID twice in the Inbox straddling the preview boundary keeps two rows.
- **Dialog** (unit): the select defaults to 180, a General value of 45 adds "Last 45 days", the chosen value is sent.
- **Pill** (unit): shown for `lastSyncAt: null` and syncing/idle, not for offline/auth/error or synced accounts; copy for one/several.
- **e2e**: connect an IMAP account against the dev backend picking 30 days; the pill shows, then goes; Settings → Accounts shows 30. Screenshots of the dialog and pill, light and dark.

## Perf

The preview costs one extra SEARCH and FETCH of ≤ 250 envelopes, once per account's life; the full read then short-circuits those 250 on the location index. No new timers; the pill renders only from the accounts list.

## Out of scope

Real progress numbers (messages so far / total), choosing the window per folder, Gmail ordering (already newest first).

## Revisions after the Codex review

The plan first ingested each 250-envelope batch of a folder as soon as it was read, newest UIDs first. Codex showed that breaks the folder read's identity rules: key lookups and twin groups would see rows the same folder wrote a moment earlier (collisions and ID-less twins decided differently), a later failure would leave written rows out of cached twin groups, held twins would still wait for the end, and reversing the order changes which duplicate gets the plain key. Replaced with the preview read above, which leaves the folder read untouched.

Also from the review:

- **What "first sync" means:** the account's first pass hasn't finished (all folders read, the first bodies fetched). Bodies beyond that come in later passes or when a message is opened; the pill doesn't wait for them.
- **Precedence:** the pill hides while the account has a connection problem (`connection` set: the connection pill speaks), needs a sign-in, or is in error; it comes back when a retry runs.
- **Web:** `connectGmailWeb` takes the window as an option; sign-in again (with `accountId`) never passes it. A Google address already connected reconnects and keeps its window.
- **Window shown:** the account's own (`syncWindowDays`, set at connect), else the General one. Several accounts: their count, no window.
- **Ports:** `shrink-0` as well as the width.
- **Import:** unchanged; a restored General window is the dialog's default.

## Codex code review, round 1

1. **A reset between the preview and the full read left stale places.** The preview kept no validity, so the full read couldn't see a reset. The preview's UIDVALIDITY is now written down in the cursor (`previewed`) as soon as the preview is in. The full read treats a change as a reset (`resetLocations`, re-identify), and clears the mark once it has read the folder. Saving also means a pass that stops after the preview doesn't preview again. Test: reset plus an expunge after the preview: the dropped message goes, and every place has the new validity.
2. **A body the server won't give blocked the rest.** The preview's bodies are now a head start, not a gate: a non-retryable failure there is left for the end-of-pass body fetch, and the full read goes on. Test: one message's body is always refused, and all 260 envelopes still come in.
3. **The interruption test didn't test interruption.** It now stops the pass right after the preview, with one twin below the preview's edge (UID 1) and one inside it (UID 272). It checks the sizes ingested (250, then 22, never a second preview), the saved mark and the twins.

All three tests fail on the code before these fixes.

## Codex code review, round 2

1. **`previewed` came back from JSON with a prototype.** A folder named `constructor` read an inherited function as the preview's validity, took it for a reset, and failed every later pass. It's now rebuilt with no prototype on load, like `mailboxes` and `resetPending`, and dropped once empty. Test: a `constructor` folder read on the retry after the preview stops (it fails before the fix).

Also: `settings-edits.test.ts` expected the old 90-day default.
