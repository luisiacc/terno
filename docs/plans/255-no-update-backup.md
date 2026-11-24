# Plan 255: no backup before a migration; migrations that touch rows are rare and said

- **Status:** planned.
- **Replaces:** the backup half of plan 95, plan 112 (the clone) and plan 253 (the clone's settle). Plan 95's gate for failures stays.
- **Request (verbatim):** "ok so the issue is the backup, what if we don't make a backup ?" — then, after the trade-off below: "ok lets remove the backup and make those steps rarer"
- **Context:** the owner wants an update never to show "Updating your mailbox…". The backup is what makes it wait: on APFS its clone's first write costs seconds (plan 253), and on Linux there is no clone, so a full copy. The owner: no users yet, no legacy paths to keep.

## 1. What exists

- **The backup** (`packages/db/src/upgrade.ts` `prepareUpgrade`, `clone.ts`, `backups.ts`): made before every migration, kept 14 days, one generation, verified, settled in the background (plan 253).
- **Its uses:**
  - the corrupt gate's "Restore the Copy…" (`apps/desktop/src/mailbox/restore.ts`, `MailboxHost.restore`, the `restoring` gate);
  - the restored mailbox's quarantine (`packages/db/src/restore.ts` `quarantineRestored`, `settleRestored`), with the "restored" snack;
  - "Update Without a Backup" on the backup's no-room and failure gates;
  - the plan 253 checkpoint hold and `deferCheckpoints`, which exist only so the clone's first write is the backup's.
- **What a backup protects against, measured against the code:**
  - **A step that fails** is already safe: each runs in one transaction (`migrate()`), so the file stays at the step before, and the gate offers Try Again.
  - **A step that only adds** (a table, a column, an index) destroys nothing.
  - **A step that deletes or rewrites rows with a bug in it** is the one case. Mail comes back from the servers; local-only data doesn't (unsent drafts, queued sends, settings, rules, snippets, "What matters" history).
- **History:** 65 of 77 migrations only add. 12 delete or rewrite rows they find (the scanner below, with trigger bodies left out): v3, 4, 6, 8, 9, 14, 19, 28, 35, 37, 57, 75. Four of them (4, 8, 57, 75) are table rebuilds, SQLite's way to change a constraint.

## 2. Design

### 2.1 No backup

- **`prepareUpgrade` goes.** The backend reads the file's schema (a read-only `user_version`), says `newer` above `SCHEMA_VERSION`, sends the `upgrading/migrate` gate when there's something to migrate, and opens (migrating).
- **Deleted:**
  - `clone.ts`, `backups.ts`, `packages/db/src/restore.ts` (`quarantineRestored`), and `quarantineForwards` if restore is its only caller;
  - `apps/desktop/src/mailbox/restore.ts` and `preparing.ts`;
  - `NoRoomError`'s backup stage and `canSkipBackup`, and `BackupError`;
  - the plan 253 checkpoint hold (`CheckpointHold`, the store's `{ hold }`, `nodeStore`'s `checkpointHold`) and `deferCheckpoints`: with no clone there is no split to keep off the mailbox.
- **The gate (`packages/core/src/mailbox`):**
  - `upgrading` loses its backup phase;
  - `no-room` loses its stage and `canSkipBackup`;
  - `failed` loses `backup`, `restoreFailed` and the `"backup"` reason;
  - `open` loses `restoredFrom`;
  - `restoring` goes.
  - `MailboxHost` keeps Try Again only. `beforeStart` returns no flags; the `skipBackup` init flag and the IPC channels `terno:mailbox-skip-backup` and the restore one go, in main, preload and `desktop.d.ts`.
- **The window (`mailbox-cover.tsx`):**
  - the corrupt screen keeps its no-backup wording ("Terno can't read it…", Try Again, Export Diagnostics);
  - the screens for restoring, a failed backup and a backup without room go, and so do "Update Without a Backup", the restored snack and `backupDate`;
  - "Updating your mailbox…" stays only as the migration's fallback past 400 ms, with its migrate line.
- **Copy:** every key only those screens used goes, in `en` and `es` together:
  - `mailbox.upgrading.backup`, `mailbox.noRoom.backup`, `mailbox.noRoom.skipHint`, `mailbox.skipBackup`;
  - `mailbox.corrupt.withBackup`, `mailbox.restore*`, `mailbox.restoring`, `mailbox.restored`;
  - `mailbox.backup.*`;
  - `errors.op.restoredFromBackup`, `forward.reason.restored`.
- **Diagnostics:** the codes `mailbox.backup_made`, `backup_skipped`, `backup_settled`, `backup_settle_failed`, `restored`, `restore_failed` and `restore_reconciled` go.
- **One cleanup at start:** the backend removes `backups/` beside the mailbox when it's there. An earlier build's clones would otherwise hold up to the mailbox's size on disk for 14 days, and nothing reads them now. A restore's other leftovers aren't touched: one mid-way could hold the only copy of a mailbox, and no profile has one.

### 2.2 The legacy body owner

Plan 253's narrowing stays (the owner's decision): only a mailbox the conversion is for opens through the exclusive worker. Its reason is rewritten: an ordinary update no longer spawns a worker for nothing.

