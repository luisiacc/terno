# Plan 20: network resilience (VPNs, Wi-Fi changes, sleep)

- **Status:** in progress.
- **Builds on:** `402470a` (main after plan 18).
- **Request (verbatim):** "when polling for new emails, if it fails for connection errors, lets make sure the retries have into accont changes in things like active vpns and that stuff, make sure that works well"
- **Plan 17** is reserved for People / waiting-for-reply; 18 exists; 19 is the logo (`19-brand.md`); this is 20.

## 1. What exists

- **Sync loop** (`packages/backend/src/core.ts`). `start()` watches every account (`startAccount` → `provider.watch`, IMAP IDLE) and runs one fixed `setInterval` (`syncIntervalMs`, 120 s) that syncs every account. `syncAccount()` coalesces passes (`syncing`, `syncAgain`). A failure sets `status: "offline"` (retryable `ProviderError`) or `"error"` and then waits for the next 120 s tick. No backoff, no retry schedule, nothing reacts to the network.
- **Ops worker.** `runWorker`/`scheduleRetry` retry by `next_attempt_at` (`failOp`: 1 s, 2 s, 4 s … then `failed` after `MAX_OP_ATTEMPTS = 8`, so ~2 minutes). A network outage longer than two minutes fails every queued action **permanently**, sends included (only before DATA; an ambiguous send is `unknown`, never resent). A network change doesn't cut a wait short.
- **IMAP** (`packages/mail/src/imap.ts`, imapflow 2.8.0).
  - One cached command session (`connection()`); `withConnection()` retries once on a fresh session.
  - `connectionTimeout` is 20 s. imapflow's `socketTimeout` defaults to 5 minutes, so a command on a dead socket hangs about 5 minutes before the retry.
  - `watch()` holds a separate IDLE session and reconnects with backoff up to 60 s that nothing resets. **Bug:** a failed connect schedules a reconnect twice, once from the `close` handler and once from the `catch`, so the reconnect loops double on every failure during an outage.
  - imapflow's quiet-socket handling: on a quiet IDLE it sends a NOOP after `socketTimeout` and closes if that NOOP hasn't settled by the next timeout. A silent dead IDLE therefore goes unnoticed for up to 10 minutes. `setKeepAlive(true, 5 s)`: libuv 1.52 also sets TCP_KEEPINTVL=1 and TCP_KEEPCNT=10, which covers a kernel-level black hole on an idle socket, not a socket with unacknowledged data or a middlebox that still answers.
- **SMTP** (`smtp.ts`): one nodemailer transport per send, with no pooled socket (`socketTimeout` 60 s). Losing the connection after `354` is classed as ambiguous, which becomes `unknown`.
- **Gmail** (`gmail-api.ts`, `gmail.ts`, `gmail-web.ts`) uses `ctx.fetch` = `net.fetchFor("mail")` over `globalThis.fetch`.
  - In Electron's utility process that is Node's undici: keep-alive 4 s, `headersTimeout`/`bodyTimeout` 300 s, and nothing reacts to a network change. A request on a stale or black-holed socket therefore hangs 5 minutes.
  - In the web build it is the browser's fetch, whose network stack drops sockets on an address change by itself.
  - No request has a timeout of its own.
- **Desktop host.** `apps/desktop/src/app.ts` uses no `powerMonitor`. `backend-entry.ts`'s `b.resume()` is the quiesce resume after a quit was put off, not a power resume. The backend never learns about sleep, wake or the network.
- **UI.** Settings → Accounts shows "Offline: {error}" per account (`accounts-tab.tsx`). The main window shows nothing, apart from the sidebar dot pinging while an account syncs. The web's `GmailReconnect` banner treats an `offline` Gmail account as needing a new Google sign-in, which is wrong for a network blip. `sync.now` exists in the contract, but no UI calls it.
- **Diagnostics** (plan 10) records `sync.done`/`sync.failed` with typed fields. It records nothing about networks or retries.

## 2. Detection: what actually sees a VPN switch on macOS

Measured on this machine, which has Tailscale connected and is loaded by other work:

