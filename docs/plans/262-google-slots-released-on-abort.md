# 262: a Google request slot comes back when its request ends, aborted or not

## Request

> check out the terno app i have running, i haven't received any new mail since 9am, and there has been new mail, please investigate this
>
> ok lets do that fix then.

## What happened (2026-11-24, the owner's running nightly 0.1.7-nightly.202611240655)

Fifteen Gmail accounts, app open since 01:05 with sleep/wake and network changes. Between 09:26 and 09:44 a run of
"request offline" failures (deadline timeouts and network resets abort the request). From 09:44:42 on, every sync of
every account was refused before any request left the machine: `sync.failed` with `ProviderCooldownError`, reason
`capacity`, thrown by `net.googleAvailable("background")` in `google-requests.ts` (mapped from the shipped bundle's
frame). Every 40 s, 15 refusals; about 4,000 by noon. The durable cooldown ledger (`provider-cooldown:v1`) was clean:
one expired pause, no hold, no overflow. No mail arrived until a restart.

## What exists

`packages/backend/src/net-policy.ts` owns one physical pool for Google: 64 responses, of which background may take
62 and foreground (reader, send) 2. A slot is taken at dispatch and released on a proven terminal of the native
transport: body EOF, a body read error, a bodyless response, or a fetch rejection. Every one of those is guarded by
`if (!request.signal.aborted)`, and `cancel()` releases only after draining a `ResponseBodyLimitError` tail. Plan 62
chose this on purpose (lines 482, 498, 506): "cancellation/abort alone does not prove physical completion and
conservatively retains its slot … for this backend session". The session in that sentence is the whole app run, so
each abort leaks one slot for good. A Gmail request is aborted by its own deadline (`no answer in N ms`), by a
connectivity reset (wake, network change) and by a cancelled sync pass, all ordinary. After 62 of them background sync
is refused for the rest of the run, silently: the capacity wake (`googleChanged` → `cooldownChanged` → `capacitySync`)
waits for a release that never comes.

## Design

The pool counts Google fetches that haven't completed, in the Fetch Standard's terms: a slot comes back when the
fetch rejects, or when its native body ends (EOF, an error, or a cancel once the cancel settles). Aborts count:

- Aborting a request's signal *aborts the fetch*: a pending `fetch()` rejects with the reason, and a response body
  still streaming is errored ("abort fetch").
- The response body's cancel algorithm *aborts the fetch controller*: cancelling the body ends the fetch.

