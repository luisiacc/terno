import { storedAddresses, type FolderView } from "@terno/core";
import type { ExportMessage, FolderExportCursor, FolderExportTarget } from "@terno/store";
import { seekAfter, T, threadMerges, type Ctx, type R } from "./mail";
import type { Key } from "./mem";

/**
 * Plan 107: what an .mbox export reads (the SQL adapter's folder-export.ts): a stretch of a place's threads at a
 * time (the smallest ids above `after`, placed as found), the messages there that are in it, a long conversation a
 * stretch of its messages at a time. The backend sorts what it collected by (date, id).
 */
const PLACE: Record<FolderView, (m: R) => boolean> = {
  inbox: (m) => m.in_inbox === 1 && !m.is_trash && !m.is_spam,
  sent: (m) => m.is_sent === 1 && !m.is_trash && !m.is_spam,
  archive: (m) => !m.in_inbox && !m.is_trash && !m.is_spam,
  spam: (m) => m.is_spam === 1 && !m.is_trash,
  trash: (m) => m.is_trash === 1,
};

const hasLabel = (m: R, key: string): boolean => {
  if (typeof m.gmail_labels !== "string" || !m.gmail_labels.includes(key)) return false;
  try {
    const labels: unknown = JSON.parse(m.gmail_labels);
    return Array.isArray(labels) && labels.includes(key);
  } catch {
    return false;
  }
};

/**
 * The smallest `limit` thread ids of the place above `after`, from a seek into an ascending order (Codex code review
 * #9: every stretch walked every member again, 12.5 million visits in stretches of 200 at 50,000, and placing them by
 * splice was quadratic): a folder's kept members (walked from `after` on, so the stretches together walk them once).
 * null: a big folder's members are still being read (its kept order isn't
 * built yet), a run at a time; the caller asks again with `pendingAfter(after)` (Codex code review round 8 #5: one
 * call walked and sorted every member, ~22 ms at 500,000). `after` below 0 is such a pending one's.
 */
export function stretch(c: Ctx, target: { accountId: number; folder: string }, after: number, limit: number, walk?: number): number[] | null {
  const ids = c.scopes.folder(c, target.accountId, target.folder);
  const at = walk !== undefined ? `w\u0000${walk}` : `f\u0000${target.accountId}\u0000${target.folder}`;
  if (ids) {
    memberRuns.get(c)?.delete(at);
    const start = seekAfter(ids, after < 0 ? -after - 1 : after);
    return ids.slice(start, start + limit);
  }
  // its order still being built (in the background): the members read a run at a time
  const memberships = T(c, "thread_folders");
  return runStretch(c, at, () => memberships.keysBy("folder", target.accountId, target.folder), (k) => memberships.rows.get(k)?.thread_id as number | undefined, after, limit)?.ids ?? null;
}

/**
 * A folder's members read while their order builds are let go: a thread merge since may have made one a member the
 * kept runs don't have (a count goes on past it: Codex code review round 19 #2)
 */
export function forgetStretch(c: Ctx, target: { accountId: number; folder: string }): void {
  memberRuns.get(c)?.delete(`f\u0000${target.accountId}\u0000${target.folder}`);
}

/**
 * A standard view's stretch: the account's smallest thread ids above `after`, from its own threads (the account
 * index) read a run a call, sorted and kept between calls, as a folder's members are while their order builds. null:
 * still being read; the caller asks again with `pendingAfter(after)`. Never the store's ascending ids: an empty
 * account beside another's million threads walked them all (Codex code review round 9 #3), and when they weren't kept
 * (after the store opened, or after an arrival) one call collected and sorted every thread (round 13 #2).
 */
export function viewStretch(c: Ctx, accountId: number, after: number, limit: number, walk?: number): Stretch | null {
  const threads = T(c, "threads");
  // a thread gone since its run was read is skipped (it counts for no stretch, but for what the call looks at)
  return runStretch(c, walk !== undefined ? `w\u0000${walk}` : `v\u0000${accountId}`, () => threads.keysBy("fk_account_id", accountId), (k) => k as number, after, limit, (id) => threads.has(id));
}

/**
 * A stretch's ids, and `through`: the last id it looked at when it stopped at its bound of gone ones before `limit`
 * (the next stretch starts after it), else null
 */
export type Stretch = { ids: number[]; through: number | null };

/** the gone ids a stretch looks at, at most, before it answers with where it stopped */
const GONE_VISITS = 4096;

