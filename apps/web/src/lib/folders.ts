import { FOLDER_NAME_MAX, type Account, type FavoriteFolder, type Folder, type FolderRename, type FolderView } from "@terno/core";
import { t } from "@terno/i18n";
import { create } from "zustand";
import { client } from "~/rpc/connection";
import { getApp, setApp } from "~/state/app";
import { followedRename, listKey } from "~/state/list";
import { relistPage } from "./page";
import { mailboxKey, saveListFilters } from "./unread-filter";
import { setOpenAccount } from "./account-folders";

/**
 * Plan 107: the folder being named in the sidebar, at most one: a new one (under `parent`, null: the account's top)
 * or a rename of `key`. `done`: the folder a create or rename just made, kept mounted and given the focus.
 */
export type FolderEdit = ({ kind: "create"; accountId: number; parent: string | null } | { kind: "rename"; accountId: number; key: string }) & { id: number };
export const useFolderEdit = create<{ editing: FolderEdit | null; done: { accountId: number; key: string } | null }>(() => ({ editing: null, done: null }));

/**
 * What an edit's field holds, by edit: its row can unmount (its account closed, the batch moved) while the server
 * answers; it comes back with the text, what went wrong, and whether the server is still answering (round 3 #4:
 * a row back while it is can't send it again). Gone with the edit.
 */
export type FieldDraft = { text: string; error: string | null; pending: boolean };
export const useFieldDrafts = create<Record<number, FieldDraft>>(() => ({}));
export function setFieldDraft(id: number, patch: Partial<FieldDraft>): void {
  useFieldDrafts.setState((s) => ({ [id]: { text: "", error: null, pending: false, ...s[id], ...patch } }));
}

const edits = { n: 0 };
export function startCreate(accountId: number, parent: string | null): void {
  // the account opens to show where it goes (its children always show)
  setOpenAccount(accountId);
  useFolderEdit.setState({ editing: { kind: "create", accountId, parent, id: ++edits.n }, done: null });
}
export function startRename(accountId: number, key: string): void {
  // from a favorite, its account may be closed: it opens so the field is there (Codex code review #4)
  setOpenAccount(accountId);
  useFolderEdit.setState({ editing: { kind: "rename", accountId, key, id: ++edits.n }, done: null });
}
/**
 * Ends edit `id` (its answer came, or it was cancelled): only that one, so a slow answer never closes a newer field
 * with its text (Codex code review #3). `done`: the folder it made, focused once listed.
 */
export function stopEditing(id: number, done?: { accountId: number; key: string }): void {
  useFieldDrafts.setState((s) => {
    if (!(id in s)) return s;
    const { [id]: _gone, ...rest } = s;
    return rest;
  }, true);
  if (useFolderEdit.getState().editing?.id !== id) return;
  useFolderEdit.setState({ editing: null, done: done ?? null });
}

/** The folders a new name sits beside: the parent's children (the account's top ones for null). */
export function siblingsOf(folders: readonly Folder[], accountId: number, parent: string | null, except?: string): Folder[] {
  const base = parent === null ? [] : (folders.find((f) => f.accountId === accountId && f.key === parent)?.path ?? null);
  return base === null ? [] : siblingsAt(folders, accountId, base, except);
}

/** The folders under a path (Codex code review round 2 #10: a renamed folder's parent may only group, with no key). */
export function siblingsAt(folders: readonly Folder[], accountId: number, base: readonly string[], except?: string): Folder[] {
  return folders.filter((f) => f.accountId === accountId && f.key !== except && f.path.length === base.length + 1 && base.every((p, i) => f.path[i] === p));
}

/**
 * What the field can tell before asking the server (plan 107, Codex R12): empty, too long, Gmail's "/" and a
 * sibling already shown with that name (case aside). The server checks the rest (an IMAP delimiter, its own names).
 */
