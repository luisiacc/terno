# Plan 139: every test in ten minutes

## The request

> why the tests take so much time? please revise the entire tests, all of them , see which ones are useless and can be removed, how to optimize the test running, its not acceptable this running for more than 1 hour, i'd say 10 minutes maximum for all tests, that perf tests should not be 32minutes not even close, for e2e across all designs, we are likely duplicating tests for things that in the sytles only change the style and don't add any buttons at all, we likely have duplicated tests, lets do a massive simplification of test and optimization, keeping the tests that make sure things work and performance is upheld.

## What exists (measured on this machine: 8 performance and 4 efficiency cores, 34 GB)

| Suite | Tests | Time | Where the time goes |
|---|---|---|---|
| typecheck, lint | | 14 s | |
| unit | 14,853 | 206 s (1,959 s summed) | `visible-mail-text` 4,512 cases of one matrix across 4 store setups: 320 s summed; conformance run per store setup: 225 s; `imap.int` 88 s; 50k tests living in unit files (`cached-refresh` 53 s, `provider-resource` 26 s); `date-timezones` 38 s |
| db-wasm | 2,174 | 69 s | the same `visible-mail-text` matrix 67 s, conformance 51 s |
| e2e, 5 designs | 3,729 | 1,597 s (macOS alone: 1,315 tests, 575 s, 2,150 s summed) | 2,448 runs repeat `@design` flows in other designs; `controls.spec` 280 tests, 265 s |
| web | 53 | 399 s | one test, the MailStore contract on SQLite-WASM over OPFS: 328 s |
| dist:mac | | 58 s | |
| smoke | 75 | 598 s on 1 worker | `native-reload` 229 s, `update` 103 s |
| perf | 330 | about 3,360 s one after another (the gate could not finish in 40 minutes) | see below |
| ui-perf | 82 | 627 s and more | the 10 MB draft 166 s; a design × density matrix of `sustained j` and scrolling 200 s |
| **All** | | **about 1 h 55 min** | |

Perf's six biggest tests hold most of it, measured under a parallel run: `idb.perf` one folder test 466 s, `facts-migration` 580 s, `load.perf`'s slow-disk test 286 s, `migrations.perf` 317 s, `idb/facts` 254 s, `twins` 136 s. `migrations.perf` writes a row-by-row copy of 50k threads per version; `facts-migration` times a v14 step that shipped long ago on three copies; `twins` builds 50k rows four times; about 20 more files seed their own 50k mailbox, 18 s on SQLite and 10 s on fake-indexeddb, before their first measurement.

35 of the Playwright configs (`apps/web/playwright.*.config.ts`) and 23 `*.dev.ts` specs are left from single fixes: no script runs them.

### Do designs change behaviour?

A design (plan 15) is typography, shape, density and 9 structural variants, read by 5 components: reader, list-tabs, thread-list, sidebar and the first-run preview. Roles, names, test ids and shortcuts are the same in all of them (`designs.spec.ts` holds that). So 612 behaviour flows per design mostly run the same code again. Which design holds which value:

| Variant | macOS | Lumen | Atelier | Luma | Graphite |
|---|---|---|---|---|---|
| compose | list-header | sidebar-pill | sidebar-outline | sidebar-pill | sidebar-row |
| listHeader | title | greeting | display | title | title |
| search | field | **button** | field | field | field |
| quickFilters | menu | **chips** | menu | menu | menu |
| row | classic | large-avatar | avatar | avatar | classic |
| categoryReview | sub-rows | inline-badge | inline-badge | inline-badge | inline-badge |
| readerHeader | classic | sender-card | chips-display | classic | classic |
| replyAction | icons | **pill** | icons | icons | icons |
| categoryTabs | underline | pill | underline | pill | pill |

## Design

The target: `pnpm test:all` runs everything in at most 600 s here, and fails when it doesn't, so the time can't grow back unnoticed.

| Stage (each runs after the one before) | Suites | Budget |
|---|---|---|
| 1, together | typecheck, lint, unit, db-wasm | 130 s |
| 2, together | e2e with its design projects, web, dist then smoke | 240 s |
| 3, alone | perf, then ui-perf | 230 s (perf 130, ui-perf 100) |

### Rules for what stays

