# Plan 17: the People filter and "waiting for your reply"

- **Status:** in progress.
- **Builds on:** `da55479` (main after plans 18, 19 and 20).
- **Request (verbatim, from the task):** "plan 17, the People filter and 'waiting for your reply'. Plan 15 deferred these here … The 'People' quick-filter chip. Lumen's chips are All / Unread / Attachments / Starred. Add People: threads whose latest inbound message is from a real person, not newsletters, notifications or no-reply senders. … Make People available everywhere the quick filters are. '· M waiting for your reply' in Lumen's greeting line under 'N unread'. These are threads where the last message is from a person to you and you haven't replied. Define this precisely in the plan: what counts as a person, how sent mail from any of your accounts or aliases counts as a reply, and what happens with archived, trash, spam and muted threads. Consider making it clickable to filter. Store work. This needs a thread-level fact … in both stores … a schema migration with a durable, restartable, cancellable backfill, coordinated with message hydration … and concurrent ingest, with version compatibility. … Person detection. Use local, deterministic heuristics … No network, and nothing leaves the machine. Performance. It must hold at 50k+ threads in both stores … Prove the backfill at scale: 300k messages, with bounded event-loop stalls (the slicer's budget), resumable after a kill mid-way."
- Plan 15 §3.6/§3.7 and its revisions R10 and R11 moved this here. Each of R10/R11's risks has a numbered answer in §9.

## 1. What exists

- **Quick filters** (plan 15 §3.6): `ListFilter = "unread" | "attachments" | "starred"` in `@terno/core` (`list-filter.ts`), one predicate (`matchesFilter`) for the renderer's stickiness, the stores' pages and scopes, and searches (`searchWithFilter`: unread and starred become operators, attachments is applied by every engine to whole threads before paging, `threadAttachments`).
  - SQLite: v11/v12 covering partial indexes, by date for pages and by id for scopes (`queries.ts` `FILTER`, pinned with `INDEXED BY`).
  - IndexedDB: one in-memory `ThreadOrder` per filter and `ScopeIndex.matching` (ascending ids), kept from row changes (`mail.ts`).
  - UI: macOS and Atelier pick the criterion from the "Filtered by" menu, Lumen from chips (`thread-list.tsx` `QuickChips`); the palette has "Show …" items; per-mailbox state in `terno:list-filter` (`lib/unread-filter.ts`).