| candidate | sees VPN on/off | cost | verdict |
|---|---|---|---|
| `/sbin/route -n monitor` (PF_ROUTE) | yes, every route change | **~6,600 RTM_MISS messages a minute** here (110 a second, any traffic to an unrouted v6 address), each one formatted by `route` and parsed by us | rejected: wakes main ~100×/s for unrelated traffic |
| `scutil` SCDynamicStore notifications | yes: VPN services publish `State:/Network/Service/*/IPv4` and `Global/IPv4` (primary changes), KernelEventMonitor publishes `State:/Network/Interface/<if>/IPv4|IPv6` for any address, `utun` included (wg-quick, OpenVPN), DNS changes in `Global/DNS` | blocked in `CFRunLoop` until configd posts a change: silent when nothing changes (verified: no output over 25 s and a 2 h passive log); exits by itself when its stdin closes (verified) | **chosen** |
| Electron `powerMonitor` `resume` | sleep and wake only | event | **used**, alongside `scutil` |
| renderer `online`/`offline` | only when there is no route at all, so a VPN switch never fires it | event | used on the web only (the only signal there) |
| `navigator.connection` `change` | fires on RTT/downlink estimate changes, which are noise | event | not used |
| fingerprinting `os.networkInterfaces()` | yes, if polled | polling | used only to confirm a notification, never on a timer |

The route-only change a root tool makes without any address or configuration change (`route add` by hand) is the one case `scutil` misses. The heartbeat (§5) bounds it.

**Verification against a real change.** A VPN can't be toggled here: Tailscale is the user's live connection, and creating a `utun` needs root (tried: `EPERM`). Writing a dynamic-store key needs root too (tried: "Permission denied"). So:

1. a passive logger records real `scutil` notifications and route messages on this Mac for the length of the work (what it caught is in "Measured"), and
2. the watcher's parser and filter are tested against the exact output `scutil` prints, and the debounce, restart and cleanup against a fake child, and
3. the packaged smoke test checks the real `scutil` child: it starts, is restarted when killed, and is gone after quit.

## 3. Design

```
main (desktop)                                   backend (utility process / web worker)
 NetworkWatch                                      BackendCore
  ├ scutil child (SCDynamicStore keys) ─┐            └ Connectivity (connectivity.ts)
  ├ powerMonitor resume ────────────────┼─ {type:"network", online, reason} ─▶ networkChanged()
  └ net.isOnline() on each event ───────┘                 ├ online=false: pause (retries at cap, no watches, worker paused)
renderer (web only): online/offline ─── sync.network ──▶  └ online / changed (settled 300 ms):
renderer (both): focus, "Retry now" ─── sync.now ──────▶      reset sockets, re-watch, sync all (jitter),
                                                               backoffs reset, parked ops resume
```

### 3.1 `NetworkWatch` (`apps/desktop/src/network-watch.ts`, main)

- **macOS:** it spawns `/usr/sbin/scutil` with `stdio: [pipe, pipe, ignore]` and writes `n.add` for these keys, then `n.watch`:
  - `State:/Network/Global/IPv4`, `State:/Network/Global/IPv6`, `State:/Network/Global/DNS`
  - the patterns `State:/Network/Service/[^/]+/(IPv4|IPv6|DNS)` and `State:/Network/Interface/[^/]+/(IPv4|IPv6)`
  - The stdin pipe stays open. If main dies, stdin reaches EOF and `scutil` exits, so there is never an orphan.
- **Parsing.** Every key named in the output is a change. Interface keys of `awdl*`, `llw*`, `anpi*`, `ap*`, `bridge*`, `gif*`, `stf*` and `lo*` are ignored (AirDrop and peer-to-peer links churn their link-local addresses).
- **Debounce:** 750 ms trailing, at most 3 s after the first message of a burst (a VPN connect posts several keys).
- **Confirming a change.** A Global or Service key always counts: the primary service or its routes changed even when no address did, as with a Tailscale exit node. An Interface-only burst counts only if the fingerprint changed. The fingerprint is the sorted `name/family/address` of non-internal, non-link-local addresses on interfaces that aren't ignored.
- **Online state:** `net.isOnline()` is read after each confirmed change and on `resume`. A change of it alone is also sent.
- **Wake:** `powerMonitor.on("resume")` sends `{ reason: "wake" }` at once. The `scutil` changes that follow as Wi-Fi rejoins are sent too, which costs one more cheap reset.
- **Supervision:**
  - an unexpected exit restarts the child after 1 s, doubling to a 5-minute cap and resetting after 10 minutes of uptime
  - `ENOENT` (no `scutil`) and 8 quick failures in a row stop it, with a diagnostic
  - quitting (`will-quit`) ends its stdin and sends SIGTERM to the PID it spawned
