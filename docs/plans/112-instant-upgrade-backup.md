# Plan 112: an update never makes you wait for the mailbox backup

- **Status:** shipped (see §7).
- **Builds on:** plan 95 (safe upgrades: the backup before a migration, the mailbox gate), plan 68 (migrations that leave heavy work to background slices).
- **Request (verbatim):** "while updateing a build,spacially for hte final user who is using this, while updating sometimes, for example when doing the backup, we are preventing the user from using the app, i think this is terrible, we must found a way of doing the backup in the background while the user is able to use their email and then the app should just update gracefully, never blocking the user from using the app"

## 1. What exists

- **The order at start** (`apps/desktop/src/backend-entry.ts` → `openMailbox`):
  1. `prepareUpgrade` reads `user_version`.
  2. When a migration is due, it copies the whole mailbox with SQLite's backup API, 256 pages a step (`packages/db/src/upgrade.ts`).
  3. The copy is verified, fsynced and published as a generation in `backups/`.
  4. `openDatabase` migrates.
  5. Only then does the backend serve the window.

  While steps 2–4 run the window shows the `upgrading` cover ("Updating your mailbox…", after 400 ms). The copy is linear in the mailbox's size: a few seconds per GB, much longer on a slow disk. That is the wait the user describes.
- **Why plan 95 rejected a clone:** the Codex review (its points 1 and 5) said a checkpoint followed by a file copy isn't consistent while any other connection or the checkpoint worker can write, and that `COPYFILE_FICLONE` may fall back silently to a full copy. Both are true as stated.
- **Measured on this Mac (APFS, Node 24):**
  - Node's `copyFileSync(…, COPYFILE_FICLONE)` doesn't clone on macOS (libuv uses a plain copy): 8–20 s for 2 GB. `COPYFILE_FICLONE_FORCE` gives ENOSYS.
  - `/bin/cp -c` (clonefile(2)) clones 2 GB in 30 ms.
- **Migrations:** plan 68 set the rule that a migration changes shape only and leaves data work to `rebuildFolders`' background slices. Its perf gate covers v24 (≤ 1 s at 50,000 threads). Plan 105's v41 follows the same pattern (`view_unread_backfill`). No gate covers the rest.

## 2. Design

The app can't run on an old schema, so the time between start and a usable window is backup plus migration. This plan brings the backup to near zero and holds every migration to a budget, so an update's first start feels like any other start. The cover stays as a rare fallback, not the normal path.

### 2.1 An instant, consistent backup (APFS)

`prepareUpgrade` gains a clone path, tried first when a backup is due:

