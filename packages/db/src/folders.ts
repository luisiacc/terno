import type { Folder } from "@terno/core";
import { mergedBehind, type FolderCountCursor, type FolderPlace, type ProviderFolder } from "@terno/store";
import { threadMerges } from "./ingest";
import { unreadSlot } from "./migrations";
import { placeholders, type Db } from "./sqlite";

/**
 * Plan 68: an account's own folders and which threads are in them.
 *
 * Membership is the store's, written in the same transaction as what decides it: recomputeThreads (ingest,
 * flag and label updates, actions, deletion) and every IMAP location write. A thread is in a folder when one
 * of its messages (not in trash or spam) carries the folder's key:
 *  - Gmail: a user label id (`Label_*`) in its labels, listed or not yet, so nothing waits for /labels;
 *  - IMAP: a location in a mailbox the account lists as a folder (role mailboxes never are).
 * `last_date` and `unread` are the thread's, so pages and counts never touch threads.
 */
/**
 * a location in a listed folder's own generation: never one its path's `except_json` names (another folder's mail,
 * cached under a path made again after a rename or delete here: Codex code review round 8 #1)
 */
const OWN = (l: string, f: string) => `(${f}.except_json IS NULL OR ${l}.uidvalidity NOT IN (SELECT value FROM json_each(${f}.except_json)))`;

/**
 * a location under a generation a pending rename here moved (`folder_aliases`: its old path and UIDVALIDITY) is the
 * new key's membership until the pass that reads it retires the rename (Codex code review round 16 #1: a thread's
 * refresh dropped the carried row, and the renamed folder lost its mail and unread count until the pass). By the
 * alias's primary key, one probe a location; none at all when no rename is pending (the table is empty).
 */
const ALIASED = (ids: string) => /* sql */ `
  SELECT m.thread_id AS tid, a.key AS folder FROM messages m JOIN message_locations l ON l.message_id = m.id
   JOIN folder_aliases a ON a.account_id = l.account_id AND a.mailbox = l.mailbox AND a.uidvalidity = l.uidvalidity
   WHERE m.thread_id IN (SELECT value FROM json_each(${ids})) AND m.is_trash = 0 AND m.is_spam = 0`;

const MEMBERSHIP = /* sql */ `
INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread)
SELECT t.id, t.account_id, k.folder, t.last_date, t.unread_count > 0 FROM (
  SELECT m.thread_id AS tid, j.value AS folder FROM messages m, json_each(CASE WHEN json_valid(m.gmail_labels) THEN m.gmail_labels ELSE '[]' END) j
   WHERE m.thread_id IN (SELECT value FROM json_each(?1)) AND m.is_trash = 0 AND m.is_spam = 0
     AND instr(m.gmail_labels, 'Label_') > 0 AND j.value LIKE 'Label\\_%' ESCAPE '\\'
  UNION
  SELECT m.thread_id, l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id JOIN folders f ON f.account_id = l.account_id AND f.key = l.mailbox
   WHERE m.thread_id IN (SELECT value FROM json_each(?1)) AND m.is_trash = 0 AND m.is_spam = 0 AND ${OWN("l", "f")}
  UNION
  ${ALIASED("?1")}
) k JOIN threads t ON t.id = k.tid`;

/**
 * Rewrites these threads' folder memberships from their messages, set at a time (a thread that's gone has none:
 * the cascade). A message whose labels hold no user label is never parsed; with no folder listed, no location is read.
 */
export function refreshFolders(db: Db, threadIds: Iterable<number>): void {
  const ids = [...threadIds];
  if (!ids.length) return;
  const json = JSON.stringify(ids);
  db.run("DELETE FROM thread_folders WHERE thread_id IN (SELECT value FROM json_each(?))", json);
  db.run(MEMBERSHIP, json);
}

/** A message's user labels (Gmail `Label_*`) from its raw labels; anything malformed has none. */
export function userLabels(raw: string): string[] {
  try {
    const labels: unknown = JSON.parse(raw);
    return Array.isArray(labels) ? labels.filter((l): l is string => typeof l === "string" && l.startsWith("Label_")) : [];
  } catch {
    return [];
  }
}

/** What recomputeThreads folded for a thread's folders: its labels (from messages not in trash or spam) and aggregates. */
export interface FoldedThread {
  id: number;
  accountId: number;
  lastDate: number;
  unread: 0 | 1;
  labels: Set<string>;
}

