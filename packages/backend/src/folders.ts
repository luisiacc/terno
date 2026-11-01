import type { FavoriteFolder, FavoriteFoldersSnapshot, Folder, FolderRename } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { ProviderError, type FolderChange, type FolderMove, type MailProvider } from "@terno/mail/portable";
import type { FolderCountCursor, FolderGeneration, FolderPlace, ProviderFolder } from "@terno/store";
import { BULK_SLICE, SliceSizer } from "./slicer";
import type { BackendCore as Backend } from "./core";
import { followFavoriteFolders, setFavoriteFolder, SettingsError } from "./settings";

/**
 * Plan 107: an account's own folders created, renamed and deleted on its server, and favorites. A change runs alone
 * with the account's provider (BackendCore.changeFolders); what the server lists after it is stored, a rename's
 * `foldersRenamed` goes out before the `folders` it produced, favorites follow, and a sync pass reads the rest.
 */

/** What a failure says to the person: offline, the server's own reason, a name taken, a standard folder. */
function folderError(b: Backend, error: unknown): unknown {
  if (error instanceof RpcError || !(error instanceof ProviderError)) return error;
  if (error.network || !b.connectivity.online) return new RpcError("UNAVAILABLE", L("errors.folder.offline"));
  return new RpcError("BAD_REQUEST", error.message, undefined, { i18n: error.i18n, cause: error });
}

/** threads carried a slice at a time (an IndexedDB write is ~20 µs a row: 500 stay well within a frame) */
const CARRY_SLICE = 500;

/** a count's rows looked at a slice, sized by time */
const COUNT_SLICE = { ...BULK_SLICE, initial: 500, floor: 50, ceiling: 20_000 };

const under = (path: readonly string[], prefix: readonly string[]) => path.length >= prefix.length && prefix.every((p, i) => path[i] === p);

async function accountFolders(b: Backend, accountId: number): Promise<Folder[]> {
  return (await b.store.folders.list()).filter((f) => f.accountId === accountId);
}

/**
 * A rename's new keys keep the folders' threads, then the move is announced: before the `folders` event that follows,
 * so the view, the back stack and favorites follow before the new list can send anyone to the Inbox (Codex R7). Also
 * a sync pass's, for a rename whose answer was lost (Codex code review round 5 #1). Carried before the list that
 * shows it is stored: an old path listed again with the moved generation left out is derived again from its own
 * places (a rebuild that clears its rows), never before its rows were carried (Codex code review round 8 #1).
 */
export async function carryRenamed(b: Backend, accountId: number, renamed: readonly FolderMove[], write: <W>(work: () => Promise<W>) => Promise<W>, announced: readonly FolderMove[] = renamed): Promise<void> {
  // an IMAP rename's new key keeps the folder's threads until the next pass proves where its mail went (Codex
  // code review round 2 #5: else the folder you're in shows empty meanwhile), a slice at a time; never another
  // generation's, shown under the path before it was made again (`stale`: Codex code review round 8)
  for (const m of renamed) {
    if (m.from === m.to) continue;
    // the new key starts empty: rows a folder that had the name left (renamed away before a pass) aren't this one's
    // (Codex code review round 14 #2: Work → Job, then Other → Work, showed Job's threads in Work), a slice at a time
    while ((await write(() => b.store.folders.clear(accountId, m.to, CARRY_SLICE))).more) await b.yieldTurn();
    if (m.stale) continue;
    for (let after: number | null = 0; after !== null; ) {
      const from: number = after;
      after = (await write(() => b.store.folders.carry(accountId, m.from, m.to, from, CARRY_SLICE))).next;
      await b.yieldTurn();
    }
  }
  // a pass's recovery announces every move it hands, carried or not (Codex code review round 15 #2)
  if (announced.length) b.server.emit("foldersRenamed", announced.map((m): FolderRename => ({ accountId, from: m.from, to: m.to })));
}

