import { MIGRATIONS, SCHEMA_VERSION } from "../migrations";
import { nodeSqliteDriver } from "../node-driver";
import { Db } from "../sqlite";

/** A mailbox exactly as an older Terno left it (schema `version`), with an account and a draft. */
export function oldMailbox(path: string, version = SCHEMA_VERSION - 1, drafts = 1): void {
  const db = new Db(nodeSqliteDriver, path);
  for (const m of MIGRATIONS.filter((m) => m.version <= version)) db.exec(m.sql);
  db.exec(`PRAGMA user_version = ${version}`);
  db.run("INSERT INTO accounts (id, kind, email, display_name, provider_config, created_at) VALUES (1, 'imap', 'synthetic@example.test', '', '{}', 0)");
  for (let i = 1; i <= drafts; i++) {
    db.run("INSERT INTO drafts (id, generation, account_id, format, mode, to_json, cc_json, subject, body_text, body_html, updated_at) VALUES (?, 'g', 1, 2, 'new', '[]', '[]', ?, 'body', '', 5)", i, `draft ${i}`);
  }
  db.close();
}

