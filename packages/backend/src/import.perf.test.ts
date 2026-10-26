/**
 * app.import of a large export (thousands of filters, categories and drafts)
 * runs in slices: the event loop never stalls long and a renderer listing
 * its inbox meanwhile stays fast.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { seedDataset, sqlDb } from "@terno/db";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { BUDGET_MULTIPLIER, report, type Stat } from "../../db/src/test/perf";
import { describeGap, watchLoop } from "../../db/src/test/timing";

const NOW = Date.UTC(2026, 9, 22, 15, 30);
const stats: Stat[] = [];
let dir: string;
let backend: Backend;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "terno-importperf-"));
  backend = new Backend({ dbPath: join(dir, "perf.db"), version: "perf", cipher: plaintextCipher, providers: demoRegistry, now: () => NOW, autoSync: false, instantSearch: false });
  seedDataset(sqlDb(backend.store), generateDataset({ threads: 2_000, accounts: 4, seed: 3, now: NOW, bodyScale: 0.3 }), { now: NOW });
}, 300_000);

afterAll(async () => {
  report("import.json", "Import (app.import)", { filters: 5_000, categories: 500, drafts: 2_000 }, stats);
  await backend.stop();
  rmSync(dir, { recursive: true, force: true });
});

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(xs.length * 0.95) - 1)] ?? 0;

it("importing 5,000 filters, 500 categories and 2,000 drafts: no stall over 50 ms, threads.list p95 ≤ 20 ms", async () => {
  const [c, srv] = createMemoryTransportPair();
  backend.connect(srv, { clientId: "importer", origin: "renderer" });
  const client = new RpcClient(c);
  const [pc, ps] = createMemoryTransportPair();
  backend.connect(ps, { clientId: "lister", origin: "renderer" });
  const lister = new RpcClient(pc);
  const accounts = (await client.call("app.bootstrap", {})).accounts;
  const email = accounts[0]!.email;
  const categories = Array.from({ length: 500 }, (_, i) => ({ id: 10_000 + i, name: `Importada ${i}`, color: "indigo" as const, position: i, autoApply: i % 2 === 0 }));
  const filters = Array.from({ length: 5_000 }, (_, i) => ({
    name: `Filtro ${i}`,
    enabled: true,
    source: "manual" as const,
    rule: { match: "all" as const, conditions: [{ field: "fromDomain" as const, op: "equals" as const, value: `d${i}.example` }], actions: [{ type: "addCategory" as const, categoryId: 10_000 + (i % 500) }] },
  }));
  const drafts = Array.from({ length: 2_000 }, (_, i) => ({ accountEmail: email, mode: "new" as const, to: [{ name: "", email: `p${i}@x.dev` }], cc: [], bcc: [], subject: `Borrador ${i}`, subjectEdited: true, bodyText: `Texto ${i}`, quotedText: "", includeQuote: false, inReplyTo: null, forwardOf: null, uiState: "open" as const, updatedAt: NOW }));
  const data = { format: "terno-export" as const, version: 2 as const, accounts: [], categories, filters, drafts };

  const loop = watchLoop(50 * BUDGET_MULTIPLIER);
  const list: number[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      const t = performance.now();
      await lister.call("threads.list", { view: "inbox" });
      list.push(performance.now() - t);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();
  const started = performance.now();
  const result = await client.call("app.import", { data });
  const took = performance.now() - started;
  done = true;
  await probe;
  const { stall, descheduled, longest } = loop.stop();

  expect(result).toMatchObject({ categories: { added: 500 }, filters: { added: 5_000 }, drafts: 2_000 });
  stats.push({ name: `import ${took.toFixed(0)} ms: max event-loop stall ${stall.toFixed(1)} ms (longest gap ${describeGap(longest)}, ${descheduled.length} descheduled), list RPC p95 ${p95(list).toFixed(1)} ms (${list.length})`, budgetMs: 50, p50: stall, p95: stall, max: stall, iterations: list.length });
  expect(stall).toBeLessThanOrEqual(50 * BUDGET_MULTIPLIER);
  expect(p95(list)).toBeLessThanOrEqual(20 * BUDGET_MULTIPLIER);
}, 300_000);

it.each([false, true])("strict validation of 5,000 attachment-bearing drafts stays within the 15 ms slice budget (connected: %s)", async (connected) => {
  const email = connected ? (await backend.store.accounts.list())[0]!.email : "not-connected@test.com";
  const attachments = Array.from({ length: 100 }, () => ({ filename: "empty.txt", mime: "text/plain", size: 0, contentId: null, chunks: [] }));
  const drafts = Array.from({ length: 5000 }, (_, i) => ({ accountEmail: email, subject: `Attached ${i}`, bodyText: "keep", to: [], cc: [], attachments }));
  const data = { format: "terno-export", version: 2, accounts: [], categories: [], filters: [], drafts };
  const categories = connected ? vi.spyOn(backend.store.categories, "list").mockRejectedValueOnce(new Error("validation complete")) : null;
  const loop = watchLoop(15);
  try {
    // Direct public RPC invocation isolates backend work from the transport's large structuredClone.
    const run = backend.server.invoke("app.import", { data }, { clientId: "attachment-importer", origin: "renderer" });
    if (connected) await expect(run).rejects.toThrow("validation complete");
    else await expect(run).rejects.toMatchObject({ code: "BAD_REQUEST" });
  } finally {
    const r = loop.stop();
    categories?.mockRestore();
    process.stderr.write(`[attached draft validation] max stall ${r.stall.toFixed(2)} ms (${describeGap(r.longest)})\n`);
    expect(r.stall).toBeLessThanOrEqual(15);
  }
}, 60000);