/**
 * Where these folders' mail is still cached while an IMAP rename made here waits for a pass: the old paths (the IMAP
 * cursor's `renamed`, by new path). The rename carried their threads to the new keys, not their locations, so a count
 * or an export read under the new keys alone found nothing (Codex code review round 5 #2). Each by the UIDVALIDITY
 * the rename recorded: a path made again since is another folder, and these keys' own paths leave out the
 * generations that are another folder's (`except`; Codex code review round 6 #2: by path alone, Job counted nothing
 * and the new Work counted Job's mail): as the folder's listing has them, which the provider checked against the
 * server's STATUS, a rename's and a delete's alike (Codex code review round 8).
 */
export async function renameAliases(b: Backend, accountId: number, keys: readonly string[]): Promise<{ aliases: FolderGeneration[]; except: Map<string, number[]> }> {
  const renamed = (await b.store.accounts.config<{ cursor?: { renamed?: Record<string, { from?: unknown; uidvalidity?: unknown }> } }>(accountId))?.config.cursor?.renamed;
  const aliases: FolderGeneration[] = [];
  const except = new Map<string, number[]>();
  const folders = await accountFolders(b, accountId);
  const asked = new Set(keys);
  for (const f of folders) if (asked.has(f.key) && f.except?.length) except.set(f.key, [...f.except]);
  if (!renamed) return { aliases, except };
  const listed = new Set(folders.map((f) => f.key));
  for (const [to, r] of Object.entries(renamed)) {
    const { from, uidvalidity } = r ?? {};
    // carried out: the new path is listed (one whose answer was lost and that never happened leaves the old one whole)
    if (typeof from !== "string" || typeof uidvalidity !== "number" || from === to || !listed.has(to)) continue;
    if (asked.has(to) && !aliases.some((a) => a.mailbox === from && a.uidvalidity === uidvalidity)) aliases.push({ mailbox: from, uidvalidity });
  }
  return { aliases, except };
}

async function change<R extends FolderChange>(
  b: Backend,
  accountId: number,
  run: (provider: MailProvider, folders: ProviderFolder[]) => Promise<R> | undefined,
  follows: (r: R) => { renamed?: readonly FolderMove[]; deleted?: readonly string[] } = () => ({}),
): Promise<R> {
  if (!(await b.store.accounts.get(accountId))) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  if (!b.connectivity.online) throw new RpcError("UNAVAILABLE", L("errors.folder.offline"));
  const resync = () => { if (b.options.autoSync !== false) void b.syncAccount(accountId).catch(() => {}); };
  return b.changeFolders(accountId, async (provider, account) => {
    // the list as stored (the demo has no catalog of its own; the others read the server's)
    const folders = (await accountFolders(b, accountId)).map(({ accountId: _a, ...f }) => f);
    let result: R;
    try {
      const pending = run(provider, folders);
      if (!pending) throw new RpcError("BAD_REQUEST", L("errors.folder.unsupported"));
      result = await pending;
    } catch (error) {
      // whatever the server did before it failed, the next pass reads (it waits for this change to end)
      resync();
      throw folderError(b, error);
    }
    account.check();
    const { renamed = [], deleted = [] } = follows(result);
    await carryRenamed(b, accountId, renamed, account.write);
    // the list and the favorites that follow it, never between a favorite's check and its write (Codex code review round 10 #4)
    await b.withFolderList(accountId, async () => {
      const stored = await account.write(() => b.store.folders.replace(accountId, result.folders, renamed.map((m) => m.to)));
      if (stored.changed || renamed.length) b.server.emit("folders", await b.store.folders.list());
      b.notifyChanged(stored.touched);
      void b.rebuildFolders();
      if (renamed.length || deleted.length) await b.writeFavorites(() => followFavoriteFolders(b.store, accountId, { renamed, deleted }));
    });
    // persisted: the provider may stop announcing these deletions (Codex code review round 13 #1: acknowledged before,
    // a LIST failing after the DELETE left the favorite for good)
    if (deleted.length) await provider.deletionsFollowed?.(deleted);
    // and these moves (Codex code review round 14 #1: acknowledged before the LIST after the RENAME, a failing one
    // left the move unannounced for good)
    if (renamed.length) await provider.renamesFollowed?.(renamed);
    resync();
    if (result.partial) throw folderError(b, result.partial);
    return result;
  });
}

