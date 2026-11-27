import { DATED_ACTIVE_MAX, DATED_OPEN_SHOWN, DATED_SCAN_DAYS, DATED_SCAN_MAX } from "@terno/core";
import { expect } from "vitest";
import type { DatedWrite } from "../dated";
import { msg } from "./fixtures";
import { expectMailbox, type WorkloadMailbox } from "./perf";

const SENDERS = 10;
/** plan 211: a check's candidates, one account's (once an account, never on a hot path: the backend's slice budget) */
export const SCAN_MS = 25;
/** plan 211: the small account's mail in the window */
export const SMALL = 40;

/**
 * Plan 211 (revision 11): a small account beside the mailbox's, with `SMALL` messages of its own in the last days, as `over`
 * says; removed by the caller once measured, so the mailbox is left as it was.
 */
export async function smallAccount(o: WorkloadMailbox, over: (i: number) => Partial<Parameters<typeof msg>[0]>): Promise<{ id: number; ids: number[] }> {
  const { account } = await o.store.accounts.create({ kind: "imap", email: "small@perf.test", displayName: "Small", color: "brown", now: o.now });
  const r = await o.store.sync.ingest(Array.from({ length: SMALL }, (_, i) => msg({ accountId: account.id, inInbox: false, providerMsgId: `small-${i}`, date: o.now - 3_600_000 - i * 3_600_000, bodyText: "x", ...over(i) })), { applyFilters: false, now: o.now, classifier: null });
  return { id: account.id, ids: r.inserted };
}
/** plan 210: the history's first read after a bulk change, at twenty thousand closed rows (IndexedDB sorts them once) */
const COLD_MS = 8;

/**
 * Plan 204's open set at its bound in a 50k+ mailbox: 1,000 received messages from ten senders, each with one open item,
 * written as the worker writes them (marked by ingest, then a finish each). Archived mail, so nothing else's view changes.
 * `far` (plan 210, iteration 3: Coming up has no horizon): their days spread from two weeks to almost a year ahead, each
 * acted on a week before (a bill's lead): with the open set emptied first, they fill the bound, every one Coming up's.
 */
