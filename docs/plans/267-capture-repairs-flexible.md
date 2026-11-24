# 267: every message Terno can't read safely becomes a repair, and the repairs table takes new reasons without a migration

## Request

> explain more about that decision for messages rejected from plan 265
>
> ok lets do hat fix and rebuild the table, lets also make it more flexible so things like that don't require a database
> change, unless is a hit oon performance, if we can have flexibility in the db and have logic on the app ourselves,
> whilekeeping performance, we should

## What exists

Incoming mail is parsed in a worker under hard limits (`incoming-processing-worker.ts`). A message refused for its own
content fails one of: too many MIME parts, nesting too deep, a header block too large, too many addresses, or too big
(`input-limit` / `result-limit`, or Gmail's raw response over its body limit).

- Plan 36 made the first two a **capture repair** (`capture_repairs`, SQL v36): the message is listed under Settings →
  "Messages needing repair" and sync goes past it. The table's DDL pins the reasons: `reason TEXT NOT NULL
  CHECK(reason IN ('mime-parts','mime-depth'))`, and `state ... CHECK(state IN ('blocked','pending'))`. The store
  validates the same list again (`blockCapture`, `packages/store/src/capture-repair.ts`).
- Plan 265 holds the other three in Gmail: the rest of the pass is stored, but the history cursor stays before the
  message, every pass downloads it again (for the size case, tens of MB a poll) and ends in its error, and after
  Gmail's history expires a full re-sync stops at that message's page.
- IMAP's body capture records only nesting depth (`imap.ts`, `syncBodies`); the other refusals throw out of the body
  run on every pass.
- The Settings list shows "Message 1", "Message 2" and the reason, never which message: a Gmail message whose
  capture was refused was never stored, so there's nothing to name it by.

Adding a reason means rebuilding the table, because SQLite can't alter a CHECK. The owner's rule from this request:
the database stays flexible and the app holds the logic, unless that costs performance.

## Design

### The table (SQL v80): rebuilt once, without the reason's list, with room for what we know

`capture_repairs` is rebuilt (create, copy, drop, rename, as v75 did for `waiting_acts`), in one transaction:

1. drop the two `message_locations` triggers that name the table (a rename fails while a trigger names a missing table)
2. create `capture_repairs_v80`: the same columns and foreign keys (both cascades), `reason TEXT NOT NULL` with **no
   CHECK list**, the `state` CHECK kept, and a new nullable `detail TEXT`
3. copy every row; drop the old table (its usage triggers go with it without firing); rename
4. recreate both indexes, the three usage triggers (after the copy, so nothing counts twice; `capture_repair_usage` is
   untouched) and the two `message_locations` triggers

`rewrites` names the DROP TABLE and why. At most 1,000 small rows per account: far inside the 1 s budget.

The reason's list goes: the store checks reasons (`blockCapture`), so a new one is a code change. The state's list stays:
`blocked` and `pending` decide what's selected, retried and completed, and an unknown state would break those rules.
`detail` is JSON of what's known about the message (`{ subject?, from?, date? }`, each part bounded), so new fields need
no migration. No column here is indexed by value or read on a hot path: none of this costs performance.

IndexedDB has no CHECKs: `detail` is an optional field (absent reads as none), so its logical schema doesn't change.

### Reasons

`CAPTURE_REASONS` in `@terno/core`: `mime-parts`, `mime-depth`, and new `mime-headers`, `mime-addresses`: every limit the
parser enforces (PostalMime's part count, nesting, header block size, forwarded addresses). `captureReasonOf(error)` in
`@terno/mail` maps the worker's codes and the parser's own (`EMAX*`, when a message is parsed in place) for both
providers. Not a reason: size (a big message is already stored envelope-only, `captureUnavailable: "size"`; the size
refusals left are malformed input or an oversized buffer), worker faults, timeouts (a quieter machine may pass), wrong or
repeated IMAP responses, stale UIDVALIDITY, store failures.

- Gmail: `processingError` returns an `IncomingCaptureRefusal` for all four; plan 265's held set keeps only
  `input-limit`, `worker-timeout` and `envelope-unavailable`. A full journal still holds the message (plan 265).
- IMAP body capture: all four become repairs and the body run goes on; a full journal skips that body (it stays
  pending) and the run goes on.

Reading is tolerant: a reason this build doesn't know (a newer build wrote it on the same schema) reads as `unknown` in
the shared projection (`captureRepair`, used by get, forMessage and both engines' lists) and shows a generic line; a
retry keeps the raw reason; `block` refuses an unknown one.

### Naming the message

- IMAP (and a Gmail message that is stored): `blockCapture` takes subject, sender and date from the stored envelope in
  the same transaction.
- Gmail's refused message was never stored, so nothing names it at block time. When the user opens the list,
  `listCaptureRepairs` reads the missing ones from Gmail's own parse of the headers (`describe`: `format=metadata`,
  Subject and From, `fields=id,internalDate,payload/headers`, the answer bounded to 64 KiB before parsing, its id
  checked), four at a time within 8 s, and keeps each with `describe` (only on the same revision, only when the row has
  none, only inside the byte cap). Nothing runs during sync and nothing runs unless the list is opened; each message is
  read once.

Byte accounting: a missing detail (absent, or SQLite's null) counts nothing, so old rows cost what they did; near the
cap a repair is recorded without its detail rather than refused.

### Copy (en and es)

`capture.headers`, `capture.addresses`, `capture.unknown`, `capture.noSubject`. The list shows the subject (or "No
subject"), the sender and the date, then the reason; a row without detail shows "Message N" as before. A row's
accessible name is its subject when known.

### AGENTS.md

Under Performance, beside the migration rules: descriptive values get no `CHECK (x IN …)` list in new schema (the store
checks them, an unknown one reads as unknown); CHECKs that guard behaviour or structure stay; data that may grow fields
goes in a JSON column the app validates.

## Tests

- `migrations.test.ts` (v80): repairs written by v79's own triggers on two accounts, both providers' locators, both
  states; after the migration every row is equal with `detail` null, the usage counts unchanged, `foreign_key_check`
  empty, the seven indexes and triggers present; a new reason goes in, an unknown state doesn't; update and delete deltas
  on the usage; a uid change, a removed location, a removed message and a removed account each take their repairs.
- `capture-repair-store.int.test.ts` (SQL, IndexedDB, WASM): the new reasons, an unknown one refused, `describe` only at
  its revision, bounded, once, surviving a retry and a reopen; an IMAP repair named from its envelope.
- `capture-repair-flexible.test.ts` (store): an unknown stored reason lists as `unknown` and a retry keeps it; no bytes
  for a missing detail; a malformed detail drops; near the cap the repair goes without its detail.
- `gmail-arrivals-first.test.ts`: headers and addresses refusals are repairs (siblings stored, cursor saved, the next pass
  reads nothing); plan 265's held cases now use `input-limit`; `describe` decodes the subject and sender and gives
  nothing for another id, a 404 or an answer past its bound (that case fails without the bound).
- `imap.int.test.ts`: a real message whose header block passes the parser's limit becomes a `mime-headers` repair named
  by its envelope, the next body is downloaded, a second pass completes (fails on the old `imap.ts`).
- `capture-repair-detail.int.test.ts` (backend, through the RPC): the list reads each Gmail repair once, keeps what it
  learns, and returns the page when a read fails or says nothing.
- `capture-recovery.test.tsx`: every reason's line, `unknown`'s generic one, subject or "No subject" or "Message N" as
  the accessible name, the sender and date.

`migrations.perf.test.ts`, and `pnpm test:all` (a migration and the store contract).

## Out of scope

- The other `CHECK (x IN …)` lists (about 35 in 25 tables): listed for the owner. Most guard states (behaviour), which
  the rule keeps; the descriptive ones can go when their table is next rebuilt. `messages` (`body_state`) can't be
  rebuilt within the 1 s budget on a large mailbox.
- Reconciliation and backfill passes still stop at a message whose repair can't be recorded because the journal is full
  (plan 265 holds it only on incremental passes); the journal holds 1,000 repairs per account.
- Telling the user outside Settings that a message needs repair.

## Revisions after the Codex review

Codex critiqued the first draft in 12 points; the design above is the result:

1. Rebuild order: the location triggers dropped before and recreated after (confirmed: the rename fails otherwise), one
   transaction, foreign keys kept, `rewrites` naming the DROP TABLE.
2. The migration test seeds a populated journal through v79's triggers and checks the counts, the foreign keys, the
   deltas and every cascade.
3. **`too-large` dropped**: big messages are already stored envelope-only; the size refusals left aren't the message's
   verdict.
4. Only the parser's limits map to reasons; the IMAP test uses a real oversized header block through the production path.
5. **The Gmail detail read left the sync path**: it held a shared read permit through quota pacing and token refresh.
   It runs when the list is opened, bounded, once per message.
6. The metadata read is bounded before parsing, asks only for the fields it needs, and checks the id.
7. Reconciliation and backfill with a full journal: written down (out of scope).
8. IMAP: wrong or repeated responses stay out of the mapping; a full journal skips the body and the run goes on.
9. Unknown reasons decoded in the shared projection; a retry keeps the raw reason.
10. **The state CHECK stays** (it guards behaviour); the AGENTS.md rule is narrowed to descriptive values.
11. A missing detail costs no bytes; near the cap a repair goes without one. IndexedDB's logical schema stays at 79: the
    only change is an optional field an older build ignores.
12. The Settings test covers every reason, `unknown`, "No subject", "Message N" and the accessible names.