These are fetch-level completions. Whether the runtime keeps a connection open for reuse afterwards is the runtime's
business (Node's undici starts tearing the socket down through its dispatcher; a browser may keep a reusable one):
the pool bounds concurrent fetches, not sockets. Plan 62's separate boundary, physical retirement across a worker or
process handoff, is unchanged.

All in `net-policy.ts`:

1. **A tracker per response, armed when headers arrive.** The native reader is taken in the fetch's `.then`, before
   admission decides (a 429 may still be saving its pause). The tracker listens for the request's `abort` and
   watches `reader.closed`, so EOF, a native error (read or idle, `highWaterMark: 0` means nobody may be pulling) and
   an abort each end the slot without a reader. A bodyless response is over at once.
2. **One cancel.** Every path (the caller's cancel, an abort, an over-limit body) shares one `reader.cancel()`
   promise. A cancel closes the stream before the transport's cancel settles, so a close while cancelling waits for
   it; a second cancel can't resolve early against the closed stream.
3. **Nothing strands the count.** `release` exists before anything after the increment can throw; a synchronous
   throw from `fetch` (or the availability notification) gives the slot back.
4. **An over-limit body is cancelled at once.** The old tail drain (up to 32 chunks / 256 KiB, for a clean EOF)
   could wait for good on a stalled server once the caller's deadline was cleared.
5. **An aborted body reads as the abort.** A wrapped body whose native stream closed because of a cancel errors with
   the abort reason instead of closing, so a truncated body is never taken as complete.
6. **A retired response** (admission refused after headers) is still read to its end for a clean EOF, unless its
   request is aborted first; the tracker releases either way.

`release()` stays idempotent. The pool's bound (64 / 62 / 2) is unchanged. The cooldown ledger, the 429 and 403
observation paths and admission are untouched: the 403 transfer moves the *logical* ticket to the classifier, and
the physical slot follows only the fetch's own completion.

## Tests

`packages/backend/src/google-transport.test.ts` (unit; a fake fetch that behaves as the standard says: rejects on
abort, errors its body on abort):

- the incident: 62 background requests aborted before an answer, then the 63rd reaches the transport; and 100
  sequential deadline aborts each leave the pool at 0
- abort after headers with nobody reading frees the slot, and the body then reads as the abort
- an idle body's native error frees the slot with nobody reading
- abort while a read is pending holds the slot until the transport's (gated) cancel settles
- abort while a 429's pause is still being saved frees the slot before the save settles
- a fetch that throws synchronously gives the slot back, and the next request goes
- abort racing EOF on an in-flight read releases once, and availability is back
- a retired response aborted mid-drain is cancelled and frees its slot; a retired body failure releases aborted or not
- an over-limit body is cancelled after the 17 reads that find the overflow, no tail
- Node's own fetch against a loopback server: an abort before headers and one mid-body both free the slot
- the pool-exhaustion case keeps 64 open bodies at the bound, and a settled cancel admits the next request

`foreground-admission.int.test.ts` (scheduler level): with 62 held background bodies and account 12 refused for
capacity, a provider `reset()` (what a network change does) aborts held reads; with auto-sync the refused sync
resumes exactly once and reaches Gmail, without it nothing runs.

Changed because they pinned plan 62's retain-on-abort: `interruption-terminal-ownership.int.test.ts` (cancel / abort
then EOF now free the slot; an aborted body reads as the abort), `gmail-policy-admission.int.test.ts` (late 403 after
cancellation: the slot is held while the fetch is unanswered, back after), `gmail-history-ownership.test.ts`
(cancel frees the slot).

Every new and changed case fails on the old `net-policy.ts`.

## Performance and resources

One `abort` listener per response body still open, removed at its terminal; no timers. Fewer held slots means less
memory held by retained readers. Nothing on a hot loop.

## Out of scope

- Telling the user when Google requests are paused on capacity (a transient state once slots come back; the wider
  "mail stopped and nobody said so" audit is the follow-up below).
- A caller that keeps a response and never reads, cancels or aborts it: still holds its slot (a caller bug, looked
  for in the follow-up audit).
- The follow-up: an audit of every other way new mail can stop arriving (owner's request, same day), as its own plan.

## Revisions after the Codex review

Codex critiqued the plan and a first draft (10 points); all but the wording ones changed the code or tests:

1. Abort handling began only when the wrapper was built, after admission; a 429 still saving its pause held the
   slot through the abort. The tracker is now armed when headers arrive (test: abort during a gated save).
2. `reader.cancel()` resolves pending reads before the transport's cancel settles, so the first draft released
   early; one shared cancel promise now gates the release (test: gated cancel with a pending read).
3. A synchronous throw from `fetch` after the increment stranded the slot (test).
4. The over-limit tail drain could wait for good on a stalled server: cancelled at once now.
5. The late-403 test now also asserts the slot is held while the fetch is unanswered.
6. An idle body's native error had no path to release: `reader.closed` is watched (test).
7. The plan overstated what Fetch proves: reworded as fetch-level completion; a real Node fetch loopback test added.
8. The incident test now fills all 62 background slots before checking the 63rd; the EOF race gates a real read.
9. A scheduler-level test drives the abort through a provider reset and asserts one automatic resume.
10. Retired-drain and send ownership tests are kept and pass unchanged.
