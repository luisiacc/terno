# Plan 253: an update's backup is never written before the window opens

- **Status:** shipped (see §§7–8).
- **Builds on:** plan 95 (safe upgrades: the backup before a migration, the mailbox gate), plan 112 (the backup as an APFS clone).
- **Request (verbatim):** "sometimes when doing updates, we are blocking the user from using the app while showing a screen like its loading, i don't like this , under which scenarios do we do this? and can we avoid it and just let the user use the app always normally" — then, after the findings below: "ok lets do that change."

## 1. What exists

- **The cover.** `MailboxCover` (`apps/web/src/components/mailbox-cover.tsx`) shows "Updating your mailbox…" when the backend's `upgrading` gate (the backup, then the migration) lasts past 400 ms. Its other screens (restoring, no room, a newer mailbox, a failed step, a damaged file, a required update) are errors or the user's own action, with no mailbox to show; they stay.
- **Plan 112 made the backup a clone,** and the logs confirm it (`method: "clone"`). Yet the owner's dev profile (1.2 GB mailbox) logged `mailbox.backup_made` at **4.7 s and 7.1 s** on its last two updates, and the window was covered that long.
- **Where the time goes,** measured on a copy of that mailbox (load 3–7):

  | step of `prepareUpgrade` | time |
  |---|---|
  | lock and TRUNCATE checkpoint (worker) | 4 ms |
  | `cp -c` | 3 ms |
  | `PRAGMA journal_mode = DELETE` on the clone (verification) | **1.5–4.8 s** |
  | user_version, page_count, fsync, manifest, rename | < 10 ms |

- **Why:** after `clonefile(2)`, the **first write to either file** pays a one-time cost while APFS splits the extents the two share. The cost grows with fragmentation. The live mailbox, grown page by page and fragmented further by every earlier clone, takes ~2 s (a 2-byte write to the clone: 1.6–2.6 s). A freshly written copy of the same 1.2 GB takes 16–160 ms. Once one side has paid, the other's first write is free (0 ms).
- **Who pays it if the clone isn't written:** migrations write to the WAL, not the main file. So the first write to the mailbox file is its first checkpoint, in the checkpoint worker (`node-driver.ts`).
  - Measured: that checkpoint took 2 s, and **a read on the backend's thread blocked for the same 2 s** (APFS holds the file during the split). Moving the cost there would trade the cover for a freeze.
- **Writing the backup in a worker instead** (the same journal switch, after the window opens):
  - reads of the mailbox were never stalled (≤ 9 ms over 4 runs);
  - the mailbox's first checkpoint afterwards took 2–3 ms;
  - a write on the backend's thread could stall 200–380 ms (2 of 4 runs), only while the WAL file grew (allocation); with the WAL's space already allocated, ≤ 8 ms (4 of 4).
- **Migrations inline:** `migrate()` runs with SQLite's default `wal_autocheckpoint = 1000`. A migration that writes more than 1000 pages (an index on a large table) checkpoints in the backend's thread at its commit, which would pay the split on the critical path again. Only the store's checkpoint worker sets it to 0 (`checkpoint.ts`).

## 2. Design

The backup stays exactly as safe (made, verified and published before the migration). What moves is the one write that pays APFS's cost: it happens to the backup, in a worker, after the window is open, and the mailbox's checkpoints wait for it.

### 2.1 The clone is verified without writing it (`upgrade.ts`)

- On the clone path the copy opens read-only through a `file:` URI with `immutable=1` (`pathToFileURL`, so a profile under "Application Support" works). It checks `user_version` and `page_count` as today. Nothing is written, and nothing appears beside it.
- No journal switch on this path. The published `terno.db` is still in WAL mode (header bytes 18–19 = 2) until it is settled (§2.2). The manifest is unchanged.
- The copy path (backup API) keeps its inline switch to DELETE: its file shares no blocks, so the write is cheap.

### 2.2 The backup is settled in the background (`clone.ts`)

- `backupToSettle(backupsDir)`: the newest generation whose `terno.db` header (bytes 18–19) says WAL, or null. It reads 2 bytes per generation (one generation is kept).
- `settleBackup(file)`: a worker thread (inlined like `LOCK_SOURCE`) opens the file, sets `journal_mode = DELETE` and closes. This is the write that pays the split, off the backend's thread. It resolves with its duration and rejects with the worker's error.
- `cancelClones()` also ends a settle in flight (shutdown). Killing it is safe: the journal switch is one header write; the file stays in WAL mode and is settled at the next start.

### 2.3 The mailbox's checkpoints wait for it

- `startCheckpointWorker(db, intervalMs, hold?)`. With a `hold` promise:
  - the node worker starts without its interval;
  - it gets `"start"` once the hold settles (resolved or rejected) or after **30 s**, whichever is first, so the WAL can never grow without bound;
  - in-thread autocheckpoints stay off meanwhile, as they already are while the worker runs.
