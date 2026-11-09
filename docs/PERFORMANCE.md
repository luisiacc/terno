# Performance

Every number below is measured and enforced by a test.

## Backend

`pnpm test:perf` seeds **50k+ messages across 8 accounts** (realistic bodies, long threads, shared timestamps) and asserts p95 latencies against the product targets. Reports are written to `test-results/perf/*.json`.

| What | Target (p95) | Typical on M-series |
|---|---|---|
| Open a view / page deep with keyset | ≤ 5 ms | ~0.3 ms |
| Category view (5k threads) | ≤ 5 ms | ~2 ms |
| Sidebar unread counts | ≤ 5 ms | ~2.7 ms |
| Instant search, every keystroke of `p…presupuesto` (engine) | ≤ 2 ms cold · ≤ 1 ms warm | ≤ 0.2 ms · ≤ 0.1 ms |
| Instant search, phrases (incl. frequent words rarely adjacent) | ≤ 5 ms | 0.2–2 ms |
| Search RPC while typing (backend, end to end) | ≤ 5 ms | ~0.7 ms |
| Instant index: memory · background build · stalls while building | ≤ 64 MiB · reported · ≤ 16 ms | ~39 MiB · ~1.3 s · ≤ 12 ms |
| Full-text search on FTS5 (the fallback) | ≤ 25 ms | 0.05–20 ms |
| Filter preview over all mail | ≤ 50 ms | ≤ 30 ms |
| RPC round trip (list) | ≤ 3 ms | ~0.4 ms |
| Search **during** a 14k-message import + bulk filter | ≤ 45 ms | ~35 ms |
| Categorize a thread (20 categories) | ≤ 50 µs | ~30 µs |
| Snackbar counts: sender / domain / list · topic | ≤ 5 ms · ≤ 25 ms | ~1 ms · ~9 ms |
| 14k-message import with the categorizer on | ≤ 10% slower | ~6% |
| "Select all N" archive of 18,792 threads, its undo: longest stall · list RPC | ≤ 50 ms · ≤ 20 ms | ~24 ms · ~0.5 ms |
| Exclusive move of 5,000 threads (in 1 or 20 categories each), its undo: longest stall | ≤ 50 ms | ~15 ms · ~35 ms |
| Count a 47,000-thread category · mark it all read: longest stall | ≤ 25 ms · ≤ 50 ms | ~7 ms · ~36 ms |

## Renderer

**In the real renderer** (`apps/web/e2e/perf.spec.ts`, Chromium, production build, real backend):

| What | Target (p95) | Measured |
|---|---|---|
| Holding `j`: keydown → selection committed (300 presses) | ≤ 16 ms | ~1 ms |
| Search: keystroke → results rendered | ≤ 100 ms | ~9 ms p50, ~20 ms p95 |
| Scroll to the end → next 100 rows rendered | ≤ 150 ms | ~35 ms |
| DOM rows while scrolling 2,000 threads | bounded | ≤ 33 |
| Theme switch → painted (double rAF, so ≥ 2 frames) | ≤ 50 ms | ~35 ms, 0 row renders |
| Drag start: threshold move → ghost shown, targets measured | ≤ 16 ms | ~5 ms |
| Drag start: threshold move → the frame showing the ghost rendered | ≤ 1 frame (16.7 ms at 60 Hz) | ~6.5 ms |
| Drag: pointermove handler · row renders during a drag | ≤ 2 ms · 0 | ~0.1 ms · 0 |
| Drop → dot on the row | ≤ 16 ms | ~1 ms, 1 row render |
| Right-click → context menu painted | ≤ 50 ms | ~9 ms p50, ~13 ms p95, 0 row renders |
| ⌘A over 500 loaded rows → committed | ≤ 16 ms | ~1.6 ms, only the rows that changed render; a toggle renders 1 row |
| `j` at key repeat (30/s, 300 presses, both densities, drafts present): frame interval · longest frame | ≤ 20 ms · ≤ 50 ms | 16.7 ms · ≤ 33 ms, 0 long frames, ~3 row renders per move |
| Continuous scroll across 2,000 threads (3 s fling, both densities): frame interval · longest frame | ≤ 20 ms · ≤ 50 ms | 16.8 ms · 16.8 ms |
| Expanding 19 messages of a conversation (5 HTML): frame interval · longest frame | ≤ 20 ms · ≤ 50 ms | 16.8 ms, nothing left mounted when collapsed |
| Inline reply: keypress → first frame showing it · that frame → expansion done | ≤ 50 ms · ≤ 133 ms | ~15 ms · ~115–126 ms |
| Print document for a 100-message conversation → built | ≤ 30 ms | ~9 ms |

## Packaged app

**Packaged app** (`pnpm test:smoke`): about 0.5 s from a warm start to the first mail painted.

## Web

**On the web** (`pnpm test:web-perf`, Chromium, real OPFS/IndexedDB in a persistent profile, timed in the page through the worker RPC; p95 at ~50k messages, load average 5–10 during the runs):

| What | Budget | SQLite on OPFS | IndexedDB |
|---|---|---|---|
| Repeat visit → first mail painted | ≤ 700 ms (IndexedDB ≤ 900) | ~280 ms | ~680 ms |
| List first / deep page | ≤ 2 ms | 0.7 / 0.8 ms | 0.2 / 0.2 ms |
| Category view · counts · open | ≤ 6 ms (IndexedDB ≤ 4) | 1.7 · 3.9 · 0.2 ms | 0.4 · 0.8 · 0.1 ms |
| Search (instant index) | ≤ 25 ms | ≤ 1.9 ms | ≤ 8 ms |
| Search, durable path alone | ≤ 25 ms (FTS5 1 char ≤ 60; exact scan ≤ 1.5 s) | FTS5 ≤ 9.3 ms (1 char ~38 ms) | exact scan ≤ 1.5 s, in ≤ 8 ms slices |
| Action commit | ≤ 16 ms | ~11.5 ms | ~11 ms (15–29 ms under load) |
| Filter preview over all mail | ≤ 50 ms (IndexedDB ≤ 600) | ~20 ms | ~46 ms |
| Keystroke → results rendered | ≤ 100 ms | ~19 ms | ~18 ms |

Cold first visit to an interactive shell: ~0.3–0.5 s. Seeding the 50k demo mailbox in the worker: ~15 s on OPFS, ~13–18 s on IndexedDB.
