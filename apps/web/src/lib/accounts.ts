import type { Account, AccountPatch } from "@terno/core";
import { client } from "~/rpc/connection";
import { getApp, setAccounts } from "~/state/app";

/** What the sidebar and Settings edit in place (plan 102); Gmail tabs regroup lists and go through `setSeparateTabs`. */
export type AccountEdit = Omit<AccountPatch, "separateTabs">;

/**
 * Per account with edits on their way: the backend's account as last heard (an answer or an `accounts` event)
 * and the edits not answered yet, oldest first. What shows is always the first with the second laid over it
 * (Codex code review #1, #3): a failure drops its edit and shows the backend's value or a later edit, never an
 * earlier unsaved one; an answer for one field never takes back another field's edit still on its way. Answers
 * come in the order the backend handled them (one connection), so the latest one heard is the backend's state.
 */
const pending = new Map<number, { base: Account; edits: { gen: number; patch: AccountEdit }[] }>();
const gen = { n: 0 };

function shown(id: number): Account | null {
  const p = pending.get(id);
  if (!p) return null;
  return p.edits.reduce<Account>((a, e) => ({ ...a, ...e.patch }), p.base);
}

function render(id: number): void {
  const accounts = getApp().accounts;
  if (!accounts.some((a) => a.id === id)) return;
  const next = shown(id);
  if (next) setAccounts(accounts.map((a) => (a.id === id ? next : a)));
}

function settle(id: number, mine: number): void {
  const p = pending.get(id);
  if (!p) return;
  p.edits = p.edits.filter((e) => e.gen !== mine);
}

/** The backend's accounts with the edits still on their way laid over them (an event mustn't put an old name back). */
export function withPendingEdits(accounts: Account[]): Account[] {
  if (pending.size === 0) return accounts;
  return accounts.map((a) => {
    const p = pending.get(a.id);
    if (!p) return a;
    p.base = a;
    return shown(a.id)!;
  });
}

/**
 * Saves an edit of an account: shown at once, then the backend's account. A failure drops it (what shows is the
 * backend's value, or a newer edit on its way) and rejects, so the caller can say why.
 */
export async function patchAccount(id: number, patch: AccountEdit): Promise<void> {
  const current = getApp().accounts.find((a) => a.id === id);
  if (!current) return;
  const mine = ++gen.n;
  const p = pending.get(id) ?? { base: current, edits: [] };
  p.edits.push({ gen: mine, patch });
  pending.set(id, p);
  render(id);
  try {
    const next = await client.call("accounts.update", { id, ...patch });
    settle(id, mine);
    p.base = next;
    render(id);
  } catch (error) {
    settle(id, mine);
    render(id);
    throw error;
  } finally {
    if (p.edits.length === 0 && pending.get(id) === p) pending.delete(id);
  }
}

/** Tests: forget every edit in flight. */
export function resetAccountEdits(): void {
  pending.clear();
}
