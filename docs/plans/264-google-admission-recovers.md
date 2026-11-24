# 264: Google admission never latches shut on a transient local condition

## Request

> look for other possible issues that could cause email not getting fetched … then fix them all, that is the most
> important part of an email client is to actually receive the email

(The owner, 2026-11-24, after plan 262's incident: fifteen Gmail accounts stopped receiving mail for hours.) Two
read-only audits then listed ways a Gmail account's admission (plan 62's durable cooldown gate, the per-account
mailbox binding, the sign-in state) can close and never reopen in a running app. This plan verifies each against the
code and fixes the real ones. The rule it holds: **every hold has a path back**, and none is a local hiccup the user
can't see or undo. Google's own constraints (Retry-After, quota refusals) are never shortened.

## What exists

- `packages/backend/src/provider-cooldown.ts`: the gate (plan 62). One durable ledger (`provider-cooldown:v1`, one
  settings key, 64 KiB) of rows per owner (`installation` or a mailbox key) and service (`gmail-api`, `oauth-token`,
  `google-userinfo`): the known Retry-After minimum (wall), a `replay` duration re-waited on the monotonic clock from
  each anchor (a start re-anchors every row: "restart re-waits FULL persisted replay", plan 62 line 44), the backoff
  position, and a `hold`. One physical writer; a 5 s logical budget; `storageFault` closes admission for every scope.
- `packages/backend/src/google-requests.ts`: a saved Gmail account's admission. An account without a binding proves
  its mailbox (`prove`) on its first Gmail call, then binds (`store.bind` + `gate.refreshAfterBind`).
- `packages/store/src/provider-cooldown.ts`: the codec, the row merge and `bindCooldown`.
- `packages/mail/src/gmail.ts`: the token refresh; `oauthClient()`.
- `packages/backend/src/core.ts`: `syncAccount` returns at once while `google.paused`; Retry Now (`retryNow`) clears a
  policy pause; `getSecret` turns a keychain failure into `SecretUnreadableError`, the provider context into
  `ProviderAuthError`; init lifts saved holds (plan 62 fix of 2026-10-31); `recheckSignIn` rechecks IMAP only.

## Findings, verified

### 1. The account-level `paused` latch: confirmed

`google-requests.ts` sets `paused = true` (and nothing resets it) when the mailbox's address differs from the saved
one, **and** when `gate.drain(5000)` isn't `drained`, when the bind write fails, when `refreshAfterBind()` isn't
`confirmed`, or when the binding read back doesn't match. `refreshAfterBind` is `recoverStorage`, which returns
`pending-terminal` at once whenever any writer is in flight (`if (this.physical)`): two accounts proving at once (the
first launch after the binding shipped, or adding accounts), or a proof overlapping any cooldown write, pauses the
second account. `syncAccount` then returns without a word every time (`core.ts` ~2170), the poll included, and
`operationAdmission` blocks its ops; Retry Now clears only the policy pause. Mail stops for that account until a
restart (where the binding written before the failed confirmation is found, so it heals then).

**Design.** Only an identity mismatch latches (the grant is for another mailbox: a sign-in answers it). The local
steps are retryable: a failure throws `ProviderCooldownError(…, "storage")` ("Gmail is paused. Try again later."),
which the sync path already treats as a cooldown (no backoff storm; the 40 s poll and Retry Now try again, and the
next Gmail call proves again since the account is still unbound). The gate gets one `bind(work)` entry that
serializes binds (a promise chain: one at a time), waits for an in-flight writer before writing and again before the
confirming read (`settled()`: up to three 5 s drains, since a flush may start right after one ends) instead of
answering `pending-terminal` because someone else is writing.

### 2. `storageFault` has no recovery: confirmed

`storageFault` is set by an unconfirmed commit, a store action over its 5 s budget that then fails, a failed read at
open, and the pending/dependency capacity guards. While set, `flush` refuses, `state()` holds every scope, `admission`
blocks all Google, `nextWakeDelay` is null, and the only call to `recoverStorage` is after a bind. A slow successful
write clears it (commit), a failed one never does: one SQLite `SQLITE_BUSY`/I/O error or an aborted IndexedDB
transaction stops all Gmail until a restart.

**Design.** A fault schedules its own bounded recovery: when the physical writer has ended (or at once when none is
running), a one-shot timer runs `recoverStorage()` after 1 s, 5 s, 30 s, 2 min, then every 5 min while still
faulted. No timer exists while healthy (the timer is created only by a fault, cleared on success and on close), and
each attempt is one local read and at most one write: never a provider request. Admission stays closed until the
recovery confirms (unchanged). Retry Now runs recovery at once (`gate.retry()`).

Plan 62 line 117 said "one bounded explicit recovery action, not background retry loops"; the explicit action never
shipped, so the account had no way back. The backoff above is bounded in rate and costs only local storage work.

