import type { Account, Folder, View } from "@terno/core";
import { create } from "zustand";
import { getApp, navigate } from "~/state/app";

/**
 * Plan 64: what's at the top of the sidebar is all your mail; what's under an account is that account's.
 * The folders an account lists under it. Starred and All Mail are cross-account: at the top only.
 */
export const ACCOUNT_VIEWS = ["inbox", "sent", "archive", "spam", "trash"] as const satisfies readonly View[];
export const listedByAccount = (v: View) => (ACCOUNT_VIEWS as readonly View[]).includes(v);

// ── the open account: one at a time, remembered on this device (like More)

const KEY = "terno:sidebar-account";
function read(): number | null {
  try {
    const id = Number(localStorage.getItem(KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
export const useOpenAccount = create<{ id: number | null }>(() => ({ id: read() }));
export function setOpenAccount(id: number | null): void {
  useOpenAccount.setState({ id });
  try {
    if (id === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(id));
  } catch {
    // private mode: remembered for this session only
  }
}

/** You're somewhere in this account's folders (a category tab filters its Inbox, so it counts as inside). */
function inside(id: number): boolean {
  const s = getApp();
  return s.accountId === id && s.reviewCategoryId === null && (s.folder !== null || s.categoryId !== null || listedByAccount(s.view));
}

/** "Go to this account" (the palette): it opens (any other closes), and you land in its Inbox. */
export function goToAccount(id: number): void {
  setOpenAccount(id);
  navigate({ accountId: id, view: "inbox" });
}

/** An account's row: a closed one opens and lands in its Inbox, unless you're already inside it; an open one closes, and you stay. */
export function toggleAccount(id: number): void {
  if (useOpenAccount.getState().id === id) return setOpenAccount(null);
  setOpenAccount(id);
  if (!inside(id)) navigate({ accountId: id, view: "inbox" });
}

/** A folder by shortcut or palette: in the scope you're in when the account lists it, otherwise for all accounts. */
export function goToFolder(view: View): void {
  navigate(listedByAccount(view) ? { view } : { view, accountId: null });
}

/** The account list changed: an account that's gone stops being open, and stops being where you are. */
export function reconcileAccounts(accounts: readonly Account[]): void {
  const has = (id: number | null) => id !== null && accounts.some((a) => a.id === id);
  const open = useOpenAccount.getState().id;
  if (open !== null && !has(open)) setOpenAccount(null);
  const { accountId } = getApp();
  if (accountId !== null && !has(accountId)) navigate({ view: "inbox", accountId: null });
}

// ── plan 65: the account's own folders

/** The folder you're in, by name (its last path step); null outside one. */
export function folderName(s: { folders: readonly Folder[]; accountId: number | null; folder: string | null }): string | null {
  if (s.folder === null) return null;
  return s.folders.find((f) => f.accountId === s.accountId && f.key === s.folder)?.path.at(-1) ?? null;
}

export interface FolderRow {
  /** null: a parent only drawn to group the folders under it (Gmail's "A/B" with no "A") */
  key: string | null;
  name: string;
  depth: number;
  /** a place to go (an IMAP \\Noselect parent or a drawn one isn't) */
  selectable: boolean;
}

/**
 * An account's folders as sidebar rows: a tree by path, each level in name order, so a folder always sits under
 * its own parent whatever order they were listed in (Codex R1: "A", "AA", "A/Z"). A parent that isn't listed is
 * drawn once (not a place to go).
 */
export function folderRows(folders: readonly Folder[], accountId: number): FolderRow[] {
  interface Node {
    name: string;
    own?: Folder;
    children: Map<string, Node>;
  }
  const root: Node = { name: "", children: new Map() };
  for (const f of folders) {
    if (f.accountId !== accountId || f.path.length === 0) continue;
    let node = root;
    for (const name of f.path) {
      let next = node.children.get(name);
      if (!next) node.children.set(name, (next = { name, children: new Map() }));
      node = next;
    }
    node.own = f;
  }
  const rows: FolderRow[] = [];
  const walk = (node: Node, depth: number) => {
    for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ key: child.own?.key ?? null, name: child.name, depth, selectable: child.own?.selectable ?? false });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}
