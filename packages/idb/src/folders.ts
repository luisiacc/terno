import { folderRef, listFilterOf, waitingCutoff, type Folder, type ThreadSummary } from "@terno/core";
import type { FolderCountCursor, FolderPlace, ListParams, Page, ProviderFolder, ScopeParams } from "@terno/store";
import { keepInPage } from "@terno/store";
import { pendingAfter, stretch, threadStretch } from "./folder-export";
import { FILTER_TEST, seekAfter, T, toSummary, VIEW_TEST, type Ctx, type R } from "./mail";
import type { Key } from "./mem";

/**
 * Plan 68: an account's own folders and which threads are in them (the SQL adapter's folders.ts). Membership is
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

/**
 * Plan 107: the account's messages in these folders (the SQL adapter's countFolderMessages), a slice at a time.
 * Folder by folder: its places by message id (a message counted in the first folder that places it), then its
 * rows' threads by id (one an earlier folder holds was read there), each thread's messages by id (counted by label
 * when no folder places them). What's looked at is bounded by `limit` (Codex code review round 4 #3: every sublabel
 * read the same long conversation again, five million visits in one call).
 */
export function countFolderMessages(c: Ctx, accountId: number, keys: readonly FolderPlace[], after: FolderCountCursor | null, limit: number): { messages: number; next: FolderCountCursor | null } {
  const places = keys.map((k): { mailbox: string; uidvalidity?: number; except?: readonly number[] } => (typeof k === "string" ? { mailbox: k } : k));
  // the folders' keys (labels and rows: a renamed folder's old path under one UIDVALIDITY has neither), and each
  // mailbox's places in order: a path made again after a rename here holds two folders' mail (Codex code review round 6 #2)
  const index = new Map<string, number>();
  const byMailbox = new Map<string, number[]>();
  const firsts = new Map<string, number>();
  places.forEach((p, i) => {
    if (p.uidvalidity === undefined && !index.has(p.mailbox)) index.set(p.mailbox, i);
    const same = byMailbox.get(p.mailbox);
    if (same) same.push(i);
    else byMailbox.set(p.mailbox, [i]);
    const id = JSON.stringify(p);
    if (!firsts.has(id)) firsts.set(id, i);
  });
  const placeOf = (mailbox: string, uidvalidity: number) => {
    for (const i of byMailbox.get(mailbox) ?? []) {
      const p = places[i]!;
      if ((p.uidvalidity === undefined || p.uidvalidity === uidvalidity) && !p.except?.includes(uidvalidity)) return i;
    }
    return Infinity;
  };
  const locations = T(c, "message_locations");
  const memberships = T(c, "thread_folders");
  /** where a message is first placed among the folders (Infinity: none) */
  const firstPlace = (id: number) => {
    let first = Infinity;
    for (const l of locations.by("fk_message_id", id)) first = Math.min(first, placeOf(l.mailbox as string, l.uidvalidity as number));
    return first;
  };
  let messages = 0;
  let budget = Math.max(1, limit);
  /** a thread's messages past `from` (null: its start), up to the budget: the last one looked at, or null when read to its end */
  const countThread = (thread: number, from: number | null): number | null => {
    const { rows, more } = threadStretch(c, thread, from, Math.max(1, budget));
    for (const m of rows) if (m.account_id === accountId && !m.is_trash && !m.is_spam && userLabels(m).some((l) => index.has(l)) && firstPlace(m.id as number) === Infinity) messages++;
    budget -= rows.length;
    return more && rows.length ? (rows.at(-1)!.id as number) : null;
  };
  let at: FolderCountCursor = after ?? { key: 0, places: true, after: [] };
  while (at.key < places.length) {
    if (budget <= 0) return { messages, next: at };
    const place = places[at.key]!;
    const key = place.mailbox;
    if (firsts.get(JSON.stringify(place)) !== at.key) { at = { key: at.key + 1, places: true, after: [] }; continue; }
    if (at.places) {
      // the folder's places by a live walk of its index kept between slices (as carryFolder's), each slice its next
      // `budget` (Codex code review round 5 #4: each slice walked and sorted the whole mailbox). `after`: how many
      // the walk has looked at; one lost (a reload, many counts at once) is walked again past those, once
      const seen = at.after[0] ?? 0;
      const token = `${accountId}\u0000${JSON.stringify(places)}\u0000${at.key}`;
      let walks = countWalks.get(c);
      if (!walks) countWalks.set(c, (walks = new Map()));
      let walk = walks.get(`${token}\u0000${seen}`);
      walks.delete(`${token}\u0000${seen}`);
      if (!walk) {
        walk = locations.keysBy("mailbox", accountId, key);
        for (let i = 0; i < seen && !walk.next().done; i++);
      }
      const asked = budget;
      let n = 0;
      let ended = false;
      while (n < asked) {
        const k = walk.next();
        if (k.done) { ended = true; break; }
        n++;
        const l = locations.rows.get(k.value);
        if (l && firstPlace(l.message_id as number) === at.key) messages++;
      }
      budget -= Math.max(1, n);
      if (ended) at = { key: at.key, places: false, after: [] };
      else {
        // a few kept (counts left unfinished let theirs go)
        if (walks.size >= 16) walks.delete(walks.keys().next().value!);
        walks.set(`${token}\u0000${seen + n}`, walk);
        at = { key: at.key, places: true, after: [seen + n] };
      }
      continue;
    }
    // a renamed folder's old path under one UIDVALIDITY: its places only (its threads are the new key's rows)
    if (place.uidvalidity !== undefined) { at = { key: at.key + 1, places: true, after: [] }; continue; }
    // inside a thread: the rest of it
    const [thread = 0, message] = at.after;
    if (message !== undefined) {
      const cut = countThread(thread, message);
      // read to its end: the threads after it, from the top (where the budget is looked at)
      at = { key: at.key, places: false, after: cut !== null ? [thread, cut] : [thread] };
      continue;
    }
    const asked = budget;
    const top = stretch(c, { accountId, folder: key }, thread, asked);
    // a big folder's members still being read: the next slice goes on (Codex code review round 8 #5)
    if (top === null) return { messages, next: { key: at.key, places: false, after: [pendingAfter(thread)] } };
    let stopped: FolderCountCursor | null = null;
    for (const id of top) {
      budget--;
      // read under the first folder that holds it
      const held = memberships.by("fk_thread_id", id).some((r) => (index.get(r.folder as string) ?? Infinity) < at.key);
      const cut = held ? null : countThread(id, null);
      if (cut !== null) { stopped = { key: at.key, places: false, after: [id, cut] }; break; }
      if (budget <= 0) { stopped = { key: at.key, places: false, after: [id] }; break; }
    }
    at = stopped ?? (top.length >= asked ? { key: at.key, places: false, after: [top.at(-1)!] } : { key: at.key + 1, places: true, after: [] });
  }
  return { messages, next: null };
}

