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

/**
 * Reconciles this window's storage with the accounts that exist (the backend's list, at boot and on every accounts
 * event): what names an account that's gone goes; with no account at all, every mail-derived key goes too. Run against
 * the authoritative list, a reload after a removal, a removal from another window, or two removals at once can't skip
 * it (Codex code review #7). Idempotent and cheap: a few small keys.
 */
export function reconcileAccountsUi(accounts: readonly { id: number }[]): void {
  const present = new Set(accounts.map((a) => a.id));
  const last = present.size === 0;
  const gone = (id: number | null) => id !== null && !present.has(id);
  // the list filters: an account's mailboxes (all of them, with no account left)
  const was = getApp().listFilters;
  const listFilters = last ? new Map() : new Map([...was].filter(([key]) => !gone(accountOfMailbox(key))));
  if (listFilters.size !== was.size) {
    setApp({ listFilters });
    if (last) remove("localStorage", LIST_FILTER_KEY);
    else saveListFilters(listFilters);
  }
  remove("localStorage", LEGACY_KEY);
  // People's filter: its accounts
  const people = usePeople.getState().filter;
  const accountsKept = last ? [] : people.accounts.filter((id) => !gone(id));
  if (accountsKept.length !== people.accounts.length) {
    const filter = last ? NO_PEOPLE_FILTER : { ...people, accounts: accountsKept };
    usePeople.setState({ filter });
    savePeopleFilter(filter);
  }
  // the palette's usage: commands that name an account that's gone (all of it, with no account left)
  forgetUsage((id) => last || gone(accountOfCommand(id)));
  if (!last) return;
  // learned-rule offers seen (sender addresses and domains) and this launch's hush
  forgetSeenOffers();
  // the sidebar's open and focused account
  remove("localStorage", "terno:sidebar-account");
  remove("localStorage", "terno:sidebar-solo");
}
