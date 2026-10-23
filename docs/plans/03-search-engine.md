# Plan 03: Search engine — instant, pluggable, provably correct

Status: proposal · Builds on PLAN.md §5, §11.6 · Sibling: `04-storage-and-web.md` (storage abstraction) · Prototypes: `/tmp/unica-search-lab/src/*` (outside the repo; `instant/engine.ts` is the engine)

## 1. Verdict

- **The index lookup was never the bottleneck.** FTS5 finds hits in under 1 ms for every query except a 1-char prefix. The 8–38 ms goes into turning hits into threads: a B-tree seek per hit into the 117 MB `messages` table, `DISTINCT`, a `threads` join, and a temp B-tree sort. SQL has to materialize **every** hit before it can order threads by recency.
- **No FTS5 setting fixes that.** We tried prefix `1 2 3`, `detail=column/none`, contentless, trigram, `optimize`, and covering indexes. The best SQL shape is still 7–18 ms for common prefixes.
- **A custom in-memory index fixes it**: postings in typed arrays, bitsets over message ids, and an early-terminating **recency walk over threads**. Every keystroke takes **0.02–0.35 ms p95** warm, and **≤ 0.81 ms** on the first, cold keystroke. Chromium runs within about 2× of Node. Results are **identical** to today's oracle-verified `searchThreads` on all pages for 32 queries, and on the first page for 12 adversarial queries.
- **Architecture:** each runtime gets an `InstantIndex` engine in the process that owns the data. FTS5 stays as the durable, always-correct fallback and serves rules, filters, MCP, and phrase escape hatches. Everything sits behind one `SearchEngine` interface and one shared conformance suite.

## 2. Method

Dataset: `generateDataset({ threads: 29_500, accounts: 8, seed: 2026, bodyScale: 4 })` gives 51,461 messages, 29,500 threads, 762 B average body, and a 59 MB FTS index. M-series Mac; Node 24.21 with `node:sqlite` 3.53.4; Chromium 1248 headless through the repo's Playwright 1.64. We report p50/p95 after warmup, over 20–100 iterations. "Top-k" means the 101 newest threads by `(last_date DESC, id DESC)` in view `all`, which is exactly what one page needs.

## 3. Results

### 3.1 Query latency, p95 ms

| Query | Current `searchThreads` | Best FTS5 SQL¹ | **Instant (Node)** | **Instant (Chromium worker)** | SQLite-WASM + OPFS (Chromium) | IDB postings² (Chromium) | FlexSearch³ | MiniSearch³ |
|---|---|---|---|---|---|---|---|---|
| `p` (1 char) | 38.5 | 18.0 | **0.02** (cold 0.81) | **0.06** (cold 0.79) | 51.0 | 10.2 | 5.7 | 182 |
| `pr` | 21.0 | 15.2 | **0.02** (cold 0.23) | **0.02** (cold 0.21) | 23.4 | 3.9 | 4.9 | 65 |
| `pro` / `pre` | 13.1 | 9.9 | **0.02** (cold 0.10) | **0.02** | 14.5 | 2.2 | 6.6 | 35 |
| `factura` (common) | 9.8 | 6.8 | **0.02** | **0.02** | 10.6 | 1.4 | 2.2 | 32 |
| `hola` (very common) | 8.6 | 7.9 | **0.02** | **0.02** | 12.0 | — | 2.0 | 26 |
| `reunión` (accented) | 11.3 | 8.4 | **0.02** | **0.02** | — | — | 2.6 | 21 |
| `tokio` (rare) | 0.52 | 0.33 | **0.04** | **0.06** | 0.66 | 0.10 | 0.03 | 0.21 |
| `propuesta presupuesto` | 1.46 | 1.20 | **0.10** | **0.13** | — | — | 2.8 | 17 |
| `propuesta pre` | 1.31 | 0.99 | **0.12** | **0.08** | 1.58 | 0.74 | 6.4 | 16 |
| `"darse de baja"` | 3.92 | 3.05 | **0.35** | **0.30** | 5.1⁴ | n/a | n/a | n/a |
| `zzqxjv` (zero) | 0.07 | 0.02 | **0.03** | **0.03** | 0.07⁴ | — | 0.003 | 0.01 |
| typing `p…presupuesto`, worst key | 37.4 (`p`) | 18.5 (`p`) | **0.81** (cold `p`) | **0.79** | 51.0 | 10.2 | 12.5 | 158 |
| typing, ≥ 4 chars | 8.5–11.0 | 6.5–8.4 | **≤ 0.08** | **≤ 0.07** | 10.1–11.4 | 1.2–1.9 | 1.3–3.9 | 14–29 |

