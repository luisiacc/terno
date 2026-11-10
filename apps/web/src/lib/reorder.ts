import type { Account, Category } from "@terno/core";
import { t } from "@terno/i18n";
import { client } from "~/rpc/connection";
import { getApp, setAccounts, setCategories } from "~/state/app";
import { snack } from "./snack";

type Key = "categories" | "accounts";

/**
 * Per list: the newest request (an older one's answer never puts its order back), the order on its way (an event
 * arriving meanwhile, another request's broadcast or an account's sync state, keeps it), and the last order the
 * backend said it holds (where a failure goes back to).
 */
const sorts: Record<Key, { n: number; pending: readonly number[] | null; saved: readonly number[] | null }> = {
  categories: { n: 0, pending: null, saved: null },
  accounts: { n: 0, pending: null, saved: null },
};

/** `list` in the order of `ids`; any not in it (new since) after them, as they were. */
function orderBy<T extends { id: number }>(list: readonly T[], ids: readonly number[]): T[] {
  const at = new Map(ids.map((id, i) => [id, i]));
  const known = list.filter((x) => at.has(x.id)).sort((a, b) => at.get(a.id)! - at.get(b.id)!);
  return [...known, ...list.filter((x) => !at.has(x.id))];
}

const ids = (list: readonly { id: number }[]) => list.map((x) => x.id);

function show(key: Key, order: readonly number[]): void {
  if (key === "categories") setCategories(orderBy(getApp().categories, order));
  else setAccounts(orderBy(getApp().accounts, order));
}

/** The backend's list (an event): its order is what it holds; while one of ours is on its way, that one is shown. */
export function withPendingOrder<T extends { id: number }>(key: Key, list: T[]): T[] {
  const s = sorts[key];
  s.saved = ids(list);
  return s.pending ? orderBy(list, s.pending) : list;
}

/**
 * Plan 169: the sidebar's order, saved. It shows at once; the backend's answer orders the list as it is then (its
 * entities stay the ones shown: an account's edit on its way stays); a failure puts back the last order the backend
 * holds and says so.
 */
async function reorder(key: Key, order: readonly number[], call: () => Promise<readonly { id: number }[]>): Promise<void> {
  const current = ids(getApp()[key] as readonly (Category | Account)[]);
  if (order.length !== current.length || order.every((id, i) => id === current[i]) || !order.every((id) => current.includes(id))) return;
  const s = sorts[key];
  const n = ++s.n;
  if (!s.pending) s.saved = current;
  s.pending = order;
  show(key, order);
  try {
    const answer = ids(await call());
    if (n !== s.n) return;
    s.pending = null;
    s.saved = answer;
    show(key, answer);
  } catch {
    if (n !== s.n) return;
    s.pending = null;
    if (s.saved) show(key, s.saved);
    snack.error(t("sidebar.reorder.failed"));
  }
}

export function reorderCategories(order: readonly number[]): Promise<void> {
  return reorder("categories", order, () => client.call("categories.reorder", { ids: [...order] }));
}

export function reorderAccounts(order: readonly number[]): Promise<void> {
  return reorder("accounts", order, () => client.call("accounts.reorder", { ids: [...order] }));
}
