/**
 * The sidebar's "+": a category from its name, in the next color, then its list.
 */
import { CATEGORY_COLORS } from "@terno/core";
import { client } from "~/rpc/connection";
import { offerTip } from "~/lib/tips";
import { snack } from "~/lib/snack";
import { getApp, navigate } from "~/state/app";

/**
 * False when nothing was created (empty, or refused: the reason is in the
 * snack). Its list opens for every account: categories are cross-account (plan 67).
 */
export async function createCategory(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    const color = CATEGORY_COLORS[getApp().categories.length % CATEGORY_COLORS.length]!;
    const c = await client.call("categories.create", { name: trimmed, color });
    if (!c.showInInbox) offerTip("category-inbox", c.id);
    navigate({ categoryId: c.id, accountId: null });
    return true;
  } catch (e) {
    snack.error(String(e));
    return false;
  }
}
