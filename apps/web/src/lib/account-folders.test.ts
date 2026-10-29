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

const { folderName, folderRows, goToAccount, goToFolder, reconcileAccounts, setOpenAccount, toggleAccount, useOpenAccount } = await import("./account-folders");
const { getApp, navigate, setApp, setFolders } = await import("~/state/app");
const { currentScope, listKey } = await import("~/state/list");

const at = (o: Partial<ReturnType<typeof getApp>>) => setApp({ view: "inbox", accountId: null, categoryId: null, reviewCategoryId: null, folder: null, folders: [], query: "", listFilters: new Map(), selectedId: null, checked: new Set(), scope: null, readerOpen: false, ...o });
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
    toggleAccount(2);
    expect(where()).toEqual({ view: "all", accountId: 2, categoryId: 5 });
  });

  it("the palette's account command always lands in its Inbox, even from inside it (Codex R1)", () => {
    setOpenAccount(2);
    at({ view: "sent", accountId: 2, query: "factura" });
    goToAccount(2);
    expect(where()).toEqual({ view: "inbox", accountId: 2, categoryId: null });
    expect(getApp().query).toBe("");
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

describe("an account's own folders (plan 65)", () => {
  const f = (accountId: number, key: string, path: string[], selectable = true) => ({ accountId, key, path, selectable });

  it("rows nest by path in listed order; a parent that isn't listed is drawn once, not a place to go", () => {
    const folders = [f(2, "Label_1", ["Work"]), f(2, "Label_3", ["Work", "Clients"]), f(2, "Label_9", ["Travel", "2026"]), f(2, "Label_10", ["Travel", "2027"]), f(3, "X", ["Other"]), f(2, "Lists", ["Lists"], false), f(2, "Lists/News", ["Lists", "News"])];
    expect(folderRows(folders, 2).map(({ id: _id, ...r }) => r)).toEqual([
      { key: "Lists", name: "Lists", depth: 0, selectable: false },
      { key: "Lists/News", name: "News", depth: 1, selectable: true },
      { key: null, name: "Travel", depth: 0, selectable: false },
      { key: "Label_9", name: "2026", depth: 1, selectable: true },
      { key: "Label_10", name: "2027", depth: 1, selectable: true },
      { key: "Label_1", name: "Work", depth: 0, selectable: true },
      { key: "Label_3", name: "Clients", depth: 1, selectable: true },
    ]);
  });

  it("Codex R6: every row has its own identity, also parents drawn twice under different ones (A/X/Y, B/X/Z)", () => {
    const rows = folderRows([f(2, "Label_1", ["A", "X", "Y"]), f(2, "Label_2", ["B", "X", "Z"])], 2);
    expect(rows.filter((r) => r.name === "X")).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it("Codex R4: two folders whose shortened names match are both rows, both places to go", () => {
    const name = "x".repeat(225);
    const rows = folderRows([f(2, `${name}a`, [name]), f(2, `${name}b`, [name])], 2);
    expect(rows.map((r) => r.key).sort()).toEqual([`${name}a`, `${name}b`]);
    expect(rows.every((r) => r.selectable)).toBe(true);
  });

  it("a folder sits under its own parent whatever order they come in (Codex R1: A, AA, A/Z)", () => {
    const rows = folderRows([f(2, "A", ["A"]), f(2, "AA", ["AA"]), f(2, "A/Z", ["A", "Z"])], 2);
    expect(rows.map((r) => [r.name, r.depth])).toEqual([["A", 0], ["Z", 1], ["AA", 0]]);
  });

  it("going to a folder: its account's, alone (no category, no review), its view all; anywhere else leaves it", () => {
    at({ view: "sent", accountId: 1, categoryId: 4, reviewCategoryId: 5 });
    navigate({ accountId: 2, folder: "Label_1" });
    expect(where()).toEqual({ view: "all", accountId: 2, categoryId: null });
    expect([getApp().folder, getApp().reviewCategoryId]).toEqual(["Label_1", null]);
    goToFolder("inbox");
    expect(where()).toEqual({ view: "inbox", accountId: 2, categoryId: null });
    expect(getApp().folder).toBeNull();
  });

  it("its name is the folder's last step; the list key carries it before the query, only when there is one", () => {
    const folders = [f(2, "Label_3", ["Work", "Clients"])];
    at({ view: "all", accountId: 2, folder: "Label_3", folders });
    expect(folderName(getApp())).toBe("Clients");
    expect(JSON.parse(listKey())).toEqual(["all", 2, null, null, null, "Label_3", ""]);
    at({ view: "inbox" });
    expect(JSON.parse(listKey())).toEqual(["inbox", null, null, null, null, ""]);
  });

  it("the list's scope is the folder; a search from it searches its account, not the folder (Codex R8)", () => {
    at({ view: "all", accountId: 2, folder: "Label_3" });
    expect(currentScope()).toEqual({ kind: "view", view: "all", accountId: 2, folder: "Label_3" });
    setApp({ query: "factura" });
    expect(currentScope()).toEqual({ kind: "search", query: "factura", accountId: 2 });
    // clearing the search is the folder again
    setApp({ query: "" });
    expect(currentScope()).toMatchObject({ folder: "Label_3" });
  });

  it("a folder you're in that's gone sends you to its account's Inbox; one still listed keeps you", () => {
    at({ view: "all", accountId: 2, folder: "Label_3" });
    setFolders([f(2, "Label_3", ["Work"])]);
    expect(getApp().folder).toBe("Label_3");
    setFolders([f(2, "Label_1", ["Other"])]);
    expect(where()).toEqual({ view: "inbox", accountId: 2, categoryId: null });
    expect(getApp().folder).toBeNull();
  });

  it("Codex R2: a write that leaves the folder's scope (a search across accounts, a tab back to the Inbox) leaves the folder", () => {
    at({ view: "all", accountId: 2, folder: "Label_3" });
    // the category snackbar's "View": all accounts, a search
    setApp({ query: "factura", view: "all", categoryId: null, accountId: null, reviewCategoryId: null });
    expect(getApp().folder).toBeNull();
    at({ view: "all", accountId: 2, folder: "Label_3" });
    setApp({ view: "inbox" });
    expect(getApp().folder).toBeNull();
    at({ view: "all", accountId: 2, folder: "Label_3" });
    setApp({ selectedId: 5 });
    expect(getApp().folder).toBe("Label_3");
  });

  it("an account's row counts a folder as inside it: it opens without moving you", () => {
    setOpenAccount(null);
    at({ view: "all", accountId: 2, folder: "Label_3" });
    toggleAccount(2);
    expect(getApp().folder).toBe("Label_3");
  });
});
