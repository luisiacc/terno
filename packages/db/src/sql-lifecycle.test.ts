import { ingest, msg, withAccounts } from "@terno/store/conformance";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openDatabase } from "./index";
import { SqlMailStore, sqlDb } from "./sql-store";

for (const method of ["resetMailbox", "removeMany"] as const) {
  it(`${method}: settles committed bounded writes, retaining identity and other mailbox state after reopen`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "terno-lifecycle-"));
    const path = join(dir, "mail.db");
    let store = new SqlMailStore(openDatabase(path), { checkpointWorker: true });
    try {
      const [, account] = await withAccounts(store);
      await store.folders.replace(account!, [{ key: "F", path: ["F"], selectable: true }, { key: "Other", path: ["Other"], selectable: true }]);
      const { inserted: ids } = await ingest(store, Array.from({ length: 2001 }, (_, i) => msg({ accountId: account!, providerMsgId: `m${i}`, locations: [
        { mailbox: "F", uidvalidity: 7, uid: i + 1, flags: ["\\Seen"] },
        { mailbox: "Other", uidvalidity: 9, uid: i + 1, flags: ["\\Flagged"] },
      ] })));
      const db = sqlDb(store);
      db.run("INSERT INTO attachment_assets(id,account_id,filename,mime,size,created_at) VALUES('asset',?,'x','text/plain',3,0)", account!);
      db.run("INSERT INTO attachment_links(id,asset_id,message_id) VALUES('pin','asset',?)", ids[0]!);
      db.run("INSERT INTO ops(id,seq,account_id,kind,target_json,created_at,updated_at) VALUES('deletion',1,?,'trash',?,0,0)", account!, JSON.stringify({ messageIds: [ids[0]] }));
      db.run("INSERT INTO recipient_receipts(opId,accountId,createdAt,charge,count,parts,state,retired,deleteAfter) VALUES('deletion',?,0,0,1,0,'accepted',0,0)", account!);
      const pins = db.all("SELECT * FROM attachment_links");
      const receipts = db.all("SELECT * FROM recipient_receipts");
      const ops = db.all("SELECT * FROM ops");
      const messages = db.all("SELECT * FROM messages ORDER BY id");
      const other = db.all("SELECT * FROM message_locations WHERE mailbox='Other' ORDER BY message_id");
      const memberships = db.all("SELECT * FROM thread_folders WHERE folder='Other' ORDER BY thread_id");
      const run = db.run.bind(db), all = db.all.bind(db);
      const removed: number[] = [];
      const writes = vi.spyOn(db, "run").mockImplementation((sql, ...args) => {
        const r = run(sql, ...args);
        if (/DELETE FROM (message_locations|thread_folders)/.test(sql)) removed.push(r.changes);
        return r;
      });
      const reads = vi.spyOn(db, "all").mockImplementation((sql, ...args) => {
        const r = all(sql, ...args);
        if (sql.startsWith("DELETE FROM message_locations")) removed.push(r.length);
        return r;
      });
      let enter!: () => void, resume!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { resume = resolve; });
      const progress: number[] = [];
      const settle = vi.spyOn(store, "settle").mockImplementation(async () => {
        expect(db.inTransaction).toBe(false);
        const n = db.get<{ n: number }>("SELECT count(*) n FROM message_locations WHERE mailbox='F'")!.n;
        progress.push(n);
        if (progress.length === 1) { enter(); await released; }
        // A committed removal always has its durable dispatch fence.
        expect(db.get<{ n: number }>("SELECT count(*) n FROM imap_identity_holds")!.n).toBe(ids.length - n);
      });
      try {
        const locations = store.providerStore(account!).locations;
        const operation = method === "resetMailbox" ? locations.resetMailbox("F") : locations.removeMany(ids, "F");
        try {
          expect(await Promise.race([entered.then(() => "settling"), operation.then(() => "finished")])).toBe("settling");
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          expect(db.get<{ n: number }>("SELECT count(*) n FROM message_locations WHERE mailbox='F'")!.n).toBe(1001);
        } finally { resume(); await operation; }
        const result = await operation;
        if (method === "resetMailbox") expect(result).toEqual(ids);
        expect(progress).toHaveLength(method === "resetMailbox" ? 3 : 6);
        expect(progress).toContain(1001);
        expect(progress).toContain(1);
        expect(progress.at(-1)).toBe(0);
        expect(removed.length).toBeGreaterThan(0);
        expect(Math.max(...removed)).toBeLessThanOrEqual(1000);
      } finally { settle.mockRestore(); writes.mockRestore(); reads.mockRestore(); }
      await store.close();
      store = new SqlMailStore(openDatabase(path), { checkpointWorker: true });
      const reopened = sqlDb(store);
      expect(reopened.all("SELECT * FROM attachment_links")).toEqual(pins);
      expect(reopened.all("SELECT * FROM recipient_receipts")).toEqual(receipts);
      expect(reopened.all("SELECT * FROM ops")).toEqual(ops);
      expect(reopened.all("SELECT * FROM messages ORDER BY id")).toEqual(messages);
      expect(reopened.all("SELECT * FROM message_locations WHERE mailbox='Other' ORDER BY message_id")).toEqual(other);
      expect(reopened.all("SELECT * FROM thread_folders WHERE folder='Other' ORDER BY thread_id")).toEqual(memberships);
      expect(reopened.get<{ n: number }>("SELECT count(*) n FROM thread_folders WHERE folder='F'")!.n).toBe(0);
      expect(await store.providerStore(account!).locations.unresolved(ids)).toEqual(ids);
      expect(await store.providerStore(account!).locations.of(ids)).toEqual(other.map((r) => ({ message_id: r.message_id, mailbox: r.mailbox, uid: r.uid, uidvalidity: r.uidvalidity, flags: r.flags })));
    } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it(`${method}: a failed removal rolls its identity holds and locations back before settlement`, async () => {
    const store = new SqlMailStore(openDatabase(":memory:"));
    try {
      const [, account] = await withAccounts(store);
      const { inserted: ids } = await ingest(store, [msg({ accountId: account!, locations: [{ mailbox: "F", uidvalidity: 7, uid: 23, flags: ["\\Seen"] }] })]);
      const db = sqlDb(store);
      const before = db.all("SELECT * FROM message_locations");
      const settle = vi.spyOn(store, "settle");
      const run = db.run.bind(db), all = db.all.bind(db);
      const writes = vi.spyOn(db, "run").mockImplementation((sql, ...args) => {
        if (sql.startsWith("DELETE FROM message_locations")) throw new Error("injected removal failure");
        return run(sql, ...args);
      });
      const reads = vi.spyOn(db, "all").mockImplementation((sql, ...args) => {
        if (sql.startsWith("DELETE FROM message_locations")) throw new Error("injected removal failure");
        return all(sql, ...args);
      });
      try {
        const locations = store.providerStore(account!).locations;
        await expect(method === "resetMailbox" ? locations.resetMailbox("F") : locations.removeMany(ids, "F")).rejects.toThrow("injected removal failure");
        expect(settle).not.toHaveBeenCalled();
      } finally { writes.mockRestore(); reads.mockRestore(); settle.mockRestore(); }
      expect(db.all("SELECT * FROM message_locations")).toEqual(before);
      expect(await store.providerStore(account!).locations.unresolved(ids)).toEqual([]);
    } finally { await store.close(); }
  });
}

