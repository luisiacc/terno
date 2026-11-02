import type { Account } from "@terno/core";

const localPart = (email: string) => email.split("@")[0]!.toLowerCase();

/**
 * A new account's sidebar name: the one it would get (Gmail's "luis", the
 * name typed for IMAP), unless another account already goes by it. Then every
 * mailbox in the clash shows its full address, so luis@a.com and luis@b.com
 * never read alike, and a later luis@c.com joins them as an address too.
 */
export function accountLabel(name: string, email: string, accounts: readonly Pick<Account, "id" | "email" | "displayName">[]): { displayName: string; renames: { id: number; displayName: string }[] } {
  const wanted = name.trim().toLowerCase();
  const local = localPart(email);
  const same = accounts.filter((a) => a.displayName.trim().toLowerCase() === wanted);
  // one already showing a luis@… address from an earlier clash
  const earlier = wanted === local && accounts.some((a) => a.displayName.toLowerCase() === a.email.toLowerCase() && localPart(a.email) === local);
  if (!same.length && !earlier) return { displayName: name, renames: [] };
  return {
    displayName: email,
    renames: same.filter((a) => a.email.toLowerCase() !== email.toLowerCase()).map((a) => ({ id: a.id, displayName: a.email })),
  };
}