/**
 * recomputeThreads' side of membership: the labels it already read, the locations of accounts that list folders
 * (one read), the rows there are (one read); then only the differences are written. A thread in no folder,
 * the common case, costs the two reads of its batch and no write.
 */
export function writeFolders(db: Db, threads: readonly FoldedThread[]): void {
  if (!threads.length) return;
  const json = JSON.stringify(threads.map((t) => t.id));
  const want = new Map(threads.map((t) => [t.id, new Set(t.labels)]));
  if (db.get("SELECT 1 FROM folders LIMIT 1")) {
    for (const r of db.all<{ thread_id: number; mailbox: string }>(
      `SELECT m.thread_id, l.mailbox FROM messages m JOIN message_locations l ON l.message_id = m.id JOIN folders f ON f.account_id = l.account_id AND f.key = l.mailbox
       WHERE m.thread_id IN (SELECT value FROM json_each(?)) AND m.is_trash = 0 AND m.is_spam = 0 AND ${OWN("l", "f")}`,
      json,
    )) want.get(r.thread_id)?.add(r.mailbox);
    // and a pending rename's (round 16 #1): read only while one is
    if (db.get("SELECT 1 FROM folder_aliases LIMIT 1")) for (const r of db.all<{ tid: number; folder: string }>(ALIASED("?"), json)) want.get(r.tid)?.add(r.folder);
  }
  const have = new Map<number, Map<string, { last_date: number; unread: number }>>();
  for (const r of db.all<{ thread_id: number; folder: string; last_date: number; unread: number }>("SELECT thread_id, folder, last_date, unread FROM thread_folders WHERE thread_id IN (SELECT value FROM json_each(?))", json)) {
    let rows = have.get(r.thread_id);
    if (!rows) have.set(r.thread_id, (rows = new Map()));
    rows.set(r.folder, r);
  }
  for (const t of threads) {
    const keys = want.get(t.id)!;
    const rows = have.get(t.id);
    for (const [folder, r] of rows ?? []) {
      if (!keys.has(folder)) db.run("DELETE FROM thread_folders WHERE thread_id = ? AND folder = ?", t.id, folder);
      else if (r.last_date !== t.lastDate || r.unread !== t.unread) db.run("UPDATE thread_folders SET last_date = ?, unread = ? WHERE thread_id = ? AND folder = ?", t.lastDate, t.unread, t.id, folder);
    }
    for (const folder of keys) if (!rows?.has(folder)) db.run("INSERT INTO thread_folders (thread_id, account_id, folder, last_date, unread) VALUES (?, ?, ?, ?, ?)", t.id, t.accountId, folder, t.lastDate, t.unread);
  }
}

/** The threads of these messages, for a membership refresh after their locations changed. */
export function threadsOfMessages(db: Db, messageIds: readonly number[]): number[] {
  const out = new Set<number>();
  for (let i = 0; i < messageIds.length; i += 500) {
    const chunk = messageIds.slice(i, i + 500);
    for (const r of db.all<{ thread_id: number }>(`SELECT DISTINCT thread_id FROM messages WHERE id IN (${placeholders(chunk.length)})`, ...chunk)) out.add(r.thread_id);
  }
  return [...out];
}

/**
 * a location of message `id` in one of these places (`places`: a JSON array of `{ m: mailbox, v: UIDVALIDITY or
 * null, x: UIDVALIDITYs left out }`): a path made again after a rename here holds two folders' mail (Codex code review
 * round 6 #2). The message's few locations by the primary key, each matched against the places (none, a Gmail one).
 */
const placed = (id: string, places: string) => `EXISTS (SELECT 1 FROM message_locations e WHERE e.message_id = ${id} AND EXISTS (SELECT 1 FROM json_each(${places}) p
  WHERE json_extract(p.value, '$.m') = e.mailbox AND coalesce(json_extract(p.value, '$.v'), e.uidvalidity) = e.uidvalidity AND e.uidvalidity NOT IN (SELECT value FROM json_each(p.value, '$.x'))))`;

/** a message counted in its thread: one of these labels (?5, outside trash and spam), and no place in these folders (?2, counted by it) */
const LABELLED = `m.is_trash = 0 AND m.is_spam = 0 AND instr(m.gmail_labels, 'Label_') > 0
  AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(m.gmail_labels) THEN m.gmail_labels ELSE '[]' END) j WHERE j.value IN (SELECT value FROM json_each(?5)))
  AND NOT ${placed("m.id", "?2")}`;