export async function seedDatedItems(o: WorkloadMailbox, round = 0, far = false): Promise<{ id: number; thread: number; senderKey: string; date: number }[]> {
  const { store, accountId } = o;
  const out: { id: number; thread: number; senderKey: string; date: number }[] = [];
  for (let slice = 0; slice < DATED_ACTIVE_MAX / 100; slice++) {
    const batch = Array.from({ length: 100 }, (_, i) => msg({ accountId, from: { name: "Biller", email: `biller${(slice * 100 + i) % SENDERS}@perf.test` }, to: [{ name: "Me", email: "me@perf.test" }], inInbox: false, providerMsgId: round ? `dated-r${round}-${slice}-${i}` : `dated-${slice}-${i}`, subject: `Bill ${round}-${slice}-${i}`, date: o.now - 10_000 - round * 1000 - slice * 100 - i, bodyText: "Due on the 20th" }));
    const r = await store.sync.ingest(batch, { applyFilters: false, now: o.now, classifier: null, datedMail: { since: null } });
    for (const id of r.inserted) {
      const src = (await store.dated.source(id))!;
      out.push({ id, thread: src.threadId, senderKey: src.senderKey, date: src.date });
    }
  }
  let n = 0;
  for (const { id, thread } of out) {
    const ahead = new Date(o.now);
    ahead.setDate(ahead.getDate() + 15 + (n % 340));
    const row: DatedWrite = far
      ? { kind: n % 3 ? "pay" : "event", item: 0, text: "Pay the bill", quote: "Due on the 20th", dueDay: `${ahead.getFullYear()}-${String(ahead.getMonth() + 1).padStart(2, "0")}-${String(ahead.getDate()).padStart(2, "0")}`, dueAt: ahead.getTime(), timed: false, dated: true, actAt: ahead.getTime() - 7 * 86_400_000 }
      : { kind: n % 3 ? "pay" : "event", item: 0, text: "Pay the bill", quote: "Due on the 20th", dueDay: "2026-11-20", dueAt: o.now + 86_400_000 + n, timed: false, dated: true, actAt: o.now + n * 60_000 };
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
  // plan 211 (revision 11): the check is one account's at a time. The mailbox's account, with the thousand just written in
  // its window; and a small one beside it, most of the mail in the other: its read never pays for the mailbox's
  const window = o.now - DATED_SCAN_DAYS * 86_400_000;
  const small = await smallAccount(o, (i) => ({ from: { name: "Shop", email: `shop${i}@perf.test` }, to: [{ name: "Me", email: "small@perf.test" }], subject: `Order ${i}` }));
  const scan = await timed(5, () => store.dated.scanCandidates(window, DATED_SCAN_MAX, o.accountId));
  const scanSmall = await timed(5, () => store.dated.scanCandidates(window, DATED_SCAN_MAX, small.id));
  expect(await store.dated.scanCandidates(window, DATED_SCAN_MAX, small.id)).toHaveLength(SMALL);
  expect(await store.dated.scanCandidates(window, DATED_SCAN_MAX, o.accountId)).not.toContain(small.ids[0]);
  await store.accounts.remove(small.id);
  o.log(`Dated: active ${active.toFixed(2)} ms, openFor ${openFor.toFixed(2)} ms, a thread's ${thread.toFixed(2)} ms, a source ${source.toFixed(2)} ms, the 14-day check's candidates ${scan.toFixed(2)} ms (a small account's ${scanSmall.toFixed(2)} ms)`);
  // the active read 5 → 6 ms (5.25 measured on SQLite, 2026-11-26): a small overrun, raised by the owner's call
  expect(active).toBeLessThanOrEqual(6 * o.budget);
  expect(openFor).toBeLessThanOrEqual(5 * o.budget);
  expect(thread).toBeLessThanOrEqual(5 * o.budget);
  expect(source).toBeLessThanOrEqual(5 * o.budget);
  expect(scan).toBeLessThanOrEqual(SCAN_MS * o.budget);
  expect(scanSmall).toBeLessThanOrEqual(SCAN_MS * o.budget);

  // plan 210: What matters' history pages through the closed rows by closing time. Twenty thousand closed within the keep
  // (the thousand open, closed, twenty times: far past a heavy quarter, each on its own conversation): its first page, a
  // deep one, and each thread's newest closing for a page's conversations, as the history reads them
  const CLOSED_ROUNDS = 20;
  let closed = 0;
  const closeAll = async () => {
    for (const { id } of await store.dated.active()) {
      const row = (await store.dated.get(id))!;
      await store.dated.update(row.id, row.revision, { state: closed % 4 ? "done" : "dismissed", closedReason: "user", closedAt: o.now - closed * 60_000 });
      closed++;
    }
  };
  await closeAll();
  for (let round = 1; round < CLOSED_ROUNDS; round++) {
    await seedDatedItems(o, round);
    await closeAll();
  }
  const since = o.now - 90 * 86_400_000;
  // cold: the first read after twenty thousand closings at once (IndexedDB builds its closing-time order here)
  const coldStart = performance.now();
  await store.dated.closedPage({ since, after: null, limit: 100 });
  const cold = performance.now() - coldStart;
  const all = await store.dated.closedPage({ since, after: null, limit: CLOSED_ROUNDS * DATED_ACTIVE_MAX });
  expect(all).toHaveLength(CLOSED_ROUNDS * DATED_ACTIVE_MAX);
  const deepKey = { at: all[19_000]!.closedAt!, id: all[19_000]!.id };
  const first = await timed(40, () => store.dated.closedPage({ since, after: null, limit: 100 }));
  const deep = await timed(40, () => store.dated.closedPage({ since, after: deepKey, limit: 100 }));
  const promises = await timed(40, () => store.followups.closedPage({ since, after: null, limit: 100 }));
  o.log(`History: cold (20,000 closed) ${cold.toFixed(1)} ms, a first page of closed items ${first.toFixed(2)} ms, a deep one ${deep.toFixed(2)} ms, closed promises ${promises.toFixed(2)} ms`);
  expect(cold).toBeLessThanOrEqual(COLD_MS * o.budget);
  expect(first).toBeLessThanOrEqual(5 * o.budget);
  expect(deep).toBeLessThanOrEqual(5 * o.budget);
  expect(promises).toBeLessThanOrEqual(5 * o.budget);
}
