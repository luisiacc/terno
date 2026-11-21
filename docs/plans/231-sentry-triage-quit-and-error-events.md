# Plan 231: a quit's ends are no crash, and an error event without an error doesn't blame our handler

- **Status:** in progress (fix landed, Codex review next).
- **Builds on:** plan 10 (diagnostics), plan 78 (error reports).
- **Request (verbatim):** "i've had some sentry reports using the prod app myself, see them on https://luisiaccorg.sentry.io/issues/errors-outages/?project=4512346705166336&statsPeriod=14d — use codex subagent to use computer use to get that data, fix all 3 issues if they are a problem, arhive them otherwise"

## 1. The three reports

Read in Sentry by a Codex agent through computer use, then checked against the owner's local logs (copied out of the profile, never read in place) and a rebuild of the reported commit.

### TERNO-4 `BackendExit: backend.exited` and TERNO-5 `RendererGone: renderer.gone` (0.1.1, one event each)

The same moment: `exitCode: 15` (SIGTERM) for both, the renderer's reason `killed`, the same session, `uptime_s: 5639`, 04:11:43 UTC. The owner's `main.jsonl` shows the order:

```
04:11:42.873  net.watch_failed        (the network watcher's child got the signal too)
04:11:43.036  backend.exited          exitCode 15, deliberate false
04:11:43.092  backend.restart_scheduled
04:11:43.583  shutdown.done           trigger quit, durationMs 774   → the quit began at ≈ 42.809
04:11:43.611  app.quit
next app.start 15 hours later
```

The app was already quitting (before-quit ran ≈ 230 ms before the first exit) when every child process got SIGTERM at once: a system restart or logout with Terno open. Main quit cleanly, so there was no unclean-exit record. Nothing broke. The bug is ours: **a child's end during a quit was reported as two fatal crashes**, and main even scheduled the backend's restart. The guard in the restart timer stopped the restart itself.

### TERNO-1 `Error: process.uncaught` (0.1.0, 3 events, 2 users since 2026-10-30)

One frame, `renderer/assets/index-B35c0LZl.js:3:7531`. Rebuilding `b16de6bfd3` gives the same bundle name, and that column is the `Error(e.message || "script error")` in our own `window` error listener (`apps/web/src/lib/diag.ts`). So the `ErrorEvent` carried **no error object**, and the report's only frame is the handler that made the stand-in. In a same-origin app, Chromium fires such an event for:

- the Resize Observer's loop notice. Per the Resize Observer spec (§ "deliver resize loop error notification"), a loop it defers to the next frame is reported as an error event with the message "ResizeObserver loop completed with undelivered notifications." and no error object. Nothing failed. It came right after opening a thread (`nav.thread` 0.3 s before), when the reader's observers settle.
- `throw null` / `throw undefined` and similar non-errors.

We never keep the message, so the report can't say which. The first is by far the likeliest, and it's noise. The second would be a real bug, but the report should say it had no error rather than pointing at our handler.

## 2. Design

- **Main knows it's quitting.** `MainDiagDeps` gets `quitting(): boolean`, wired to `quitState !== "running"` in `app.ts` (the single owner of the quit state: before-quit, the update install, and the move to Applications).
  - `rendererGone` during a quit logs `renderer.gone` at info and records nothing, so nothing is reported. It doesn't reload the window either.
  - The backend's `exit` handler during a quit (after the retirement and mailbox checks, which already handle their own cases) logs `backend.exited` with `deliberate: true` and returns. It sends no record and schedules no restart. `MainDiag.backendExited` checks `deps.quitting()` itself, so the decision lives in one place, and `app.ts` only skips the restart.
- **A window error event without an error** (`lib/diag.ts`, a pure `windowError(e)` beside the listener):
  - Its error is reported as before when it has one.
  - The Resize Observer loop notice (message starting `ResizeObserver loop`, the spec's text) returns null: not reported, not logged.
  - Any other event becomes a stand-in named `ErrorEvent`, with no stack frames, so Sentry titles it `ErrorEvent: process.uncaught` and blames no frame of ours.

## 3. Tests

- `apps/web/src/lib/diag-local.test.ts` (unit, Node): `windowError` returns the event's error; null for both spellings of the Resize Observer notice; for an event without an error, an `ErrorEvent` stand-in with no frames after `normalizeError`.
- `apps/desktop/e2e/diagnostics.smoke.ts` (packaged): a system shutdown, emulated. The test starts a quit, sends SIGTERM to the backend's and the renderer's PIDs while main shuts down, waits for the exit, and checks that the profile's `crashes/` holds no new `backend_exit` or `renderer_gone` record and no unclean-exit marker. Then it relaunches for the tests after it.
- Existing smoke tests keep a renderer crash (`forcefullyCrashRenderer`) and a backend SIGKILL outside a quit reported as before.

## 4. Perf and resources

One boolean read per child exit. Nothing on a hot path.

## 5. Sentry

After the fix lands: TERNO-4 and TERNO-5 resolved (not a crash; our report fixed), TERNO-1 resolved in the next release, so a no-error event that isn't the Resize Observer comes back under its own `ErrorEvent` title.

## 6. Out of scope

- The renderer asks `learning.proposals` on every counts change, and the trails show it every ≈ 12 s while idle (every ≈ 0.7 s during a sync). That is a separate look at why counts change while idle.

## 7. Revisions after the Codex review (plan critique)

Codex made eleven points. Taken:

- The quit check in the backend's `exit` handler comes **before `cache.crashed()`**: a quit isn't a crash, so the bytecode cache stays.
- `childGone` follows the same rule: no `child.gone` record during a quit.
- A renderer that ends during a quit is logged and not reported, but **the reload stays**. If the quit is called off (drafts that won't flush, a deferred install), the window comes back as before, so nothing new has to track windows across a cancelled quit. The ring is deleted in both branches.
- `quitting()` reads the live quit state, which every path sets: before-quit, the update install, and the move to Applications, including their cancellation.
- The Resize Observer notice is matched on its two exact messages, and only when the event carries no error. A real error is reported even when its message reads the same. The plan says this is the likeliest cause of TERNO-1, not a proven one.
- The stand-in is a fresh `Error` named `ErrorEvent`, with an empty stack and **no message** (none of the event's text is carried). Thrown `0`, `false` and `""` stay the event's own error.
- The smoke test takes its baseline from the files already in `crashes/` and reads `main.jsonl` from the quit's start. It requires evidence that the new guard ran (`backend.exited` at info with `deliberate: true`, and `renderer.gone` at info), so a backend that took the retirement path fails the test. It checks for no `backend.restart_scheduled`, that the `diag/running` marker is gone, and, after a relaunch, that there is no `unclean_exit` record.

Not taken:

- Transition tests for each quit path (update deferred or failed, move cancelled). They all set the one quit state that `quitting()` reads, and the smoke test covers the reading.
- Listener-level tests in a DOM. The listener is one line on top of the pure `windowError`.
