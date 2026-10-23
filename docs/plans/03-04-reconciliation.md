# Plans 03 + 04 reconciliation (Codex review, 2026-10-23)

Binding for implementation: where this conflicts with plans 03 or 04, this document wins.

Use [03’s engine-owned filtering and paging](/Users/Luis/projects/emailclient/docs/plans/03-search-engine.md:123), wrapped by [04’s async `MailStore`](/Users/Luis/projects/emailclient/docs/plans/04-storage-and-web.md:100). Delete 04’s `SearchHost` design: returning message hits to storage for deduplication, filtering and sorting recreates the bottleneck 03 measured.

The architecture is sound once freshness becomes an explicit contract. Neither plan currently specifies enough to guarantee it.

1. Reconcile the seam as follows.

Keep 03’s `SearchMessageDoc`, `SearchThreadDoc`, `IndexChange` and `ResolvedSearch` projections; add `bodyState` to the message projection. Use this single interface set:

```ts
type Revision = { epoch: string; seq: number };

type SearchCursor = {
  revision: Revision;
  queryKey: string;
  lastDate: number;
  id: number;
};

interface SearchRequest {
  search: ResolvedSearch;
  cursor?: SearchCursor;
  limit: number;
}

interface SearchIdsPage {
  threadIds: number[];
  nextCursor: SearchCursor | null;
  revision: Revision;
  strategy: string;
}

interface SearchEngine {
  readonly id: string;
  // Exact over locally stored text, including all supported operators.
  query(req: SearchRequest, at: Revision): Promise<SearchIdsPage>;
}

interface IndexBatch {
  from: Revision;
  to: Revision;
  // Absolute post-commit projections or deletion tombstones.
  changes: readonly IndexChange[];
}

interface CachedSearchEngine extends SearchEngine {
  status(): {
    revision: Revision | null;
    state: "building" | "ready" | "stale" | "disabled";
    allocatedBytes: number;
  };
  apply(batch: IndexBatch): Promise<void>;
  snapshot(): Promise<Uint8Array>;
  restore(bytes: Uint8Array): Promise<boolean>;
}

interface SearchFeed {
  head(): Promise<Revision>;
  changes(
    after: Revision, through: Revision, maxCommits: number
  ): Promise<readonly IndexBatch[]>;
  beginBuild(): Promise<{
    from: Revision; // Retains subsequent log entries until release.
    messages(): AsyncIterable<readonly SearchMessageDoc[]>;
    threads(): AsyncIterable<readonly SearchThreadDoc[]>;
    release(): Promise<void>;
  }>;
}

interface MailStoreSearch {
  search(req: SearchRequest): Promise<{
    items: ThreadSummary[];
    nextCursor: SearchCursor | null;
    revision: Revision;
    strategy: string;
    complete: boolean;
    pendingBodies: number;
  }>;
}
```

`MailStore.threads` implements `MailStoreSearch`. Backend/RPC callers never access engines directly.

**Ownership:** the engine evaluates message predicates, deduplicates threads, applies every thread predicate, orders by `(lastDate DESC, id DESC)`, and selects `limit + 1`. The store resolves account/category names through shared pure logic and hydrates summaries in the returned order. FTS5 retains its fused SQL implementation.

**Read consistency:** store search captures revision R and prevents writes from interleaving between scope resolution, engine query and hydration. Maintain one writer on both platforms. Use RAM only when its revision equals R; otherwise use the durable fallback. A cursor with a different revision or query key requires restart/reconciliation, matching the existing live-list policy rather than promising snapshot pagination indefinitely.

**Write consistency:** use a transactional outbox on both adapters, never direct engine calls inside write transactions.