type Place = { mailbox: string; uidvalidity?: number; except?: readonly number[] };
export const toPlace = (k: FolderPlace): Place => (typeof k === "string" ? { mailbox: k } : k);
const placesJson = (places: readonly Place[]) => JSON.stringify(places.map((p) => ({ m: p.mailbox, v: p.uidvalidity ?? null, x: p.except ?? [] })));

/**
 * Plan 107: the account's messages in these folders (MailStore.folders.count; the IndexedDB adapter's
 * countFolderMessages), a slice at a time. Folder by folder: its places (a message counted in the first folder that
 * places it), then its rows' threads (one an earlier folder holds was read there), each thread's messages by the
 * thread index (counted by label when no folder places them). What's looked at is bounded by `limit`, never by how
 * many match (Codex code review round 4 #3: every sublabel read the same long conversation again, in one call).
 */
export function countFolderMessages(db: Db, accountId: number, keys: readonly FolderPlace[], after: FolderCountCursor | null, limit: number): { messages: number; next: FolderCountCursor | null; restarted?: true } {
  const places = keys.map(toPlace);
  const all = placesJson(places);
  // the folders' keys, for labels and rows (a renamed folder's old path under one UIDVALIDITY has neither)
  const folders = (to: number) => JSON.stringify(places.slice(0, to).filter((p) => p.uidvalidity === undefined).map((p) => p.mailbox));
  const labels = folders(places.length);
  // a merge since the last slice into a thread the count passed took messages it hadn't read behind it: it starts over
  // (Codex code review round 19 #2: thread 2 merged into thread 1 after the walk passed 1 left thread 2's out)
  const merges = threadMerges(db);
  const restarted = after?.merges !== undefined && mergedBehind(after, merges.into(after.merges), places, (t) => db.all<{ folder: string }>("SELECT folder FROM thread_folders WHERE thread_id = ?", t).map((r) => r.folder));
  let messages = 0;
  let budget = Math.max(1, limit);
  let at: FolderCountCursor = (!restarted && after) || { key: 0, places: true, after: [] };
  const answer = (next: FolderCountCursor | null) => ({ messages, next: next && { ...next, merges: merges.current }, ...(restarted && { restarted: true as const }) });
  while (at.key < places.length) {
    if (budget <= 0) return answer(at);
    const place = places[at.key]!;
    const key = place.mailbox;
    if (at.places) {
      // by the place index, a UIDVALIDITY at a time: the one named, or each but those left out, found by a seek
      // (Codex code review round 6 #2), then its UIDs past `after`
      const earlier = placesJson(places.slice(0, at.key));
      const generation = (above: number): number | undefined => {
        if (place.uidvalidity !== undefined) return above < place.uidvalidity ? place.uidvalidity : undefined;
        for (;;) {
          const next = db.get<{ v: number }>("SELECT uidvalidity AS v FROM message_locations INDEXED BY message_locations_uid WHERE account_id = ? AND mailbox = ? AND uidvalidity > ? ORDER BY uidvalidity LIMIT 1", accountId, key, above)?.v;
          if (next === undefined || !place.except?.includes(next)) return next;
          above = next;
        }
      };
      const select = `SELECT l.uid AS u, NOT ${placed("l.message_id", "?3")} AS ok
        FROM message_locations l INDEXED BY message_locations_uid WHERE l.account_id = ?1 AND l.mailbox = ?2 AND l.uidvalidity = ?4 AND l.uid > ?5 ORDER BY l.uid LIMIT ?6`;
      let v = at.after.length ? at.after[0] : generation(-1);
      let u = at.after[1] ?? -1;
      for (;;) {
        if (v === undefined) { at = { key: at.key, places: false, after: [] }; break; }
        const asked = budget;
        const rows = db.all<{ u: number; ok: number }>(select, accountId, key, earlier, v, u, asked);
        for (const r of rows) messages += r.ok ? 1 : 0;
        budget -= Math.max(1, rows.length);
        if (rows.length >= asked) { at = { key: at.key, places: true, after: [v, rows.at(-1)!.u] }; break; }
        v = generation(v);
        u = -1;
        if (budget <= 0) { at = v === undefined ? { key: at.key, places: false, after: [] } : { key: at.key, places: true, after: [v, -1] }; break; }
      }
      continue;
    }
    // a renamed folder's old path under one UIDVALIDITY: its places only (its threads are the new key's rows)
    if (place.uidvalidity !== undefined) { at = { key: at.key + 1, places: true, after: [] }; continue; }
    const earlier = folders(at.key);
    // inside a thread: the rest of it, past (date, id)
    const [thread = 0, date, id] = at.after;
    if (date !== undefined && id !== undefined) {
      const cut = countThread(thread, { date, id });
      // read to its end: the threads after it, from the top (where the budget is looked at)
      at = { key: at.key, places: false, after: cut ? [thread, cut.date, cut.id] : [thread] };
      continue;
    }
    const asked = budget;
    const threads = db.all<{ id: number; dup: number }>(
      `SELECT f.thread_id AS id, EXISTS (SELECT 1 FROM thread_folders e WHERE e.thread_id = f.thread_id AND e.folder IN (SELECT value FROM json_each(?4))) AS dup
       FROM thread_folders f INDEXED BY thread_folders_id WHERE f.account_id = ?1 AND f.folder = ?2 AND f.thread_id > ?3 ORDER BY f.thread_id LIMIT ?5`,
      accountId, key, thread, earlier, asked,
    );
    let stopped: FolderCountCursor | null = null;
    for (const t of threads) {
      budget--;
      const cut = t.dup ? null : countThread(t.id, null);
      if (cut) { stopped = { key: at.key, places: false, after: [t.id, cut.date, cut.id] }; break; }
      if (budget <= 0) { stopped = { key: at.key, places: false, after: [t.id] }; break; }
    }
    if (stopped) at = stopped;
    else at = threads.length >= asked ? { key: at.key, places: false, after: [threads.at(-1)!.id] } : { key: at.key + 1, places: true, after: [] };
  }
  return answer(null);

  /** a thread's messages from `from` (null: its start), up to the budget: where it stopped, or null when read to its end */
  function countThread(thread: number, from: { date: number; id: number } | null): { date: number; id: number } | null {
    const select = `SELECT m.id, m.date, (${LABELLED}) AS ok FROM messages m INDEXED BY messages_thread WHERE m.thread_id = ?1`;
    // one more than the budget: whether the thread goes on past it
    const n = Math.max(1, budget) + 1;
    const same = from ? db.all<{ id: number; date: number; ok: number }>(`${select} AND m.date = ?3 AND m.id > ?4 ORDER BY m.id LIMIT ?6`, thread, all, from.date, from.id, labels, n) : [];
    const rows = same.length >= n ? same : [...same, ...db.all<{ id: number; date: number; ok: number }>(`${select} AND m.date ${from ? ">" : ">="} ?3 ORDER BY m.date, m.id LIMIT ?4`, thread, all, from?.date ?? Number.MIN_SAFE_INTEGER, n - same.length, labels)];
    const taken = rows.length > n - 1 ? rows.slice(0, n - 1) : rows;
    for (const r of taken) messages += r.ok ? 1 : 0;
    budget -= taken.length;
    return rows.length > taken.length ? { date: taken.at(-1)!.date, id: taken.at(-1)!.id } : null;
  }
}

