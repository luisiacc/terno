/**
 * Plan 107: what the folder name field says before asking the server, the folders a name sits beside, and a
 * rename's mapping applied before the new catalog (the list you're in, favorites and the field follow it).
 */
import { readFileSync } from "node:fs";
import type { Folder } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // the page module reads the appearance at import (a document, a window and its media queries)
  const html = { classList: { contains: () => false, toggle() {} }, dataset: {}, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } };
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: html, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, head: { appendChild() {} }, createElement: () => ({}) };
  g.window = globalThis;
  g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  g.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  g.requestAnimationFrame = () => 0;
});
const rpc = vi.hoisted(() => ({ call: (..._args: unknown[]): Promise<unknown> => new Promise(() => {}) }));
vi.mock("~/rpc/connection", () => ({ client: { call: (...args: unknown[]) => rpc.call(...args), on: () => () => {} } }));

const { applyFavoriteFolders, applyFolderRenames, favoritesApplied, nameProblem, setFavorite, siblingsOf, startCreate, startRename, stopEditing, useFolderEdit } = await import("./folders");
const { useOpenAccount } = await import("./account-folders");
const { getApp, setApp } = await import("~/state/app");

const f = (accountId: number, key: string, ...path: string[]): Folder => ({ accountId, key, path, selectable: true });
const FOLDERS = [f(1, "Label_1", "Work"), f(1, "Label_2", "Work", "Clients"), f(1, "Label_3", "Travel"), f(2, "Work", "Work")];

beforeEach(() => setLocale("en", en));

describe("siblingsOf", () => {
  it("the parent's children, or the account's top folders; never another account's or the one renamed", () => {
    expect(siblingsOf(FOLDERS, 1, null).map((x) => x.key)).toEqual(["Label_1", "Label_3"]);
    expect(siblingsOf(FOLDERS, 1, "Label_1").map((x) => x.key)).toEqual(["Label_2"]);
    expect(siblingsOf(FOLDERS, 1, null, "Label_1").map((x) => x.key)).toEqual(["Label_3"]);
    expect(siblingsOf(FOLDERS, 1, "Gone")).toEqual([]);
  });
});

describe("nameProblem", () => {
  const gmail = { kind: "gmail" as const };
  const imap = { kind: "imap" as const };
  it("empty, too long, Gmail's separator, a sibling's name in any case", () => {
    const top = siblingsOf(FOLDERS, 1, null);
    expect(nameProblem("   ", top, gmail)).toBe("Enter a name.");
    expect(nameProblem("x".repeat(300), top, gmail)).toBe("Use 225 characters or fewer.");
    expect(nameProblem("a/b", top, gmail)).toBe("A folder name can’t contain “/”.");
    expect(nameProblem(" work ", top, gmail)).toBe("There’s already a folder called “work” here.");
    expect(nameProblem("Clients", top, gmail)).toBeNull();
  });
  it("IMAP's delimiter is the server's to check", () => {
    expect(nameProblem("a/b", [], imap)).toBeNull();
  });
});

describe("applyFolderRenames", () => {
  beforeEach(() => {
    setApp({ accountId: 2, folder: "Work", view: "all", categoryId: null, reviewCategoryId: null, gmailTab: null, reminders: false, folders: FOLDERS, settings: { favoriteFolders: [{ accountId: 2, folder: "Work", view: null }, { accountId: 1, folder: "Label_1", view: null }] } as never });
    useFolderEdit.setState({ editing: null, done: null });
  });

  it("the folder you're in, your favorites and the field follow an IMAP rename's new key", () => {
    useFolderEdit.setState({ editing: { kind: "create", accountId: 2, parent: "Work", id: 1 }, done: null });
    applyFolderRenames([{ accountId: 2, from: "Work", to: "Jobs" }]);
    expect(getApp().folder).toBe("Jobs");
    expect(getApp().accountId).toBe(2);
    expect(getApp().settings!.favoriteFolders).toEqual([{ accountId: 2, folder: "Jobs", view: null }, { accountId: 1, folder: "Label_1", view: null }]);
    expect(useFolderEdit.getState().editing).toEqual({ kind: "create", accountId: 2, parent: "Jobs", id: 1 });
  });

  it("a Gmail rename (same key) or another account's leaves where you are alone", () => {
    const before = getApp().settings;
    applyFolderRenames([{ accountId: 1, from: "Label_1", to: "Label_1" }, { accountId: 1, from: "Work", to: "Other" }]);
    expect(getApp().folder).toBe("Work");
    expect(getApp().settings).toBe(before);
  });
});

