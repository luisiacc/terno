import { changeLineId, DATED_CLOSED_KEEP_MS, datedGroup, HANDED, historyAfter, historyOrder, refKey, waitingDoneLineId, waitingRowId, type HistorySource, type DatedRow, type FeedRowId, type FollowupRow, type HistoryKey, type HistoryOutcome, type ItemRef, type SettledHow, type ThreadSummary, type TodayHistoryItem, type TodayHistoryPage } from "@terno/core";
import { ANSWERED_WITH_PROMISE, HELD_REQUEST_CLOSED, WAITING_CLOSED, type ClosedAt, type MailStore, type WaitingDone } from "@terno/store";
import { sameParcel } from "./dated-evidence";
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
  src: 0 | 1 | 4;
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
  /** plan 215: a conversation waiting on you marked Done (What matters' own: no reader's setting gates it) */
  waiting?: boolean;
  /**
   * Plan 210 (iteration 4, Change…): the open items the user changed (as the open part reads them: trusted, within the
   * bounds), each a "Changed" line at the moment of its change while it's open. Absent: none
   */
  changed?: { dated: readonly DatedRow[]; promises: readonly FollowupRow[] };
  /** plan 211: an account whose lines show (AI and What matters on); absent: every account's */
  shows?: (accountId: number) => boolean;
  /** plan 215: an account whose waiting Done lines show (What matters on, as its waiting rows); absent: every account's */
  showsWaiting?: (accountId: number) => boolean;
  /** Codex code review: a walk past many left-out rows gives the event loop back between reads, within the slice's budget */
  yieldTurn: () => Promise<void>;
  sliceMs: number;
}

// plan 210 (iteration 3, revision 4): a promise its person replaced (`finishDated`) is neither done nor removed; (iteration 4)
// one handed to a person by a confirmed forward says to whom
const outcomeOf = (r: { state: string; closedReason: string | null }): HistoryOutcome => (r.closedReason === "replaced" ? "replaced" : r.closedReason === HANDED && r.state === "done" ? "handed" : r.state === "done" ? "done" : r.state === "settled" ? "settled" : r.closedReason === "expired" ? "over" : "dismissed");

type Row = (DatedRow & { src: 0 }) | (FollowupRow & { src: 1 });
/** plan 210 (iteration 4): an open item the user changed, at its change */
type Changed = (DatedRow & { src: 2 }) | (FollowupRow & { src: 3 });
/** a dated item's line or its Changed line (0, 2), a promise's (1, 3); a waiting Done (4) is no item's */
const SOURCE_OF: Readonly<Record<0 | 1 | 2 | 3, ItemRef["source"]>> = { 0: "dated", 1: "promise", 2: "dated", 3: "promise" };
const sourceOf = (src: 0 | 1 | 2 | 3): ItemRef["source"] => SOURCE_OF[src];
/** plan 215: a waiting Done as a history row, keyed by its moment and its message */
type WaitingLine = WaitingDone & { src: 4; id: number; closedAt: number };
const keyOf = (r: Row | Changed): string => r.sameAs ?? refKey({ source: sourceOf(r.src), id: r.id });
const closingOf = (r: Row): HistoryKey => ({ at: r.closedAt!, src: r.src, id: r.id });
const REASKED: SettledHow = "reasked";
/** the claims ledger's third batch: a parcel over by its day while a newer notice of the same parcel in its conversation is open */
const superseded = (r: DatedRow, open: readonly DatedRow[] | undefined, from: string): boolean =>
  r.kind === "delivery" && r.closedReason === "expired" && !!open?.some((o) => o.kind === "delivery" && o.id !== r.id && o.arrivedAt > r.arrivedAt && sameParcel(r.text, o.text, from));
const open = (r: { state: string }): boolean => r.state === "open" || r.state === "due";
/** the claims ledger's third batch: the request a promise answers, settled by the very mail that kept the promise */
const answeredWith = (p: FollowupRow, r: DatedRow | null | undefined): boolean => !!r && r.state === "settled" && r.settledBy != null && r.settledBy === p.settledBy && r.threadId === p.threadId;

/**
 * Plan 210 (iteration 4): an open item's "Changed" line, one a canonical item (its members change together) at its newest
 * change in the keep's window, strictly after `after`, newest first. From what's in hand: no read.
 */