1. **Same APFS volume.** The folder holding the mailbox is APFS (`statfsSync(dir).type === 26`, `vfs.apfs`) and `backups/` is on the same device (`st_dev` of the mailbox's folder equals that of `backups/`, created first). Otherwise use today's backup API path.
2. **Sole ownership.** Open a read-write `DatabaseSync` with `busy_timeout = 0` and `locking_mode = EXCLUSIVE`, then `BEGIN EXCLUSIVE; COMMIT`. In WAL mode this takes the file's exclusive lock and keeps it until the connection closes.
   - No other connection (reader, writer, checkpoint worker or external tool) can then read or write. One that was already open makes the lock fail with SQLITE_BUSY, and the path falls back to the backup API, whose snapshot stays consistent whatever others do.
   - Measured: an open idle connection and an open reader both block the lock; with the lock held, another connection's read gets "database is locked".
3. **One self-contained file.** `PRAGMA wal_checkpoint(TRUNCATE)` must return `busy = 0`, and the `-wal` file must then be 0 bytes (or absent). Otherwise fall back. The main file now holds every commit, and nobody can add one.
4. **Clone.** `execFile("/bin/cp", ["-c", mailbox, partial/terno.db])`. It runs asynchronously, so the event loop keeps answering (a quit stays possible).
   - `cp -c` falls back to a plain copy where a clone is impossible. The same-APFS-volume check makes that unlikely; the duration is logged (`mailbox.backup_made { method: "clone", durationMs }`), so a regression shows up.
5. **Verify and publish, as today.** Open the copy, set `journal_mode = DELETE` (so it is one file with no `-wal`), and check that `user_version` and `page_count` equal what was read under the lock. Then fsync the file and the manifest, rename the generation into place, fsync `backups/`, and remove older generations.
   - The manifest gains `method: "clone" | "copy"` for diagnostics. Readers ignore unknown keys, so older and newer builds read each other's manifests.
6. **Release** the lock (close the connection) before `openDatabase`, in a `finally`. Failures after the lock map to the same typed errors as today: a partial folder is removed, and the mailbox is never written (the checkpoint only moves committed pages into the main file).

**Room:** a clone costs no space when made. Its blocks diverge as the original changes later, up to the mailbox's size by the time it expires (14 days). The pre-flight therefore asks only for the migration's headroom (`migrateHeadroom(size)`) on the clone path, and today's `size + wal + headroom` on the copy path. A real ENOSPC or SQLITE_FULL is still caught and said the same way.

**The cover:** on the clone path the backend doesn't send `upgrading/backup` (it would never be seen: the 400 ms delay outlasts the clone). The copy fallback keeps today's cover and wording.

### 2.2 Every migration within a budget

- **A perf gate for every recent migration** (`packages/db/src/migrations.perf.test.ts`). One 50,000-thread mailbox is seeded once. For each of the last eight schema versions *v*, a copy is written at *v − 1* (`writeLegacyCopy`), then timed through `openDatabase`. Each step stays ≤ 1 s (the plan-68 budget, times the perf multiplier).
  - A new migration that rewrites data inline fails the gate. Its author moves the data work to a background backfill, as v24 and v41 do.
- **The rule, written down:** AGENTS.md gains one line under Performance. A migration changes shape only; data work goes to the backend's background slices; the gate checks it.

### 2.3 What the user sees

On an APFS Mac (every supported macOS keeps the profile on the APFS system volume) an update's first start shows the mailbox like any other start: the clone takes milliseconds and the migration is under a second at 50,000 threads. The cover appears only on the fallback path (a profile on a non-APFS disk, or another program holding the file) or on a mailbox far past the gate's size, and its words stay as plan 95 wrote them.

## 3. Tests

**Unit (`packages/db/src/upgrade.test.ts`, real temp files on the test machine's APFS):**
- An older mailbox with commits only in the WAL (`wal_autocheckpoint = 0`, a connection kept open while writing and then closed without a checkpoint is simulated by copying the `-wal` aside and back) gets a clone backup: `method: "clone"`, the WAL folded in, every row and the old `user_version` in the copy, no `-wal` beside the copy.
- A second connection open on the mailbox (reader, or idle) makes the clone path step aside: the backup is made by the backup API (`method: "copy"`), and the reader is never disturbed.
- A non-APFS answer from the `volume` seam goes straight to the copy path. A different device for `backups/` also does.
- `cp` failing (the `clone` seam throws ENOSPC, EACCES or a generic error) leaves no partial folder, keeps the mailbox's logical contents, and reports `no-room`, `unwritable` or `failed`. The lock is released: a fresh connection can write right after.
- The lock is released on every path (the next `openDatabase` succeeds), including a verification failure.
- The room check on the clone path asks for the migration's headroom only; on the copy path for the full size.
- The clone path never sends `onBackup`; the copy path still does.
- The existing plan-95 tests keep passing on both paths (the copy path forced through the `volume` seam where they test it).

**Real volumes (`upgrade.volumes.int.test.ts`, macOS, hdiutil):**
- APFS: a 512 MB mailbox backed up by clone in under 1 s, with free space dropping by less than 16 MB. The copy opens at the old version after the original migrated, with its rows.
- HFS+: the copy path is taken (`method: "copy"`), as today.

**Perf (`migrations.perf.test.ts`):** each of the last eight migrations at 50,000 threads within 1 s.

**Packaged smoke (`mailbox.smoke.ts`):** the existing "an older mailbox is backed up and migrated" case asserts `method: "clone"` in the manifest and that the window reaches the mailbox without the `upgrading` cover ever showing.

## 4. Perf and resources

- A start with nothing to migrate is unchanged: one `readdir`, one read-only `user_version`.
- The clone path adds one `statfs`, two `stat`s, an exclusive lock, a TRUNCATE checkpoint (bounded by the WAL, which the checkpoint worker keeps small) and one `cp` spawn, once per schema change.
- Disk: a clone is free when made and grows only as the mailbox changes, within the existing one-generation, 14-day bound.

## 5. Out of scope

- **A backup made by the old app before the restart** (in the background while the user works) for profiles on non-APFS disks. The old app can't know the new schema, a backup taken minutes earlier would miss what arrived since, and every supported Mac keeps the profile on APFS. Recorded as a follow-up if a non-APFS case shows up in diagnostics (`method: "copy"` with a long `durationMs`).
- **Serving the mailbox while a migration runs.** The app reads the new schema only; the migration budget makes this unnecessary.
- **Web:** IndexedDB's upgrade is one atomic transaction with no backup, and OPFS SQLite migrates step by step; neither has a backup to wait for.

## 6. Revisions after the Codex review

These override §§2–5 where they conflict. The full critique is in `/tmp/terno-p112/plan-review.txt`.

1. **The lock and the checkpoint run in a worker thread** (points 1, 4, 5).
   - A `worker_threads` worker (the pattern of `checkpoint.ts`) opens the mailbox. It sets `busy_timeout = 0`, `checkpoint_fullfsync = ON` and `locking_mode = EXCLUSIVE` before the connection's first access, then `BEGIN EXCLUSIVE; COMMIT` and the TRUNCATE checkpoint.
   - It reports `{ version, pages }` and holds the lock until told to release. A crash-left WAL of any size is checkpointed off the backend's event loop, which keeps answering main.
   - **Locks die with the process.** The worker lives inside the backend process, so the lock goes when the process does. The `cp` child is killed on `shutdown` and on process exit.
   - **Shutdown waits for preparation.** `shutdown()` during preparation now waits for it to end (or end early) before it answers "closed".
   - **Tests for every locking state:** a separate process holding an untouched handle, a finished read, an open read transaction, a writer, and a checkpoint worker. Each one makes the clone path step aside. The live `-shm` is never removed.
2. **A copy that wasn't a clone is caught** (points 2, 12).
   - `cp -c` may fall back to a full copy, so free space is read before and after. If it dropped by more than half the file, the result is recorded as `method: "copy"` and the room check runs again with the full accounting. A shortfall is then `NoRoomError("migrate")`, the existing screen.
   - **Restore clones as well.** It copies with the same `cloneFile` helper (`cp -c`) when the backup and the mailbox share an APFS volume, and asks only for 64 MiB there. Otherwise the full `size + 64 MiB` check and the Node copy apply. Node's `COPYFILE_FICLONE` copies in full on macOS, so it is no longer used anywhere.
3. **`cp` failures are classified from what `cp` reports** (point 3). The helper maps exit status and stderr ("No space left on device", "Permission denied", "Read-only file system") to `ENOSPC`, `EACCES` or `EROFS` errors before `prepareUpgrade`'s classifier sees them. The tests run the real `/bin/cp` against a full HFS+ image and a read-only destination, besides the seam.
4. **Durability** (points 6, 7). The worker's connection uses `checkpoint_fullfsync = ON`, as the driver's do. A newly created `backups/` is fsynced together with its parent folder before anything is published into it.
5. **The WAL fixture is real** (point 8). A child process writes with `wal_autocheckpoint = 0` and exits with `process.exit` without closing SQLite, so its commits live only in the `-wal`, beside a leftover `-shm`. The clone holds every row; the published generation holds only `terno.db` and `manifest.json`.
6. **The migration gate times each step on its own** (point 9).
   - For every migration from v25 on (plan 68's own test covers v24), a copy is written at *v − 1*, and only step *v*'s SQL is timed, in its transaction. Each step stays ≤ 1 s.
   - Separately, the whole upgrade from v25 to today, through `openDatabase` (which adds `optimize`), stays ≤ 3 s.
7. **The fixture's limits are recorded, not widened** (point 10). The dataset is the standard 50,000-thread mock (four accounts, labels, folders, bodies). Tables it doesn't fill (filters, reminders, scheduled sends) are small per user by nature. `writeLegacyCopy`'s derived tallies are only timed here, never asserted.
8. **The backup screen is still reported** (point 11).
   - `onBackup` fires on both paths, so a slow checkpoint or clone shows the cover after the usual 400 ms; a fast one never does.
   - The smoke installs a `MutationObserver` before the window loads and asserts that `mailbox-gate` never attached.

## 7. As shipped

- **The clone** (`packages/db/src/clone.ts`):
  - A worker thread takes the exclusive lock (locking mode set before the first access, `checkpoint_fullfsync` on) and runs the TRUNCATE checkpoint. It answers `{ version, pages }`, or `null` when another connection has the file, and holds the lock until released.
  - `/bin/cp -c` makes the clone. `cp` refuses `-c` together with `-X`, so the copy keeps the mailbox's (empty) extended attributes.
  - cp's stderr is mapped to `ENOSPC`, `EACCES` or `EROFS`. A `cp` in flight is killed by `cancelClones()` (the backend's shutdown), at process exit, and on SIGTERM (main's retirement), after which SIGTERM ends the process as before.
- **`prepareUpgrade`:**
  - It tries the clone on one APFS volume. The free space read before and after the clone tells a clone from a full copy.
  - Another connection, another volume or a full copy that leaves less than the migration's room fall back to plan 95's path, or say no-room with the space measured once the copy is gone.
  - The manifest records `method`, and `backups/` is fsynced with its parent when it is new.
- **Restore** clones on the backup's own APFS volume, asks only for the 64 MiB margin there, and checks the margin again after the copy.
- **The backend** logs `mailbox.backup_made { method, durationMs }`. A shutdown during the backup ends it, waits, and keeps the mailbox from opening after (`mailbox/preparing.ts`).
- **The rule** is in AGENTS.md: a migration changes shape only, ≤ 1 s at 50k threads.

### Measured

- **Before:** the dev profile `/tmp/terno-1` logged `mailbox.backup_made` at 19.2 s and 13.2 s on its last two updates. The window was covered for that long.
- **Now:**
  - A 200 MB mailbox on a real APFS image is cloned in under 1 s, with free space moving by less than 16 MB.
  - The packaged app upgrades a ~200 MB mailbox in under 400 ms of backup, and the cover never shows.
- **Migrations at 50,000 threads, each on its own:** v25–v43 take 0–44 ms (v30 is the largest), and the whole way from v24 through `openDatabase` takes 100 ms.

### Verification

- **Unit:**
  - `upgrade-clone.test.ts` (21): a WAL left by a process that died, other processes holding the file in every state, room on both paths, a full copy detected, failures by errno, the real `cp` into a folder it can't write, verification, cp's words, and SIGTERM taking `cp` with it.
  - `upgrade.test.ts` (16) on the copy path.
  - `restore.test.ts` (+3).
  - `preparing.test.ts` (3).
- **Real volumes** (`upgrade.volumes.int.test.ts`, 8): the clone on APFS, the copy on HFS+, and the real `cp` filling an HFS+ disk. The suite now has a 180 s timeout: hdiutil took more than 5 s per image on a busy machine, which made the plan-95 cases time out before this change too.
- **Perf:** `migrations.perf.test.ts`.
- **Packaged:**
  - `mailbox.smoke.ts`: 5 of 5.
  - The full desktop smoke: 71 of 72. `update.smoke.ts`' "saved renderer ACK … active-send drain" failed once and passed on its own, the same flake as plan 107's run.

## 8. What the Codex code review changed

The review is in `/tmp/terno-p112/code-review.txt`. Each fix has a regression test that fails without it.

1. A shutdown during the backup no longer answers "closed" while the open goes on: it waits for the backup, and the mailbox isn't opened after (`Preparation`).
2. Main's SIGTERM retirement no longer leaves `cp` running: a SIGTERM handler, present only while a `cp` runs, kills it first.
3. Restore checks its margin again after a `cp` that copied in full, before anything moves.
4. A full copy that left too little room reports the space free once the copy is gone, so Update Without a Backup is offered when the migration alone fits.
5. The smoke asserts the logged backup time is under the cover's 400 ms, besides watching for the cover.

## 9. Mail during an upgrade

- **Request (verbatim):** "make sure after restarting for an update that has migrations, the app still polls for new messages, maybe even during the migration being run, or at least it handles that gracefully, i wouldn't want a migration that touches the threads of emails broken midway because the migration is midawy and new messages came in, we need to handle that gracefully."
- **The migration can't meet new mail.** It runs at open (`openDatabase` → `migrate`), before the backend exists: nothing syncs until it ends. Each step is one transaction, so a quit or a crash leaves the file at the last whole step. Mail that arrives meanwhile waits on the server and comes in with the first pass after (§7: 100 ms for the whole way from v24 at 50,000 threads).
- **What overlaps with sync is the upgrade's background work.** Examples are v24's folder memberships, v41's Archive and Spam unread and plan 17's facts. `start()` schedules it without waiting (`void this.rebuildFolders()`), then starts every account's sync, push and poll. Each slice is its own transaction on the one writer, so a slice and a sync write never interleave inside each other. The triggers count only what the slices have passed, so nothing is counted twice or missed.
- **Tested end to end** (`packages/backend/src/upgrade-sync.int.test.ts`, real IMAP server with IDLE):
  - A v40 mailbox of 1,000 conversations opens and migrates, and the backfill is held after its first slice.
  - Meanwhile, new mail arrives in the Inbox, Archive and Junk, and archived mail is marked read and unread on both sides of the slice's cursor. All of it syncs while the backfill is still midway.
  - Released, the backfill ends with Archive and Spam unread and every folder's unread equal to a recount from the conversations, and with the expected totals.
  - With the trigger's cursor check removed (double counting), the test fails.
- **Found while writing it (not this plan's):** a message another mail app moves from the Inbox to the Archive loses its Inbox location at the next sync, but its new Archive copy isn't attached. The conversation stays in the Inbox with no location. This happens with or without an upgrade, by the server's own move and by an IMAP MOVE alike. Left out of this test, and reported separately.