export function nameProblem(name: string, siblings: readonly Folder[], account: Pick<Account, "kind">): string | null {
  const n = name.trim();
  if (!n) return t("folder.nameEmpty");
  if (n.length > FOLDER_NAME_MAX) return t("folder.nameTooLong", { max: FOLDER_NAME_MAX });
  if (account.kind === "gmail" && n.includes("/")) return t("folder.nameSeparator", { separator: "/" });
  const lower = n.toLocaleLowerCase();
  if (siblings.some((f) => f.path.at(-1)!.toLocaleLowerCase() === lower)) return t("folder.nameTaken", { name: n });
  return null;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Creates it on the server; the new folder, or what went wrong in words. */
export async function createFolder(accountId: number, parent: string | null, name: string): Promise<{ folder: Folder } | { error: string }> {
  try {
    return { folder: await client.call("folders.create", { accountId, parent, name: name.trim() }) };
  } catch (e) {
    return { error: errorText(e) };
  }
}

/** Renames it on the server; where it went (an IMAP folder gets a new key), or what went wrong. */
export async function renameFolder(accountId: number, key: string, name: string): Promise<{ key: string } | { error: string }> {
  try {
    const { renamed } = await client.call("folders.rename", { accountId, key, name: name.trim() });
    return { key: renamed.find((r) => r.accountId === accountId && r.from === key)?.to ?? key };
  } catch (e) {
    return { error: errorText(e) };
  }
}

// ── favorites (below Starred)

export type FolderTarget = { accountId: number; folder: string; view: null } | { accountId: number; folder: null; view: FolderView };
export const sameTarget = (a: Pick<FavoriteFolder, "accountId" | "folder" | "view">, b: Pick<FavoriteFolder, "accountId" | "folder" | "view">) =>
  a.accountId === b.accountId && a.folder === b.folder && a.view === b.view;

export function isFavorite(favorites: readonly FavoriteFolder[] | undefined, target: FolderTarget): boolean {
  return (favorites ?? []).some((f) => sameTarget(f, target));
}

/** Adds it below Starred, or takes it away; the list the backend kept. */
export async function setFavorite(target: FolderTarget, on: boolean): Promise<void> {
  const favoriteFolders = await client.call("folders.favorite", { ...target, on });
  setApp((s) => (s.settings ? { settings: { ...s.settings, favoriteFolders } } : {}));
}

// ── renames from the backend (sent right before the folders they produced)

/**
 * A folder renamed (an IMAP one gets a new key): the list you're in follows it before the new catalog arrives, so
 * the missing-folder check never sends you to the Inbox (Codex R7).
 */
export function applyFolderRenames(renamed: readonly FolderRename[]): void {
  const s = getApp();
  const here = renamed.find((r) => r.accountId === s.accountId && r.from === s.folder && r.from !== r.to);
  if (here) {
    // the same mailbox under a new key: not a navigation (Codex code review #7), its quick filter moves with it
    const before = mailboxKey(s);
    const after = mailboxKey({ ...s, folder: here.to });
    const filter = s.listFilters.get(before);
    const listFilters = filter === undefined ? s.listFilters : new Map([...s.listFilters].filter(([k]) => k !== before).concat([[after, filter]]));
    followedRename.from = here.from;
    followedRename.to = here.to;
    if (listFilters !== s.listFilters) saveListFilters(listFilters);
    const fromList = listKey();
    setApp({ folder: here.to, listFilters });
    followedRename.from = followedRename.to = null;
    // List layout: the open conversation's history entry is over this list, under its new key (round 2 #4)
    relistPage(fromList, listKey());
  }
  const { editing, done } = useFolderEdit.getState();
  const moved = (accountId: number, key: string) => renamed.find((r) => r.accountId === accountId && r.from === key)?.to ?? key;
  // the backend rewrote its favorites the same way; this window's copy follows (no settings event comes)
  const favorites = s.settings?.favoriteFolders;
  if (favorites?.some((f) => f.folder !== null && moved(f.accountId, f.folder) !== f.folder)) {
    setApp((st) => (st.settings ? { settings: { ...st.settings, favoriteFolders: favorites.map((f) => (f.folder === null ? f : { ...f, folder: moved(f.accountId, f.folder) })) } } : {}));
  }
  if (editing?.kind === "rename") useFolderEdit.setState({ editing: { ...editing, key: moved(editing.accountId, editing.key) } });
  if (editing?.kind === "create" && editing.parent !== null) useFolderEdit.setState({ editing: { ...editing, parent: moved(editing.accountId, editing.parent) } });
  if (done) useFolderEdit.setState({ done: { ...done, key: moved(done.accountId, done.key) } });
}

/** A delete's folders leave this window's favorites too (Codex code review round 2 #11: no settings event comes). */
export function dropFavorites(accountId: number, keys: readonly string[]): void {
  const gone = new Set(keys);
  setApp((s) => (s.settings ? { settings: { ...s.settings, favoriteFolders: s.settings.favoriteFolders.filter((f) => f.accountId !== accountId || f.folder === null || !gone.has(f.folder)) } } : {}));
}
