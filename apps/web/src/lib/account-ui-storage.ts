/**
 * Plan 293 (CASA 6.6.1): what this window keeps of an account in its browser storage goes when the account does.
 * Nothing there is authentication material (tokens, passwords and keys live in the backend, sealed by the OS
 * keychain), but some keys name an account or hold mail-derived words: the list filters (account ids and folder names),
 * People's filter (account ids), the palette's usage (account, focus and tab ids). Removing an account drops its
 * entries; removing the last one also drops every mail-derived key (the learned-rule offers seen: sender addresses
 * and domains), so a Terno with no account keeps only preferences. Memory and storage go together, so nothing writes
 * an old value back.
 */
import { NO_PEOPLE_FILTER, savePeopleFilter } from "./people-filter";
import { LEGACY_KEY, saveListFilters, STORAGE_KEY as LIST_FILTER_KEY } from "./unread-filter";
import { forgetUsage } from "./palette-usage";
import { forgetSeenOffers } from "./learned";
import { getApp, setApp } from "~/state/app";
import { usePeople } from "~/state/people";

/** The account a list-filter key belongs to (`view|accountId|…`), or null for one across accounts. */
const accountOfMailbox = (key: string): number | null => Number(key.split("|")[1]) || null;

/** The account a palette id names (`account:3`, `focus:3`, `tab:3:promotions`), or null. */
const accountOfCommand = (id: string): number | null => {
  const m = /^(account|focus|tab):(\d+)(:|$)/.exec(id);
  return m ? Number(m[2]) : null;
};

function remove(storage: "localStorage" | "sessionStorage", key: string): void {
  try {
    globalThis[storage]?.removeItem(key);
  } catch {
    // storage refused: nothing kept there to begin with
  }
}

/** `gone`: the accounts just removed; `remaining`: how many are left. */
export function forgetAccountsUi(gone: readonly number[], remaining: number): void {
  const last = remaining === 0;
  const dropped = new Set(gone);
  // the list filters: that account's mailboxes (all of them, after the last account)
  const listFilters = last ? new Map() : new Map([...getApp().listFilters].filter(([key]) => !dropped.has(accountOfMailbox(key) ?? -1)));
  if (listFilters.size !== getApp().listFilters.size) setApp({ listFilters });
  if (last) remove("localStorage", LIST_FILTER_KEY);
  else saveListFilters(listFilters);
  remove("localStorage", LEGACY_KEY);
  // People's filter: its accounts
  const people = usePeople.getState().filter;
  const filter = last ? NO_PEOPLE_FILTER : { ...people, accounts: people.accounts.filter((id) => !dropped.has(id)) };
  usePeople.setState({ filter });
  savePeopleFilter(filter);
  // the palette's usage: commands that name the account
  forgetUsage((id) => last || dropped.has(accountOfCommand(id) ?? -1));
  if (!last) return;
  // learned-rule offers seen (sender addresses and domains) and this launch's hush
  forgetSeenOffers();
  // the sidebar's open and focused account
  remove("localStorage", "terno:sidebar-account");
  remove("localStorage", "terno:sidebar-solo");
}
