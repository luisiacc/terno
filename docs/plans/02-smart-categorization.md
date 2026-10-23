# Plan 02: Smart categorization, quick actions, "everything about X and Y"

Status: implemented (migration **v4**, per the 03/04 reconciliation; see "Implementation notes" at the end) · Builds on PLAN.md §4–§6, §11

## 1. Goals

1. For every new thread, and on demand, predict each category with a **confidence** and an **explanation**. Then choose **auto-apply / suggest / nothing**, precision first.
2. After any categorization, show a **snackbar** with bulk actions: everything from this sender, domain or list; everything about the selected terms; always do this (create a filter); undo.
3. Support **"everything talking about X and Y"** as a previewable, undoable, time-sliced bulk add.
4. **Local mode (hard requirement).** Quality bars are met with **local signals only, no AI, no network**. AI is optional, goes only through the pluggable `AiProvider`, and is either off or a loopback model (Ollama/LM Studio).
5. Keep the existing budgets: 8 ms slices and list/search/RPC p95s.

Non-goals (v1): embeddings, model sync, provider-side folders.

## 2. Current state and gaps

- `suggestSimilarForCategory` tries sender, then List-Id, then domain. The reader's `SuggestionCard` offers to add the matches.
  - **Bug:** for `list`/`domain` reasons, "accept" searches the raw value as free text, so it adds the wrong set. It is also capped at 500.
- `removeThreadsFromCategory` **forgets removals**, so there are no negatives to learn from.
- The `added_by` CHECK constraint lacks `'auto'`, so adding it requires a table rebuild.
- There is no drag-and-drop to categories yet. The snackbar hooks into `toggleCategory`, so every entry point gets it.
- In the mock data, sender, tag and category map one-to-one, so sender lookup alone looks perfect. The mock needs adversarial cases (§9).

## 3. Algorithm

### 3.1 Features

Features are taken from the thread's **root inbound message**: the earliest message with `is_sent=0` that is not from one of the user's own addresses. They come from a pure, versioned function in `core/categorize/features.ts`.

- **Identity:** `from:<email>`, `list:<id>`, `dom:<domain>`. The domain feature is skipped for consumer domains **and for the user's own account domains** (e.g. coworkers at `acme.studio`).
- **Content:** `normalizeText` tokens aligned with FTS `unicode61 remove_diacritics 2`, minus an es/en stoplist. Numbers are bucketed (`#n`, `#n4`). Subject tokens are prefixed `s:`. Body tokens are prefixed `b:` and taken from the first 2 KB with quotes stripped. Binary presence, at most 120 per thread.
- **Intent detectors** (regex, es/en): `amount`, `invoice` (factura/CFDI/recibo/receipt), `tracking`, `unsubscribe`, `calendar`, `otp`, `travel`, `replied` (thread has a sent message), `pdf`, `bulk` (List-Id or no-reply), `consumer`.

### 3.2 Model: one-vs-rest Naive Bayes with grouped, clipped evidence

Categories are additive, so each category gets an independent binary model. Plain multinomial Naive Bayes was measured and rejected: it was overconfident. Clientes reached only **0.35 precision even at p ≥ 0.98**, because work and client threads share vocabulary.

```
llr(f) = ln((a+0.1)/(P+0.2)) − ln((b+0.1)/(N+0.2))     a/b = weighted pos/neg examples with f; P/N = totals
prior  = ln((P+1)/(N+1))
I      = clip(llr(k*), ±6)    k* = most specific identity key with support ≥ 3 (sender > list > domain), else 0
C      = clip(Σ clip(llr_tok, ±3) / √k, ±4)       content tokens with support ≥ 2
Nint   = clip(Σ clip(llr_intent, ±3), ±3)
p      = σ(prior + I + C + Nint)
```

- Identity dominates when it has evidence.
- Content generalizes to new senders.
- `√k` and the group caps are what fix the overconfidence.
- Training is incremental count updates. Classification is a few `Map` lookups per feature.

### 3.3 Training signals

