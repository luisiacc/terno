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

/** What the plain Inbox leaves out: plan 83's hidden categories, plan 86's Gmail tabs, plan 238's accounts. */
export interface InboxHiding {
  categories: readonly number[];
  /**
   * plan 86, 275: null when no account with tabs (Gmail's, Outlook's Other) separates them (no test at all); else those
   * of them that don't (each account by its own setting, whatever another kind's is)
   */
  tabsOff: readonly number[] | null;
  /** plan 238: the accounts out of the all-accounts Inbox (an account's own Inbox keeps them) */
  accountsOff: readonly number[];
}
export const NO_HIDING: InboxHiding = { categories: [], tabsOff: null, accountsOff: [] };

/** Read per query: the categories table and the accounts are a handful of rows. */
export function inboxHiding(db: Db): InboxHiding {
  const accounts = db.all<{ id: number; tabbed: number; tabsOff: number; out: number }>(
    "SELECT id, kind IN ('gmail', 'outlook') AS tabbed, coalesce(json_extract(provider_config, '$.separateTabs') = 0, 0) AS tabsOff, coalesce(json_extract(provider_config, '$.unified') = 0, 0) AS out FROM accounts ORDER BY id",
  );
  const tabbed = accounts.filter((a) => a.tabbed);
  return {
    categories: hiddenCategories(db),
    tabsOff: tabbed.some((a) => !a.tabsOff) ? tabbed.filter((a) => a.tabsOff).map((a) => a.id) : null,
    accountsOff: accounts.filter((a) => a.out).map((a) => a.id),
  };
}

/**
 * The tests the plain Inbox adds for `alias` (none with nothing hidden: the SQL is what it was). `all`: the
 * all-accounts Inbox, which also leaves out plan 238's accounts (a column of the row it reads anyway).
 */
export function hidingSql(alias: string, h: InboxHiding, all = false): { where: string[]; params: Param[] } {
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
  if (all && h.accountsOff.length) {
    where.push(`${alias}.account_id NOT IN (${placeholders(h.accountsOff.length)})`);
    params.push(...h.accountsOff);
  }
  return { where, params };
}
