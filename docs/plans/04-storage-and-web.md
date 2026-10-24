# Plan 04: pluggable storage + web client

Status: proposed. Scope: `packages/db` (driver seam, body split), new `packages/store` (interfaces, conformance), `packages/backend` (store-only, platform seam), `packages/mail` (ProviderStore, web registry), `apps/web` (web target, worker host, nudge), CI. Coordinates with **03-search-engine** (SearchEngine seam, §3.4) and with 02/05 (migration numbering, §6).

## 1. Decisions

1. **On the web, the backend runs in a dedicated Web Worker**, not on a server. The renderer talks to it over a `MessagePort` with the same RPC as desktop. Gmail uses REST with CORS. IMAP/SMTP, MCP and background sync with the tab closed are **desktop-only**.
2. **Two seams:**
   - **`MailStore`** (async, one atomic unit of work per method) is the plug-and-play boundary the backend uses.
   - **`SqliteConnection`** (sync) sits under the shared SQL code. node:sqlite and SQLite-WASM are two connections under the same `Db`, migrations, planner and rule compiler.
3. **Web default: SQLite-WASM on OPFS (`opfs-sahpool` VFS).** It is synchronous in a worker, runs the same SQL and FTS5, needs no COOP/COEP, and is browser storage with the same quota and eviction rules as IndexedDB.
4. **A native IndexedDB adapter** (`IdbMailStore`) uses object stores, sparse compound indexes in place of partial indexes, and an in-memory postings `SearchEngine` persisted in IDB. It is the fallback when OPFS sync handles are missing, can be forced with `?store=idb`, and is the reference adapter that proves the seam.
5. **Rejected: IDB as persistence under SQLite** (wa-sqlite `IDBBatchAtomicVFS`, absurd-sql). An async VFS makes every SQL call async, and absurd-sql is unmaintained. OPFS SAH already covers Chrome 108+, Safari 16.4+ and Firefox 111+.
6. **Sync vs async:** `MailStore` returns Promises and SQL internals stay synchronous. The boundary costs **+0.002 ms** p50 on desktop (0.2215 vs 0.2221 ms). SQL transactions stay sync, so nothing can interleave inside one.
7. **Schema change on both platforms: bodies move to `message_bodies`.** On OPFS, page-cache fit decides performance (§2).
8. **`apps/backend-dev` stays** as the Node e2e/parity host. The web host is new code in `apps/web/src/worker/`.

## 2. Evidence (prototypes in `/tmp/unica-storage-lab`)

A 60-line `node:sqlite` shim over `@sqlite.org/sqlite-wasm` 3.54.1 ran **the repo's unmodified `packages/db`** (seed, list, search, counts, thread, filter preview, actions). The only browser blockers were `node:crypto` (`repos.ts`) and `node:worker_threads` (checkpoint worker). Dataset: 51,461 messages, 29,500 threads, 8 accounts, `bodyScale: 4`.

| p95 ms (50k msgs) | node:sqlite (desktop) | WASM in-mem (Node) | **OPFS SQLite, Chromium worker** | **Native IDB, Chromium** |
|---|---|---|---|---|
| list inbox first page | 0.34 | 0.88 | 0.8 | 0.7 (`getAll` on sparse index; cursor 1.2) |
| deep keyset page | 0.30 | 0.85 | 0.9 | 0.6 |
| category view | 1.29 | 2.07 | 1.8 | 1.7 |
| sidebar counts | 3.07 | 3.76 | 3.5 | 0.2 |
| open thread | 0.05 | 0.09 | 0.7 | 0.2 |
| search "factura" / "reunion" | 9.4 / 11.8 | 15.4 / 16.6 | **910 / 1008** → **10.4 / 13.5** after body split | 3.9 / 4.9 (memory postings) |
| search prefix "propu" | 1.1 | 1.4 | 1.8 | 0.3 |
| filter preview (scan) | 14.9 | 20.6 | 1107 → **15.3** after body split | 433 (naive scan) |
| archive + restore (2 write tx) | 0.21 | 0.19 | 14–16 | 0.3 (default durability) |
| seed / import 51k | 10.9 s | 13.4 s | 37.7 s (incl. FTS + threading) | 1.0 s raw `put` (52k msg/s) |