| Signal | Label | Weight |
|---|---|---|
| `added_by` `user` (picker, drag-and-drop) or `suggestion` (accepted) | + | 1.0 |
| Bulk/snackbar adds | + | 0.5, and content is capped at 50 examples per (sender, category) so one bulk add can't turn the model into "Uber words" |
| `agent` | + | 0.5 |
| `filter`, `auto` | not trained (prevents feedback loops) | – |
| User removes a thread (any origin) | − | 3.0 |
| Thread is in another category | − | 1.0 |
| Seen but uncategorized: inbound, ≥ 3 days old, not spam/trash | − (positive-unlabeled) | **α = 0.1** |

**Decay:** weight × 0.5^(age/365 d), floor 0.25, applied on snapshot rebuild.

**Measured α:** α = 0.3 at 30% label coverage drops auto recall to 0.32. α = 0.03 lets 11 inbox phishing mails auto-apply on content alone. **α = 0.1** gives auto precision 1.000 and recall 0.93, even at 30% coverage.

### 3.4 Decision policy

**Scope.** The engine evaluates a thread only if all of these hold:
- it is new, or it has no categories and no recorded user decision
- its root message is inbound and in the Inbox (not spam, trash or draft)
- it is dated within the last 14 days

Backfill from initial sync never auto-applies. It yields aggregated suggestions instead.

**AUTO** requires **all** of the following:
1. Global setting `autoCategorize="auto"` (the default) and per-category `auto_apply=1`.
2. The category has ≥ 5 positive examples. With 5–10 examples the prototype made no false positives and auto recall was 0.14–0.17, which is conservative by design.
3. p ≥ **0.97**.
4. One evidence path:
   - **Identity:** I ≥ 2 with support ≥ 3.
   - **Content-only** (unknown sender): C + Nint ≥ 4, the category has ≥ 30 positives from ≥ 5 senders, and no look-alike.
5. I > −1, so the sender is not counter-evidence.
6. **Vetoes:**
   - **Hard veto:** the user once removed this thread from the category.
   - **Sender veto:** in the last 90 days, the user removed ≥ 2 threads from this sender and removals ≥ positives.
   - **Look-alike veto:** the display name matches a trained sender but the domain differs.
7. **Safety valve:** take Beta(1+kept, 1+reverted) over the category's auto decisions, where a revert is a removal within 30 days. If its 5th percentile falls below 0.90, auto pauses for that category and the UI says so.

**SUGGEST:** p ≥ **0.80**, no veto, ≥ 3 positives, at most 2 suggestions per thread.

**NOTHING:** otherwise.

Multi-label is allowed: a client invoice can be auto-added to Clientes and Facturas. A thread is reclassified once when its body arrives (`bodyCompleted`).

### 3.5 Explanations

The top features by contribution are rendered as text, for example: "mismo remitente que 12 en Facturas · menciona «factura», «cfdi» · incluye un importe". Counter-evidence is shown too: "pero Uber también envía promociones que no guardas aquí".

### 3.6 Optional AI

AI is used only when it is enabled and the thread falls in the band 0.5 ≤ p < 0.97.
- **How it runs:** async, outside ingestion slices, at most 20 calls per minute, cached per thread.
- **Interface:** a new optional `AiProvider.classifyThread()` method.
- **What it may do:** promote a thread from nothing to suggest, or enrich the explanation. **It never auto-applies.**
- **Local mode:** the provider must be `none` or a loopback OpenAI-compatible endpoint. That provider kind is a Local-mode prerequisite.
- **Text-to-query** for "about…" (§7) uses the same gate.

## 4. Data model (migration v3)

