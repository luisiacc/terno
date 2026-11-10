# Plan 176: quick checks while the window has just gained focus

## Request (verbatim)

> When someone goes and focuses their email in the screen, it's because they probably expect an email, like a verification code, a link, or something. When they do that can we increase the polling frequency that we have (every 5 seconds) to fetch new emails every 5 seconds? When they start focusing on the email, we can do that for 1 minute after they refocus and then we just start fetching normally. What do you think about that?
>
> ok proceed to build this, document it so when outlook accounts are in we do this with outlook accounts too

## What exists

- **The poll:** the backend checks every account every 2 minutes (`syncIntervalMs: 120_000`, `BackendCore.tick`, `packages/backend/src/core.ts`).
- **Push:** a provider with `watch` (`MailProvider.watch`, `packages/mail/src/types.ts`) calls back when its server says something changed. IMAP has it (IDLE on the Inbox), so new IMAP mail already shows within a second or two. Gmail has none: Gmail's push goes through Google Cloud Pub/Sub, which needs a server or cloud setup on our side, so a Gmail account learns of new mail only from the 2-minute poll. A verification code can wait up to two minutes.
- **A Gmail pass** reads history since its cursor (`/history`, 2 quota units of the 6,000 a minute Gmail allows, `gmail-quota.ts`), but also retries pending capture repairs, reconciles pending flag snapshots, captures attachment bodies, runs a backfill chunk (plan 101) and reads `/labels` when stale (plan 68). Each pass writes the account's status twice ("syncing", then "idle" with a new `lastSyncAt`), and each write publishes the whole account list.
- **Focus today:** `apps/web/src/lib/network.ts` calls `sync.now { reason: "focus" }` when the window comes back, but only if an account is offline or needs a sign-in (plan 20, plan 25). A healthy account isn't checked when the user comes back.
- Every renderer connection has its own `clientId` (desktop: one per window; web: the page), and `onDisconnect` hears when one goes. Desktop's main tells the backend about the network directly (`MainToBackend`, `apps/desktop/src/ipc.ts`).

## Design

**The rule.** When a Terno window gains focus, every account whose provider takes quick checks is checked at once and then every 5 s, until a minute has passed since that focus or no Terno window has focus any more. Then the 2-minute poll is all there is again. A quick check is a lighter pass than the poll's: new mail and changes since the cursor, and nothing else.

**Which providers: an explicit opt-in.** `MailProvider.quickChecks?: true` says the provider honours `SyncSink.quick` and that a quick pass with nothing new is one small request. Gmail sets it. IMAP doesn't: IDLE already pushes new Inbox mail. The doc comment on `quickChecks` is where a new provider's author reads the rule.