- **Boot:** sqlite3.wasm is 408 KB gz. WASM init plus SAH-pool install takes 44 ms; reopening a 195 MB OPFS DB and listing the first page takes 13.9 ms. Chromium quota: 11 GB.
- **The OPFS cliff is the page cache, not the VFS.** With bodies inline, the FTS hit→`messages` join reads more than 64 MB of pages and thrashes; a 256 MB cache gives 13 ms. After the split (messages 46 MB, bodies 52 MB, FTS 62 MB), a 64 MB cache gives 10–13 ms but **32 MB gives 556 ms**. At 10k messages every configuration is ≤ 3 ms.
- **WAL** works on sahpool with `locking_mode=EXCLUSIVE` but gains nothing (12.2 vs 13.9 ms per write pair).
- **Row decoding:** `stmt.get([])` with cached column names halved WASM list time compared with `get({})` (1.54 → 0.88 ms).
- **IDB postings:** building from 51k messages takes 1.7 s (11.4k terms, 15.4 MB); persisting one segment takes 33 ms and reloading 10 ms.
- **The IDB column is optimistic.** Its search is free-text AND plus prefix only (no field scoping, phrases or negation). Its "action" rewrites one thread and its messages, without ops or user-action rows. Its import is raw `put`, without threading or aggregates. Treat these as floors, not adapter numbers.
- **fake-indexeddb** (Node, 10k messages) is correct and fast enough for conformance, but not for perf.
- **Not verified:** WebKit and Firefox (browsers not installed). They are required CI before GA.

## 3. Interfaces

### 3.1 Architecture

```
DESKTOP (unchanged topology)                    WEB (static site, no server)
Renderer ──MessagePort──▶ utilityProcess        Renderer tab ──MessagePort──▶ Dedicated Worker (leader tab, Web Locks)
                          Backend                                              Backend (same code)
                          ├─ SqlMailStore                                      ├─ store = registry.pick()
                          │   └─ Db ◀ NodeSqliteConnection (WAL, mmap)         │   ├─ SqlMailStore ◀ Db ◀ WasmSqliteConnection (opfs-sahpool)
                          ├─ Fts5SearchEngine                                  │   └─ IdbMailStore (+ PostingsSearchEngine)   [fallback / ?store=idb]
                          ├─ providers: IMAP, SMTP, Gmail, demo                ├─ providers: Gmail (REST+CORS), demo
                          ├─ checkpoint worker, agent socket (MCP)            ├─ cipher: WebCrypto AES-GCM, non-extractable key in IDB
                          └─ cipher: safeStorage via main                      └─ platform: yield = MessageChannel, uuid = crypto.randomUUID
apps/backend-dev: Node WS host (e2e/Playwright), any store incl. sqlite-wasm-memory for parity
```

### 3.2 SQL connection seam (`packages/db`)

```ts
/** The subset of node:sqlite that Db uses. Both drivers implement it synchronously. */
export interface SqliteConnection {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  function(name: string, opts: { deterministic?: boolean }, fn: (...a: SqlValue[]) => SqlValue): void;
  readonly isOpen: boolean;
  close(): void;
}
export interface SqliteStatement {
  all(...p: SqlValue[]): Row[]; get(...p: SqlValue[]): Row | undefined;
  run(...p: SqlValue[]): { changes: number; lastInsertRowid: number };
}
export interface SqliteDriver {
  id: "node-sqlite" | "wasm-opfs" | "wasm-memory" | (string & {});
  open(path: string, o: { readonly?: boolean }): SqliteConnection;
  /** pragmas applied by Db after open (desktop: WAL/mmap/fullfsync; web: no WAL, adaptive cache_size) */
  pragmas(o: { readonly: boolean; hotBytes?: number }): string[];
  features: { externalReaders: boolean; checkpointWorker: boolean; mmap: boolean };
}
export function openDatabase(path: string, o: OpenOptions & { driver?: SqliteDriver }): Db; // default: node driver
```

`Db` (LRU, savepoint `tx`, `dataVersion`) is unchanged apart from taking a connection. `startCheckpointWorker` runs only when `driver.features.checkpointWorker` is set. The web cache rule is `cache_size = clamp(1.3 × (pages(messages) + pages(messages_fts*)), 64 MB, 192 MB)`, recomputed after imports.

### 3.3 Store seam (`packages/store`, no Node/DOM deps)

