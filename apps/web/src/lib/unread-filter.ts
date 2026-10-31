/**
 * The list's quick filter (plan 12's unread filter, generalized in plan 15
 * to unread, with attachments and starred), like Mail's message filter: per
 * mailbox (a view, an account, a category), remembered across launches. A
 * search inherits the filter of the mailbox it searches in. The filter is
 * derived from the mailbox, never set by navigation, so every way of changing
 * mailbox (the sidebar, a sender search, boot) gets the right one.
 */
import { isListFilter, LIST_FILTERS, type ListFilter, type View } from "@terno/core";

export const STORAGE_KEY = "terno:list-filter";
/** plan 12's: the keys whose unread filter was on */
export const LEGACY_KEY = "terno:unread-filter";
/** keys kept, newest last (old mailboxes fall off) */
export const MAX_KEYS = 200;

export type ListFilters = ReadonlyMap<string, ListFilter>;

export interface Mailbox {
  view: View;
  accountId: number | null;
  categoryId: number | null;
  reviewCategoryId: number | null;
  /** plan 68: one of the account's own folders */
  folder?: string | null;
  /** plan 87: the Reminders list (never filtered) */
  reminders?: boolean;
}

/** "inbox||", "all||7", "inbox|2|", and a folder's "all|2||Work" (plan 68) */
export const mailboxKey = (m: Mailbox): string => `${m.view}|${m.accountId ?? ""}|${m.categoryId ?? ""}${m.folder ? `|${m.folder}` : ""}`;

/** Plan 15's filters: what a backend that doesn't say (older than plan 17) knows. */
export const LEGACY_FILTERS: readonly ListFilter[] = ["unread", "attachments", "starred"];

/** The filters a backend says it knows, in the renderer's order; nothing said: plan 15's (Codex R12). */
export function supportedFilters(said: readonly unknown[] | undefined): readonly ListFilter[] {
  return said ? LIST_FILTERS.filter((f) => said.includes(f)) : LEGACY_FILTERS;
}

/**
 * The current list's filter, if any. "Revisar" (a category's suggestions) and
 * Reminders are never filtered, and a remembered filter the backend doesn't
 * know reads as none (it would be refused).
 */
export function activeFilter(m: Mailbox & { listFilters: ListFilters; supportedFilters?: readonly ListFilter[] }): ListFilter | undefined {
  const f = m.reviewCategoryId === null && !m.reminders ? m.listFilters.get(mailboxKey(m)) : undefined;
  return f && (m.supportedFilters ?? LIST_FILTERS).includes(f) ? f : undefined;
}

/** Is the current list filtered to unread threads (⌘L's state, its "Filtered by" count)? */
export function isUnreadOnly(m: Mailbox & { listFilters: ListFilters }): boolean {
  return activeFilter(m) === "unread";
}

/** a mailbox key: short, or a folder's (plan 68, Codex R1: an IMAP path is up to 1,000 characters) */
const goodKey = (k: unknown): k is string => typeof k === "string" && k.length > 0 && k.length <= 1100;

/** What was stored: [key, filter] pairs, else nothing on (storage may be unavailable or hold anything). */
export function parseStored(raw: string | null): Map<string, ListFilter> {
  try {
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(v)) return new Map();
    const pairs = v.filter((p): p is [string, ListFilter] => Array.isArray(p) && p.length === 2 && goodKey(p[0]) && isListFilter(p[1]));
    return new Map(pairs.slice(-MAX_KEYS));
  } catch {
    return new Map();
  }
}

/** plan 12's list of keys whose unread filter was on */
export function parseLegacy(raw: string | null): Map<string, ListFilter> {
  try {
    const v: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(v)) return new Map();
    return new Map(v.filter(goodKey).slice(-MAX_KEYS).map((k) => [k, "unread" as const]));
  } catch {
    return new Map();
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

/** The stored filters; the first time, plan 12's unread ones, carried over. */
export function loadListFilters(storage: Pick<Storage, "getItem"> | null = local()): Map<string, ListFilter> {
  try {
    const raw = storage?.getItem(STORAGE_KEY) ?? null;
    return raw === null ? parseLegacy(storage?.getItem(LEGACY_KEY) ?? null) : parseStored(raw);
  } catch {
    return new Map();
  }
}

/** The filters with `key` set to `filter` (newest last; past MAX_KEYS the oldest fall off), or cleared. */
export function withFilter(filters: ListFilters, key: string, filter: ListFilter | undefined): Map<string, ListFilter> {
  const next = new Map(filters);
  next.delete(key);
  if (filter) next.set(key, filter);
  return new Map([...next].slice(-MAX_KEYS));
}

export function saveListFilters(filters: ListFilters, storage: Pick<Storage, "setItem"> | null = local()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify([...filters]));
  } catch {
    // full or unavailable storage: the filter still applies for this session
  }
}