/**
 * The smallest `limit` ids above `after` from a live walk read `MEMBER_RUN` keys a call, each run sorted, kept between
 * calls (by `at`: an export's own walk, a count's folder); a walk starts again with each export (`after` 0), or when it
 * was let go (`keep`). null until the walk is
 * read to its end (Codex code review round 8 #5: one call walked and sorted every member, ~22 ms at 500,000). Ids
 * `live` rejects count toward what a call looks at, `GONE_VISITS` at most (Codex code review round 15 #3: an account's
 * million threads deleted between calls were all looked at in the next one, ~120 ms).
 */
function runStretch(c: Ctx, at: string, walk: () => Iterator<Key>, id: (k: Key) => number | undefined, after: number, limit: number, live: (id: number) => boolean = () => true): Stretch | null {
  const from = after < 0 ? -after - 1 : after;
  let runs = memberRuns.get(c);
  if (!runs) memberRuns.set(c, (runs = new Map()));
  let read = after === 0 ? undefined : kept(runs, at);
  if (!read) keep(runs, at, (read = { walk: walk(), runs: [], done: false, used: 0 }));
  if (!read.done) {
    const run: number[] = [];
    while (run.length < MEMBER_RUN) {
      const k = read.walk.next();
      if (k.done) { read.done = true; break; }
      const v = id(k.value);
      if (v !== undefined) run.push(v);
    }
    if (run.length) read.runs.push(Float64Array.from(run).sort());
    if (!read.done) return null;
  }
  // the runs merged from their seeks: `limit` steps over a few dozen heads
  const heads = read.runs.map((r) => seekAfter(r, from));
  const out: number[] = [];
  let last = -Infinity;
  let gone = 0;
  while (out.length < limit) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) if (heads[i]! < read.runs[i]!.length && (best < 0 || read.runs[i]![heads[i]!]! < read.runs[best]![heads[best]!]!)) best = i;
    if (best < 0) break;
    const v = read.runs[best]![heads[best]!++]!;
    // an id read in two runs (let go and added again meanwhile, or its row updated: an update moves its key to the
    // end of the live index) comes once
    if (v === last) continue;
    last = v;
    if (live(v)) out.push(v);
    else if (++gone >= GONE_VISITS) return { ids: out, through: v };
  }
  return { ids: out, through: null };
}

/** the `after` to ask with again when `stretch` said its members are still being read */
export const pendingAfter = (after: number): number => (after < 0 ? after : -after - 1);

/** members read a call at a time: each run is sorted natively (~1 ms), never the whole folder at once */
const MEMBER_RUN = 16_384;
/** a place's members read so far while its kept order builds, per store, by export walk (or a count's folder) */
const memberRuns = new WeakMap<Ctx, Map<string, { walk: Iterator<Key>; runs: Float64Array[]; done: boolean; used: number }>>();

/**
 * Walks kept between calls are let go once idle (an export cancelled, a window closed) or, past `KEPT_MAX`, the least
 * recently used: never one in use by a few exports at once. Four kept, the least recently used let go, had five
 * interleaved exports evict each other's walk before it was whole, and none finished (Codex code review round 18 #2).
 * The backend resolves one export a window at a time.
 */
const KEPT_IDLE_MS = 30_000;
const KEPT_MAX = 64;
/** the walk kept at `key`, now the most recently used */
function kept<K, V extends { used: number }>(map: Map<K, V>, key: K): V | undefined {
  const v = map.get(key);
  if (!v) return undefined;
  map.delete(key);
  v.used = performance.now();
  map.set(key, v);
  return v;
}
/** keeps a walk at `key`, letting go of the idle ones and the least recently used past `KEPT_MAX` */
function keep<K, V extends { used: number }>(map: Map<K, V>, key: K, value: V): void {
  const now = performance.now();
  map.delete(key);
  for (const [k, v] of map) {
    if (map.size < KEPT_MAX && now - v.used < KEPT_IDLE_MS) break;
    map.delete(k);
  }
  value.used = now;
  map.set(key, value);
}
/** the last export walk id given (an object property: a module `let` read then reset miscompiles under the React Compiler) */
const exportWalkIds = { last: 0 };

/**
 * A thread's messages after `from` (by id), at most `n` looked at: all of a short one as the index holds them; a long
 * one's from its ids ascending, kept between calls and seeked into, so a conversation of any length is read a stretch
 * a call (Codex code review round 2 #6: one of 50,000 was read whole in one call). The order is built a run a call
 * (`pending` until it's whole, the caller asking again from the same place) and let go when the thread's messages
 * change (Codex code review round 10 #3: every call read and sorted all of a million-message conversation, ~55 ms).
 */
