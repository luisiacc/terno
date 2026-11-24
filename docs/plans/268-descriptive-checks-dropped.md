# 268: the database's descriptive value lists go, without rewriting a row

**Status (2026-11-24): stopped before building; the owner decides.** The plan below was drafted, critiqued and
prototyped; the prototype was reverted. Why, and the options, are at the end ("Why it stopped").

## Request

> (on dropping the other descriptive CHECK lists through `writable_schema`, after plan 267) yes if its performant

Plan 267's rule (AGENTS.md, Performance): descriptive values get no `CHECK (x IN …)` list; the store checks them, so a
new value is a code change, never a migration. CHECKs that guard behaviour (states) or structure (booleans) stay.

## What exists

33 value lists in the schema (a fresh database, `sqlite_schema`). Sorted by the rule:

- **Descriptive, dropped here (18):** `accounts.kind`, `owner.provider`, `owner.verified_by`, `ai_dated_mail.source`,
  `ai_sent_mail.source`, `ai_turns.kind`, `cls_decisions.kind`, `cls_decisions.outcome`, `cls_examples.source`,
  `dated_items.kind`, `dated_mutes.target`, `filters.source`, `followups.kind`, `forwards.rule_kind`, `reminders.kind`,
  `thread_categories.added_by`, `wanted_marks.source`, `writing_profiles.scope`.
  (v57 rebuilt `dated_items` only to add `ask` to its kinds; plan 259 needs `outlook` in the first three.)
- **States, kept (12):** `ai_digests`, `ai_prepared_replies`, `ai_summaries`, `capture_repairs`, `dated_items`,
  `followups` (and its `inbox_state`), `forwards`, `ops`, `waiting_acts`, `wanted_items`, and `messages.body_state`.
- **Structure, kept (3):** `drafts.show_source_context`, `filters.auto` (0/1), `cls_examples.label` (-1/1).

A table rebuild copies every row: `messages` alone is most of a 1.2 GB mailbox, and `accounts` is referenced
`ON DELETE CASCADE` by 24 tables (plan 259: a rebuild would cascade-delete them). `messages` keeps its list here, so it
isn't touched.

## Design

SQLite's documented way to change a table's constraints without touching its rows (lang_altertable.html, "Making
Other Kinds Of Table Schema Changes"): inside one transaction, read `PRAGMA schema_version`, turn on
`PRAGMA writable_schema`, `UPDATE sqlite_schema SET sql = …` for the table, set `schema_version` one higher, turn
`writable_schema` off. Removing a CHECK can't make a stored row invalid, so no `integrity_check` is needed (it would read
the whole file: seconds on a large mailbox). The cost is a handful of small updates to `sqlite_schema`, the same at any
size.

- **Migration shape.** A step may carry `schema: { table, from, to }[]` beside its SQL: text edits to a table's stored
  `CREATE TABLE`. One exported `applyMigration(db, m)` runs a step's SQL and then its edits; `migrate()`, the perf gate
  and every test helper that replays migrations (`test/legacy.ts`, `test/old-mailbox.ts`, `test/perf-mailbox.ts`,
  `open-errors.test.ts`, `attachment-accounting.test.ts`, `migrations.test.ts`) use it, so no replay skips an edit.