¹ v_p123 with covering indexes `messages(id, thread_id)` and `threads(id, in_trash, in_spam, last_date)`, plus a 2-phase hydrate.
² Postings stored per term in IndexedDB and read on every keystroke (`getAll` over a key range).
³ Node, a single concatenated field with pre-normalized text, AND plus last-token prefix. Neither library has phrase support or our per-field same-message semantics. Orama (p95 933 ms for `p`, 95 ms for `factura`) and lunr (759 ms and 42 ms; immutable index) are not viable.
⁴ SQLite-WASM, in-memory, under Node.

**FTS5 settings**, 1-char prefix, p95 ms: `2 3` (current) 38; `1 2 3` 22 (index 59→158 MB); no prefix index 54; `detail=column` 22; `detail=none` 24 (no phrase or column search); contentless 20; trigram ≥ 3 chars only, substring semantics, 1.3–2× slower. `optimize`: no measurable effect. Common words move by ±10% across all settings. A bare `count(*) … MATCH` takes 0.3–0.9 ms, so the cost sits downstream of the doclist.

**Adversarial cases** (instant, p95; repo in parentheses): `a` 0.03 (48); `"de la"` 0.48 (17); `to:luis factura -hola` 0.24 (7); date/attachment + text ≤ 1.4 (5–8); thread filters passing 0.1% of threads ≤ 0.2. **Exception:** phrases of frequent words that never occur adjacent. `"hola equipo"` takes **22 ms** and `"baja darse"` 9.5 ms, because 10k candidates fail verification. The FTS5 phrase doclist answers them in **1.2** and **0.2 ms** (§4.3).

### 3.2 Build, memory, persistence, updates

| | Build | Memory / size | Startup | Incremental |
|---|---|---|---|---|
| FTS5 (current) | triggers during ingest; bulk rebuild 2.0 s | 59 MB on disk | 0 (persistent) | per-row trigger |
| **InstantIndex (Node)** | 2.1 s from rows (1.2 s of it is `tokenize`) + 1.5 s SQLite read | **46 MB** heap (postings 19, forward index 11; 11k terms) | snapshot of 31–33 MB: **10–21 ms** to restore | add **0.085 / 0.175 ms** per msg (p50/p95); remove ≈ 0 (tombstone) |
| InstantIndex, vocabulary stress (+25 random tokens per msg, 259k terms) | 3.3 s | 110 MB | — | queries still ≤ 1.2 ms cold |
| InstantIndex (Chromium) | — | same | OPFS read + decode **18.5 ms**; IDB read + decode 36 ms; fetch 33 ms | same engine |
| SQLite-WASM + OPFS | 2.2 s in-memory | 114 MB file | `importDb` 136–159 ms, open 10–12 ms, **first query 61 ms** | — |
| FlexSearch / MiniSearch / Orama / lunr | 3.8 / 3.2 / 7.9 / 5.0 s | 28 / 105 / 407 / 827 MB | — | lunr: none |

**Bundle size (min + gzip):** instant engine plus parser **5.9 KB**; MiniSearch 5.7; lunr 8.7; FlexSearch 17; Orama 24.7; SQLite-WASM 65.6 KB of JS plus **398 KB** of wasm.

