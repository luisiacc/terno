// @vitest-environment jsdom
/** Plan 287: People's filter (remembered, what's asked, its words) and People inside a focused account. */
import type { Account, PeopleList } from "@terno/core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
});
const call = vi.fn();
vi.mock("~/rpc/connection", () => ({ client: { call: (...a: unknown[]) => call(...a), on: () => () => {}, onAttach: () => () => {} } }));

const { usePeople } = await import("~/state/people");
const { getApp, navigate, setApp } = await import("~/state/app");
const { askLastEmails, loadPeople, openPeople, peopleFilter, setPeopleFilter, searchPeople, selectPerson } = await import("~/lib/people");
const { accountsLabel, effectivePeopleFilter, filterSummary, loadPeopleFilter, NO_PEOPLE_FILTER, savePeopleFilter, toggleAccount } = await import("~/lib/people-filter");

const account = (id: number, name: string) => ({ id, displayName: name, email: `${name.toLowerCase()}@x.test`, color: "brown" }) as unknown as Account;
const accounts = [account(1, "Home"), account(2, "Work"), account(3, "Club")];
const empty: PeopleList = { open: [], everyone: [], everyoneVersion: 1, index: "ready" };

afterEach(() => {
  call.mockReset();
  usePeople.setState({ list: null, query: "", hits: null, page: null, reading: null, failed: false, pageFailed: null, filter: NO_PEOPLE_FILTER, listScope: "", lastEmails: new Map() });
  navigate({ view: "inbox", accountId: null });
  setApp({ soloAccountId: null, accounts: [] });
});

describe("the filter as set", () => {
  it("is remembered, and anything unreadable is none", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    savePeopleFilter({ within: "month", accounts: [2, 3] }, storage);
    expect(loadPeopleFilter(storage)).toEqual({ within: "month", accounts: [2, 3] });
    savePeopleFilter(NO_PEOPLE_FILTER, storage);
    expect(store.size).toBe(0);
    store.set("terno:people-filter", '{"within":"decade","accounts":[1,"x",-2,1]}');
    expect(loadPeopleFilter(storage)).toEqual({ within: null, accounts: [1] });
    store.set("terno:people-filter", "{nope");
    expect(loadPeopleFilter(storage)).toEqual(NO_PEOPLE_FILTER);
  });

  it("ticking every account is every account; an account gone is left out of what's asked", () => {
    let c = toggleAccount(NO_PEOPLE_FILTER, 2, accounts);
    expect(c.accounts).toEqual([2]);
    c = toggleAccount(c, 3, accounts);
    expect(c.accounts).toEqual([2, 3]);
    expect(toggleAccount(c, 1, accounts).accounts).toEqual([]);
    expect(toggleAccount(c, 2, accounts).accounts).toEqual([3]);
    expect(effectivePeopleFilter({ within: null, accounts: [2, 9] }, accounts, null)).toEqual({ accounts: [2] });
    expect(effectivePeopleFilter({ within: null, accounts: [9] }, accounts, null)).toEqual({});
  });

  it("in a focused account, that account alone (whatever was chosen); the date holds", () => {
    expect(effectivePeopleFilter({ within: "week", accounts: [2, 3] }, accounts, 1)).toEqual({ within: "week", accounts: [1] });
  });

  it("its words: the date, one or two accounts by name, more by their count; a focused account's say only the date", () => {
    expect(accountsLabel([accounts[0]!, accounts[1]!])).toBe("Home, Work");
    expect(accountsLabel(accounts.slice(0, 2).concat(account(4, "Four")))).toBe("3 accounts");
    expect(filterSummary({ within: "quarter", accounts: [2] }, accounts, false)).toBe("Past 3 months, Work");
    expect(filterSummary({ within: null, accounts: [2] }, accounts, true)).toBeNull();
    expect(filterSummary(NO_PEOPLE_FILTER, accounts, false)).toBeNull();
  });
});

