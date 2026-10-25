import { parseSearch } from "./search/parse";
import type { ThreadSummary } from "./types";

/**
 * The list's quick filters (plan 15, generalizing plan 12's unread filter):
 * one predicate, the same in the renderer (which rows stay), the stores'
 * pages and scopes, and searches (as an operator in front of the query).
 */
export const LIST_FILTERS = ["unread", "attachments", "starred"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export function isListFilter(v: unknown): v is ListFilter {
  return typeof v === "string" && (LIST_FILTERS as readonly string[]).includes(v);
}

/** The filter a request asks for: `filter`, or plan 12's `unreadOnly` (older renderers still send it). */
export function listFilterOf(p: { filter?: ListFilter; unreadOnly?: boolean }): ListFilter | undefined {
  return p.filter ?? (p.unreadOnly ? "unread" : undefined);
}

/** Does a thread match the filter (none: everything does)? */
export function matchesFilter(filter: ListFilter | undefined, t: Pick<ThreadSummary, "unread" | "starred" | "hasAttachments">): boolean {
  return filter === undefined || (filter === "unread" ? t.unread : filter === "starred" ? t.starred : t.hasAttachments);
}

const OPERATOR: Record<Exclude<ListFilter, "attachments">, string> = { unread: "is:unread", starred: "is:starred" };

/**
 * A search narrowed by a filter. Unread and starred are thread-level in every
 * search engine, so their operator goes in front of the query (the token
 * still being typed stays the last, prefix-matched one). `has:attachment` is
 * per message there, but the filter means "the conversation has
 * attachments": the query stays as it is and the caller keeps the threads
 * with attachments (`threadLevel`). `query` is null when the query asks for
 * the filter's opposite (both together match nothing).
 */
export function searchWithFilter(query: string, filter: ListFilter, now: number = Date.now()): { query: string | null; threadLevel: boolean } {
  const q = parseSearch(query, now);
  const opposite = filter === "unread" ? q.unread === false : filter === "starred" ? q.starred === false : q.hasAttachment === false;
  if (opposite) return { query: null, threadLevel: false };
  return filter === "attachments" ? { query, threadLevel: true } : { query: `${OPERATOR[filter]} ${query}`, threadLevel: false };
}

/** The query a filtered search runs: see searchWithFilter (the attachments filter is applied to its threads by the caller). */
export function withListFilter(query: string, filter: ListFilter, now: number = Date.now()): string | null {
  return searchWithFilter(query, filter, now).query;
}