/** a count's walks of a folder's places, per store, by the count's folders, the folder and how far it has looked */
const countWalks = new WeakMap<Ctx, Map<string, Iterator<Key>>>();

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
  // the folder's locations as its index holds them, walked by a cursor kept for the job: each slice its next
  // `limit`, never the whole folder read, copied and sorted first (Codex R6, R47: 500,000 sorted in one slice, 170 ms).
  // Adding a membership that's missing is idempotent, so a job resumed after a reload walks the folder again from its
  // start; a location added meanwhile is the incremental writes' (and a live index visits it), one gone is skipped
  const at = `${job.account_id}\u0000${job.key}`;
  let cached = rebuildOrders.get(c);
  if (!cached) rebuildOrders.set(c, (cached = new Map()));
  let walk = cached.get(at);
  if (!walk) cached.set(at, (walk = { keys: T(c, "message_locations").keysBy("mailbox", job.account_id, job.key), pending: null, done: false }));
  // a slice not yet saved (its command rolled back) is walked again first (Codex R48); `confirmRebuilt` lets it go
  if (!walk.pending) {
    walk.pending = [];
    while (walk.pending.length < limit) {
      const next = walk.keys.next();
      if (next.done) {
        walk.done = true;
        break;
      }
      walk.pending.push(next.value);
    }
  }
  const locations = T(c, "message_locations");
  const messages = T(c, "messages");
  const threadRows = T(c, "threads");
  const threads: number[] = [];
  const done = walk.done;
  for (const key of walk.pending) {
    const l = locations.rows.get(key);
    // this folder's rows only (its old ones went in phase 0), from its messages: no thread refolded (Codex R11)
    if (!l) continue;
    const m = messages.get(l.message_id);
    if (!m || m.is_trash || m.is_spam || memberships.has(m.thread_id, job.key)) continue;
    const t = threadRows.get(m.thread_id);
    if (!t) continue;
    memberships.insert({ thread_id: t.id, account_id: t.account_id, folder: job.key, last_date: t.last_date, unread: t.unread_count > 0 ? 1 : 0 });
    threads.push(t.id as number);
  }
  if (done) {
    jobs.deleteRow(job);
    cached.delete(at);
  }
  return { more: left(), touched: threads };
}