### 3. A clock hold latches until restart: confirmed

`state()` writes hold `clock` when the wall clock reads below the last reading of *any* retained row, even one whose
pause ended long ago, and rows are never removed (finding 4). A held row has no wake (`nextWakeDelay` skips it), and
only init lifts holds. One backward NTP step of a millisecond stops Gmail for the session.

**Design.**
- A row that was already satisfied at its last trusted reading can't become unsatisfied by a clock step: it stays
  ready (the anchor remembers `satisfied`; a new 429 replaces the row and the anchor), and the new timeline is
  accepted as the high-water mark. No hold, no write.
- A row still waiting gets the same repair a start (and plan 62's Check clock) gives, at once, when both clocks read
  valid: the hold is written and repaired in the same turn through the existing revision-fenced `checkClock`, which
  re-waits the row's full retained pause from now and keeps every known minimum. Nothing is released early; the
  wait is only ever longer, never latched. Only a clock that reads invalid (not a safe epoch) keeps the hold, and
  Retry Now and the next start lift it (`gate.retry()` and init share `liftHolds()`, batched below the write slots).

### 4. A satisfied long cooldown is imposed again: confirmed, a bug

A 2xx at the row's revision resets `position` to 0 but keeps `replay`. Two consequences:
- every start re-anchors every retained row and re-waits its full `replay`: an account Google once told to wait an
  hour waits an hour after **every** launch, forever (the escalating fallback alone reaches six minutes);
- the next 429 starts from `previous.replay` (`replay = max(previous.replay, …)`), so a later short Retry-After
  re-imposes the old long wait.

Plan 62's re-wait is for an **active** pause across a restart (no trusted elapsed time crosses a restart). Once Google
accepted a request at the same revision after the pause ended, that pause is over. **Design:** that success retires
the row's pause: `replay` 0, `minimum` the current wall (already met), `wall` now, `position` 0, and `repair` = the
retired revision. The store merge keeps the larger `replay` of two rows, which would bring the old wait back from
disk; it now takes the newer row's `replay` when that row is fenced on exactly the other's revision (`repair ===
other.revision`, newer revision), the fence Check clock and start lifts already use for holds (their `replay` is
never smaller, so for them nothing changes). A 429 newer than the success has a newer revision and is untouched
("preserving any newer refusal"): the success only retires when the row's revision is still the one the request
was dispatched under, as today.

### 5. Persisted overflow disables Gmail across restarts: confirmed (rare)

`overflow` is persisted when an update would exceed the ledger's bytes, `state()` then holds every scope, recovery
ORs it, and nothing clears it. Bindings of removed accounts and every row ever written stay forever (plan 62's own
note: "about 200 accounts ever bound would set the sticky overflow").

**Design:** a start compacts the ledger in one store transaction (`compactCooldown` in `@terno/store`, run through
`persistence.update`, so both stores use it): it drops bindings of accounts that no longer exist (id and createdAt),
rows that are retired (finding 4: no hold, position 0, replay 0, minimum met: identical to no row), and rows of a
mailbox no binding references whose pause is over by the wall clock (no hold, minimum met). Then it clears
`overflow` only when the compacted ledger plus a worst-case row for every service each remaining owner lacks still
fits under the byte cap with the overflow envelope's room: every active constraint fits. No migration: one settings
key, rewritten in the same transaction it is read in; nothing in it is user data (AGENTS.md's rewrite rule is about
migrations; this is the gate's own bounded state).

In-session overflow (a run that overflows after start) keeps holding until the next start; with retired rows and
removed accounts compacted it needs about 60 distinct mailboxes with live pauses at once. Out of scope.

### 6. A transient local credential read becomes a permanent sign-in demand: partly confirmed

- `gmail.ts` `oauthClient()`: a throw from `ctx.googleClient()` (the remembered client is a store read of the
  account's config) becomes `ProviderAuthError("Reconnect this Gmail account")`, persisted as a sign-in demand.
  Confirmed: a store read that fails once demands a new sign-in. **Fix:** a throw is a retryable
  `ProviderError` (a new message, en and es); only "no client this build knows" (`null`) stays a sign-in.
- `core.ts` `getSecret`: the keychain refusing to open the refresh token (`SecretUnreadableError`, not legacy)
  becomes `ProviderAuthError`; the refusal is persisted, every Gmail request is refused while `signInRequired`, and
  `recheckSignIn` rechecks IMAP only. Confirmed. We cannot tell a locked keychain from one that will never open this
  blob (the cipher's failure carries no reason we may rely on), and retrying a keychain read every poll could prompt
  the user over and over. **Fix:** the refusal stays (its copy already says what to do), and Gmail joins the local
  recheck at the moments the user would try again (a start, a network change, Retry Now, a window's focus at most
  every ten minutes): when the refusal is the keychain's (its catalog key is `errors.secret.keychain.*`), the backend
  opens the refresh token again, locally; if it opens, the refusal lifts as a sign-in would and the account syncs
  (Google refusing the grant then is an ordinary refusal again). Nothing reaches the network to recheck. A refusal
  from Google (`invalid_grant`) or a legacy Única blob is untouched: only a sign-in answers those.
- A store read failure of the secret itself (not the cipher) already becomes the retryable `replaceFailed` error.

## Tests

- `provider-cooldown.test.ts`: two binds at once both confirm (serialized); a writer in flight during a bind waits
  instead of failing; a failed commit schedules recovery, which reopens admission once the store works, with the
  timers injected (1 s, then 5 s) and no timer while healthy; a backward clock step on a satisfied row holds nothing;
  on an active row it re-waits the full pause from now and is not held; a success at the row's revision retires the
  replay (a restart doesn't re-wait it; a later short 429 isn't stretched to the old one), and a 429 newer than the
  success keeps its pause.
- `store` merge test: a fenced retirement's `replay` wins over the older row's; an unfenced lower `replay` doesn't.
- compaction: removed-account bindings and retired/expired unbound rows dropped, active ones kept, overflow cleared
  only when everything fits.
- `google-requests`: a transient bind failure throws `storage` and does not pause; the next proof binds; an address
  mismatch still pauses.
- `gmail` provider: a failing `googleClient()` is retryable, not `ProviderAuthError`.
- backend: a Gmail keychain refusal lifts on Retry Now once the token opens; a Google refusal is not rechecked.

Each regression test fails on the old code (checked by restoring the old file).

## Perf and resources

No hot path changes: the checks added to `state()` are a comparison on an existing anchor. The recovery timer exists
only while the gate is faulted. Compaction runs once per start inside the one existing ledger read-modify-write (a
64 KiB JSON value at most). The keychain recheck is one local decrypt at moments that already recheck IMAP.

## Out of scope

In-session overflow; a Check clock control; distinguishing a locked keychain from a lost key (needs the host to
report why, an IPC change); the sync scheduling in `core.ts` (plan 263).

## Revisions after the Codex review

Codex (read-only, 12 points against the code) changed the design as follows; what the sections above say is
superseded where it differs.

1. **Overflow** (point 1): an overflow persisted the ledger *without* the refusal it couldn't fit, so free space at
   the next start doesn't mean nothing is lost. Clearing it now also writes a one-hour pause on every Google service
   at the installation (`OVERFLOW_QUARANTINE_MS`; every account checks the installation scope), in place of the
   refusal it lost. Gmail's documented answer to rate limits is exponential backoff, not multi-hour holds; the residual
   risk is a lost Retry-After longer than an hour, on a ledger that needed ~60 paused mailboxes at once to overflow.
2. **Compaction keeps every row that isn't retired** (point 2): an unbound mailbox's row whose wall deadline passed may
   still be re-waiting its replay after a restart. Only retired rows (and removed accounts' bindings) are dropped.
3. **Retry Now lifts only clock holds** (point 3): a `clock-evidence` hold kept no deadline, and lifting it re-waits a
   two-second fallback; that stays a start's decision (plan 62's fix), not one a button repeats.
4. **A recovered binding is adopted** (point 4): an account whose provider was made while the ledger couldn't be read
   ran under the installation scope; its next Gmail call now looks for a binding in the ledger first and switches to
   it with no proof request.
5. **The bind runs under the gate's physical writer** (point 5): `own(work, false)` registers the bind's transaction as
   the writer, so a 429 observed meanwhile flushes after it and `close()` joins it; queued binds after close refuse.
6. **Retirement covers older revisions** (point 6): the fence is "repair ≥ the other's revision", so a retirement of a
   pending row that never reached disk still covers the older stored one.
7. **No retirement while a 429 waits on that row** (point 7): its confirmation compares the exact row it observed; the
   success then only resets the backoff, as before, and the next success retires.
8. **Every clock hold repairs on read** (point 8): `state()` repairs any `clock` hold (from `observe`, `reconcile`, a
   recovery read or a load) once both clocks read valid and no 429 waits on it, revision-fenced through `checkClock`.
   Plan 62's contract tests keep the explicit Check clock with `repairClock: false` (as `checkClockOnStart: false`).
9. Dependency capacity (point 9): the 65th token dependency still reports a storage fault; with the recovery it is no
   longer a latch, but it can alternate fault and recovery while 64 dependencies stay open (more than 64 Gmail accounts
   renewing at once). Not changed: it needs its own capacity state, out of scope.
10. **A bind that didn't settle never re-asks Google and never spins** (point 10): the proven mailbox is kept for the
    same credentials, and the account is deferred (`paused`, so ops aren't claimed and refunded in a loop) for
    `REBIND_MS` (30 s) or until Retry Now.
11. **Gmail's keychain recheck reaches every entry point** (point 11): a start rechecks after `startAccount` (the
    lifetime exists), and the renderer's focus retry now includes a Gmail account whose refusal is the keychain's.
12. **The keychain recovery lifts only that refusal** (point 12): `AccountStatus.localRecoveryProof` clears the
    whole-account refusal only if it is still the same one (count and key captured before the read), never a policy
    pause or a send refusal.

Found while testing: a retired row (replay 0) read "not ready" for up to a millisecond after it was retired, because an
anchor rounds elapsed time up; the next request in the same pass was refused ("Gmail is paused"). A row with nothing to
re-wait needs no elapsed reading past its anchor (`gmail-cooldown.int.test.ts` "labels429" caught it).

## Tests (as built)

- `packages/store/src/provider-cooldown.test.ts`: the fence (covering older revisions, never lowering a newer refusal,
  unfenced rows keep the larger wait); compaction (removed bindings and retired rows only; overflow cleared behind
  the installation pause; kept when it still doesn't fit).
- `packages/backend/src/provider-cooldown-recovery.test.ts`: recovery after a failed commit (1 s, then admission
  reopens with the refusal written, no timer left), backoff and Retry Now, a failed read at start; a met pause through
  a clock step; a waiting one re-waited in full from the step; a saved hold repaired on read; retirement across a
  restart and against a later short refusal.
- `packages/backend/src/google-admission-recovery.int.test.ts` (backend, SQLite, a fake Google): three accounts
  proving at once; a cooldown write in flight between the bind and its confirmation (old code: "Gmail verification
  paused" for the session); a bind the store failed, retried with no second proof after Retry Now; an address
  mismatch still pauses; a keychain refusal lifted at Retry Now; Google's `invalid_grant` not rechecked.
- `packages/mail/src/gmail-refresh.test.ts`: a remembered client that couldn't be read is retryable, not a sign-in.
- Existing suites updated: `gmail-cooldown.int.test.ts`'s two stale-proof tests now expect the kept provider to
  bind under the new credentials (the old expectation was the latch); plan 62's clock contract tests run with
  `repairClock: false`.

Every new test except the controls (three accounts at once, address mismatch, `invalid_grant`) fails on the old code.

## What the Codex code review changed

One round, 8 findings, all fixed, each with a regression test that fails without the fix:

1. **High: a bind could take the writer from a flush** that started between `settled()` and the bind's continuation,
   so `close()` could return with a cooldown write in flight. The bind now rechecks `physical` (and pending, fault,
   overflow) in the same turn it takes the writer. (`provider-cooldown-recovery.test.ts`)
2. **High: a binding a recovery read back didn't constrain a token refresh.** A provider made while the ledger was
   unreadable ran under the installation scope, and a cold refresh left before `prove()` adopted the binding. Every
   `check()` now also applies the bound mailbox's state while the provider hasn't adopted it (`gate.boundOwner`, a
   synchronous lookup with the stamp's digest computed once). (`google-requests.test.ts`)
3. **High: a clock repair could strand a 429's ticket.** The met shortcut, `checkClock` and `liftHold` now leave a row
   alone while a 429 waits for that exact row to commit (it is held, as before, and repaired on the next read once
   confirmed). (`provider-cooldown-recovery.test.ts`)
4. **High: the compaction's inventory read could fail `init()`.** It is optional now: an inventory that can't be read
   opens the gate without compaction. (`provider-cooldown-start.test.ts`)
5. **Medium: a ledger first read by a recovery skipped the start's lift.** The gate calls `hooks.loaded` once when a
   recovery reads a ledger the start couldn't; the backend's `cooldownLoaded()` (the start's hold lift and the bound
   accounts' index) runs then too. Compaction stays a start's job. (`provider-cooldown-recovery.test.ts`)
6. **Medium: a second clock repair could bring back a saved hold** a lift had already handled (its fence then named an
   in-memory hold that never reached disk). The merge's hold rules use the same "at or after" fence as minimum and
   replay. (`packages/store/src/provider-cooldown.test.ts`)
7. **Medium: a keychain refusal could replace Google's** for the same credentials, and its local recovery then lifted
   the whole account. A keychain refusal never replaces another whole-account refusal, and `localRecoveryProof` only
   lifts a keychain refusal. (`account-status.test.ts`)
8. **Low: the met check used the elapsed rule a retired row doesn't need**, so a clock step right after a retirement
   re-waited the old minimum. `met()` uses the same zero-replay rule as `state()`. (`provider-cooldown-recovery.test.ts`)
