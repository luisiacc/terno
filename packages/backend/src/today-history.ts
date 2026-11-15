import { DATED_CLOSED_KEEP_MS, historyAfter, historyOrder, refKey, type DatedRow, type FeedRowId, type FollowupRow, type HistoryKey, type HistoryOutcome, type ItemRef, type ThreadSummary, type TodayHistoryItem, type TodayHistoryPage } from "@terno/core";
import type { ClosedAt, MailStore } from "@terno/store";
import { withoutUntrusted } from "./suspicious-sender";

/**
 * Plan 210: What matters' history, one page. Iteration 2 (a row per item): a line is a closed item (a dated item done,
 * removed, settled or over; a promise of yours done or removed) in the keep's window, whatever else its conversation has
 * open; true duplicates are one line, at their newest closing, and none while any of them is open. Never in Spam or
 * Trash, never a row the feed holds in the open part. Whether a closing is a line depends only on the data (its item's
 * members, read in a batch a page), so pages taken by key (`historyOrder`: newest first, a dated item before a promise at
 * the same moment, then the higher id) never repeat or skip one: what closes meanwhile is newer than any key, and what
 * reopens leaves.
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
  /** the rows the feed holds in the open part (their ids): never a history line */
  held: ReadonlySet<FeedRowId>;
  dated: boolean;
  promises: boolean;
  /** Codex code review: a walk past many left-out rows gives the event loop back between reads, within the slice's budget */
  yieldTurn: () => Promise<void>;
  sliceMs: number;
}

const outcomeOf = (r: { state: string; closedReason: string | null }): HistoryOutcome => (r.state === "done" ? "done" : r.state === "settled" ? "settled" : r.closedReason === "expired" ? "over" : "dismissed");

type Row = (DatedRow & { src: 0 }) | (FollowupRow & { src: 1 });
const sourceOf = (src: 0 | 1): ItemRef["source"] => (src === 0 ? "dated" : "promise");
const keyOf = (r: Row): string => r.sameAs ?? refKey({ source: sourceOf(r.src), id: r.id });
const closingOf = (r: Row): HistoryKey => ({ at: r.closedAt!, src: r.src, id: r.id });
const open = (r: { state: string }): boolean => r.state === "open" || r.state === "due";

export async function historyPage(store: MailStore, o: HistoryAsk): Promise<TodayHistoryPage> {
  const since = o.now - DATED_CLOSED_KEEP_MS;
  // an item from an untrusted sender isn't shown (as in the open part, Codex's second pass of plan 204)
  const trusted = (rows: DatedRow[]) => withoutUntrusted(rows, (keys) => store.dated.written(keys));
  // each table strictly after the key, translated: at the key's moment a dated item comes before a promise
  const start = (src: 0 | 1): ClosedAt | null => (o.after ? historyAfter(o.after, src) : null);
  const dated: Source<Row> = { src: 0, after: start(0), buf: [], done: !o.dated, read: async (after) => (await store.dated.closedPage({ since, after, limit: READ_BATCH })).map((r) => ({ ...r, src: 0 as const })) };
  const promises: Source<Row> = { src: 1, after: start(1), buf: [], done: !o.promises, read: async (after) => (await store.followups.closedPage({ since, after, limit: READ_BATCH })).map((r) => ({ ...r, src: 1 as const })) };
  // what each read brought: its thread (Spam, Trash, gone), and each item's members: a merged item is a line once, at its
  // newest closing, and only when none of it is open (lone items, most, are their own and only member)
  const threads = new Map<number, ThreadSummary | null>();
  const groups = new Map<string, { open: boolean; newest: HistoryKey | null }>();
  const learn = async (rows: readonly Row[]) => {
    const keys = [...new Set(rows.map(keyOf))].filter((k) => !groups.has(k));
    const members = keys.length ? await store.today.members(keys) : { dated: [], promises: [] };
    // every member's conversation, and whether its sender is trusted: a merged item's line is its newest closing that may
    // show (Codex code review of iteration 2: one in Trash never hides the others')
    const fresh = [...new Set([...rows, ...members.dated, ...members.promises].map((r) => r.threadId))].filter((id) => !threads.has(id));
    const [summaries, kept] = await Promise.all([fresh.length ? store.threads.summaries(fresh) : [], trusted(members.dated)]);
    const byId = new Map(summaries.map((t) => [t.id, t]));
    for (const id of fresh) threads.set(id, byId.get(id) ?? null);
    const trustedIds = new Set(kept.map((r) => r.id));
    const shows = (m: Row) => {
      const t = threads.get(m.threadId);
      return !!t && !t.inSpam && !t.inTrash && (m.src === 1 || trustedIds.has(m.id));
    };
    for (const k of keys) groups.set(k, { open: false, newest: null });
    const all: Row[] = [...members.dated.map((r) => ({ ...r, src: 0 as const })), ...members.promises.map((r) => ({ ...r, src: 1 as const }))];
    for (const m of all) {
      const g = groups.get(keyOf(m));
      if (!g) continue;
      if (open(m)) g.open = true;
      else if (m.closedAt !== null && m.closedAt >= since && shows(m) && (!g.newest || historyOrder(closingOf(m), g.newest) < 0)) g.newest = closingOf(m);
    }
  };
  let slice = performance.now();
  const breathe = async () => {
    if (performance.now() - slice < o.sliceMs) return;
    await o.yieldTurn();
    slice = performance.now();
  };
  const fill = async (s: Source<Row>, keep: (rows: Row[]) => Promise<readonly Row[]>) => {
    // a whole batch left out (an untrusted sender's items) reads on
    while (!s.buf.length && !s.done) {
      await breathe();
      const rows = await s.read(s.after);
      if (rows.length < READ_BATCH) s.done = true;
      if (!rows.length) return;
      const last = rows.at(-1)!;
      s.after = { at: last.closedAt!, id: last.id };
      const kept = await keep(rows);
      await learn(kept);
      s.buf.push(...kept);
    }
  };
  const datedTrusted = async (rows: Row[]) => (await trusted(rows as DatedRow[])) as Row[];
  const all = async (rows: Row[]) => rows;
  const items: TodayHistoryItem[] = [];
  let next: HistoryKey | null = null;
  for (;;) {
    await Promise.all([fill(dated, datedTrusted), fill(promises, all)]);
    const heads = [dated.buf[0], promises.buf[0]].filter((r): r is Row => !!r).map((r) => ({ key: closingOf(r), source: r.src === 0 ? dated : promises }));
    if (!heads.length) {
      next = null;
      break;
    }
    const head = heads.sort((a, b) => historyOrder(a.key, b.key))[0]!;
    if (o.through && historyOrder(head.key, o.through) > 0) {
      // past the line the renderer had: the rest is the next page's, from the last line here, or (none left above it, all
      // gone meanwhile: Codex code review) from that line itself, so nothing older is lost
      next = items.at(-1)?.key ?? o.through;
      break;
    }
    const row = head.source.buf.shift()!;
    const thread = threads.get(row.threadId);
    const id = keyOf(row);
    const group = groups.get(id);
    // a merged item's line is its newest closing's, and it has none while any of it is open
    if (!thread || thread.inSpam || thread.inTrash || o.held.has(id) || !group || group.open || !group.newest || historyOrder(group.newest, head.key) !== 0) continue;
    items.push({ id, item: { source: sourceOf(row.src), id: row.id }, thread, key: head.key, outcome: outcomeOf(row), kind: row.src === 0 ? row.kind : "promise", text: row.text });
    if (!o.through && items.length >= o.limit) {
      next = head.key;
      break;
    }
  }
  return { items, next };
}
