import { createHash } from "node:crypto";
import { renameSync, rmSync } from "node:fs";
import { Db } from "../../../packages/db/src/sqlite";
import { nodeSqliteDriver } from "../../../packages/db/src/node-driver";
import { writeLegacyCopy } from "../../../packages/db/src/test/legacy";

export function profileFacts(path: string) {
  const db = new Db(nodeSqliteDriver, path, { readonly: true });
  try {
    const digest = (sql: string) => createHash("sha256").update(JSON.stringify(db.all(sql))).digest("hex");
    return {
      accounts: digest("SELECT id, email, provider_config FROM accounts ORDER BY id"),
      threads: digest("SELECT id FROM threads ORDER BY id"),
      messages: digest("SELECT id, thread_id, subject, from_email, to_json FROM messages ORDER BY id"),
      bodies: digest("SELECT * FROM message_bodies ORDER BY message_id"),
      drafts: digest("SELECT id FROM drafts ORDER BY id"),
      counts: ["accounts", "threads", "messages", "message_bodies", "drafts"].map((table) => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n),
    };
  } finally { db.close(); }
}

/** Copy rows into the schema v13 actually created; never relabel a newer schema. */
export function toV13(path: string): void {
  const source = new Db(nodeSqliteDriver, path);
  const legacy = `${path}.v13`;
  try {
    source.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    writeLegacyCopy(source, legacy, 13);
  } finally { source.close(); }
  const db = new Db(nodeSqliteDriver, legacy);
  try {
    db.exec("DELETE FROM settings WHERE key IN ('facts_backfill', 'facts_senders')");
    const app = JSON.parse(db.get<{ value_json: string }>("SELECT value_json FROM settings WHERE key = 'app'")!.value_json);
    db.run("UPDATE settings SET value_json = ? WHERE key = 'app'", JSON.stringify({ ...app, design: "lumen" }));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally { db.close(); }
  for (const suffix of ["-wal", "-shm", ".search"]) rmSync(path + suffix, { force: true });
  renameSync(legacy, path);
}
