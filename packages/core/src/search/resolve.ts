import { normalizeText } from "../text";
import type { View } from "../types";
import type { SearchQuery } from "./parse";

export interface ScopeLookup {
  accounts: readonly { id: number; email: string; display_name: string }[];
  categories: readonly { id: number; name: string }[];
}

/** account:/category: tokens resolved to ids, so every engine scopes a query identically. */
export interface ResolvedSearch {
  query: SearchQuery;
  view: View;
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

export function searchKey(text: string, scope: { accountId?: number; categoryId?: number }): string {
  return JSON.stringify([text, scope.accountId ?? null, scope.categoryId ?? null]);
}

export function resolveSearch(
  query: SearchQuery,
  text: string,
  scope: { accountId?: number; categoryId?: number },
  lookup: ScopeLookup,
): ResolvedSearch {
  let impossible = false;
  const accountIds = new Set<number>();
  if (scope.accountId !== undefined) accountIds.add(scope.accountId);
  for (const token of query.accounts) {
    const matches = accountMatches(lookup, token);
    if (matches.length === 0) impossible = true;
    // account:x inside an account view narrows instead of widening
    if (scope.accountId !== undefined) {
      if (!matches.includes(scope.accountId)) impossible = true;
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
    view: query.view ?? "all",
    accountIds: accountIds.size > 0 ? [...accountIds] : null,
    excludeAccountIds: [...excludeAccountIds],
    categoryIds: [...categoryIds],
    excludeCategoryIds: [...excludeCategoryIds],
    impossible,
    key: searchKey(text, scope),
  };
}