- **Other platforms:** `powerMonitor` only (macOS first; documented).
- **Main → backend:** `{ type: "network", online, reason: "network" | "wake" | "online" | "offline" }`. The `init` message carries `online`. After a backend restart, main sends the current state again.

### 3.2 Web

The page listens for `online`/`offline` (`lib/network.ts`, entry chunk, a few lines) and calls `sync.network { online }`. The worker hosts the backend, and the page owns the events. `navigator.connection` isn't used (see §2).

### 3.3 `Connectivity` (`packages/backend/src/connectivity.ts`)

A small class owned by `BackendCore`, holding all timer and policy state. Clock, timers and random are injectable, so it is tested without the core.

- **Retry schedule** for a sync that failed retryably: 2 s, 5 s, 15 s, 30 s, 1 min, 2 min, then 5 min forever, each × a uniform jitter in [0.8, 1.2]. Reset by:
  - a successful sync
  - a network change or the online event
  - the user: "Retry now", or `sync.now` from a window focus, at most once per 15 s
- **Offline** (the host says so):
  - every pending retry moves to the cap (5 min), so attempts drop to one per account every 5 minutes
  - watches stop: their sockets are dead anyway, and the IDLE loop would otherwise try every minute
  - the worker claims nothing, so no attempts are spent
  - the online event cuts all of this short

  It is not a hard stop, because the OS's "offline" can be wrong (reachability with some VPNs). A sync that succeeds while the host says offline proves it wrong: the core treats the host as online (and logs it).
- **Online, or a network change** (any source, settled 300 ms so the sources coalesce):
  1. `provider.reset()` for every provider (§4, §5): sockets are presumed dead.
  2. watches restart. IDLE reconnects now with its backoff reset.
  3. every account syncs, each after a random 0–250 ms. A pass already running gets `syncAgain`; its dead socket was just destroyed, so it fails fast.
  4. backoffs reset and `ops.resumeNetwork(now)` releases parked ops (§3.4).
- **The 120 s tick** skips accounts with a retry pending and does nothing while offline. It remains the poll for folders IDLE doesn't watch, and it is the heartbeat's trigger (§5).
- **No flash for a blip.** The first retryable failure after a success keeps `status: "syncing"` and sets `retryAt`; the 2 s retry follows. The second failure in a row, or any failure while the host says offline, sets `status: "offline"`. `AccountSyncState` gains `retryAt: number | null`, optional for rows written before. `failures` lives in memory only.
- **Not retried:** non-retryable errors (sign-in, configuration, a server's NO/BAD) stay `error` and wait for the user, as today.

### 3.4 Ops: wait for the network instead of burning attempts

- `ProviderError` gains `network: boolean` ("couldn't reach the server": DNS, refused, reset, unreachable, timed out, socket closed), always retryable and never ambiguous. Classifiers:
  - IMAP's `toProviderError`: Node errnos (`ECONNREFUSED`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENETDOWN`, `EPIPE`, `EADDRNOTAVAIL`) and imapflow's `NoConnection`, `EConnectionClosed`, `ETIMEOUT`, `CONNECT_TIMEOUT`, `GREETING_TIMEOUT`, `UPGRADE_TIMEOUT`, `ClosedAfterConnect*`
  - `classifySmtpError` before DATA: nodemailer's `ECONNECTION`, `ETIMEDOUT`, `ESOCKET`, `EDNS`
  - Gmail: a fetch that throws or is aborted, unless the request is a send (`ambiguousOnFailure`)
- **Parking.** A network failure of an op now **parks** it: `ops.fail(id, error, true, now, { untilNetwork: true })` keeps the claim's attempt (spent) and sets `next_attempt_at = AWAITING_NETWORK`, a sentinel below `AWAITING_AUTH`. `nextAttemptAt()` ignores both sentinels.
- **Resuming.** `ops.resumeNetwork(accountId | null, now)` makes parked ops ready. It is called on:
  - that account's successful sync
  - a network change or the online event
  - "Retry now"
- **Effect.**
  - During an outage nothing retries, so nothing is spent and nothing fails.
  - A server that stays unreachable while its account otherwise syncs (a mistyped SMTP host) still fails after 8 real tries.
  - Both stores (SQLite `repos.ts`, IndexedDB `mail.ts`) implement it, with conformance tests.
- **Sends** keep their semantics. An ambiguous outcome is `unknown` and is never retried, and a reset never touches a send in flight (§4, §5).

## 4. IMAP

- **Command session: `socketTimeout: 60_000`.** A command stuck on a dead socket fails within 60 s, and `withConnection` retries on a fresh session. imapflow closes a session left quiet for 60 s (its documented timeout on a session with no IDLE), so a quiet minute never leaves a dead socket to reuse; the next sync opens a new one. That is one login per 2-minute tick, the cost of not holding a second long-lived connection.
- **`reset()`** (new, optional on `MailProvider`): `client.close()` (destroy, never LOGOUT on a dead socket), and every watcher restarts now with its backoff reset.
- **`watch()` rewritten as one reconnect loop:**
  - at most one timer and one connection per watcher
  - `close` and `catch` share `scheduleReconnect()`, which is a no-op when one is pending, so it can't double
  - backoff 1 s doubling to 60 s with ±20 % jitter
  - stop closes whatever connection exists
- **Heartbeat** (§5): after each successful sync, a watcher that has heard nothing for 60 s sends NOOP and must hear back within `heartbeatMs` (15 s). If it doesn't, the IDLE connection closes and reconnects now. Re-entering IDLE afterwards is imapflow's (auto-IDLE). No timer of its own: it rides the sync tick.
- **SMTP** is per send, with nothing to reset. Its 60 s `socketTimeout` stays, and a stall after DATA stays ambiguous.
- Test-only options (`ImapProviderOptions.timeouts`) shorten `socketTimeout`, `heartbeatMs` and the SMTP timeouts so the integration tests run in seconds.

## 5. Gmail and HTTP

- **Reads** (everything except `messages/send`) get a 60 s deadline and the provider's reset signal (`AbortSignal.any`, with a fallback where it's missing). `reset()` aborts reads in flight: they fail as `network` and the core resyncs. Aborting destroys their sockets. Any other pooled socket lives at most undici's 4 s keep-alive, and a request on one that died is bounded by the deadline.
- **A send** is never aborted by `reset()` and gets no extra deadline. A large upload may legitimately take minutes. undici's own timeouts stand, and a failure is ambiguous (`unknown`).
- **DNS** is re-resolved on every new connection. imapflow and undici call `dns.lookup` → getaddrinfo → mDNSResponder, which follows macOS's scoped and split resolvers and flushes on a network change. Nothing pins mail hosts (the network policy pins only local AI).
- **Not done:** switching to Electron's `net.fetch` (Chromium's stack drops sockets on IP changes by itself). It changes proxy, cookie and policy behaviour, so it is out of scope.