/** Whether a mailbox is one of the account's listed folders (a role mailbox's locations decide no membership). */
export function isFolder(db: Db, accountId: number, key: string): boolean {
  return db.get("SELECT 1 FROM folders WHERE account_id = ? AND key = ?", accountId, key) !== undefined;
}

/**
 * A listed folder's generations that are another folder's (`except_json`), or null when the mailbox isn't a listed
 * folder: a location under one of them makes no membership (Codex code review round 8 #1).
 */
export function folderExcept(db: Db, accountId: number, key: string): readonly number[] | null {
  const r = db.get<{ except_json: string | null }>("SELECT except_json FROM folders WHERE account_id = ? AND key = ?", accountId, key);
  return r ? exceptOf(r.except_json) : null;
}

const exceptOf = (json: string | null): number[] => {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
};
/** a folder's `except` as stored: sorted, NULL when there's none */
const exceptJson = (except: readonly number[] | undefined): string | null => (except?.length ? JSON.stringify([...new Set(except)].sort((a, b) => a - b)) : null);

interface FolderRow {
  account_id: number;
  key: string;
  path_json: string;
  selectable: number;
  except_json: string | null;
}

type Alias = { mailbox: string; uidvalidity: number };
/** a folder's aliases as compared and stored: one each, by path then UIDVALIDITY */
const aliasesOf = (aliases: readonly Alias[] | undefined): Alias[] =>
  [...new Map((aliases ?? []).map((a) => [`${a.uidvalidity}\u0000${a.mailbox}`, { mailbox: a.mailbox, uidvalidity: a.uidvalidity }])).values()].sort((a, b) => (a.mailbox < b.mailbox ? -1 : a.mailbox > b.mailbox ? 1 : a.uidvalidity - b.uidvalidity));
