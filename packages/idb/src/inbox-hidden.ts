import type { MemDb, Row } from "./mem";

/**
 * Plan 83 (SQLite's hiddenCategories): the categories whose mail the plain
 * Inbox leaves out, or null when none is (every Inbox walk is what it was).
 * A row written before plan 83 has no show_in_inbox: shown.
 */
export function hiddenCategories(db: MemDb): Set<number> | null {
  let hidden: Set<number> | null = null;
  for (const r of db.table<Row & Record<string, any>>("categories").all()) if (r.show_in_inbox === 0) (hidden ??= new Set()).add(r.id as number);
  return hidden;
}

/** A thread in a hidden category: one lookup of its memberships. */
export function hiddenFromInbox(db: MemDb, hidden: ReadonlySet<number> | null, threadId: number): boolean {
  if (!hidden) return false;
  return db.table<Row & Record<string, any>>("thread_categories").by("fk_thread_id", threadId).some((r) => hidden.has(r.category_id as number));
}

/**
 * Plan 86 (SQLite's inboxHiding().tabsOff): a test that a thread is in a
 * Gmail tab its account keeps out of the Inbox, or null when no account does
 * (every Inbox walk is what it was). A row from before plan 86 has no tab.
 */
export function tabHiddenTest(db: MemDb): ((t: Row & Record<string, any>) => boolean) | null {
  let separated: Set<number> | null = null;
  for (const a of db.table<Row & Record<string, any>>("accounts").all()) {
    if (a.kind === "gmail" && (JSON.parse(a.provider_config as string) as { separateTabs?: boolean }).separateTabs !== false) (separated ??= new Set()).add(a.id as number);
  }
  if (!separated) return null;
  const s = separated;
  return (t) => !!t.tab && s.has(t.account_id as number);
}
