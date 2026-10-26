/**
 * Plan 24: the List layout's category tabs. They're another view of the same
 * state as the sidebar and the quick filter (view, category, the mailbox's
 * filter), never a state of their own, so the tabs, the sidebar and ⌘L always
 * agree. Pure parts (which tab is selected, what fits) are unit-tested.
 */
import { CATEGORY_COLORS } from "@terno/core";
import { client } from "~/rpc/connection";
import { snack } from "~/lib/snack";
import { activeFilter, mailboxKey, saveListFilters, withFilter } from "~/lib/unread-filter";
import { getApp, navigate, setApp, type AppState } from "~/state/app";

/** All, Unread (the inbox), or a category id */
export type Tab = "all" | "unread" | number;

type TabState = Pick<AppState, "view" | "accountId" | "categoryId" | "reviewCategoryId" | "query" | "listFilters">;

/** Tabs slice the inbox: they show on the inbox and on a category's list, not in other folders, a search or Revisar. */
export function tabsShown(s: TabState): boolean {
  if (s.reviewCategoryId !== null || s.query.trim() !== "") return false;
  return s.categoryId !== null || s.view === "inbox";
}

/** The selected tab: the category; else Unread when the inbox is filtered to unread; else All. */
export function selectedTab(s: TabState): Tab | null {
  if (!tabsShown(s)) return null;
  if (s.categoryId !== null) return s.categoryId;
  return activeFilter(s) === "unread" ? "unread" : "all";
}

/**
 * One state change (so one list load). A category is the sidebar's category
 * (the same list, the same count). All and Unread are the inbox, its filter
 * off or on Unread: inside the inbox that's exactly ⌘L (the open thread and
 * the cursor stay); from a category it's the inbox's list.
 */
export function openTab(tab: Tab): void {
  const s = getApp();
  if (typeof tab === "number") {
    if (s.categoryId !== tab || s.reviewCategoryId !== null) navigate({ categoryId: tab });
    return;
  }
  const inbox = { view: "inbox" as const, accountId: s.accountId, categoryId: null, reviewCategoryId: null };
  const listFilters = withFilter(s.listFilters, mailboxKey(inbox), tab === "unread" ? "unread" : undefined);
  const same = activeFilter({ ...inbox, listFilters: s.listFilters }) === (tab === "unread" ? "unread" : undefined);
  const inInbox = s.view === "inbox" && s.categoryId === null && s.reviewCategoryId === null && s.query === "";
  if (inInbox && same) return;
  if (!same) saveListFilters(listFilters);
  if (inInbox) return void setApp({ listFilters, checked: new Set(), anchorId: null, scope: null });
  setApp({ ...navigatePatch(s), listFilters });
}

/** What navigate({ view: "inbox" }) writes, to go in the same setApp as the filter. */
function navigatePatch(s: AppState): Partial<AppState> {
  return { view: "inbox", categoryId: null, reviewCategoryId: null, accountId: s.accountId, query: "", selectedId: null, checked: new Set(), anchorId: null, scope: null, readerOpen: false };
}

/**
 * A new category from its name (the sidebar's +, the tabs' +): the next
 * color, then its list. False when nothing was created (empty, or refused:
 * the reason is in the snack).
 */
export async function createCategory(name: string): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  try {
    const color = CATEGORY_COLORS[getApp().categories.length % CATEGORY_COLORS.length]!;
    const c = await client.call("categories.create", { name: trimmed, color });
    navigate({ categoryId: c.id });
    return true;
  } catch (e) {
    snack.error(String(e));
    return false;
  }
}

/**
 * Which categories fit on the strip's one row. All, Unread and "+" are
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
