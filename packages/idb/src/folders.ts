import { folderRef, listFilterOf, waitingCutoff, type Folder, type ThreadSummary } from "@terno/core";
import type { ListParams, Page, ProviderFolder, ScopeParams } from "@terno/store";
import { keepInPage } from "@terno/store";
import { FILTER_TEST, seekAfter, T, toSummary, VIEW_TEST, type Ctx, type R } from "./mail";

/**
 * Plan 65: an account's own folders and which threads are in them (the SQL adapter's folders.ts). Membership is
 * written in the same unit as what decides it: recomputeThreads and every IMAP location write. A thread is in a
 * folder when one of its messages (not in trash or spam) carries the key: a Gmail user label (`Label_*`, listed
 * or not yet), or a location in a mailbox the account lists. Rows carry the thread's date and unread state.
 */
const userLabels = (m: R): string[] => {
  if (!m.gmail_labels) return [];
  try {
    const labels: unknown = JSON.parse(m.gmail_labels as string);
    return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string" && l.startsWith("Label_")) : [];
  } catch {
    return [];
  }
};

/** Rewrites these threads' memberships from their messages; rows that didn't change aren't written. */
export function refreshFolders(c: Ctx, threadIds: Iterable<number>): void {
  const memberships = T(c, "thread_folders");
  const threads = T(c, "threads");
  const messages = T(c, "messages");
  const locations = T(c, "message_locations");
  const folders = T(c, "folders");
  for (const id of threadIds) {
    const t = threads.get(id);
    const keys = new Set<string>();
    if (t) {
      for (const m of messages.by("fk_thread_id", id)) {
        if (m.is_trash || m.is_spam) continue;
        for (const l of userLabels(m)) keys.add(l);
        for (const l of locations.by("fk_message_id", m.id)) if (folders.has(t.account_id, l.mailbox)) keys.add(l.mailbox as string);
      }
    }
    const unread = t && t.unread_count > 0 ? 1 : 0;
    for (const r of memberships.by("fk_thread_id", id)) {
      if (!keys.delete(r.folder as string)) memberships.deleteRow(r);
      else if (r.last_date !== t!.last_date || r.unread !== unread) memberships.update(r, { last_date: t!.last_date, unread });
    }
    for (const folder of keys) memberships.insert({ thread_id: id, account_id: t!.account_id, folder, last_date: t!.last_date, unread });
  }
}

/** Threads with a Gmail user label (an upgraded mailbox's memberships, written once). */
/** The upgrade's work (schema 24): the messages that carry a user label, by id (Codex R15: by message, as SQLite's). */
export function messagesWithUserLabels(c: Ctx): number[] {
  const out: number[] = [];
  for (const m of T(c, "messages").all()) if (typeof m.gmail_labels === "string" && m.gmail_labels.includes("Label_")) out.push(m.id as number);
  return out;
}

/**
 * The upgrade's batch: these messages' user labels as their threads' memberships, beside any already there (a label
 * is a membership if any message carries it). A batch of messages, whatever their threads: one conversation of
 * 50,000 is many batches, never one (Codex R15).
 */
export function addMessageLabels(c: Ctx, messageIds: readonly number[]): number[] {
  const messages = T(c, "messages");
  const threads = T(c, "threads");
  const memberships = T(c, "thread_folders");
  const touched = new Set<number>();
  for (const id of messageIds) {
    const m = messages.get(id);
    if (!m || m.is_trash || m.is_spam) continue;
    const t = threads.get(m.thread_id);
    if (!t) continue;
    for (const label of userLabels(m)) {
      if (memberships.has(t.id, label)) continue;
      memberships.insert({ thread_id: t.id, account_id: t.account_id, folder: label, last_date: t.last_date, unread: t.unread_count > 0 ? 1 : 0 });
      touched.add(t.id as number);
    }
  }
  return [...touched];
}

/** The threads of these messages, for a refresh after their locations changed. */
export function threadsOfMessages(c: Ctx, messageIds: readonly number[]): number[] {
  const messages = T(c, "messages");
  return [...new Set(messageIds.map((id) => messages.get(id)?.thread_id as number | undefined).filter((t): t is number => t !== undefined))];
}

export function isFolder(c: Ctx, accountId: number, key: string): boolean {
  return T(c, "folders").has(accountId, key);
}

export function listFolders(c: Ctx): Folder[] {
  return [...T(c, "folders").all()]
    .sort((x, y) => x.account_id - y.account_id || x.position - y.position)
    .map((r) => ({ accountId: r.account_id, key: r.key, path: JSON.parse(r.path_json) as string[], selectable: r.selectable === 1 }));
}

/**
 * An account's list now; nothing written when it's the same (the SQL adapter's replaceFolders): memberships never
 * wait on the list; only a newly listed IMAP folder's located threads, and rows a past listing left, are rewritten.
 */