export async function createFolder(b: Backend, accountId: number, parent: string | null, name: string): Promise<Folder> {
  const r = await change(b, accountId, (p, folders) => p.createFolder?.({ parent, name, folders }));
  const made = r.folders.find((f) => f.key === r.key);
  return { accountId, key: r.key, path: made?.path ?? [name], selectable: made?.selectable ?? true };
}

export async function renameFolder(b: Backend, accountId: number, key: string, name: string): Promise<{ renamed: FolderRename[] }> {
  const r = await change(b, accountId, (p, folders) => p.renameFolder?.({ key, name, folders }), (x) => ({ renamed: x.renamed }));
  return { renamed: r.renamed.map((m) => ({ accountId, from: m.from, to: m.to })) };
}

export async function deleteFolder(b: Backend, accountId: number, key: string): Promise<{ deleted: string[] }> {
  const r = await change(b, accountId, (p, folders) => p.deleteFolder?.({ key, folders }), (x) => ({ deleted: x.deleted }));
  return { deleted: r.deleted };
}

/** Plan 107: what a delete takes with it, from this computer's copy: the folder and those under it, and their messages. */
export async function countFolder(b: Backend, accountId: number, key: string): Promise<{ messages: number; folders: number }> {
  const folders = await accountFolders(b, accountId);
  const target = folders.find((f) => f.key === key);
  if (!target) throw new RpcError("NOT_FOUND", L("errors.folder.notFound"));
  const own = folders.filter((f) => under(f.path, target.path)).map((f) => f.key);
  // and where a rename here left their mail until a pass reads it (counted once: a message counts where it's first placed)
  const { aliases, except } = await renameAliases(b, accountId, own);
  const keys: FolderPlace[] = [...own.map((key) => (except.has(key) ? { mailbox: key, except: except.get(key)! } : key)), ...aliases];
  // a slice at a time, sized by time, with a turn between (Codex code review round 4 #3: one call could be seconds)
  const sizer = new SliceSizer(COUNT_SLICE);
  let messages = 0;
  for (let after: FolderCountCursor | null = null; ; ) {
    const started = performance.now();
    const r = await b.store.folders.count(accountId, keys, after, sizer.size);
    sizer.record(sizer.size, performance.now() - started);
    messages += r.messages;
    if (!r.next) break;
    after = r.next;
    await b.yieldTurn();
  }
  return { messages, folders: own.length };
}

/** Plan 107: a folder (or standard row) below Starred, or not: the account must exist, an own folder must be listed. */
export function favoriteFolder(b: Backend, target: FavoriteFolder, on: boolean): Promise<FavoriteFoldersSnapshot> {
  // checked and written alone among the account's folder-list writes: a rename or delete between them had its key
  // written back (Codex code review round 10 #4)
  return b.withFolderList(target.accountId, () => favoriteAlone(b, target, on));
}

async function favoriteAlone(b: Backend, target: FavoriteFolder, on: boolean): Promise<FavoriteFoldersSnapshot> {
  if (!(await b.store.accounts.get(target.accountId))) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  const keys = new Set((await accountFolders(b, target.accountId)).map((f) => f.key));
  if (on && target.folder !== null && !keys.has(target.folder)) throw new RpcError("BAD_REQUEST", L("errors.folder.favoriteUnknown"));
  // only this account's are judged: its list is the one held still; another account's may be changing meanwhile
  // (Codex code review round 11 #1: a snapshot of every account's pruned a favorite another's rename had just moved)
  const live = (f: FavoriteFolder) => f.accountId !== target.accountId || f.folder === null || keys.has(f.folder);
  try {
    // setFavoriteFolder always answers the list: a snapshot
    return (await b.writeFavorites(() => setFavoriteFolder(b.store, target, on, live)))!;
  } catch (error) {
    if (error instanceof SettingsError) throw new RpcError("BAD_REQUEST", error.message, undefined, { i18n: error.i18n });
    throw error;
  }
}
