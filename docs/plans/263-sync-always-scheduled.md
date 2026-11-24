# 263: every sync outcome leaves the account a way to sync again

## Request

> look for other possible issues that could cause email not getting fetched … then fix them all, that is the most
> important part of an email client is to actually receive the email

(The owner, 2026-11-24, after plan 262. Two read-only audits then listed suspects; this plan takes the backend's sync
scheduling: `packages/backend/src/core.ts`'s pass outcomes, `connectivity.ts` and desktop main's `network-watch.ts`.)

## What exists

Plan 20 (network), 31 (the account sync lifecycle) and 87 (wakes) built this. What tries an account again:

- **The poll** (`tick`, every `syncIntervalMs`, 40 s): every account without a pending retry or a sign-in to redo.
  It does nothing while the host says offline (`if (!this.connectivity.online) return`).
- **Connectivity's timer** per account: the retry schedule after a retryable failure (2 s … 5 min), and offline one
  probe per account at the 5-minute cap. A network change while offline probes soon (rate-limited to 15 s).
- **The cooldown wake** (`cooldownChanged`): a timer at the next timed Google cooldown's end syncs every Google account
  that's ready, whatever the network says; a released Google slot (`googleChanged`) syncs the accounts in
  `capacitySync` that `connectivity.canSync` (which needs online).
- **Holds the user lifts**: a sign-in to redo (plan 25), a Gmail policy pause (`google.paused`, "Retry now").

## Findings, checked against the code

### 1. Offline, some failures end a pass with no probe: confirmed

`syncAccount`'s catch (core.ts ~2422-2445):

- the cooldown branch (any `ProviderCooldownError`, a Gmail 429, a retryable or paused 403) calls
  `connectivity.succeeded(accountId)`, which clears the account's timer, and returns;
- the `FlagConnectionError` branch returns without touching connectivity;
- an exception before the try (`this.provider()` failing on a store read) leaves the same way.

