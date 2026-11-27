import { PEOPLE_FILTER_ACCOUNTS_MAX, PEOPLE_WITHIN, type PeopleFilter, type PeopleWithin } from "@terno/core";
import { t } from "@terno/i18n";
import type { Account } from "@terno/core";

/**
 * Plan 287: People's filter as the user set it (the date of the last email, the accounts), remembered on this device. What
 * a read asks for is `effectivePeopleFilter`: in a focused account, that account alone.
 */
export interface PeopleFilterChoice {
  within: PeopleWithin | null;
  /** none: every account */
  accounts: number[];
}

export const NO_PEOPLE_FILTER: PeopleFilterChoice = { within: null, accounts: [] };

const STORAGE_KEY = "terno:people-filter";

/** localStorage, if this context has one (reading the global itself can throw) */
function local(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored choice; anything unreadable is no filter. */
export function loadPeopleFilter(storage: Pick<Storage, "getItem"> | null = local()): PeopleFilterChoice {
  try {
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as { within?: unknown; accounts?: unknown } | null;
    if (!raw || typeof raw !== "object") return NO_PEOPLE_FILTER;
    const within = PEOPLE_WITHIN.find((w) => w === raw.within) ?? null;
    const accounts = Array.isArray(raw.accounts) ? [...new Set(raw.accounts.filter((a): a is number => Number.isInteger(a) && a > 0))].slice(0, PEOPLE_FILTER_ACCOUNTS_MAX) : [];
    return { within, accounts };
  } catch {
    return NO_PEOPLE_FILTER;
  }
}

export function savePeopleFilter(choice: PeopleFilterChoice, storage: Pick<Storage, "setItem" | "removeItem"> | null = local()): void {
  try {
    if (!choice.within && !choice.accounts.length) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // private mode, a full disk: the filter holds for this session
  }
}

/** The accounts chosen that still exist, in the sidebar's order; every one of them chosen is none (every account). */
export function chosenAccounts(choice: PeopleFilterChoice, accounts: readonly Account[]): Account[] {
  const chosen = accounts.filter((a) => choice.accounts.includes(a.id));
  return chosen.length === accounts.length ? [] : chosen;
}

/** What a read asks for: the date, and the accounts (a focused account alone, else those chosen that still exist). */
export function effectivePeopleFilter(choice: PeopleFilterChoice, accounts: readonly Account[], solo: number | null): PeopleFilter {
  const ids = solo !== null ? [solo] : chosenAccounts(choice, accounts).map((a) => a.id);
  return { ...(choice.within ? { within: choice.within } : {}), ...(ids.length ? { accounts: ids } : {}) };
}

/** The choice with one account ticked or unticked (all of them ticked is every account: none). */
export function toggleAccount(choice: PeopleFilterChoice, id: number, accounts: readonly Account[]): PeopleFilterChoice {
  const live = choice.accounts.filter((a) => accounts.some((x) => x.id === a));
  const next = live.includes(id) ? live.filter((a) => a !== id) : [...live, id];
  return { ...choice, accounts: next.length >= accounts.length ? [] : next };
}

export const withinLabel = (within: PeopleWithin | null): string => t(within ? `people.filter.${within}` : "people.filter.any");

/** A chip's words for the accounts: one or two by name, more by their count. */
export function accountsLabel(chosen: readonly Account[]): string {
  return chosen.length > 2 ? t("people.filter.accountsCount", { count: chosen.length }) : chosen.map((a) => a.displayName).join(", ");
}

/** The filter as the button's name says it ("Past month, 2 accounts"), or null when none is on. */
export function filterSummary(choice: PeopleFilterChoice, accounts: readonly Account[], solo: boolean): string | null {
  const parts: string[] = [];
  if (choice.within) parts.push(withinLabel(choice.within));
  const chosen = solo ? [] : chosenAccounts(choice, accounts);
  if (chosen.length) parts.push(accountsLabel(chosen));
  return parts.length ? parts.join(", ") : null;
}
