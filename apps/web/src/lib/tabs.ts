/**
 * Plan 24: the List layout's category tabs. They're another view of the same
 * state as the sidebar (view, category), never a state of their own, so the
 * tabs and the sidebar always agree. Pure parts (which tab is selected, what fits) are unit-tested.
 */
import { CATEGORY_COLORS } from "@terno/core";
import { client } from "~/rpc/connection";
import { offerTip } from "~/lib/tips";
import { snack } from "~/lib/snack";
import { getApp, navigate, setApp, type AppState } from "~/state/app";

/** The inbox, or a category id */
export type Tab = "all" | number;

type TabState = Pick<AppState, "view" | "accountId" | "categoryId" | "reviewCategoryId" | "query">;

/** Tabs slice the inbox: they show on the inbox and on a category's list, not in other folders, a search or Revisar. */
export function tabsShown(s: TabState): boolean {
  if (s.reviewCategoryId !== null || s.query.trim() !== "") return false;
  return s.categoryId !== null || s.view === "inbox";
}

/** The selected tab: the category, else the inbox. */
export function selectedTab(s: TabState): Tab | null {
  if (!tabsShown(s)) return null;
  return s.categoryId ?? "all";
}

/** One state change (so one list load). A category is the sidebar's category (the same list, the same count); the first tab, the inbox's list, with whatever filter it has. */
export function openTab(tab: Tab): void {
  const s = getApp();
  if (typeof tab === "number") {
    if (s.categoryId !== tab || s.reviewCategoryId !== null) navigate({ categoryId: tab });
    return;
  }
  // plan 86 (Codex code review #5): in a Gmail tab, the first tab is that tab's
  if (s.view === "inbox" && s.categoryId === null && s.reviewCategoryId === null && s.query === "") return;
  setApp({ view: "inbox", categoryId: null, reviewCategoryId: null, accountId: s.accountId, gmailTab: s.gmailTab, folder: null, query: "", selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false });
}

/**
 * A new category from its name (the sidebar's +, the tabs' +): the next
 * color, then its list. False when nothing was created (empty, or refused:
 * the reason is in the snack). `allAccounts`: the sidebar's, whose
 * categories are cross-account (plan 67); the tabs' keeps the account you're in.
 */
export async function createCategory(name: string, o: { allAccounts?: boolean } = {}): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    const color = CATEGORY_COLORS[getApp().categories.length % CATEGORY_COLORS.length]!;
    const c = await client.call("categories.create", { name: trimmed, color });
    if (!c.showInInbox) offerTip("category-inbox", c.id);
    navigate(o.allAccounts ? { categoryId: c.id, accountId: null } : { categoryId: c.id });
    return true;
  } catch (e) {
    snack.error(String(e));
    return false;
  }
}

/**
 * Which items fit on a strip's one row (List's tabs, Lumen's chips). What's in `pinned` is
 * always there (`pinned`, their widths and gaps). Categories follow in order
 * while they fit; the rest go behind "More" (whose width is reserved only
 * when something overflows). The selected category is never hidden: it takes
 * the last visible place. Widths only, so it doesn't care about direction.
 */
export function fitTabs(o: { widths: readonly number[]; available: number; pinned: number; more: number; gap: number; selected: number }): { visible: number[]; overflow: number[] } {
  const { widths, available, pinned, more, gap, selected } = o;
  const all = widths.map((_, i) => i);
  const total = pinned + widths.reduce((n, w) => n + w + gap, 0);
  if (total <= available) return { visible: all, overflow: [] };
  const room = available - pinned - more - gap;
  const visible: number[] = [];
  let used = 0;
  for (const i of all) {
    if (used + widths[i]! + gap > room) break;
    visible.push(i);
    used += widths[i]! + gap;
  }
  if (selected >= 0 && !visible.includes(selected)) {
    // the selected one takes the end of the row, displacing as many as it needs
    const need = widths[selected]! + gap;
    while (visible.length && used + need > room) used -= widths[visible.pop()!]! + gap;
    if (used + need <= room || visible.length === 0) visible.push(selected);
  }
  const shown = new Set(visible);
  return { visible, overflow: all.filter((i) => !shown.has(i)) };
}