Online the poll covers all three within 40 s. Offline nothing does: the probe that ran this pass fired and is gone, the
poll is off, and a capacity refusal's `capacitySync` resume needs `canSync`, i.e. online. Only a network event or the
user's Retry wakes the account. The OS saying offline when it isn't (a VPN's reachability, the reason the probe exists)
then means no mail until the user acts. A timed cooldown still has its wake (it ignores the network); capacity, a
ledger hold and the flag error have nothing. The non-retryable branch already re-arms the probe (`probeLater`), the
retryable one schedules through `failed()`, and the "went offline during a successful pass" branch through
`probeLater`.

### 2. A wake that reads "offline" waits for the 5-minute probe: confirmed (partly)

`NetworkWatch.wake()` reads `net.isOnline()` once. Right after a wake Wi-Fi is often not associated yet, so the
backend goes offline and schedules every account's probe at the cap (`network(false)` on an online backend). On macOS
the address change that follows usually reaches `scutil` and `settle()` reads `isOnline()` again, so most wakes
recover in seconds. Not all: an interface whose address survived the sleep posts no key, Chromium's reachability can
trail configd's, and on Linux (plan 189) there's no watcher at all, so only the wake is read. `start()` has the same
single read (an app opened at login before Wi-Fi joins). Electron's main process has no online event to listen to
(`net.isOnline()` is a getter), so the honest fix is a short, bounded re-read after an offline report.

### 3. A "sync again" asked for during a pass is dropped when Google isn't ready: confirmed

The pass's `finally` takes `syncAgain` out and runs the follow-up only if `googleReady(accountId)`. If Google refuses
the account at that moment, the request is gone. A timed cooldown's wake syncs every ready account anyway, so that case
recovers; capacity resumes only accounts in `capacitySync`, so a request dropped while the slots are full waits for the
poll (40 s online, never with autoSync off or offline).

### Also checked

- `failed()` returning null (a reconnect during the pass): the reconnect syncs every account itself. Fine.
- An early return for a sign-in to redo, a removed account, a stopped backend or a paused Gmail policy: each is a hold
  the user (or removal) ends. Fine.
- `continueBackfill` skips while offline: going offline already gave every account a probe. Fine.
- The poll after sleep: a Node `setInterval` runs on the monotonic clock, which macOS stops during sleep, so the poll
  resumes at most 40 s after a wake and is never stopped except by `stop()`; the wake itself reconnects and syncs every
  account at once. Fine.
- The offline "network changed" probe in `Connectivity.network` tests `a.signIn`, which is only set when no
  `signInRequired` hook exists; the backend passes one, so an account waiting for a sign-in got a (harmless, local)
  probe. Fixed in passing (the same `signInRequired(id)` as the other paths).

## Design

### 1. One rule at the end of every pass (core.ts)

The pass's `finally` (where `syncAgain` is read) ends with: if no follow-up pass starts, the account is current, the
host says offline and the account has no timer, `connectivity.probeLater(accountId)`. `probeLater` already refuses an
untracked account, a stopped backend and an account waiting for a sign-in. So whatever a pass ended in, offline it
keeps its 5-minute probe, as the non-retryable branch always did. Online nothing changes (the poll runs). With autoSync
off, `probeLater` schedules nothing (retries off), as before.

The invariant, stated where it's kept: every pass leaves its account the poll (online), a retry or probe timer, a
cooldown wake, or a hold only the user ends.

### 2. Main re-reads `isOnline()` after an offline report (network-watch.ts); a wake or a change probes soon

- `NetworkWatch`: after `start()`, `wake()` or `settle()` leaves it offline, it reads `isOnline()` again 1 s, 3 s,
  10 s and 30 s later (44 s in all), and reports `{ online: true, reason: "online" }` at the first true, then stops.
  A newer report restarts the ladder; `stop()` clears it. At most four reads per offline report, nothing while online
  or after the ladder: no idle polling.
- `Connectivity.network(false, "wake" | "network")` on a backend that was online: the same rate-limited probe soon
  that the already-offline branch gives a change (the OS's word right after a wake is the least reliable), instead of
  the cap. A plain `"offline"` still waits for the cap.

### 3. A follow-up Google refuses waits for admission (core.ts)

In the `finally`, an explicit `syncAgain` whose follow-up can't run because Google isn't ready joins the set the
admission wake resumes. That set is renamed `admissionSync` (accounts waiting for Google to admit them again: refused
for capacity, or a pass asked for while it wasn't ready). A full pass that starts takes its account out of the set
(it is the pass that was waited for; a capacity refusal puts it back), so a timed wake's own sync isn't followed by a
second one.

## Tests

`packages/backend/src/network.test.ts` (scripted providers, the real Backend; a short offline probe):

- offline, a probe refused by a Google cooldown (capacity) is followed by another probe; when the account then answers,
  the backend comes online. Fails on the old code (no second probe).
- the same for the flag-connection error (`FlagObservationError`).
- a "sync again" asked for during a Gmail pass that ends while Google's background capacity is full runs once capacity
  is back (the admission wake); and exactly once. Fails on the old code (dropped).

`apps/desktop/src/network-watch.test.ts`:

- a wake read offline, then online 3 s later: reported online at the 4 s read; nothing more after.
- offline for good: four reads, then no timer left.
- a newer report restarts the ladder; online first means no ladder; `stop()` clears it.

`packages/backend/src/connectivity.test.ts`:

- an online backend told offline by a wake or a network change probes every account after the settle, not at the cap;
  a plain offline still waits for the cap; the 15 s rate limit holds across both branches.
- an account waiting for a sign-in gets no change probe (hook-based).

## Performance and resources

No new work on a hot path. Offline: one timer per account, as plan 20 bounds it (the hour-offline test keeps its
≤ 12 attempts and ≤ 1 timer per account). Main: at most four `isOnline()` reads per offline report. A wake that reads
offline costs one local, failing pass per account, at most every 15 s.

## Out of scope

- Google's own admission latches and holds (plan 264), Gmail sync ordering (265), IMAP (266).
- Linux network monitoring beyond the wake (plan 189 left it out).
- autoSync off: nothing runs by itself, by design.

## Revisions after the Codex review

Codex critiqued the plan against the code (12 points). What changed:

1. **A recheck during the mailbox's opening was lost.** `backend-entry.ts` dropped `network` messages until the
   backend existed (a migration can take a while), so a ladder's "online" told then never arrived and the backend
   started from init's stale offline. The entry keeps main's latest word, as it does focus, and the backend starts
   from it. (No unit harness exists for the entry; typechecked, and the smoke covers the entry.)
2. **A pass that fails before its own error handling was an unhandled rejection.** `accountStatus()`, `provider()`
   (a provider that can't be made) and the setup reads reject out of `syncAccount`; every automatic caller dropped
   the promise, and desktop's backend dies on an unhandled rejection: every account stops, and a restart meets the
   same pass. Automatic passes now go through `syncInBackground`, which reports the failure (`sync.failed`) and
   leaves the account to the poll or, offline, the probe the pass's end gives it. Awaited callers still see the
   error. Test: a provider whose creation fails once; no unhandled rejection, and the poll syncs it.
3. **No probe for a paused Gmail account.** Its next pass stops at `syncAccount`'s pause gate; the user lifts it.
   `keepScheduled` skips it.
4. **The flag-connection error kept a stale `connection`** ("reconnecting" from the pass's start). It ends with
   `connection: null`, like the other errors with no retry schedule.
5. **Retry now cleared the probes, then could fail resuming ops before any pass started.** The passes start in a
   `finally`. Test: `resumeNetwork` rejecting; the account still syncs.
6. **The timed cooldown wake synced an account twice** (the admission set's loop, then the sweep's coalesced call).
   The wake (`cooldownWake`) runs first: an idle ready account starts there, one in a pass joins the admission set;
   the set's loop then skips what's syncing. Test: one pass, not two.
7. **A Google change landing after the cooldown timer was due, before its callback, erased the wake** (the row is
   ready, so `nextWakeDelay` skips it). `cooldownChanged` runs the wake itself when the timer it clears was due.
   Test: a busy event loop past the deadline, then a change; the account syncs.
8. The capacity handoff is unchanged: the readiness check, `autoSync`, sign-in and lifetime guards stay, and the
   plan 262 and capacity-ordering tests in `foreground-admission.int.test.ts` pass unchanged.
9. **Which pass satisfies a queued admission wait:** a full pass (not a quick check) that reached its provider, after
   the folder-change wait, the sign-in check and provider creation. A pass that ends earlier leaves the entry. A
   capacity refusal puts it back; any other outcome has its own schedule (retry, poll, probe, wake).
10. **`syncAgain` is any coalesced request** (push, the poll, a reconnect, the user), not only the user's. A follow-up
    that can run at once still bypasses `canSync` as before; one deferred for Google waits in the admission set,
    whose loop needs `autoSync` and `canSync` (offline, the probe covers it). The test uses a Gmail account with the
    real admission check (`googleReady` through the account's Google requests), the pool's availability stubbed.
11. **The first offline report allocated a cap timer and then replaced it.** The delay is chosen once (`changeProbe`
    returns whether it scheduled).
12. No change: a reconnect's jitter callbacks firing in a newer offline episode are extra probes, not lost ones; the
    pass they start fails into the offline schedule.
