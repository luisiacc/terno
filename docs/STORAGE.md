# Storage adapters

Única's backend talks to storage only through `MailStore` (`packages/store/src/mail-store.ts`): async, one atomic unit of work per method, plus a revisioned search feed. Anything that implements it and passes the conformance suite can hold a mailbox; the backend, providers, categorizer and MCP never know which one they got.

| Adapter | Package | Where | Search | Notes |
|---|---|---|---|---|
| `sqlite-node-sqlite` | `@unica/db` | Desktop (Electron utility process), backend-dev, tests | FTS5 + instant index | WAL, checkpoint worker, MCP readers |
| `opfs-sqlite` | `@unica/db/wasm` | Web, dedicated worker | FTS5 + instant index | SQLite-WASM on OPFS (sahpool), one tab at a time |
| `wasm-memory` | `@unica/db/wasm` | Node tests (project `db-wasm`) | FTS5 + instant index | in-memory images, the web's engine under the db suite |
| `idb` | `@unica/idb` | Web, dedicated worker | instant index, exact scan meanwhile | native IndexedDB, tables mirrored in memory, bodies on demand |

## Choosing one on the web

The worker builds a `StoreRegistry` (`packages/store/src/registry.ts`) in `apps/web/src/web/worker/stores.ts`, in preference order. `pick()` decides:

1. **requested**: `?storage=<id>` (e.g. `?storage=idb`). If unavailable, the app shows an error; it never substitutes another adapter.
2. **pinned**: the adapter the mailbox was created with (the page remembers it per mailbox, `unica:storage:<name>`). Same rule: unavailable is an error.
3. **existing**: whichever adapter already holds a mailbox of that name.
4. **default**: the first available adapter marked `automatic`. OPFS SQLite comes first; IndexedDB is the fallback where OPFS sync access handles are missing (it became automatic once it passed conformance and the browser perf gate).

An open error (corrupt file, newer schema, a handle another tab still holds) is shown as an error with a retry. The mailbox is never swapped for an empty one elsewhere.

## Adding an adapter (e.g. Postgres)

1. **Implement `MailStore`.** Every method is one atomic unit; nothing may interleave inside it. Start from the closest existing adapter: `SqlMailStore` (`packages/db/src/sql-store.ts`) if your backend speaks SQL (a Postgres port reuses the logic with a dialect port of the queries), `IdbMailStore` (`packages/idb/src/store.ts`) if it doesn't.
2. **Keep the outbox contract.** Each command that changes what search indexes (messages, bodies, threads, category memberships) appends **one** batch `{ seq, messageIds, threadIds }` under the next revision, in the same transaction; a rollback takes it along. `feed.changes()` serves absolute projections read at serving time; `feed.beginBuild()` holds the log while a rebuild scans. Cursors are valid only at their revision (`StaleCursorError` otherwise).
3. **Ops wait for sign-ins.** `ops.awaitAuth` puts a claimed op back without spending its attempt (next attempt `AWAITING_AUTH`, never scheduled); `ops.resumeAuth(account)` makes the account's waiting ops ready. The suite checks both.
4. **Search exactly.** Either a durable engine that answers every query exactly (FTS5, Postgres full text with the same semantics), or the instant index (`@unica/store/instant`) in front of an exact fallback. Never return a page that silently misses matches; slow is acceptable while an index builds, as long as it yields (time slices) and stops when `searchText`'s `signal` says the caller moved on.
5. **Pass the suite.** Add a harness next to your adapter:

   ```ts
   import { defineStoreConformance } from "@unica/store/conformance";

   defineStoreConformance("PgMailStore", {
     open: async () => PgMailStore.open(freshDatabase()),
     reopen: async (store) => { const url = (store as PgMailStore).url; await store.close(); return PgMailStore.open(url); },
     // optional: upgraded() (data written by your previous schema), strategies (FTS5-specific)
   });
   ```

   It covers threading, derived thread state under random operations, actions, the ops state machine and crash recovery, the search oracle on every page, keyset pagination, counts, filter rules against core's evaluator, categorization (training, removals, merges, moves, undo), the search outbox (one batch per command, rollbacks, cascades, merges, replay convergence, leases, epochs), durability and migrations.
6. **Register it** where the host builds its registry, with `automatic: false` until it has also passed the host's perf gate (`pnpm test:web-perf` with `WEB_PERF_STORAGE=<id>` on the web):

   ```ts
   registry.register({
     id: "pg",
     label: "Postgres",
     automatic: false,
     available: async () => true,
     exists: async (name) => pgHasMailbox(name),
     open: (o) => PgMailStore.open(o.name, { platform: o.platform, instantSearch: o.instantSearch }),
   });
   ```

7. **Report capabilities honestly** (`capabilities.engine`, `search`, `bulkRuleScan`, `durability`): hosts show them, and the renderer gates features on the host, not the store.

Migrations keep logical ids across adapters (v1–v7 today, see `packages/db/src/migrations.ts`); an adapter implements each id its own way (SQL scripts, IndexedDB version upgrades, resumable data jobs) and refuses data written by a newer version with `Database schema … is newer than this app`, so hosts handle it alike (reload, change nothing).
