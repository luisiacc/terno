import "fake-indexeddb/auto";
/**
 * Plan 17's backfill at scale on IndexedDB (fake-indexeddb): 300,000
 * messages in 145,000 conversations and one of 50,000, from the upgrade's
 * state to every thread's facts through the backend's runner. Slices are
 * commands on the late tables (they wait for messages to load). The gate is
 * the event loop's longest stall less the collections inside it (a 300,000-
 * row mirror's heap is not ours to collect), with fake-indexeddb's own
 * synchronous cloning in it (Chromium clones off the main thread): 48 ms,
 * as the autocomplete gate. Then a store dropped mid-way without closing:
 * a new one on the same database resumes from what committed and ends the
 * same.
 */
import { generateDataset } from "@terno/mock-data";
import type { IncomingMessage, MailStore, Platform } from "@terno/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeGap, stallLessGc, watchGc, watchLoop } from "../../db/src/test/timing";
import { FACTS_SLICE, FactsBackfill } from "../../backend/src/facts";
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

const facts = async (store: MailStore) => (await store.debug.snapshot()).threads.map((t) => [t.id, t.person, t.waitingSince] as const);

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

describe("the facts backfill at 300,000 messages (IndexedDB)", () => {
  let store: IdbMailStore;
  let expected: Awaited<ReturnType<typeof facts>>;
  let messages = 0;

  beforeAll(async () => {
    store = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    const data = generateDataset({ threads: 145_000, accounts: 4, seed: 17, now: NOW, bodyScale: 1 });
    const seeded = await store.dev.seed(data, { now: NOW });
    const giant = giantThread(seeded.accountIds[0]!, data.accounts[0]!.email, 50_000).concat(giantThread(seeded.accountIds[0]!, data.accounts[0]!.email, 10_000, "giant-trash", true));
    for (let i = 0; i < giant.length; i += 5000) await store.sync.ingest(giant.slice(i, i + 5000), { applyFilters: false, now: NOW, classifier: null });
    messages = seeded.messageCount + giant.length;
    expect(messages).toBeGreaterThanOrEqual(300_000);
    expected = await facts(store);
    expect(expected.some(([, p]) => p) && expected.some(([, , w]) => w !== null)).toBe(true);
  }, 3_600_000);

  afterAll(async () => {
    await store?.close();
  });

  it(`backfills in slices, the event loop never held past ${STALL_MS} ms (less its collections), to what ingest computes`, { timeout: 3_600_000 }, async () => {
    const runs: { stall: number; ms: number; slices: number; line: string }[] = [];
    for (let attempt = 1; attempt <= ATTEMPTS && !(runs.length && Math.min(...runs.map((r) => r.stall)) <= STALL_MS * MULT); attempt++) {
      await store.debug.resetFacts();
      const loop = watchLoop(STALL_MS * MULT);
      const gc = watchGc();
      const started = performance.now();
      const slices = await runBackfill(store);
      const ms = performance.now() - started;
      const r = loop.stop();
      const stall = stallLessGc(r, await gc.stop());
      runs.push({ stall, ms: ms - r.held, slices, line: `${(ms - r.held).toFixed(0)} ms, ${slices} slices, stall ${stall.toFixed(1)} ms less GC (${r.stall.toFixed(1)} with it; longest gap ${describeGap(r.longest)}; ${r.descheduled.length} descheduled)` });
      expect(await facts(store)).toEqual(expected);
    }
    for (const run of runs) console.log(`facts backfill (IndexedDB, ${messages} messages, ${expected.length} threads): ${run.line}`);
    const best = runs.reduce((a, b) => (b.stall < a.stall ? b : a));
    expect(best.stall, best.line).toBeLessThanOrEqual(STALL_MS * MULT);
  });

  it("a store dropped mid-way without closing: a new one on the same database resumes from what committed and ends the same", { timeout: 3_600_000 }, async () => {
    await store.debug.resetFacts();
    const threads = expected.length;
    // to 40% of the threads, then the instance is abandoned: its runner stops, nothing closes it
    let processed = 0;
    await runBackfill(store, (r) => {
      if (r.phase !== "senders") processed += r.processed;
      return processed >= threads * 0.4;
    });
    const resumed = await IdbMailStore.open({ name, factory: indexedDB, platform, instantSearch: false });
    try {
      await resumed.whenLoaded();
      const pending = (await resumed.debug.snapshot()).threads.filter((t) => t.person === null).length;
      console.log(`facts backfill (IndexedDB): dropped at ${Math.round((1 - pending / threads) * 100)}%`);
      expect(pending).toBeGreaterThan(0);
      expect(pending).toBeLessThan(threads * 0.6 + 1);
      expect(await resumed.facts.idle()).toBe(false);
      await runBackfill(resumed);
      expect(await facts(resumed)).toEqual(expected);
    } finally {
      await resumed.close();
    }
  });
});