export function replaceFolders(c: Ctx, accountId: number, next: readonly ProviderFolder[]): { changed: boolean; touched: number[] } {
  const folders = T(c, "folders");
  // by key, the differences only (Codex R14: a rename in 10,000 folders rewrote them all): a new folder goes after
  // the others (the order is the sidebar's to draw, by path), a renamed one changes in place, a gone one goes
  const before = new Map(folders.by("fk_account_id", accountId).map((r) => [r.key as string, r]));
  const known = new Set(before.keys());
  const listed = new Set<string>();
  let position = Math.max(-1, ...[...before.values()].map((r) => r.position as number));
  let changed = false;
  for (const f of next) {
    if (listed.has(f.key)) continue;
    listed.add(f.key);
    const path = JSON.stringify(f.path);
    const was = before.get(f.key);
    if (!was) folders.put({ account_id: accountId, key: f.key, path_json: path, selectable: f.selectable ? 1 : 0, position: ++position });
    else if (was.path_json !== path || (was.selectable === 1) !== f.selectable) folders.put({ ...was, path_json: path, selectable: f.selectable ? 1 : 0 });
    else continue;
    changed = true;
  }
  for (const [key, r] of before) {
    if (listed.has(key)) continue;
    folders.deleteRow(r);
    changed = true;
  }
  if (!changed) return { changed: false, touched: [] };
  // a job for a folder no longer listed has nothing to do; a newly listed IMAP folder with something to rebuild gets one (Codex R5)
  const jobs = T(c, "folder_rebuilds");
  const now = listed;
  // a job cancelled or replaced lets its cached order go: the next one sorts what's there then (Codex R7)
  const forget = (key: string) => rebuildOrders.get(c)?.delete(`${accountId}\u0000${key}`);
  for (const j of jobs.by("fk_account_id", accountId)) {
    if (now.has(j.key as string)) continue;
    jobs.deleteRow(j);
    forget(j.key as string);
  }
  if (T(c, "accounts").get(accountId)?.kind === "imap") {
    for (const f of next) {
      if (known.has(f.key)) continue;
      if (T(c, "message_locations").count("mailbox", accountId, f.key) || T(c, "thread_folders").count("folder", accountId, f.key)) {
        jobs.put({ account_id: accountId, key: f.key, phase: 0, after_uidvalidity: 0, after_uid: 0 });
        forget(f.key);
      }
    }
  }
  return { changed: true, touched: [] };
}

/** One slice of a pending rebuild (the SQL adapter's rebuildFolders): old rows first, then locations by UID. */
export function rebuildFolders(c: Ctx, limit: number): { more: boolean; touched: number[] } {
  const jobs = T(c, "folder_rebuilds");
  const job = jobs.all().next().value as R | undefined;
  if (!job) return { more: false, touched: [] };
  const left = () => jobs.size > 0;
  if (!isFolder(c, job.account_id, job.key)) {
    jobs.deleteRow(job);
    rebuildOrders.get(c)?.delete(`${job.account_id}\u0000${job.key}`);
    return { more: left(), touched: [] };
  }
  const memberships = T(c, "thread_folders");
  if (job.phase === 0) {
    // up to `limit` rows, read from the index and no further (Codex R8: never the whole remaining folder per slice)
    const gone: R[] = [];
    for (const k of memberships.keysBy("folder", job.account_id, job.key)) {
      gone.push(memberships.rows.get(k)!);
      if (gone.length >= limit) break;
    }
    for (const r of gone) memberships.deleteRow(r);
    if (gone.length < limit) jobs.update(job, { phase: 1 });
    return { more: true, touched: gone.map((r) => r.thread_id as number) };
  }
  // the folder's locations in UID order, sorted once for the job (Codex R6: never per slice); each slice seeks into it
  const at = `${job.account_id}\u0000${job.key}`;
  let cached = rebuildOrders.get(c);
  if (!cached) rebuildOrders.set(c, (cached = new Map()));
  let order = cached.get(at);
  if (!order) cached.set(at, (order = T(c, "message_locations").by("mailbox", job.account_id, job.key).map((l) => ({ id: l.message_id as number, uidvalidity: l.uidvalidity as number, uid: l.uid as number })).sort((x, y) => x.uidvalidity - y.uidvalidity || x.uid - y.uid)));
  let lo = 0;
  let hi = order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const l = order[mid]!;
    if (l.uidvalidity < job.after_uidvalidity || (l.uidvalidity === job.after_uidvalidity && l.uid <= job.after_uid)) lo = mid + 1;
    else hi = mid;
  }
  const rows = order.slice(lo, lo + limit).map((l) => ({ message_id: l.id, uidvalidity: l.uidvalidity, uid: l.uid }));
  // this folder's rows only (its old ones went in phase 0), from the batch's messages: no thread refolded (Codex R11)
  const messages = T(c, "messages");
  const threadRows = T(c, "threads");
  const locations = T(c, "message_locations");
  const threads: number[] = [];
  for (const r of rows) {
    // the order was read ahead: a location gone since then brings nothing back (Codex R12)
    if (!locations.has(r.message_id, job.key)) continue;
    const m = messages.get(r.message_id);
    if (!m || m.is_trash || m.is_spam || memberships.has(m.thread_id, job.key)) continue;
    const t = threadRows.get(m.thread_id);
    if (!t) continue;
    memberships.insert({ thread_id: t.id, account_id: t.account_id, folder: job.key, last_date: t.last_date, unread: t.unread_count > 0 ? 1 : 0 });
    threads.push(t.id as number);
  }
  const last = rows.at(-1);
  if (rows.length < limit) {
    jobs.deleteRow(job);
    cached.delete(at);
  } else jobs.update(job, { after_uidvalidity: last!.uidvalidity, after_uid: last!.uid });
  return { more: left(), touched: threads };
}

