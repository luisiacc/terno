# Plan 95: safe upgrades: a backup before migrating, a clear screen when the mailbox can't open, and required updates

- **Status:** shipped (see §7, as shipped).
- **Builds on:** plan 11 (in-app updates), plan 10 (diagnostics), plan 69 (compaction's free-space check).
- **Request (verbatim):** "do we currently have everything set up to make releases and updates? also, do we have things set up so if there are changes in the db each client will gracefully update when they download an update, and have mechanisms if they fail, also if we force the user to update the app, we need to provide a button to clearly do that." Then: "yes do that, do have into account possibility of failiures during doing the backup like disk space and other things similar, after that, start implementing them and have tests for them, realtest for real scenarios and possible edge cases."

## 1. What exists

- **Migrations** (`packages/db/src/migrations.ts`): an ordered list. Each step runs in its own transaction and sets `user_version`, so a failure rolls back that step and leaves the file at the last good version. A file newer than the app throws "…newer than this app. Update Terno."
- **Opening** happens in the backend utility process (`backend-entry.ts` → `new Backend({ dbPath })` → `openDatabase`). Any init error goes to `die("backend.init_failed")`. Main restarts the backend after 0.5, 1, 2, 4 and 8 s, then marks the engine `stopped`, and the window shows the generic "The mail engine stopped" (Try Again, Export diagnostics).
- **No backup** is made before migrating. Squirrel keeps no copy of the old app.
- **Local mode** reaches main only through the backend's `policy` message. Until that arrives main fails closed (local mode on), so automatic update checks never run while the mailbox can't open.
- **Updates** (plan 11): the `UpdateController` reducer, manual grants that work in local mode, the pill and popover, and Squirrel's install with a coordinated shutdown. Required updates were explicitly out of scope.
- **Web:** the worker already maps "newer than this app" to `SCHEMA_NEWER` and shows a Reload screen; IndexedDB upgrades are one atomic `versionchange` transaction.

## 2. Design

### 2.1 The mailbox gate (desktop)

This is a new state for "the mailbox can't open yet", owned by main and pushed to every window, the way the update state is. The type lives in `packages/core/src/mailbox/gate.ts`:

```ts
type MailboxGate =
  | { kind: "open" }
  | { kind: "upgrading"; phase: "backup" | "migrate"; from: number; to: number }
  | { kind: "no-room"; stage: "backup" | "migrate"; needBytes: number; freeBytes: number; canSkipBackup: boolean }
  | { kind: "failed"; reason: "migration" | "corrupt" | "unwritable" | "backup"; step: number | null; backup: BackupInfo | null }
  | { kind: "newer"; schema: number; supported: number }
  | { kind: "restoring" }
```

- **The backend reports it.** At init the backend sends `{ type: "gate", gate }` before it opens anything heavy, then `ready` (or a classified failure). A classified failure is sent as `{ type: "open-failed", gate }` before the process exits.
- **No restarts for a classified failure.** Main does not restart the backend after one: retrying a deterministic failure five times only delays the screen. The engine goes straight to `stopped`, and the gate explains why. An unclassified crash keeps today's restart policy.
- **The window** shows a full-window screen for every kind except `open` (`MailboxGateScreen`, lazy-loaded). It is calm, one primary action, with plain words for what happened and what to do:
  - `upgrading`: "Updating your mailbox…" with "Making a backup first" or "This can take a minute on a large mailbox". There is no button; it only shows after 400 ms so a quick upgrade never flashes it.
  - `no-room`: "Terno needs {need} free to update your mailbox" and "Free up space on this Mac, then try again. {free} is free now." Primary: Try Again. Secondary (only for the backup stage, when the migration itself fits): "Update Without a Backup", with a line saying the update is still safe step by step, but there'd be no copy to go back to.
  - `failed` / `migration`: "Terno couldn't update your mailbox" and "Your mail is safe: nothing was changed beyond the last step that finished. A newer version of Terno may fix this." Primary: Check for Updates (the update flow of §2.3, inline). Secondary: Try Again, and Export Diagnostics.
  - `failed` / `corrupt`: "Your mailbox file is damaged". When a backup exists: "Restore the copy from {date}". Restoring keeps everything up to that copy; mail since then downloads again from your accounts, and drafts and settings changed since then are lost (said in the confirmation). Without a backup: Export Diagnostics and Try Again.
  - `failed` / `unwritable`: "Terno can't write to its folder" with the folder's path and "Check that your disk isn't full or read-only". Try Again.
  - `failed` / `backup`: "Terno couldn't back up your mailbox before updating it" with Try Again and Update Without a Backup.
  - `newer`: "This mailbox was opened by a newer version of Terno" and "Update Terno to keep using it." Primary: Update Terno (the update flow of §2.3).
  - `restoring`: "Restoring your mailbox…".
- **Drafts:** the gate never covers unsaved work. A window that has unsaved drafts reaches the gate only after the backend failed, and drafts autosave through the backend, so the existing draft-recovery review keeps precedence (the same rule `EngineStopped` follows).

### 2.2 The backup before a migration (`packages/db/src/upgrade.ts`, Node only)

`prepareUpgrade(path, o)` runs in the backend before `openDatabase`:

1. **No file:** a fresh install has nothing to back up.
2. **Read the version.** Open the file without migrating and read `PRAGMA user_version`.
   - Equal to the app's schema: close it, nothing to do (the common start costs one open and one pragma, measured).
   - Newer than the app: throw a typed `SchemaNewerError { schema, supported }`; its message keeps the "newer than this app" words the web worker matches.
   - Older: continue.
3. **Make the file self-contained.** Run `wal_checkpoint(TRUNCATE)` so the main file holds every commit. If a reader blocks the checkpoint (busy), copy the WAL alongside instead: with no writer, the main file and its WAL together are a consistent snapshot.
4. **Keep the first backup of this upgrade.** If `backups/` already holds a valid backup made for this same target schema, don't make another. A retry after a migration failed halfway would otherwise replace the pristine copy with a half-migrated one.
5. **Check the room.**
   - `need = copyBytes + migrateHeadroom`, where `migrateHeadroom = 64 MiB + size / 4`.
   - `copyBytes` is 0 when the volume clones files (APFS: `statfs().type`). A clone shares blocks until either copy changes, so it is instant and free at first.
   - Too little room gives a typed `NoRoomError { stage, need, free, canSkipBackup }`. `canSkipBackup` is true when `free ≥ migrateHeadroom`.
   - The estimate is only a pre-flight: an actual ENOSPC or SQLITE_FULL later is caught and reported the same way.
6. **Copy.**
   - Copy with `copyFileSync(…, COPYFILE_FICLONE)` (a clone, or a full copy when the volume can't) into `backups/terno-v<from>.db.partial`.
   - Verify it: its size equals the source's, and it opens read-only with the same `user_version` and `quick_check` on the header page (`PRAGMA quick_check(1)`, bounded).
   - fsync it, rename it to `terno-v<from>.db`, then write its manifest `terno-v<from>.json` (`{ fromSchema, toSchema, appVersion, size, createdAt, cloned }`) through a temp file and rename.
   - The manifest is written last, so a backup without one is never trusted.
7. **Any error while copying** (ENOSPC, EIO, EACCES, EROFS, EPERM, a check that fails) removes the partial file and reports a typed `BackupError { kind: "no-room" | "unwritable" | "failed" }`. The mailbox itself is untouched: copying never writes to it.
8. **Bounded disk.**
   - Only the newest backup is kept; a new one replaces the old only after it is complete.
   - Stray `.partial` files from a crash are removed at the next start.
   - A backup is deleted 14 days after it was made, once a later start opened the upgraded mailbox; the check runs at start, with no timer.
   - The `terno.db.before-restore` copy of §2.4 follows the same 14 days.
9. **Skipping the backup** happens only once, when the user chose "Update Without a Backup". Main passes `{ skipBackup: true }` in the next `init` and only that one.

Then `openDatabase` migrates as today. `migrate` gains classified errors:
- a failing step throws `MigrationError { step, name, cause }`
- SQLITE_FULL (13) or an ENOSPC cause becomes `NoRoomError { stage: "migrate" }`
- SQLITE_CORRUPT (11) or SQLITE_NOTADB (26) becomes `CorruptError`
- SQLITE_READONLY (8), SQLITE_CANTOPEN (14) or SQLITE_IOERR with EACCES becomes `UnwritableError`

The step's transaction rolls back as before.

The backend posts `gate: upgrading/backup` before copying and `gate: upgrading/migrate` before migrating, only when there is something to migrate.

### 2.3 Required updates

- **The feed.** `release.mjs` writes `minimumVersion: x.y.z` into the channel file (`latest-mac.yml`) when `TERNO_MINIMUM_VERSION` is set, or when the release's `apps/desktop/release-policy.json` says so. electron-updater keeps unknown keys in `updateInfo`. The yml is fetched over the same HTTPS path as the update and pins the zip's sha512, so it is as trusted as the update itself.
- **The state.** `UpdateInfo` gains `minimum: string | null`. The reducer adds `required: string | null` to `UpdateState`, set when a check finds `current < minimum`.
  - It is persisted in `updates/prefs.json` (`requiredMinimum`), so quitting doesn't escape it.
  - It is cleared at start when the running version is at or past it, or when a check's feed no longer asks for it.
- **The screen.** `RequiredUpdateScreen` covers the window with "Update Terno to keep going", "This version ({current}) is no longer supported. Terno {version} is ready to install." and the release notes collapsed.
  - **The one button: "Update Terno".** One click is the whole flow: a manual check (if needed), a manual download with a progress bar, then the install (the coordinated shutdown and the restart).
  - Errors keep the button as Try Again and show the reason. A send in flight shows "Waiting for a message to finish sending…".
  - **Can't update itself** (unsigned, run from the DMG, translocated, and so on): the button becomes "Download Terno", which opens the release page, and the text says to move Terno to Applications.
  - Quitting stays possible (⌘Q).
- **While blocked**, the backend keeps running so autosaved drafts and an outbox in flight finish; only the UI is covered. The ⌘K, menu and Settings routes into the app are covered too.
- **Local mode.** It still means no automatic checks, so a required update is learned only from a check the user makes or that runs outside local mode. Privacy wins over enforcement, and plan 11's wording already discloses that checks go to GitHub. The `newer` gate uses the same button.
- **Web:** a tab always runs the newest deployment after its next load, and a tab on an older build than its worker already gets `BUILD_MISMATCH`. Nothing new.

### 2.4 Restore (desktop)

`restoreBackup()` runs in main, only while the backend is stopped (after the gate failed, or after the coordinated shutdown from Settings):

1. Check the room: the backup's size plus 64 MiB, or less when cloning.
2. Move `terno.db` (and its `-wal` and `-shm`) aside to `terno.db.before-restore`, replacing an older one.
3. Copy the backup into `terno.db.partial`, verify it, and rename it into place.
4. Start the backend. It migrates the restored copy again, making no new backup because the manifest is for this target.
5. On any failure, put `before-restore` back and report it, so the mailbox is never left missing.

It is offered:
- on the `corrupt` gate
- in Settings → General → Updates, desktop only, when a backup exists: "Mailbox backup from before Terno {version} · {date} · Restore…", with a confirmation that says what's lost

### 2.5 After an update whose migration fails

`UpdateController.backendFailed(gate)`: if `updates/pending.json` names the running version as `to`, log `update.applied` and capture `update.migration_failed { fromVersion, toVersion, step }` (unexpected), so the failure is tied to the release that caused it.

## 3. Tests

**Unit (packages/db, real temp files):**
- `prepareUpgrade`:
  - fresh install, current, older, newer
  - a backup made, verified and manifested
  - a retry keeps the first backup
  - stray `.partial` files removed
  - a busy checkpoint copies the WAL too
  - retention after 14 days
  - an injected copy failure for each errno (ENOSPC, EIO, EACCES, EROFS) leaves no partial file and the mailbox byte-identical
  - the room estimate for clone and copy
- `migrate` classification:
  - a step that fails on a conflicting table gives `MigrationError` at that step, with `user_version` at the previous step
  - SQLITE_FULL through a `max_page_count` limit (a real full database, no mock) gives `NoRoomError`
  - a file of garbage gives `CorruptError`
  - a read-only file gives `UnwritableError`

**Integration on real volumes (`*.int.test.ts`, macOS, skipped elsewhere with a reason):**
- a small HFS+ disk image (`hdiutil`, no clones), mounted and filled:
  - a backup that doesn't fit reports `no-room` and leaves the mailbox intact
  - a backup that fits but leaves no room for the migration reports that
- an APFS image: the backup is a clone (free space barely moves), then a migration that fills the disk rolls back with `user_version` unchanged
- read-only: `hdiutil attach -readonly` gives `unwritable`

**Desktop unit:**
- main's gate handling: no restarts for classified failures, retry, skip-backup is a one-shot
- restore, with every failure point rolling back
- the controller: required from the feed, persisted, cleared, and `backendFailed`

**Core:** the reducer cases for `required`.

**e2e (web fixture with the stand-in main):** every gate kind and the required screen, in light and dark with axe:
- one button each, focus on it
- the skip-backup confirmation
- the restore confirmation
- the required flow from Update Terno to progress, error and Try Again
- the unsupported variant
- drafts review taking precedence

**Packaged smoke (real app, temp profile):**
- an old-schema mailbox (built from the migrations up to v37, with rows) opens; a backup with its manifest exists; the threads survive
- a mailbox at `SCHEMA_VERSION + 1` shows the `newer` screen with no restart loop (the log shows one `backend.started`)
- a mailbox whose next migration conflicts shows "couldn't update"; Try Again shows it again; the file stays at the previous version
- a profile on a nearly full HFS+ image shows `no-room`; Update Without a Backup migrates
- `update.smoke.ts`: a feed whose yml says `minimumVersion: 0.1.1` blocks 0.1.0 with the required screen; Update Terno downloads, installs and relaunches into 0.1.1, which isn't blocked

## 4. Perf and resources

- **A normal start** adds one read of `user_version` on a connection that's then closed, with no copy, no statfs and no spawn (asserted in a test). The backup sweep is one `readdir` of `backups/`.
- **A clone** makes the backup O(1) on APFS. A full copy runs only on non-APFS volumes, before the backend serves anything, with the upgrading screen shown.
- **The gate screens** are lazy-loaded, out of the entry chunk.

## 5. Out of scope

- A binary rollback to the previous app: Squirrel keeps none, and a fix ships as a newer release.
- Backups of the web stores: IndexedDB's upgrade is atomic, and OPFS SQLite uses the same per-step migrations.
- Staged rollouts, and a grace period before a required update.
- A Developer ID certificate and notarization, which are a purchase rather than code.

## 6. Revisions after the Codex review

These override §§2–5 where they conflict. The full critique is in `/tmp/terno-p95/plan-review.txt`.

1. **SQLite's backup API, not a file copy** (points 1, 2, 6).
   - `node:sqlite`'s `backup(db, dest, { rate })` (available in Electron 45's Node 24.22) writes a self-contained, consistent snapshot, the WAL's commits included, however other connections behave.
   - It copies in steps of 256 pages and yields between them, so the backend's event loop keeps answering (a quit during a backup closes it at once, leaving only a partial file that the next start removes).
   - There is no clone. The cost is the mailbox's size in disk and a few seconds on a large mailbox, once per schema change, behind the "Updating your mailbox…" screen.
   - Verification is the copy opening read-only with the expected `user_version` and `page_count`; the API guarantees the rest. There is no `quick_check` (it's O(N)).
   - The tests compare logical contents (rows and `user_version`), never bytes.
2. **Backups are immutable generations** (point 3). Each one is `backups/<createdAt>-v<from>-v<to>/`, holding `terno.db` and `manifest.json`.
   - It is built in a `.partial-<id>` folder; the database and the manifest are fsynced, then the folder is renamed into place and the parent folder fsynced.
   - Only after that is the previous generation deleted. A folder without a valid manifest that names its own file and size is ignored, and removed at start.
   - "Keep the first backup of this upgrade" means: a generation whose `to` equals this app's schema already exists.
3. **Restore is journaled and reconciled at start** (point 4).
   1. The copy is prepared and verified as `terno.db.restoring` first.
   2. `restore.json` (`{ phase: "swap", generation }`) is written and fsynced.
   3. The live `terno.db` (with its `-wal` and `-shm`) is renamed to `terno.db.before-restore`, `terno.db.restoring` is renamed into place, and the journal is removed.
   4. Before every backend start, main reconciles a leftover journal:
      - with `terno.db` missing and `before-restore` present, it puts the original back (`-wal` included)
      - with the new file in place, it finishes by removing the journal
   - The `-shm` is never carried over (SQLite rebuilds it).
4. **The free-space estimate is honest** (point 5).
   - A backup needs `size + wal`. The migration's headroom is `64 MiB + size / 2`, and Settings, the UI and the code call it an estimate.
   - `canSkipBackup` only means the backup is what doesn't fit, never that the migration will fit. A real SQLITE_FULL or ENOSPC is caught and shown the same way.
   - No clone means no APFS special case.
5. **Errors keep their identity across the whole open** (point 7).
   - `Db.tx` rolls back only while SQLite still has a transaction open, and a failing ROLLBACK never replaces the original error.
   - `openDatabaseWith` closes the connection when anything after the open throws.
   - Classification looks at the whole open (pragmas, the version read, migrations, `optimize`, lease cleanup, compaction) through `errcode` (primary code `& 0xff`) and `cause.code`, in one function, `classifyOpenError`.
   - The tests include a real SQLITE_FULL during a statement and during a commit (`max_page_count`).
6. **Restore can't resend or relax privacy** (point 8).
   - Restore is offered only where the mailbox is unusable anyway: the `corrupt` gate. There is no Settings entry in this plan.
   - The restored database is put into recovery before the backend starts it:
     - every op that would reach a server (send and every remote op) and every scheduled send is set to `failed` with "Not sent: Terno restored your mailbox from a backup. Check Sent before trying again.", so nothing replays
     - local mode is turned on in the restored settings (the most private choice: the user turns it off again if they want to)
     - a flag shows the one-time explanation snack
   - The confirmation says that accounts removed since the backup come back.
   - The test covers a send queued in the backup and a backup taken with local mode off.
7. **Drafts outrank both screens** (point 9).
   - The gate screens appear only when the backend failed at start or at a retry. A window whose drafts aren't all saved (`draftsSaved()` false) shows the existing draft recovery first, as `EngineStopped` does.
   - The required screen is an overlay: editors stay mounted beneath it. It appears only once `draftsSaved()` is true (a dirty draft keeps the app usable and the pill says "Update required").
   - An install refused because of unsaved drafts closes the overlay with "Save or discard your drafts, then update". The tests cover a required update arriving while a draft is being typed.
8. **Policy metadata travels independently of availability** (point 10).
   - `Engine.check` returns `{ update, minimum }`; `minimum` is read from the channel file even when there's no newer version, and validated as semver.
   - A check whose feed carries no minimum (or one at or below this version) clears a persisted requirement.
   - A minimum above the offered version is ignored, since no update could satisfy it (logged).
   - A staged `ready` update below the minimum isn't installed by the button: the flow downloads the offered version, which Squirrel stages over the older one, and then installs.
   - Copies that can't update themselves never check (plan 11), so they learn no minimum. The `newer` gate covers them with "Download Terno".
9. **Consent in local mode stays explicit** (point 11).
   - The button's line says exactly what it does: "Checks GitHub for Terno {version}, downloads it and restarts Terno."
   - One click opens one manual check grant (only if no current offer is known) and one manual download grant, both scoped to that click, then installs.
   - A persisted requirement never starts a request at launch; the tests watch the wire across a relaunch in local mode.
10. **Binary applied and mailbox healthy are separate** (point 12).
    - `pending.json` is settled only at backend `ready`, as today.
    - A classified open failure in a run whose pending record names the running version logs `update.installed` and captures `update.mailbox_failed { fromVersion, toVersion, step }` (unexpected), once per run. The pending record stays, so a later successful open (a retry or a fix release) settles it with the usual toast.
    - Writing the pending record is fsynced, and a failure is captured as an unexpected error instead of a log line.
11. **Smaller decisions.**
    - The packaged smoke for a failing migration uses a conflicting table rather than a test-only hook in the release.
    - The full "failing release, then repair release" Squirrel chain is covered by the unit flow plus the gate smoke: building three signed releases is beyond the smoke's budget, recorded as a limit.

## 7. As shipped

### What exists

- **Classified opens** (`packages/db/src/open-errors.ts`):
  - `migrate` throws `SchemaNewerError` or `MigrationError` (with the step and SQLite's own words).
  - `classifyOpenError` sorts any failure into newer, no-room (backup or migrate), corrupt, unwritable, migration or backup. Anything else stays a crash.
  - **Full-disk detection.** On a really full volume SQLite says SQLITE_CANTOPEN (it can't create the WAL) or SQLITE_IOERR, almost never SQLITE_FULL. With less free space than the update needs, those count as no-room (found by the real-volume test).
  - **Original errors kept.** `Db.tx` rolls back only while SQLite still has a transaction, and keeps the original error (a failed ROLLBACK used to replace SQLITE_FULL). Failed opens close their connection.
- **The backup** (`upgrade.ts`, `backups.ts`):
  - `prepareUpgrade` runs before the open and uses SQLite's backup API, 256 pages per step.
  - The copy is switched to `journal_mode = DELETE`, so it is one self-contained file. It is verified by `user_version` and `page_count`.
  - It is fsynced, with its manifest, and renamed into `backups/<createdAt>-v<from>-v<to>/`. The previous generation goes only after that.
  - Room is checked first: `size + wal + 64 MiB + size/2`. A real ENOSPC or SQLITE_FULL is reported the same way.
  - The first backup of an upgrade is kept across retries. Partial or torn generations are removed.
  - `expireBackups` deletes one 14 days old, only after a healthy open.
  - A start with nothing to migrate costs one `readdir` and one read-only `user_version`.
- **Restore** (`apps/desktop/src/mailbox/restore.ts`):
  - It is journaled. The copy is prepared beside the mailbox and verified, then the journal is written and the folder fsynced.
  - The live WAL and then the file move aside; the folder is fsynced again; the copy takes their place; the marker is written; the journal goes.
  - `reconcileRestore` settles a leftover journal before every backend start: finished, or put back exactly with its WAL. A restore that can't be settled keeps every backend off the file.
  - The backend's `settleRestored` quarantines the restored mailbox:
    - ops that would reach a server are failed with an explanation
    - scheduled sends go back to drafts
    - local mode is turned on
  - The quarantine is checkpointed to the file (`wal_checkpoint(FULL)`) before the marker is removed.
  - The damaged original is kept 14 days from the restore.
- **Main** (`mailbox/host.ts`):
  - It keeps the gate, pushes it to every window, and handles Try Again, Update Without a Backup (one start only, where the backup is what failed or didn't fit) and Restore (a damaged mailbox only, no backend alive).
  - A backend that explained its failure isn't restarted on a timer. A crash during an upgrade steps the gate aside for the restart policy.
- **Required updates:**
  - `package.mjs` writes `minimumVersion` into the channel file (`TERNO_MINIMUM_VERSION` or `release-policy.json`) and refuses one above the release.
  - The engine returns `{ update, minimum }`. `feedMinimum` ignores a minimum no published version meets.
  - The requirement is persisted in `updates/prefs.json` and lifted by a check that no longer asks for it, or by running a version that meets it.
  - `updateNow()` is one explicit click: a manual check if needed, a manual download, then the install on Squirrel's own "ready". A staged update below the minimum is never what installs.
- **Health after an update:** `mailboxFailed` logs `update.installed` and captures `update.mailbox_failed` once per run. The pending record stays for the open that works. Writing it is fsynced, and a failure to write it is captured.
- **Window** (lazy `mailbox-cover.tsx`):
  - One screen per gate, plus the required-update screen with Update Terno and its progress, outcome and the unsupported "Download Terno".
  - The pill shows Update Required while drafts keep the screen away (`useRequiredCover`, driven by draft changes, at most once a second). An unsaved draft sends the window to draft review before any gate.
  - The gate and update state start with the window, before the mail engine connects.
  - Strings are in `en` and `es`.

### Deviations from §§2–6

- No clone on APFS: the backup API's consistency matters more than the free copy (§6.1).
- Restore is offered only on the damaged-mailbox gate (§6.6). There is no Settings entry.
- Local mode still means no automatic checks. A required update is learned from a check the user makes, or one that runs outside local mode. Privacy over enforcement, as planned.

### Verification

- **Unit:**
  - the backup, retention, failures per errno, verification and fsync failure, a WAL-only commit, retries (16)
  - classification, including a real SQLITE_FULL inside a statement and inside a transaction, and a garbage file (8)
  - restore, with failure at every step, crash states, durable ordering and retention (17)
  - the host (10), the update controller and policy (required, Update Terno, forced shutdown, staged-below-minimum, mailbox failure after an install), and the reducer and semver (5 more)
- **Real volumes** (`upgrade.volumes.int.test.ts`, hdiutil):
  - a tight HFS+ volume refuses the backup by estimate
  - a disk that fills during the backup leaves no partial copy and the mailbox intact
  - a migration on a truly full APFS volume rolls back (CANTOPEN), then migrates once freed
  - a read-only volume is unwritable with nothing written
  - a backup on APFS still opens at the old version after the original migrated
- **e2e** (`mailbox-gate.spec.ts`): every gate kind and the required screen, in light and dark with axe; a hung draft save keeps the required screen away, and a gate over an unsaved draft opens its review.
- **Packaged** (`mailbox.smoke.ts`, the signed app):
  - an older mailbox is backed up and migrated
  - a newer one gets the gate, with Update Terno visible and one backend start in nine seconds
  - a conflicting step gets the gate, and Try Again makes one more start
  - a nearly full HFS+ image gets no-room, then Update Without a Backup
  - a damaged mailbox is restored, its queued send failed and local mode on
- **Packaged update** (`update.smoke.ts`, real Squirrel): a feed with `minimumVersion: '0.1.1'` covers 0.1.0; Update Terno installs and relaunches 0.1.1, which forgets the requirement.
- **Environment note:** the update smoke's feed now ignores this environment's port probe (`GET /` with Node's user agent, seen on a plain server with no Terno running). The test asserts the updater never sends that agent.

### Limits

- A failing release followed by a fix release is covered by the unit flow and the gate smoke, not by three signed builds through Squirrel.
- Web stores have no backups, as planned: IndexedDB upgrades atomically and OPFS SQLite migrates step by step.

## 8. What the Codex code review changed

The review is in `/tmp/terno-p95/code-review.txt`. Each fix has a regression test that fails without it.

1. The restore journal and the moves are durable (folder fsync) before the copy takes the mailbox's place.
2. A restore that can't be settled at start keeps every backend off the mailbox, with Try Again.
3. The quarantine is checkpointed to the file before its marker is removed.
4. The update state starts with the window, so a cold start whose mailbox can't open has Update Terno.
5. A forced shutdown during Update Terno ends it, and the button comes back with the reason.
6. A crash mid-upgrade steps the gate aside, so the restart policy and the stopped-engine screen take over.
7. A gate never hides an unsaved draft: draft review comes first.
8. Backups expire only after a healthy open, not when the header reads.
9. The set-aside mailbox is kept 14 days from the restore, not from its last write.
