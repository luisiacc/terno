import { MIGRATIONS } from "../migrations";
import { nodeSqliteDriver } from "../node-driver";
import { Db } from "../sqlite";

/**
 * How today's tables read back in an older schema's shape, for tables whose
 * shape changed since. Everything else is copied column by column.
 */
const SOURCE: Record<string, string> = {};

/**
 * Writes `source`'s rows into a new database created with the schema of
 * `version` (its exact migration SQL, triggers included), as an install of
 * that version would hold them. Its FTS index is the one the old triggers
 * build while the rows go in.
 */
export function writeLegacyCopy(source: Db, path: string, version: number): void {
  const db = new Db(nodeSqliteDriver, path);
  try {
    for (const m of MIGRATIONS.filter((x) => x.version <= version)) db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${version}`);
    db.exec("PRAGMA foreign_keys = OFF");
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts%' ORDER BY name")
      .map((r) => r.name);
    db.tx(() => {
      for (const table of tables) {
        const columns = db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name);
        const list = columns.map((c) => `"${c}"`).join(", ");
        const rows = source.all<Record<string, unknown>>(`SELECT ${list} FROM ${SOURCE[table] ?? table}`);
        const insert = `INSERT INTO ${table} (${list}) VALUES (${columns.map(() => "?").join(", ")})`;
        for (const r of rows) db.run(insert, ...columns.map((c) => r[c] as never));
      }
    });
    db.exec("PRAGMA foreign_keys = ON");
  } finally {
    db.close();
  }
}
