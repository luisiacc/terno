import { expect, it, vi } from "vitest";
import { openDatabase } from "./index";
import { nodePlatform } from "./node-driver";
import { SqlMailStore } from "./sql-store";
import { msg, withAccounts } from "../../store/src/conformance/fixtures";

for (const mode of ["startup", "final", "held"] as const) it(`closes native SQL after ${mode} cleanup failure and shares observed retirement`, async () => {
  const db = openDatabase(":memory:"), fault = new Error("Synthetic cleanup failure");
  let armed = mode === "startup", hold = false, entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; }), resume = new Promise<void>((r) => { release = r; });
  const platform = { ...nodePlatform, async yield() { await nodePlatform.yield(); if (hold) { hold = false; entered(); await resume; } } };
  const get = db.get.bind(db), rawClose = db.close.bind(db);
  const failure = vi.spyOn(db, "get").mockImplementation((sql, ...args) => { if (armed && sql === "SELECT id FROM body_captures ORDER BY id DESC LIMIT 1") throw fault; return get(sql, ...args); });
  const close = vi.spyOn(db, "close");
  const store = new SqlMailStore(db, { platform, instantSearch: mode === "startup" });
  const indexClose = store.instant ? vi.spyOn(store.instant, "close") : undefined;
  let reading: ReturnType<typeof store.threads.get> | undefined, closing: Promise<unknown> | undefined;
  try {
    if (mode !== "startup") {
      const [accountId] = await withAccounts(store, 1);
      const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "exact cached body\r\n".repeat(3000), bodyHtml: "<p>exact HTML</p>", bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
      if (mode === "held") { hold = true; reading = store.threads.get(result.touched[0]!); await started; }
      armed = true;
    }
    let settled = false;
    closing = store.close().then(() => null, (error: unknown) => error).finally(() => { settled = true; });
    const concurrent = store.close().then(() => null, (error: unknown) => error);
    if (mode === "held") {
      await nodePlatform.yield(); await nodePlatform.yield();
      expect(settled, "close must await the admitted body read despite cleanup failure").toBe(false);
      expect(close).not.toHaveBeenCalled();
      release();
      expect((await reading)!.messages[0]!.bodyText === "exact cached body\r\n".repeat(3000)).toBe(true);
    }
    expect(await closing).toBe(fault);
    expect(await concurrent).toBe(fault);
    expect(close).toHaveBeenCalledTimes(1);
    expect(db.isOpen).toBe(false);
    if (indexClose) expect(indexClose).toHaveBeenCalledTimes(1);
    expect(await store.close().catch((e: unknown) => e)).toBe(fault);
    expect(close).toHaveBeenCalledTimes(1);
  } finally { release(); await Promise.allSettled([reading, closing].filter((x) => x !== undefined)); armed = false; failure.mockRestore(); await store.instant?.close(); if (db.isOpen) rawClose(); }
});

it("reports background reclaim failure after native SQL closure even if final cleanup recovers", async () => {
  const db = openDatabase(":memory:"), store = new SqlMailStore(db, { platform: nodePlatform, instantSearch: false });
  const fault = new Error("Synthetic background reclaim failure");
  let build: Awaited<ReturnType<typeof store.feed.beginBuild>> | undefined, fired!: () => void;
  const failed = new Promise<void>((r) => { fired = r; });
  const run = db.run.bind(db);
  let armed = false;
  const spy = vi.spyOn(db, "run").mockImplementation((sql, ...args) => { if (armed && sql.startsWith("DELETE FROM body_parts WHERE")) { armed = false; fired(); throw fault; } return run(sql, ...args); });
  try {
    const [accountId] = await withAccounts(store, 1);
    const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: "old exact body ".repeat(3000), bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
    const message = (await store.threads.get(result.touched[0]!))!.messages[0]!;
    build = await store.feed.beginBuild();
    const pages = build.messages()[Symbol.asyncIterator](); await pages.next(); await pages.return?.();
    await store.sync.setBody(message.id, "new exact body ".repeat(3000), null, { now: 2, classifier: null });
    armed = true; await build.release(); await failed;
    await expect(store.close()).rejects.toBe(fault);
    expect(db.isOpen).toBe(false);
  } finally { armed = false; spy.mockRestore(); await build?.release(); await store.close().catch(() => {}); if (db.isOpen) db.close(); }
});