/** the account's aliases, by folder key (a handful: only while a rename here waits for its pass) */
function aliasesByKey(db: Db, accountId?: number): Map<string, Alias[]> {
  const out = new Map<string, Alias[]>();
  const rows = accountId === undefined
    ? db.all<{ account_id: number; key: string; mailbox: string; uidvalidity: number }>("SELECT account_id, key, mailbox, uidvalidity FROM folder_aliases")
    : db.all<{ account_id: number; key: string; mailbox: string; uidvalidity: number }>("SELECT account_id, key, mailbox, uidvalidity FROM folder_aliases WHERE account_id = ?", accountId);
  for (const r of rows) {
    const at = `${r.account_id}\u0000${r.key}`;
    out.set(at, [...(out.get(at) ?? []), { mailbox: r.mailbox, uidvalidity: r.uidvalidity }]);
  }
  for (const [at, list] of out) out.set(at, aliasesOf(list));
  return out;
}
const sameAliases = (a: readonly Alias[], b: readonly Alias[]) => a.length === b.length && a.every((x, i) => x.mailbox === b[i]!.mailbox && x.uidvalidity === b[i]!.uidvalidity);

const toFolder = (r: FolderRow, aliases?: readonly Alias[]): Folder => ({ accountId: r.account_id, key: r.key, path: JSON.parse(r.path_json) as string[], selectable: r.selectable === 1, ...(r.except_json && { except: exceptOf(r.except_json) }), ...(aliases?.length && { aliases: aliases.map((a) => ({ ...a })) }) });

export function listFolders(db: Db): Folder[] {
  const aliases = aliasesByKey(db);
  return db.all<FolderRow>("SELECT account_id, key, path_json, selectable, except_json FROM folders ORDER BY account_id, position").map((r) => toFolder(r, aliases.get(`${r.account_id}\u0000${r.key}`)));
}

/**
 * An account's list now; nothing is written when it's the same. Memberships never wait on the list (Codex R1):
 * Gmail's follow the labels, and a folder no longer listed keeps its rows unseen (every read goes through the
 * list). A newly listed IMAP folder gets a rebuild job instead of a rebuild here (Codex R5: one transaction over a
 * big folder held the backend): `rebuildFolders` runs it a slice at a time, resumable.
 */
