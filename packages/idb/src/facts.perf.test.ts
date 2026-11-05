import "fake-indexeddb/auto";
/**
 * Plan 17's backfill at scale on IndexedDB (fake-indexeddb): from the upgrade's state to every thread's facts through
 * the backend's runner. Slices are commands on the late tables (they wait for messages to load). The gate is the event
 * loop's longest stall less the collections inside it (a large mirror's heap is not ours to collect), with
 * fake-indexeddb's own synchronous cloning in it (Chromium clones off the main thread): 48 ms, as the autocomplete gate.
 * Then a store dropped inside a giant conversation, without closing: a new one on the same database resumes from what
 * committed and ends the same.
 *
 * What's big stays big (Codex's revision 4): first use visits every thread, cold, and all 145,000 are pending, where the
 * queue walks rather than sorts (140,000 of them empty, written straight into the mirror: seeding their mail was
 * minutes, and what a slice computes for a thread follows its messages, not how many threads wait); and two
 * conversations above 4,096 messages go by chunks, many slices each.
 */
import { generateDataset } from "@terno/mock-data";
import type { IncomingMessage, MailStore, Platform } from "@terno/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeGap, stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";
import { FACTS_SLICE, FactsBackfill } from "../../backend/src/facts";
import { BIG_THREAD } from "./facts";
import { IdbMailStore } from "./store";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const MULT = Number(env.PERF_BUDGET_MULTIPLIER ?? "1");
const NOW = Date.UTC(2026, 9, 22, 15, 30);
const STALL_MS = 48;
const ATTEMPTS = 3;
const platform: Pick<Platform, "uuid" | "yield"> = { uuid: () => crypto.randomUUID(), yield: () => new Promise((r) => setTimeout(r, 0)) };
const name = `facts-perf-${Date.now()}`;

function giantThread(accountId: number, me: string, n: number, key = "giant", trash = false): IncomingMessage[] {
  return Array.from({ length: n }, (_, i) => {
    // a person's first, then all yours: the walk runs to the window's end (Codex review 1, #1)
    const mine = i > 0;
    return {
      accountId,
      providerMsgId: `${key}-${i}`,
      providerThreadId: key,
      rfcMessageId: `${key}-${i}@perf.test`,
      inReplyTo: i ? `${key}-${i - 1}@perf.test` : null,
      references: i ? [`${key}-${i - 1}@perf.test`] : [],
      from: mine ? { name: "Me", email: me } : { name: "Carlos", email: "carlos@acme.com" },
      to: [mine ? { name: "Carlos", email: "carlos@acme.com" } : { name: "Me", email: me }],
      cc: [],
      bcc: [],
      subject: i ? "Re: el proyecto" : "El proyecto",
      date: NOW - (n - i) * 60_000,
      snippet: "",
      bodyText: `Mensaje ${i}`,
      bodyHtml: null,
      bodyState: "full",
      listId: null,
      isRead: true,
      isStarred: false,
      inInbox: !mine && !trash,
      isSent: mine,
      isDraft: false,
      isTrash: trash,
      isSpam: false,
      hasAttachments: false,
      size: 100,
    };
  });
}


async function runBackfill(store: MailStore, stopAfter?: (r: { phase: string; processed: number }) => boolean): Promise<number> {
  let slices = 0;
  let stop = false;
  const counted = {
    isOpen: true,
    facts: {
      idle: () => store.facts.idle(),
      backfill: async (o: { limit: number }) => {
        // a "kill": no slice starts once asked to stop (the ones done are committed)
        if (stop) throw new Error("killed");
        slices++;
        const r = await store.facts.backfill(o);
        if (stopAfter?.(r)) stop = true;
        return r;
      },
    },
  } as unknown as MailStore;
  const runner = new FactsBackfill({ store: counted, platform, notifyChanged: () => {}, log: () => {} }, FACTS_SLICE);
  runner.wake();
  await runner.idle();
  return slices;
}

type ThreadRow = Record<string, unknown>;
const mirror = (s: IdbMailStore) => (s as unknown as { c: { facts: { big: { rows: unknown[] } | null }; db: { table(name: string): { rows: Map<number, ThreadRow>; load(row: ThreadRow): void } } } }).c;