```ts
export interface StoreCapabilities {
  engine: string;                         // "sqlite-node" | "sqlite-wasm-opfs" | "indexeddb" | …
  search: string;                         // SearchEngine id
  bulkRuleScan: "indexed" | "scan";       // filter preview/apply over all mail
  imapLocations: boolean;                 // ImapLocationStore available
  externalReaders: boolean;               // other connections may write (MCP on desktop)
  durability: "fsync" | "browser";
}

/** Each method is ONE atomic unit of work. There is no generic cross-call transaction. */
export interface MailStore {
  readonly capabilities: StoreCapabilities;
  open(): Promise<{ from: number; to: number }>;   // runs this adapter's migrations
  close(): Promise<void>;

  threads: {
    list(p: ListParams): Promise<Page>;
    summaries(ids: readonly number[]): Promise<ThreadSummary[]>;
    get(id: number): Promise<ThreadDetail | null>;
    counts(): Promise<Counts>;
    search(p: SearchParams): Promise<SearchResult & { complete: boolean }>;  // delegates to SearchEngine
    /** local optimistic change + user-action log + provider ops, atomically */
    act(c: { threadIds: number[]; action: ThreadAction; origin: Origin; now: number }): Promise<{ threadIds: number[]; opIds: string[] }>;
  };
  sync: {                                  // what Backend's SyncSink calls, per slice
    ingest(batch: IncomingMessage[], o: { applyFilters: boolean; now: number }): Promise<{ inserted: number[]; touched: number[] }>;
    setBody(id: number, text: string | null, html: string | null, now: number): Promise<{ touched: number[] }>;
    updateFlags(accountId: number, u: FlagUpdate[]): Promise<{ touched: number[] }>;   // skips pending-op messages inside the tx
    remove(ids: number[]): Promise<{ touched: number[] }>;
    pendingMessageIds(accountId: number): Promise<Set<number>>;
  };
  ops: {
    claimReady(now: number, limit: number): Promise<OpRow[]>;
    get(id: string): Promise<OpRow | null>;
    complete(id: string, r: ProviderResult | void, now: number): Promise<{ touched: number[] }>; // incl. provider id adoption
    fail(id: string, error: string, retryable: boolean, now: number): Promise<OpState>;
    markUnknown(id: string, error: string, now: number): Promise<void>;
    recover(now: number): Promise<{ requeued: number; unknown: number }>;
    nextAttemptAt(): Promise<number | null>;
    recent(limit: number): Promise<OpRow[]>;
    resolveUnknown(id: string, r: "markSent" | "retry" | "discard", now: number): Promise<{ touched: number[] }>;
  };
  compose: { queueSend(c: SendCommand): Promise<{ opId: string; threadId: number }> };
  filters: {
    list(): Promise<Filter[]>; get(id: number): Promise<Filter | null>;
    save(f: FilterInput, now: number): Promise<Filter>; delete(id: number): Promise<void>;
    preview(rule: FilterRule, now: number, limit: number): Promise<{ count: number; sample: ThreadSummary[] }>;
    /** one bounded chunk; Backend loops and yields between chunks */
    applyChunk(id: number, cursor: number | null, now: number): Promise<{ next: number | null; touched: number[] }>;
  };
  categories: CategoryRepo;   // list/create/update/delete/addThreads/removeThreads/suggest/dismiss
  accounts: AccountRepo;      // list/get/config/create/update/remove/setSyncState/setProviderConfig
  drafts: DraftRepo; settings: KvRepo; secrets: BlobRepo;
  learning: { actionsSince(t: number): Promise<UserAction[]>; dismissedKeys(): Promise<Set<string>>; learnedKeys(): Promise<Set<string>> };
  providerStore(accountId: number): ProviderStore;
  /** test-only, required: plain rows for oracles and property tests */
  debug: { snapshot(): Promise<StoreSnapshot>; verify(): Promise<void> };
}

/** Replaces ProviderContext.db; the SQL impl holds today's imap.ts/gmail.ts SQL verbatim. */
export interface ProviderStore {
  messageByProviderId(providerMsgId: string): Promise<{ id: number; subject: string; fromEmail: string } | null>;
  knownProviderIds(ids: readonly string[]): Promise<Set<string>>;
  recentMessages(since: number): Promise<{ id: number; providerMsgId: string; date: number }[]>;
  pendingBodies(limit: number): Promise<PendingBody[]>; countPendingBodies(): Promise<number>;
  locations?: ImapLocationStore;           // present iff capabilities.imapLocations
}

export interface StoreFactory {
  id: string;
  available(): Promise<boolean>;           // e.g. OPFS SAH probe; IDB open probe
  create(o: { name: string; search?: SearchEngineFactory; platform: Platform }): Promise<MailStore>;
}
export function registerStore(f: StoreFactory): void;
export function pickStore(preferred?: string): Promise<StoreFactory>; // web: ?store= → opfs → idb

export interface Platform {
  yield(): Promise<void>; uuid(): string; now(): number;
  cipher: SecretCipher; fetch: typeof fetch;   // fetch injection is shared with plan 05
}
```

