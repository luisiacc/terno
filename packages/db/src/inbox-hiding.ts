import { placeholders, type Db, type Param } from "./sqlite";

/**
 * Plan 83: the categories whose mail the plain Inbox leaves out (a handful of
 * rows, read per query). None: every Inbox query is the SQL it was.
 */
export function hiddenCategories(db: Db): number[] {
  return db.all<{ id: number }>("SELECT id FROM categories WHERE show_in_inbox = 0 ORDER BY id").map((r) => r.id);
}

/** The thread (`alias`) is in no hidden category: a primary-key probe of its memberships. */
export function shownInInbox(alias: string, hidden: readonly number[]): { where: string; params: Param[] } {
  return { where: `NOT EXISTS (SELECT 1 FROM thread_categories h WHERE h.thread_id = ${alias}.id AND h.category_id IN (${placeholders(hidden.length)}))`, params: [...hidden] };
}

/** What the plain Inbox leaves out: plan 83's hidden categories, plan 86's Gmail tabs. */
export interface InboxHiding {
  categories: readonly number[];
  /** plan 86: null when no Gmail account separates its tabs (no test at all); else the Gmail accounts that don't */
  tabsOff: readonly number[] | null;
}
export const NO_HIDING: InboxHiding = { categories: [], tabsOff: null };

/** Read per query: the categories table and the Gmail accounts are a handful of rows. */
export function inboxHiding(db: Db): InboxHiding {
  const gmail = db.all<{ id: number; off: number }>("SELECT id, coalesce(json_extract(provider_config, '$.separateTabs') = 0, 0) AS off FROM accounts WHERE kind = 'gmail' ORDER BY id");
  return { categories: hiddenCategories(db), tabsOff: gmail.some((a) => !a.off) ? gmail.filter((a) => a.off).map((a) => a.id) : null };
}

/** The tests the plain Inbox adds for `alias` (none with nothing hidden: the SQL is what it was). */
export function hidingSql(alias: string, h: InboxHiding): { where: string[]; params: Param[] } {
  const where: string[] = [];
  const params: Param[] = [];
  if (h.categories.length) {
    const c = shownInInbox(alias, h.categories);
    where.push(c.where);
    params.push(...c.params);
  }
  if (h.tabsOff) {
    // a column of the row the Inbox reads anyway; an account that keeps its tabs in the Inbox is let through
    where.push(h.tabsOff.length ? `(${alias}.tab = 0 OR ${alias}.account_id IN (${placeholders(h.tabsOff.length)}))` : `${alias}.tab = 0`);
    params.push(...h.tabsOff);
  }
  return { where, params };
}
