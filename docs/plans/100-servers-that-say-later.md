# Plan 100: servers that say "later"

## Request (verbatim)

> look for potential bugs of similar to this one for other operations or maybe on the smtp integrtion too, if you find any, fix them

"This one": a Gmail first sync paused for good (plan 62 fixes of 2026-10-31/11-01): a temporary refusal turned into a state nothing ever left.

## What the audit found (IMAP/SMTP; Gmail's are in plan 62)

1. **A login refused for "too many connections" asked the user to sign in again.** Only `[UNAVAILABLE]` counted as temporary; `[LIMIT]`, `[INUSE]`, Gmail's "Too many simultaneous connections" or "exceeded command or bandwidth limits" became a sign-in error: sync stopped polling and every op parked for a sign-in until a restart or a network change.
2. **IDLE stopped for good after one refused login** (it never retries a refused login, rightly), even when the command session then logged in with the same password: push stayed off with no visible error.
3. **A throttled command failed for good and undid the user's change.** Every NO/BAD was permanent; Microsoft's `Request is throttled` (imapflow `ETHROTTLE`) too. imapflow resolves STORE/MOVE/COPY/DELETE `false` on any error, so the reason was lost: a busy STORE settled as failed and the message went back to unread.
4. **A refused MOVE became "unknown" with its message held for good** (the identity hold is released only by a mapped move; sync skips held messages and actions on them park).
5. **SMTP 4xx (and every retryable op) had eight tries in about two minutes**; servers defer for minutes to hours (`421 Try again later`, `454 Too many login attempts`).

No connection bursts (one command and one IDLE session per account), no ordering races and no duplicate-send path were found.

## Design

- `temporaryRefusal()` (imap.ts): RFC 5530 `UNAVAILABLE`/`INUSE`/`LIMIT`/`SERVERBUG`/`THROTTLED`, imapflow's `ETHROTTLE`, and the busy texts servers send without a code. An explicit credentials code (`AUTHENTICATIONFAILED`, `AUTHORIZATIONFAILED`, `EXPIRED`, `PRIVACYREQUIRED`, `CONTACTADMIN`, `NOPERM`) always wins: retrying a wrong password locks accounts. A temporary login refusal is retryable; other temporary refusals are `ProviderError.deferred`.
- imapflow's logger (a `warn` only; nothing logged) keeps a client's last command error, so a command it resolved `false` is classified: temporary (deferred, retried), refused (permanent, never "unknown"), or no reply (as before: a dead session after a change is "unknown"). `RefusedChangeError` passes `withConnection`'s unknown conversion; a deferred error skips its instant reconnect-retry (the session is fine; the op's backoff waits).
- A refusal that proves nothing changed releases its admission's identity holds (`ImapLocationStore.refused(ids, holdOwner)`, SQL and IDB): a refused COPY (atomic, RFC 3501; also the no-MOVE fallback's first step) or a refused MOVE of one message (RFC 6851 lets a refused MOVE of a larger set move part of it). Anything else stays held as before.
- IDLE remembers a refused login and starts again when the command session logs in successfully.
- `ProviderError.deferred` + `OpPark { deferred: true }`: an op the server keeps deferring is retried for a day from its creation (`DEFERRED_RETRY_MS`; 5 minutes apart once the backoff caps) instead of eight tries. SMTP 4xx is deferred (5xx stays permanent; a connection lost after DATA stays ambiguous, never resent).

## Tests

`net-errors.test.ts` (classification, credential precedence), conformance (a day of deferred retries; `refused` releases only its owner's holds) on SQL and both IDB modes, `imap-old-flags.int.test.ts` (throttled STORE retried and lands; refused single MOVE retried, not unknown, not held; refused fallback COPY released and done; refused multi-message MOVE stays held), `imap-idle-foreground.int.test.ts` (IDLE back after the command session logs in). Each fails without its fix.

## Codex review

Three findings, all fixed with a regression: a refused MOVE of several messages may have moved part of them (holds now released only for one message, or a COPY); a refused fallback COPY was left held and parked (now released, it changed nothing); a credentials code with "try again later" text was treated as temporary.

## Out of scope / known

- A hold from a genuinely ambiguous change (a lost acknowledgement, a failed EXPUNGE after the fallback's COPY, a partly refused multi-message MOVE) still has no automatic way out: the user is told to manage the message in their mail provider. Resolving those by re-reading the server is its own design.
- The server's suggested wait (`ETHROTTLE`'s `throttleReset`, SMTP texts) isn't read; the capped backoff applies.
