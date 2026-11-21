# Plan 230: check for updates at launch, and nothing on main's thread waits

- **Status:** shipped.
- **Builds on:** plan 11 (in-app updates), plan 95 (restore from a backup).
- **Request (verbatim):** "when the app is opened by the user, lets check for an update right away as it opens, should be a quick check. also, when i clicked on the 'check for updates' button on settings, the entire ui was blocked while that cehck was running, lets please not do that and just make it work seamlessly, look for similar patterns of things that could block the main thread somehow and make sure they run in the backgroud async."

## 1. What exists

- The first automatic check waited 30 s after launch (`STARTUP_CHECK_DELAY_MS`), so a cold start never paid for it. Then one check every 4 h.
- Every step of a check is already asynchronous: the location probe (`codesign -dv` through `execFile`, `fs.access`), electron-updater's requests through Electron `net`, the download (streamed, sha512 on the stream), and Squirrel.Mac's own verification.

## 2. What was measured (the "UI blocked" report)

The owner's click, from the 0.1.1 log: `update.check` → `update.available` 3 s → `update.downloaded` 128 s → `update.ready` 50 s (Squirrel unzipping and verifying the Developer ID bundle).

- Bare Electron, the real GitHub feed: loading electron-updater and creating the session took ≈ 55–78 ms once (in the shipped bundle electron-updater is part of `main.cjs`, so that part is paid at startup). The check (1–2.4 s) and the full 0.1.2 download (92 s) never stalled main's event loop by more than 56 ms.
- Packaged test build, real Squirrel: check, download and Squirrel's verification (2.2 s together) stalled main's thread by 34 ms at most, and no renderer frame took longer than 100 ms.
- Nothing in the UI is modal while it checks: the pill's popover opens only on a click, and the required-update cover only for a required update.

The update path doesn't block main's thread or the renderer. What the owner saw isn't reproduced. It was 27 s after launch, while the first sync ran. Section 4 lists the remaining synchronous work found in main.

## 3. Design

- **The launch check runs when the backend is first ready** (`UpdateController.backendReady`): the window is up and the mailbox open (about 0.5 s after launch), so the check stays off the cold start's critical path. It runs on a timer, never inside the backend's message handler.
- **The delay becomes a fallback**, cut to 10 s: a backend that never gets ready (a mailbox that won't open, plan 95) still gets its check.
- One launch check per run: a restarted backend doesn't check again, and nor does a backend that gets ready after the fallback has already checked. The 4-hour schedule is unchanged.
- **Test builds** keep their baked delay as the only automatic check (`checkWhenReady: false`), so `update.smoke.ts` still sees no request it didn't ask for.
- The policy is unchanged: manual mode checks and offers; automatic mode also downloads (plans 11, 97).

## 4. Synchronous work in main, audited

- **IPC handlers:** all are `handle`d asynchronously or do constant work: `terno:version` and `terno:diag-info` are `sendSync`, but they answer from memory, and `terno:appearance` writes a few bytes.
- **The restore from a backup (plan 95)** made the copied mailbox durable with `fsyncSync` on main's thread. After a full copy (no APFS clone) of a large mailbox, that flush can take seconds and freeze every window. It is now `FileHandle.sync()`, off the thread. The journal, the marker and the folder fsyncs stay synchronous: they are a few bytes each and ordered with the renames.
- Left as they are:
  - `pending.json` is fsynced synchronously right before Squirrel quits. That is on purpose: it must be on disk first.
  - `install-main.ts`'s `plutil` runs before any window exists.
  - Diagnostics' synchronous writes are for fatal records only.
  - electron-updater runs `sysctl` and `uname` with `execFileSync` at the start of a download, a few ms each, inside the library.

## 5. Tests

- `controller.test.ts`:
  - the check runs at backend ready, on a timer, not inside the call
  - a second ready doesn't check again
  - the next check is the 4-hour one
  - a ready before `start` checks at `start`
  - a ready after the fallback's check doesn't check again
  - a test build waits out its delay
  - the fallback with no backend
- `restore.test.ts`: the copied mailbox is made durable before the journal, and never through the blocking fsync (checked by inode). This test fails on the old code.

## 6. Out of scope

- A perf gate on main's event-loop stalls through a packaged update: it needs two signed builds, and section 2 measured it once by hand.
- Patching electron-updater's `execFileSync` calls.

## 7. What the Codex code review changed

The review is in this session's scratchpad (`codex-review.txt`). It found one issue, and the fix has a regression test.

1. **An install that didn't apply keeps its Try Again on screen.** `backendReady()` shows "not applied". The launch check then ran at once, and its `check-start` cleared that error, so the window never showed it. The 30 s delay had hidden this. Now no launch check runs after a failed install. The first automatic check is the 4-hour one, and the user's Try Again (a manual check) is the retry. The test covers a ready that comes before `start` and one that comes after it.