- SQLite triggers collect dirty message/thread IDs. A store-command finalizer coalesces them, materializes absolute projections and appends one revisioned batch **inside that transaction**. Cover bodies, membership changes, cascades and both sides of thread merges—not just `messages` and `threads`.
- IndexedDB commands explicitly append the identical batch and advance `meta.searchRevision` in their existing readwrite transaction. Publish only after transaction completion. IDB transactions can become inactive between event-loop tasks, so network and unrelated asynchronous work stay outside them. [IndexedDB specification](https://www.w3.org/TR/IndexedDB/)
- Apply batches after commit. Advance the engine watermark only after the entire batch succeeds. Ignore duplicates, reject gaps/epoch mismatches, and discard an engine left partially mutated by failure. Write acknowledgements need not await indexing; subsequent searches fall back until caught up.

This requires all domain writes—including sync, rules, categorization, compose and MCP actions—to use store commands.

**Startup and snapshots:** persist `{database epoch, schema/tokenizer/index versions, revision, checksum}` with the arrays. Publish snapshots atomically through a replaceable file or transactional IDB manifest. A restored snapshot becomes usable only after replay reaches the store head.

For rebuilding, retain the log at W0, scan in bounded chunks, capture W1 after scanning, then replay all absolute batches `(W0, W1]`. This repairs rows changed during the scan. Catch up and promote under the writer guard. Log gaps force another rebuild. Prune only behind a durable snapshot and active build leases; cap retention and invalidate older snapshots when necessary.

SQLite answers immediately through FTS5 during restore/build. A fresh FTS5 answer can have `complete=true`; index warming alone is not incomplete mail. `pendingBodies` describes corpus coverage separately.

IDB has no FTS5. Its correctness fallback must be an exact, sliced store scan, or fully conformant persistent postings—not the prototype’s limited free-text engine. Slow searches may remain pending; silently incomplete pages are unacceptable.

**Memory policy:** initially cap steady index allocation at 192 MiB desktop / 96 MiB web, with explicit peak budgets of 256/128 MiB. Include buffers, dictionary, deltas, caches and serialization copies. On pressure, disable RAM and use exact fallback. Avoid a partial hot tier in v1: globally correct ordering and pagination require a proper merge with cold results.

2. Resolve these problems before implementation.

- **Freshness claims are too strong.** “Same thread” does not imply immediate read-your-writes when draining yields. Conversely, 04’s in-command indexing can survive a rolled-back database write in RAM. The revision contract above resolves both.

- **Search semantics need one executable specification.** Preserve same-message conjunctions, exact full-email matching, field-local phrases and last-token prefixes. Preserve today’s special negation rule: `from:ana -factura` tests one message; purely negative text excludes whole threads. Neither token intersection across messages nor phrases spanning fields is valid. Keep an independent brute-force oracle; moving it beside production code must not make it reuse the implementation’s matcher.

- **Rules and MCP are mischaracterized in 03.** Rules need message IDs and their own DSL semantics; they cannot consume paged thread results. Keep `filters.preview/applyChunk` store-owned, using SQL compilation or the JS evaluator. MCP already calls `threads.search`; retain that shared route and authorization rather than introducing an FTS-only MCP route. Plan 02’s query-based bulk operations need bounded enumeration with defined mutation behavior, especially when adding a category changes their own exclusion predicate.

- **The body split is a correctness migration.** Moving FTS triggers solely onto `message_bodies` misses subject/sender/recipient edits and messages without bodies. Deletes must retain the exact old indexed projection, including during cascades. Update rule SQL still referencing `m.body_text`, reader queries, ingestion and fixtures together. Run external-content integrity checks with `rank=1`. [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html)

- **500k-message costs exceed the headline numbers.** 03 estimates roughly 450 MB before realistic vocabulary growth. Restore, compaction, structured cloning and old/new buffers increase peaks. Its 51k-message build already takes approximately 3.6 seconds; startup cannot depend on rebuilding. Sorted vocabulary insertion, recency-array movement and tombstone accumulation also need sustained-update benchmarks. Budget rebuild CPU and memory together.

- **OPFS remains vulnerable beyond 50k.** Body splitting moves the cache cliff; it does not eliminate it. A 192 MB cache ceiling cannot guarantee a larger working set fits. Measure cold fallback search, rules, imports and concurrent interaction—not merely warm cache-hit ratios. Larger batches must still preserve the interactive latency gate.

- **Several performance promises are unproven.** Phrase fallback’s ≤5 ms is projected; the IDB prototype lacks essential semantics and transactional work. A batched timer measures throughput, not individual-request p95. Preserve one-character searches: raising the minimum prefix to make the fallback gate pass changes product behavior.

- **Cross-plan transactions need adjustment.** Plan 02’s RAM model updates must also happen after commit. Its category-table rebuild must preserve/recreate search triggers. Ingestion/classification must remain one atomic store command, with pure classification dependencies—not SQL callbacks exposed to Backend. Its “another category means negative” training signal conflicts with additive categories; its safety valve also needs a minimum number of matured outcomes.

- **Web is more than a browser-safe bundle.** Plan 05’s DNS pinning and Electron network interception need a browser-specific policy implementation and honest guarantees. Serialize tab takeover, close storage handles before releasing leadership, and coordinate worker/service-worker/schema versions. Never silently switch an existing OPFS mailbox to an empty IDB database following an open error.

For v1, defer Postgres scaffolding, compression/positional sidecars, partial hot tiers and the full native-IDB implementation until OPFS is proven. Keep IDB’s contract specified now. The repeated desktop nudges and hypothetical Mac comparison are also unnecessary launch scope.

3. Land the work in this order.

Preserve the active sequence **05 → 02 → 01**, then **04 foundations → 03 desktop → 04 web**. Agree on the shared contract now, so 02 uses store-command-shaped operations and 01’s picker/DnD share the same categorization action.

| Migration | Assignment |
|---|---|
| v1–v2 | Existing schema and operation-target index |
| v3 | 05 identity, secrets and local mode; already present |
| v4 | 02 categorization |
| v5 | 04 body split |
| v6 | 03 search revision/outbox |
| None | 01 appearance settings |

Keep logical migration IDs stable across adapters; IDB schema upgrades and resumable data jobs are adapter implementations of those IDs. Give v5’s FTS/rule changes one owner. Do not renumber landed migrations.

Split 03/04 into independently green commits:

1. **Shared contracts and conformance:** extract the oracle, wrap existing FTS search, preserve behavior and strategies.
2. **04 node foundations:** connection interface, explicit statement disposal, node driver and platform injection; retain current pragmas/checkpoint behavior.
3. **04 store extraction:** move composite transactions and provider SQL behind `SqlMailStore`; include 02/05 operations. Add store-level perf coverage before removing `Backend.db`.
4. **v5 body split:** complete readers, writers, rules and FTS migration together.
5. **v6 outbox:** capture every mutation, with RAM disabled. Test aborts, cascades, merges, replay gaps and crash recovery; measure write amplification.
6. **03 engine:** pure implementation and differential tests, then mutation support; keep production on FTS.
7. **03 activation:** revision-gated routing, snapshots, sliced rebuild, memory caps and phrase fallback. Enable only after measured gates pass.
8. **04 WASM:** full DB/store suites against WASM-memory, then OPFS worker demo, lifecycle tests and browser perf.
9. **04 web release:** Gmail auth, capabilities, browser network policy, offline/version handling and cross-browser validation.
10. **IDB later:** full semantics and recovery first; automatic fallback only after conformance and real-browser perf pass.

At each relevant commit retain the existing SQL, import-contention, renderer and packaged-app gates. Add instant-search gates without replacing fallback gates or changing `PERF_BUDGET_MULTIPLIER`. Test cold startup and missing/corrupt snapshots explicitly. Prototype timings support the direction; they are not implementation acceptance evidence.

## Implementation notes: steps 1–5 (2026-10-23)

Landed as the commits for steps 1–5 above, with migration numbers shifted by one (v1–v5 were already taken, v4 by 02 and v5 by 02's move journal): **v6 is the body split, v7 the outbox.**

- **Contracts** live in `@unica/store` (`search.ts`, `mail-store.ts`, `types.ts`, `platform.ts`); `resolveSearch` is pure in `@unica/core`. `ResolvedSearch` gained `key` (the query as typed plus its UI scope): relative dates move with time, so a key derived from the parsed query would never match its own next page.
- **Cursors** carry `revision` and `queryKey` and are valid only at their revision and in their database: any other epoch, revision or query is refused (`StaleCursorError`, RPC `STALE`), because a commit between pages can move a thread above the cursor. The renderer then refetches from the top the window it had loaded plus a page, keeping the selection (capped at 500 rows per request). Keyset-only cursors from older renderers continue at the current revision.
- `MailStore.threads` implements `MailStoreSearch.search(req)` for pre-resolved requests and adds `searchText(...)`, which resolves `account:`/`category:` inside the same unit of work as the engine query and hydration. FTS5 keeps its fused statement (`Fts5SearchEngine.page`); `query()` returns ids for other callers.
- `complete` is true for every FTS5 answer; `pendingBodies` is a count capped at 1,000. The RPC's `complete` keeps its old meaning (`complete && pendingBodies === 0`).
- Classification stays inside the ingestion command with the in-memory model passed as a pure input (`ClassifierInput`); settings are read by the backend and passed in (`mode`). The AI assist re-checks its settings in the backend and its data conditions inside `recordAiSuggestion`.
- **The outbox is an id log.** Each top-level transaction (a `Db` before-commit hook, so every write on the connection is captured, not only store commands) appends the message and thread ids it touched under the next revision; `SearchFeed.changes()` materializes their projections when it serves a batch. Projections are therefore the newest committed state of each id, never older than the batch, and a later change to an id always comes with a later batch, so replaying converges (the reference replica in the conformance suite checks it). Commits don't copy mail text into the log. Marking: message and body changes by their FTS triggers, message inserts by `ingestMessages` and thread aggregates by `recomputeThreads` (one statement per slice each), deletes (cascades included) and category membership by triggers. The log is pruned past 32 MiB (UTF-8 bytes) in bounded steps per commit, never the newest batch nor past an active build lease; leases are cleared on open.
- Any future rebuild of `messages`, `message_bodies`, `threads` or `thread_categories` must recreate both the FTS and the `search_dirty_*` triggers; new messages and thread aggregates must keep going through `ingestMessages` and `recomputeThreads`.
- A ⌥-move journals both categories' examples as its training replaces them (in each training slice), not inside the membership commit.
- Measured at 51k messages: the v5→v6 migration takes ~1 s (no FTS rebuild); a real v5 profile (21k messages) upgrades to v7 in ~0.2 s with rows, memberships, ops, settings and FTS answers unchanged. The outbox writes a few bytes per touched id. Ingestion is within ~1–3% of the pre-storage-work throughput (gated at 3%); a 5,000-thread ⌥-move stalls 31–32 ms (gate 50 ms; 41–45 ms before this work).

## Implementation notes: steps 6–7 (2026-10-23)

- **Engine** (`@unica/store/instant`, pure TS: no Node or DOM APIs besides `performance.now` and `setTimeout`): `InstantSearchEngine` implements `CachedSearchEngine` with a CSR base of postings (doc slots plus a subject/from/to/body mask) and a per-term delta, one dictionary with sorted prefix ranges, a packed varint forward index (phrases inside one field, rebuilds without tokenizing), bitsets over message slots and typed-array thread state (views, account, category bitsets, unread, starred) in a recency order repositioned in place (only when `lastDate` changes). Same-message conjunctions, exact full-email senders, field-local phrases, last-token prefixes and the special negation rule follow the oracle. Plans: a newest-first walk that stops after limit + 1, or a dedup of few candidates into a top-k buffer; one- or two-letter prefixes are checked per doc from the forward index instead of materializing their sets (cold `p` 3.2 → 0.1 ms); `before:` builds its candidates from the doc arrays; a walk that passes 3,000 matching-filter threads without filling the page switches to dedup. Strategies are `instant:walk|docs|empty`, `+phrases` when the doclist settled a phrase.
- **Phrase fallback:** 512 failed verifications, then the exact doclist (`ftsTermMessages`, FTS5 `MATCH` on the term), called inside the store's synchronous unit so it answers at the engine's revision. Without a doclist (the web on IndexedDB), `"hola equipo"` costs 18–27 ms at 51k.
- **Changes:** a changed message gets a new slot, the old one is a tombstone. Batches apply in order (duplicates ignored, gaps and other epochs refused); the revision advances only after the whole batch, and a failure part-way disables the engine. Compaction (tombstones + delta ≥ 2,000 and > 15 % of live docs) builds a new engine from the forward index in slices while the old one keeps answering, then swaps.
- **Routing:** `SqlMailStore` answers from RAM only when `InstantSearch.at(R)` returns the engine for the revision R it captured, in one synchronous unit with the hydration (one `json_each` statement); FTS5 otherwise, with identical results. `Backend` enables it by default (`instantSearch`); rules, filters, categorization bulk scopes and `searchThreadIds` stay on SQL; MCP shares `threads.search`.
- **Indexer** (`InstantSearch`): a Db after-commit hook notifies it; it catches up once writes have been quiet for 25 ms or have lagged 5 s, so imports run at full speed (CPU ×0.97 with the index current) and FTS5 answers meanwhile. Builds take a feed lease and scan 500-row pages in 4 ms slices. The SQL feed reads a large commit's projections 500 ids at a time with yields (each doc is the newest committed state when read, which replay already relies on); a 5,000-thread ⌥-move stalls as without the index (~30 ms). Gap, epoch or a revision ahead of the head ⇒ rebuild; three failures in a row ⇒ disabled (logged).
- **Snapshots** (`<db>.search`): magic, header JSON with `{tokenizer, format, identity: sqlite-schema-N, revision, meta, sections}`, 8-byte aligned typed arrays and a checksum over everything after it. Written after a build, after 5,000 changes or 5 minutes after the first unsaved one, and on close; atomically through `Platform.files.replace` (temp file + rename). Not fsynced: a crash that loses the bytes behind the rename fails the checksum and costs a rebuild. Restore adopts the buffer it reads (typed views, no second copy) and replays the feed to the head before the engine is used; missing, truncated, bit-flipped, foreign-epoch, older-schema and pruned-past snapshots rebuild (tested). A snapshot that can't be written is retried after 5 minutes; the index stays.
- **Memory:** caps 192 MiB steady / 256 MiB peak (`DESKTOP_SEARCH_MEMORY`), by the engine's own accounting (typed arrays at capacity plus estimates for maps, strings and deltas), which matched the measured heap + array buffers within ~3 % at 51k. Over the steady cap the index is disabled until restart; compaction and snapshots are skipped when twice the index would exceed the peak.
- **Measured at 51k** (load average 5–13 throughout, other processes on the machine): build ~1.25 s wall in slices, max event-loop stall 7–12 ms over the build and first snapshot; 39.7 MiB (808 B/message), 34 MiB snapshot, restore ~35 ms, compaction ~0.4 s; every keystroke of `p…presupuesto` ≤ 0.17 ms p95 cold and ≤ 0.11 ms warm; the §3.1 queries ≤ 0.6 ms; phrases ≤ 2.1 ms (`"hola equipo"` through the doclist); the store's search path ≤ 0.6 ms; apply 0.05 ms per new message p95. Backend `threads.search` while typing ≤ 0.83 ms p95 end to end (20k threads; `factura` 8.3 → 0.6 ms). In the renderer (3,000-thread demo mailbox, where FTS5 already answered in ~1 ms p50 / 3 ms p95) keystroke → results rendered went from 10.6 to 8.6 ms p50, ~20 ms p95 either way: rendering dominates there.
- **Gates:** `instant.perf.test.ts` and `backend.perf` (type-ahead RPC). The build-stall gate takes the best of up to three fresh builds (each attempt and the load are reported): a stall from our code repeats every time, preemption by other processes doesn't. The restore stall (15–16 ms, GC-bound) is reported, not gated. The classification A/B imports run without the index and wait for the shared index to rest, because they measure process CPU.
