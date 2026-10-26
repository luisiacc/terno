import { waitingCutoff } from "./people";
import { parseSearch } from "./search/parse";
import type { ThreadSummary } from "./types";

/**
 * The list's quick filters (plan 15, generalizing plan 12's unread filter;
 * People and Waiting from plan 17): one predicate, the same in the renderer
 * (which rows stay), the stores' pages and scopes, and searches (as an
 * operator in front of the query, or a thread filter every engine applies).
 */
export const LIST_FILTERS = ["unread", "people", "waiting", "attachments", "starred"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

/** The filters every search engine applies to whole conversations before paging (no operator says them). */
export type ThreadFilter = Extract<ListFilter, "attachments" | "people" | "waiting">;

export function isListFilter(v: unknown): v is ListFilter {
  return typeof v === "string" && (LIST_FILTERS as readonly string[]).includes(v);
}

/** The filter a request asks for: `filter`, or plan 12's `unreadOnly` (older renderers still send it). */
export function listFilterOf(p: { filter?: ListFilter; unreadOnly?: boolean }): ListFilter | undefined {
  return p.filter ?? (p.unreadOnly ? "unread" : undefined);
}

/**
 * Does a thread match the filter (none: everything does)? Waiting holds while
 * the thread's `waitingSince` is inside the window at `now` (plan 17); an older
 * backend's summaries carry no facts and match neither People nor Waiting.
 */
export function matchesFilter(filter: ListFilter | undefined, t: Pick<ThreadSummary, "unread" | "starred" | "hasAttachments" | "person" | "waitingSince">, now: number = Date.now()): boolean {
  switch (filter) {
    case undefined:
      return true;
    case "unread":
      return t.unread;
    case "starred":
      return t.starred;
    case "attachments":
      return t.hasAttachments;
    case "people":
      return t.person === true;
    case "waiting":
      return t.waitingSince != null && t.waitingSince >= waitingCutoff(now);
  }
}

const OPERATOR: Record<Exclude<ListFilter, ThreadFilter>, string> = { unread: "is:unread", starred: "is:starred" };

/**
 * A search narrowed by a filter. Unread and starred are thread-level in every
 * search engine, so their operator goes in front of the query (the token
 * still being typed stays the last, prefix-matched one). `has:attachment` is
 * per message there, but the filter means "the conversation has
 * attachments": the query stays as it is and every engine keeps the threads
 * that have them (`threadFilter`), as it does for People and Waiting, which
 * no operator says. `query` is null when the query asks for the filter's
 * opposite (both together match nothing).
 */
export function searchWithFilter(query: string, filter: ListFilter, now: number = Date.now()): { query: string | null; threadFilter?: ThreadFilter } {
  if (filter === "people" || filter === "waiting") return { query, threadFilter: filter };
  const q = parseSearch(query, now);
  const opposite = filter === "unread" ? q.unread === false : filter === "starred" ? q.starred === false : q.hasAttachment === false;
  if (opposite) return { query: null };
  return filter === "attachments" ? { query, threadFilter: "attachments" } : { query: `${OPERATOR[filter]} ${query}` };
}

/** The query a filtered search runs: see searchWithFilter (thread filters are applied by the engines). */
export function withListFilter(query: string, filter: ListFilter, now: number = Date.now()): string | null {
  return searchWithFilter(query, filter, now).query;
}