describe("the backend's favorites (Codex code review round 11 #2)", () => {
  beforeEach(() => {
    favoritesApplied.revision = 0;
  });
  it("every window takes the list the backend announces: a delete that failed midway, or one made in another window", () => {
    setApp({ settings: { favoriteFolders: [{ accountId: 2, folder: "Work/Sub", view: null }, { accountId: 1, folder: "Label_1", view: null }, { accountId: 1, folder: null, view: "inbox" }] } as never });
    applyFavoriteFolders({ favorites: [{ accountId: 1, folder: "Label_1", view: null }, { accountId: 1, folder: null, view: "inbox" }], revision: 1 });
    expect(getApp().settings!.favoriteFolders).toEqual([{ accountId: 1, folder: "Label_1", view: null }, { accountId: 1, folder: null, view: "inbox" }]);
  });
  it("a call's answer older than an announcement that came first is dropped (Codex code review round 12 #2)", async () => {
    const a = { accountId: 1, folder: "Label_1", view: null };
    const b = { accountId: 2, folder: "Work", view: null };
    setApp({ settings: { favoriteFolders: [] } as never });
    let answer!: (value: unknown) => void;
    rpc.call = () => new Promise((resolve) => (answer = resolve));
    try {
      // this window favorites A; another window favorites B, announced (revision 11) before A's answer (revision 10)
      const asked = setFavorite({ accountId: 1, folder: "Label_1", view: null }, true);
      applyFavoriteFolders({ favorites: [a, b], revision: 11 });
      answer({ favorites: [a], revision: 10 });
      await asked;
      expect(getApp().settings!.favoriteFolders).toEqual([a, b]);
      // an answer newer than what was announced is applied
      const again = setFavorite({ accountId: 2, folder: "Work", view: null }, false);
      answer({ favorites: [a], revision: 12 });
      await again;
      expect(getApp().settings!.favoriteFolders).toEqual([a]);
    } finally {
      rpc.call = () => new Promise(() => {});
    }
  });
  it("boot listens for it", () => {
    const boot = readFileSync(new URL("./boot.ts", import.meta.url), "utf8");
    expect(boot).toContain('client.on("favoriteFolders", applyFavoriteFolders)');
  });
});

describe("editing", () => {
  it("a slow answer ends only its own edit, never a newer field (Codex code review #3)", () => {
    startCreate(1, null);
    const first = useFolderEdit.getState().editing!.id;
    startRename(1, "Label_3");
    stopEditing(first, { accountId: 1, key: "Label_9" });
    expect(useFolderEdit.getState().editing).toMatchObject({ kind: "rename", key: "Label_3" });
    expect(useFolderEdit.getState().done).toBeNull();
  });

  it("Rename opens its account (from a favorite it may be closed) (Codex code review #4)", () => {
    useOpenAccount.setState({ id: 2 });
    startRename(1, "Label_3");
    expect(useOpenAccount.getState().id).toBe(1);
  });
});

describe("following a rename", () => {
  it("keeps the open thread, the reader and the checked rows; the list's filter moves to the new key (Codex code review #7)", () => {
    setApp({ accountId: 2, folder: "Work", view: "all", query: "", categoryId: null, reviewCategoryId: null, gmailTab: null, reminders: false, selectedId: 7, readerOpen: true, checked: new Set([7, 8]), listFilters: new Map([["all|2||Work", "unread"]]), settings: { favoriteFolders: [] } as never });
    applyFolderRenames([{ accountId: 2, from: "Work", to: "Jobs" }]);
    expect(getApp()).toMatchObject({ folder: "Jobs", selectedId: 7, readerOpen: true });
    expect([...getApp().checked]).toEqual([7, 8]);
    expect([...getApp().listFilters]).toEqual([["all|2||Jobs", "unread"]]);
  });
});
