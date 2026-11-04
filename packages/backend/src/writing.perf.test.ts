/**
 * Plan 133 at 50,000 threads: the learner never holds the event loop past the slicer's budget, on either store, and a
 * draft's assembly, a refinement and an intent are quick with 3,000 sent messages, thousands of look-alikes among them.
 * The model's a script: nothing leaves this process.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAi, type AiOptions, type ProviderConfig } from "@terno/ai";
import { DEFAULT_WRITING_PREFS } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { openDatabase, SqlMailStore } from "@terno/db";
import { IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { msg } from "@terno/store/conformance";
import type { MailStore } from "@terno/store";
import { expect, it } from "vitest";
import { Backend, plaintextCipher } from "./backend";
import { say } from "./test/writing-fixture";
import { VoiceLearner, windowKey } from "./voice-learner";

const NOW = Date.UTC(2026, 10, 1, 12);
const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const TOM = { name: "Tom Reed", email: "tom@acme.test" };
const LINES = ["Thanks for sending this over, it looks good to me.", "Let me know if that works for you and the team.", "I had a look at the numbers and we can go ahead with it.", "Sounds good, talk soon and have a great weekend.", "Could you send me the latest version when you get a chance?"];

async function seed(store: MailStore): Promise<number> {
  const seeded = await store.dev.seed(generateDataset({ threads: 50_000, accounts: 2, seed: 233, now: NOW, bodyScale: 0.02 }), { now: NOW, categorizeRate: 0 });
  expect(seeded.threadCount).toBeGreaterThanOrEqual(50_000);
  const accountId = seeded.accountIds[0]!;
  const me = { name: "Me", email: "me@perf.test" };
  for (let slice = 0; slice < 30; slice++) {
    const batch = Array.from({ length: 100 }, (_, i) => {
      const n = slice * 100 + i;
      const to = n % 3 === 0 ? TOM : { name: `Person ${n % 400}`, email: `p${n % 400}@company${n % 40}.test` };
      const body = `Hi ${to.name.split(" ")[0]},\n\n${LINES[n % 5]} ${LINES[(n + 2) % 5]}\n\n${LINES[(n + 4) % 5]}\n\nOn Friday someone wrote:\n> ${"quoted line ".repeat(20)}\n\nBest,\nMe\n\n-- \nMe\nFounder at Perf Inc`;
      return msg({ accountId, from: me, to: [to], isSent: true, isRead: true, inInbox: false, bodyText: body, date: NOW - n * 60_000 });
    });
    await store.sync.ingest(batch, { applyFilters: false, now: NOW, classifier: null });
  }
  return accountId;
}

async function runLearner(store: MailStore, label: string, gate: boolean): Promise<void> {
  const accountId = await seed(store);
  const learner = new VoiceLearner({
    store,
    platform: { yield: () => new Promise<void>((resolve) => setImmediate(resolve)) },
    now: () => NOW,
    prefs: async () => DEFAULT_WRITING_PREFS,
    forVoice: () => Promise.reject(new Error("no model here")),
    begin: () => ({ signal: new AbortController().signal, release: () => {} }),
    studyProgress: () => {},
    log: () => {},
    sliceMs: 6,
  });
  // the longest time the event loop waited while it ran: what anything else in the backend would have waited
  let stall = 0;
  let last = performance.now();
  let beating = true;
  const beat = () => {
    if (!beating) return;
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
    setImmediate(beat);
  };
  const started = performance.now();
  setImmediate(beat);
  await learner.activate();
  await learner.idle();
  beating = false;
  const ms = performance.now() - started;
  const window = await store.settings.get<number[]>(windowKey(accountId), []);
  const rows = (await store.writing.profiles.list({ accountId, limit: 2000 })).length;
  process.stderr.write(`[50k ${label} learner] ${window.length} messages, ${rows} rows in ${ms.toFixed(0)} ms; longest slice ${learner.longestSliceMs.toFixed(1)} ms, longest event-loop stall ${stall.toFixed(1)} ms\n`);
  expect(window.length).toBe(3000);
  expect(rows).toBeGreaterThan(50);
  expect(learner.longestSliceMs).toBeLessThanOrEqual(30 * MULT);
  // SQLite's reads are in process; fake-indexeddb's commits are this test's own, and say nothing of a real one
  if (gate) expect(stall).toBeLessThanOrEqual(60 * MULT);
  expect(ms).toBeLessThanOrEqual(60_000 * MULT);
}

it("the learner stays in its slices on SQLite at 50,000 threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-learner-perf-"));
  const store = new SqlMailStore(openDatabase(join(dir, "perf.db")));
  try {
    await runLearner(store, "SQL", true);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);

it("the learner stays in its slices on IndexedDB at 50,000 threads", async () => {
  const store = await IdbMailStore.open({ name: "learner-perf-50k", factory: indexedDB, instantSearch: false, platform: { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) } });
  try {
    await runLearner(store, "IDB", false);
  } finally {
    await store.close();
  }
}, 600_000);

it("a draft's assembly, a refinement and an intent, at 50,000 threads", async () => {
  const dir = mkdtempSync(join(tmpdir(), "terno-draft-perf-"));
  const factory = (config: ProviderConfig, options: AiOptions) =>
    createAi(config, {
      ...options,
      transport: {
        complete: async () => ({ text: JSON.stringify({ recipient: null }), stop: "end" as const }),
        stream: () => say("<email>Fine.</email>"),
      },
    });
  const backend = new Backend({ dbPath: join(dir, "u.db"), version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, aiFactory: factory, now: () => NOW });
  await backend.store.ready;
  await backend.ready;
  try {
    const accountId = await seed(backend.store);
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await client.call("settings.update", { ai: { provider: "fake" } });
    await backend.writing.learner.activate();
    await backend.writing.learner.idle();
    await backend.warmAutocomplete();
    const { refs } = await backend.store.writing.sentTo({ addresses: [TOM.email], accountId, limit: 1 });
    const threadId = refs[0]!.threadId;
    const timed = async (n: number, work: (i: number) => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < n; i++) {
        const t = performance.now();
        await work(i);
        times.push(performance.now() - t);
      }
      return [...times].sort((a, b) => a - b)[Math.ceil(n * 0.95) - 1]!;
    };
    const draft = (session: string, requestId: string) => client.call("ai.compose", { requestId, session, accountId, kind: "reply", threadId, to: [TOM], instruction: "tell tom it's fine", timezone: "UTC" });
    const first = await timed(20, (i) => draft(`first-${i}`, `f${i}`));
    await draft("again", "again-0");
    const refine = await timed(20, (i) => draft("again", `again-${i + 1}`));
    const intent = await timed(20, (i) => client.call("ai.resolveIntent", { requestId: `i${i}`, instruction: "just write them a note about the budget", surface: { kind: "thread", threadId } }));
    process.stderr.write(`[50k draft] p95: first draft's assembly and script ${first.toFixed(2)} ms, a refinement ${refine.toFixed(2)} ms, an intent ${intent.toFixed(2)} ms\n`);
    expect(first).toBeLessThanOrEqual(120 * MULT);
    expect(refine).toBeLessThanOrEqual(30 * MULT);
    expect(intent).toBeLessThanOrEqual(16 * MULT);
  } finally {
    await backend.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 600_000);
