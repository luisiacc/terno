# 156 · A launch that doesn't parse the backend every time

## The request

"yes find what is slowing launch down and fix it, for the ainproviders sdk you could load them parallel to the main ui since they are not required to show the first screen when you launch the app"

(After plan 155, no lazy loading, warm starts read 947 to 1,539 ms against 833 to 876 before.)

## What exists: where a launch goes

Traced on packaged builds, one mark set applied to both, median of 15 launches, ms from spawn:

| | before plan 155 | after plan 155 |
|---|---|---|
| main forks the backend, creates the window | 341 | 363 |
| backend process starts | 380 | 402 |
| its bundle's first line runs | 678 | 798 |
| backend ready | 765 | 884 |
| renderer's own first paint | 702 | 749 |
| rows painted, by the page's clock | 819 | 935 |
| what `startup.perf.ts` read | 869 | 1,371 |

Three findings:

1. **The gate misreads.** `locator.waitFor` retries at 0, 20, 50, 100, 100, then every 500 ms, so a row that misses a retry is read up to 500 ms late: a run reported as 1,426 ms had painted at 954. The real regression of plan 155 is about 115 ms, not 500, and the two values were never in the app.
2. **The backend's compile is the launch.** Everything else waits for it. Inside the utility process: reading `backend.cjs` 0.7 ms, compiling it 346 ms (66 ms in plain Node, not known why), compiling it with V8's code cache 8 ms, evaluating it about 60 ms.
3. **The AI SDKs cost compile, not evaluation.** Plan 155 added about 100 ms before the first line, and about 5 ms after it (56 to 61): as static ES modules they are hoisted to the bundle's top level, which is compiled eagerly. Node's `enableCompileCache` reports enabled and changes nothing in this process. An ASCII-only source changes nothing either.

## Design

`backend-boot.cjs`, a small entry main forks, loads `backend.cjs` through `vm.Script` with `cachedData`:

- **The file** is one, `<userData>/engine.v8cache`, overwritten: the build it belongs to, then V8's data (2 to 3 MB). It holds compiled code of our own bundle, nothing of the user's.
- **Which build:** the bundle's debug id, read from its last line (content-derived, `scripts/sourcemaps.mjs`). V8 checks its own version, flags and the source's length, never its content, so a same-length build needs this.
- **Written** once per build, 2 s after evaluation, so the functions used for the first screen are in it, with `createCachedData` (about 12 ms) and an atomic write, never when an accepted cache was used.
- **Never in the way:** a missing, stale, torn or rejected cache means a normal compile, and any failure around it is ignored. Evaluation errors stay the backend's own.
- **Crash safety:** a backend restarted after an exit starts without a cache and deletes it. Bad bytecode can't crash-loop the mail engine; the next normal launch writes a new one.

### The AI SDKs

The request offers loading them beside the first screen. It isn't needed if the cache removes their compile, and it would be the one exception to plan 155's rule. Measured once the cache is in: if evaluating them still costs the first screen a noticeable time, they move; otherwise they stay plain imports. (On one thread, "parallel" would still block the backend while they evaluate.)

## Tests

- Unit (`code-cache.test.ts`): runs the file with `__filename`/`__dirname`/`require`; no cache writes one; an accepted cache is used and not rewritten; another build's, a torn or a garbage file compiles normally and is replaced; an unwritable path doesn't fail the launch.
- `startup.perf.ts`: reads rows at frame precision (`waitForFunction`, `raf`), holds the budget at a number the app now meets, and checks the cache exists.
- Packaged smoke: the backend still starts, restarts after a crash and reports errors with the bundle's name.

## Perf

Before: rows painted at 935 ms. Target: under plan 155's starting point of 819.

## Out of scope

The main process's own compile, unless measuring shows it matters: it runs before the profile is prepared, so it has nowhere settled to keep a cache. The renderer already has Chromium's.