## 6. Dead sockets with no event: the bounds

| what | detected within |
|---|---|
| a command on a dead socket | 60 s (`socketTimeout`), then a fresh session |
| new mail while IDLE is silently dead | the next tick (≤ 120 s) + ≤ 60 s, through the command session |
| IDLE itself | tick + 15 s (heartbeat), else imapflow's 2 × 5 min |
| a Gmail read | 60 s |

With an event, all of it happens at once (settled 300 ms + jitter ≤ 250 ms + reconnect).

## 7. UX

- **Sidebar `ConnectionPill`**, in the same place and style as `UpdatePill` (a quiet capsule above it):
  - shown only while an account is `offline`. One account of several: "Work is offline · retrying in 25 sec". All of them: "Offline · retrying in 25 sec".
  - a "Retry now" button (`sync.now`, user). During a retry it reads "Reconnecting…" (the renderer remembers which accounts were offline).
  - the countdown uses `Intl.NumberFormat` units ("25 sec", "2 min"; Spanish "25 s", "2 min") and ticks once a second only while the pill is mounted and the page visible
  - the state words are in a `role="status"` region, and the countdown is `aria-hidden`, so a screen reader hears "Offline" and "Reconnecting", not every second
  - same roles, test ids and names in every design. Checked in all three designs, light and dark.
- **Settings → Accounts:** "Offline · retrying in 25 sec: {error}" while a retry is set, and "Reconnecting…" while one runs.
- **Web `GmailReconnect`:** only for `error` (a sign-in to redo), never for `offline`.
- **Focus:** a window regaining focus with an account offline calls `sync.now { reason: "focus" }` (rate-limited in the backend) → an immediate retry.
- **Strings (en + es):**
  - `connection.offline`, `connection.accountOffline`, `connection.reconnecting`, `connection.retryNow`
  - `account.status.offlineRetry`, `account.status.reconnecting`
  - `errors.network.offline` ("No network connection")

## 8. Diagnostics (plan 10)