1. **Each behaviour is tested once, at the lowest level that can catch its failure.** Pure logic in unit, store contracts in conformance, flows in e2e, what only a packaged app does in smoke.
2. **A matrix earns each axis.** A test repeats across a design, a store engine or a mode only if that axis can change the result. Otherwise one full run plus a focused subset on the other values.
3. **A gate must be able to fail.** A perf gate that a regression couldn't trip, or that fails every day on a healthy machine, is fixed or removed.
4. **A slice gate is measured at the size that matters to it.** Reads and queries stay at 50k+ in both stores (AGENTS.md). A gate on a slicer's stall (bulk work, backfills, resuming) measures one slice's bound and doesn't get stricter from rows it never touches, so it runs at the smallest size that still takes many slices.
5. **Seeding isn't the test.** A mailbox is built once and copied.
6. **Shipped is frozen.** A shipped migration's SQL can't regress unless someone edits it, and a checksum test forbids that.

### Perf: 3,360 s to 130 s

- `packages/db/src/test/perf-mailbox.ts`: the 50k SQLite mailbox, seeded once per run and copied per file (a file copy, well under a second). Files that need the same shape share it; workloads in `@terno/store/conformance` (`measureWriting` and the others) split "seed" from "measure" so they can take a seeded store.
- `migrations.perf`: one copy at v24, walked step by step, each step timed, then the total. `facts-migration`'s v14 timing goes (v14 is frozen; `migrations.perf` holds the rule); its cold backfill slices stay, on one copy. A new test locks shipped migrations by checksum.
- `twins`: one store holding both cohorts.
- IndexedDB: the small workload files share one 50k store in one test file, since fake-indexeddb can't be copied; `idb.perf`'s folder test labels what the gate reads rather than every message of an account one batch at a time; `idb/facts` and `load.perf`'s slow-disk test drop to their slice size (rule 4).
- `ingest.perf`: 8 paired rounds fail 0.95 against a 0.97 tolerance on every healthy run, so that's rule 3: rebase its tolerance on what was accepted and pair fewer rounds.
- Perf stays one file at a time.

### E2E: 1,597 s to about 200 s

- `e2e` (macOS) runs every behaviour once.
- `@design` shrinks to what a design can change: `designs.spec`, the visual baselines, an axe sweep of the main surfaces in light and dark, and icon, motion and corner checks. These run in all 5 designs.
- A new tag `@variant` keeps the flows that go through a structural variant (compose entry, search behind a button, chips, sender card, reply pill, inline review badge, the category tabs). They run in the designs that hold a value macOS doesn't: Lumen, Atelier, plus Graphite's compose row.
- `controls.spec`: one test per design and mode doing all its probes on one page: 280 tests become 10.
- `settings-pass`'s 86 s contrast test goes through palettes that can't be proved by the contrast suite only.
- Workers go from 4 to 8, once the suite is shown stable at 8.
- Duplicates between specs are read and removed, spec by spec, under rule 1. Spec-level `@design` tags that exist only to run axe per surface collapse into the sweep.

### Web: 399 s to 60 s

The OPFS contract keeps a persistence subset (open, write, reopen, migrate, take over): db-wasm runs the whole contract on the same engine. Native IndexedDB keeps its full contract in one mode. The `(macos) @design` repeats and the recovery matrix collapse under rule 2.

### Smoke: 598 s to 100 s

`native-reload`'s missing/unknown × settings/shortcuts matrix keeps one of each axis that can differ; what's left runs on 3 workers if the app's profiles and ports allow it, one at a time where not.

### Unit: 206 s to 110 s, db-wasm: 69 s to 25 s

- `visible-mail-text`: the whole matrix once at the parser and on SQLite; IndexedDB and WASM keep the cases where the store's own index decides.
- IndexedDB's second conformance mode (instant index) keeps what the index answers: search, filters and their mutations.
- 50k tests leave unit for perf, or go to the size their property needs. `date-timezones` keeps a positive, a negative and a half-hour offset.
- Sleeps in `imap.int`, `network.int` and others are replaced by the event they wait for where one exists.
- The audit reads every package's tests under the rules above and removes what repeats. What can't be justified by a failure it would catch goes.

### UI perf: 627 s to 100 s

One design per row layout (classic, avatar, large-avatar) in comfortable, plus one compact. The 10 MB draft drops (5 MB holds the same gate), and the heap test does fewer rounds. Serial mode stays only where tests depend on each other, so a failure no longer skips every later gate.

### Also

