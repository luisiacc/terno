import type { FavoriteFolder, Folder, FolderRename } from "@terno/core";
import { RpcError } from "@terno/core/rpc";
import { L } from "@terno/i18n";
import { ProviderError, type FolderChange, type MailProvider } from "@terno/mail/portable";
import type { FolderCountCursor, ProviderFolder } from "@terno/store";
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
 * a sync pass's, for a rename whose answer was lost (Codex code review round 5 #1).
 */
export async function carryRenamed(b: Backend, accountId: number, renamed: readonly { from: string; to: string }[], write: <W>(work: () => Promise<W>) => Promise<W>): Promise<void> {
  // an IMAP rename's new key keeps the folder's threads until the next pass proves where its mail went (Codex
  // code review round 2 #5: else the folder you're in shows empty meanwhile), a slice at a time
  for (const m of renamed) {
    if (m.from === m.to) continue;
    for (let after: number | null = 0; after !== null; ) {
      const from: number = after;
      after = (await write(() => b.store.folders.carry(accountId, m.from, m.to, from, CARRY_SLICE))).next;
      await b.yieldTurn();
    }
  }
  if (renamed.length) b.server.emit("foldersRenamed", renamed.map((m): FolderRename => ({ accountId, from: m.from, to: m.to })));
}

async function change<R extends FolderChange>(
  b: Backend,
  accountId: number,
  run: (provider: MailProvider, folders: ProviderFolder[]) => Promise<R> | undefined,
  follows: (r: R) => { renamed?: readonly { from: string; to: string }[]; deleted?: readonly string[] } = () => ({}),
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
    const stored = await account.write(() => b.store.folders.replace(accountId, result.folders));
    const { renamed = [], deleted = [] } = follows(result);
    await carryRenamed(b, accountId, renamed, account.write);
    if (stored.changed || renamed.length) b.server.emit("folders", await b.store.folders.list());
    b.notifyChanged(stored.touched);
    void b.rebuildFolders();
    if (renamed.length || deleted.length) await followFavoriteFolders(b.store, accountId, { renamed, deleted });
    resync();
    if (result.partial) throw folderError(b, result.partial);
    return result;
  });
}

export async function createFolder(b: Backend, accountId: number, parent: string | null, name: string): Promise<Folder> {
  const r = await change(b, accountId, (p, folders) => p.createFolder?.({ parent, name, folders }));
  const made = r.folders.find((f) => f.key === r.key);
  return { accountId, ...(made ?? { key: r.key, path: [name], selectable: true }) };
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
  const keys = folders.filter((f) => under(f.path, target.path)).map((f) => f.key);
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
  return { messages, folders: keys.length };
}

/** Plan 107: a folder (or standard row) below Starred, or not: the account must exist, an own folder must be listed. */
export async function favoriteFolder(b: Backend, target: FavoriteFolder, on: boolean): Promise<FavoriteFolder[]> {
  if (!(await b.store.accounts.get(target.accountId))) throw new RpcError("NOT_FOUND", L("errors.accountGone"));
  if (on && target.folder !== null && !(await accountFolders(b, target.accountId)).some((f) => f.key === target.folder)) throw new RpcError("BAD_REQUEST", L("errors.folder.favoriteUnknown"));
  const [accounts, folders] = await Promise.all([b.store.accounts.list(), b.store.folders.list()]);
  const ids = new Set(accounts.map((a) => a.id));
  const keys = new Set(folders.map((f) => `${f.accountId}\n${f.key}`));
  const live = (f: FavoriteFolder) => ids.has(f.accountId) && (f.folder === null || keys.has(`${f.accountId}\n${f.folder}`));
  try {
    return await setFavoriteFolder(b.store, target, on, live);
  } catch (error) {
    if (error instanceof SettingsError) throw new RpcError("BAD_REQUEST", error.message, undefined, { i18n: error.i18n });
    throw error;
  }
}
