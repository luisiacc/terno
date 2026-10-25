import type { ThreadSummary } from "@terno/core";
import type { Page } from "./types";

const before = (a: ThreadSummary, b: { lastDate: number; id: number }) => a.lastDate > b.lastDate || (a.lastDate === b.lastDate && a.id > b.id);

/**
 * The unread filter's kept threads (`keepIds`: the open one, the checked
 * ones), read now, join the page they belong to: still in the view (read or
 * not; the store checked, the cursor included) and placed before the page's
 * last row, where the next page starts. Others wait for their own page; ones
 * already there change nothing.
 */
export function keepInPage(page: Page, kept: readonly ThreadSummary[]): Page {
  const have = new Set(page.items.map((t) => t.id));
  const next = page.nextCursor;
  const joining = kept.filter((k) => !have.has(k.id) && (!next || before(k, next)));
  if (joining.length === 0) return page;
  const items = [...page.items, ...joining].sort((a, b) => b.lastDate - a.lastDate || b.id - a.id);
  return { items, nextCursor: page.nextCursor };
}
