import type { Address } from "@terno/core";
import { client } from "~/rpc/connection";

/**
 * The renderer's side of autocomplete (plan 18): warming the backend's models
 * on real intent (a draft opened, a recipient field focused) and the calls a
 * keystroke makes. Failures are silent: a suggestion that doesn't come is
 * just no suggestion.
 */
let warmed = false;

/** Once per session: the backend restores (or builds) its models. */
export function warmAutocomplete(): void {
  if (warmed) return;
  warmed = true;
  void client.call("compose.warm", {}).catch(() => {
    warmed = false;
  });
}

export async function suggestRecipients(p: { query: string; exclude: string[]; accountId?: number }): Promise<{ items: Address[]; ready: boolean }> {
  try {
    return await client.call("compose.suggestRecipients", { ...p, exclude: p.exclude.slice(0, 600), limit: 6 });
  } catch {
    return { items: [], ready: true };
  }
}

/** The best few people per first letter, per account, fetched when a recipient field gets focus (at most every 30 s). */
const initialsCache = new Map<number, { at: number; byInitial: Record<string, Address[]> }>();

export function recipientInitials(accountId: number): Record<string, Address[]> | null {
  return initialsCache.get(accountId)?.byInitial ?? null;
}

export function prefetchRecipientInitials(accountId: number): void {
  const cached = initialsCache.get(accountId);
  if (cached && performance.now() - cached.at < 30_000) return;
  initialsCache.set(accountId, { at: performance.now(), byInitial: cached?.byInitial ?? {} });
  void client.call("compose.recipientInitials", { accountId }).then(
    (byInitial) => initialsCache.set(accountId, { at: performance.now(), byInitial }),
    () => initialsCache.delete(accountId),
  );
}

export async function suggestText(p: { before: string; names: string[]; me?: string }): Promise<string | null> {
  try {
    return (await client.call("compose.suggestText", p)).text;
  } catch {
    return null;
  }
}