**Roaring:** native `roaring` would not build, and PLAN §2.1 rules out native modules. A dense 6.4 KB bitset AND takes **0.003 ms**, against 0.020–0.040 ms for `roaring-wasm`. Building one from postings: 0.04 ms against 0.28. roaring-wasm also needs manual `dispose()`. Reconsider it only for compressed posting *storage* above roughly 1M messages.

### 3.3 The floor (everything that isn't the index), p95 ms

| Step | p95 |
|---|---|
| Hydrate 100 thread summaries (`getSummaries`) | 0.35 |
| `JSON.stringify` / `parse` of a 44.7 KB page | 0.10 / 0.09 |
| `structuredClone` of the page | 0.13 |
| MessagePort echo of the page | 0.42 |
| `parseSearch` | 0.002 |

**Desktop keystroke in the backend ≈ 0.02 (engine) + 0.35 (hydrate) + 0.4 (transport) < 1 ms.** The floor is now hydration plus RPC. The rest of the UI's 18.5 ms keystroke→render is React work.

## 4. Algorithm (InstantIndex)

### 4.1 Data structures (per runtime, in the process that owns storage)

- **Docs = messages**, with dense internal ids. Typed arrays hold `docThread`, `docDate`, `docAtt`, and `docFromEmail` (interned). An `alive` bitset marks tombstones.
- **Dictionary:** a `Map<term, termId>`, plus a **sorted term array** for prefix ranges. A prefix is a binary search followed by a contiguous scan. New terms are binary-inserted.
- **Postings:** an immutable CSR base segment (`Uint32Array` doc ids, `Uint8Array` field mask with subject/from/to/body bits, offsets). A small mutable **delta segment** takes new docs. Column operators filter on the mask, so one dictionary serves all fields.
- **Forward index:** varint term ids per field, 1.5 B per token. It verifies phrases and multi-token values (`from:lucia.gar`), and is used to rebuild.
- **Threads:** `lastDate`, view flags, account, unread, starred, and category membership as typed arrays. A **recency order array** is repositioned with `copyWithin` on a bump (0.002 ms), plus thread→docs adjacency.
- **Prefix-set LRU** (64 entries) of bitsets for the token being typed. It is **patched, not invalidated**, when docs are added. This is the "refine the previous keystroke" cache. Measured cold-session typing: `p` 0.81, `pr` 0.23, `pre` 0.12, then ≤ 0.08 ms. No further refinement layer is needed.

### 4.2 Query plan (same semantics as `db/search.ts`)

1. Resolve `SearchQuery` (from `core/search`) into **message predicates** and **thread predicates**. `account:` and `category:` resolution moves to core so that every engine resolves them identically.
2. Each positive term becomes a bitset: an exact posting, or the cached prefix set for the last token. Mask by field. AND them together. Multi-token terms become verifiers.
3. Negatives use AND-NOT at message level whenever any message predicate exists. A purely negative query excludes whole threads, exactly like the oracle.
4. Sender, date, and attachment predicates become **lazy per-doc verifiers**.
5. **Planner:** `est = popcount(set)`, which costs about 1 µs.
   - **Dense** (≥ 2,000 docs, or negative-only): **walk threads newest-first**. A thread matches when any of its docs is in the set *and* passes the verifiers. Stop at `limit + 1`. Keyset cursors binary-search into the order array.
   - **Sparse:** iterate set bits, dedupe by thread with generation stamps, and keep a 101-element sorted buffer.

   Both paths are exact. Neither ever applies a LIMIT before thread dedup.
6. Return thread ids, the cursor, the strategy, and `complete`. Storage hydrates the 100 rows.

### 4.3 Phrase escape hatch

Give verification a **budget**: 512 docs verified with fewer than `limit` threads found. When the budget runs out, ask the fallback engine for the exact phrase doclist (FTS5: 0.2–2 ms) and intersect. Common phrases finish inside the budget because the walk terminates early. Rare or non-occurring phrases have small doclists. On the web without FTS5, add a **next-token positional sidecar** later (§9) and accept the phrase-specific budget in §8 until then.