- The failures every run has been carrying get fixed, since a red suite hides new failures: `w02-canonical-actions` (4), `i18n.spec`'s Graphite in Spanish, `send-later.spec:113`.
- Delete the 35 unused Playwright configs and 23 `.dev` specs, and any helper only they used.
- AGENTS.md: step 5 becomes `pnpm test:all`, with the rules above. Designs' `@design` section says what the tag now means.

## Proof nothing that matters was lost

- Mutation checks: for each reduced gate family, a deliberate regression (a design's variant broken; a query without its index; a slicer that stops adapting; a migration rewriting rows) must fail the new suite. Recorded here.
- Every removed file or group is listed with what still covers it.

## Revisions after the Codex review

Twelve points against the code, all taken. They change the design above where they differ:

1. **UI perf's budget was below its sampling windows.** A paired autocomplete burst is 900 ms, 15 keys at 90 ms, 600 ms; three positions plus the paragraph cost about 90 s by themselves, and four `sustained j` cases 40 s. So windows are redesigned and measured, and the injected-regression canaries stay. Stage 3's split is decided by measurement, not by this plan.
2. **A walked migration can't also be the startup total.** Reopening a walked copy migrates nothing. The walk times each raw step (populating what a later step's table needs); a second untouched v24 copy is timed through `openDatabase`.
3. **v14's SQL being frozen doesn't freeze what running it costs:** the runner, pragmas and SQLite itself can regress. One timed v13-to-current startup stays, on one copy, not three.
4. **Slice size isn't enough for `idb/facts`.** First use visits every thread, the algorithm changes above 4,096 pending threads, and conversations above 4,096 messages take another path (`facts.ts:63,80,104`). Ordinary backfill work shrinks; a large cold first use and a multi-chunk giant conversation, with a restart inside it, stay.
5. **A copied SQLite file isn't a seeded one.** `store.perf` deliberately measures a fresh connection with hot pages in its WAL, and seeding runs `PRAGMA optimize`. So: checkpoint and close before copying, say per workload what statistics and warmth it wants, keep the fresh-write and WAL cases seeded, and check thresholds and a missing-index mutation under both setups before trusting a copy.
6. **A shared IndexedDB store is benchmark input.** Forwards leaves filters on and summaries then times ingest under them; storage perf deletes bodies. So: workloads are grouped by compatibility, each asserts the counts it needs before timing, and destructive or cold-start workloads get their own store.
7. **Row variants aren't geometry.** Atelier and Luma both use avatar rows at different heights, and a row's height also depends on density and List layout (`thread-list.tsx:649`). A short per-design List round trip stays (height, scroll and focus restored), and UI perf picks its designs by real row height and mounted rows.
8. **Node WASM doesn't replace OPFS for recovery.** Node exports whole images; OPFS has a rollback journal over SAH pools (`wasm-driver.ts:160`). The real-OPFS subset names atomic rejection, attachment bytes and send recovery (`draft-recovery.ts`), besides lifecycle.
9. **The instant subset must cover bulk categorization and prove which path answered:** `categorize.resolveScope` has its own indexed path, paging by 500 with exclusions (`idb/store.ts:2148,2225`), and an instant store can silently scan until caught up. It keeps bulk scope and count over 500 matches, exclusions, mutations and reopen, with readiness and strategy asserted.
10. **The 10 MB draft is the multibyte case** (Chinese, where bytes and the five-million-character limit differ). Encoding is kept apart from scale: a smaller Chinese case plus one near-limit size probe, at fewer positions.
11. **`update.smoke` is serial with two signed builds in `beforeAll`,** so more workers can't shorten its 103 s, and its tests share a profile, updater identity and Squirrel caches. Smoke's budget is the longest serial file plus setup: it's budgeted once `update.smoke` is measured and its builds reused where immutable.
12. **Stability at 8 workers has to be shown under all of stage 2.** Web workers, Electron and packaging run alongside, and e2e holds hard timing asserts (`reader.spec.ts:155`, 100 ms). Those asserts move to the perf stage or become counts, stage 2 gets a shared concurrency limit, and the whole schedule is what's validated.

So the budgets above are targets. What decides is `pnpm test:all` under 600 s, and where a cut would lose what a gate proves, the gate stays.

## Perf of the change itself

`pnpm test:all` under 600 s, measured three times, and stable under it (no new flakes at 8 workers).

## Out of scope

Product code, except where a test exposes a real bug. CI (the repo runs none for tests). `test:web-perf` (not in the gates; stays as is).