/** A job's walk of its folder's locations, per store: started on its first slice (after a reload, again from the start) */
const rebuildOrders = new WeakMap<Ctx, Map<string, { keys: Iterator<Key>; pending: Key[] | null; done: boolean }>>();

/** The last rebuild slice is saved: its walk goes on from there (Codex R48: a rolled-back one is walked again). */
export function confirmRebuilt(c: Ctx): void {
  for (const walk of rebuildOrders.get(c)?.values() ?? []) walk.pending = null;
}

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
  // a folder reads through the account's list: one it no longer lists holds nothing (its rows wait unseen)
  const listed = T(c, "folders").has(p.accountId, p.folder);
  // the "Unread" filter walks the folder's unread memberships alone, by date (Codex R11: an all-read folder walked
  // whole), kept sorted across pages (Codex R12: never re-sorted per page)
  const filter = listFilterOf(p);
  const unreadOnly = listed && filter === "unread";
  const unread = unreadOnly ? c.scopes.folderUnreadByDate(c, p.accountId!, p.folder!) : null;
  const byDate = listed && !unreadOnly ? c.scopes.folderByDate(c, p.accountId!, p.folder!) : [];
  // a big folder's order (or its Unread one) still being built: this page selected from its members, newest first
  // (Codex R48, R49)
  if (byDate === null || (unreadOnly && unread === null)) return selectFolderPage(c, p, unreadOnly ? "unread" : "folder");
  const size = unread ? unread.length : byDate.length;
  const order = unread ?? byDate;
  const floor = filter === "waiting" ? waitingCutoff(p.now!) : -Infinity;
  // Validate the order first: pending membership/date changes can bring a row back into the window.
  if (filter === "waiting" && !p.keepIds?.length && (!size || order[0]!.date < floor)) return { items: [], nextCursor: null };
  const threads = T(c, "threads");
  const pass = keeps(p);
  const before = (t: R) => !p.cursor || t.last_date < p.cursor.lastDate || (t.last_date === p.cursor.lastDate && t.id < p.cursor.id);
  let lo = 0;
  let hi = size;
  while (p.cursor && lo < hi) {
    const mid = (lo + hi) >> 1;
    const at = order[mid]!;
    if (at.date < p.cursor.lastDate || (at.date === p.cursor.lastDate && at.id < p.cursor.id)) hi = mid;
    else lo = mid + 1;
  }
  const rows: R[] = [];
  // newest first: "Waiting" stops at its window's start (Codex R26: an expired folder walked whole)
  for (let i = lo; i < size && rows.length <= p.limit; i++) {
    const at = order[i]!;
    if (at.date < floor) break;
    const t = threads.get(at.id);
    if (pass(t)) rows.push(t);
  }
  const hasMore = rows.length > p.limit;
  const items: ThreadSummary[] = (hasMore ? rows.slice(0, p.limit) : rows).map((t) => toSummary(c, t));
  const last = items[items.length - 1];
  const page = { items, nextCursor: hasMore && last ? { lastDate: last.lastDate, id: last.id } : null };
  if (!filter || !p.keepIds?.length) return page;
  const inView = keeps({ ...p, filter: undefined, unreadOnly: false });
  const memberships = T(c, "thread_folders");
  const kept = [...new Set(p.keepIds)].filter((id) => listed && memberships.has(id, p.folder)).map((id) => threads.get(id)).filter((t): t is R => inView(t) && before(t));
  return keepInPage(page, kept.map((t) => toSummary(c, t)));
}

