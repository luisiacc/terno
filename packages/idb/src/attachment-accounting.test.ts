import { expect, it } from "vitest";
import { createMemDb } from "./schema";
import { idbAssets } from "./attachments";

it("maintains exact usage and bounded orphan traversal through load, rollback and cascades", () => {
  const db = createMemDb(); const assets = idbAssets(db);
  db.tx(() => {
    db.table("accounts").insert({ id: 1 }); db.table("accounts").insert({ id: 2 });
    db.table("drafts").insert({ id: 1, account_id: 1 });
    for (let i = 0; i < 500; i++) db.table("attachment_assets").insert({ id: `old-${i}`, account_id: 1, filename: "x", mime: "text/plain", size: i, created_at: 500 - i });
    db.table("attachment_assets").insert({ id: "other", account_id: 2, filename: "x", mime: "text/plain", size: 7, created_at: 0 });
    for (let i = 0; i < 500; i += 2) assets.link(`old-${i}`, "draft", 1);
  }); db.confirm();
  const total = 500 * 1024 + 499 * 500 / 2;
  expect(assets.used(1)).toBe(total); expect(assets.used(2)).toBe(1031);
  expect(assets.orphans(1, 1000)).toHaveLength(50);
  expect(() => db.tx(() => { assets.unlink("draft", 1); assets.remove("old-1"); throw new Error("rollback"); })).toThrow("rollback");
  expect(assets.used(1)).toBe(total); expect(assets.orphans(1, 1000).every((id) => Number(id.split("-")[1]) % 2)).toBe(true);
  db.tx(() => assets.unlink("draft", 1)); const commit = db.takeCommit(); expect(commit).toBeTruthy(); db.revert();
  expect(assets.orphans(1, 1000).every((id) => Number(id.split("-")[1]) % 2)).toBe(true);
  db.tx(() => db.table("drafts").delete(1)); db.confirm();
  let deleted = 0;
  for (;;) {
    const batch = assets.orphans(1, 1000); if (!batch.length) break;
    expect(batch.length).toBeLessThanOrEqual(50);
    db.tx(() => { for (const id of batch) assets.remove(id); }); db.confirm(); deleted += batch.length;
  }
  expect(deleted).toBe(500); expect(assets.used(1)).toBe(0);
  db.tx(() => db.table("accounts").delete(1)); db.confirm();
  expect(assets.used(2)).toBe(1031); expect(assets.orphans(2, 1)).toEqual(["other"]);
});
