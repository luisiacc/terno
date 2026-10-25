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

const OPERATOR: Record<ListFilter, string> = { unread: "is:unread", attachments: "has:attachment", starred: "is:starred" };

/**
 * A search narrowed by a filter: the query with the filter's operator in
 * front, so the token still being typed stays the last (prefix-matched) one;
 * null when the query asks for the opposite (both together match nothing).
 */
export function withListFilter(query: string, filter: ListFilter, now: number = Date.now()): string | null {
  const q = parseSearch(query, now);
  const opposite = filter === "unread" ? q.unread === false : filter === "starred" ? q.starred === false : q.hasAttachment === false;
  return opposite ? null : `${OPERATOR[filter]} ${query}`;
}
