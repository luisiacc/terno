/**
 * Plan 107 (Codex code review round 20 #5): a demo IMAP-like folder of 20,000 messages renamed through the backend.
 * The demo copies its places under the new path, then removes the old ones once the backend followed the move: a page
 * at a time with real turns between, so nothing holds the event loop past the slicer's budget (plus one write begun
 * inside it), and the mail is all there after.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { demoRegistry } from "@terno/mail";
import { ingest, msg } from "@terno/store/conformance";
import { afterAll, expect, it } from "vitest";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { describeGap, watchLoop } from "../../db/src/test/timing";
import { Backend, plaintextCipher } from "./backend";

const FOLDER = 20_000;
/** the slicer's 15 ms budget plus one write begun inside it */
const STALL_MS = 25;
const stats: Stat[] = [];
const dirs: string[] = [];
afterAll(() => {
  report("folder-actions-demo.json", "Demo folder rename (plan 107)", { folder: FOLDER }, stats);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

it(`renames a populated ${FOLDER.toLocaleString("en")}-message demo folder without stalling the backend`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-p107-demo-perf-"));
  dirs.push(dir);
  const backend = new Backend({ dbPath: join(dir, "test.db"), version: "test", cipher: plaintextCipher, providers: demoRegistry, autoSync: false });
  const [c, s] = createMemoryTransportPair();
  backend.connect(s, { clientId: "p107-demo-perf", origin: "renderer" });
  const client = new RpcClient(c);
  try {
    const { account } = await backend.store.accounts.create({ kind: "imap", email: "free@example.test", displayName: "Freelance", color: "amber", now: 0 });
    await backend.store.folders.replace(account.id, [{ key: "Work", path: ["Work"], selectable: true }]);
    const all = Array.from({ length: FOLDER }, (_, i) =>
      msg({ accountId: account.id, providerMsgId: `w${i}`, rfcMessageId: `w${i}@test`, subject: `Work ${i}`, inInbox: false, locations: [{ mailbox: "Work", uidvalidity: 1, uid: i + 1, flags: [] }] }),
    );
    for (let i = 0; i < all.length; i += 2000) await ingest(backend.store, all.slice(i, i + 2000));
    await backend.rebuildFolders();
    // the rename (the copy and the backend's carry), then a pass that finds nothing left to do
    const loop = watchLoop(STALL_MS * BUDGET_MULTIPLIER);
    const started = performance.now();
    await client.call("folders.rename", { accountId: account.id, key: "Work", name: "Job" });
    const renameMs = performance.now() - started;
    await backend.syncAccount(account.id);
    const r = loop.stop();
    stats.push({ name: `rename ${renameMs.toFixed(0)} ms, max stall ${r.stall.toFixed(1)} ms (longest ${describeGap(r.longest)})`, budgetMs: STALL_MS, p50: r.stall, p95: r.stall, max: r.stall, iterations: 1 });
    const places = backend.store.providerStore(account.id).locations;
    expect((await places.inMailbox("Job", 1)).length).toBe(FOLDER);
    expect((await places.inMailbox("Work", 1)).length).toBe(0);
    expect(await client.call("folders.count", { accountId: account.id, key: "Job" })).toEqual({ messages: FOLDER, folders: 1 });
    expect(r.stall, "event-loop stall").toBeLessThanOrEqual(STALL_MS * BUDGET_MULTIPLIER);
  } finally {
    client.close();
    await backend.stop();
  }
});