```sql
-- rebuild to allow 'auto'/'bulk' + batch ids (CHECK can't be altered)
CREATE TABLE thread_categories_new (thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL DEFAULT 'user' CHECK (added_by IN ('user','filter','agent','suggestion','auto','bulk')),
  added_at INTEGER NOT NULL DEFAULT 0, batch_id INTEGER, PRIMARY KEY (thread_id, category_id)) WITHOUT ROWID;
INSERT INTO thread_categories_new SELECT thread_id, category_id, added_by, added_at, NULL FROM thread_categories;
DROP TABLE thread_categories; ALTER TABLE thread_categories_new RENAME TO thread_categories;
CREATE INDEX thread_categories_c ON thread_categories(category_id, thread_id);
CREATE INDEX thread_categories_batch ON thread_categories(batch_id) WHERE batch_id IS NOT NULL;
ALTER TABLE categories ADD COLUMN auto_apply INTEGER NOT NULL DEFAULT 1;

-- labeled examples = training source of truth (removals kept as label -1)
CREATE TABLE cls_examples (thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  label INTEGER NOT NULL, weight REAL NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL,
  features BLOB NOT NULL,  -- features_v + uint32 FNV-1a hashes (~320 B)
  PRIMARY KEY (thread_id, category_id)) WITHOUT ROWID;
CREATE INDEX cls_examples_cat ON cls_examples(category_id, label);

-- engine decisions: suggestions, auto outcomes (safety valve, "Ver/Deshacer")
CREATE TABLE cls_decisions (thread_id INTEGER NOT NULL, category_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','suggest')), p REAL NOT NULL, explain_json TEXT NOT NULL, at INTEGER NOT NULL,
  outcome TEXT CHECK (outcome IN ('kept','reverted','accepted','rejected')), PRIMARY KEY (thread_id, category_id)) WITHOUT ROWID;
CREATE INDEX cls_decisions_pending ON cls_decisions(category_id, at) WHERE kind = 'suggest' AND outcome IS NULL;

CREATE TABLE cat_batches (id INTEGER PRIMARY KEY, category_id INTEGER NOT NULL, scope_json TEXT NOT NULL,
  added INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, undone_at INTEGER);
CREATE TABLE cls_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), features_v INTEGER NOT NULL, built_at INTEGER NOT NULL, blob BLOB NOT NULL);
```

- **Hashed features.** Explanations re-tokenize the thread itself, so no vocabulary table is needed.
- **Weak-negative background counts** live **in memory**. They are incremented at ingest without SQL writes, and persisted in `cls_snapshot` at idle and on shutdown.
- **Rebuild:** the model is rebuilt at idle, in slices, from `cls_examples` plus recent inbound roots whenever the snapshot is stale or the feature version changes.
- **Memory:** ≤ 30 MB at 20 categories and 100k features.

## 5. RPC contract (`core/rpc/contract.ts` style)

```ts
const scope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sender"), email: z.string().email() }),
  z.object({ kind: z.literal("domain"), domain: z.string().max(253) }),
  z.object({ kind: z.literal("list"), listId: z.string().max(400) }),
  z.object({ kind: z.literal("query"), query: z.string().min(1).max(500) }), // search language
]);
"categories.addThreads":   + source: z.enum(["picker","dnd","snackbar","suggestion"]).default("picker")
"categorize.quickActions": m<QuickActions>()({ categoryId, threadIds })  // sender, domain|null, list|null, terms[≤6], filterDraft
"categorize.count":        m<{ count: number; capped: boolean }>()({ categoryId, scope })
"categorize.preview":      m<{ count: number; sample: ThreadSummary[] }>()({ categoryId, scope, limit ≤ 50 })
"categorize.apply":        m<{ batchId: number; added: number }>()({ categoryId, scope }, { timeoutMs: 120_000 })
"categorize.undo":         m<{ removed: number }>()({ batchId })
"categorize.predict":      m<Prediction[]>()({ threadId })   // {categoryId, p, decision, reasons[]}
"categorize.suggestions":  m<{ items: (ThreadSummary & { prediction: Prediction })[] }>()({ categoryId?, limit })
"categorize.feedback":     m<{ ok: true }>()({ threadId, categoryId, verdict: "accept" | "reject" })
"categorize.stats":        m<CategoryModelStats[]>()({})     // positives, autoEnabled, autoPrecision, paused
settings.update += autoCategorize: "off"|"suggest"|"auto" ; categories.update += autoApply
event "categorized": { categoryId, threadIds, by: "auto" }  // coalesced per category ≤ 30 s
```

**Scope rules.** Every scope excludes threads already in the category, trash/spam, and threads the user removed from it.

**Sender scope** matches only `is_sent=0` messages and never the user's own addresses. In the 50k perf database, the top `from_email` values are the user's own accounts.

**MCP access:** `predict` and `suggestions` are read-only. `apply` is allowed for agents (weight 0.5).

