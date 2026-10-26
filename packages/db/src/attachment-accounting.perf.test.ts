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
