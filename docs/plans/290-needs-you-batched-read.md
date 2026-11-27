# Plan 290: Needs you's last check, one read a table on SQLite

## The request

The owner, 2026-11-26/27, after `pnpm test:all` failed on the Today perf gate: "yes" to batching the read, rather than
raising SQLite's Today budgets by 40–50 %.

## What exists

`needsRows` (`packages/db/src/today.ts`) walks at most `NEEDS_WALK` (2,000) waiting threads, lets `needsYou` (plan 145)
and the muted senders (plan 210, iteration 4) narrow them, then asks `stillWaiting` about each one (plan 204's second panel
round, tightened by plans 210 and 240). `stillWaiting` is up to six single-row statements per thread:

1. `dated_nothing_asked` by thread (plan 210, iteration 2), unless the sender is always shown (plan 240);
2. their latest received message (id, date, and its text when the snippet starts like a thanks), only when a rule needs it;
3. the handled `dated_items` by thread;
4. the thread's promises, aggregated (closed at, open, put off);
5. its `ai_summaries` row, unless the sender is always shown;
6. whether anything arrived after a summary that asks nothing.

63c2f0444 (plan 210, iteration 2) added (1) and made (2) run for every thread with a reading, and gave every conversation
in the gate's "Needs you at its bound" such a reading. Since then SQLite's gate has failed: that scenario's list p95 went
from 36–42 ms to 63–90 ms (a bisect, median of three runs a step, 2026-11-27), its longest busy turn to ~100 ms
(gate 60–70), the spread's added time to 4.7 ms (gate 2), People's longest turn to 157 ms (gate 120). A full run stops at
the first failing check, which hid how far over it was. IndexedDB is within its gates or a hair over; it's out of scope.

## Design

`stillWaiting(db, threadId, …)` becomes `stillWaitingAmong(db, rows, now)`: the same rules in the same order for each
thread, over facts read once for the whole walk:

- `dated_nothing_asked`, `dated_items` (handled), `followups` (promises, grouped by thread) and `ai_summaries`: one
  statement each, `thread_id IN (SELECT value FROM json_each(?))` on the index each uses today (`…_thread`), keyed back by
  thread in a `Map`.
- Their latest received message: one statement for the threads a rule needs it for (a reading or a handled item, a
  closed promise, a thanks-like snippet), a correlated `ORDER BY date DESC, id DESC LIMIT 1` per thread on
  `messages_thread` as today, the body's text only for the thanks-like ones.
- Arrived after the summary: one statement for the threads whose current summary asks nothing, the same `EXISTS` per
  thread.

What each thread decides is unchanged: a rule reads the same fact it read before, so the store contract's Today and
dated conformance cases (`packages/store/src/conformance/today.ts`, `dated.ts`) hold as they are. The sender-shown
exemptions (plan 240) still skip the reading and the summary.

## Tests

- The conformance suite on both SQLite engines (node-sqlite in `unit`, WASM in `db-wasm`): `store.conformance.test.ts`.
- `today.perf.test.ts` (both stores), unchanged budgets: SQLite back under them.
- `pnpm test:all` (shared query code in `packages/db`).

## Perf

From up to ~6 × 2,000 statements a walk to 6. Each batched statement is bounded by the walk (2,000 ids in one
`json_each`) and uses the same index.

## Out of scope

IndexedDB's `stillWaiting` (within its gates); raising any budget.
