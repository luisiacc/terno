import { DATED_CLOSED_KEEP_MS, historyAfter, historyOrder, type DatedRow, type FollowupRow, type HistoryKey, type HistoryOutcome, type ThreadSummary, type TodayHistoryItem, type TodayHistoryPage } from "@terno/core";
import type { ClosedAt, MailStore } from "@terno/store";
import { withoutUntrusted } from "./suspicious-sender";

/**
 * Plan 210: What matters' history, one page. A line is a conversation's newest closing (a dated item done, not a task,
 * settled or over; a promise of yours done or not a promise) in the keep's window, unless the conversation is in the open
 * part, held there, or in Spam or Trash. Whether a closing is a line depends only on the data, so pages taken by key
 * (`historyOrder`: newest first, a dated item before a promise at the same moment, then the higher id) never repeat or
 * skip one: what closes meanwhile is newer than any key, and what reopens leaves.
 */

/** How many rows each table's read takes at a time; a page past what's eligible reads on. */
const READ_BATCH = 100;

interface Source<R> {
  src: 0 | 1;
  after: ClosedAt | null;
  buf: R[];
  done: boolean;
  read: (after: ClosedAt | null) => Promise<R[]>;
}

export interface HistoryAsk {
  now: number;
  /** strictly after this line (a next page), or from the top */
  after: HistoryKey | null;
  /** from the top down to and including this line (a reload keeping the depth it had); else `limit` lines */
  through: HistoryKey | null;
  limit: number;
  /** the open part's conversations and the held ones: never a history line */
  exclude: ReadonlySet<number>;
  dated: boolean;
  promises: boolean;
}

const outcomeOf = (r: { state: string; closedReason: string | null }): HistoryOutcome => (r.state === "done" ? "done" : r.state === "settled" ? "settled" : r.closedReason === "expired" ? "over" : "dismissed");

export async function historyPage(store: MailStore, o: HistoryAsk): Promise<TodayHistoryPage> {
  const since = o.now - DATED_CLOSED_KEEP_MS;
  // each table strictly after the key, translated: at the key's moment a dated item comes before a promise
  const start = (src: 0 | 1): ClosedAt | null => (o.after ? historyAfter(o.after, src) : null);
  const dated: Source<DatedRow> = { src: 0, after: start(0), buf: [], done: !o.dated, read: (after) => store.dated.closedPage({ since, after, limit: READ_BATCH }) };
  const promises: Source<FollowupRow> = { src: 1, after: start(1), buf: [], done: !o.promises, read: (after) => store.followups.closedPage({ since, after, limit: READ_BATCH }) };
  // what each read brought: each thread's newest closing, and the thread (Spam, Trash, gone)
  const newest = new Map<number, HistoryKey>();
  const threads = new Map<number, ThreadSummary | null>();
  const learn = async (ids: readonly number[]) => {
    const fresh = [...new Set(ids)].filter((id) => !threads.has(id));
    if (!fresh.length) return;
    const [d, p, summaries] = await Promise.all([o.dated ? store.dated.newestClosed(fresh, since) : new Map<number, ClosedAt>(), o.promises ? store.followups.newestClosed(fresh, since) : new Map<number, ClosedAt>(), store.threads.summaries(fresh)]);
    const byId = new Map(summaries.map((t) => [t.id, t]));
    for (const id of fresh) {
      threads.set(id, byId.get(id) ?? null);
      const keys = [d.get(id) && { at: d.get(id)!.at, src: 0 as const, id: d.get(id)!.id }, p.get(id) && { at: p.get(id)!.at, src: 1 as const, id: p.get(id)!.id }].filter((k): k is HistoryKey => !!k);
      const top = keys.sort(historyOrder)[0];
      if (top) newest.set(id, top);
    }
  };
  const fill = async <R extends { threadId: number; id: number; closedAt: number | null }>(s: Source<R>, keep: (rows: R[]) => Promise<readonly R[]>) => {
    if (s.buf.length || s.done) return;
    const rows = await s.read(s.after);
    if (rows.length < READ_BATCH) s.done = true;
    if (!rows.length) return;
    const last = rows.at(-1)!;
    s.after = { at: last.closedAt!, id: last.id };
    await learn(rows.map((r) => r.threadId));
    s.buf.push(...(await keep(rows)));
    // a whole batch left out (an untrusted sender's items): read on
    if (!s.buf.length) await fill(s, keep);
  };
  // an item from an untrusted sender isn't shown (as in the open part, Codex's second pass of plan 204)
  const trusted = (rows: DatedRow[]) => withoutUntrusted(rows, (keys) => store.dated.written(keys));
  const all = async (rows: FollowupRow[]) => rows;
  const items: TodayHistoryItem[] = [];
  const seen = new Set<number>();
  let next: HistoryKey | null = null;
  for (;;) {
    await Promise.all([fill(dated, trusted), fill(promises, all)]);
    const heads = [dated.buf[0] && { key: { at: dated.buf[0].closedAt!, src: 0 as const, id: dated.buf[0].id }, source: dated }, promises.buf[0] && { key: { at: promises.buf[0].closedAt!, src: 1 as const, id: promises.buf[0].id }, source: promises }].filter((h) => !!h);
    if (!heads.length) {
      next = null;
      break;
    }
    const head = heads.sort((a, b) => historyOrder(a.key, b.key))[0]!;
    if (o.through && historyOrder(head.key, o.through) > 0) {
      // past the line the renderer had: the rest is the next page's
      next = items.at(-1)?.key ?? null;
      break;
    }
    const row = head.source.buf.shift()! as DatedRow | FollowupRow;
    const thread = threads.get(row.threadId);
    const top = newest.get(row.threadId);
    if (!thread || thread.inSpam || thread.inTrash || o.exclude.has(row.threadId) || seen.has(row.threadId) || !top || historyOrder(top, head.key) !== 0) continue;
    seen.add(row.threadId);
    items.push({ thread, key: head.key, outcome: outcomeOf(row), kind: head.key.src === 0 ? (row as DatedRow).kind : "promise", text: row.text });
    if (!o.through && items.length >= o.limit) {
      next = head.key;
      break;
    }
  }
  return { items, next };
}
