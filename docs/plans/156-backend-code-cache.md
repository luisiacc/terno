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

`backend-boot.cjs`, a small entry main forks, loads `backend.cjs` through `vm.Script` with `cachedData` (`code-cache.ts`). Nothing is deferred: the bundle runs at once, in full.

- **The file** is one, `<userData>/engine.v8cache`, overwritten: the format and the build it belongs to, then V8's data (3.7 MB). It holds compiled code of our own bundle, nothing of the user's. Main passes its path as an argument, since the profile is main's to resolve.
- **Which build:** the bundle's debug id, read from its last line (content-derived, `scripts/sourcemaps.mjs`), in the same read as what's compiled. V8 checks its own version, flags and the source's length, never its content, so a same-length build needs this.
- **Written** once per build, 2 s after evaluation, so what the first screen uses is in it: 20 ms for `createCachedData` and 2 ms for an atomic write (a temp file of its own, then a rename), once, inside the slicer's budget. Never when a cache was accepted. A launch quit within 2 s writes nothing, and the next one tries again.
- **Never in the way:** a missing, stale, torn or rejected cache compiles normally. The bundle runs once, outside anything that catches, so its errors stay its own.
- **Crash safety:** a backend that dies without being asked starts again with no cache and the file goes, for the rest of the session: a Retry too, and however long it ran, since the restart policy's count resets. Bad bytecode can't keep the mail engine down; the next launch writes a new one.
- **Stack traces:** absolute filename, and a negative `columnOffset` so the wrapper doesn't shift line 1; the debug id lookup keeps working.

### The AI SDKs

The request offers loading them beside the first screen. Measured with the cache in, it would gain nothing: evaluating the whole bundle takes 38 ms and the backend is ready at 496 ms, about 170 ms before the renderer first asks it for anything (665 ms). They stay plain imports, with no exception to plan 155's rule. Their cost that's left is a first launch after an update, which compiles them with everything else. (And on one thread, "parallel" would still block the backend while they evaluate.)

## Tests

- `code-cache.test.ts`, each load in a process of its own (in one, V8's compilation cache answers and a bad cache looks accepted): runs as CommonJS; writes, then uses and leaves alone; a same-length build never runs another's code; garbage and a torn file compile and are replaced; an unreadable or unwritable path doesn't get in the way; a bundle's own failure is the process's, once; lines and columns hold with and without the cache; main's switch.
- `backend-retirement.test.ts`: a crash turns the cache off, a replacement asked for doesn't.
- `startup.perf.ts`: rows by the page's clock (`terno:first-rows`, the frame that paints them, only with a row in the page), and one visible afterwards; waits for the cache outside the measured time; each launch's `backend.code_cache` in main's log says how it compiled (none, then accepted three times); logs the launch without a cache.
- `update.smoke`: a backend crash, and a real update's relaunch.

## Perf

Median of 15 launches, in one run, rows painted, ms from spawn, on a machine at load 15 to 25:

| | backend ready | renderer asks | rows painted |
|---|---|---|---|
| Before plan 155 | 768 | 620 | 824 |
| After plan 155 | 865 | 616 | 920 |
| With the cache | 496 | 665 | 754 |

Compile: 345 ms to 8 ms. `startup.perf.ts` on a clean build: warm 692 to 818 ms, and 880 to 902 ms without a cache, the first launch after an update. **Its budget goes from 1,500 to 1,000 ms,** now that it reads the real thing.

The renderer is now what a launch waits for: about 100 ms of script after commit, on Chromium's own code cache.

## Out of scope

- The main process's compile: `main.cjs` grew by 260 KB in plan 155 with no visible change at its first line. It also runs before the profile is prepared, with nowhere settled to keep a cache.
- A cache shipped in the app, for the first launch after an update: V8's flags and CPU features have to match, so it would need building on the user's machine anyway.

## Not verified

A Developer ID build, with the hardened runtime: this machine has an Apple Development identity only. `update.smoke` ran signed with that; the cache's numbers are from ad-hoc builds. `test:all` on a release machine covers it, through `startup.perf.ts`'s check that the cache was accepted.

## Seen on the way

`native-reload.smoke.ts:287` fails whenever it shares a run with other spec files, on this branch and 3 of 3 on the build before plan 155: it asserts which window the OS has focused. It passes alone. Not touched.

## What the Codex review changed

Of the code:

1. **The gate's proof of acceptance proved nothing.** It checked the file was unchanged, but a rejected cache is only rewritten 2 s later and a measured launch quits sooner. The backend now tells main how it compiled, main logs it (`backend.code_cache`, in the diagnostics catalog: it's what a slow launch is asked first), and the gate reads that for every launch.
2. **The mark fired without rows,** on a list that failed to load, so a fast error screen could pass. It now needs a row in the page, and the gate sees one visible.

Of the plan, before building: the bundle runs through an explicit CommonJS wrapper in this context; main passes the path as an argument; the build id comes from the same read as the source; loads in tests run in separate processes, and with same-length sources; the crash switch is independent of the restart policy's count; temp files are the process's own; the bundle runs once, outside the catches; the perf gate waits for the cache and proves it was accepted, and reads the row's time in the page.

## On top of main's AI round two

The same gate after rebasing, whose renderer holds that work too (3.08 MB, 2.9 before), at load 18 to 39: warm samples 832 to 1,308 ms, the best of each of four runs 832, 868, 877 and 986; without a cache 977 to 2,067 ms. That's about 100 ms above the numbers before it, and the gate still passes. What the 100 ms is hasn't been measured: AI round two's own boot work, its code now loading at boot, or the load.