## 6. Backend integration

- **`backend/categorizer.ts`** holds the in-memory model and exposes `classify`, `train`, `untrain`, `snapshot` and `rebuildSliced`. The math lives in pure `core/categorize/{features,model,policy}.ts`.
- **`ingestSliced`:** inside the slice transaction, after `applyFiltersTo`:
  - **Classified:** new inbound threads that filters did not categorize.
  - **Output:** auto (`addThreadsToCategory(...,'auto')` plus a `cls_decisions` row) or a suggestion row.
  - **Cost:** CPU plus at most 2 small writes. The adaptive slice sizer absorbs it.
  - Background counters are updated in memory.
- **`categories.addThreads` and `removeThreads`** write `cls_examples` and update the model in the same transaction. Removing an `auto` row marks the decision `reverted`. More than 200 ids go through `runSliced`.
- **`categorize.apply`** resolves the scope (sender/list/domain via their indexes, query via the compiled search predicates returning thread ids only, uncapped). It then inserts with `batch_id` through `runSliced` and emits `changed`. Undo is `DELETE … WHERE batch_id = ?`.
- **Distinguishing terms:** the thread's tokens ranked by llr for the category, keeping only tokens with 2 ≤ df ≤ 20% of messages (from an in-memory df estimate). The sender's brand tokens are dropped because the sender chip already covers them. The top 6 are shown and the top 2 preselected.
- **Cold start / demo:** `seedDataset` calls `rebuildModel` after seeding categories, so the mock dataset starts warm.
- **Idle work:** persist the snapshot, rebuild with decay, and mark auto decisions older than 30 days without a revert as `kept`.

## 7. UI spec

**Snackbar** (`category-snackbar.tsx`, sonner `toast.custom`, bottom-left):
- **Trigger:** any `toggleCategory(on)`, so the picker, drag-and-drop and accepted suggestions all get it.
- **Lifetime:** 10 s, paused on hover or focus and while editing chips. The next categorization replaces it.

```
● Añadido a Facturas                                              [Deshacer z]
[1 Todo de Uber Receipts · 23] [2 Todo de @uber.com · 31] [3 Lista … · 9]
[4 Sobre: (factura ✓)(uber ✓)(cfdi)(viaje) · 17  Ver]   [5 Siempre → filtro]
```

- **Counts:** the frame renders instantly from `quickActions` (≤ 2 ms). Counts then stream in lazily, one `categorize.count` per chip, with skeletons while loading. Large counts show as "1 000+". Chips with zero matches are hidden. Multi-thread selections show only shared chips.
- **"Sobre…":** chips toggle with a 150 ms debounced recount of `"factura" "uber" -category:Facturas`. **Ver** opens that query in the search view as the preview.
  - **Más…** opens a field, "Añadir todo lo que hable de…", that accepts the search language (`factura uber from:@uber.com`).
  - With AI enabled (local or remote), natural language is turned into a query first. The user always sees the query and the count before applying.
- **Apply:** shows a progress toast that ends with "23 añadidas · Deshacer" (`categorize.undo`).
- **Siempre:** saves a filter from `filterDraft` scoped to the strongest active chip, then shows "Filtro creado · Editar".
- **Keys:** `1`–`5` trigger the actions, `z` undoes, `Esc` closes. This needs a new `snackbar` keybinding context.

**Auto notice:** one toast per category per 30 s: "Única añadió 3 conversaciones a Facturas · Ver · Deshacer".

**Reader:**
- The header gets a "¿Facturas?" chip that replaces `SuggestionCard`. `y` accepts it. `n` rejects it, which is recorded as a negative with weight 1.
- The tooltip shows the explanation.
- Auto-added badges show an "auto" mark with the explanation and a "No es Facturas" action.

**Sidebar:** a "Revisar (N)" entry per category for pending suggestions.

**Settings → Categorías:**
- a global switch: Off / Solo sugerir / Automático
- a per-category auto toggle
- per-category stats: examples, auto precision, paused

## 8. Local mode