The composite transactions now in `Backend`/`handlers.ts` become store commands: `act`, `ingest` with filters/claims/ops, `updateFlags`, `ops.complete`, `queueSend`, `applyChunk`, `resolveUnknown`. The SQL implementation calls the **existing** functions inside `db.tx`, so code moves rather than being rewritten. `Backend` keeps the orchestration: slicing, sync loops, the ops worker, providers, events, AI, latest-wins search and MCP authorization.

### 3.4 SearchEngine seam (03-search-engine fills it in)

```ts
export interface SearchEngine {
  readonly id: string;
  readonly features: { phrase: boolean; prefix: boolean; fields: boolean; negation: boolean; snippets: boolean };
  /** "store" = maintained by the store's own writes (FTS5 triggers); otherwise the store calls it in-command */
  readonly indexing: "store" | SearchIndexer;
  search(q: SearchQuery /* core AST */, s: SearchScope, page: { cursor?: Cursor; limit: number }, host: SearchHost): Promise<SearchResult>;
  completeness(): Promise<{ complete: boolean; pendingBodies: number }>;
  verify(): Promise<void>;                 // integrity: FTS5 'integrity-check' or postings vs snapshot
}
export interface SearchIndexer {
  upsert(docs: SearchDoc[]): void | Promise<void>;   // SearchDoc = message id + normalized fields
  remove(ids: readonly number[]): void | Promise<void>;
  flush(): Promise<void>; rebuild(src: AsyncIterable<SearchDoc>): Promise<void>;
}
/** Provided by the store: the engine returns message hits; the store owns thread filters + keyset order. */
export interface SearchHost {
  threadsForMessages(ids: Iterable<number>, f: ThreadFilter, cursor: Cursor | undefined, limit: number): Promise<Page>;
  walk(f: ThreadFilter, cursor: Cursor | undefined, limit: number, pred?: MessagePredicate): Promise<Page>;
}
```

Contract:
- All message predicates must match the **same message** before deduplication.
- Hits are never LIMITed before thread filtering. Cursors stay `{lastDate, id}`.
- `Fts5SearchEngine` is today's `search.ts`, a fused SQL query that ignores `host`.
- Engines are chosen per store and can be overridden with `create({ search })`. The oracle test runs per (store, engine) pair.

## 4. Adapter matrix

| | node:sqlite (desktop) | SQLite-WASM OPFS (web default) | SQLite-WASM memory (Node tests) | IndexedDB native (web fallback) | Postgres (future server) |
|---|---|---|---|---|---|
| Shared SQL code | 100% | 100% | 100% | none (native) | logic only (dialect port) |
| Search | FTS5 planner | FTS5 planner | FTS5 planner | postings engine (plan 03) | tsvector engine |
| Sync/async inside | sync | sync (worker) | sync | async | async |
| Multi-connection | yes (MCP, checkpoints) | no (one tab = leader) | no | yes, but one writer by design | yes |
| IMAP locations | yes | n/a on web | yes | optional | yes |
| Bulk rule scan | indexed SQL | SQL (15 ms @50k) | SQL | JS scan (~0.4 s @50k) | SQL |
| Expected p95 list / search @50k | 0.3 / ≤ 12 ms | 0.8 / ≤ 14 ms | 0.9 / ≤ 17 ms | 0.7 / ≤ 5 ms | n/a |
| Durable commit | 0.1–0.2 ms | 3–7 ms | n/a | ~0.3 ms | network |
| Features that are SQL-only (e.g. plan 02) | ✓ | ✓ | ✓ | gated until ported | port |