export function threadStretch(c: Ctx, thread: number, from: number | null, n: number): { rows: R[]; more: boolean; pending?: true } {
  const messages = T(c, "messages");
  if (from === null && messages.count("fk_thread_id", thread) <= n) return { rows: messages.by("fk_thread_id", thread), more: false };
  const orders = threadOrdersOf(c);
  let order = kept(orders, thread);
  // kept while it's read (the exports' and counts' at once), let go when read to its end
  if (!order) keep(orders, thread, (order = { walk: messages.keysBy("fk_thread_id", thread), runs: [], done: false, used: 0 }));
  if (!order.done) {
    const run: number[] = [];
    while (run.length < MEMBER_RUN) {
      const k = order.walk.next();
      if (k.done) { order.done = true; break; }
      run.push(k.value as number);
    }
    if (run.length) order.runs.push(Float64Array.from(run).sort());
    if (!order.done) return { rows: [], more: true, pending: true };
  }
  // the runs merged from their seeks: `n` steps over a few dozen heads. A message updated after its run was read is
  // met again by the live walk (an update moves its key to the end of the index), so it's in two runs: it comes once
  // (Codex code review round 12 #1)
  const runs = order.runs;
  const heads = runs.map((r) => (from === null ? 0 : seekAfter(r, from)));
  const rows: R[] = [];
  let last = from ?? -Infinity;
  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) if (heads[i]! < runs[i]!.length && (best < 0 || runs[i]![heads[i]!]! < runs[best]![heads[best]!]!)) best = i;
    if (best < 0) {
      orders.delete(thread);
      return { rows, more: false };
    }
    const id = runs[best]![heads[best]!]!;
    if (id === last) { heads[best]!++; continue; }
    if (rows.length >= n) return { rows, more: true };
    heads[best]!++;
    last = id;
    rows.push(messages.get(id)!);
  }
}

/** a long thread's message ids read so far, sorted a run at a time, per store, by thread (kept while read: `keep`) */
type ThreadIds = { walk: Iterator<Key>; runs: Float64Array[]; done: boolean; used: number };
const threadOrders = new WeakMap<Ctx["db"], Map<number, ThreadIds>>();

function threadOrdersOf(c: Ctx): Map<number, ThreadIds> {
  let orders = threadOrders.get(c.db);
  if (orders) return orders;
  const kept = (orders = new Map());
  threadOrders.set(c.db, kept);
  // a message in, out or moved to another thread (undo included): that thread's order is read again
  c.db.onRow((table, row, prev) => {
    if (table !== "messages" || !kept.size || (row && prev && row.thread_id === prev.thread_id)) return;
    if (row) kept.delete(row.thread_id as number);
    if (prev) kept.delete(prev.thread_id as number);
  });
  return kept;
}

export function exportIds(c: Ctx, target: FolderExportTarget, after: FolderExportCursor | null, limit: number): { messages: { id: number; date: number }[]; next: FolderExportCursor | null; rewound?: true } {
  // a merge since the last stretch that moved a thread not read yet into one passed: read again from there, its
  // threads read afresh (the merge may have made one a member) (Codex code review round 17 #1: thread 2 merged into
  // thread 1 after the walk passed 1 left thread 2's messages out)
  const merges = threadMerges(c);
  // the export's own walk of the place's members, kept between its calls (Codex code review round 18 #2)
  const walk = after?.walk ?? ++exportWalkIds.last;
  const back = after?.merges === undefined ? null : merges.rewind(after.merges, after.thread < 0 ? -after.thread - 1 : after.thread);
  if (back !== null) {
    memberRuns.get(c)?.delete(`w\u0000${walk}`);
    after = { thread: back - 1 };
  }
  const answer = (messages: { id: number; date: number }[], next: FolderExportCursor | null) => {
    // read to its end: its walk is let go
    if (!next) memberRuns.get(c)?.delete(`w\u0000${walk}`);
    return { messages, next: next && { ...next, merges: merges.current, walk }, ...(back !== null && { rewound: true as const }) };
  };
  const locations = T(c, "message_locations");
  const folder = target.folder;
  // a pending rename's old paths are the folder's too (Codex code review round 5 #2), each under the UIDVALIDITY it
  // had; those are another folder's under its own path when the path was made again (round 6 #2)
  const aliases = (folder !== undefined && target.aliases) || [];
  const except = (folder !== undefined && target.except) || [];
  const at = (m: R, mailbox: string) => locations.get(m.id, mailbox)?.uidvalidity as number | undefined;
  const placed = (m: R, mailbox: string) => { const v = at(m, mailbox); return v !== undefined && !except.includes(v); };
  const test = folder !== undefined ? (m: R) => !m.is_trash && !m.is_spam && (hasLabel(m, folder) || placed(m, folder) || aliases.some((a) => at(m, a.mailbox) === a.uidvalidity)) : PLACE[target.view];
  const out: { id: number; date: number }[] = [];
  let budget = limit;
  /** a thread from `from`: where it stopped, or null when it's read to its end */
  const read = (thread: number, from: number | null): { id: number; date: number } | null => {
    const { rows, more, pending } = threadStretch(c, thread, from, budget);
    // its order still being read: the next call asks again from here
    if (pending) return { id: from ?? 0, date: 0 };
    for (const m of rows) if (m.account_id === target.accountId && !m.is_draft && test(m)) out.push({ id: m.id as number, date: m.date as number });
    budget -= Math.max(1, rows.length);
    const last = rows.at(-1);
    return more && last ? { id: last.id as number, date: last.date as number } : null;
  };
  if (after?.message) {
    const cut = read(after.thread, after.message.id);
    if (cut) return answer(out, { thread: after.thread, message: cut });
    if (budget <= 0) return answer(out, { thread: after.thread });
  }
  const asked = budget;
  const top = folder !== undefined ? stretch(c, { accountId: target.accountId, folder }, after?.thread ?? 0, asked, walk) : viewStretch(c, target.accountId, after?.thread ?? 0, asked, walk);
  // still reading a big folder's members or an account's threads: the next call goes on (Codex code review round 8 #5, round 13 #2)
  if (top === null) return answer(out, { thread: pendingAfter(after?.thread ?? 0) });
  const { ids, through } = Array.isArray(top) ? { ids: top, through: null } : top;
  for (const id of ids) {
    const cut = read(id, null);
    if (cut) return answer(out, { thread: id, message: cut });
    if (budget <= 0) return answer(out, { thread: id });
  }
  // stopped at its bound of gone threads: the next call goes on after the last it looked at (round 15 #3)
  if (through !== null) return answer(out, { thread: through });
  // each thread took at least one of the budget: a full stretch returned above, so this one was the last
  return answer(out, null);
}