The engine (features, model, counts, terms) and its evaluation are pure SQLite plus in-process JS with no `fetch`. AI is disabled by default. When enabled it runs only through `AiProvider`, which may be a loopback local model. The §9 bars are **asserted with `aiProvider: "none"`**, and a network guard fails the test on any outbound connection.

## 9. Evaluation: offline accuracy test (AI disabled)

**Generator:** `generateDataset({ adversarial: true })` adds `tags: ThreadTag[]` (multi-label gold) and the following families. With the flag off, existing seeds stay byte-identical.

| Family | What it simulates | Gold |
|---|---|---|
| amazon-invoice | Amazon CFDI invoices next to Amazon shipping mail | Facturas |
| uber-promo | Uber promos mentioning "viaje" | none |
| phish-bank | look-alike bank domains, in spam **and** in the inbox | none |
| friend-trip | friends discussing flights | not Viajes |
| client-invoice | a client sends an invoice | Clientes + Facturas |
| new-receipt | Netflix/CFE receipts that appear only in the test period | Facturas |
| fintech-newsletter | a newsletter full of "factura $" | Lecturas only |
| label-noise | 5% wrong user labels | – |

**Protocol** (`backend/categorize.eval.test.ts`, unit project, ~3k threads, < 10 s):
1. Replay the oldest 80% as user categorizations through `categories.addThreads`, at 0.7 coverage.
2. Ingest the newest 20% through `ingestSliced`.
3. Score the engine's decisions against gold.
4. Write `test-results/categorize/*.json`.

Scenarios: standard, cold-adversarial, 30% coverage, 5% noise, few-shot (≤ 4 examples per category).

**Asserted bars:**
- **Auto precision:** ≥ 0.97 overall, and ≥ 0.95 per category with ≥ 10 decisions.
- **Auto recall:** ≥ 0.80 (standard) and ≥ 0.75 (cold-adversarial).
- **Suggest band:** precision ≥ 0.80. Auto plus suggest recall ≥ 0.95.
- **Never:**
  - no auto-applies on phish-bank, uber-promo or friend-trip
  - no auto-applies in the few-shot scenario
  - no re-adding a thread the user removed

Core unit tests cover the gates, vetoes, safety valve, decay, look-alike detection and determinism.

**Prototype results** (same model, 3k threads, 5 categories, α = 0.1, auto at p ≥ 0.97, AI off):

| Scenario | Auto P | Auto R | Suggest (p ≥ 0.8) P / R |
|---|---|---|---|
| Mock, standard | 1.000 | 0.947 | 0.994 / 0.972 |
| Adversarial | 1.000 | 0.948 | 0.989 / 0.986 |
| Cold-adversarial | 1.000 | 0.848 | 1.000 / 0.988 |
| Coverage 0.3 | 1.000 | 0.931 | 0.994 / 0.970 |
| Noise 5% | 1.000 | 0.959 | 0.857 / 0.981 |
| ≤ 10 examples per category | 1.000 | 0.17 | gated by design |

In the cold-adversarial run, amazon-invoice got **0 auto-applies but 100% suggestions**: Amazon's sender identity counts against Facturas. This is the intended auto-versus-suggest split. new-receipt reached 1.00 auto recall through the content-only path.

## 10. Performance budgets (perf project)

| What | Budget | Measured in the prototype |
|---|---|---|
| `classify` per thread, 20 categories, 2 KB body | p95 ≤ 50 µs | 16 µs average (600 B bodies). 26–34 µs including featurization at 5 categories. |
| Ingestion throughput regression (14k import) | ≤ 10% | baseline ingest ≈ 190 µs per message |
| Interactive RPC p95 during import | unchanged (≤ 45 ms) | – |
| Count: sender, list, domain (50k messages) | p95 ≤ 5 ms | 0.2–1.0 ms. Worst case 3.4 ms (an own domain, which is excluded anyway). |
| Count: query (FTS) | p95 ≤ 25 ms, capped at 1 000 | rare terms / AND 0.2–0.6 ms. "factura" 16 ms and "semana" 21 ms uncapped; 6.5 ms capped. |
| `quickActions` | p95 ≤ 2 ms | – |
| train/untrain one thread | ≤ 200 µs | – |
| Model load after first paint | ≤ 30 ms, ≤ 30 MB | – |
| Snapshot rebuild, 20k threads | ≤ 2 s, in 8 ms slices | – |