export function replaceFolders(db: Db, accountId: number, folders: readonly ProviderFolder[], carried: readonly string[] = [], rebuild: readonly string[] = []): { changed: boolean; touched: number[] } {
  return db.tx(() => {
    // by key, the differences only (Codex R14: a rename in 10,000 folders rewrote them all): a new folder goes after
    // the others (the order is the sidebar's to draw, by path), a renamed one changes in place, a gone one goes
    const before = new Map(db.all<FolderRow & { position: number }>("SELECT account_id, key, path_json, selectable, except_json, position FROM folders WHERE account_id = ?", accountId).map((r) => [r.key, r]));
    const known = new Set(before.keys());
    const next = new Set<string>();
    // listed before with other generations left out: its memberships are derived again (Codex code review round 8 #1)
    const regenerated = new Set<string>();
    // a pending rename's aliases, as stored (round 16 #1): written where they differ, never a rebuild (the rename's
    // carry already wrote the rows they derive)
    const aliasesBefore = aliasesByKey(db, accountId);
    let position = Math.max(-1, ...[...before.values()].map((r) => r.position));
    let changed = false;
    for (const f of folders) {
      if (next.has(f.key)) continue;
      next.add(f.key);
      const path = JSON.stringify(f.path);
      const except = exceptJson(f.except);
      const was = before.get(f.key);
      if (!was) {
        db.run("INSERT INTO folders (account_id, key, path_json, selectable, position, except_json) VALUES (?, ?, ?, ?, ?, ?)", accountId, f.key, path, f.selectable ? 1 : 0, ++position, except);
        changed = true;
      } else if (was.path_json !== path || (was.selectable === 1) !== f.selectable || was.except_json !== except) {
        db.run("UPDATE folders SET path_json = ?, selectable = ?, except_json = ? WHERE account_id = ? AND key = ?", path, f.selectable ? 1 : 0, except, accountId, f.key);
        if (was.except_json !== except) regenerated.add(f.key);
        changed = true;
      }
      const aliases = aliasesOf(f.aliases);
      if (!sameAliases(aliasesBefore.get(`${accountId}\u0000${f.key}`) ?? [], aliases)) {
        db.run("DELETE FROM folder_aliases WHERE account_id = ? AND key = ?", accountId, f.key);
        for (const a of aliases) db.run("INSERT INTO folder_aliases (account_id, key, mailbox, uidvalidity) VALUES (?, ?, ?, ?)", accountId, f.key, a.mailbox, a.uidvalidity);
        changed = true;
      }
    }
    for (const key of known) {
      if (next.has(key)) continue;
      db.run("DELETE FROM folders WHERE account_id = ? AND key = ?", accountId, key);
      changed = true;
    }
    if (!changed && !rebuild.length) return { changed: false, touched: [] };
    // a job for a folder no longer listed has nothing to do
    db.run("DELETE FROM folder_rebuilds WHERE account_id = ? AND key NOT IN (SELECT key FROM folders WHERE account_id = ?)", accountId, accountId);
    if (db.get<{ kind: string }>("SELECT kind FROM accounts WHERE id = ?", accountId)?.kind === "imap") {
      for (const f of folders) {
        // (a rename's new key keeps the rows just carried to it: Codex code review round 8 #1), unless they were
        // carried from a folder still being rebuilt (round 23 #1): then it's derived again from its places and aliases
        if (rebuild.includes(f.key)) {
          if (f.aliases?.length || db.get("SELECT 1 FROM message_locations INDEXED BY message_locations_uid WHERE account_id = ? AND mailbox = ? LIMIT 1", accountId, f.key)) {
            db.run("INSERT OR REPLACE INTO folder_rebuilds (account_id, key, phase, after_uidvalidity, after_uid) VALUES (?, ?, 0, 0, 0)", accountId, f.key);
          }
          continue;
        }
        if ((known.has(f.key) && !regenerated.has(f.key)) || carried.includes(f.key)) continue;
        // only where there's something to rebuild: its mailbox has locations, or rows a past listing left
        const any =
          f.aliases?.length ||
          db.get("SELECT 1 FROM message_locations INDEXED BY message_locations_uid WHERE account_id = ? AND mailbox = ? LIMIT 1", accountId, f.key) ||
          db.get("SELECT 1 FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? LIMIT 1", accountId, f.key);
        if (any) db.run("INSERT OR REPLACE INTO folder_rebuilds (account_id, key, phase, after_uidvalidity, after_uid) VALUES (?, ?, 0, 0, 0)", accountId, f.key);
      }
    }
    return { changed, touched: [] };
  });
}

/**
 * One slice of a pending rebuild (Codex R5): first the folder's old rows go (`limit` at a time), then its locations
 * are walked in UID order and their threads refolded (`limit` at a time). Each slice is its own transaction, its
 * progress saved with it, so a quit resumes where it was. Location writes meanwhile keep membership as ever.
 */
/** Deduplicate within the slice before insertion: a long thread repeats its labels on every message. */
const MESSAGE_LABELS = /* sql */ `
INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread)
SELECT DISTINCT t.id, t.account_id, j.value, t.last_date, t.unread_count > 0
FROM (SELECT thread_id, gmail_labels FROM messages WHERE id > ?1 AND id <= ?2 AND gmail_labels IS NOT NULL AND is_trash = 0 AND is_spam = 0 AND instr(gmail_labels, 'Label_') > 0) m
JOIN threads t ON t.id = m.thread_id, json_each(CASE WHEN json_valid(m.gmail_labels) THEN m.gmail_labels ELSE '[]' END) j
WHERE j.value LIKE 'Label\\_%' ESCAPE '\\'
RETURNING thread_id`;

/**
 * The upgrade's slice (schema 24): the memberships of a mailbox from before, a few messages at a time, whatever
 * their threads (Codex R14: one conversation of 50,000 is many slices, never one), added beside any a sync wrote
 * meanwhile (those are already right; a label is a membership if any message carries it).
 */