**Outlook (and any provider to come).** An Outlook provider built on Microsoft Graph has no push a desktop client can use (Graph's change notifications need a public webhook), so it should take quick checks like Gmail: implement `SyncSink.quick` as a delta query on the Inbox since the stored delta link (one small request when nothing changed), then set `quickChecks: true`. Nothing in the backend changes for it. Until its quick pass is that cheap, it leaves `quickChecks` unset and is only polled. An Outlook account over IMAP gets IDLE and is skipped like IMAP. A test like `gmail-quick-pass.test.ts` proves the new provider's quick pass reads one request and does no maintenance.

**The quick pass (`SyncSink.quick`).** Only history since the cursor: Gmail's `quickPass` reads the cursor, then `incremental`, keeping the cursor's backfill progress on the save as every pass does. Repairs, flag snapshots, attachment captures, backfill and `/labels` wait for an ordinary pass. With no completed cursor (a first sync) or a reconciliation under way, or when history expired or overflowed, it calls `again()` (an ordinary pass soon) and stops, so a quick check never starts a full reconciliation.

**Quiet in the account's status.** `syncAccount(…, { quick: true })` doesn't write "syncing", doesn't move `lastSyncAt` and doesn't read the folders. It ends with the status a healthy, synced account already has, so `AccountStatus.publish` finds nothing changed: a check with nothing new writes no status and publishes no account list. New mail is announced as it always is (the store's change events and plan 41's notices). A quick check that fails ends like any failed pass (status, backoff, the poll), which takes the account out of quick checks.

**Which accounts a check reaches** (`BackendCore.quickCheck`). Nothing before `start()` or with `autoSync` off (no poll, nothing to hurry), or while stopped. For each account: its provider has `quickChecks`, it is synced and healthy (status idle, synced at least once, no error, no connection trouble, no sign-in needed, no first-sync or backfill progress), no pass is running (a quick pass behind a running one would read the same mail), and `connectivity.canSync` (online, not waiting for a retry). Admission is checked again right before the pass starts, since the account and provider reads await: a blur, going offline or another pass may come in between. An account that failed (retryable or not) is no longer idle, so it isn't asked again every 5 s: its retry or the poll goes first.

**The timing, in one module.** `packages/backend/src/quick-checks.ts` (`QuickChecks`), like `Connectivity`: timers injected, tested without a backend.

- `focus(clientId, true)`: the client joins the focused set and the minute starts over (`until = now + 60 s`). If no check is scheduled, one runs now, or at the last check + 5 s if that is later, so switching windows quickly isn't a burst of requests.
- `focus(clientId, false)`, or that client disconnecting: it leaves the set. With no client focused, the timer goes at once.
- Each check asks the core (`hooks.check()`), then schedules the next 5 s later if that is still within the minute. Otherwise no timer is left: idle is idle.
- `running`: a client is focused and the minute isn't over, which the core checks again before each pass.
- Tracking clients rather than one flag means two windows' focus and blur can arrive in either order.

**Where focus comes from.**
- **Desktop:** main, from the OS (`app` `browser-window-focus` / `browser-window-blur`, then `BrowserWindow.getFocusedWindow()` among Terno's windows). The page can't tell: a click into a mail's HTML frame takes focus away from the page without the window losing it, and coming back to Terno then focuses the frame, not the page. `FocusReporter` (`apps/desktop/src/window-focus.ts`) reads the focus 50 ms after a change, so a switch between two Terno windows (a blur, then a focus) isn't told as Terno losing focus, and tells only changes. A (re)started backend gets the focus in its `init` (`focused`), and `backend-entry.ts` applies it after `start()` as client `"main"`. Later changes are `{ type: "focus" }` messages.
- **Web:** the page. `network.ts` (web build only) sends `sync.focus { focused }` on `focus`, `blur` and `visibilitychange`, with focused meaning visible and `document.hasFocus()`, only on a change, once at start, and again whenever the RPC transport (re)attaches. The mail-frame limitation stays on the web, which is low priority.

**RPC.** `sync.focus` (`packages/core/src/rpc/contract.ts`): `{ focused: boolean }`, keyed by the caller's `clientId`. Not open to MCP agents (not in `MCP_ALLOWED`).

**What the user sees.** Mail arriving while they look, within about 5 s instead of up to 2 minutes. No new UI and no new copy, so no strings.

**Privacy and resources.** Only the user's own mail server, which the poll already reaches, while the user is looking at Terno. At most 13 `/history` reads per Gmail account per focus (26 units of Gmail's 6,000 a minute), each followed by the cursor save every pass makes. Nothing runs in the background or while Terno is not focused beyond what runs today.

## Tests

- `quick-checks.test.ts` (fake timers): a focus checks at once, then every 5 s, 13 checks, then nothing and no timer. A blur stops it and leaves no timer. A refocus starts the minute over, and one within 5 s of the last check waits for the slot. A focus while running extends the minute without a second timer. Two clients: one blurring while the other is focused goes on, in either order, and the last blur stops it. A disconnect counts as a blur. `stop()` clears it.
- `quick-checks-sync.test.ts` (the backend, scripted providers, `sync.focus` over RPC): a quick-check provider gets quick passes for the minute and then none; a push provider gets none. A check with nothing new leaves the status as it was and publishes no `accounts` event. Blur and disconnect stop it. An account whose pass failed (retryable or not) isn't checked again; offline nothing is. A running pass isn't followed by a quick one. With `autoSync` off nothing starts.
- `gmail-quick-pass.test.ts`: Gmail takes quick checks; a quick pass with nothing new is one `/history` read, with no repairs, flag snapshots, captures, backfill or labels, and saves the cursor with its backfill progress. No cursor, a reconciliation under way, or expired history asks for an ordinary pass and reads nothing more.
- `apps/web/src/lib/network.test.ts`: the web page tells its focus once per change, from the start, and again on a (re)attach; desktop's renderer tells nothing.
- `apps/desktop/src/window-focus.test.ts`: changes are told once they settle; a switch between Terno windows isn't a blur; a change with no backend is carried by the next init.

## Perf

Nothing on a hot path. A check reads the account list and, per eligible account, runs a pass that costs one small request, a cursor save and no status write when nothing changed. No timer exists outside the minute after a focus.

## Out of scope

- Gmail push through Pub/Sub (needs a server or a cloud setup on our side).
- Quick checks for the folders IMAP IDLE doesn't watch (Spam, other folders): the 2-minute poll covers them, as today.
- Ending early once a message arrives: a second code or link may follow, and the minute is short.

## Revisions after the Codex review

1. **The web's first focus could be lost** before the transport attached, and a restarted backend never heard it again. `network.ts` now sends the focus again on every `client.onAttach`.
2. **Admission is checked again after the awaits**: `quickCheck` reads the account's status and provider, so a blur, offline or another pass in between could start a stale check. `QuickChecks.running`, `connectivity.canSync` and `syncing` are checked again right before the pass.
3. **Failures that aren't retried didn't back off**: such accounts would fail every 5 s. Quick checks now reach only healthy, synced accounts, and any failure takes the account out until a pass works.
4. **A Gmail pass wasn't one request**: repairs, flag snapshots, captures, backfill and labels ran on every pass. The quick pass (`SyncSink.quick`) skips them all, and expired history or a reconciliation hands over to an ordinary pass instead of starting one.
5. **Status churn**: every pass wrote "syncing" then "idle" with a new `lastSyncAt`, each publishing the whole account list. A quick pass now writes neither, so a check with nothing new publishes nothing.
6. **Eligibility as an absent `watch` couldn't say "not yet"** for a polling provider whose check isn't cheap. It is now the explicit `quickChecks` capability.

Found while building, not by the review: on desktop the page can't see the window's focus once a click went into a mail frame, so desktop's focus comes from main (the OS), and only the web build sends `sync.focus` from the page.