- `settle()` (the bulk writers' backpressure) doesn't wait for a held worker below `WAL_HARD_LIMIT` (64 MiB). Past it, it waits for the hold, then for a checkpoint, as today.
- The store takes it as `checkpointWorker: true | { hold: Promise<unknown> }`; `nodeStore` passes it through.

### 2.4 Migrations never checkpoint inline

- `OpenOptions.deferCheckpoints`: `openDatabaseWith` sets `wal_autocheckpoint = 0` before `migrate()`.
- The desktop backend passes it on every open, because the store it hands the db to always runs the checkpoint worker, which owns checkpoints from then on (and turns autocheckpoints back on if it dies).
- Nobody else passes it, so tests, readers and `backend-dev` keep SQLite's default.

### 2.5 The backend wires it (`backend-entry.ts`)

- After `openMailbox`, and before the store is made: `const pending = backupToSettle(backupsDir)`.
  - When there is one, `settleBackup(pending)` starts. Its promise is the store's checkpoint hold.
  - Its outcome is logged: `mailbox.backup_settled { durationMs }`, or `mailbox.backup_settle_failed` (a warning). On failure the hold releases too, and the mailbox's first checkpoint pays the split as it would have.
- Every start checks, not only an upgrade's. So a quit during the settle is finished at the next start; there is usually nothing to do.

### 2.6 Restore reads the backup without writing it (`restore.ts`)

The check of the restored copy opens it with `immutable=1`. A WAL-mode backup then leaves no `-wal` or `-shm` beside the file that's about to become the mailbox.

### 2.7 What the user sees

- An update's first start shows the mailbox like any other start, plus the migration (≤ 1 s at 50k threads). The cover appears only past 400 ms, so on the clone path it essentially never shows.
- The cover still appears:
  - on the copy path (a non-APFS disk, or another program holding the file);
  - for a migration that runs past 400 ms.
- **Left over:** during the ~2 s settle, on a large fragmented mailbox, one write on the backend's thread may stall 200–380 ms while the WAL file grows (measured 2 of 4 runs). Reads are unaffected. That's once per schema change, against a 5–7 s cover today.

## 3. Tests

**Unit (`packages/db/src/upgrade-clone.test.ts`):**
- The clone path never writes the clone:
  - the published `terno.db` still says WAL (bytes 18–19 = 2);
  - its mtime is the one `cp` left;
  - nothing sits beside it;
  - the manifest says `method: "clone"`.
  - Fails without the fix: the journal switch writes the header (it would be 1).
- The copy path still publishes a DELETE-mode file.
- `backupToSettle` finds a WAL-mode generation and ignores a settled one. `settleBackup` turns it to DELETE, leaves nothing beside it, and is a no-op on a settled file. Rejects for a missing file.

**Unit (`packages/db/src/checkpoint.test.ts` or the node-driver suite):**
- With a pending hold, a write's frames stay unchecked past several intervals.
- Once the hold resolves, they're checkpointed. A rejected hold releases too. So does the 30 s bound (an injectable bound in the test).
- `settle()` returns at once under the hard limit while held.

**Unit (`packages/db` open):**
- `deferCheckpoints` leaves `wal_autocheckpoint` at 0 during the migration. A migration step that writes past 1000 pages leaves its frames unchecked (read from the wal-index).
- Without the option, the default stays.

**Unit (`apps/desktop/src/mailbox/restore.test.ts`):** a WAL-mode backup restores, and leaves no `-wal` or `-shm` beside the restoring file.

**Integration (`apps/desktop/src/mailbox/opening.int.test.ts`):** the real entry on an older mailbox:
- the window's gate opens before the backup is settled (`mailbox.backup_settled` after `gate open`);
- the backup ends up in DELETE mode;
- the next start finds nothing to settle.

**Packaged smoke (`mailbox.smoke.ts`):** the existing "an older mailbox is backed up and migrated" case also asserts that the backup is settled (DELETE mode) once the app is ready, and still that the cover never attached.

**Measured, not gated:** a before/after on a temp copy of a large real mailbox one schema behind:
- `mailbox.backup_made` duration;
- `backend.ready` duration;
- the backend's event-loop delay (`monitorEventLoopDelay`) during the settle.

A fragmented fixture big enough to reproduce the ~2 s split takes millions of scattered writes (a 128 MB file with 30k pieces splits in 46 ms), so the stall isn't timed in a test. The order is asserted instead, deterministically.

## 4. Perf and resources

- A start with nothing to migrate gains one `readdir` plus a 2-byte read of the one kept backup.
- One worker thread for ~2 s, once per schema change.
- The WAL may grow for those seconds (bounded by the 30 s hold and the 64 MiB hard limit).

## 5. Out of scope

- **Pre-sizing the WAL** to remove the leftover write stall. SQLite has no API for it, and writing the file ourselves means relying on recovery behaviour we'd have to infer.
- **Defragmenting the mailbox** (a VACUUM rewrites 1.2 GB and holds the writer).
- **Serving the window before the migration:** the app reads the new schema only (plan 112 §5).

## 6. Revisions after the Codex review

These override §§2–5 where they conflict. The critique is in `/tmp/terno-scratch/p253-plan-review.txt`.

1. **An interrupted settle is played back before anything trusts the file** (point 1).
   - SQLite leaves WAL mode through a rollback-journal transaction. A quit or crash mid-settle can leave a hot `terno.db-journal`, even with the header already saying DELETE.
   - `backupToSettle` treats a generation with a `-journal` beside it as unsettled, so the next start's settle opens it normally and SQLite plays the journal back.
   - **Restore** settles an unsettled backup (the same worker) before it clones it. Its check then reads the staged copy with `immutable=1`. Restore already shows its own cover.
2. **The settle runs only on a kept generation, after expiry** (point 2).
   - The store gets the hold as a deferred promise.
   - After `expireBackups`, the backend picks the candidate and starts the settle; with none, the hold releases at once.
   - The worker opens the file as a `file:` URI with `mode=rw`, so a generation removed meanwhile is never recreated.
   - Success means the pragma answered `delete`.
3. **Ordinary migrations leave the legacy body owner** (point 3, the owner's decision).
   - Today `needsLegacyBodyUpgrade` sends every older schema to the exclusive legacy-body worker. That worker's connection is the last one on the file, so its close checkpoints and would pay the split before the window opens.
   - It now routes only mailboxes the conversion is for: older than v45 (the step that adds body parts), or not marked converted (`application_id` other than `BODY_READY_APPLICATION_ID`, which includes the "upgrade pending" id).
   - Every other migration runs in the backend's own open, as before the conversion existed, under `deferCheckpoints`. A mailbox the conversion is for still pays the split in that worker. It's a one-time conversion of years-old mailboxes, already a long step with its own cover.
4. **A pending compaction is left as it is** (point 4). Plan 69's one-time VACUUM rewrites the whole file on the backend's thread and ends with a TRUNCATE checkpoint, which pays the split too. On a start that has one pending it adds ~2 s to a step that already takes many seconds and happens once after removing a storage. The owner's rule (no users yet, no legacy paths) argues against an option just for that coincidence.
5. **Restore's durable checkpoint stays** (point 5). `settleRestored`'s inline FULL checkpoint on a restored clone may pay the split before the store exists. Restore is the user's recovery action; its durability comes first, and it isn't changed here.
6. **Shutdown owns the settle** (point 6).
   - `settleBackup` returns `{ done, stop }`, and the backend keeps it as one owned job. It is no longer in `cancelClones`.
   - A shutdown that closes (both branches, with or without a backend) stops it and waits for the worker to exit before answering "closed". A shutdown deferred for sending ("sending") leaves it running.
   - A worker killed mid-switch leaves at worst a hot journal (revision 1).
7. **One release signal** (point 7). The worker's start, a bulk writer waiting in `settle()` past the hard limit, and `checkpointNow` all wait on the same bounded release. A rejected or hung hold, the bound, `stop()` and the worker's exit all resolve it. Tests cover the over-limit wait and the bound.
8. **The bound is 15 s, and its cost is stated** (point 8).
   - With `synchronous = NORMAL`, WAL commits become durable at a checkpoint. Holding checkpoints widens the power-loss window from about a second to the settle's length (2–5 s measured), at most 15 s.
   - The WAL grows meanwhile by whatever is written, which is unbounded for one huge transaction, as today.
   - `settle()`'s 64 MiB is backpressure, not a cap.
9. **Tests read backups without touching them** (point 9). The clone test's `drafts()`, the entry test's `exactOld()` and the smoke's `facts()` read a published backup with `immutable=1`. The crash-left WAL fixture stays, and its WAL-only draft is followed through publication, settle and restore.
10. **The hold goes through the driver contract** (point 10). `startCheckpointWorker`'s fourth argument is threaded through `SqliteDriver`. A store asked for a worker that gets none (`null`) turns in-thread autocheckpoints back on, so a writer opened with `deferCheckpoints` never runs without checkpoints.
11. **The entry test holds the settle** (point 11).
    - The fixture parks the settle worker's answer. The test asserts the mailbox reaches `ready` while held, releases it, then asserts the backup is settled and that the next start finds nothing.
    - The smoke waits for settlement separately.
    - `mailbox.backup_settled` and `mailbox.backup_settle_failed` go into the diagnostics catalog.

## 7. As shipped

- **`upgrade.ts`:** the clone path verifies through `immutable=1` (`untouchedUri`) and never switches the clone's journal mode. The copy path still does, inline.
- **`backups.ts`:** `unsettled(file)` (WAL header or a `-journal` beside) and `backupToSettle(dir)`. A generation whose size differs from its manifest is kept when a journal beside it can put the size back. Without that, `listBackups` deleted a backup cut short mid-settle.
- **`clone.ts`:** `settleBackup(file)` returns `{ done, stop }`: a worker opens the file as `mode=rw`, plays a journal back, switches to DELETE, and succeeds only when the pragma answers `delete`.
- **Checkpoint hold:**
  - `startCheckpointWorker(db, interval, hold)` through `SqliteDriver`, and the store's `checkpointWorker: { hold }`.
  - One release (the hold settles, its bound, `stop()`, the worker's exit) starts the worker's passes and frees writers waiting past the hard limit.
  - A store asked for a worker that gets none turns autocheckpoints back on.
- **`OpenOptions.deferCheckpoints`:** `wal_autocheckpoint = 0` before `migrate()`.
- **The backend** opens with `deferCheckpoints`, makes the store with a 15 s hold, and runs `startSettle` after `expireBackups`. A shutdown that closes runs `stopSettle()` (the thread gone) before "closed". It logs `mailbox.backup_settled { durationMs }` or captures `mailbox.backup_settle_failed`.
- **The legacy body owner** (`needsLegacyBodyUpgrade`) opens only `version < SCHEMA_VERSION && (version < 45 || application_id ≠ READY)`, or a pending conversion.
- **Restore** settles an unsettled backup before copying it, and checks the staged copy through `immutable=1`.

### Measured

A copy of the owner's dev mailbox (1.17 GB, years of real mail grown page by page, in WAL mode, schema 76 → 77). Same harness each time: `prepareUpgrade`, the open with its migration, the store with its held checkpoints, then 6 s of reads and small writes on the backend's thread while the backup settles. Three runs each, alternating. Load 2.3–4.2.

| | before (the switch inline, as shipped by plan 112) | after |
|---|---|---|
| mailbox ready | 2.7–4.9 s | **53–81 ms** |
| the backup's settle | (on the way) | 4.2–5.7 s, in the background |
| slowest read / write meanwhile | — | 12–14 ms / 9–14 ms |
| longest event-loop delay meanwhile | — | 15–19 ms |

The 200–380 ms write stall the first experiment saw (§1) didn't show here.

## 8. What the Codex code review changed

The review is in `/tmp/terno-scratch/p253-code-review.txt`. Each fix has a regression test that fails without it.

1. **A journal no longer vouches for a missing file** (#1).
   - `readManifest` forgives a size mismatch only for a file that exists, with a journal beside it.
   - A retry's kept generation that a settle left mid-way is played back and checked against its size before the migration runs (`playedBack`). If that fails, it's a backup failure.
   - Tests: a retry after a cut-short settle; a journal beside a removed file.
2. **The settle's write survives a power cut on macOS** (#3): `fullfsync = ON` beside `synchronous = FULL`, so its journal reaches the disk before page 1 does. Not tested: a pragma that only a power cut can show.
3. **Two shutdowns wait for the same settle** (#8). `stopSettle` keeps the stop it started, and a second shutdown awaits it. Test: two shutdowns, a settle thread slow to go, neither "closed" before it has.
4. **A settle with no thread doesn't fail the mailbox** (#9). A synchronous `new Worker` failure is captured as `mailbox.backup_settle_failed`, the hold releases, and the window opens. Test: the entry with the settle's constructor throwing reaches `ready`.
5. **A stopped worker's wal-index reader stays closed** (#10). A writer still waiting never reopens `-shm`. Not tested on its own: one file descriptor, shown only by `lsof`.
6. **The tests prove the wiring** (#11):
   - the entry test checks that the mailbox's main file isn't written for 1.5 s while the settle is held, and is once it's done (fails with the hold removed);
   - the `deferCheckpoints` test checks the order (the pragma before the migration's first `CREATE`);
   - the stop test shows the writer waiting before `stop()`, with no other worker checkpointing.

**Left as they are:**
- **#2:** a retry more than 14 days after a failed first attempt, then a power cut before the first checkpoint, could lose the expired generation. Rare, and older than this series.
- **#4:** restore racing the engine's restart over IPC. Older than this series.
- **#5:** a mailbox in DELETE mode switching to WAL pays the split before `ready`. Only a restored mailbox is in that mode, and restore is the user's recovery action.
- **#6:** a pending conversion whose completion is still only in the WAL routes once more to the owner.
- **#7:** the settle starts during startup. It's a worker, measured with no effect on the backend's thread; the 15 s hold is far beyond a start's milliseconds.
- **#12:** interrupting the WAL-to-DELETE switch itself (the fixture interrupts the transaction after it). SQLite's journal playback is the same either way.
