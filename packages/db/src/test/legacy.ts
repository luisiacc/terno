import { upgradeLegacyBodies } from "../body-upgrade";
import { openDatabase } from "../index";
import { MIGRATIONS } from "../migrations";
import { nodeSqliteDriver } from "../node-driver";
import { Db } from "../sqlite";

/**
 * Opens a legacy copy as a host does: migrations, then the dedicated legacy-body
 * upgrade before any store is admitted (w11: "Use the off-thread legacy upgrade").
 */
export async function openUpgraded(path: string): Promise<Db> {
  return upgradedBodies(openDatabase(path));
}

/** An opened (migrated) legacy database after its legacy-body upgrade, ready for a store. */
export async function upgradedBodies(db: Db): Promise<Db> {
  await upgradeLegacyBodies(db, () => new Promise<void>((resolve) => setImmediate(resolve)), async () => {}, () => {});
  return db;
}

/**
 * How today's tables read back in an older schema's shape, for tables whose
 * shape changed since. Everything else is copied column by column.
 */
/** the migration that seeds the legacy-body upgrade's marker (an older copy has no such row) */
const BODY_PARTS_VERSION = MIGRATIONS.find((m) => m.sql.includes("'body_parts_upgrade'"))!.version;

const SOURCE: Record<string, string> = {
  // v6 moved bodies out of messages
  messages: "messages LEFT JOIN message_bodies ON message_bodies.message_id = messages.id",
};

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
        const rows = source.all<Record<string, unknown>>(`SELECT ${list} FROM ${SOURCE[table] ?? table}${table === "settings" && version < BODY_PARTS_VERSION ? " WHERE key != 'body_parts_upgrade'" : ""}`);
        // OR REPLACE: rows a migration seeds (search_state at v7) take the source's values
        const insert = `INSERT OR REPLACE INTO ${table} (${list}) VALUES (${columns.map(() => "?").join(", ")})`;
        for (const r of rows) db.run(insert, ...columns.map((c) => r[c] as never));
      }
    });
    db.exec("PRAGMA foreign_keys = ON");
  } finally {
    db.close();
  }
}