### 2.3 Steps that touch rows are rare, and said

- **`Migration` gains `rewrites?: string`:** why a step deletes or rewrites existing rows.
- **A test reads every migration past v77** (`migration-rule.test.ts`, `rowRewrites` in `migrations.ts`). It fails a step whose SQL has `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, `UPDATE` or an `INSERT` that may replace a row (`OR REPLACE`, `REPLACE INTO`) without `rewrites`.
  - An `INSERT` that only adds rows, even copied from a `SELECT`, destroys nothing; its time is the perf gate's.
  - The 12 before v78 are history, and the test pins that list, so the reader is checked against real SQL.
  - The scan strips comments and string literals first, so a word in a default value or a comment isn't a statement.
  - `CREATE TRIGGER` bodies are skipped: a trigger runs later, on the app's own writes, not on the rows the migration finds.
- **AGENTS.md's Performance line becomes the rule:** a migration adds (tables, columns, indexes), with no backup to go back to. Prefer leaving an old column or table in place, and cleaning up in the background later, over deleting or rewriting rows in the step. One that must says why in `rewrites`, and the plan that adds it says what a bug in it would lose.

## 3. Tests

- **Deleted with their code:** `upgrade.test.ts`, `upgrade-clone.test.ts`, `upgrade.volumes.int.test.ts`, `restore.test.ts` (desktop), the restore and quarantine cases in `restore` (db), `preparing.test.ts`, and plan 253's hold tests in `repos.test.ts`.
- **Kept and adjusted:**
  - `open-errors.test.ts`: no backup kinds.
  - `host.test.ts`: Try Again, a failure that isn't restarted, a crash mid-upgrade.
  - `opening.int.test.ts`: the four legacy modes without backup assertions, plus an ordinary mailbox one schema behind migrating in the host's open, no `backups/` made, and an existing `backups/` removed.
  - `legacy-body-route.test.ts` as is.
- **New:**
  - The migration rule: the scanner on sample steps (an `UPDATE` without `rewrites` fails, with it passes; a trigger body or a string literal with `DELETE FROM` passes), and the real `MIGRATIONS` past v77 passing.
  - The backups folder removed at start.
- **Web e2e:**
  - `mailbox-gate.spec.ts`: upgrading (migrate), no-room, a failed step, unwritable, corrupt (no Restore), newer, required. The fake main loses `skipBackup` and `restore`.
  - `design-axe.spec.ts`'s gate list follows.
- **Packaged smoke (`mailbox.smoke.ts`):**
  - an older mailbox migrates, the cover never attaches, no `backups/`;
  - no room says the numbers (no skip);
  - a damaged mailbox says so with Try Again (the restore case goes);
  - a newer mailbox and a failed step as today.

## 4. Perf and resources

- A start does less: no `readdir` of backups, no lock worker, no `cp`, no settle worker, no held checkpoints.
- Disk: no clone that grows to the mailbox's size for 14 days, and old ones are removed.

## 5. Out of scope

- **Background steps** (a backfill or an index build run after the window opens, resumable) and removing the migration's fallback cover. That's the next plan, once a step needs it. Today every step is milliseconds on a 1.2 GB mailbox.
- **A corrupt mailbox's way forward** (start over and download the mail again) is a separate feature.
- **A copy of the local-only tables before a step that rewrites rows.** It can be revisited if a `rewrites` step ever needs it.

## 6. Revisions after the Codex review

These override §§2–5 where they conflict. The critique is in `/tmp/terno-scratch/p255-plan-review.txt`.

1. **The scanner is about rows lost, not time spent** (points 4–6).
   - It flags `DROP TABLE`, `DROP COLUMN`, `DELETE FROM`, `UPDATE`, and an `INSERT` that may replace a row (`OR REPLACE`, `REPLACE INTO`, the `VALUES` form included).
   - A plain `INSERT … SELECT` (a marker row, a copy into a new table) adds and is the perf gate's.
   - Trigger bodies are skipped from their `BEGIN` to the `END` that closes it, counting `CASE … END` inside. A `WHEN` clause's `CASE` comes before the `BEGIN`.
   - The history it reads (v3, 4, 6, 8, 9, 14, 19, 28, 35, 37, 57, 75) is pinned in the test.
   - A trigger created in a step and fired by a later `INSERT` in the same step isn't seen. It's rare, and a reviewer reads the step anyway.
2. **`backups/` goes off the opening's way** (point 2). `removeOldBackups` is an `fs.promises.rm` started before the open and not awaited: a large clone takes a while to free. A quit mid-way leaves the rest to the next start. The single-instance lock keeps any other Terno out of the folder.
3. **Checkpoints during a migration are SQLite's default again** (point 3). With no clone, a migration crossing 1,000 pages pays an ordinary checkpoint, as before plan 253. `deferCheckpoints` and the hold went with the clone.
4. **The updater and the backend report one `no-room`** (point 8). The `openFailure` field's values are `newer`, `no-room`, `migration`, `corrupt`, `unwritable` and `other`, with a controller test.
5. **Persisted reasons** (point 9). `forward.reason.restored` was only written by the restore's quarantine. No profile was ever restored (no users), so the key goes with it.
6. **Tests** (points 10–12):
   - the entry test loses `backup-cancel` and the settle cases and gains an ordinary update (no legacy owner, `backups/` removed);
   - `incoming-node-open.int.test.ts` reads the schema instead of backing up;
   - `upgrade.test.ts` covers a crash-left WAL holding both the step and a draft;
   - the packaged smoke's full disk is now truly full: the migration rolls back, says no room, and Try Again migrates once the space is freed.
7. **Left as they are:**
   - **A restore's leftovers from an earlier build** (point 1): no profile has one.
   - **IndexedDB** has its own version path; the web build is low priority, and its schema steps are code, not SQL.
   - **"Your Mac is almost out of space"** says Mac on Linux too. That's a copy fix for plan 254's Linux work.

## 7. As shipped

- **Deleted:** `clone.ts`, `backups.ts`, `restore.ts` (db and desktop), `preparing.ts` and their tests, the hold from plan 253, `quarantineForwards`, 17 strings in each locale and 7 diagnostics codes.
- **The cover:** "Updating your mailbox…" stays only as the fallback for a migration past 400 ms. The corrupt screen's text is `mailbox.corrupt.body`. The keys `noRoom.migrate` and `upgrading.migrate` are now `….body`.
- **Note on history:** the deletions landed inside f832a3b63 (a site commit that took the shared index while this was being built); 608b72640 completes the change.

## 8. What the Codex code review changed

The review is in `/tmp/terno-scratch/p255-code-review.txt`.

1. **The scanner reads like SQLite** (#1–3).
   - Strings, quoted names and comments go in one pass, so a `--` or `/*` inside a string hides nothing, and a column named `"case"`, `"end"` or `"DROP COLUMN"` is just a name.
   - It catches a `WITH` before `DELETE` or `REPLACE`, an upsert's `DO UPDATE SET`, and `ALTER TABLE t DROP c` without `COLUMN`.
   - Each case is in `migration-rule.test.ts`; the history list didn't move.
2. **A full disk is tested where it can happen** (#6).
   - Electron can't start its own profile on a disk that full, so the packaged case could never reach the gate.
   - `upgrade.volumes.int.test.ts` fills a real HFS+ image, leaving room for the schema's read (its `-shm`) but not for the migration's pages. The migration rolls back to a step it reached, is classified as no room, and runs once the space is freed.
   - Found on the way: on a disk full to the last block, even reading the schema fails (a WAL mailbox's reader needs its `-shm`). The backend reads it inside the open's `try`, so that's sorted the same way.
3. **A stopped checkpoint worker's wal-index reader stays closed** (#7). The bug predates plan 253, whose fix went out with the revert.
4. **The crash-left WAL test applies the real step** (#9) and checks the migrated schema against a fresh one, table by table and index by index.

**Left as they are:**
- **#4:** a full disk during the legacy body owner's conversion is said as unwritable. Only mailboxes from before v45 go there.
- **#5:** a full disk that the backups' removal frees a moment after the open failed. Try Again opens it.
- **#8:** tests that would still pass if the removal were awaited. Awaiting would be a visible code change.

## 9. A second review: Fable and Astra

Two independent reviews, Claude Fable and Codex's gpt-6.2-astra, read the series as it stood after §8. Each fix has a test that fails without it.

1. **A Try Again that crashes no longer strands the window** (Astra #1). A backend that dies before it reports cleared only an `upgrading` gate, so the earlier failure stayed up with its button busy. Any gate but `open` now steps aside on a crash, for the restart policy and its stopped-engine screen (`host.test.ts`).
2. **The rule reads every UPDATE** (Astra #2, Fable #1).
   - `UPDATE t AS x SET`, `INDEXED BY` and `NOT INDEXED` were missed. With trigger bodies out, any `UPDATE` that isn't a foreign key's `ON UPDATE` counts.
   - A quoted name touching a keyword (`UPDATE"t"SET`) now has a space kept around it.
3. **A trigger ends at the `END` that starts a statement** (Astra #3). A column may be named `begin` or `end`: counting those hid a `DELETE` after the trigger. The trigger's own `END` follows a `;` outside any `CASE`.
4. **The cover has an accessible description** (Astra #6). Its main sentence is `aria-describedby`, so a screen reader says what happened and what to do, not only the title and the focused button (`mailbox-gate.spec.ts`).
5. **No room never asks for less than is free** (Fable #2). After a real `SQLITE_FULL` the disk is back to what it was, and the estimate (64 MiB plus half the file) could be below it. The ask is now at least what's free plus 64 MiB (`open-errors.test.ts`).
6. **The full-disk test proves the rollback** (Fable #4): the error is the `MigrationError` of the step right after the one the file reached.
7. **Comments** that still spoke of a backup (Fable #3) say what is.

**Left as they are:**
- **Astra #4:** a crash-left WAL holding a current schema routes once through the legacy owner, which costs time, not data.
- **Astra #5:** "0 B free" when both the disk and `statfs` fail, a double failure.
- **Astra #7:** the smoke samples the cover every 25 ms. The cover shows only after 400 ms and stays until open.
