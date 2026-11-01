import { storedAddresses, type FolderView } from "@terno/core";
import type { ExportMessage, FolderExportCursor, FolderExportTarget } from "@terno/store";
import { seekAfter, T, type Ctx, type R } from "./mail";
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
export function stretch(c: Ctx, target: { accountId: number; folder: string }, after: number, limit: number): number[] | null {
  const from = after < 0 ? -after - 1 : after;
  const at = `${target.accountId}\u0000${target.folder}`;
  let runs = memberRuns.get(c);
  if (!runs) memberRuns.set(c, (runs = new Map()));
  const ids = c.scopes.folder(c, target.accountId, target.folder);
  if (ids) {
    runs.delete(at);
    const start = seekAfter(ids, from);
    return ids.slice(start, start + limit);
  }
  // its order still being built (in the background): the members read a run at a time, each run sorted, kept
  // between calls; a walk starts again with each export (`after` 0), or when it was let go
  let read = after === 0 ? undefined : runs.get(at);
  if (!read) {
    runs.delete(at);
    if (runs.size >= 4) runs.delete(runs.keys().next().value!);
    runs.set(at, (read = { walk: T(c, "thread_folders").keysBy("folder", target.accountId, target.folder), runs: [], done: false }));
  }
  if (!read.done) {
    const memberships = T(c, "thread_folders");
    const run: number[] = [];
    while (run.length < MEMBER_RUN) {
      const k = read.walk.next();
      if (k.done) { read.done = true; break; }
      const r = memberships.rows.get(k.value);
      if (r) run.push(r.thread_id as number);
    }
    if (run.length) read.runs.push(Float64Array.from(run).sort());
    if (!read.done) return null;
  }
  // the runs merged from their seeks: `limit` steps over a few dozen heads
  const heads = read.runs.map((r) => seekAfter(r, from));
  const out: number[] = [];
  while (out.length < limit) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) if (heads[i]! < read.runs[i]!.length && (best < 0 || read.runs[i]![heads[i]!]! < read.runs[best]![heads[best]!]!)) best = i;
    if (best < 0) break;
    const id = read.runs[best]![heads[best]!++]!;
    // a thread read in two runs (let go and added again meanwhile) comes once
    if (out.at(-1) !== id) out.push(id);
  }
  return out;
}

/**
 * A standard view's stretch: the account's smallest thread ids above `after`, walked in the store's ascending ids at
 * most `VIEW_VISITS` a call (Codex code review round 9 #3: an empty account's export walked another's million threads
 * in one call, ~47 ms). `resume`: where the next call goes on when the walk stopped there, matched or not.
 */
export function viewStretch(c: Ctx, accountId: number, after: number, limit: number): { ids: number[]; resume: number | null } {
  const threads = T(c, "threads");
  const all = c.scopes.threads(c);
  const ids: number[] = [];
  let i = seekAfter(all, after);
  for (const end = Math.min(all.length, i + VIEW_VISITS); i < end && ids.length < limit; i++) if (threads.get(all[i]!)?.account_id === accountId) ids.push(all[i]!);
  return { ids, resume: ids.length < limit && i < all.length ? all[i - 1]! : null };
}

/** thread ids a view's stretch looks at a call, whichever account they're in (a few milliseconds) */
export const VIEW_VISITS = 16_384;

/** the `after` to ask with again when `stretch` said its members are still being read */
export const pendingAfter = (after: number): number => (after < 0 ? after : -after - 1);

/** members read a call at a time: each run is sorted natively (~1 ms), never the whole folder at once */
const MEMBER_RUN = 16_384;
/** a folder's members read so far while its kept order builds, per store, by account and folder (a few kept) */
const memberRuns = new WeakMap<Ctx, Map<string, { walk: Iterator<Key>; runs: Float64Array[]; done: boolean }>>();

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
  let order = orders.get(thread);
  if (!order) {
    // a few kept (the export's and a count's)
    if (orders.size >= 4) orders.delete(orders.keys().next().value!);
    orders.set(thread, (order = { walk: messages.keysBy("fk_thread_id", thread), runs: [], done: false }));
  }
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
  // the runs merged from their seeks: `n` steps over a few dozen heads
  const runs = order.runs;
  const heads = runs.map((r) => (from === null ? 0 : seekAfter(r, from)));
  const rows: R[] = [];
  for (;;) {
    let best = -1;
    for (let i = 0; i < heads.length; i++) if (heads[i]! < runs[i]!.length && (best < 0 || runs[i]![heads[i]!]! < runs[best]![heads[best]!]!)) best = i;
    if (best < 0) return { rows, more: false };
    if (rows.length >= n) return { rows, more: true };
    rows.push(messages.get(runs[best]![heads[best]!++]!)!);
  }
}

/** a long thread's message ids read so far, sorted a run at a time, per store, by thread (a few kept) */
type ThreadIds = { walk: Iterator<Key>; runs: Float64Array[]; done: boolean };
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

export function exportIds(c: Ctx, target: FolderExportTarget, after: FolderExportCursor | null, limit: number): { messages: { id: number; date: number }[]; next: FolderExportCursor | null } {
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
    if (cut) return { messages: out, next: { thread: after.thread, message: cut } };
    if (budget <= 0) return { messages: out, next: { thread: after.thread } };
  }
  const asked = budget;
  let top: number[] | null;
  let resume: number | null = null;
  if (folder !== undefined) top = stretch(c, { accountId: target.accountId, folder }, after?.thread ?? 0, asked);
  else ({ ids: top, resume } = viewStretch(c, target.accountId, after?.thread ?? 0, asked));
  // still reading a big folder's members: the next call goes on (Codex code review round 8 #5)
  if (top === null) return { messages: out, next: { thread: pendingAfter(after?.thread ?? 0) } };
  for (const id of top) {
    const cut = read(id, null);
    if (cut) return { messages: out, next: { thread: id, message: cut } };
    if (budget <= 0) return { messages: out, next: { thread: id } };
  }
  // a view's walk stopped at its bound: the next call goes on from there (Codex code review round 9 #3)
  if (resume !== null) return { messages: out, next: { thread: resume } };
  // each thread took at least one of the budget: a full stretch returned above, so this one was the last
  return { messages: out, next: null };
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
      hasText: typeof body?.body_text === "string",
      hasHtml: typeof body?.body_html === "string",
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
  const body = c.body(id);
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
