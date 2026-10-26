import { expect, it } from "vitest";
import { Db } from "./sqlite";
import { sqliteDriver } from "./index";
import { MIGRATIONS, migrate } from "./migrations";
import { SqlMailStore } from "./sql-store";
import { sqlAssets } from "./attachments";
import { withAccounts } from "@terno/store/conformance";

it.each([17, 18])("upgrades v%s to fresh persisted orphan grace with exact accounting, rollback and cascades", async (version) => {
  const db = new Db(sqliteDriver(), ":memory:");
  try {
    for (const migration of MIGRATIONS.filter((m) => m.version <= version)) db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${version}`);
    db.run("INSERT INTO accounts (id,kind,email,display_name,created_at) VALUES (1,'gmail','a@test.com','A',0),(2,'gmail','b@test.com','B',0)");
    db.run("INSERT INTO drafts (id,account_id,to_json,cc_json,subject,body_text,updated_at) VALUES (1,1,'[]','[]','','',0)");
    db.run("INSERT INTO attachment_assets (id,account_id,filename,mime,size,created_at) VALUES ('pinned',1,'x','text/plain',3,0),('old',1,'x','text/plain',2,0),('other',2,'x','text/plain',7,0)");
    db.run("INSERT INTO attachment_links (id,asset_id,draft_id) VALUES ('pin','pinned',1)");
    migrate(db);
    const assets = sqlAssets(db);
    expect(assets.used(1)).toBe(2053); expect(assets.used(2)).toBe(1031);
    expect(assets.orphans(1, 1000)).toEqual([]);
    db.tx(() => assets.beginOrphanGrace(1, 100));
    expect(assets.orphans(1, 100)).toEqual([]);
    expect(assets.orphans(1, 101)).toEqual(["old"]);
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT asset_id FROM attachment_orphans WHERE account_id = 1 AND grace_started_at < 101 ORDER BY grace_started_at, asset_id LIMIT 50");
    expect(plan.map((r) => r.detail).join(" ")).toContain("attachment_orphans_age");
    expect(() => db.tx(() => { assets.unlink("draft", 1); assets.beginOrphanGrace(1, 200); assets.remove("old"); throw new Error("rollback"); })).toThrow("rollback");
    expect(assets.used(1)).toBe(2053); expect(assets.orphans(1, 1000)).toEqual(["old"]);
    db.run("DELETE FROM drafts WHERE id = 1");
    expect(assets.orphans(1, 1000)).toEqual(["old"]);
    db.tx(() => assets.beginOrphanGrace(1, 200));
    expect(assets.orphans(1, 201)).toEqual(["old", "pinned"]);
    db.run("DELETE FROM accounts WHERE id = 1");
    expect(assets.used(1)).toBe(0); expect(assets.orphans(1, 1000)).toEqual([]); expect(assets.used(2)).toBe(1031);
    const store = new SqlMailStore(db, { instantSearch: false });
    await store.attachments.create({ accountId: 2, filename: "new", mime: "text/plain", size: 0, now: 0 });
    expect(assets.used(2)).toBe(2055);
  } finally { db.close(); }
});

it("anchors at most 50 pending orphans per separate committed transaction using the age index", () => {
  const db = new Db(sqliteDriver(), ":memory:"); migrate(db);
  try {
    db.run("INSERT INTO accounts (id,kind,email,display_name,created_at) VALUES (1,'gmail','a@test.com','A',0)");
    db.run("INSERT INTO drafts (id,account_id,to_json,cc_json,subject,body_text,updated_at) VALUES (1,1,'[]','[]','','',0)");
    const assets = sqlAssets(db);
    db.tx(() => {
      for (let i = 0; i < 120; i++) {
        db.run("INSERT INTO attachment_assets (id,account_id,filename,mime,size,created_at) VALUES (?,1,'x','text/plain',0,0)", `a-${i}`);
        assets.link(`a-${i}`, "draft", 1);
      }
      assets.unlink("draft", 1);
    });
    const pending = () => db.get<{ n: number }>("SELECT count(*) AS n FROM attachment_orphans WHERE grace_started_at IS NULL")!.n;
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT asset_id FROM attachment_orphans WHERE account_id = 1 AND grace_started_at IS NULL ORDER BY asset_id LIMIT 50");
    expect(plan.map((r) => r.detail).join(" ")).toContain("attachment_orphans_age");
    db.tx(() => assets.beginOrphanGrace(1, 100));
    expect(pending()).toBe(70);
    expect(() => db.tx(() => { assets.beginOrphanGrace(1, 200); assets.remove("a-0"); throw new Error("rollback"); })).toThrow("rollback");
    expect(pending()).toBe(70); expect(assets.used(1)).toBe(120 * 1024);
    expect(assets.orphans(1, 101)).toHaveLength(50);
  } finally { db.close(); }
});

it("keeps committed grace when reservation rolls back without deleting bytes or changing usage", async () => {
  const db = new Db(sqliteDriver(), ":memory:"); migrate(db);
  const store = new SqlMailStore(db, { instantSearch: false });
  try {
    const [a] = await withAccounts(store, 1);
    const ref = await store.attachments.create({ accountId: a!, filename: "old", mime: "text/plain", size: 3, now: 0 });
    await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId);
    const draft = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "undo", bodyText: "", attachments: [ref] }, 0))!;
    await store.drafts.delete(draft.id);
    db.exec("CREATE TRIGGER refuse_reservation BEFORE INSERT ON attachment_assets BEGIN SELECT RAISE(ABORT, 'synthetic reservation failure'); END");
    await expect(store.attachments.create({ accountId: a!, filename: "new", mime: "text/plain", size: 0, now: 172800000 })).rejects.toThrow("synthetic reservation failure");
    expect(sqlAssets(db).used(a!)).toBe(1027);
    expect(db.get<{ grace_started_at: number }>("SELECT grace_started_at FROM attachment_orphans WHERE asset_id = ?", ref.assetId)!.grace_started_at).toBe(172800000);
    expect(await store.attachments.read(a!, ref.assetId, 0)).toBe("AP+A");
    db.exec("DROP TRIGGER refuse_reservation");
    await store.attachments.create({ accountId: a!, filename: "new", mime: "text/plain", size: 0, now: 259200001 });
    expect(sqlAssets(db).used(a!)).toBe(1024);
    await expect(store.attachments.info(a!, ref.assetId)).rejects.toThrow();
  } finally { await store.close(); }
});
