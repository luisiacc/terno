/**
 * The unread filter (plan 12), like Mail's message filter: per mailbox (a
 * view, an account, a category), remembered across launches. A search
 * inherits the state of the mailbox it searches in. The filter is derived
 * from the mailbox, never set by navigation, so every way of changing
 * mailbox (the sidebar, a sender search, boot) gets the right one.
 */
import type { View } from "@terno/core";

export const STORAGE_KEY = "terno:unread-filter";
/** keys kept, newest last (old mailboxes fall off) */
export const MAX_KEYS = 200;

export interface Mailbox {
  view: View;
  accountId: number | null;
  categoryId: number | null;
  reviewCategoryId: number | null;
}

/** "inbox||", "all||7", "inbox|2|" */
export const mailboxKey = (m: Mailbox): string => `${m.view}|${m.accountId ?? ""}|${m.categoryId ?? ""}`;

/** Is the current list filtered? "Revisar" (a category's suggestions) never is. */
export function isUnreadOnly(m: Mailbox & { unreadFilters: ReadonlySet<string> }): boolean {
  return m.reviewCategoryId === null && m.unreadFilters.has(mailboxKey(m));
}

/** What was stored: an array of short strings, else nothing on (storage may be unavailable or hold anything). */
export function parseStored(raw: string | null): Set<string> {
  try {
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(v)) return new Set();
    return new Set(v.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 64).slice(-MAX_KEYS));
  } catch {
    return new Set();
  }
}

/** localStorage, if this context has one (reading the global itself can throw) */
function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadUnreadFilters(storage: Pick<Storage, "getItem"> | null = local()): Set<string> {
  try {
    return parseStored(storage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return new Set();
  }
}

/** The set with `key` flipped (an "on" key moves to the newest end; past MAX_KEYS the oldest fall off). */
export function flipped(filters: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(filters);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return new Set([...next].slice(-MAX_KEYS));
}

export function saveUnreadFilters(filters: ReadonlySet<string>, storage: Pick<Storage, "setItem"> | null = local()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...filters]));
  } catch {
    // full or unavailable storage: the filter still applies for this session
  }
}
