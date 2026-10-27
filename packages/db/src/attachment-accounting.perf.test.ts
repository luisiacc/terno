import { expect, it } from "vitest";
import { SqlMailStore } from "./sql-store";
import { openDatabase } from "./index";
import { withAccounts } from "@terno/store/conformance";

it("creates and reclaims assets within 15 ms CPU with 100,000 pinned reservations", async () => {
  const db = openDatabase(":memory:"); const store = new SqlMailStore(db, { instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1);
    const draft = (await store.drafts.save({ accountId: accountId!, to: [], cc: [], subject: "pins", bodyText: "" }, 0))!;
    db.tx(() => {
      for (let i = 0; i < 100000; i++) {
        db.run("INSERT INTO attachment_assets (id,account_id,filename,mime,size,created_at) VALUES (?,?,?, ?,0,0)", `pin-${i}`, accountId!, "empty", "text/plain");
        db.run("INSERT INTO attachment_links (id,asset_id,draft_id) VALUES (?,?,?)", `link-${i}`, `pin-${i}`, draft.id);
      }
    });
    let maxCpu = 0, maxWall = 0;
    for (let i = 0; i < 20; i++) {
      const cpu = process.threadCpuUsage(), wall = performance.now();
      await store.attachments.create({ accountId: accountId!, filename: "new", mime: "text/plain", size: 0, now: i % 2 ? 172800000 : 0 });
      const used = process.threadCpuUsage(cpu); maxCpu = Math.max(maxCpu, (used.user + used.system) / 1000); maxWall = Math.max(maxWall, performance.now() - wall);
    }
    process.stderr.write(`[100k SQL asset create/cleanup] max CPU ${maxCpu.toFixed(2)} ms, wall ${maxWall.toFixed(2)} ms\n`);
    expect(maxCpu).toBeLessThanOrEqual(15);
  } finally { await store.close(); }
});

it("public create reclaims 252 MiB of physical orphan chunks with task turns and at most 15 ms CPU per slice", async () => {
  const db = openDatabase(":memory:"); const store = new SqlMailStore(db, { instantSearch: false });
  try {
    const [accountId] = await withAccounts(store, 1);
    const size = 18 * 1024 * 1024, width = 48 * 1024, data = Buffer.alloc(width, 90).toString("base64");
    db.tx(() => { for (let a = 0; a < 14; a++) {
      const id = `orphan-${a}`;
      db.run("INSERT INTO attachment_assets(id,account_id,filename,mime,size,received,chunks,complete,created_at) VALUES (?,?,'large.bin','application/octet-stream',?,?,?,1,0)", id, accountId!, size, size, size / width);
      for (let i = 0; i < size / width; i++) {
        db.run("INSERT INTO attachment_chunks(id,asset_id,position,size) VALUES (?,?,?,?)", `${id}:${i}`, id, i, width);
        db.run("INSERT INTO attachment_bytes(chunk_id,data_base64) VALUES (?,?)", `${id}:${i}`, data);
      }
    } });
    let previous = process.threadCpuUsage(), maxCpu = 0, turns = 0;
    const record = () => { const cpu = process.threadCpuUsage(previous); maxCpu = Math.max(maxCpu, (cpu.user + cpu.system) / 1000); previous = process.threadCpuUsage(); };
    const heartbeat = () => { record(); turns++; timer = setImmediate(heartbeat); };
    let timer = setImmediate(heartbeat);
    try { await store.attachments.create({ accountId: accountId!, filename: "next", mime: "text/plain", size: 0, now: 172800000 }); record(); }
    finally { clearImmediate(timer); }
    process.stderr.write(`[252MiB SQL cleanup] ${turns} turns; maxCPU ${maxCpu.toFixed(2)} ms\n`);
    expect(db.get<{ n: number }>("SELECT count(*) n FROM attachment_bytes")!.n).toBe(0);
    expect(db.get<{ bytes: number }>("SELECT bytes FROM attachment_usage WHERE account_id = ?", accountId!)!.bytes).toBe(1024);
    expect(maxCpu).toBeLessThanOrEqual(15);
    expect(turns).toBeGreaterThan(100);
  } finally { await store.close(); }
});