- **New fields:**
  - `netReason: enum("network", "wake", "online", "offline", "user", "focus", "other")`
  - `online: bool`
- **New codes:**
  - `net.changed { netReason, online }` (backend breadcrumb and log)
  - `net.watch_failed { errno, exitCode, attempt }` (main)
  - `sync.retry { accountKind, attempt, delayMs }`
  - `push.lost { accountKind }` and `push.restored { accountKind, durationMs }`: providers report through an optional `ctx.event`
- No hosts, addresses, interface names or keys.

## 9. Tests

- **Unit, `connectivity.test.ts`, fake timers:**
  - schedule and jitter bounds, and reset on success, change and user
  - the focus rate limit
  - offline moves retries to the cap; online cuts it short
  - the settle debounce coalesces bursts from several sources
  - a success while offline flips to online
  - **a simulated hour:**
    - offline: ≤ 12 attempts per account and ≤ 1 timer per account
    - online with the server unreachable: the schedule's ~17 attempts
    - the tick adds none
    - `vi.getTimerCount()` stays bounded
- **Unit, core with a fake provider:**
  - the first failure stays `syncing`, the second is `offline` with `retryAt`
  - a change resets providers, re-watches and syncs all, with jitter
  - parked ops resume on success, change and user
  - the worker claims nothing while offline
  - a send is never resent after a change
- **Store conformance (SQLite + IDB):** `fail(…, { untilNetwork })` parks and spends the attempt; `resumeNetwork`; `nextAttemptAt` ignores parked ops; the 8th parked failure fails.
- **Classifiers:** IMAP, SMTP and Gmail errors → `network`, and a send's fetch failure stays ambiguous.
- **Integration (`network.int.test.ts`), real imapflow ↔ ImapKit through a test TCP proxy** that can pass, **black-hole existing connections** (sockets stay open, bytes are dropped both ways, new connections pass: a VPN switch), black-hole everything, refuse, and reset:
  1. **VPN switch with the event:** IDLE established; black-hole existing; `networkChanged`; a new message arrives within 3 s (measured).
  2. **The same, without the event:** nothing arrives in that window (control); with the tick at 1.5 s and `heartbeatMs` 1 s, it arrives within its bound.
  3. **Refused while the server is down:** `offline` after two failures, with `retryAt`; the server comes back; the retry syncs; `idle`.
  4. **IDLE reconnect loop against a refusing port:** connection attempts grow linearly (the doubling bug fails this).
  5. **Send across a change:** SMTP holds its 250 after DATA; a change fires; one message delivered and the op succeeded. Black-holed after DATA: `unknown`, still `unknown` after a change, received ≤ 1.
  6. **An archive while the server is unreachable:** parked (not failed); the server returns, a change fires, it runs.
- **Gmail:** `reset()` aborts reads, never a send; the read deadline.
- **Desktop unit (`network-watch.test.ts`):**
  - the parser on `scutil`'s real output, and the ignored interfaces
  - debounce and max wait, fingerprint confirmation, Global keys always counting
  - restart backoff, `ENOENT` give-up and stop, all with a fake spawn
- **Packaged smoke:** the `scutil` child of main runs. After `kill -9` it is back within a few seconds. After quit, no `scutil` child of that PID remains.
- **e2e (`network.spec.ts`), with a backend-dev provider that can be switched unreachable:**
  - the pill appears after two failures with the countdown; "Retry now" with the server back clears it
  - "Reconnecting…" while a retry runs
  - focus retries
  - Settings status, and Spanish
  - axe; screenshots in all designs, light and dark

## 10. Performance and resources

- Nothing on a hot path changes (the list, search, ingestion).
- **Idle cost:**
  - one blocked `scutil` process (~1 MB, zero CPU until configd posts)
  - no new timers in the backend: a retry timer exists only while an account is failing
  - the heartbeat rides the existing tick
- The pill's ticker runs only while it is shown.
- Logs: the retry and network codes are bounded by the schedule and the debounce.
- `pnpm test:ui-perf` and `pnpm test:perf` must stay green. No perf gate files are touched.

## 11. Out of scope

- Gmail push (watch/Pub/Sub)
- removing the 120 s poll
- Electron `net.fetch` for Gmail
- Linux and Windows network monitors (wake only)
- proxies and PAC
- a manual "work offline" mode

## Revisions after the Codex review

Codex (`codex exec -s read-only`, 12 points) against the plan and the code. What changed:

