// @vitest-environment jsdom
/**
 * Plan 293 (CASA 6.6.1): removing an account drops what this window kept of it in browser storage, memory included;
 * removing the last one leaves only preferences.
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { connectionVersion: 1, call: () => new Promise(() => {}), on: () => () => {} } }));
window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { getApp, setApp } = await import("~/state/app");
const { usePeople } = await import("~/state/people");
const { useOffer } = await import("./learned");
const { reconcileAccountsUi } = await import("./account-ui-storage");

const PREFERENCES = { "terno:appearance": '{"v":2}', "terno:language": "es", "terno:panes": '{"v":1}', "terno:first-run": "done", "terno:sidebar-more": "open" };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const [k, v] of Object.entries(PREFERENCES)) localStorage.setItem(k, v);
  const listFilters = new Map([["inbox|1|", "unread"], ["folder|1||Clientes/ACME", "attachments"], ["inbox|2|", "starred"], ["inbox|||", "unread"]] as const);
  setApp({ listFilters });
  localStorage.setItem("terno:list-filter", JSON.stringify([...listFilters]));
  localStorage.setItem("terno:unread-filter", '["inbox|1|"]');
  usePeople.setState({ filter: { within: null, range: null, accounts: [1, 2] } });
  localStorage.setItem("terno:people-filter", JSON.stringify({ within: null, range: null, accounts: [1, 2] }));
  localStorage.setItem("terno:palette-usage", JSON.stringify([["account:1", 3, 1], ["focus:1", 1, 1], ["tab:1:promotions", 1, 1], ["account:2", 2, 1], ["view:inbox", 9, 1]]));
  useOffer.setState({ seen: new Set(["sender:ana@example.com:archive"]), hushed: true });
  localStorage.setItem("terno:learned-seen", '["sender:ana@example.com:archive","domain:acme.com:archive"]');
  sessionStorage.setItem("terno:learned-hushed", "1");
});

it("removing one account drops its list filters (and its folder names), its People choice and its palette entries; the others' stay", () => {
  reconcileAccountsUi([{ id: 2 }]);
  expect([...getApp().listFilters.keys()]).toEqual(["inbox|2|", "inbox|||"]);
  expect(JSON.parse(localStorage.getItem("terno:list-filter")!)).toEqual([["inbox|2|", "starred"], ["inbox|||", "unread"]]);
  expect(localStorage.getItem("terno:list-filter")).not.toContain("ACME");
  expect(localStorage.getItem("terno:unread-filter")).toBeNull();
  expect(usePeople.getState().filter.accounts).toEqual([2]);
  expect(JSON.parse(localStorage.getItem("terno:people-filter")!).accounts).toEqual([2]);
  expect(JSON.parse(localStorage.getItem("terno:palette-usage")!).map((r: unknown[]) => r[0])).toEqual(["account:2", "view:inbox"]);
  // what isn't any one account's stays while others remain
  expect(localStorage.getItem("terno:learned-seen")).not.toBeNull();
});

it("the accounts that exist are what counts: run again, or with every account still there, nothing more goes", () => {
  reconcileAccountsUi([{ id: 1 }, { id: 2 }]);
  expect(getApp().listFilters.size).toBe(4);
  expect(usePeople.getState().filter.accounts).toEqual([1, 2]);
  reconcileAccountsUi([{ id: 2 }]);
  const after = { ...localStorage };
  reconcileAccountsUi([{ id: 2 }]);
  expect({ ...localStorage }).toEqual(after);
});

it("removing the last account leaves only preferences, in storage and in memory", () => {
  reconcileAccountsUi([]);
  const keys = Object.keys(localStorage).sort();
  expect(keys).toEqual(Object.keys(PREFERENCES).sort());
  expect(Object.keys(sessionStorage)).toEqual([]);
  expect(getApp().listFilters.size).toBe(0);
  expect(usePeople.getState().filter.accounts).toEqual([]);
  expect(useOffer.getState().seen.size).toBe(0);
  expect(useOffer.getState().hushed).toBe(false);
});
