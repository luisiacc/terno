import type { ThreadSummary } from "@terno/core";
import type { Page } from "./types";

/**
 * The unread filter's open thread (`keepId`), read now, joins the page it
 * belongs to: still in the view (read or not; the store checked, the cursor
 * included) and placed at or before the page's last row, where the next page
 * starts. Elsewhere it waits for its own page; already there, nothing changes.
 */
export function keepInPage(page: Page, kept: ThreadSummary | null): Page {
  if (!kept || page.items.some((t) => t.id === kept.id)) return page;
  const next = page.nextCursor;
  if (next && (kept.lastDate < next.lastDate || (kept.lastDate === next.lastDate && kept.id < next.id))) return page;
  const at = page.items.findIndex((t) => t.lastDate < kept.lastDate || (t.lastDate === kept.lastDate && t.id < kept.id));
  const items = [...page.items];
  items.splice(at === -1 ? items.length : at, 0, kept);
  return { items, nextCursor: page.nextCursor };
}