1. **An outage never spends a send's attempts.** Parking gives the claim's attempt back when the failure happens during an outage: the host says offline, the account's own sync is failing, or a network change happened in the last minute. It spends the attempt only when the account otherwise syncs fine (a mistyped SMTP host still fails after 8 real tries). Store API: `fail(id, error, true, now, { park: "network", keepAttempt })`. Test: 10 network changes during one outage, then delivery.
2. **No zero-delay worker loop behind a parked op.** `nextAttemptAt()` now uses the claim's own dependency predicate, in both stores: a location op blocked by an older queued or running one isn't due. This also fixes today's spin while an older op sits in its plain backoff. Tests: parked archive → trash, counting worker passes.
3. **One IMAP connect in flight.** `connection()` shares a pending promise. `reset()` bumps a generation, and a session that finishes connecting under an old generation is closed. `withConnection` invalidates only the session that failed (`client === c`). Tests: reset while the secret is read and while TLS/login runs; a sync and an op connecting together make one session.
4. **Every sync trigger respects the retry state.**
   - A pass whose failure was caused by Terno's own reset doesn't count: an epoch is captured at its start, and the coalesced pass runs at once.
   - An IDLE event or a user request still syncs: push is proof the server is reachable, and the user is the user.
   - The tick skips accounts in backoff.
   - **Errors keep today's tick.** A non-retryable classification isn't always permanent (Gmail answers a rate limit with 403), so `error` accounts are still tried by the 120 s tick, as before. The plan wrongly said they wait for the user.
5. **Gmail deadlines cover everything a read waits on:** the fetch, the body (an abort while decoding is `network`) and the token refresh (its own 30 s deadline, shared by the callers waiting on it).
6. **Pooled HTTP sockets are really dropped.** undici's keep-alive can be extended by the server up to 600 s. On Node, the network reset swaps fetch's global dispatcher for a fresh `Agent` (the `Symbol.for("undici.globalDispatcher.1")` slot npm undici's `setGlobalDispatcher` uses) and `close()`s the old one. That closes its idle sockets now, while requests in flight (a send) finish on it. Test: a server that advertises `Keep-Alive: timeout=600`; after a reset, the next request opens a new socket and the idle one is closed.
7. **A send has a finite deadline: 15 minutes**, long enough for a 35 MB upload on a slow uplink. Past it, the outcome is unknown (`unknown`, never retried). A send that never connected (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, a connect timeout) never left, so it is a network failure and is retried.
8. **Classifiers read structured codes.**
   - nodemailer's `ESOCKET` counts only with a socket errno underneath (`originalCode`, `errno`, the cause); a TLS certificate error isn't connectivity.
   - A Node fetch failure counts only with a network code on its cause.
   - A browser `TypeError` without a cause counts (it can't say more).
   - Explicit SMTP replies and post-DATA ambiguity keep their precedence.
   - Tests: certificate errors, 451/554, a disconnect after 354.
9. **The heartbeat is started by the tick itself** (`MailProvider.heartbeat()`), independent of the sync pass, one probe per watcher at a time. Bound: tick + `heartbeatMs`, whatever the sync does. Test: dead IDLE while the command session is black-holed too.
10. **Lifecycle fences.**
    - `stop()`, `quiesce()` and `dropAccount()` cancel Connectivity's timers (settle, jitter, retries).
    - Delayed callbacks check `stopped`, and that the account is still tracked.
    - `executeOp` re-checks offline right before dispatch and releases the claim (attempt given back), as it does for draining.
    - `backend-entry.ts` ignores network messages until the backend exists; `init` carries the state.
    - Tests: offline during a claimed batch, a change during quiesce, a reset during removal.
11. **Gmail reconnect only for a sign-in to redo.** `AccountSyncState.authRequired` is set by a `ProviderAuthError` and cleared by any success. The web banner shows for it only. A second 401 in a row is a `ProviderAuthError` (ops wait for the sign-in instead of failing). Test: revoked vs 403 permission vs malformed.
12. **Connection health is backend state.** `AccountSyncState.connection` is `{ state: "offline" | "reconnecting", retryAt }` or null. It is set after the second failure in a row, or at once while the host is offline. It reads "reconnecting" while a retry pass runs and is cleared by a success. The pill and Settings read it, so it survives reloads and second windows. The pill stays mounted from "offline" through "reconnecting" until a success, and its "Retry now" keeps focus (`aria-disabled` while reconnecting, never removed). `retryAt` moves into it.