**IDB design:**
- `threads` carries sparse view keys, present only while the thread is in that view (`vInbox=[-lastDate,-id]`, `vAcctInbox=[acct,…]`, `vAll`, `vArchive`, `vStarred`, `vSent`, `vTrash`, `vSpam`, `vUnreadInbox=acct`). These act as partial indexes, and the negated keys make ascending `getAll(range, n+1)` return newest first.
- Other stores: `messages` (by thread, provider, rfc, from, domain, list, body-pending), `message_bodies`, `message_refs`, `thread_categories` keyed `[cat,-lastDate,-id]` (rekeyed in-tx), `category_stats`, `ops`, `op_targets`, `filter_applications`, `user_actions`, `drafts`, `settings`, `secrets`, `search_segments`, `meta`.
- Auto-increment ids are never reused.
- Aggregates use a pure `core.deriveThreadAggregate`, which is also the property-test oracle. Rules use core `evaluateRule`, whose parity with SQL is already tested.
- Durability is `strict` for actions, ops and sends, and `relaxed` for re-fetchable imports.
- Commands await only IDB requests; the `idbTx` helper surfaces `TransactionInactiveError` in tests.

## 5. Web client

- **Host.** `apps/web/src/worker/backend.worker.ts` picks the store, builds `Backend({ store, platform: webPlatform, providers: webRegistry })`, serves RPC on a `MessagePort` and calls `navigator.storage.persist()`.
  - It takes the Web Lock `terno-backend`. A second tab offers "Terno está abierto en otra pestaña · Usar aquí" (handover via sahpool `pauseVfs`).
  - `connection.ts` gets a `VITE_TARGET === "web"` branch that reuses `portTransport`.
- **Browser-safe packages.** core, store, db (minus the node driver), backend (minus `agent-socket`/`transports`) and `mail/gmail` must bundle for the browser.
  - `node:crypto` → `globalThis.crypto`; `node:timers/promises` → `platform.yield`; `Buffer` → core base64url; the OAuth loopback server becomes a per-platform `connectGmail`.
  - `@terno/mail/registry-web` exports Gmail and demo only.
  - A CI esbuild check fails on any `node:` import.
- **Gmail on web.**
  - Google Identity Services token model with a user-supplied *Web* client ID (bring-your-own, like desktop).
  - Access tokens (1 h) live only in worker memory. Without a server there is no refresh token, so on expiry sync pauses behind a one-click "Reconectar Gmail" chip (the popup needs a user gesture).
  - A stateless token broker is deferred. `gmail.modify` is a restricted scope and needs Google verification before public hosting.
- **Capability gating** via `bootstrap.platform = { kind, capabilities }`. Off on web: IMAP/SMTP (no TCP), MCP/agents, sync with the tab closed, OS notifications.
  - Secrets use AES-GCM with a **non-extractable** `CryptoKey` in IDB. That protects data at rest and in exports, not against same-origin script, so CSP, Trusted Types and the sandboxed mail iframe are mandatory.
- **Desktop nudge.** Honest and quiet, never shown during compose:
  - **Onboarding:** "Terno es mucho más rápido en Mac". Primary **Descargar para Mac**, secondary "Seguir en el navegador".
  - **Banner:** one line above the list, dismissible for 7 days, at most once per session.
  - **Settings → "Terno para Mac":** compares IMAP, agents, background sync and speed, using **live numbers from this device** ("tu última búsqueda: 13 ms aquí · ~1 ms en Mac").
  - A sidebar pill "Escritorio", and on each gated feature a lock with "Disponible en la app de escritorio".
  - Off macOS, the CTA becomes "Mac por ahora · avísame".
- **Build/deploy.** `pnpm build:web` (`VITE_TARGET=web`) → static `apps/web/dist-web/`.
  - The service worker precaches the shell, the worker and `sqlite3.wasm` (streaming compile).
  - CSP: `script-src 'self' 'wasm-unsafe-eval'`; `connect-src` allows Google APIs and the configured AI hosts.
  - Serve wasm as `application/wasm`; hashed assets are immutable. No COOP/COEP needed.
  - Any static host (Cloudflare/GitHub Pages), with PR preview deploys.

## 6. Transactions & migrations

