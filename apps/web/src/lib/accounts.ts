import type { Account, AccountPatch } from "@terno/core";
import { client } from "~/rpc/connection";
import { getApp, setAccounts } from "~/state/app";

/** What the sidebar and Settings edit in place (plan 102); Gmail tabs regroup lists and go through `setSeparateTabs`. */
export type AccountEdit = Omit<AccountPatch, "separateTabs">;
type Field = keyof AccountEdit;

/**
 * Per account with edits on their way: the backend's account as last heard (an answer or an `accounts` event),
 * the edits not answered yet, and per field the newest edit the backend accepted. What shows is the account with
 * each field's edits on their way laid over it, unless a newer edit of that field was already accepted (Codex
 * code review #1, #3; round 2 #2). A failure drops its edit: the backend's value shows, or a later edit, never an
 * earlier unsaved one; an answer for one field never takes back another field's edit still on its way.
 */
const pending = new Map<number, { base: Account; edits: { gen: number; patch: AccountEdit; shown: boolean }[]; accepted: Partial<Record<Field, number>> }>();
const gen = { n: 0 };

function shown(id: number): Account | null {
  const p = pending.get(id);
  if (!p) return null;
  const over: Partial<Account> = {};
  for (const e of p.edits) {
    if (!e.shown) continue;
    for (const f of Object.keys(e.patch) as Field[]) if (e.gen > (p.accepted[f] ?? 0)) (over as Record<string, unknown>)[f] = e.patch[f];
  }
  return { ...p.base, ...over };
}

function render(id: number): void {
  const accounts = getApp().accounts;
  if (!accounts.some((a) => a.id === id)) return;
  const next = shown(id);
  if (next) setAccounts(accounts.map((a) => (a.id === id ? next : a)));
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
 * Saves an edit of an account: shown at once, then the backend's account. A failure drops it and rejects, so the
 * caller can say why. `optimistic: false` (Settings' text fields, which keep the typed text themselves and say
 * a failure under it, Codex code review round 2 #1): the account changes only once the backend has it.
 */
export async function patchAccount(id: number, patch: AccountEdit, options: { optimistic?: boolean } = {}): Promise<void> {
  const current = getApp().accounts.find((a) => a.id === id);
  if (!current) return;
  const mine = ++gen.n;
  const p = pending.get(id) ?? { base: current, edits: [], accepted: {} };
  p.edits.push({ gen: mine, patch, shown: options.optimistic !== false });
  pending.set(id, p);
  render(id);
  const drop = () => (p.edits = p.edits.filter((e) => e.gen !== mine));
  try {
    const next = await client.call("accounts.update", { id, ...patch });
    drop();
    // a field a newer accepted edit set keeps that value (an older answer arriving late doesn't take it back)
    const base: Account = { ...next };
    for (const f of Object.keys(p.accepted) as Field[]) if (p.accepted[f]! > mine) (base as unknown as Record<string, unknown>)[f] = p.base[f];
    p.base = base;
    for (const f of Object.keys(patch) as Field[]) p.accepted[f] = Math.max(p.accepted[f] ?? 0, mine);
    render(id);
  } catch (error) {
    drop();
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