describe("the facts backfill at 145,000 threads (IndexedDB)", () => {
  let store: IdbMailStore;
  let ids: number[];
  /** the threads with real mail: their facts as ingest left them */
  let expected: (readonly [number, unknown, unknown])[];
  const facts = (s: IdbMailStore) => {
    const rows = mirror(s).db.table("threads").rows;
    return ids.map((id) => [id, rows.get(id)!.person ?? null, rows.get(id)!.waiting_since ?? null] as const);
  };

  const reopen = async () => {
    await store.close();
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    await store.whenLoaded();
  };
  /** the store as a restart finds it after an upgrade: nothing computed, nothing kept in memory */
  async function upgraded(): Promise<IdbMailStore> {
    await store.debug.resetFacts();
    await reopen();
    return store;
  }
  /** threads with no mail, waiting like the rest */
  function moreThreads(s: IdbMailStore): void {
    const threads = mirror(s).db.table("threads");
    const top = Math.max(...threads.rows.keys());
    for (let i = 1; threads.rows.size < 145_000; i++) threads.load({ id: top + i, account_id: 1, last_date: i, message_count: 0, unread_count: 0, in_inbox: 0, in_trash: 0, in_spam: 0, person: null, waiting_since: null });
  }

  beforeAll(async () => {
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    const data = generateDataset({ threads: 5_000, accounts: 4, seed: 17, now: NOW, bodyScale: 1 });
    const seeded = await store.dev.seed(data, { now: NOW });
    const giant = giantThread(seeded.accountIds[0]!, data.accounts[0]!.email, 3 * BIG_THREAD + 100).concat(giantThread(seeded.accountIds[0]!, data.accounts[0]!.email, 2 * BIG_THREAD + 100, "giant-trash", true));
    for (let i = 0; i < giant.length; i += 5000) await store.sync.ingest(giant.slice(i, i + 5000), { applyFilters: false, now: NOW, classifier: null });
    ids = [...mirror(store).db.table("threads").rows.keys()];
    expect(ids.length, "more than the queue sorts on the spot").toBeGreaterThan(4_096);
    expected = facts(store);
    expect(expected.some(([, p]) => p) && expected.some(([, , w]) => w !== null)).toBe(true);
  }, 600_000);

  afterAll(async () => {
    await store?.close();
  });

  it("a store dropped inside a giant conversation, without closing: a new one on the same database resumes from what committed and ends the same", { timeout: 300_000 }, async () => {
    const dropped = await upgraded();
    // to the second chunk of a long conversation, then the instance is abandoned: its runner stops, nothing closes it
    let chunks = 0;
    await runBackfill(dropped, () => {
      if (mirror(dropped).facts.big?.rows.length) chunks++;
      return chunks >= 2;
    });
    expect(chunks, "stopped inside a conversation read in chunks").toBe(2);
    const big = mirror(dropped).facts.big;
    expect(big).not.toBeNull();
    const resumed = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    store = resumed;
    await resumed.whenLoaded();
    const pending = [...mirror(resumed).db.table("threads").rows.values()].filter((t) => t.person == null).length;
    console.log(`facts backfill (IndexedDB): dropped with ${pending} of ${ids.length} threads pending`);
    expect(pending).toBeGreaterThan(0);
    expect(await resumed.facts.idle()).toBe(false);
    await runBackfill(resumed);
    expect(facts(resumed)).toEqual(expected);
  });

  it(`backfills in slices, the event loop never held past ${STALL_MS} ms (less its collections), to what ingest computes`, { timeout: 300_000 }, async () => {
    const runs: { stall: number; ms: number; slices: number; line: string }[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS && !(runs.length && Math.min(...runs.map((r) => r.stall)) <= STALL_MS * MULT); attempt++) {
      moreThreads(await upgraded());
      const loop = watchLoop(STALL_MS * MULT);
      const gc = watchGc();
      const started = performance.now();
      const slices = await runBackfill(store);
      const ms = performance.now() - started;
      const r = loop.stop();
      const stall = stallLessGc(r, await gc.stop());
      runs.push({ stall, ms: ms - r.held, slices, line: `${(ms - r.held).toFixed(0)} ms, ${slices} slices, stall ${stall.toFixed(1)} ms less GC (${r.stall.toFixed(1)} with it; longest gap ${describeGap(r.longest)}; ${r.descheduled.length} descheduled)` });
      expect(facts(store)).toEqual(expected);
    }
    for (const run of runs) console.log(`facts backfill (IndexedDB, ${mirror(store).db.table("threads").rows.size} threads): ${run.line}`);
    const best = runs.reduce((a, b) => (b.stall < a.stall ? b : a));
    expect(best.stall, best.line).toBeLessThanOrEqual(STALL_MS * MULT);
    // the whole backfill is seconds, linear in the threads: what a slice costs that stays within its stall (a sort of all
    // of them per slice is 40 ms, and 4 minutes in all) shows here
    expect(Math.min(...runs.map((r) => r.ms)), "the whole backfill (ms)").toBeLessThanOrEqual(30_000 * MULT);
  });
});
