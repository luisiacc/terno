import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ATTACHMENT_CHUNK } from "@terno/core";
import { withAccounts } from "@terno/store/conformance";
import { openDatabase } from "./index";
import { SqlMailStore } from "./sql-store";
import { sqlAssets } from "./attachments";

it("commits a bounded physical claim, refuses every new owner, and resumes after rollback and reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-asset-cleanup-")), path = join(dir, "mail.db");
  let interrupt = false;
  const platform = { yield: async () => { if (interrupt) throw new Error("interrupted cleanup"); } };
  let db = openDatabase(path), store = new SqlMailStore(db, { instantSearch: false, platform });
  try {
    const [a] = await withAccounts(store, 1), size = ATTACHMENT_CHUNK * 9, data = Buffer.alloc(ATTACHMENT_CHUNK, 90).toString("base64");
    const ref = await store.attachments.create({ accountId: a!, filename: "expired", mime: "application/octet-stream", size, now: 0 });
    for (let i = 0; i < 9; i++) await store.attachments.append(a!, ref.assetId, i, data);
    await store.attachments.seal(a!, ref.assetId);
    const create = () => store.attachments.create({ accountId: a!, filename: "next", mime: "text/plain", size: 0, now: 172800000 });
    interrupt = true;
    await expect(create()).rejects.toThrow("interrupted cleanup");
    expect(db.get<{ n: number }>("SELECT count(*) n FROM attachment_bytes")!.n).toBe(1);
    expect(sqlAssets(db).used(a!)).toBe(size + 1024);
    expect(sqlAssets(db).get(ref.assetId)?.complete).toBe(-1);
    await store.close(); db = openDatabase(path); store = new SqlMailStore(db, { instantSearch: false, platform });
    for (const action of [
      () => store.attachments.info(a!, ref.assetId), () => store.attachments.read(a!, ref.assetId, 8),
      () => store.attachments.append(a!, ref.assetId, 8, data), () => store.attachments.seal(a!, ref.assetId), () => store.attachments.discard(a!, ref.assetId),
      () => store.drafts.save({ accountId: a!, to: [], cc: [], subject: "owner", bodyText: "", attachments: [ref] }, 1),
      () => store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject: "owner", bodyText: "", attachments: [ref], recordReply: false, now: 1 }),
    ]) await expect(action()).rejects.toThrow();
    db.exec("CREATE TRIGGER refuse_cleanup BEFORE DELETE ON attachment_bytes BEGIN SELECT RAISE(ABORT, 'synthetic cleanup rollback'); END");
    interrupt = false;
    await expect(create()).rejects.toThrow("synthetic cleanup rollback");
    expect(sqlAssets(db).used(a!)).toBe(size + 1024);
    expect(db.get<{ data_base64: string }>("SELECT data_base64 FROM attachment_bytes")!.data_base64).toBe(data);
    db.exec("DROP TRIGGER refuse_cleanup");
    await store.close(); db = openDatabase(path); store = new SqlMailStore(db, { instantSearch: false, platform });
    await create();
    expect(db.get<{ n: number }>("SELECT count(*) n FROM attachment_bytes")!.n).toBe(0);
    expect(sqlAssets(db).used(a!)).toBe(1024);
    await store.debug.verify();
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("rechecks live owners and fresh Undo grace between cleanup units, and snapshots the creation request", async () => {
  const db = openDatabase(":memory:"); let between: (() => Promise<void>) | undefined;
  const store = new SqlMailStore(db, { instantSearch: false, platform: { yield: async () => { const fn = between; between = undefined; await fn?.(); } } });
  try {
    const [a] = await withAccounts(store, 1);
    const refs = [];
    for (let i = 0; i < 3; i++) {
      const ref = await store.attachments.create({ accountId: a!, filename: "old", mime: "text/plain", size: 3, now: 0 });
      await store.attachments.append(a!, ref.assetId, 0, "AP+A"); await store.attachments.seal(a!, ref.assetId); refs.push(ref);
    }
    const ids = sqlAssets(db).orphans(a!, 1);
    const pin = refs.find((r) => r.assetId === ids[1])!, grace = refs.find((r) => r.assetId === ids[2])!;
    const request = { accountId: a!, filename: "requested", mime: "text/plain", size: 0, now: 172800000 };
    between = async () => {
      await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "pin", bodyText: "", attachments: [pin] }, 1);
      const d = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "undo", bodyText: "", attachments: [grace] }, 1))!;
      await store.drafts.delete(d.id);
      request.size = 19 * 1024 * 1024; request.filename = "mutated";
    };
    expect(await store.attachments.create(request)).toMatchObject({ filename: "requested", size: 0 });
    for (const r of [pin, grace]) expect(await store.attachments.read(a!, r.assetId, 0)).toBe("AP+A");
  } finally { await store.close(); }
});