- **Atomic per command.** SQL uses `db.tx` (sync, savepoints); IDB uses one `readwrite` transaction over the stores it touches. Slicing stays in `Backend` (`runSliced`, 8 ms). Web slices are larger because an OPFS commit costs 3–7 ms.
- **One migration registry** (`packages/store/migrations.ts`): `{ id, name, sql?, idb?(upgrade), data?(store), notApplicable? }`.
  - SQL runs under `user_version`. IDB runs schema steps in `onupgradeneeded` and data steps as resumable jobs tracked in `meta`.
  - A test fails if a migration lacks an implementation, or an explicit `notApplicable`, for any registered adapter.
  - Plans 02 and 05 both claim "v3"; the registry numbers migrations in landing order.
- **Body split** (`message_bodies(id, body_text, body_html)`): the FTS view joins it and the FTS triggers move to it; `body_tail_norm` and `body_state` stay on `messages`.
  - Co-owned with plan 03, since it touches FTS.
  - It took 25 s on OPFS at 50k, so it runs as a one-time job with progress.

## 7. Conformance suite (`packages/store/conformance`)

`defineStoreConformance(name, makeStore)` uses only `MailStore` + `debug.snapshot()`. It runs in CI on Node for `sqlite-node`, `sqlite-wasm-memory` and `indexeddb` (fake-indexeddb). Nightly, the same suite runs bundled in Playwright for `sqlite-wasm-opfs` and real IDB on Chromium, WebKit and Firefox. Ported from `packages/db`:

1. **Threading** (6 cases).
2. **Derived state property test:** random ingest/act/delete; thread rows must equal `deriveThreadAggregate` over the snapshot. Also covers id never reused and empty thread deleted.
3. **Action semantics:** captured ids, latest-only star/unread, `moveToInbox` vs sent mail.
4. **Ops state machine** (12 cases), including crash recovery (close mid-op, reopen) and the pending-op guard in `updateFlags`.
5. **Search oracle:** 40+ queries, every page, account/category scope, same-message semantics. Strategy assertions apply only to FTS5.
6. **Rule parity:** 120+ generated rules; `filters.preview` ≡ `evaluateRule` over the snapshot; apply-once.
7. **Keyset pagination** with shared timestamps, for every view, account and category.
8. **Counts** equal brute force.
9. **Migrations:** upgrade from per-adapter fixtures; refuse newer schemas.
10. **Serializability:** concurrent `act`/`ingest`/`updateFlags` equal some serial order.
11. **`debug.verify()`** (FTS integrity-check, or postings vs snapshot).

EXPLAIN-plan, checkpoint-worker and strategy tests stay SQL-only. The whole `packages/db` suite also runs again as project `db-wasm`.

## 8. Perf plan & budgets

- **Desktop no-regression.** Existing gates stay. A new `store.perf.test.ts` re-runs the navigation and search gate through `SqlMailStore` at the same budgets (list ~0.3 ms typical, search ≤ 25 ms).
- **Web: Playwright project `web-perf`** (Chromium, production `build:web`, 1 worker).
  - A build-flagged `dev.seed` RPC seeds inside the worker. In-worker timings are batched ×10 because worker timers are coarse (0.1 ms).
  - The page side measures keystroke→render and j-key.
  - On OPFS, the cache-miss ratio (`sqlite3_db_status`) must stay < 5% while searching.

| Web budget, p95 (×`PERF_BUDGET_MULTIPLIER`) | OPFS 10k | OPFS 50k | IDB 10k | IDB 50k | measured (50k) |
|---|---|---|---|---|---|
| cold first visit → shell interactive | ≤ 1.5 s | — | — | — | not measured; shell ≈143 KB gz |
| repeat visit (SW) → first mail painted | ≤ 600 ms | ≤ 700 ms | ≤ 600 ms | ≤ 900 ms (loads index) | worker 44 + open 14 ms |
| list first / deep page | ≤ 2 ms | ≤ 2 ms | ≤ 2 ms | ≤ 2 ms | 0.8 / 0.7 |
| category, counts, open thread | ≤ 4 ms | ≤ 6 ms | ≤ 4 ms | ≤ 4 ms | ≤ 3.5 |
| search (common, prefix, operators) | ≤ 10 ms | ≤ 25 ms | ≤ 10 ms | ≤ 25 ms | 10–14 / 4–5 |
| user action commit | ≤ 16 ms | ≤ 16 ms | ≤ 16 ms | ≤ 16 ms | ~7 / 0.3 |
| filter preview | ≤ 50 ms | ≤ 50 ms | ≤ 150 ms | ≤ 600 ms | 15 / 433 |
| ingest throughput | ≥ 1k msg/s | ≥ 1k msg/s | ≥ 1k msg/s | ≥ 1k msg/s | 1.35k / tbd |
| RPC round trip (100 rows, structured clone) | ≤ 3 ms | ≤ 3 ms | ≤ 3 ms | ≤ 3 ms | tbd |
| keystroke→results; j-key | ≤ 100; ≤ 16 ms | same | same | same | desktop: 19; 1 ms |

