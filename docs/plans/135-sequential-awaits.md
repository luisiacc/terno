# Plan 135: sequential awaits on hot paths

- **Status:** built.
- **Builds on:** plan 20 (network resilience), plan 22 (icons), plan 62 (Gmail's quota pacer), the exact body parts (`threads.bodyPart`, drafts/w11-mime-byte-retention).

## The request

> do a deep scan of all hot paths and fix any unnecessary sequential async functions calls

## What exists

An AST scan of all production source (626 files, conformance suites and test helpers excluded) listed every `await` in a loop, every run of independent awaited statements, and every literal or call with several awaited members. That is about 700 sites. Most are yields, ordered writes or cursors. Reading them against one question decides each: **does the awaited call wait on real I/O, and does nothing force the order?**

Facts that decide most of them:

- **SQLite is synchronous** on both engines that matter (`node:sqlite` on desktop, sqlite-wasm over OPFS on the web). `await store.x()` there is a microtask: `Promise.all` saves nothing, and sequential reads can't be slower than parallel ones.
- **IndexedDB is the web's fallback engine.** Its reads answer from memory, but each one first waits for `settled()`, the commit in flight. Under sync writes, N sequential reads can wait for up to N commits; together they wait for one.
- **Attachment calls have a gate.** `handlers.ts:74` admits two at once and refuses the rest (`attachments.busy`). `inline-images.ts` documents this.
- **Body downloads have a gate.** `core.ts:1645` admits two body jobs at once and refuses the rest.
- **IMAP is one socket per connection** with a mailbox lock: its calls are serial on the wire.
- **`download()`** (`gmail-api.ts:317`) is the existing bounded pool: six at a time, stops starting work after the first failure, rethrows it. Gmail's first sync and flag reconcile use it.
- **The quota pacer** (`gmail-quota.ts`) charges every Gmail call at the moment it leaves, whatever the concurrency: 900 units of burst, then 85 a second.

## Design: what changes

Each is real waiting with no required order.

| # | Site | Waits on | Today | Change |
|---|---|---|---|---|
| 1 | `core/rpc/client.ts:105`, opening a thread | an RPC round trip per body part, plus a macrotask yield per part | one part at a time across every message and field | four at a time |
| 2 | `mail/gmail-api.ts:1291`, incremental sync's changed labels | one HTTP read per changed message | one at a time | `download()`, a page of 50 ids at a time |
| 3 | `mail/gmail-api.ts:1536`, trash | one HTTP POST per message | one at a time | `download()` |
| 4 | `backend/icons/service.ts:150`, `icons.data` | one file read per icon (≤ 50, the contract's cap) | one at a time | `Promise.all` |
| 5 | `backend/core.ts:696`, `reconnect` | a login per account needing a recheck | one account at a time, so one slow server holds every other account's watcher and parked mail | one task per account: its recheck, its watcher, then its own parked mail |
| 6 | `backend/core.ts:1657`, `readSelectedBody` | assembling every body in the thread, one after another | full `threads.get` to read one message's `bodyState` | `{ bodyFormat: "parts" }`: no body is read |
| 8 | `mail/google-photos.ts:93`, `collectGooglePhotos` | the user's own photo, one HTTP read, before the lists | Settings waits for it when photos are turned on | read beside the lists |
| 7 | `backend/handlers.ts:319`, `app.bootstrap`; `backend/settings.ts` `readSettings`; `backend/attention.ts:250`, `flush` | local reads (IndexedDB: a commit each, under load) | one at a time | `Promise.all` |

### Notes

**1. Body parts.** A pool of four pulls `{ message, field, ordinal }` from a generator, so a count is validated when it's reached and no array is sized from what the wire said. Parts land by ordinal, so completion order doesn't matter and code units stay exact, lone surrogates split across parts included. They're concatenated once all have arrived, in the same balanced rope as before (`balancedConcat`): `join("")` would copy a long body whole in one task, which w11 exists to avoid. `yieldTo` goes: each answer already arrives in its own task on every real transport, and its single resolver slot would lose wakeups under concurrency. The first failure rejects the call at once and drops the siblings' pending requests, so `pendingCount` is 0 when the caller hears (`rpc.test.ts:193`), and no worker starts another part. The deadline stays one, for the whole read. Nothing is published partially: fields are assigned only after every part arrived.

**2. Label changes.** Same as the refresh stage's `download` loop. A page's updates are written together, ≤ 50, and never an empty write. A 404 adds to `deleted` as before. A failure drops the page's unwritten updates and the cursor doesn't move, as today.

**3. Trash.** Bulk trash on Gmail waits on one POST a message. `/trash` is idempotent and a retryable failure retries the whole op, as today; `markDispatched` is a flag. Pacing still applies per request.

Failure, retryable or not: nothing not yet begun is sent, and the first error is what the operation hears. A trash that fails partway was always partial: today messages before the failure stay trashed and the op fails. What changes is which ones: up to five that had already begun finish as well, and a request already waiting for its token or quota slot may still go. A permanent failure (a 404) fails the op with those trashed, and the next sync reconciles them.

**5. Reconnect.** `recheckSignIn` catches its own errors and each account's state is its own. Each account keeps today's order: recheck, then watch, then `resumeNetwork(account.id)` and `kickWorker`. A refused account's mail therefore waits for its own answer rather than parking and announcing "waiting for sign-in" a moment before the login lifts it. An account's finished sync also resumes its parked mail (`core.ts:1908`), so the old barrier wasn't total: it lasted until that sync ended.

**7. Local reads.** No gain on SQLite and no harm: the same synchronous work in the same turn. The gain is on IndexedDB under writes.

## Deliberately left sequential

| Site | Why |
|---|---|
| `attachmentBlob` chunks, `cid.ts` images, `inline-images.ts`, `compose.ts:658` and `forward-files.ts:254` `attachments.info` | the backend's two-call gate would refuse them |
| `hydrateSelectedThread` per message | the two-job gate: a thread would use both slots and the next thread opened would be refused |
| Every `imap.ts` loop | one socket, mailbox lock |
| Operation worker, per account | operations on an account are ordered (`core.ts:2246`); accounts already run in parallel |
| `fetchFull` chunks of 50, `store.ingest` | ordered ingest, bounded memory; each chunk is already parallel inside |
| `batchModify` chunks of 1000, `threads.act` chunks of 5000, `undoActions` | writes; only above their chunk size |
| `registry.pick`, `category-snackbar` `filters.autoFor` | short-circuit on the first hit; in parallel the common case does more work |
| `requireCategory` before work (`handlers.ts:587` and others) | a guard that spares the work when it fails |
| `reminders` before the first list (`boot.ts:151`) | deliberate: the Inbox opens with due ones on top |
| `collectGooglePhotos`, the two lists | contacts must win over other contacts in one capped map, and a full map skips the second list's pages |
| `provider-cooldown` `admission` | one SHA-256 of an address per bound account, a handful at most, once per claimed batch: nothing measurable to gain |
| `messageByProviderId` per message, `locations.*` in IMAP, `core.ts` store pairs | synchronous on SQLite; pairs in send paths read a state machine |
| Autocomplete, instant index, facts, tabs, body upgrades, exports, imports | background slices: being one at a time is the point (principle 3) |
| IndexedDB `prepareBodyTests`, full `threads.get` | fallback engine, large bodies only; after #6 full `threads.get` only serves forwarding |
| AI SDK `load()` then helper `import()` | first call only, beside a request that takes seconds |

## Tests

- `rpc.test.ts`: never more than four parts in flight and more than one at once; a body reassembled exactly when parts answer out of order; a failure leaves nothing pending and starts no more parts.
- `gmail-outcomes.test.ts`: several changed messages read at once, updates batched ≤ 50, a 404 becomes a deletion, a failure stops further reads. `gmail-trash.test.ts`: several at once, all done, a failure rethrown.
- `google-photos.test.ts`: the lists don't wait for the user's own photo.
- `icons/service.test.ts`: reads overlap.
- `backend` tests: a held recheck doesn't stop another account's mail; `reader.hydrate` doesn't assemble bodies; bootstrap's and `readSettings`' reads overlap.
- `attention.test.ts`: the two reads overlap.

## Perf

Run `pnpm test:perf` for `gmail-history`, `gmail-batches`, `load`, `backend`, and `pnpm test:ui-perf`, since thread open is on the path. Report measured before and after with a simulated round trip.

## Out of scope

- Raising the attachment or body-job gates, which would unlock parallel attachment reads. That's a separate decision about backend load.
- Trashing through `batchModify` with the `TRASH` label (50 units per thousand against 20 each). It would be far cheaper, but Gmail's behaviour needs checking against a real account.
- Newest-first order in `hydrateSelectedThread`.

## Revisions after the Codex review

The plan critique changed these:

- **Reconnect** kept `resumeNetwork(null)` after all the rechecks, which left the barrier in place for parked mail. It's now per account (design note 5).
- **Trash** assumed every failure retries. A 404 is permanent (`gmail-api.ts:732`, `core.ts:2479`), so the partial outcome is now defined and tested.
- **`download()`** stops new callbacks, not requests already waiting for a token or quota. Accepted for both uses and stated in the notes.
- **The RPC tests** now use more than four parts, so failures land in a later wave, and they hold an unrelated call to prove cleanup touches only this read.
- **The label test** covers more than 50 candidates, out-of-order answers, a message's 404, a later failure, the replay, and an identity proof's own 404.
- **Trash through the managed path** has its own tests: tickets settle, a 429 is heard once, `RequestRun` matches what was sent.
- **Photos:** the user's own photo doesn't wait for, or hold up, the lists.
- **Cooldown digests:** the reason given was wrong; corrected above. Left alone: nothing to gain.

Found while implementing:

- `levels` is deliberate (w11). The plan's `join("")` would have put back a whole-body copy in one task.
- The first reconnect test passed against the old code: a sync finishing also resumes parked mail. The test now holds that sync.

The code review changed these:

- **Photos:** the early read's parsing could reject while the lists ran, with nothing attached yet, and the desktop backend exits on an unhandled rejection (rare: a 200 with a null body). A malformed answer now costs only that photo, and a test watches for the rejection.
- **Tests that passed on the old code:** the RPC failure, reattach and deadline tests now assert a whole wave was in flight, and the proof-404 test now fails its proof on the concurrent reads, not on `/history`.

## What was measured

Simulated latency, seven-sample median for threads and one run for Gmail, against the previous code. The thread cases use a 1 ms handler and a test transport, so they show the shape of the gain and not absolute times. The Gmail cases run without the quota pacer: in production the gain applies inside the 900-unit burst (45 reads or trashes at 20 units each), and past that the pacer's rate decides.

| Path | Before | After |
|---|---|---|
| Open a thread, 1 message, 2 parts | 9.8 ms | 1.6 ms |
| Open a thread, 10 messages, 20 parts | 69 ms | 6.4 ms |
| Open a thread, 1 long message, 40 parts | 122 ms | 14.5 ms |
| Open a thread, 30 messages, 120 parts | 213 ms | 40 ms |
| Label changes, 10 messages at 50 ms | 626 ms | 187 ms |
| Label changes, 45 messages at 50 ms | 2,477 ms | 483 ms |
| Trash, 10 messages at 50 ms | 515 ms | 105 ms |
| Trash, 45 messages at 50 ms | 2,311 ms | 413 ms |

Not measured: `icons.data`, the reconnect and `readSelectedBody` (each proved by a test of the behaviour), and the local reads (`Promise.all` on synchronous SQLite does the same work).