function backfill(db: Db, limit: number, left: () => boolean): { more: boolean; touched: number[] } {
  const fill = db.get<{ after_message_id: number }>("SELECT after_message_id FROM folder_backfill LIMIT 1");
  if (!fill) return { more: false, touched: [] };
  const n = Math.max(1, Math.floor(limit / 5));
  const range = db.get<{ last: number | null; c: number }>("SELECT max(id) AS last, count(*) AS c FROM (SELECT id FROM messages WHERE id > ? ORDER BY id LIMIT ?)", fill.after_message_id, n)!;
  const touched = range.last === null ? [] : [...new Set(db.all<{ thread_id: number }>(MESSAGE_LABELS, fill.after_message_id, range.last).map((r) => r.thread_id))];
  if (range.c < n) db.run("DELETE FROM folder_backfill");
  else db.run("UPDATE folder_backfill SET after_message_id = ?", range.last);
  return { more: left(), touched };
}

/**
 * The upgrade's tally of Archive and Spam unread (schema 41), `limit` threads at a time by id: the triggers count only
 * threads at or below the cursor, so each is counted once. Its last slice names a thread, so the counts refresh.
 */
function tallyViewUnread(db: Db, limit: number, left: () => boolean): { more: boolean; touched: number[] } {
  const fill = db.get<{ after_id: number }>("SELECT after_id FROM view_unread_backfill LIMIT 1");
  if (!fill) return { more: false, touched: [] };
  const range = db.get<{ last: number | null; c: number }>("SELECT max(id) AS last, count(*) AS c FROM (SELECT id FROM threads WHERE id > ? ORDER BY id LIMIT ?)", fill.after_id, limit)!;
  if (range.last !== null)
    db.run(
      `INSERT INTO view_unread (account_id, view, n)
       SELECT account_id, slot, count(*) FROM (SELECT account_id, ${unreadSlot("threads")} AS slot FROM threads INDEXED BY threads_unread_id WHERE unread_count > 0 AND id > ? AND id <= ?)
       WHERE slot IS NOT NULL GROUP BY account_id, slot ORDER BY account_id, slot
       ON CONFLICT (account_id, view) DO UPDATE SET n = n + excluded.n`,
      fill.after_id,
      range.last,
    );
  if (range.c < limit) {
    db.run("DELETE FROM view_unread_backfill");
    return { more: left(), touched: range.last === null ? [] : [range.last] };
  }
  db.run("UPDATE view_unread_backfill SET after_id = ?", range.last);
  return { more: true, touched: [] };
}