describe("People in a focused account (plan 287)", () => {
  it("opens as that account's, keeping the focus; every read asks for it alone", () => {
    setApp({ accounts });
    navigate({ view: "inbox", accountId: 2 });
    setApp({ soloAccountId: 2 });
    openPeople();
    expect(getApp()).toMatchObject({ people: true, accountId: 2, soloAccountId: 2, view: "all" });
    usePeople.setState({ filter: { within: "week", accounts: [3] } });
    expect(peopleFilter()).toEqual({ within: "week", accounts: [2] });
  });

  it("leaving the focus to go somewhere leaves People; ending it without going anywhere keeps People, for every account", () => {
    setApp({ accounts });
    navigate({ view: "inbox", accountId: 2 });
    setApp({ soloAccountId: 2 });
    openPeople();
    setApp({ soloAccountId: null });
    expect(getApp()).toMatchObject({ people: true, accountId: null, soloAccountId: null });
    navigate({ view: "inbox", accountId: 2 });
    setApp({ soloAccountId: 2 });
    openPeople();
    navigate({ view: "inbox", accountId: null });
    expect(getApp()).toMatchObject({ people: false, soloAccountId: null });
    navigate({ view: "inbox", accountId: 2 });
    setApp({ soloAccountId: 2 });
    openPeople();
    // another account: neither the focus nor People holds
    setApp({ accountId: 3 });
    expect(getApp()).toMatchObject({ people: false, soloAccountId: null, accountId: 3 });
  });

  it("People of every account never carries an account", () => {
    navigate({ view: "inbox", accountId: 2 });
    openPeople();
    expect(getApp()).toMatchObject({ people: true, accountId: null });
    setApp({ accountId: 2 });
    expect(getApp().people).toBe(false);
  });
});

describe("a new filter, while reads are on their way (plan 287)", () => {
  it("a list asked in the old scope is dropped as it answers; Everyone's version is asked back only in its own scope", async () => {
    setApp({ accounts });
    openPeople();
    let late!: (l: PeopleList) => void;
    call.mockImplementationOnce(() => new Promise((r) => (late = r)));
    const first = loadPeople();
    call.mockImplementation(async () => ({ ...empty, everyoneVersion: 7 }));
    setPeopleFilter({ within: "month", accounts: [] });
    await vi.waitFor(() => expect(usePeople.getState().list?.everyoneVersion).toBe(7));
    late({ ...empty, everyoneVersion: 3 });
    await first;
    expect(usePeople.getState()).toMatchObject({ list: { everyoneVersion: 7 }, listScope: JSON.stringify({ within: "month" }) });
    expect(call).toHaveBeenCalledWith("people.list", { filter: { within: "month" } });
    // the same scope again: Everyone's version asked back
    await loadPeople();
    expect(call).toHaveBeenLastCalledWith("people.list", { known: 7, filter: { within: "month" } });
  });

  it("a search and the rows' dates from the old scope are dropped; the page is read again in the new one", async () => {
    setApp({ accounts });
    openPeople();
    call.mockImplementation(async (method: string) => (method === "people.person" ? { key: "ana@x.test", email: "ana@x.test", name: "Ana", items: [], conversations: [], more: false } : method === "people.list" ? empty : method === "people.search" ? { hits: [], index: "ready" } : method === "people.lastEmails" ? { last: {} } : null));
    selectPerson("ana@x.test", "ana@x.test");
    let lateHits!: (h: unknown) => void;
    let lateLast!: (h: unknown) => void;
    call.mockImplementationOnce(() => new Promise((r) => (lateHits = r)));
    searchPeople("an");
    call.mockImplementationOnce(() => new Promise((r) => (lateLast = r)));
    askLastEmails([{ key: "bo@x.test", email: "bo@x.test" }]);
    setPeopleFilter({ within: null, accounts: [2] });
    expect(call).toHaveBeenCalledWith("people.person", { email: "ana@x.test", filter: { accounts: [2] } });
    expect(call).toHaveBeenCalledWith("people.search", { query: "an", filter: { accounts: [2] } });
    lateHits({ hits: [{ name: "Old", email: "old@x.test", key: "old@x.test", last: 0, written: true, open: 0 }], index: "ready" });
    lateLast({ last: { "bo@x.test": 42 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(usePeople.getState().hits?.hits.map((h) => h.key) ?? []).not.toContain("old@x.test");
    expect(usePeople.getState().lastEmails.get("bo@x.test")).toBeUndefined();
  });
});