- **Edits are exact and checked.** `editSchema(db, edits)` (in `migrations.ts`) replaces `from` with `to` only where
  `from` occurs exactly once in the table's stored SQL (the text the migrations wrote, so it's the same in every
  mailbox); otherwise it leaves that table as it is (a list already gone, or text it can't be sure of). Then it bumps
  `schema_version` and prepares `SELECT * FROM <table> LIMIT 0` for each edited table: a statement that doesn't parse
  throws, and the step's transaction rolls back (`sqlite_schema` with it). Finally the statement cache is reset
  (plan 267's `resetStatements`).
- **SQL v81** carries the 19 edits (`CHECK (x IN (…))` removed, the column's type and NOT NULL kept), no SQL.
- **Engines.** Desktop runs Node's `node:sqlite`; the web build runs SQLite's WASM build. `SQLITE_DBCONFIG_DEFENSIVE`
  would refuse the update: both are tested (unit and db-wasm projects) by the migration test itself. If one refused,
  the step would fail and roll back (the mailbox stays at v80 and opens), and this plan would stop there.
- **The rule's records.** `migration-rule.test.ts`: the step rewrites no row (its SQL is empty; the edits touch the
  schema only), and `rowRewrites` stays a reader of SQL. `migrations-shipped.test.ts` hashes a step's SQL and, for a
  step that has them, its edits.
- **IndexedDB** has no CHECKs: nothing changes (no logical schema bump; the schema.ts comment says so).
- **Store validation.** Plan 267's rule puts the check in the store; these columns are written by typed code paths
  (TypeScript unions, zod at the RPC). No new validation is added here; out of scope below.

## Tests

- `migrations.test.ts`: a v80 mailbox with mail, accounts, categories, filters, dated items and follow-ups migrates to
  v81; every row of every table is unchanged; each of the 19 columns now takes a value outside its old list; a state
  list and a boolean still refuse one; `PRAGMA integrity_check` is ok (in the test only); a reopened file reads its
  schema; `schema_version` went up by one.
- `editSchema`: an edit whose text isn't there, or is there twice, changes nothing; an edit that leaves invalid SQL
  throws and the transaction rolls back (the table still has its CHECK and the file opens).
- the same migration test in the db-wasm project (the web's engine).
- `migrations.perf.test.ts`: v81 within the step budget on the 57,000-conversation mailbox (it's O(1)).
- `migration-rule.test.ts`, `migrations-shipped.test.ts`, `open-errors.test.ts`.

## Out of scope

- The 12 state lists and 3 structural CHECKs (kept by the rule).
- Store-level validation of the freed columns beyond the existing typed writes.
- Plan 259 no longer needs to widen `accounts.kind`, `owner.provider` and `owner.verified_by`: they're open after v81
  (its plan gets a note).

## Why it stopped

The Codex critique (12 points) and a check on the shipped runtime found two problems the plan can't absorb:

1. **The shipped runtime refuses the edit.** Electron 45's Node 24.22 (SQLite 3.53.4) opens databases in SQLite's
   defensive mode by default (Node turned it on in 24.14): `UPDATE sqlite_schema` fails with "table sqlite_master may
   not be modified" even with `writable_schema` on. The development shell's Node 24.3 allowed it, which is why the first
   probe passed. Doing it anyway means turning defensive mode off on the migration's connection
   (`DatabaseSync.enableDefensive(false)`, restored after): a deliberate hardening Node added, switched off in production.
2. **Most of these lists guard behaviour, not description.** `accounts.kind` picks the provider; `reminders.kind`
   decides whether a reply clears a reminder; `followups.kind` has its own lifecycle and partial indexes;
   `forwards.rule_kind` is the cancellation namespace; `dated_mutes.target` picks the key format; `cls_decisions`'
   kind and outcome drive maturity, undo and suppression; the queue `source`s decide expiry; `thread_categories.added_by`
   indexes training. By plan 267's own rule, dropping one needs store-boundary validation and a defined path for an
   unknown value, per column, with tests. Without that, a migration saved becomes a silent misbehaviour.

Smaller points it raised (kept for whoever picks this up): edits must abort, not skip, on a missing match; the cookie,
edits, validation and `user_version` belong in one transaction with `writable_schema=RESET`; replays outside a
transaction (`test/legacy.ts`, the smoke and OPFS helpers); WAL readers on an old snapshot; the db-wasm project excludes
`migrations.test.ts`; a real v80 → v81 open timed on the large mailbox.

Options:

- **A (recommended): keep these lists; apply the rule as each column needs a new value.** Plan 267's way: the step
  that adds a value removes that column's list, with the store's validation and unknown handling for that column, by a
  rebuild when the table is small or in place on the migration's connection. New schema follows the rule from the start.
- **B:** do all 18 now: defensive mode off on the migration connection only, plus the per-column validation and unknown
  handling for each (a large change across `db`, `idb`, `backend` and `core`).
- **C:** plan 259 (Outlook) widens `accounts.kind`, `owner.provider` and `owner.verified_by` itself; it has to deal with
  defensive mode the same way (its plan assumed `writable_schema` works).