it("removeMany: long-thread membership deletion settles only after the clean-watch decision commits", async () => {
  const store = new SqlMailStore(openDatabase(":memory:"));
  try {
    const [, account] = await withAccounts(store);
    await store.folders.replace(account!, [{ key: "F", path: ["F"], selectable: true }]);
    const { inserted: ids } = await ingest(store, Array.from({ length: 1001 }, (_, i) => msg({ accountId: account!, providerMsgId: `m${i}`, providerThreadId: "one", locations: [{ mailbox: "F", uidvalidity: 1, uid: i + 1, flags: [] }] })));
    const db = sqlDb(store);
    const progress: number[] = [];
    const settle = vi.spyOn(store, "settle").mockImplementation(async () => {
      expect(db.inTransaction).toBe(false);
      progress.push(db.get<{ n: number }>("SELECT count(*) n FROM thread_folders WHERE folder='F'")!.n);
    });
    try { await store.providerStore(account!).locations.removeMany(ids, "F"); }
    finally { settle.mockRestore(); }
    expect(progress).toEqual([1, 1, 0]);
    expect(await store.providerStore(account!).locations.unresolved(ids)).toEqual(ids);
  } finally { await store.close(); }
});

for (const method of ["resetMailbox", "removeMany"] as const) {
  it(`${method}: settlement failure preserves the committed slice and a later call resumes`, async () => {
    const store = new SqlMailStore(openDatabase(":memory:"));
    try {
      const [, account] = await withAccounts(store);
      const { inserted: ids } = await ingest(store, Array.from({ length: 1001 }, (_, i) => msg({ accountId: account!, providerMsgId: `m${i}`, locations: [{ mailbox: "F", uidvalidity: 3, uid: i + 1, flags: [] }] })));
      const db = sqlDb(store);
      const settle = vi.spyOn(store, "settle").mockRejectedValue(new Error("checkpoint failure"));
      const locations = store.providerStore(account!).locations;
      try { await expect(method === "resetMailbox" ? locations.resetMailbox("F") : locations.removeMany(ids, "F")).rejects.toThrow("checkpoint failure"); }
      finally { settle.mockRestore(); }
      expect(db.get<{ n: number }>("SELECT count(*) n FROM message_locations WHERE mailbox='F'")!.n).toBe(1);
      expect((await locations.unresolved(ids)).length).toBe(1000);
      if (method === "resetMailbox") expect(await locations.resetMailbox("F")).toEqual([ids.at(-1)]);
      else await locations.removeMany(ids, "F");
      expect(await locations.unresolved(ids)).toEqual(ids);
      expect(await locations.of(ids)).toEqual([]);
    } finally { await store.close(); }
  });
}

