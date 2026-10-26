import type { Account, CategoryColor } from "@terno/core";

/** What a row says about the account its mail came to (plan 23): a name, or an address split so the domain survives truncation. */
export interface AccountLabel {
  /** the display name, or the whole address */
  text: string;
  /** set when the label is an address: the part that truncates, and the `@domain` that stays */
  local?: string;
  domain?: string;
  email: string;
  color: CategoryColor;
}

let last: { accounts: readonly Account[]; labels: Map<number, AccountLabel> } | null = null;

const same = (a: AccountLabel, b: AccountLabel) => a.text === b.text && a.email === b.email && a.color === b.color && a.local === b.local && a.domain === b.domain;

/**
 * Every account's label, derived once per accounts array (rows select theirs by id). A label that
 * didn't change keeps its object, so the frequent `accounts` events (sync state) re-render no row.
 * The display name, unless it's empty, the address itself or shared with another account: then the address.
 */
export function accountLabels(accounts: readonly Account[]): Map<number, AccountLabel> {
  if (last?.accounts === accounts) return last.labels;
  const names = new Map<string, number>();
  for (const a of accounts) {
    const n = a.displayName.trim().toLowerCase();
    if (n) names.set(n, (names.get(n) ?? 0) + 1);
  }
  const labels = new Map<number, AccountLabel>();
  for (const a of accounts) {
    const name = a.displayName.trim();
    const unique = name !== "" && names.get(name.toLowerCase()) === 1 && name.toLowerCase() !== a.email.toLowerCase();
    const at = a.email.lastIndexOf("@");
    const next: AccountLabel = unique || at <= 0 ? { text: unique ? name : a.email, email: a.email, color: a.color as CategoryColor } : { text: a.email, local: a.email.slice(0, at), domain: a.email.slice(at), email: a.email, color: a.color as CategoryColor };
    const prev = last?.labels.get(a.id);
    labels.set(a.id, prev && same(prev, next) ? prev : next);
  }
  last = { accounts, labels };
  return labels;
}
