import type { Account, View } from "@terno/core";
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
  return s.accountId === id && s.reviewCategoryId === null && (s.categoryId !== null || listedByAccount(s.view));
}

/** "Go to this account" (the palette): it opens (any other closes), and you land in its Inbox unless you're already inside it. */
export function goToAccount(id: number): void {
  setOpenAccount(id);
  if (!inside(id)) navigate({ accountId: id, view: "inbox" });
}

/** An account's row: a closed one is "go to this account"; an open one closes, and you stay where you are. */
export function toggleAccount(id: number): void {
  if (useOpenAccount.getState().id === id) setOpenAccount(null);
  else goToAccount(id);
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