## 5. Desktop architecture

```
backend utility process
  Storage (node:sqlite, sole writer) ──tx──▶ messages/threads + search_outbox(seq, kind, id)   [triggers, same tx]
        │                                          │ drain after commit (≤500 rows/slice)
        ▼                                          ▼
  Fts5SearchEngine (durable, fallback)       InstantSearchEngine (RAM, primary)
        └──────────── TieredSearchEngine (planner: instant if ready && fresh, else FTS5) ────▶ threads.search
```

- **Keep FTS5** for persistence, crash safety, `findRuleMatches`, MCP, phrase doclists, and answers while the instant index builds.
- **Consistency:** triggers on `messages` and `threads` append to `search_outbox` in the **same transaction** as the write. The engine drains the outbox after each commit, so a query never runs ahead of storage. Search runs on the same thread as writes, so read-your-writes is immediate. The snapshot records the outbox `seq` watermark. Startup is: restore snapshot (≤ 25 ms) → replay outbox since watermark → ready. With no snapshot, or a version mismatch, the tiered engine serves FTS5 while a background rebuild runs in ≤ 8 ms slices or a `worker_thread` (about 3.6 s total).
- **Snapshot:** a portable binary file next to the DB, `unica-search.v1.bin` (header JSON + aligned typed arrays). Write it on idle and quit, at most every 5 minutes or 5k changes. Write to a temp file then rename. A corrupt snapshot is discarded, never trusted.
- **Compaction:** once tombstones plus the delta segment exceed 10% of docs, fold them into a new base on idle (≈ 2 s per 51k, chunked).

## 6. Web architecture

- **Engine:** the same `InstantSearchEngine`, in 04's storage worker (≤ 0.8 ms cold, ≤ 0.13 ms warm in Chromium).
- **If 04 picks SQLite-WASM + OPFS:** keep FTS5 in SQLite as the fallback and phrase doclist (10–51 ms, so fallback only). Store the snapshot as an OPFS file (read + decode 18.5 ms).
- **If 04 picks IndexedDB:** InstantIndex is the only engine. Persist the snapshot as one IDB value (36 ms), and use the IDB-postings engine (1.2–10 ms) only as a degraded mode while the snapshot loads. Phrase verification uses the forward index, whose worst case is 22 ms until the positional sidecar lands.
- Main-thread cost is one `postMessage` round trip. Searches that run before the snapshot loads use the fallback and return `complete=false`.

## 7. Interface (`packages/core/src/search/engine.ts`)

Pure TypeScript with no Node or DOM types, so it lives next to the storage ports from 04. Storage implements `SearchSource`; engines implement `SearchEngine`.

