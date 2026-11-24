import { spawnSync } from "node:child_process";

/**
 * Plan 253: a backup whose settle was cut short by a crash. The file is in
 * rollback-journal mode with a hot `-journal` beside it, and pages of the
 * unfinished transaction (a `_spill` table) are already in the file, so only
 * playing the journal back gives the backup as it was.
 */
export function cutShortSettle(file: string): void {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA cache_size = 2; BEGIN; CREATE TABLE _spill (x)");
    for (let i = 0; i < 400; i++) db.exec("INSERT INTO _spill VALUES (randomblob(4000))");
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ["-e", script]);
  if (r.status !== 0) throw new Error(`cutShortSettle: ${String(r.stderr)}`);
}
