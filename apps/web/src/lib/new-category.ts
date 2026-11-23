/**
 * The sidebar's "+": a category from its name (the backend picks its color, plan 237), then its list.
 */
import { client } from "~/rpc/connection";
import { offerTip } from "~/lib/tips";
import { snack } from "~/lib/snack";
import { navigate } from "~/state/app";

/**
 * False when nothing was created (empty, or refused: the reason is in the
 * snack). Its list opens for every account: categories are cross-account (plan 67).
 */
export async function createCategory(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    const c = await client.call("categories.create", { name: trimmed });
    if (!c.showInInbox) offerTip("category-inbox", c.id);
    navigate({ categoryId: c.id, accountId: null });
    return true;
  } catch (e) {
    snack.error(String(e));
    return false;
  }
}