- **The greeting** (Lumen's inbox): `Greeting` + `Subtitle` show "N unread" or "You're all caught up." from `counts.inboxUnread(ByAccount)`.
- **Thread aggregates** are recomputed by `recomputeThreads` (both stores) from the thread's messages after every write (ingest, flags, actions, undo, deletes, merges, op completion). It reads neither `list_id` nor `is_draft` (R11). The list's "latest" message puts trash and spam last; the counterpart (`last_from_*`) is the newest non-sent message.
- **Headers**: only `List-Id` is captured (`messages.list_id`, IMAP fetches `references` and `list-id`; Gmail parses the raw message). Gmail labels are kept in `gmail_labels` (`CATEGORY_PROMOTIONS`, `CATEGORY_UPDATES` …).
- **Own addresses**: nothing persistent. Plan 18's contact index knows "own" and "I sent to them", but it lives in the backend's memory, is built only once a draft opens, and isn't available to the stores' recompute.
- **The categorizer** has a `bulk` intent (`features.ts` `BULK_LOCAL`: no-reply, notifications, newsletter … local parts, or a List-Id). Its features are versioned (`FEATURES_V`) and stay untouched.
- **Migrations**: SQL is at v13 (`migrations.ts`), each one a transaction at open; a database newer than the app is refused. IndexedDB is at version 3 (logical 9); its upgrade runs in `onupgradeneeded`, and rows are plain objects (a new column is simply absent on old rows). Threads are an *early* table (in memory before the store opens); messages are *late* (they load while the first screen paints, and every non-early unit waits for them).
- **Background work in the backend**: `SliceSizer` (`slicer.ts`) sizes slices from measured time; the categorizer's rebuild and moves run in slices with `platform.yield()`; `notifyChanged` coalesces events; counts are throttled to every 200 ms.
- **Perf policy**: `packages/db/src/test/timing.ts` (plan 04 §11): `measure()` re-runs over-budget batches; on a busy machine rare OS holds are excused; stall gates use `watchLoop` + `stallLessGc`; every gate is shown to fail on an injected regression.

## 2. Definitions

These are the contract. `@terno/core` exports them as pure functions (`people.ts`), and both stores call the same functions, so the conformance suite holds them to one table of cases.

### 2.1 Your addresses

- **Your addresses** are every account's address, plus the From address of every message you sent (`is_sent`) in any account: aliases, send-as addresses and old addresses you once sent from.
- Addresses are compared lowercased, trimmed, with a `+tag` in the local part dropped (`ana+news@x.com` is `ana@x.com`). Gmail's dot-insensitivity is not applied (it is Gmail-only, and a false match would hide mail).
- **A message is yours** when it is sent (`is_sent`) or its From is one of your addresses (your reply from account B landing in account A's inbox is yours). Any other message is **inbound**.

### 2.2 Who is a person (`senderKind`)

An inbound message's sender is classified from local signals only. Nothing is fetched and nothing leaves the machine.

1. **Automated (strong)**, whatever else is true:
   - the message is spam;
   - it has a `List-Id` (mailing lists and most newsletters);
   - it carried bulk headers at ingest: `List-Unsubscribe`, `Precedence: bulk | list | junk`, or `Auto-Submitted` other than `no` (new: `messages.is_bulk`, §4.1);
   - Gmail filed it under Promotions, Social or Forums (`gmail_labels`);
   - the local part is a no-reply address: once `.`, `_`, `-` are removed it contains `noreply`, `donotreply`, `noresponder` or `mailerdaemon`, or it is `postmaster`, or it starts with `bounce`;
   - the address is empty or has no `@`.
2. **Automated (weak)**, which a person you have written to overrides:
   - a **role** word is one of the local part's pieces (split on `.` `_` `-` `+`): notifications, alerts, info, news, newsletter, updates, digest, marketing, promo, offers, billing, invoices, receipts, orders, shipping, reservations, bookings, support, help, helpdesk, hello, team, contact, service, accounts, security, calendar, automated, mailer, system, admin, feedback, survey, community, store, shop, sales, welcome, and their Spanish forms (notificaciones, alertas, boletin, promociones, ofertas, facturacion, facturas, recibos, pedidos, envios, reservaciones, reservas, soporte, ayuda, hola, equipo, contacto, servicio, cuenta, seguridad, encuesta, comunidad, tienda, ventas, bienvenida). The list is a superset of the categorizer's `BULK_LOCAL` words (a unit test checks it);
   - the domain's first label is a sending subdomain: mail, email, e, em, news, newsletter, info, mailer, mailing, marketing, notifications, notify, bounce, mg, sg, mta, send;
   - a short list of known automated domains (facebookmail.com, linkedin.com, x.com, twitter.com, pinterest.com, mail.instagram.com, accounts.google.com);
   - Gmail filed it under Updates.
3. **Person**: everything else, and a weak case whose address **you have written to** (it is in the To, Cc or Bcc of a message you sent, in any account). `support@small-shop.com` that you answered is a person; `notifications@github.com` is not.

### 2.3 The thread facts

Two columns on every thread, recomputed with its other aggregates:

- **`person`** (0 or 1): among the thread's messages that aren't drafts, take the visible ones (not trash, not spam), or all of them when the whole thread is in the Trash. The newest **inbound** one (date, then id: the list's order) has a person sender. A thread with no inbound message (only your own mail) is 0. A thread entirely in spam is 0 (spam is never a person).
- **`waiting_since`** (a date or NULL): take the newest visible, non-draft message M.
  - M is inbound and its sender is a person.
  - You aren't only on its Cc: when one of your addresses is in Cc and none in To, it isn't waiting. Mail with none of your addresses at all (a forwarding address you never sent from, Bcc) counts as to you; lists are already excluded by rule 1.
  - No message of yours, in any account, answers it: none has M's Message-ID in its In-Reply-To or References. (A reply in the same thread is newer than M by definition, so M wouldn't be the newest. This rule catches a reply sent from another account that didn't copy this one.)
  - Then `waiting_since` = M's date; otherwise NULL.

### 2.4 What the user sees

- **People** (the filter): threads whose `person` = 1, in the mailbox being looked at (any view, account, category or search), like every quick filter.
- **Waiting for your reply** (the count and the filter): `waiting_since` within the last **30 days** (`WAITING_WINDOW_MS`) of *now*. Older unanswered mail isn't "waiting" anymore; without a window a neglected inbox would say "2,000 waiting". `now` is always passed in (the backend's injected clock, the renderer's `Date.now()` for stickiness), never read inside a store (R11).
- **The greeting's count** is the inbox's threads waiting (an account's inbox: that account's). Archived threads aren't counted: archiving is dealt-with. The filter itself works in any mailbox (Waiting in Archive lists archived unanswered conversations).
- **Trash and spam** never wait: their messages aren't visible. A thread with one trashed message ignores that message.
- **Muted**: Terno has no mute. When it arrives, muted threads are left out of the count and the filter (noted in §8).
- **Drafts** never count, neither as the newest message nor as a reply. Sending is what answers.

## 3. User-facing design

### 3.1 The People filter, everywhere the quick filters are

- `LIST_FILTERS` becomes `["unread", "people", "waiting", "attachments", "starred"]`. The per-mailbox state, `terno:list-filter` (stored values validated by `isListFilter`), ⌘L's meaning (unread ↔ all), stickiness ("no longer matches" keeps the open and checked rows until the selection moves), select-all scopes and "a search inherits its mailbox" are unchanged.
- **Lumen** (`chips`): All / Unread / **People** / Attachments / Starred. A **Waiting** chip appears after People only while that filter is on (it's reached from the greeting, the palette or another design's menu), so the row doesn't grow a sixth chip for a filter most people reach from the count.
- **macOS and Atelier** (`menu`): the "Filtered by" menu lists Unread, People, Waiting for reply, With attachments, Starred. As today, N is shown for Unread only.
- **Palette**: "Show conversations from people", "Show conversations waiting for your reply" (hidden when already on, like the others).
- **Empty states** per criterion: People: "No conversations from people" / "Newsletters, notifications and automated mail are left out." Waiting: "Nothing is waiting for your reply" / "Conversations where someone wrote to you in the last 30 days, and you haven't answered, show up here." Searches: "No results with this filter" / "Nothing that matches is from a person." and "… is waiting for your reply."
- **Scope labels**: "Inbox · People", "Inbox · Waiting for reply".

### 3.2 The greeting line (Lumen's inbox)

- "**N unread** · **M waiting for your reply**". The second part is a toggle button (`data-testid="waiting-count"`, `aria-pressed`, same text as its name) that turns the Waiting filter on, and off again. It uses the subtitle's type, `text-foreground` with an underline on hover and a focus ring; `unread-ink` stays for N.
- Nothing unread: "**M waiting for your reply**" alone (not "You're all caught up."). Neither: "You're all caught up." M = 0: the second part is omitted.
- While the backfill hasn't finished (§5), the store reports the count as unknown (`null`) and the part is omitted: no wrong number is ever shown.
- An account's inbox shows that account's count. Other views and designs keep their subtitles (only the greeting carries it, as plan 15 specified).
- The count refreshes with every `counts` event (each change), and the greeting's existing boundary timer and `visibilitychange` ask for fresh counts too, so a thread crossing the 30-day line is dropped at most one day-part late with no new timer (the expiry refresh policy, R11).

### 3.3 Copy (`en` / `es`)

| Key | en | es |
|---|---|---|
| `list.filter.people` | People | Personas |
| `list.filter.waiting` | Waiting for reply | Esperan respuesta |
| `list.waitingCount` | # waiting for your reply | one: # espera tu respuesta · other: # esperan tu respuesta |
| `list.filterEmpty.peopleTitle` / `Body` | No conversations from people / Newsletters, notifications and automated mail are left out. | Sin conversaciones de personas / Se omiten boletines, notificaciones y correo automático. |
| `list.filterEmpty.waitingTitle` / `Body` | Nothing is waiting for your reply / Conversations where someone wrote to you in the last 30 days, and you haven't answered, show up here. | Nada espera tu respuesta / Aquí aparecen las conversaciones en las que alguien te escribió en los últimos 30 días y aún no respondes. |
| `list.filterEmpty.peopleSearchBody` / `waitingSearchBody` | Nothing that matches is from a person. / Nothing that matches is waiting for your reply. | Nada de lo que coincide es de una persona. / Nada de lo que coincide espera tu respuesta. |
| `list.scope.people` / `waiting` | {label} · People / {label} · Waiting for reply | {label} · Personas / {label} · Esperan respuesta |
| `palette.showPeople` / `showWaiting` | Show conversations from people / Show conversations waiting for your reply | Mostrar conversaciones de personas / Mostrar conversaciones que esperan tu respuesta |

## 4. Store work

### 4.1 Schema (SQL migration v14; IndexedDB version 4, logical 14)

```sql
ALTER TABLE threads ADD COLUMN person INTEGER;          -- NULL: not computed yet (the backfill's work)
ALTER TABLE threads ADD COLUMN waiting_since INTEGER;   -- NULL: not waiting
ALTER TABLE messages ADD COLUMN is_bulk INTEGER NOT NULL DEFAULT 0;  -- bulk headers seen at ingest
CREATE TABLE correspondents (email TEXT PRIMARY KEY, own INTEGER NOT NULL DEFAULT 0, written INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
CREATE INDEX correspondents_own ON correspondents(email) WHERE own = 1;
-- the filters, shaped like v11/v12 (pages by date, scopes by id), carrying what a view or account tests
CREATE INDEX threads_people    ON threads(last_date DESC, id DESC, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE person = 1;
CREATE INDEX threads_people_id ON threads(id, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE person = 1;
CREATE INDEX threads_waiting    ON threads(last_date DESC, id DESC, waiting_since, account_id, in_inbox, in_trash, in_spam, is_starred, has_sent) WHERE waiting_since IS NOT NULL;
-- the backfill's queue, newest first
CREATE INDEX threads_facts_pending ON threads(last_date DESC, id DESC) WHERE person IS NULL;
INSERT INTO settings (key, value_json) SELECT 'facts_backfill',
  CASE WHEN EXISTS (SELECT 1 FROM threads) THEN '{"phase":"senders","after":0}' ELSE '{"phase":"done"}' END;
```

- **No row is rewritten by the migration**: `ADD COLUMN` with a NULL or constant default is O(1) in SQLite; only the five indexes are built (`threads_facts_pending` holds every thread at first). The migration's time at 50k threads / 300k messages is measured and gated (§6).
- **IndexedDB 4** creates the `correspondents` object store (`TABLES`: early, key `email`, index `own`). Thread rows written before have no `person` key: absent is NULL. `LOGICAL_SCHEMA` = 14 is written to `meta` on upgrade.
- **A newer database is refused** by an older app, as today (`user_version` > `SCHEMA_VERSION`, IndexedDB's `VersionError`), with the same "Update Terno." message.
- `waiting_since` ≤ `last_date` always (M is one of the visible messages), so `waiting_since >= cutoff` implies `last_date >= cutoff`: the waiting walks stop at the cutoff.

### 4.2 Ingest and recompute (both stores)

- **Headers**: `IncomingMessage.bulk?: boolean` (absent: false). IMAP adds `list-unsubscribe`, `precedence` and `auto-submitted` to the headers it already fetches; Gmail reads them from the raw message it already parses (`mime.ts` `parseRaw` → `bulkHeaders()` in core). Stored as `messages.is_bulk`. Older mail keeps 0: headers can't be fetched again without the network, so its classification uses the other signals (List-Id, labels, the address, whether you wrote to them).
- **Correspondents**: ingesting a message that is yours upserts its From as `own = 1` and every To/Cc/Bcc address as `written = 1` (idempotent: re-ingesting changes nothing). Deleting mail never clears them ("a person you corresponded with stays a person you know", as plan 18 §3.5).
- **`recomputeThreads`** computes `person` and `waiting_since` from the same single read of the thread's messages, now including `is_draft`, `is_bulk`, `list_id`, `gmail_labels` (R11). Your addresses are read once per call (`correspondents_own` plus the accounts); `written` is looked up only for a weak sender; To/Cc are parsed only for M; the cross-account "answered" check (`message_refs` by `(account_id, ref)` for each other account) runs only for a waiting candidate.
- **Knowledge that changes other threads**:
  - A new own address (the first message sent from an alias), or a new written-to address that is weak, can change the facts of threads with mail from that address. Those threads go back to pending (`person = NULL`, through `messages_from`) and the backfill recomputes them, so one ingest slice never recomputes an unbounded number of threads.
  - A message of yours with references: threads in *other* accounts holding a message with one of those Message-IDs are recomputed in the same unit (an index probe per reference per other account; only for your own mail). Deleting such a message does the same before it goes.
  - Creating or removing an account changes your addresses: threads with mail from that address go back to pending.
- **While the backfill's first phase runs** (your addresses and correspondents aren't complete yet), recompute writes `person = NULL` and `waiting_since = NULL`, so nothing is classified on partial knowledge. The second phase reaches those threads first (newest first).
- **Search projection**: `SearchThreadDoc` gains `person` and `waitingSince`. `recomputeThreads` already marks every thread it writes dirty, and the backfill writes through the same path, so the log serves every thread again with its facts. The instant index keeps a `T_PERSON` flag bit and a `thrWaiting` array (a new snapshot section; a snapshot without it restores with zeros and converges as the backfill's batches replay, so an upgrade doesn't throw the index away). Older log batches are ids, read when served, so they carry the new fields.

### 4.3 Reads

- `threads.list`, `scopeIds`, `scopeCount` take `filter: "people" | "waiting"`; `ListParams`/`ScopeParams` gain `now` (required for waiting; the backend always sends it).
  - SQLite pins `threads_people(_id)` / `threads_waiting(_id)` like v11/v12. Waiting adds `t.waiting_since >= ? AND t.last_date >= ?` (the cutoff), so a page walks the date index from the top and stops at the cutoff.
  - IndexedDB: `ThreadOrder`s for `person = 1` and `waiting_since != null`; `ScopeIndex.matching` for both. Waiting tests the cutoff per row and stops at `last_date < cutoff`.
- `threads.counts(now)`: `inboxWaiting` and `inboxWaitingByAccount`.
  - SQLite: `SELECT account_id, count(*) FROM threads INDEXED BY threads_waiting WHERE last_date >= ?1 AND waiting_since >= ?1 AND in_inbox = 1 GROUP BY account_id`: a range of the index, the threads of the last 30 days that wait.
  - IndexedDB: walk the waiting order until `last_date < cutoff`.
  - `inboxWaiting` is `null` until the backfill is done (§5): the greeting shows nothing rather than a growing number.
- **Searches**: `threadAttachments?: boolean` becomes `threadFilter?: "attachments" | "people" | "waiting"`, applied by every engine to the thread before paging (SQLite `t.person = 1` / the cutoff in SQL; the IndexedDB scan's thread row; the instant engine's flag bit and `thrWaiting`). `searchWithFilter` returns it for these three; unread and starred stay operators. `threadAttachments` is still accepted (an alias).
- **Summaries** (`ThreadSummary`) gain `person?: boolean` and `waitingSince?: number | null` (optional: a renderer must cope with an older backend's answers, and the stale web shell with a newer one's). `matchesFilter(filter, t, now)` reads them.

### 4.4 The store seam

```ts
facts: {
  /** one slice of the backfill, one unit of work: `limit` message ids (senders) or threads (threads); never more */
  backfill(o: { limit: number }): Promise<{ phase: "senders" | "threads" | "done"; processed: number; more: boolean }>;
};
```

`debug.snapshot()` threads gain `person` and `waitingSince`; `debug.resetFacts()` (test-only) puts a store back to the post-migration state (facts NULL, correspondents empty, phase `senders`) so the conformance suite can backfill any store.

## 5. The backfill

### 5.1 Phases

1. **`senders`**: messages by id in windows (`id > after AND id <= after + limit`, `is_sent = 1` tested in SQL, so a window's cost is bounded whatever it holds), upserting correspondents. The cursor (`after`) is written in the same transaction as the window. It ends when `after` passes the highest message id (read once per window).
2. **`threads`**: up to `limit` threads from `threads_facts_pending`, newest first, each recomputed exactly as ingest would. No cursor: the queue is the set of threads with `person IS NULL`, and a recomputed thread leaves it in the same transaction.
3. **`done`**: written when the queue is empty. Later invalidations (§4.2) put threads back in the queue without changing the phase; `backfill()` recomputes them.

IndexedDB mirrors this with its in-memory rows: phase 1 walks the id range with `get(id)`; phase 2 keeps a recency-ordered list of the pending ids, built once and walked (a recomputed id is skipped; when the list runs out, the remaining pending rows, if any, are listed again). Each slice is one command: one IndexedDB transaction with the rows it wrote, the cursor (a `settings` row) and its outbox batch.

### 5.2 Durable, restartable, cancellable (R10)

- **Durable**: every slice is one atomic unit (a SQLite transaction; one IndexedDB transaction). Its effects and its progress commit together or not at all.
- **Restartable**: after a kill, the next start finds the phase and cursor in `settings` and the remaining threads in the pending index. Re-running a window or a thread is idempotent (upserts set flags; recompute is a function of the messages).
- **Cancellable**: the backend's runner checks `stopped` between slices; `stop()` awaits the slice in flight, then the store closes. A quit mid-backfill loses nothing.
- **Concurrent ingest**: slices and ingest are units of the same single writer, so they never interleave. Ingest's recompute writes facts (or NULL during phase 1); a thread ingest wrote leaves the queue.
- **Message hydration (IndexedDB)**: backfill slices are non-early units, so they wait for the late tables like every command that reads messages. Lists and counts are early reads: they answer before hydration from the facts already on the thread rows.

### 5.3 The runner (`packages/backend/src/facts.ts`)

- Started from `BackendCore.start()` and woken by `notifyChanged` (ingest may have queued threads). It loops `store.facts.backfill({ limit })` with a `SliceSizer` per phase at the backend's slice budget (8 ms target), `platform.yield()` and `store.settle?.()` between slices.
- While it runs it announces at most one `changed` (views only) per second, and once at the end with fresh counts (`inboxWaiting` becomes known).
- Failures are captured (`facts.backfill_failed`, plan 10 fields: `count`, `durationMs`, `errorClass`) and retried on the next wake; three in a row stop it for the session.
- When nothing is pending, a wake costs one indexed probe (SQLite) or a set size (IndexedDB), and no timer runs: idle stays idle.

## 6. Performance

| Gate | Where | Budget |
|---|---|---|
| People and Waiting pages: inbox, archive, trash, an account; every page; cold first page; scope count and whole id walk; dense and empty cases | `store.perf` (SQLite, 29.5k threads), `perf.perf` (SQLite, 50k+ threads: as computed, twenty far from every view, everyone, no one) and `idb.perf` (28.4k threads, the adapter's usual mailbox) | plan 12/15's: a page ≤ 5 ms (SQLite p95) / a frame (IndexedDB), counts ≤ 3 ms |
| `counts(now)` with waiting; the waiting count alone | both; the count alone in `perf.perf` at 50k+ | ≤ 5 ms (the sidebar's); ≤ 1 ms |
| A search narrowed to People / Waiting, first and next page, instant engine | `idb.perf`, instant on SQLite | ≤ 25 ms |
| The backfill at **300k messages** (~120k threads): longest event-loop stall less GC (load-aware, `watchLoop` + `stallLessGc`) | `facts.perf` in `packages/backend` (SQLite, through the runner) and `packages/idb` | ≤ 32 ms SQLite (two frames), ≤ 48 ms fake-indexeddb in Node; throughput reported |
| A kill mid-backfill: SQLite in a child process killed with SIGKILL after ~40% of the threads; IndexedDB by dropping the store without closing it | `facts.perf` | the resumed backfill finishes, and every thread equals a fresh recompute |
| Migration v14 on a v13 database of 50k threads | `migrations` perf case | ≤ 1 s, reported |
| Ingest | `ingest.perf` (unchanged) | ≥ 0.97× the frozen reference (today ≈ 1.04×) |

- Each new gate is run once with an injected regression (a pinned index removed → a full scan; the backfill's limit ignored → one long slice; a per-thread unindexed lookup in recompute) and is recorded failing in §12.
- **Memory**: IndexedDB adds two orders and two id lists (ints, bounded by the thread count) and one pending list during the backfill. SQLite adds nothing in memory.
- **Disk**: five indexes; the two "people" ones hold roughly the people share of threads, the waiting ones a few percent, the pending one nothing after the backfill. Sizes reported at 50k threads.
- **Idle**: no timer; the runner sleeps until a change.

## 7. Tests

- **Core**: `senderKind` on a table of addresses, headers and labels (strong beats written-to; weak loses to it; plus-tags; Spanish roles; the `BULK_LOCAL` superset); `threadFacts` on a table of threads (hidden and draft messages, all-trash, spam, Cc-only, unknown recipient, cross-account answer, no inbound); `matchesFilter` with the window; `searchWithFilter` for the new filters; `bulkHeaders`.
- **Mail**: `parseRaw` reads the bulk headers; the IMAP fetch asks for them (the existing fetch test).
- **Conformance** (`packages/store/src/conformance`), on node:sqlite, SQLite-WASM and fake-indexeddb:
  - the facts table end to end through ingest (and flags, actions, undo, deletes, merges, sends, account removal);
  - list / scope / count parity for People and Waiting in every view, an account, a category, against the oracle; the cutoff with an injected `now`;
  - counts' waiting numbers, and `null` while the backfill isn't done;
  - searches with each thread filter, every engine;
  - the backfill from `resetFacts()`: done equals ingest-computed; interrupted after any slice and resumed (a new store instance on the same data) equals it too; ingest between slices; an invalidation (first mail to a weak sender, a new alias) requeues and the backfill fixes it.
- **Migration with real old data**: SQLite: a seeded v13 copy (`writeLegacyCopy`) opened at v14 (columns, indexes, phase), backfilled, equals a database seeded at v14; the people and waiting pages walk their indexes without a temporary sort (query plans). IndexedDB: a version-3 database written with the old shape (no `correspondents` store, rows without the new keys) opened at version 4 and backfilled.
- **Backend**: the runner runs at start, slices, stops on `stop()` mid-way and resumes on the next start, wakes on a change, announces once a second at most; counts and `threads.list` pass `now`.
- **E2E**:
  - `@design`: the People filter keeps only people's threads, through each design's own control (Lumen's chip, the others' menu), the open row kept; the palette's People and Waiting items.
  - Lumen: the greeting shows the inbox's waiting count (equal to the backend's), clicking it filters and shows the Waiting chip, clicking again clears it; an account's inbox shows its own count; no count while the backfill hasn't finished; replying to a waiting thread drops the count.
  - The new strings in Spanish (`i18n.spec`), axe in light and dark with the filters on.
  - Lumen's visual baselines updated (the People chip, the greeting line), and nothing else's.
- **Screenshots** of every design in light and dark (the People filter on, the greeting with the count, the Waiting filter's chip and empty state, the menu open): `/tmp/unica-scratch/people-17/`.

## 8. Out of scope

- **Mute and snooze**: no such features yet; when they come, muted threads leave the waiting count and filter.
- **Re-reading headers of old mail**: the backfill never touches the network; older mail is classified without `List-Unsubscribe`/`Precedence`.
- **A user override** ("this sender is a person" / "isn't"): a later plan; the heuristics are deterministic so an override can sit on top.
- **Gmail dot-insensitive alias matching**, BIMI, avatars, any lookup off the machine.
- **Waiting counts outside Lumen's greeting** (sidebar badges, other designs' subtitles).

## 9. Plan 15's R10 and R11, answered

1. **A durable backfill** (R10): every slice is one atomic unit with its progress (§5.2).
2. **Restartable** (R10): phase and cursor in `settings`, the remaining threads in a pending index; re-running is idempotent; proven by a SIGKILL mid-way (§6).
3. **Cancellable** (R10): the runner stops between slices and `stop()` awaits the slice in flight (§5.3).
4. **Message hydration** (R10): IndexedDB backfill slices are non-early units that wait for the late tables; lists and counts answer earlier from the facts already on thread rows (§5.2).
5. **Concurrent ingest** (R10): one writer, so slices and ingest never interleave; ingest computes facts itself, and writes NULL while phase 1 hasn't finished, so nothing is classified on partial knowledge (§4.2).
6. **Version compatibility** (R10): a newer database is refused by an older app (both stores, as today); summaries' and counts' new fields are optional, so an older renderer ignores them and a newer one copes without them; log batches are ids read when served; an instant snapshot without the new section restores with zeros and converges (§4.1–4.3).
7. **"Latest" excludes hidden messages** (R11): `person` and `waiting_since` read visible, non-draft messages (trash only when the whole thread is there; spam never) (§2.3).
8. **Recompute reads `list_id` and `is_draft`** (R11), and `is_bulk` and `gmail_labels` (§4.2).
9. **Counts take no clock; an injected one** (R11): `counts(now)`, `ListParams.now`, `searchText`'s existing `now`; the stores never call `Date.now()` for facts (§2.4).
10. **Expiry refresh** (R11): the 30-day window is applied at read time to a clock-free fact; counts refresh on every change, on `visibilitychange` and at the greeting's existing day-part boundary (§3.2).

## 10. Revisions after the Codex review

Codex (`codex exec -s read-only`, `/tmp/unica-scratch/people-17/plan-critique.txt`) made 12 points against the code. All are accepted; where they contradict the body above, this section wins.

1. **Invalidations bypassed the search outbox.** SQLite has no trigger on thread updates (v7: `recomputeThreads` marks what it writes). Every path that writes `person`/`waiting_since` outside `recomputeThreads` (the backfill, requeues) marks those threads dirty in the same transaction. A conformance test checks the instant engine's People answer after a requeue.
2. **Plus-tagged senders weren't reachable through `messages_from`.** `from_email` is stored as received. A requeue by address looks up the exact address and, on SQLite, the index range `local+` … `local,` with the same domain (one more range seek on the same index); IndexedDB walks its `from` index's keys for the same prefix. No new column.
3. **A new address of yours changes recipient checks too** (Cc-only, "mine"), not just mail *from* it. Learning an own address, adding or removing an account starts a **rescan**: phase `rescan` walks every thread by id in slices and rewrites the facts that changed (so the log and the indexes see only real changes). Counts read `null` until it ends.
4. **Flag updates can make a message sent or a draft** (`updateFlags` takes `isSent`/`isDraft`). The same maintenance as ingest runs on those transitions: correspondents (which may start a rescan) and the threads its references answer.
5. **Removing an account deletes its replies directly** (`removeAccount`, IndexedDB cascades), not through `deleteMessages`. Account removal starts a rescan (3). `deleteMessages` collects the references of your messages it deletes and recomputes the threads they answered.
6. **Live ingest and the backfill learned from different messages.** Correspondents learn only from sent, non-draft messages, in both paths: their From is yours, their recipients are people you wrote to. ("Mine" for the facts still includes mail from your addresses.) The result no longer depends on upgrade history.
7. **A reply can sit in another thread of the same account** (Gmail thread ids win over references). "Answered" looks in every account, the candidate's included, and a message of yours recomputes the threads its references name in every account.
8. **Queued and failed sends.** A send is optimistic like every action: the local copy answers the thread at once. A send whose op **failed** doesn't count (facts skip a `local:` message whose send op failed, a lookup made only for local rows), and the op's failure recomputes the thread and what it answered. Unknown sends still count until the user resolves them; discarding deletes the copy (5).
9. **The cutoff can't stop an id-ordered walk.** `threads_waiting_id` is dropped. Waiting scope pages and counts walk `threads_waiting` from the top to the cutoff (`last_date >= cutoff` bounds the range, since `waiting_since <= last_date`) and order by id within that window: a sort bounded by the threads that wait in the last 30 days, never the mailbox. IndexedDB does the same over its waiting order. A dense-expired / sparse-current case is gated.
10. **A thread count doesn't bound a slice** (one 50,000-message thread). The backfill and the rescan compute facts only (the other aggregates are already right), walking the thread's messages newest first through `messages_thread` in pages of 16, stopping once the newest visible message and the newest inbound one are known. `threadFactsNewestFirst` in core does it; a property test holds it equal to `threadFacts`. A skewed fixture with a 50,000-message thread is in the stall gate. IndexedDB's rows are in memory: one linear pass.
11. **Requeues and counts.** A requeue clears both facts. A requeue of at most 200 threads recomputes them in the same unit (no flicker of the count); more go back to the queue. `inboxWaiting` is `null` while any thread is pending or a phase other than `done` runs.
12. **A newer renderer and an older backend.** `app.bootstrap` reports the filters the backend knows (`filters`); the renderer offers only those (a missing list means plan 15's three), and a stored filter the backend doesn't know reads as none. A unit test runs the renderer's filter state against an older bootstrap.

## 11. What the Codex code reviews changed

### Round 1 (`/tmp/unica-scratch/people-17/review-1.txt`, `da55479..a887998`, 9 findings, all fixed in `12f6d99`)

Each fix has a regression test that fails without it (checked by undoing the fix for #5 and #6, and by construction for the rest).

1. **High: one long conversation could hold a slice.** A 50,000-message thread of yours (or entirely in the Trash) made the newest-first walk read all of it (94–99 ms). The facts now read a conversation's **newest 200 messages** (`FACTS_WINDOW`, drafts and hidden ones included), identically in `threadFacts` (a bounded heap when a thread is longer) and `threadFactsNewestFirst` (stops at 200). Test: core, a 50,000-message thread reads exactly 200; the property test runs both with a window of 3. The perf fixtures' giant thread is now a person's message then 50,000 of yours, plus a 10,000-message trashed one.
2. **High: writing to a sender with many conversations recomputed them inside the ingest.** A bounded look (`LIMIT 201` on the sender's range of `messages_from`, an O(1) count on IndexedDB's index) decides: up to 200 threads are recomputed in the unit, more become a persisted **sender job** (`settings.facts_senders`) that backfill slices walk by message id, the +tagged forms after the address. Facts stay as they were meanwhile; counts read unknown until the job ends. IndexedDB keeps its +tagged senders per address from row changes (no walk of every sender). Test (conformance, both stores): 205 conversations from a role address are untouched by the ingest that writes to it, then the backfill makes them people in more than three slices.
3. **High: a failed send was looked up by scanning every op.** `ops_failed_sends`, an expression index on the local message of failed sends (part of v14). Test: the query plan searches it.
4. **Medium: a draft ingested again as sent skipped the facts' upkeep.** Ingest of an existing message runs the same upkeep as a flag update when sent/draft changes. Test (conformance): a draft answering a question in another Gmail thread comes back sent; the question stops waiting.
5. **Medium: writing to someone Gmail filed under Updates didn't make them a person.** Every newly written address that isn't a no-reply address goes through the requeue (bounded, #2). Test (conformance).
6. **Medium: a send failing for good didn't tell the renderer.** The backend announces a change after a terminal send failure. Test (backend): a `changed` event and the count back at 1.
7. **Medium: adding an account left its rescan asleep.** `emitAccounts` wakes the runner (one probe when idle). Test (backend).
8. **Medium: Gmail's category moves never reached the stored labels.** `FlagUpdate.gmailLabels`, sent by the Gmail provider and written by both stores' `updateFlags`. Test (conformance): Promotions → Primary → Promotions.
9. **Low: some promised gates weren't asserted.** The SQLite People/Waiting id walk is timed, the IndexedDB waiting count is gated (≤ 5 ms), and searches narrowed to People or Waiting are gated on the FTS engine and IndexedDB's instant index (≤ 25 ms a page).

Found while measuring, before the review: the runner sized the first thread slice with the message-id sizer (a 5,277-thread slice, 265 ms), so slices report the next slice's kind; the walk's next page used an `OR`, which reads a long thread from its start, so it pages by a row value (`a3656b2`); IndexedDB's queue sorted every pending thread in one slice (180 ms at 145,000 threads), so it walks the store's recency order from a cursor (19 ms); the SQLite recompute reads To, Cc and the Message-ID only for the newest message, and Gmail's labels as the one category that decides.

### Round 2 (`review-2.txt`, on round 1's fixes, 6 findings, all fixed in `7b6b48c`)

1. **High: IndexedDB's first queue slice sorted every thread** when nothing had listed yet (`ThreadOrder`'s first build, 119 ms at 145,000). Until the recency order is built (`ready`), the queue walks ids from the highest down (about newest mail first), a bounded number of steps a slice. Test: the queue never asks an unready order for its threads. The IndexedDB backfill gate now runs on an unprimed store.
2. **High: a sender job materialized the sender's whole history every slice** (68–82 ms at 600,000 conversations, quadratic overall). A live walk of the `from` index's keys (`Table.keysBy`), `n` a slice. Test: no `by("from")` during the job's slices.
3. **High: the 200-message window didn't bound IndexedDB**, which fetched a whole thread to choose its newest 200 (74–113 ms for 300,000). Past `BIG_THREAD` (4,096) messages the backfill reads a conversation in chunks, one a slice, keeping the newest 200; a change to it reads it again, and a thread ingest computed meanwhile is let go. Requeues, sender jobs and rescans hand such a thread to the queue instead of reading it. Test: a 12,289-message thread takes at least three chunk slices.
4. **High: SQLite's +tagged sender walk sought on the address only** (`(from_email, id) > (?, ?)` read the address's earlier rows: 41–84 ms late in 600,000). The cursor's address is sought with its id (`from_email = ? AND id > ?`), then the next addresses (`from_email > ?`). Test: round 3 #2's.
5. **Medium: a pending op dropped Gmail's category change** with the flags. Labels aren't optimistic state: they're written for messages with pending ops too. Test (conformance).
6. **Medium: a send that ran out of attempts on network errors didn't tell the renderer.** One announcement after either failure branch. Test (backend).

Also: the greeting's count got its own covering index (`threads_waiting_inbox`), since the window's range of `threads_waiting` read ~0.28 ms per counts call, about 8% of the sidebar's counts at 30,000 threads.

### Round 3 (`review-3.txt`, on round 2's fixes, 2 findings, fixed in `943e788`)

1. **Medium: IndexedDB's sender walk ran ahead of what committed.** A reverted slice, or a reverted command that took all the sender's mail (the index lets an empty key set go), left threads behind. The job commits its position with each slice; the walk is trusted only while its position and key set agree with what committed, otherwise it is made again (skipping to the position, or from the start for a new set). Tests: both scenarios, the first verified failing without the fix.
2. **Low: the plan tests checked constants, not the code's statements.** A test records what the greeting's count and a sender job at a late +tagged cursor actually prepare, and checks those plans (verified failing without the address seek).

### Rounds 4–6 (`review-4.txt` … `review-6.txt`, on the sender walk)

- Round 4 (2 findings, `23e7789`): skipping to the committed position after a reverted slice could skip a key an update had moved to the set's end (599 of 600), and the skip was unbounded (250,001 steps for a one-message slice). A walk that disagrees with what committed now walks its address again from the start, in the same bounded slices. Test: a reverted slice after an update; the next slice takes at most `limit + 1` steps (205 before).
- Round 5 (1 finding, `b390fc3`): a replay that was itself reverted could match the committed position again. The job commits a slice counter that only moves forward; a walk made for another value starts over. Test: two reverted slices in a row (599 of 600 before).
- Round 6: nothing found ("rollback/replay, reindexed rows, replaced key sets, restart, same-address requeue and +tag transitions" checked).

## 12. As shipped: measured, and the gates against injected regressions

Measured on a machine loaded by other work; budgets as in §6.

- **Migration v14** at 50,000 threads: 43–74 ms (≤ 1 s); the first 40 cold slices ≤ 1 ms each.
- **Backfill at 314,152 messages / 145,002 threads**, a 50,000-message thread and a 10,000-message trashed one included. SQLite through the runner: 5.7–6.0 s (about 25k threads/s), longest stall 27–28 ms (≤ 32). Killed with SIGKILL at about 41%, the resumed backfill ends equal to ingest's facts. IndexedDB: 4.9–5.4 s, longest stall less GC 19–26 ms (≤ 48). Dropped without closing at about 40%, it resumes and ends equal.
- **Pages at 50k+ threads (SQLite)**: People and Waiting first pages 0.3 ms, the largest category 3.4 ms, archive counts ≤ 2.4 ms (everyone a person), the whole archive id walk ≤ 11 ms (everyone); the waiting count alone 0.21 ms (0.53 ms when every thread waits), counts with it 3.2–3.6 ms. IndexedDB (28.4k threads): every page ≤ 0.25 ms, cold first page 6–9 ms.
- **Ingest**: 0.985–1.006× the frozen reference (≥ 0.97); without v14's indexes 1.022×.

Each new gate, run with a regression injected (then reverted):

| Injected | Gate | Result |
|---|---|---|
| People's predicate made non-sargable (`t.person + 0 = 1`, unpinned) | `perf.perf` 50k, sparse | archive first page 12.9 ms > 5: **fails** |
| The waiting count by table scan (`NOT INDEXED`) | `perf.perf` 50k | counts 6.7 ms > 5: **fails** (at 29.5k threads `store.perf` let it pass at 4.6 ms, so the 50k gates were added) |
| IndexedDB People walking the whole recency order | `idb.perf` | cold first page 20.6 ms > 16, twice (clean: 9 ms, twice): **fails** |
| The runner's slice target 8 → 80 ms | `backend/facts.perf` (SQLite) | stall 151 ms > 32: **fails** |
| The IndexedDB slice ignoring its limit | `idb/facts.perf` | stall 905 ms > 48: **fails**. (A target of 80 ms passed here: a slice is a store command whose time includes the asynchronous commit, so its synchronous part stays under 48 ms; the sizer adapts to per-thread costs, so the limit is what the gate guards.) |
| Facts computed eagerly at open (the backfill run to the end inside the migration) | `facts-migration.perf` | 8.1 s > 1 s: **fails** |
| A senders slice ignoring its id window | `facts-migration.perf` | first slices 82.6 ms > 32: **fails** |
| The facts context rebuilt per thread instead of per batch | `ingest.perf` | 0.9698× < 0.97: **fails**, at the edge. Re-reading each thread's messages from the database instead passed (0.989×): this gate's resolution is about 3%, and the facts are a small part of an ingest. |

The query-plan tests (`migrations.test.ts`) catch a lost index exactly, whatever the timing.

**`autocomplete-perf.spec.ts`'s 10 MB draft** failed on this branch three times under load (opening the draft timed out at 8 s twice, and suggestions took 753 ms once) and passed on the base three times. A scratch spec that times opening the 10 MB draft three times on each tree found the same multi-minute stalls on both: base 115 s for a reload and 114–119 s to open, this branch 117 s. That's load, not this feature.