export function rebuildFolders(db: Db, limit: number): { more: boolean; touched: number[] } {
  return db.tx(() => {
    const job = db.get<{ account_id: number; key: string; phase: number; after_uidvalidity: number; after_uid: number }>("SELECT account_id, key, phase, after_uidvalidity, after_uid FROM folder_rebuilds LIMIT 1");
    const left = () => db.get("SELECT 1 FROM folder_rebuilds UNION ALL SELECT 1 FROM folder_backfill UNION ALL SELECT 1 FROM view_unread_backfill LIMIT 1") !== undefined;
    if (!job && db.get("SELECT 1 FROM folder_backfill") === undefined) return tallyViewUnread(db, limit, left);
    if (!job) return backfill(db, limit, left);
    const done = () => db.run("DELETE FROM folder_rebuilds WHERE account_id = ? AND key = ?", job.account_id, job.key);
    if (!isFolder(db, job.account_id, job.key)) {
      done();
      return { more: left(), touched: [] };
    }
    if (job.phase === 0) {
      const gone = db.all<{ thread_id: number }>(
        "DELETE FROM thread_folders WHERE folder = ? AND thread_id IN (SELECT thread_id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? LIMIT ?) RETURNING thread_id",
        job.key,
        job.account_id,
        job.key,
        limit,
      );
      if (gone.length < limit) db.run("UPDATE folder_rebuilds SET phase = 1 WHERE account_id = ? AND key = ?", job.account_id, job.key);
      return { more: true, touched: gone.map((r) => r.thread_id) };
    }
    // phase 1 walks the folder's own places; phase 2 + i the i-th place a pending rename here still caches its mail
    // under (its alias: old path and UIDVALIDITY, round 16 #1), so a rebuild never drops what the rename carried
    const aliases = job.phase >= 2 ? (aliasesByKey(db, job.account_id).get(`${job.account_id}\u0000${job.key}`) ?? []) : [];
    const alias = job.phase >= 2 ? aliases[job.phase - 2] : undefined;
    const nextPhase = () => {
      const more = job.phase === 1 ? db.get("SELECT 1 FROM folder_aliases WHERE account_id = ? AND key = ? LIMIT 1", job.account_id, job.key) !== undefined : job.phase - 1 < aliases.length;
      if (more) db.run("UPDATE folder_rebuilds SET phase = ?, after_uidvalidity = 0, after_uid = 0 WHERE account_id = ? AND key = ?", job.phase + 1, job.account_id, job.key);
      else done();
    };
    if (job.phase >= 2 && !alias) {
      done();
      return { more: left(), touched: [] };
    }
    const rows = alias
      ? db.all<{ message_id: number; uidvalidity: number; uid: number }>(
          `SELECT message_id, uidvalidity, uid FROM message_locations INDEXED BY message_locations_uid
           WHERE account_id = ? AND mailbox = ? AND uidvalidity = ? AND uid > ? ORDER BY uid LIMIT ?`,
          job.account_id,
          alias.mailbox,
          alias.uidvalidity,
          job.after_uid,
          limit,
        )
      : db.all<{ message_id: number; uidvalidity: number; uid: number }>(
          `SELECT message_id, uidvalidity, uid FROM message_locations INDEXED BY message_locations_uid
           WHERE account_id = ? AND mailbox = ? AND (uidvalidity, uid) > (?, ?) ORDER BY uidvalidity, uid LIMIT ?`,
          job.account_id,
          job.key,
          job.after_uidvalidity,
          job.after_uid,
          limit,
        );
    // this folder's rows only (its old ones went in phase 0): from the batch's messages, never a refold of their
    // whole threads (Codex R11: a long conversation re-read per slice); never another folder's generation (round 8 #1)
    const except = alias ? [] : (folderExcept(db, job.account_id, job.key) ?? []);
    const ids = JSON.stringify(rows.filter((r) => !except.includes(r.uidvalidity)).map((r) => r.message_id));
    const threads = db
      .all<{ thread_id: number }>(
        `INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread)
         SELECT DISTINCT t.id, t.account_id, ?, t.last_date, t.unread_count > 0 FROM messages m JOIN threads t ON t.id = m.thread_id
         WHERE m.id IN (SELECT value FROM json_each(?)) AND m.is_trash = 0 AND m.is_spam = 0 RETURNING thread_id`,
        job.key,
        ids,
      )
      .map((r) => r.thread_id);
    const last = rows.at(-1);
    if (rows.length < limit) nextPhase();
    else db.run("UPDATE folder_rebuilds SET after_uidvalidity = ?, after_uid = ? WHERE account_id = ? AND key = ?", last!.uidvalidity, last!.uid, job.account_id, job.key);
    return { more: left(), touched: threads };
  });
}

/** Plan 107: a slice of the rows left under a key a rename is about to carry threads to (Store.folders.clear). */
export function clearFolder(db: Db, accountId: number, key: string, limit: number): { more: boolean } {
  return db.tx(() => {
    // a rebuild of what the name held is retired with its rows: walked on, it restored the old folder's mail beside
    // the carried one's (Codex code review round 24 #2); the listing gives the new key its own job when it needs one
    db.run("DELETE FROM folder_rebuilds WHERE account_id = ? AND key = ?", accountId, key);
    const gone = db.all<{ thread_id: number }>(
      "DELETE FROM thread_folders WHERE folder = ? AND thread_id IN (SELECT thread_id FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? LIMIT ?) RETURNING thread_id",
      key, accountId, key, limit,
    );
    return { more: gone.length >= limit };
  });
}

/** Plan 107: a renamed IMAP folder's threads under its new key, a slice by thread id (Store.folders.carry). */
export function carryFolder(db: Db, accountId: number, from: string, to: string, after: number, limit: number): { next: number | null } {
  return db.tx(() => {
    const rows = db.all<{ thread_id: number; last_date: number; unread: number }>(
      "SELECT thread_id, last_date, unread FROM thread_folders INDEXED BY thread_folders_id WHERE account_id = ? AND folder = ? AND thread_id > ? ORDER BY thread_id LIMIT ?",
      accountId, from, after, limit,
    );
    for (const r of rows) db.run("INSERT OR IGNORE INTO thread_folders (thread_id, account_id, folder, last_date, unread) VALUES (?, ?, ?, ?, ?)", r.thread_id, accountId, to, r.last_date, r.unread);
    // its rows may be partial while its own rebuild runs (Codex code review round 23 #1)
    const pending = db.get("SELECT 1 FROM folder_rebuilds WHERE account_id = ? AND key = ?", accountId, from) !== undefined;
    return { next: rows.length < limit ? null : rows.at(-1)!.thread_id, ...(pending && { pending: true as const }) };
  });
}