/** A folder's page while its order is built: one walk of its members keeping the newest `limit + 1` that pass. */
function selectFolderPage(c: Ctx, p: ListParams, index: "folder" | "unread"): Page {
  const threads = T(c, "threads");
  const memberships = T(c, "thread_folders");
  const pass = keeps(p);
  const floor = listFilterOf(p) === "waiting" ? waitingCutoff(p.now!) : Number.NEGATIVE_INFINITY;
  const before = (t: R) => !p.cursor || t.last_date < p.cursor.lastDate || (t.last_date === p.cursor.lastDate && t.id < p.cursor.id);
  const newer = (a: R, b: R) => b.last_date - a.last_date || b.id - a.id;
  const top: R[] = [];
  const cursorDate = p.cursor ? p.cursor.lastDate : Number.POSITIVE_INFINITY;
  for (const k of memberships.keysBy(index, p.accountId, p.folder)) {
    const m = memberships.rows.get(k)!;
    // the membership's own date (the thread's) rules most out before the thread is looked up
    const d = m.last_date as number;
    if (d < floor || d > cursorDate || (top.length > p.limit && d < top[p.limit]!.last_date)) continue;
    const t = threads.get(m.thread_id);
    if (!t || !before(t) || !pass(t)) continue;
    if (top.length > p.limit && newer(t, top[p.limit]!) >= 0) continue;
    let lo = 0;
    let hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (newer(top[mid]!, t) < 0) lo = mid + 1;
      else hi = mid;
    }
    top.splice(lo, 0, t);
    if (top.length > p.limit + 1) top.pop();
  }
  const hasMore = top.length > p.limit;
  const items: ThreadSummary[] = (hasMore ? top.slice(0, p.limit) : top).map((t) => toSummary(c, t));
  const last = items[items.length - 1];
  const page = { items, nextCursor: hasMore && last ? { lastDate: last.lastDate, id: last.id } : null };
  if (!listFilterOf(p) || !p.keepIds?.length) return page;
  const inView = keeps({ ...p, filter: undefined, unreadOnly: false });
  const kept = [...new Set(p.keepIds)].filter((id) => memberships.has(id, p.folder)).map((id) => threads.get(id)).filter((t): t is R => inView(t) && before(t));
  return keepInPage(page, kept.map((t) => toSummary(c, t)));
}

/** A folder's thread ids above `after`, ascending: its cached members from a seek, walked until the page is full. */
export function folderScopeIds(c: Ctx, p: ScopeParams & { after?: number; limit: number }): number[] {
  const threads = T(c, "threads");
  const ids = T(c, "folders").has(p.accountId, p.folder) ? c.scopes.folder(c, p.accountId!, p.folder!) : [];
  const pass = keeps(p);
  if (ids === null) {
    // still being built (Codex R51): the smallest `limit` members above `after` that pass, from one walk and one
    // native sort (Codex R52: a count's limit of 100,001 placed by splice was quadratic)
    const memberships = T(c, "thread_folders");
    const after = p.after ?? 0;
    if (p.limit <= 5000) {
      // a page: placed in order as found, the view and filter only for what can still make it
      const top: number[] = [];
      for (const k of memberships.keysBy("folder", p.accountId, p.folder)) {
        const id = memberships.rows.get(k)!.thread_id as number;
        if (id <= after || (top.length >= p.limit && id > top[p.limit - 1]!) || !pass(threads.get(id))) continue;
        top.splice(seekAfter(top, id - 1), 0, id);
        if (top.length > p.limit) top.pop();
      }
      return top;
    }
    // a count's (a limit of 100,001): one native sort, never a splice each
    const found: number[] = [];
    for (const k of memberships.keysBy("folder", p.accountId, p.folder)) {
      const id = memberships.rows.get(k)!.thread_id as number;
      if (id > after) found.push(id);
    }
    // sorted, then the view and filter looked at only until the page is full
    const sorted = Float64Array.from(found).sort();
    const out: number[] = [];
    for (let i = 0; i < sorted.length && out.length < p.limit; i++) if (pass(threads.get(sorted[i]!))) out.push(sorted[i]!);
    return out;
  }
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

/**
 * Plan 107: a renamed IMAP folder's threads under its new key, a slice at a time (the SQL adapter's carryFolder):
 * a live walk of the folder's index kept between slices, each row checked by its key (Codex code review round 3
 * #5: never the whole folder per slice). `after` 0 starts the walk; `next` is non-null while rows remain.
 */
export function carryFolder(c: Ctx, accountId: number, from: string, to: string, after: number, limit: number): { next: number | null } {
  const memberships = T(c, "thread_folders");
  let walks = carryWalks.get(c);
  if (!walks) carryWalks.set(c, (walks = new Map()));
  const at = `${accountId}\u0000${from}\u0000${to}`;
  let walk = walks.get(at);
  if (after === 0 || !walk) walks.set(at, (walk = memberships.keysBy("folder", accountId, from)));
  let last: number | null = null;
  let n = 0;
  while (n < limit) {
    const k = walk.next();
    if (k.done) break;
    const r = memberships.rows.get(k.value);
    if (!r) continue;
    n++;
    last = r.thread_id as number;
    if (!memberships.has(r.thread_id, to)) memberships.insert({ thread_id: r.thread_id, account_id: accountId, folder: to, last_date: r.last_date, unread: r.unread });
  }
  if (n < limit) {
    walks.delete(at);
    return { next: null };
  }
  return { next: last };
}
const carryWalks = new WeakMap<Ctx, Map<string, Iterator<Key>>>();