## 9. Risks

1. **OPFS page-cache cliff** (32 MB → 556 ms at 50k). Mitigations: body split, adaptive cache capped at 192 MB, a miss-ratio assertion, and a "use desktop" warning above ~100k messages.
2. **IDB double implementation.** Every SQL feature (plan 02 is pure SQLite) needs an IDB port or a capability gate. IDB is a lagging tier, protected by conformance.
3. **One tab at a time** (sync access handles exist only in dedicated workers). Web Locks leadership plus takeover; on worker crash, reopen and re-attach the RPC.
4. **Eviction** (Safari 7-day ITP, storage pressure). Mail can re-sync, but local-only state (filters, categories, learned actions, unsent ops) is at risk. Mitigations: `persist()`, prompt op flushing, export/import, a banner if persistence is denied.
5. **Gmail web auth:** no refresh token, gesture-gated popup, restricted-scope verification.
6. **WebKit and Firefox are untested.** GA waits on their conformance and perf projects.
7. **Async misuse** (network await inside an IDB transaction). The interface is command-only and the `idbTx` helper catches it in tests.
8. **Migration number collisions** (02/05). Resolved by the single registry.
9. **XSS** means the whole mailbox. CSP, Trusted Types, sandboxed iframe.
10. **OPFS import is 3.5× slower** than native. Initial Gmail sync is network-bound anyway; use bigger web slices.

## 10. Ordered checklist (main green at every step)

1. **Platform seam.** Replace `node:crypto`/`setImmediate`/`Buffer` in db, backend and gmail with `Platform` and core helpers. Add the browser-bundle guard test.
2. **Connection seam.** `SqliteDriver`/`SqliteConnection`; node driver = today's behavior; per-driver pragmas; checkpoint worker gated. Zero behavior change.
3. **WASM driver** (`@sqlite.org/sqlite-wasm`, `get([])` row decoding). The full `packages/db` suite runs as project `db-wasm` in Node.
4. **`packages/store`** interfaces + `SqlMailStore`. Move composite transactions out of `Backend`/`handlers.ts`, and move the raw SQL in `imap.ts`/`gmail.ts`/`backend.ts`/hosts into `SqlProviderStore`/commands. Delete `backend.db` and `ProviderContext.db`. Add the store perf gate (no regression).
5. **Conformance suite** for `sqlite-node` + `sqlite-wasm-memory`.
6. **SearchEngine seam**, with `Fts5SearchEngine` = `search.ts`. Plan 03's engine lands behind it.
7. **Migration registry + body split**, numbered with 02/05. Desktop perf gate re-run.
8. **Web worker host**:
   - `registry-web`, WebCrypto cipher, Web Locks
   - `connection.ts` web branch, `build:web`, service worker
   - Playwright project `web` (demo data on OPFS): triage, search, compose-to-outbox smoke
9. **`web-perf` suite** (OPFS 10k/50k) with the §8 budgets.
10. **Gmail web OAuth** (GIS token model) and `bootstrap.platform` capability gating.
11. **Desktop nudge** (onboarding, banner, settings, pill, locks) with light/dark visual snapshots.
12. **`IdbMailStore` + postings engine.** Conformance on fake-indexeddb, then in Chromium; `pickStore` fallback and `?store=idb`.
13. **IDB perf suite.** WebKit/Firefox projects. Document "writing a store adapter" in the package README.
14. **Static deploy** (headers, CSP, preview deploys).

**Deletions:** `Backend.db`, `ProviderContext.db`, raw SQL in `apps/desktop/src/backend-entry.ts` and `apps/backend-dev/src/server.ts` (they use `store.settings.set`), and `db.raw` use outside `packages/db`. **Kept:** `apps/backend-dev`, the Node e2e host, which can also run `sqlite-wasm-memory` to cross-check desktop/web parity.
