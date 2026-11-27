import { PEOPLE_FILTER_ACCOUNTS_MAX, PEOPLE_WITHIN, type PeopleFilter, type PeopleWithin } from "@terno/core";
import { localeTag, t } from "@terno/i18n";
import type { Account } from "@terno/core";

/**
 * Plan 287: People's filter as the user set it (the date of the last email, the accounts), remembered on this device. What
 * a read asks for is `effectivePeopleFilter`: in a focused account, that account alone.
 */
export interface PeopleFilterChoice {
  within: PeopleWithin | null;
  /**
   * a custom range (plan 287), its first and last days ("2026-11-03"): days, so a stored range means the same days
   * whatever the clock's zone; with it, `within` is null
   */
  range: PeopleRange | null;
  /** none: every account */
  accounts: number[];
}

/** A custom range's days, as `YYYY-MM-DD` (local), `from` never after `to`. */
export interface PeopleRange {
  from: string;
  to: string;
}

export const NO_PEOPLE_FILTER: PeopleFilterChoice = { within: null, range: null, accounts: [] };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A day's `YYYY-MM-DD` (local) and back: the local midnight starting it. */
export const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function dayOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}
/** The first day a range can start on (a filter's moments are after 1970, in any zone). */
export const FIRST_DAY = new Date(1970, 0, 2);

/** a stored range, if it is one: two real days from `FIRST_DAY`, the first not after the last */
function rangeOf(raw: unknown): PeopleRange | null {
  const r = raw as { from?: unknown; to?: unknown } | null;
  if (!r || typeof r.from !== "string" || typeof r.to !== "string" || !DAY.test(r.from) || !DAY.test(r.to)) return null;
  if (dayKey(dayOf(r.from)) !== r.from || dayKey(dayOf(r.to)) !== r.to || r.from > r.to || dayOf(r.from) < FIRST_DAY) return null;
  return { from: r.from, to: r.to };
}

/** The choice without its date (any time). */
export const withoutDate = (choice: PeopleFilterChoice): PeopleFilterChoice => ({ ...choice, within: null, range: null });
/** Whether the choice has a date (a period or a range). */
export const hasDate = (choice: PeopleFilterChoice): boolean => !!choice.within || !!choice.range;

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
    const raw = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as { within?: unknown; range?: unknown; accounts?: unknown } | null;
    if (!raw || typeof raw !== "object") return NO_PEOPLE_FILTER;
    const range = rangeOf(raw.range);
    const within = range ? null : (PEOPLE_WITHIN.find((w) => w === raw.within) ?? null);
    const accounts = Array.isArray(raw.accounts) ? [...new Set(raw.accounts.filter((a): a is number => Number.isInteger(a) && a > 0))].slice(0, PEOPLE_FILTER_ACCOUNTS_MAX) : [];
    return { within, range, accounts };
  } catch {
    return NO_PEOPLE_FILTER;
  }
}

export function savePeopleFilter(choice: PeopleFilterChoice, storage: Pick<Storage, "setItem" | "removeItem"> | null = local()): void {
  try {
    if (!hasDate(choice) && !choice.accounts.length) storage?.removeItem(STORAGE_KEY);
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
  // a range from the local start of its first day to the local end of its last
  const range = choice.range ? { from: dayOf(choice.range.from).getTime(), to: endOfDay(choice.range.to) } : null;
  return { ...(range ? { range } : choice.within ? { within: choice.within } : {}), ...(ids.length ? { accounts: ids } : {}) };
}

/** The choice with one account ticked or unticked (all of them ticked is every account: none). */
export function toggleAccount(choice: PeopleFilterChoice, id: number, accounts: readonly Account[]): PeopleFilterChoice {
  const live = choice.accounts.filter((a) => accounts.some((x) => x.id === a));
  const next = live.includes(id) ? live.filter((a) => a !== id) : [...live, id];
  return { ...choice, accounts: next.length >= accounts.length ? [] : next };
}

export const withinLabel = (within: PeopleWithin | null): string => t(within ? `people.filter.${within}` : "people.filter.any");

/** the last moment of a day (its next midnight less one, so a day that's 23 or 25 hours long is whole) */
function endOfDay(key: string): number {
  const d = dayOf(key);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

/** A range in words, as short as it reads: "Nov 3 – 20", "Nov 28 – Dec 4", a year only when it isn't this one. */
export function rangeLabel(range: PeopleRange, now = new Date()): string {
  const from = dayOf(range.from);
  const to = dayOf(range.to);
  const thisYear = from.getFullYear() === now.getFullYear() && to.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(localeTag(), { month: "short", day: "numeric", ...(thisYear ? {} : { year: "numeric" }) }).formatRange(from, to).replace(/\./g, "");
}

/** How many days a range holds (both ends counted). */
export const rangeDays = (range: PeopleRange): number => Math.round((dayOf(range.to).getTime() - dayOf(range.from).getTime()) / 86_400_000) + 1;

/** The date part in words: a period's name or a range's days, null for any time. */
export const dateLabel = (choice: PeopleFilterChoice): string | null => (choice.range ? rangeLabel(choice.range) : choice.within ? withinLabel(choice.within) : null);

/** A chip's words for the accounts: one or two by name, more by their count. */
export function accountsLabel(chosen: readonly Account[]): string {
  return chosen.length > 2 ? t("people.filter.accountsCount", { count: chosen.length }) : chosen.map((a) => a.displayName).join(", ");
}

/** The filter as the button's name says it ("Past month, 2 accounts"), or null when none is on. */
export function filterSummary(choice: PeopleFilterChoice, accounts: readonly Account[], solo: boolean): string | null {
  const parts: string[] = [];
  const date = dateLabel(choice);
  if (date) parts.push(date);
  const chosen = solo ? [] : chosenAccounts(choice, accounts);
  if (chosen.length) parts.push(accountsLabel(chosen));
  return parts.length ? parts.join(", ") : null;
}
