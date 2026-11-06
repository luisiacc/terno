/**
 * Plan 144 revision 11 at 50,000+ threads, on both stores: the whole of a preparation as an open sets it off (each read
 * again before each request, assembly, the check, the draft, the conditional finish at the table's cap), on a short
 * conversation and a long one. It holds the time and the longest the event loop goes without a turn. The model's a
 * script: nothing leaves this process.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, type AiOptions, type ProviderConfig } from "@terno/ai";
import { REPLY_BODIES_MAX, REPLY_DECISIONS_MAX } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import type { MailStore } from "@terno/store";
import { msg } from "@terno/store/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { copyMailbox, LARGE_MAILBOX } from "../../db/src/test/perf-mailbox";
import { watchLoop } from "../../db/src/test/timing";
import { Backend, plaintextCipher } from "./backend";
import { say } from "./test/writing-fixture";

const NOW = Date.UTC(2026, 10, 1, 12);
const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const ANA = { name: "Ana", email: "ana@perf.test" };
const dir = mkdtempSync(join(tmpdir(), "terno-replies-perf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(kind: "SQLite" | "IndexedDB", budget: { p95Ms: number; busyMs: number }) {
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  let store: MailStore | undefined;
  let accountId: number;
  const path = join(dir, `${kind}.db`);
  if (kind === "IndexedDB") {
    const idb = await IdbMailStore.open({ name: "replies-perf", factory: indexedDB, instantSearch: false, platform });
    const seeded = await idb.dev.seed(generateDataset({ threads: 52_000, accounts: 2, seed: 144, now: NOW, bodyScale: 0.02 }), { now: NOW, categorizeRate: 0 });
    accountId = seeded.accountIds[0]!;
    store = idb;
  } else accountId = copyMailbox(LARGE_MAILBOX, path).accountIds[0]!;
  const factory = (config: ProviderConfig, options: AiOptions) => createAi(config, { ...options, transport: { complete: async () => ({ text: JSON.stringify({ needsReply: true }), stop: "end" as const }), stream: () => say("<email>Fine.</email>") } });
  const backend = new Backend({ dbPath: path, store, platform: store ? platform : undefined, version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => NOW });
  await backend.store.ready;
  await backend.ready;
  try {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await client.call("settings.update", { ai: { provider: "fake" } });
    await client.call("settings.update", { replies: { enabled: true } });
    const live = backend.store;
    // the table at its cap: every finish below has the bounds to keep
    const walked = await live.filters.threadsOf(await live.filters.messageWalk().next(40_000));
    let n = 0;
    for (const threadId of walked.slice(300, 300 + REPLY_BODIES_MAX + REPLY_DECISIONS_MAX)) {
      const sources = await live.aiSummaries.sources(threadId);
      if (!sources) continue;
      const hasBody = n++ < REPLY_BODIES_MAX;
      await live.replies.finish({ rowId: `seed-${threadId}`, expect: null, threadId, sourceStamp: sources.stamp, generationKey: "k", answeringMessageId: 1, state: hasBody ? "ready" : "skipped", body: hasBody ? "Hello" : null, used: null, checks: null, to: [ANA], cc: [], model: "m", provider: "p", promptVersion: 1, generatedAt: NOW - 1000, clearGeneration: live.replies.clearGeneration() });
    }
    expect(n).toBeGreaterThan(1000);
    // conversations waiting on an answer: what plan 17 would mark, kept to this gate's summaries
    const short = Array.from({ length: 25 }, (_, i) => msg({ accountId, providerMsgId: `s-${i}`, providerThreadId: `s-${i}`, from: ANA, subject: `Short ${i}`, bodyText: "Can you make the 19th?", date: NOW - 60_000 }));
    const long = Array.from({ length: 200 }, (_, i) => msg({ accountId, providerMsgId: `l-${i}`, providerThreadId: "long", from: ANA, subject: "Long", bodyText: `Paragraph ${i}. ${"words ".repeat(40)}`, date: NOW - (200 - i) * 60_000 }));
    await live.sync.ingest([...short, ...long], { applyFilters: false, now: NOW, classifier: null });
    const summaries = live.threads.summaries.bind(live.threads);
    live.threads.summaries = async (ids) => (await summaries(ids)).map((t) => ({ ...t, waitingSince: NOW - 60_000 }));
    const all = await live.filters.messageWalk().next(225);
    const threads = await live.filters.threadsOf(all);
    const facts = await live.filters.actionFacts(threads);
    const shortIds = facts.filter((f) => f.subject.startsWith("Short")).map((f) => f.id);
    const longId = facts.find((f) => f.subject === "Long")!.id;
    const prepared = (threadId: number) =>
      new Promise<void>((resolve, reject) => {
        const off = client.on("aiReply", (e) => {
          if (e.threadId !== threadId || e.phase === "writing") return;
          off();
          if (e.phase === "ready") resolve();
          else reject(new Error(`no reply for ${threadId}`));
        });
        void client.call("ai.prepareReply", { threadId, accountId, to: [ANA], cc: [], timezone: "UTC" }).then((r) => {
          if (r.status !== "started") reject(new Error(`didn't start: ${r.status}`));
        }, reject);
      });
    const loop = watchLoop(budget.busyMs * MULT);
    const times: number[] = [];
    for (const threadId of shortIds) {
      const t = performance.now();
      await prepared(threadId);
      times.push(performance.now() - t);
    }
    const t = performance.now();
    await prepared(longId);
    const longMs = performance.now() - t;
    const report = loop.stop();
    const p95 = [...times].sort((a, b) => a - b)[Math.ceil(times.length * 0.95) - 1]!;
    process.stderr.write(`[${kind}] a preparation: p95 ${p95.toFixed(1)} ms, long ${longMs.toFixed(1)} ms, longest busy ${report.longest.busy.toFixed(1)} ms\n`);
    expect(p95).toBeLessThanOrEqual(budget.p95Ms * MULT);
    expect(longMs).toBeLessThanOrEqual(budget.p95Ms * 2 * MULT);
    expect(report.longest.busy).toBeLessThanOrEqual(budget.busyMs * MULT);
  } finally {
    await backend.stop();
  }
}

describe("a preparation at 50k+ threads (plan 144)", () => {
  it("SQLite", () => run("SQLite", { p95Ms: 400, busyMs: 120 }), 900_000);
  it("IndexedDB", () => run("IndexedDB", { p95Ms: 800, busyMs: 200 }), 900_000);
});