Query-plan tests assert that counts use `messages_from`, `messages_list`, `messages_domain` and `thread_categories_c`.

## 11. Risks

| Risk | Mitigation |
|---|---|
| Silent wrong auto-adds | Strict gates, a visible notice with undo, the "auto" badge, and a per-category safety valve |
| Feedback loops | `auto` and `filter` rows never train the model |
| A bulk add dominates | 0.5 weight plus a per-sender content cap |
| Positive-unlabeled bias | α = 0.1 with an exposure gate, tuned only through the eval |
| Ingest write amplification | In-memory background counts, snapshot at idle |
| Table rebuild time on large DBs | A single-transaction migration, timed at 20k threads |
| Phishing | Spam is never classified, a look-alike veto, strict content-only gates |
| Intent regexes cover only es/en | They are one of three evidence groups. Identity and content are language-agnostic. |
| AI breaking Local mode | Provider gate, network-guarded test, AI never auto-applies |

## 12. Implementation checklist (one commit each, tests green)

1. `core/categorize/features.ts` + tests (FTS tokenizer parity, intents, own/consumer domains).
2. `core/categorize/model.ts` (grouped NB, hashing, serialization) + `policy.ts` (gates, vetoes, valve, decay) + tests.
3. Mock generator: `tags[]` + `adversarial` families.
4. Migration v3 + migration test on a seeded database.
5. Backend `Categorizer`: training hooks (removals recorded), snapshot/rebuild, seed warm-up.
6. Offline eval test (§9), with AI off and the network guard. Tune only here.
7. Ingestion integration (auto/suggest, `bodyCompleted`, 14-day window, `categorized` event) + §10 perf tests.
8. RPCs `quickActions`/`count`/`preview`/`apply`/`undo` (sliced, batches) + query-plan tests. Retire the buggy `SuggestionCard` accept path.
9. Snackbar + keyboard context + undo + "Siempre → filtro" + Playwright flow and visual tests.
10. "Sobre…" chips, free-text field, search-view preview + e2e.
11. Reader suggestion chip, auto badge, "Revisar (N)", Settings → Categorías + e2e.
12. Optional AI (`classifyThread`, text-to-query) for Fake/Anthropic/local providers, gated per §3.6.

## Implementation notes

Where the implementation departs from the proposal above, and why:

- **No cross-category negatives.** Categories are additive, so negatives are user removals (3.0), rejected suggestions (1.0) and background mail (α = 0.1). Without them the llr of an identity depends on the category's size, so the model estimates the user's **filing rate** (max of the category's and the global rate, floor 0.2) and applies a positive-unlabeled correction to class totals and per-feature background counts. The identity gate uses this calibrated share (95% Wilson upper bound ≥ 0.9; a point share ≤ 0.3 is counter-evidence) instead of `I ≥ 2` / `I > −1`.
- **A domain vouches for a new sender** only once ≥ 3 of its senders are in the category (client companies yes; uber.com receipts don't make promotions invoices).
- **Suggestions against a counter-identity** need near-maximal content (C + Nint ≥ 5): Amazon's invoices are suggested, mislabeled examples don't spawn suggestions.
- **Safety valve** pauses only with ≥ 10 matured outcomes and at least one revert (without reverts the Beta quantile only measures sample size).
- **Backfill** (mail older than the 14-day window) is not classified inside import slices: its background counts and suggestions come from one sliced pass after the import settles (throughput).
- **The `classify` budget** (≤ 50 µs p95, 20 categories) is the model's scoring; featurizing a 2 KB body adds ~60 µs and is bounded at 150 µs end to end. The import budget (≤ 10%) is measured on the load test's 14k-message import; an all-new-inbox import is reported (~+20%).
- **Snackbar** renders in its own fixed layer (it grows as counts arrive; a toast stack measures height once). The reader's "add similar" card is retired; its accept searched list/domain values as free text and stopped at 500.
- **AI assist** uses `AiTasks.classify` through `Backend.ai()`; text-to-query for "Sobre…" is not implemented (the field takes the search language).
