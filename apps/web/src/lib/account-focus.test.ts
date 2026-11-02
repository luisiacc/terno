// @vitest-environment jsdom
/**
 * Plan 108: focus on one account. It lasts while you're in that account (every way out ends it in the same write),
 * shortcuts stay in it, a search looks only in it, and it's remembered on this device.
 */
import type { Account } from "@terno/core";
import { beforeEach, expect, it, vi } from "vitest";

const calls: { method: string; params: Record<string, unknown> }[] = [];
vi.mock("~/rpc/connection", () => ({
  client: {
    connectionVersion: 1,
    call: (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return new Promise(() => {});
    },
    on: () => () => {},
  },
}));

window.matchMedia = (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;

const { getApp, navigate, setApp } = await import("~/state/app");
const { currentScope, listKey } = await import("~/state/list");
const { focusAccount, goToFolder, leaveFocus, rememberFocus, restoredFocus } = await import("./account-folders");

const account = (id: number) => ({ id }) as Account;
const KEY = "terno:sidebar-solo";
const stopRemembering = rememberFocus();

beforeEach(() => {
  setApp({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, folder: null, gmailTab: null, reminders: false, query: "", soloAccountId: null, folders: [] });
  localStorage.clear();
  calls.length = 0;
});

it("focusing lands on the account's Inbox; already in one of its places, you stay", () => {
  focusAccount(2);
  expect(getApp()).toMatchObject({ soloAccountId: 2, accountId: 2, view: "inbox" });
  setApp({ soloAccountId: null });
  navigate({ accountId: 3, view: "starred" });
  focusAccount(3);
  expect(getApp()).toMatchObject({ soloAccountId: 3, accountId: 3, view: "starred" });
  setApp({ soloAccountId: null });
  navigate({ accountId: 3, folder: "Work" });
  focusAccount(3);
  expect(getApp()).toMatchObject({ soloAccountId: 3, accountId: 3, folder: "Work" });
});

it("anything that leaves the account ends focus in the same write; places inside it don't", () => {
  focusAccount(2);
  navigate({ view: "sent" });
  navigate({ accountId: 2, folder: "Work" });
  navigate({ accountId: 2, gmailTab: "promotions" });
  navigate({ categoryId: 7 });
  expect(getApp()).toMatchObject({ soloAccountId: 2, accountId: 2, categoryId: 7 });

  for (const out of [{ accountId: 3 }, { view: "inbox" as const, accountId: null }, { reminders: true }, { categoryId: 7, accountId: null }, { view: "all" as const, reviewCategoryId: 7, accountId: null }]) {
    focusAccount(2);
    navigate(out);
    expect(getApp().soloAccountId).toBeNull();
  }
});

it("the back arrow is the all-accounts Inbox", () => {
  focusAccount(2);
  navigate({ view: "archive" });
  leaveFocus();
  expect(getApp()).toMatchObject({ soloAccountId: null, accountId: null, view: "inbox" });
});

it("shortcuts stay in the focused account, Starred and All Mail too", () => {
  navigate({ accountId: 2, view: "inbox" });
  goToFolder("starred");
  // not focused: Starred is cross-account (plan 67)
  expect(getApp().accountId).toBeNull();
  focusAccount(2);
  goToFolder("starred");
  expect(getApp()).toMatchObject({ soloAccountId: 2, accountId: 2, view: "starred" });
  goToFolder("all");
  expect(getApp()).toMatchObject({ soloAccountId: 2, accountId: 2, view: "all" });
});

it("a search looks only in the focused account; widening it reloads everywhere", () => {
  focusAccount(2);
  setApp({ query: "factura" });
  expect(currentScope()).toMatchObject({ kind: "search", query: "factura", accountId: 2 });
  const focused = listKey();
  calls.length = 0;
  setApp({ soloAccountId: null });
  expect(currentScope()).toEqual({ kind: "search", query: "factura" });
  expect(listKey()).not.toBe(focused);
  // the list asked again, everywhere
  expect(calls.filter((c) => c.method === "threads.search").map((c) => c.params.accountId)).toEqual([undefined]);
});

it("not focused, a search looks everywhere whatever account you're in (plan 64)", () => {
  navigate({ accountId: 2, view: "inbox" });
  setApp({ query: "factura" });
  expect(currentScope()).toEqual({ kind: "search", query: "factura" });
});

it("remembered however it ends, and restored only for an account still there among several", () => {
  focusAccount(2);
  expect(localStorage.getItem(KEY)).toBe("2");
  navigate({ reminders: true });
  expect(localStorage.getItem(KEY)).toBeNull();

  focusAccount(2);
  expect(restoredFocus([account(1), account(2)])).toEqual({ soloAccountId: 2, accountId: 2, view: "inbox" });
  // its account removed, or the only one left: forgotten
  expect(restoredFocus([account(1), account(3)])).toEqual({});
  expect(localStorage.getItem(KEY)).toBeNull();
  localStorage.setItem(KEY, "2");
  expect(restoredFocus([account(2)])).toEqual({});
  expect(localStorage.getItem(KEY)).toBeNull();
  stopRemembering();
});
