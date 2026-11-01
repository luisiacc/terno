import type { Account, AccountPatch } from "@terno/core";
import { client } from "~/rpc/connection";
import { getApp, setAccounts } from "~/state/app";

/** What the sidebar and Settings edit in place (plan 102); Gmail tabs regroup lists and go through `setSeparateTabs`. */
export type AccountEdit = Omit<AccountPatch, "separateTabs">;
type Field = keyof AccountEdit;
const EDITABLE: Record<Field, true> = { displayName: true, color: true, senderName: true, signature: true, syncWindowDays: true };

/**
 * Per account and field: the latest edit's generation, and the value it wrote while it's in flight. A response
 * or a rollback writes a field only when no newer edit of it started since (plan 102, Codex R7), and an
 * `accounts` event that lands mid-save keeps the edits still on their way.
 */
const latest = new Map<number, Partial<Record<Field, number>>>();
const pending = new Map<number, Partial<Record<Field, { gen: number; value: unknown }>>>();
const gen = { n: 0 };

function write(id: number, fields: Partial<Account>): void {
  const accounts = getApp().accounts;
  if (!accounts.some((a) => a.id === id)) return;
  setAccounts(accounts.map((a) => (a.id === id ? { ...a, ...fields } : a)));
}

/** The backend's accounts with the edits still on their way laid over them (an event mustn't put an old name back). */
export function withPendingEdits(accounts: Account[]): Account[] {
  if (pending.size === 0) return accounts;
  return accounts.map((a) => {
    const edits = pending.get(a.id);
    if (!edits) return a;
    const over = Object.fromEntries(Object.entries(edits).map(([f, e]) => [f, e!.value]));
    return Object.keys(over).some((f) => a[f as Field] !== over[f]) ? { ...a, ...over } : a;
  });
}

/**
 * Saves an edit of an account: shown at once, then the backend's account. A failure puts back what this edit
 * replaced (unless a newer edit of the field has started) and rejects, so the caller can say why.
 */
export async function patchAccount(id: number, patch: AccountEdit): Promise<void> {
  const before = getApp().accounts.find((a) => a.id === id);
  if (!before) return;
  const fields = Object.keys(patch) as Field[];
  const mine: Partial<Record<Field, number>> = {};
  const seen = { ...latest.get(id) };
  const marks = (latest.get(id) ?? {}) as Partial<Record<Field, number>>;
  const waiting = (pending.get(id) ?? {}) as Partial<Record<Field, { gen: number; value: unknown }>>;
  for (const f of fields) {
    mine[f] = marks[f] = ++gen.n;
    waiting[f] = { gen: mine[f]!, value: patch[f] };
  }
  latest.set(id, marks);
  pending.set(id, waiting);
  // a field this edit owns, or one no edit has touched since it started
  const newer = (f: Field) => (latest.get(id)?.[f] ?? 0) > (mine[f] ?? seen[f] ?? 0);
  const settle = () => {
    const w = pending.get(id);
    if (!w) return;
    for (const f of fields) if (w[f]?.gen === mine[f]) delete w[f];
    if (Object.keys(w).length === 0) pending.delete(id);
  };
  write(id, patch);
  try {
    const next = await client.call("accounts.update", { id, ...patch });
    settle();
    const current = getApp().accounts.find((a) => a.id === id);
    if (!current) return;
    const merged: Account = { ...next };
    for (const f of Object.keys(next) as (keyof Account)[]) if (f in EDITABLE && newer(f as Field)) (merged as unknown as Record<string, unknown>)[f] = current[f];
    setAccounts(getApp().accounts.map((a) => (a.id === id ? merged : a)));
  } catch (error) {
    settle();
    const undo: Partial<Account> = {};
    for (const f of fields) if (!newer(f)) (undo as Record<string, unknown>)[f] = before[f];
    write(id, undo);
    throw error;
  }
}

/** Tests: forget every edit in flight. */
export function resetAccountEdits(): void {
  latest.clear();
  pending.clear();
}
