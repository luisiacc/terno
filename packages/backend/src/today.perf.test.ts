/**
 * Plan 204 revision 12 at 50,000+ threads, on both stores: the whole of `today.list` and the sidebar's count, with the
 * dated set at its bound (1,000 open items, every one of them showing) and follow-ups on. It holds the time and the
 * longest the event loop goes without a turn. Nothing leaves this process.
 */
import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { todayKey } from "@terno/core";
import { createMemoryTransportPair, RpcClient } from "@terno/core/rpc";
import { IdbMailStore } from "@terno/idb";
import { demoRegistry } from "@terno/mail";
import { generateDataset } from "@terno/mock-data";
import { NEEDS_WALK, type MailStore } from "@terno/store";
import { msg, seedDatedItems } from "@terno/store/conformance";
import { afterAll, describe, expect, it } from "vitest";
import { copyMailbox, LARGE_MAILBOX } from "../../db/src/test/perf-mailbox";
import { watchLoop } from "../../db/src/test/timing";
import { Backend, plaintextCipher } from "./backend";

const NOW = Date.UTC(2026, 10, 1, 12);
const DAY = 86_400_000;
const MULT = Number(process.env.PERF_BUDGET_MULTIPLIER ?? "1");
const dir = mkdtempSync(join(tmpdir(), "terno-today-perf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** list: today.list; added: what the count adds to plan 145's; needs and count: absolute, so a slower Needs you shows (plan 204, the second panel round) */
type Gate = { listMs: number; addedMs: number; needsMs: number; countMs: number };

const p95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95) - 1]!;

/** NEEDS_WALK conversations newer than the mailbox's, each waiting on the reader, as above. */
async function needsAtBound(store: MailStore, client: RpcClient, accountId: number, now: number) {
  await client.call("settings.update", { summaries: { enabled: false } });
  const me = { name: "Me", email: "me@perf.test" };
  const who = (i: number) => ({ name: `Person ${i}`, email: `person${i}@needs.test` });
  const at = (i: number) => now - 3_600_000 - i * 1000;
  const text = "Thanks! Here are the notes from this morning's call, with the numbers we went through and the plan for next week.";
  const out = Array.from({ length: NEEDS_WALK }, (_, i) => msg({ accountId, date: at(i) - 500, providerMsgId: `needs-${i}-out`, providerThreadId: `needs-${i}`, from: me, to: [who(i)], isSent: true, isRead: true, listId: null, subject: `Notes ${i}` }));
  const back = Array.from({ length: NEEDS_WALK }, (_, i) => msg({ accountId, date: at(i), providerMsgId: `needs-${i}-in`, providerThreadId: `needs-${i}`, from: who(i), to: [me], isRead: false, listId: null, subject: `Re: Notes ${i}`, inReplyTo: `needs-${i}-out`, snippet: text, bodyText: text }));
  for (const batch of [out, back]) for (let i = 0; i < batch.length; i += 500) await store.sync.ingest(batch.slice(i, i + 500), { applyFilters: false, now, classifier: null });
  // one snapshot: threadOf reads the whole mailbox each time
  const threads = new Map((await store.debug.snapshot()).messages.map((m) => [m.providerMsgId, m.threadId]));
  const body = JSON.stringify({ summary: "Notes from the call.", items: [{ kind: "fact", text: "The plan for next week is in the notes." }] });
  let written = 0;
  for (let i = 0; i < NEEDS_WALK; i++) {
    const threadId = threads.get(`needs-${i}-in`)!;
    const sources = await store.aiSummaries.sources(threadId);
    const r = await store.aiSummaries.finish({ threadId, stamp: sources!.stamp, expectThrough: null, now: now + 1, clearGeneration: store.aiSummaries.clearGeneration(), contentHash: "h", promptVersion: 7, language: "en", model: "m", provider: "fake", endpoint: null, bodyJson: body });
    if (r === "written") written++;
  }
  expect(written).toBe(NEEDS_WALK);
  // the facts of what came in, as the backend's slices would: until then the count has no waiting number to add to
  while (!(await store.facts.idle())) await store.facts.backfill({ limit: 5000 });
}

/**
 * The fifth panel round (revision 9): conversations holding two dated items and two promises of yours, Coming up as the
 * spread has them and all showing at the bound, each row saying its next. Among the soonest, so they stay at the bound.
 */
