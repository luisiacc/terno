import { normalizeText } from "../text";
import type { ThreadFilter } from "../list-filter";
import { waitingCutoff } from "../people";
import type { SearchQuery, SearchView } from "./parse";

export interface ScopeLookup {
  accounts: readonly { id: number; email: string; display_name: string }[];
  categories: readonly { id: number; name: string }[];
}

/** account:/category: tokens resolved to ids, so every engine scopes a query identically. */
export interface ResolvedSearch {
  query: SearchQuery;
  /** plan 64: anywhere unless the query says in:… (or the caller's `place`, plan 185) */
  view: SearchView;
  /** null = any account */
  accountIds: readonly number[] | null;
  excludeAccountIds: readonly number[];
  /** the thread must be in every one of them */
  categoryIds: readonly number[];
  excludeCategoryIds: readonly number[];
  impossible: boolean;
  /** identifies the query as typed plus its UI scope (relative dates move with time, the key doesn't) */
  key: string;
}

function accountMatches(lookup: ScopeLookup, token: string): number[] {
  return lookup.accounts
    .filter((a) => normalizeText(a.email).includes(token) || normalizeText(a.display_name).includes(token))
    .map((a) => a.id);
}

function categoryMatch(lookup: ScopeLookup, token: string): number | undefined {
  return (
    lookup.categories.find((c) => normalizeText(c.name) === token) ?? lookup.categories.find((c) => normalizeText(c.name).startsWith(token))
  )?.id;
}

export function searchKey(text: string, scope: { accountId?: number; accountIds?: readonly number[]; categoryId?: number; place?: SearchView }): string {
  // plan 185: a place only when one is set, so the keys (and cursors) of a search that has none never change
  const key = scope.place === undefined ? [text, scope.accountId ?? null, scope.categoryId ?? null] : [text, scope.accountId ?? null, scope.categoryId ?? null, scope.place];
  // plan 287: a set of accounts only when one is given, likewise
  return JSON.stringify(scope.accountIds?.length ? [...key, [...scope.accountIds].sort((a, b) => a - b)] : key);
}

export function resolveSearch(
  query: SearchQuery,
  text: string,
  /** `place` (plan 185): where a query that names none looks; anywhere unless set (an agent's search: `all`) */
  /** `accountIds` (plan 287, People's filter): in any of these accounts, as `accountId` is in one */
  scope: { accountId?: number; accountIds?: readonly number[]; categoryId?: number; threadAttachments?: boolean; threadFilter?: ThreadFilter; now?: number; place?: SearchView },
  lookup: ScopeLookup,
): ResolvedSearch {
  // the list's thread filters (plan 15's attachments, plan 17's people and waiting): thread-level, applied by the
  // engines, a part of the query's identity (waiting's window moves with the clock, so only its name is)
  const thread = scope.threadFilter ?? (scope.threadAttachments ? "attachments" : undefined);
  if (thread === "attachments") query = { ...query, threadAttachments: true };
  else if (thread === "people") query = { ...query, threadPeople: true };
  else if (thread === "waiting") query = { ...query, threadWaitingSince: waitingCutoff(scope.now ?? Date.now()) };
  let impossible = false;
  // the scope's accounts: an account view's one, or a set of them (plan 287); account:x inside them narrows instead of widening
  const fixed = scope.accountId !== undefined ? [scope.accountId] : scope.accountIds?.length ? [...new Set(scope.accountIds)] : null;
  let accountIds = new Set<number>(fixed);
  for (const token of query.accounts) {
    const matches = accountMatches(lookup, token);
    if (matches.length === 0) impossible = true;
    if (fixed) {
      accountIds = new Set([...accountIds].filter((id) => matches.includes(id)));
      if (accountIds.size === 0) impossible = true;
    } else {
      for (const id of matches) accountIds.add(id);
    }
  }
  const categoryIds = new Set<number>();
  if (scope.categoryId !== undefined) categoryIds.add(scope.categoryId);
  for (const token of query.categories) {
    const id = categoryMatch(lookup, token);
    if (id === undefined) impossible = true;
    else categoryIds.add(id);
  }
  const excludeAccountIds = new Set(query.excludeAccounts.flatMap((token) => accountMatches(lookup, token)));
  const excludeCategoryIds = new Set<number>();
  for (const token of query.excludeCategories) {
    // excluding a category that doesn't exist excludes nothing
    const id = categoryMatch(lookup, token);
    if (id !== undefined) excludeCategoryIds.add(id);
  }
  return {
    query,
    view: query.view ?? scope.place ?? "anywhere",
    accountIds: accountIds.size > 0 ? [...accountIds] : null,
    excludeAccountIds: [...excludeAccountIds],
    categoryIds: [...categoryIds],
    excludeCategoryIds: [...excludeCategoryIds],
    impossible,
    key: searchKey(text, scope) + (thread ? `\u0000${thread}` : ""),
  };
}