```ts
import type { SearchQuery } from "./parse";
import type { View } from "../types";

export interface SearchCursor { lastDate: number; id: number }

/** What storage feeds the engine (field text exactly as FTS sees it). */
export interface SearchMessageDoc {
  messageId: number; threadId: number; accountId: number; date: number;
  subject: string; fromText: string; fromEmail: string; recipients: string; body: string;
  hasAttachments: boolean;
}
export interface SearchThreadDoc {
  threadId: number; accountId: number; lastDate: number;
  inInbox: boolean; hasSent: boolean; inTrash: boolean; inSpam: boolean;
  isStarred: boolean; unreadCount: number; categoryIds: readonly number[];
}
export type IndexChange =
  | { kind: "upsertMessage"; doc: SearchMessageDoc }
  | { kind: "removeMessage"; messageId: number }
  | { kind: "upsertThread"; doc: SearchThreadDoc }
  | { kind: "removeThread"; threadId: number };
export interface IndexBatch { changes: readonly IndexChange[]; watermark: number }

/** account:/category: tokens already resolved to ids by core (shared by every engine). */
export interface ResolvedSearch {
  query: SearchQuery;
  view: View;
  accountIds: readonly number[] | null;      // null = any
  excludeAccountIds: readonly number[];
  categoryIds: readonly number[];            // thread must be in all
  excludeCategoryIds: readonly number[];
  impossible: boolean;
}
export interface SearchRequest { search: ResolvedSearch; cursor?: SearchCursor; limit: number }
export interface SearchResult {
  threadIds: number[];                       // newest first, (last_date DESC, id DESC)
  nextCursor: SearchCursor | null;
  strategy: string;                          // "instant:walk" | "instant:docs" | "fts" | …
  complete: boolean;                         // false: engine stale/building, or bodies pending
}
export interface EngineStatus {
  state: "empty" | "building" | "ready" | "stale";
  watermark: number; docs: number; memoryBytes: number;
}
export interface SearchEngine {
  readonly name: string;
  readonly capabilities: { phrase: "exact" | "verify" | "none"; incremental: boolean; persistent: boolean };
  status(): EngineStatus;
  apply(batch: IndexBatch): void;                          // idempotent per watermark
  query(req: SearchRequest): SearchResult | Promise<SearchResult>;
  /** exact phrase doclist for escape hatches (FTS5 implements it) */
  phraseMessages?(field: "text" | "from" | "to" | "subject", phrase: string): Iterable<number> | Promise<Iterable<number>>;
  snapshot?(): Uint8Array;
  restore?(bytes: Uint8Array): boolean;                    // false = incompatible, rebuild
}
/** Provided by the storage layer (04): bulk scan for rebuilds + change feed. */
export interface SearchSource {
  scanMessages(afterMessageId: number, limit: number): SearchMessageDoc[] | Promise<SearchMessageDoc[]>;
  scanThreads(afterThreadId: number, limit: number): SearchThreadDoc[] | Promise<SearchThreadDoc[]>;
  changesSince(watermark: number, limit: number): IndexBatch | Promise<IndexBatch>;
  bodiesComplete(): boolean | Promise<boolean>;
}
```

`TieredSearchEngine(primary, fallback)` is itself a `SearchEngine`. The backend handler becomes `engine.query(...)` → `storage.getSummaries(ids)`. The RPC contract (`SearchPage.strategy/complete`) stays as it is.

## 8. Correctness and perf gates

**Conformance suite.** Move the brute-force oracle out of `packages/db/src/search.test.ts` into `packages/core/src/search/oracle.ts`. It is a pure function over `SearchMessageDoc[]` and `SearchThreadDoc[]`. Then add `runSearchConformance(name, makeEngine)`, which runs:

1. All 42 existing cases, every page at `limit = 37`, plus UI account and category scope, the same-message test, and fixture sanity checks.
2. **500 generated queries** from the fixture vocabulary: 1–4-char prefixes, word pairs, phrases cut from real bodies, phrases with the last token as a prefix, negations, `from:`, `to:`, and `subject:` with multi-token values, plus every operator.
3. **Mutation sequences:** add, replace body, delete, thread bump, move to trash, category changes. After each batch, compare against the oracle.
4. **Snapshot round-trip:** restore, then get an identical answer on every query.
5. **Differential at 51k:** instant against FTS5 on every page of the perf query list.

Each engine runs the suite: `Fts5SearchEngine` and `InstantSearchEngine` in Vitest; the instant engine in Chromium (Vitest browser or Playwright); the IDB engine if 04 picks IDB. Tokenizer parity is part of the suite, with Latin accents, Greek tonos, Cyrillic й, and the ﬁ ligature, because `tokenize` must keep mirroring unicode61 `remove_diacritics 2`.

**Perf budgets** go into `perf.perf.test.ts` at 51k messages, with `PERF_BUDGET_MULTIPLIER` unchanged:

| Gate | Budget (p95) | Measured |
|---|---|---|
| Instant engine, every keystroke `p…presupuesto`, cold cache | ≤ 2 ms | 0.81 |
| Instant engine, all §3.1 queries warm | ≤ 1 ms | ≤ 0.35 |
| Phrase, including adversarial `"hola equipo"` (with escape hatch) | ≤ 5 ms | 1.2 projected |
| Backend keystroke (parse + engine + hydrate 100) | ≤ 2 ms | ≈ 0.4 |
| Backend RPC round trip for search | ≤ 3 ms | ≈ 0.8 |
| **User-level target: keystroke → results in the backend** | **≤ 5 ms** | < 1 |
| FTS5 fallback (existing gate) | ≤ 25 ms | ≤ 21 (the `p` case is 38 today; keep it as walk-only or make the min prefix 2 chars for the fallback) |
| Incremental add | ≤ 0.5 ms/msg | 0.175 |
| Snapshot restore (desktop / web OPFS) | ≤ 50 / ≤ 100 ms | 21 / 18.5 |
| Web engine query in a Chromium worker | ≤ 2 ms | ≤ 0.79 |
| **Memory:** instant index at 51k | ≤ 64 MB, alert at 1.5 KB/msg | 46 MB |

Web keystroke → render stays at ≤ 100 ms (§11.8). Aim for ≤ 50 ms once the renderer work is done.

## 9. Risks

1. **Memory at scale.** About 0.9 KB/msg today gives roughly 450 MB at 500k messages. Mitigations, in order: (a) delta-varint postings in 128-doc blocks, about 4× smaller; (b) on desktop, drop the forward index and use the FTS5 phrase escape hatch plus rebuild from SQLite; (c) intern rare terms into a front-coded dictionary in place of `Map<string>` keys; (d) a hot tier (recent N months) with `complete=false`, and an async FTS5 top-up for older threads. Roaring storage becomes worth it at that point.
2. **Real vocabularies are larger** than the mock's 11k terms. The stress test with 259k terms took 110 MB, and queries stayed under 1.2 ms. Add a realistic-noise fixture to the perf gate.
3. **Drift from storage.** Prevented by the outbox in the same transaction plus the watermark. Detected by a periodic idle check: sampled term counts, instant against FTS5.
4. **Smaller risks:**
   - **Tokenizer parity:** one shared `tokenize`, with scripts covered by the suite.
   - **Recency tie-breaks** must match SQL (`id DESC`); the keyset test covers it.
   - **GC:** pack the forward index into one buffer, not 51k small arrays.
   - **Web quota eviction:** the snapshot is only a cache and can always be rebuilt.

## 10. Implementation checklist (ordered)

1. Extract `oracle.ts` and `runSearchConformance` into `core/search`. Make the current `searchThreads` pass it as `Fts5SearchEngine`, with no behavior change.
2. Move `account:` and `category:` resolution (`compileSearch` scope logic) into core as `resolveSearch()`. Define the `SearchEngine` and `SearchSource` types and align them with 04.
3. Add the `search_outbox` migration and triggers, and implement `SearchSource` on `node:sqlite`.
4. Port `InstantIndex` from the lab (`/tmp/unica-search-lab/src/instant/engine.ts`) into `packages/search-instant`: pure TS, no Node APIs. Use a packed forward index and full thread predicates (views, account, category, unread, starred).
5. Make it pass conformance, including mutations and snapshot round-trip. Add the generated-query fuzzer.
6. Add `TieredSearchEngine`, then wire the backend handler and the outbox drain after commit. `complete` = engine ready && `bodiesComplete`.
7. Add snapshot write and restore with temp-file rename, the watermark replay, and background rebuild in slices or a worker.
8. Add the phrase escape hatch (budgeted verification → `phraseMessages`).
9. Add the perf gates from §8 and a realistic-vocabulary fixture. Record the results in `test-results/perf/search.json`.
10. Web: run conformance in Chromium. Persist the snapshot to OPFS or IDB per 04, and gate the worker query p95.
11. Later, only if gates or memory require it: block-compressed postings, the positional sidecar for web phrases, the hot tier for mailboxes over 250k messages.