const SEVERAL = 50;

async function severalPerThread(store: MailStore, accountId: number, now: number) {
  const me = { name: "Me", email: "me@perf.test" };
  const who = (i: number) => ({ name: `Board ${i}`, email: `board${i}@several.test` });
  // yours first, so the requests in what came after aren't answered by it
  const sent = Array.from({ length: SEVERAL }, (_, i) => msg({ accountId, from: me, to: [who(i)], isSent: true, isRead: true, inInbox: false, listId: null, providerMsgId: `several-${i}-out`, providerThreadId: `several-${i}`, subject: `Board ${i}`, date: now - 7_200_000 - i, bodyText: "I'll send the budget." }));
  const came = Array.from({ length: SEVERAL }, (_, i) => msg({ accountId, from: who(i), to: [me], inInbox: false, listId: null, providerMsgId: `several-${i}-in`, providerThreadId: `several-${i}`, subject: `Re: Board ${i}`, date: now - 3_600_000 - i, bodyText: "The board meets Thursday at 9:00; the dues are due Friday." }));
  const outs = (await store.sync.ingest(sent, { applyFilters: false, now, classifier: null, liveSent: { wanted: true } })).inserted;
  const ins = (await store.sync.ingest(came, { applyFilters: false, now, classifier: null, datedMail: { since: null } })).inserted;
  expect([outs.length, ins.length]).toEqual([SEVERAL, SEVERAL]);
  const day = (n: number) => todayKey(now + n * DAY);
  for (let i = 0; i < SEVERAL; i++) {
    const src = (await store.dated.source(ins[i]!))!;
    const rows = [
      { kind: "event" as const, item: 0, text: "Board meeting", quote: "The board meets Thursday", dueDay: day(4), dueAt: now + 4 * DAY, timed: true, dated: true, actAt: now + 30_000 + i },
      { kind: "pay" as const, item: 1, text: "Pay the dues", quote: "the dues are due Friday", dueDay: day(5), dueAt: now + 5 * DAY, timed: false, dated: true, actAt: now + 30_000 + i },
    ];
    expect(await store.dated.finish({ messageId: ins[i]!, threadId: src.threadId, fromScan: false, rows, settled: [], now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
    const promise = (item: number, text: string, dueAt: number, dated: boolean) => ({ kind: "promise" as const, item, text, quote: "I'll send the budget", personName: who(i).name, personEmail: who(i).email, dueAt, dated });
    await store.followups.finish({ messageId: outs[i]!, threadId: src.threadId, fromScan: false, rows: [promise(0, "send the budget", now + 3 * DAY, true), promise(1, "call back", now + DAY, false)], kept: [], now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.followups.clearGeneration() });
  }
  // the facts of what came in: until then the count has no waiting number to add to
  while (!(await store.facts.idle())) await store.facts.backfill({ limit: 5000 });
}

async function run(kind: "SQLite" | "IndexedDB", budget: { spread: Gate; bound: Gate; needs: Gate; busyMs: number }) {
  const platform = { uuid: () => crypto.randomUUID(), yield: () => new Promise<void>((resolve) => setImmediate(resolve)) };
  let store: MailStore | undefined;
  let accountId: number;
  const path = join(dir, `${kind}.db`);
  if (kind === "IndexedDB") {
    const idb = await IdbMailStore.open({ name: "today-perf", factory: indexedDB, instantSearch: false, platform });
    const seeded = await idb.dev.seed(generateDataset({ threads: 52_000, accounts: 2, seed: 204, now: NOW, bodyScale: 0.02 }), { now: NOW, categorizeRate: 0 });
    accountId = seeded.accountIds[0]!;
    store = idb;
  } else accountId = copyMailbox(LARGE_MAILBOX, path).accountIds[0]!;
  const clock = { now: NOW };
  const backend = new Backend({ dbPath: path, store, platform: store ? platform : undefined, version: "t", cipher: plaintextCipher, providers: demoRegistry, autoSync: false, demoAi: true, now: () => clock.now });
  await backend.store.ready;
  await backend.ready;
  try {
    const [c, s] = createMemoryTransportPair();
    backend.connect(s, { clientId: "r", origin: "renderer" });
    const client = new RpcClient(c);
    await client.call("settings.update", { ai: { provider: "fake" } });
    // seeded first: the reader, once on, would read (and drop) mail from before it went on
    await seedDatedItems({ store: backend.store, accountId, now: NOW, budget: MULT, log: () => {} });
    // the soonest stay at the bound: these take the place of the furthest SEVERAL * 2 of those
    await severalPerThread(backend.store, accountId, NOW);
    await client.call("settings.update", { dated: { enabled: true }, followups: { enabled: true } });
    // a turn between calls, as between two requests: the store answers synchronously on SQLite
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    const measure = async (label: string, at: number, gate: Gate) => {
      clock.now = at;
      backend.today.touched();
      const lists: number[] = [];
      const counts: number[] = [];
      // plan 145's own count, in the same turns: what this plan adds is the difference
      const needs: number[] = [];
      const loop = watchLoop(budget.busyMs * MULT);
      for (let i = 0; i < 20; i++) {
        await turn();
        let t = performance.now();
        await backend.today.list([]);
        lists.push(performance.now() - t);
        const raw = await backend.store.threads.counts(clock.now);
        await turn();
        t = performance.now();
        await backend.today.withCount(raw);
        counts.push(performance.now() - t);
        await turn();
        t = performance.now();
        await backend.store.today.needsCount(clock.now);
        needs.push(performance.now() - t);
      }
      const report = loop.stop();
      const added = p95(counts) - p95(needs);
      process.stderr.write(`[${kind}] ${label}: today.list p95 ${p95(lists).toFixed(1)} ms, count p95 ${p95(counts).toFixed(1)} ms (plan 145's ${p95(needs).toFixed(1)}, so ${added.toFixed(1)} added), longest busy ${report.longest.busy.toFixed(1)} ms\n`);
      expect(report.longest.busy).toBeLessThanOrEqual(budget.busyMs * MULT);
      expect(p95(lists)).toBeLessThanOrEqual(gate.listMs * MULT);
      expect(added).toBeLessThanOrEqual(gate.addedMs * MULT);
      expect(p95(needs)).toBeLessThanOrEqual(gate.needsMs * MULT);
      expect(p95(counts)).toBeLessThanOrEqual(gate.countMs * MULT);
    };
    // as a mailbox has them: the items spread over the coming weeks, a few for today, the rest Coming up
    await measure("spread", NOW, budget.spread);
    // the bound: every item's time to act has come, and the list holds all 1,000, a conversation once (each of SEVERAL
    // with its next item said beside it)
    clock.now = NOW + 2 * DAY;
    backend.today.touched();
    const all = (await client.call("today.list", { heldIds: [] })).sections.flatMap((x) => x.items);
    expect(all.length).toBeGreaterThanOrEqual(1000 - SEVERAL);
    expect(all.filter((i) => i.also).length).toBe(SEVERAL);
    await measure("all showing", NOW + 2 * DAY, budget.bound);
    // plan 204, the second panel round: Needs you full (NEEDS_WALK conversations), each on the tighter rule's slowest
    // path: a snippet that starts like a thanks (its body read), a body that says more, a current summary to parse
    await needsAtBound(backend.store, client, accountId, NOW + 2 * DAY);
    await measure("Needs you at its bound", NOW + 2 * DAY, budget.needs);
  } finally {
    await backend.stop();
  }
}

describe("Today at 50k threads with 1,000 dated items (plan 204 revision 12)", () => {
  // the count is plan 145's walk and what this plan adds to it: at most 2 ms spread, 4 ms with a thousand threads to check
  // Needs you's own walk: about 7 ms (SQLite) and 5 ms (IndexedDB) as mailboxes have it, about 28 and 8 with all 2,000 on its slowest path
  it("SQLite", async () => run("SQLite", { spread: { listMs: 20, addedMs: 2, needsMs: 12, countMs: 14 }, bound: { listMs: 30, addedMs: 4, needsMs: 12, countMs: 14 }, needs: { listMs: 45, addedMs: 5, needsMs: 40, countMs: 42 }, busyMs: 60 }), 600_000);
  it("IndexedDB", async () => run("IndexedDB", { spread: { listMs: 20, addedMs: 2, needsMs: 10, countMs: 12 }, bound: { listMs: 30, addedMs: 4, needsMs: 10, countMs: 12 }, needs: { listMs: 15, addedMs: 3, needsMs: 12, countMs: 14 }, busyMs: 60 }), 900_000);
});
