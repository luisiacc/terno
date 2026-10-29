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
export function threadsWithUserLabels(c: Ctx): number[] {
  const out = new Set<number>();
  for (const m of T(c, "messages").all()) if (typeof m.gmail_labels === "string" && m.gmail_labels.includes("Label_")) out.add(m.thread_id as number);
  return [...out];
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
  const before = folders.by("fk_account_id", accountId).sort((x, y) => x.position - y.position);
  const same = before.length === next.length && before.every((r, i) => r.key === next[i]!.key && r.path_json === JSON.stringify(next[i]!.path) && (r.selectable === 1) === next[i]!.selectable);
  if (same) return { changed: false, touched: [] };
  const known = new Set(before.map((r) => r.key as string));
  for (const r of before) folders.deleteRow(r);
  next.forEach((f, position) => folders.put({ account_id: accountId, key: f.key, path_json: JSON.stringify(f.path), selectable: f.selectable ? 1 : 0, position }));
  const touched = new Set<number>();
  if (T(c, "accounts").get(accountId)?.kind === "imap") {
    const locations = T(c, "message_locations");
    const messages = T(c, "messages");
    const memberships = T(c, "thread_folders");
    for (const f of next) {
      if (known.has(f.key)) continue;
      for (const l of locations.by("mailbox", accountId, f.key)) {
        const m = messages.get(l.message_id);
        if (m) touched.add(m.thread_id as number);
      }
      for (const r of memberships.by("folder", accountId, f.key)) touched.add(r.thread_id as number);
    }
    refreshFolders(c, touched);
  }
  return { changed: true, touched: [...touched] };
}

/** Does a thread pass the folder's view and the list's filter (Waiting: inside its window)? */
function keeps(p: ScopeParams): (t: R | undefined) => t is R {
  const test = VIEW_TEST[p.view];
  const filter = listFilterOf(p);
  const cutoff = filter === "waiting" ? waitingCutoff(p.now!) : null;
  return (t): t is R => !!t && test(t) && (!filter || FILTER_TEST[filter](t)) && (cutoff === null || t.waiting_since >= cutoff);
}

/**
 * A page of a folder: its members newest first (cached until they change), from the cursor by binary search,
 * walked until the page is full; kept threads only while they're in the folder. A sparse or empty folder never
 * walks the mailbox, and a deep page never walks the folder's top.
 */
export function folderPage(c: Ctx, p: ListParams): Page {
  const threads = T(c, "threads");
  // a folder reads through the account's list: one it no longer lists holds nothing (its rows wait unseen)
  const order = T(c, "folders").has(p.accountId, p.folder) ? c.scopes.folderByDate(c, p.accountId!, p.folder!) : [];
  const pass = keeps(p);
  const before = (t: R) => !p.cursor || t.last_date < p.cursor.lastDate || (t.last_date === p.cursor.lastDate && t.id < p.cursor.id);
  let lo = 0;
  let hi = order.length;
  while (p.cursor && lo < hi) {
    const mid = (lo + hi) >> 1;
    if (before(threads.get(order[mid]!)!)) hi = mid;
    else lo = mid + 1;
  }
  const rows: R[] = [];
  for (let i = lo; i < order.length && rows.length <= p.limit; i++) {
    const t = threads.get(order[i]!);
    if (pass(t)) rows.push(t);
  }
  const hasMore = rows.length > p.limit;
  const items: ThreadSummary[] = (hasMore ? rows.slice(0, p.limit) : rows).map((t) => toSummary(c, t));
  const last = items[items.length - 1];
  const page = { items, nextCursor: hasMore && last ? { lastDate: last.lastDate, id: last.id } : null };
  if (!listFilterOf(p) || !p.keepIds?.length) return page;
  const inView = keeps({ ...p, filter: undefined, unreadOnly: false });
  const memberships = T(c, "thread_folders");
  const kept = [...new Set(p.keepIds)].filter((id) => order.length > 0 && memberships.has(id, p.folder)).map((id) => threads.get(id)).filter((t): t is R => inView(t) && before(t));
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
