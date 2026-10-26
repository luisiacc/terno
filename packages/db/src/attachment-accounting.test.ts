import { expect, it } from "vitest";
import { Db } from "./sqlite";
import { nodeSqliteDriver } from "./node-driver";
import { MIGRATIONS, migrate } from "./migrations";
import { SqlMailStore } from "./sql-store";
import { sqlAssets } from "./attachments";

it("backfills exact per-account usage and indexed orphans when upgrading v17", async () => {
  const db = new Db(nodeSqliteDriver, ":memory:");
  try {
    for (const migration of MIGRATIONS.filter((m) => m.version <= 17)) db.exec(migration.sql);
    db.exec("PRAGMA user_version = 17");
    db.run("INSERT INTO accounts (id,kind,email,display_name,created_at) VALUES (1,'gmail','a@test.com','A',0),(2,'gmail','b@test.com','B',0)");
    db.run("INSERT INTO drafts (id,account_id,to_json,cc_json,subject,body_text,updated_at) VALUES (1,1,'[]','[]','','',0)");
    db.run("INSERT INTO attachment_assets (id,account_id,filename,mime,size,created_at) VALUES ('pinned',1,'x','text/plain',3,0),('old',1,'x','text/plain',2,0),('other',2,'x','text/plain',7,0)");
    db.run("INSERT INTO attachment_links (id,asset_id,draft_id) VALUES ('pin','pinned',1)");
    migrate(db);
    const assets = sqlAssets(db);
    expect(assets.used(1)).toBe(2053); expect(assets.used(2)).toBe(1031);
    expect(assets.orphans(1, 1)).toEqual(["old"]);
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT asset_id FROM attachment_orphans WHERE account_id = 1 AND created_at < 1 ORDER BY created_at, asset_id LIMIT 50");
    expect(plan.map((r) => r.detail).join(" ")).toContain("attachment_orphans_age");
    expect(() => db.tx(() => { assets.unlink("draft", 1); assets.remove("old"); throw new Error("rollback"); })).toThrow("rollback");
    expect(assets.used(1)).toBe(2053); expect(assets.orphans(1, 1)).toEqual(["old"]);
    db.run("DELETE FROM drafts WHERE id = 1");
    expect(assets.orphans(1, 1)).toEqual(["old", "pinned"]);
    db.run("DELETE FROM accounts WHERE id = 1");
    expect(assets.used(1)).toBe(0); expect(assets.orphans(1, 1)).toEqual([]); expect(assets.used(2)).toBe(1031);
    const store = new SqlMailStore(db, { instantSearch: false });
    await store.attachments.create({ accountId: 2, filename: "new", mime: "text/plain", size: 0, now: 0 });
    expect(assets.used(2)).toBe(2055);
  } finally { db.close(); }
});