function changedLines(o: Pick<HistoryAsk, "changed" | "after">, since: number): { row: Changed; key: HistoryKey }[] {
  if (!o.changed) return [];
  const newest = new Map<string, { row: Changed; key: HistoryKey }>();
  const rows: Changed[] = [...o.changed.dated.map((r) => ({ ...r, src: 2 as const })), ...o.changed.promises.map((r) => ({ ...r, src: 3 as const }))];
  for (const row of rows) {
    if (row.changedAt == null || row.changedAt < since || (row.state !== "open" && row.state !== "due")) continue;
    const key: HistoryKey = { at: row.changedAt, src: row.src, id: row.id };
    const was = newest.get(keyOf(row));
    if (!was || historyOrder(key, was.key) < 0) newest.set(keyOf(row), { row, key });
  }
  return [...newest.values()].filter((c) => !o.after || historyOrder(c.key, o.after) > 0).sort((a, b) => historyOrder(a.key, b.key));
}

export async function historyPage(store: MailStore, o: HistoryAsk): Promise<TodayHistoryPage> {
  const since = o.now - DATED_CLOSED_KEEP_MS;
  // plan 211: a conversation whose line may show: here, in neither Spam nor Trash, of an account that's in
  const visible = (t: ThreadSummary | null | undefined): t is ThreadSummary => !!t && !t.inSpam && !t.inTrash && (!o.shows || o.shows(t.accountId));
  // an item from an untrusted sender isn't shown (as in the open part, Codex's second pass of plan 204)
  const trusted = (rows: DatedRow[]) => withoutUntrusted(rows, (keys) => store.dated.trusted(keys));
  // each table strictly after the key, translated: at the key's moment a dated item comes before a promise
  const start = (src: HistorySource): ClosedAt | null => (o.after ? historyAfter(o.after, src) : null);
  const dated: Source<Row> = { src: 0, after: start(0), buf: [], done: !o.dated, read: async (after) => (await store.dated.closedPage({ since, after, limit: READ_BATCH })).map((r) => ({ ...r, src: 0 as const })) };
  const promises: Source<Row> = { src: 1, after: start(1), buf: [], done: !o.promises, read: async (after) => (await store.followups.closedPage({ since, after, limit: READ_BATCH })).map((r) => ({ ...r, src: 1 as const })) };
  const waiting: Source<WaitingLine> = { src: 4, after: start(4), buf: [], done: o.waiting !== true, read: async (after) => (await store.today.waiting.donePage({ since, after, limit: READ_BATCH })).map((r) => ({ ...r, src: 4 as const, id: r.messageId, closedAt: r.at })) };
  // plan 215: a waiting Done's line shows while its conversation does (What matters' own switch) and doesn't wait again
  const waitingVisible = (t: ThreadSummary | null | undefined): t is ThreadSummary => !!t && !t.inSpam && !t.inTrash && t.waitingSince == null && (!o.showsWaiting || o.showsWaiting(t.accountId));
  // what each read brought: its thread (Spam, Trash, gone), and each item's members: a merged item is a line once, at its
  // newest closing, and only when none of it is open (lone items, most, are their own and only member)
  const threads = new Map<number, ThreadSummary | null>();
  const groups = new Map<string, { open: boolean; newest: HistoryKey | null }>();
  // the claims ledger's third batch: the request each promise closed by mail answers (`answers`), read with the members
  const requests = new Map<number, DatedRow | null>();
  // and (Diego's arm) the open items of each conversation with a parcel that's over, for the newer notice that replaced it
  const openIn = new Map<number, readonly DatedRow[]>();
  const learn = async (rows: readonly Row[]) => {
    const parcels = [...new Set(rows.flatMap((r) => (r.src === 0 && r.kind === "delivery" && r.closedReason === "expired" && !openIn.has(r.threadId) ? [r.threadId] : [])))];
    for (const [id, open] of await Promise.all(parcels.map(async (id) => [id, await store.dated.ofThread(id)] as const))) openIn.set(id, open);
    const keys = [...new Set(rows.map(keyOf))].filter((k) => !groups.has(k));
    const asked = [...new Set(rows.flatMap((r) => (r.src === 1 && r.answers != null && r.settledBy != null && !requests.has(r.answers) ? [r.answers] : [])))];
    const askedKeys = asked.map((id) => refKey({ source: "dated", id }));
    const members = keys.length || asked.length ? await store.today.members([...keys, ...askedKeys]) : { dated: [], promises: [] };
    // every member's conversation, and whether its sender is trusted: a merged item's line is its newest closing that may
    // show (Codex code review of iteration 2: one in Trash never hides the others')
    const fresh = [...new Set([...rows, ...members.dated, ...members.promises].map((r) => r.threadId))].filter((id) => !threads.has(id));
    const [summaries, kept] = await Promise.all([fresh.length ? store.threads.summaries(fresh) : [], trusted(members.dated)]);
    const byId = new Map(summaries.map((t) => [t.id, t]));
    for (const id of fresh) threads.set(id, byId.get(id) ?? null);
    const trustedIds = new Set(kept.map((r) => r.id));
    // a request whose own line shows in this view: dated items shown, a trusted sender's, its own item (none joined to
    // another, none of its members open), in the keep's window and not held open; else the promise's line stays (its code
    // review: with Dates off, both lines went)
    for (const id of asked) {
      const r = members.dated.find((d) => d.id === id);
      const key = refKey({ source: "dated", id });
      const alone = !!r && r.sameAs == null && ![...members.dated, ...members.promises].some((m) => m.sameAs === key && open(m));
      requests.set(id, r && o.dated && trustedIds.has(id) && alone && r.closedAt != null && r.closedAt >= since && !o.held.has(key) ? r : null);
    }
    const shows = (m: Row) => visible(threads.get(m.threadId)) && (m.src === 1 || trustedIds.has(m.id));
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
  const fill = async <R extends { closedAt: number | null; id: number }>(s: Source<R>, keep: (rows: R[]) => Promise<readonly R[]>) => {
    // a whole batch left out (an untrusted sender's items) reads on
    while (!s.buf.length && !s.done) {
      await breathe();
      const rows = await s.read(s.after);
      if (rows.length < READ_BATCH) s.done = true;
      if (!rows.length) return;
      const last = rows.at(-1)!;
      s.after = { at: last.closedAt!, id: last.id };
      s.buf.push(...(await keep(rows)));
    }
  };
  const datedTrusted = async (rows: Row[]) => {
    const kept = (await trusted(rows as DatedRow[])) as Row[];
    await learn(kept);
    return kept;
  };
  const all = async (rows: Row[]) => {
    await learn(rows);
    return rows;
  };
  // a waiting Done needs only its conversation, read with the page's
  const conversations = async (rows: WaitingLine[]) => {
    const fresh = [...new Set(rows.map((r) => r.threadId))].filter((id) => !threads.has(id));
    if (fresh.length) {
      const byId = new Map((await store.threads.summaries(fresh)).map((t) => [t.id, t]));
      for (const id of fresh) threads.set(id, byId.get(id) ?? null);
    }
    return rows;
  };
  // plan 210 (iteration 4): the "Changed" lines, from the open items in hand (bounded), one a canonical item at its newest
  // change, strictly after `after`, newest first; their conversations read once with the page's
  const changes = changedLines(o, since);
  const unread = [...new Set(changes.map((c) => c.row.threadId))].filter((id) => !threads.has(id));
  if (unread.length) {
    const byId = new Map((await store.threads.summaries(unread)).map((t) => [t.id, t]));
    for (const id of unread) threads.set(id, byId.get(id) ?? null);
  }
  const items: TodayHistoryItem[] = [];
  let next: HistoryKey | null = null;
  for (;;) {
    await Promise.all([fill(dated, datedTrusted), fill(promises, all), fill(waiting, conversations)]);
    const heads: { key: HistoryKey; source: Source<Row> | Source<WaitingLine> | null }[] = [dated.buf[0], promises.buf[0]].filter((r): r is Row => !!r).map((r) => ({ key: closingOf(r), source: r.src === 0 ? dated : promises }));
    if (waiting.buf[0]) heads.push({ key: { at: waiting.buf[0].at, src: 4, id: waiting.buf[0].messageId }, source: waiting });
    if (changes[0]) heads.push({ key: changes[0].key, source: null });
    if (!heads.length) {
      next = null;
      break;
    }
    const head = heads.sort((a, b) => historyOrder(a.key, b.key))[0]!;
    if (!head.source) {
      if (o.through && historyOrder(head.key, o.through) > 0) {
        next = items.at(-1)?.key ?? o.through;
        break;
      }
      const { row } = changes.shift()!;
      const thread = threads.get(row.threadId);
      if (!visible(thread)) continue;
      items.push({ id: changeLineId(keyOf(row)), item: { source: sourceOf(row.src), id: row.id }, thread, key: head.key, outcome: "changed", kind: row.src === 2 ? row.kind : "promise", text: row.text });
      if (!o.through && items.length >= o.limit) {
        next = head.key;
        break;
      }
      continue;
    }
    if (o.through && historyOrder(head.key, o.through) > 0) {
      // past the line the renderer had: the rest is the next page's, from the last line here, or (none left above it, all
      // gone meanwhile: Codex code review) from that line itself, so nothing older is lost
      next = items.at(-1)?.key ?? o.through;
      break;
    }
    if (head.source === waiting) {
      const w = waiting.buf.shift()!;
      const thread = threads.get(w.threadId);
      // the conversation's open row held (it waits again, or is kept in place) has none
      if (!waitingVisible(thread) || o.held.has(waitingRowId(w.threadId))) continue;
      items.push({ id: waitingDoneLineId(w.messageId), item: { source: "waiting", messageId: w.messageId }, thread, key: head.key, outcome: "done", kind: "waiting", text: "", waiting: { who: w.who, subject: w.subject, wrote: w.wrote } });
      if (!o.through && items.length >= o.limit) {
        next = head.key;
        break;
      }
      continue;
    }
    const row = (head.source as Source<Row>).buf.shift()!;
    const thread = threads.get(row.threadId);
    const id = keyOf(row);
    const group = groups.get(id);
    // a merged item's line is its newest closing's, and it has none while any of it is open
    if (!visible(thread) || o.held.has(id) || !group || group.open || !group.newest || historyOrder(group.newest, head.key) !== 0) continue;
    // plan 210 (iteration 3): a request finished with the promise that answered it is that promise's line
    if (row.src === 0 && row.closedReason === ANSWERED_WITH_PROMISE) continue;
    // plan 215: a request closed with its conversation's Done: the waiting line says it
    if (row.src === 0 && row.closedReason === WAITING_CLOSED) continue;
        // the claims ledger's third batch: an ask its person asked again with a day lives on as the request that mail made
    if (row.src === 0 && row.closedReason === REASKED) continue;
    // (Diego's arm) a parcel's notice whose day went by while a newer notice of that parcel is still on its way was replaced,
    // not over: its line would say "Over yesterday" beside the live delivery
    if (row.src === 0 && superseded(row, openIn.get(row.threadId), thread.fromName)) continue;
    // iteration 4: a promise that only held a request closed with it: the request's line says it
    if (row.src === 1 && row.closedReason === HELD_REQUEST_CLOSED) continue;
    // the claims ledger's third batch (Theo's script, Margaret's papers): a promise the mail that answered its request also
    // kept is one thing done, the request's line ("Answered Fri"), as when the two are one item (the request leads)
    if (row.src === 1 && row.answers != null && answeredWith(row, requests.get(row.answers))) continue;
    const outcome = outcomeOf(row);
    const line: TodayHistoryItem = { id, item: { source: sourceOf(row.src), id: row.id }, thread, key: head.key, outcome, kind: row.src === 0 ? row.kind : "promise", text: row.text, ...(outcome === "handed" && row.handedTo && { handedTo: row.handedTo }) };
    // plan 210 (iteration 4, revision 7): settled by mail, the line says that mail's day and how
    if (row.settledAt != null) line.on = row.settledAt;
    // the claims ledger's third batch (Margaret's furnace tune-up, Priya's dinner): a plan that's over says its own day
    // ("Over Fri"), never the moment the sweep retired it ("Over today" the next morning)
    else if (outcome === "over" && row.src === 0 && datedGroup(row.kind) === "plans") line.on = row.dueAt;
    if (row.closedReason) line.reason = row.closedReason;
    items.push(line);
    if (!o.through && items.length >= o.limit) {
      next = head.key;
      break;
    }
  }
  return { items, next };
}
