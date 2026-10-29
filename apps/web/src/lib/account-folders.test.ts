/**
 * Plan 64: the top of the sidebar is all your mail, what's under an account is that account's. The scope rules
 * of shortcuts, the palette and an account's row, and the open account. Node, the RPC client mocked.
 */
import type { Account } from "@terno/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const store = new Map<string, string>([["terno:sidebar-account", "7"]]);
  g.localStorage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null, removeItem: (k: string) => void store.delete(k) };
  g.requestAnimationFrame = () => 0;
  return { store };
});

vi.mock("~/rpc/connection", () => ({ client: { call: () => Promise.resolve({ items: [], nextCursor: null }), on: () => () => {} } }));

const { goToAccount, goToFolder, reconcileAccounts, setOpenAccount, toggleAccount, useOpenAccount } = await import("./account-folders");
const { getApp, setApp } = await import("~/state/app");

const at = (o: Partial<ReturnType<typeof getApp>>) => setApp({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, query: "", selectedId: null, checked: new Set(), scope: null, readerOpen: false, ...o });
const where = () => {
  const s = getApp();
  return { view: s.view, accountId: s.accountId, categoryId: s.categoryId };
};
const account = (id: number) => ({ id }) as Account;

beforeEach(() => at({}));

describe("the open account", () => {
  it("is read back from this device, and written as it changes", () => {
    expect(useOpenAccount.getState().id).toBe(7);
    setOpenAccount(2);
    expect(fake.store.get("terno:sidebar-account")).toBe("2");
    setOpenAccount(null);
    expect(fake.store.has("terno:sidebar-account")).toBe(false);
  });
});

describe("an account's row", () => {
  it("closed: opens (one at a time) and lands in its Inbox", () => {
    setOpenAccount(1);
    at({ view: "starred" });
    toggleAccount(2);
    expect(useOpenAccount.getState().id).toBe(2);
    expect(where()).toEqual({ view: "inbox", accountId: 2, categoryId: null });
  });

  it("closed while you're already inside it (a folder, a category tab of its Inbox): opens and you stay", () => {
    setOpenAccount(null);
    at({ view: "trash", accountId: 2 });
    toggleAccount(2);
    expect(where()).toEqual({ view: "trash", accountId: 2, categoryId: null });
    setOpenAccount(null);
    at({ view: "all", accountId: 2, categoryId: 5 });
    goToAccount(2);
    expect(where()).toEqual({ view: "all", accountId: 2, categoryId: 5 });
  });

  it("open: closes, and you stay where you are", () => {
    setOpenAccount(2);
    at({ view: "sent", accountId: 2 });
    toggleAccount(2);
    expect(useOpenAccount.getState().id).toBeNull();
    expect(where()).toEqual({ view: "sent", accountId: 2, categoryId: null });
  });
});

describe("shortcuts and the palette", () => {
  it("keep the scope for the folders an account lists", () => {
    at({ view: "sent", accountId: 2 });
    for (const v of ["inbox", "archive", "trash", "spam", "sent"] as const) {
      goToFolder(v);
      expect(where()).toEqual({ view: v, accountId: 2, categoryId: null });
    }
  });

  it("go to all accounts for the cross-account ones (Starred, All Mail)", () => {
    for (const v of ["starred", "all"] as const) {
      at({ view: "sent", accountId: 2 });
      goToFolder(v);
      expect(where()).toEqual({ view: v, accountId: null, categoryId: null });
    }
  });

  it("never change which account is open", () => {
    setOpenAccount(3);
    at({ accountId: 2 });
    goToFolder("sent");
    expect(useOpenAccount.getState().id).toBe(3);
  });
});

describe("accounts that come and go", () => {
  it("an account that's gone stops being open and stops being where you are", () => {
    setOpenAccount(2);
    at({ view: "sent", accountId: 2 });
    reconcileAccounts([account(1), account(3)]);
    expect(useOpenAccount.getState().id).toBeNull();
    expect(where()).toEqual({ view: "inbox", accountId: null, categoryId: null });
  });

  it("an account added, or one still there, changes nothing", () => {
    setOpenAccount(2);
    at({ view: "sent", accountId: 2 });
    reconcileAccounts([account(1), account(2), account(9)]);
    expect(useOpenAccount.getState().id).toBe(2);
    expect(where()).toEqual({ view: "sent", accountId: 2, categoryId: null });
  });
});
