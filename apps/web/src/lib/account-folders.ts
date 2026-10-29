import type { Account, Folder, View } from "@terno/core";
import { useLayoutEffect, useState } from "react";
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

/** levels of an account's own folders drawn in the sidebar */
const DEPTH = 8;

export interface FolderRow {
  /** the row's identity: its full path from the top (and its key): unique, stable as the list changes */
  id: string;
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
  const steps = folderRowSteps(folders, accountId);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * folderRows a step at a time (Codex R14: 10,000 folders a hundred levels deep took a renderer 60 ms at once):
 * each yield a pause where the caller may give the frame back, a few hundred folders or a thousand rows apart.
 */
export function* folderRowSteps(folders: readonly Folder[], accountId: number): Generator<void, FolderRow[], void> {
  // a node's children only once it has some, and sorted only when there are two (Codex R14: a frame for 10,000
  // folders a hundred levels deep, most nodes a single child or none)
  interface Node {
    name: string;
    own?: Folder;
    children?: Map<string, Node>;
  }
  const root: Node = { name: "" };
  const byName = new Intl.Collator().compare;
  let placed = 0;
  for (const f of folders) {
    if (f.accountId !== accountId || f.path.length === 0) continue;
    if (++placed % 256 === 0) yield;
    let node = root;
    // at most DEPTH levels drawn: deeper names join the last one (Codex R11: 10,000 paths of 100 levels drew a million rows)
    const path = f.path.length > DEPTH ? [...f.path.slice(0, DEPTH - 1), f.path.slice(DEPTH - 1).join("/")] : f.path;
    path.forEach((name, i) => {
      // a folder whose shortened name is another folder's (providers cap names at 225 characters) is its own row,
      // never written over the other (Codex R4)
      const leaf = i === path.length - 1;
      let id = name;
      const children = (node.children ??= new Map());
      while (leaf && children.get(id)?.own && children.get(id)!.own!.key !== f.key) id = `${id}\u0000${f.key}`;
      let next = children.get(id);
      if (!next) children.set(id, (next = { name }));
      node = next;
    });
    node.own = f;
  }
  const rows: FolderRow[] = [];
  // depth first, each level in name order: a stack of the levels still being walked
  const stack: { entries: [string, Node][]; next: number; depth: number; at: string }[] = [];
  const enter = (node: Node, depth: number, at: string) => {
    if (!node.children) return;
    const entries = [...node.children.entries()];
    if (entries.length > 1) entries.sort(([, a], [, b]) => byName(a.name, b.name));
    stack.push({ entries, next: 0, depth, at });
  };
  enter(root, 0, "");
  while (stack.length) {
    const level = stack.at(-1)!;
    if (level.next === level.entries.length) {
      stack.pop();
      continue;
    }
    const [childId, child] = level.entries[level.next++]!;
    const id = `${level.at}\u0000${childId}`;
    rows.push({ id, key: child.own?.key ?? null, name: child.name, depth: level.depth, selectable: child.own?.selectable ?? false });
    enter(child, level.depth + 1, id);
    if (rows.length % 1024 === 0) yield;
  }
  return rows;
}

const NO_ROWS: readonly FolderRow[] = [];
/** a step of building an account's folder rows: a frame's share, the rest in the tasks after */
const ROWS_STEP_MS = 4;

/**
 * An account's folder rows, built only while it's open (Codex R11, R14: a closed one costs nothing, even as its
 * folders change; one closing keeps what it drew). The first step runs before the paint, so a catalog of any usual
 * size is there at once; a huge one goes on a few milliseconds a task, the rows it had shown until then.
 */
export function useFolderRows(folders: readonly Folder[], accountId: number, open: boolean): readonly FolderRow[] {
  const [built, setBuilt] = useState<{ folders: readonly Folder[]; rows: readonly FolderRow[] } | null>(null);
  useLayoutEffect(() => {
    if (!open || built?.folders === folders) return;
    const steps = folderRowSteps(folders, accountId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      const until = performance.now() + ROWS_STEP_MS;
      for (let r = steps.next(); ; r = steps.next()) {
        if (r.done) return setBuilt({ folders, rows: r.value });
        if (performance.now() >= until) {
          timer = setTimeout(step, 0);
          return;
        }
      }
    };
    step();
    return () => clearTimeout(timer);
  }, [open, folders, accountId, built]);
  return built?.rows ?? NO_ROWS;
}