it("removeMany: rejection after a long-thread membership commit leaves no temporary watch", async () => {
  const store = new SqlMailStore(openDatabase(":memory:"));
  try {
    const [, account] = await withAccounts(store);
    await store.folders.replace(account!, [{ key: "F", path: ["F"], selectable: true }]);
    const { inserted: ids } = await ingest(store, Array.from({ length: 1001 }, (_, i) => msg({ accountId: account!, providerMsgId: `m${i}`, providerThreadId: "one", locations: [{ mailbox: "F", uidvalidity: 1, uid: i + 1, flags: [] }] })));
    const db = sqlDb(store);
    const settle = vi.spyOn(store, "settle").mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error("checkpoint failure"));
    try { await expect(store.providerStore(account!).locations.removeMany(ids, "F")).rejects.toThrow("checkpoint failure"); }
    finally { settle.mockRestore(); }
    expect(db.get<{ n: number }>("SELECT count(*) n FROM expunge_watch")!.n).toBe(0);
    expect(db.get<{ n: number }>("SELECT count(*) n FROM thread_folders WHERE folder='F'")!.n).toBe(0);
    expect(await store.providerStore(account!).locations.unresolved(ids)).toEqual(ids);
  } finally { await store.close(); }
});

it("removeMany: membership batches await settlement before the next deletion", async () => {
  const store = new SqlMailStore(openDatabase(":memory:"));
  let resume!: () => void;
  const released = new Promise<void>((resolve) => { resume = resolve; });
  try {
    const [, account] = await withAccounts(store);
    await store.folders.replace(account!, [{ key: "F", path: ["F"], selectable: true }]);
    const { inserted: ids } = await ingest(store, Array.from({ length: 2001 }, (_, i) => msg({ accountId: account!, providerMsgId: `m${i}`, locations: [{ mailbox: "F", uidvalidity: 1, uid: i + 1, flags: [] }] })));
    const db = sqlDb(store);
    let enter!: () => void, calls = 0;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const settle = vi.spyOn(store, "settle").mockImplementation(async () => {
      if (++calls === 4) { enter(); await released; }
    });
    const operation = store.providerStore(account!).locations.removeMany(ids, "F");
    try {
      expect(await Promise.race([entered.then(() => "settling"), operation.then(() => "finished")])).toBe("settling");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(db.get<{ n: number }>("SELECT count(*) n FROM thread_folders WHERE folder='F'")!.n).toBe(1001);
    } finally { resume(); await operation; settle.mockRestore(); }
    expect(db.get<{ n: number }>("SELECT count(*) n FROM thread_folders WHERE folder='F'")!.n).toBe(0);
  } finally { resume(); await store.close(); }
});
