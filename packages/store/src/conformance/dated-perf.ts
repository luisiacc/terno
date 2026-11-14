import { DATED_ACTIVE_MAX, DATED_OPEN_SHOWN, DATED_SCAN_DAYS, DATED_SCAN_MAX } from "@terno/core";
import { expect } from "vitest";
import type { DatedWrite } from "../dated";
import { msg } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

const SENDERS = 10;

/**
 * Plan 204's open set at its bound in a 50k+ mailbox: 1,000 received messages from ten senders, each with one open item,
 * written as the worker writes them (marked by ingest, then a finish each). Archived mail, so nothing else's view changes.
 */
export async function seedDatedItems(o: WorkloadMailbox): Promise<{ id: number; thread: number; senderKey: string; date: number }[]> {
  const { store, accountId } = o;
  const out: { id: number; thread: number; senderKey: string; date: number }[] = [];
  for (let slice = 0; slice < DATED_ACTIVE_MAX / 100; slice++) {
    const batch = Array.from({ length: 100 }, (_, i) => msg({ accountId, from: { name: "Biller", email: `biller${(slice * 100 + i) % SENDERS}@perf.test` }, to: [{ name: "Me", email: "me@perf.test" }], inInbox: false, providerMsgId: `dated-${slice}-${i}`, subject: `Bill ${slice}-${i}`, date: o.now - 10_000 - slice * 100 - i, bodyText: "Due on the 20th" }));
    const r = await store.sync.ingest(batch, { applyFilters: false, now: o.now, classifier: null, datedMail: { since: null } });
    for (const id of r.inserted) {
      const src = (await store.dated.source(id))!;
      out.push({ id, thread: src.threadId, senderKey: src.senderKey, date: src.date });
    }
  }
  let n = 0;
  for (const { id, thread } of out) {
    const row: DatedWrite = { kind: n % 3 ? "pay" : "event", item: 0, text: "Pay the bill", quote: "Due on the 20th", dueDay: "2026-11-20", dueAt: o.now + 86_400_000 + n, timed: false, dated: true, actAt: o.now + n * 60_000, };
    n++;
    expect(await store.dated.finish({ messageId: id, threadId: thread, fromScan: false, rows: [row], settled: [], now: o.now, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() })).toBe("written");
  }
  return out;
}

export async function measureDated(o: WorkloadMailbox): Promise<void> {
  const { store } = o;
  await expectMailbox(o, {});
  const seed = performance.now();
  const sources = await seedDatedItems(o);
  o.log(`1,000 dated items written in ${(performance.now() - seed).toFixed(0)} ms`);
  expect(await store.dated.active()).toHaveLength(DATED_ACTIVE_MAX);
  const timed = async (runs: number, work: (i: number) => Promise<unknown>) => {
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await work(i);
      times.push(performance.now() - start);
    }
    return [...times].sort((a, b) => a - b)[Math.ceil(runs * 0.95) - 1]!;
  };
  // a sender with a hundred open items: what a new message of theirs is shown to settle
  const open = await store.dated.openFor({ threadId: sources[0]!.thread, senderKey: sources[0]!.senderKey, before: o.now, limit: DATED_OPEN_SHOWN });
  expect(open).toHaveLength(DATED_OPEN_SHOWN);
  const active = await timed(20, () => store.dated.active());
  const openFor = await timed(40, (i) => store.dated.openFor({ threadId: sources[i]!.thread, senderKey: sources[i]!.senderKey, before: o.now, limit: DATED_OPEN_SHOWN }));
  const thread = await timed(40, (i) => store.dated.ofThread(sources[i]!.thread));
  const source = await timed(40, (i) => store.dated.source(sources[i]!.id));
  const scan = await timed(5, () => store.dated.scanCandidates(o.now - DATED_SCAN_DAYS * 86_400_000, DATED_SCAN_MAX));
  o.log(`Dated: active ${active.toFixed(2)} ms, openFor ${openFor.toFixed(2)} ms, a thread's ${thread.toFixed(2)} ms, a source ${source.toFixed(2)} ms, the 14-day check's candidates ${scan.toFixed(2)} ms`);
  expect(active).toBeLessThanOrEqual(5 * o.budget);
  expect(openFor).toBeLessThanOrEqual(5 * o.budget);
  expect(thread).toBeLessThanOrEqual(5 * o.budget);
  expect(source).toBeLessThanOrEqual(5 * o.budget);
}