/** these messages, their bodies read ahead by the caller (which parts there are) */
export function exportMessages(c: Ctx, ids: readonly number[]): ExportMessage[] {
  const messages = T(c, "messages");
  const attachments = T(c, "attachments");
  const assets = T(c, "attachment_assets");
  const out: ExportMessage[] = [];
  for (const id of ids) {
    const m = messages.get(id);
    if (!m) continue;
    const body = c.body(id);
    const capture = body?.capture_id ? T(c, "body_captures").get(body.capture_id) : undefined;
    out.push({
      id,
      accountId: m.account_id,
      rfcMessageId: m.rfc_message_id ?? null,
      inReplyTo: m.in_reply_to ?? null,
      references: parseRefs(m.references_json),
      ...storedAddresses(m as Parameters<typeof storedAddresses>[0]),
      date: m.date,
      subject: m.subject,
      listId: m.list_id ?? null,
      hasText: typeof body?.body_text === "string" || capture?.text_parts != null,
      hasHtml: typeof body?.body_html === "string" || capture?.html_parts != null,
      bodyState: m.body_state,
      attachments: attachments
        .by("fk_message_id", id)
        .sort((x, y) => x.id - y.id)
        // the bytes are here only when the asset is complete
        .map((a) => ({ filename: a.filename, mime: a.mime, size: a.size, contentId: a.content_id ?? null, assetId: a.asset_id && assets.get(a.asset_id)?.complete === 1 ? (a.asset_id as string) : null })),
    });
  }
  return out;
}

/**
 * A stretch of a body part, its body read ahead by the caller. IndexedDB keeps a message's body as one record, read
 * whole (into the body cache) by any read of it: what's bounded here is what a call visits and hands on, a stretch of
 * UTF-16 units, never half a surrogate pair (Codex code review round 6 #4).
 */
export function exportBody(c: Ctx, id: number, part: "text" | "html", at: number, size: number): { text: string; next: number | null } | null {
  return sliceBody(c.body(id), part, at, size);
}

/** a stretch of a body read already (an export's lease: Codex code review round 27 #3) */
export function sliceBody(body: { body_text: string | null; body_html: string | null } | null, part: "text" | "html", at: number, size: number): { text: string; next: number | null } | null {
  const s = part === "text" ? body?.body_text : body?.body_html;
  if (typeof s !== "string") return null;
  let end = Math.min(s.length, at + size);
  if (end < s.length && end > at + 1 && (s.charCodeAt(end - 1) & 0xfc00) === 0xd800) end--;
  return { text: s.slice(at, end), next: end < s.length ? end : null };
}

function parseRefs(json: unknown): string[] {
  try {
    const refs: unknown = JSON.parse(typeof json === "string" ? json : "[]");
    return Array.isArray(refs) ? refs.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}