/** A job's locations in UID order, per store: built on its first slice (after a reload, again once) */
const rebuildOrders = new WeakMap<Ctx, Map<string, { id: number; uidvalidity: number; uid: number }[]>>();

/** Does a thread pass the folder's view and the list's filter (Waiting: inside its window)? */
function keeps(p: ScopeParams): (t: R | undefined) => t is R {
  const test = VIEW_TEST[p.view];
  const filter = listFilterOf(p);
  const cutoff = filter === "waiting" ? waitingCutoff(p.now!) : null;
  // the folder's account's threads only (another account may have a folder with the same key, Codex R2)
  return (t): t is R => !!t && t.account_id === p.accountId && test(t) && (!filter || FILTER_TEST[filter](t)) && (cutoff === null || t.waiting_since >= cutoff);
}

/**
 * A page of a folder: its members newest first (cached until they change), from the cursor by binary search,
 * walked until the page is full; kept threads only while they're in the folder. A sparse or empty folder never
 * walks the mailbox, and a deep page never walks the folder's top.
 */
export function folderPage(c: Ctx, p: ListParams): Page {
  const threads = T(c, "threads");
  // a folder reads through the account's list: one it no longer lists holds nothing (its rows wait unseen)
  const listed = T(c, "folders").has(p.accountId, p.folder);
  // the "Unread" filter walks the folder's unread memberships alone, by date (Codex R11: an all-read folder walked
  // whole), kept sorted across pages (Codex R12: never re-sorted per page)
  const unread = listed && listFilterOf(p) === "unread" ? c.scopes.folderUnreadByDate(c, p.accountId!, p.folder!) : null;
  const byDate = listed && !unread ? c.scopes.folderByDate(c, p.accountId!, p.folder!) : [];
  const size = unread ? unread.length : byDate.length;
  const idAt = unread ? (i: number) => unread[i]!.id : (i: number) => byDate[i]!;
  const pass = keeps(p);
  const before = (t: R) => !p.cursor || t.last_date < p.cursor.lastDate || (t.last_date === p.cursor.lastDate && t.id < p.cursor.id);
  let lo = 0;
  let hi = size;
  while (p.cursor && lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(threads.get(idAt(mid))!)) hi = mid;
    else lo = mid + 1;
  }
  const rows: R[] = [];
  for (let i = lo; i < size && rows.length <= p.limit; i++) {
    const t = threads.get(idAt(i));
    if (pass(t)) rows.push(t);
  }
  const hasMore = rows.length > p.limit;
  const items: ThreadSummary[] = (hasMore ? rows.slice(0, p.limit) : rows).map((t) => toSummary(c, t));
  const last = items[items.length - 1];
  const page = { items, nextCursor: hasMore && last ? { lastDate: last.lastDate, id: last.id } : null };
  if (!listFilterOf(p) || !p.keepIds?.length) return page;
  const inView = keeps({ ...p, filter: undefined, unreadOnly: false });
  const memberships = T(c, "thread_folders");
  const kept = [...new Set(p.keepIds)].filter((id) => listed && memberships.has(id, p.folder)).map((id) => threads.get(id)).filter((t): t is R => inView(t) && before(t));
  return keepInPage(page, kept.map((t) => toSummary(c, t)));
}

/** A folder's thread ids above `after`, ascending: its cached members from a seek, walked until the page is full. */
export function folderScopeIds(c: Ctx, p: ScopeParams & { after?: number; limit: number }): number[] {
  const threads = T(c, "threads");
  const ids = T(c, "folders").has(p.accountId, p.folder) ? c.scopes.folder(c, p.accountId!, p.folder!) : [];
  const pass = keeps(p);
  const out: number[] = [];
  for (let i = seekAfter(ids, p.after ?? 0); i < ids.length && out.length < p.limit; i++) if (pass(threads.get(ids[i]!))) out.push(ids[i]!);
  return out;
}

/** Unread threads per listed folder: the size of each one's bucket in the unread index (no walk at all). */
export function folderUnreadCounts(c: Ctx): Record<string, number> {
  const out: Record<string, number> = {};
  const unread = T(c, "thread_folders");
  for (const f of T(c, "folders").all()) {
    const n = unread.count("unread", f.account_id, f.key);
    if (n) out[folderRef(f.account_id, f.key)] = n;
  }
  return out;
}
