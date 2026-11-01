/**
 * Plan 107: what the folder name field says before asking the server, the folders a name sits beside, and a
 * rename's mapping applied before the new catalog (the list you're in, favorites and the field follow it).
 */
import type { Folder } from "@terno/core";
import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/rpc/connection", () => ({ client: { call: () => new Promise(() => {}), on: () => () => {} } }));
(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { applyFolderRenames, nameProblem, siblingsOf, useFolderEdit } = await import("./folders");
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
    useFolderEdit.setState({ editing: { kind: "create", accountId: 2, parent: "Work" }, done: null });
    applyFolderRenames([{ accountId: 2, from: "Work", to: "Jobs" }]);
    expect(getApp().folder).toBe("Jobs");
    expect(getApp().accountId).toBe(2);
    expect(getApp().settings!.favoriteFolders).toEqual([{ accountId: 2, folder: "Jobs", view: null }, { accountId: 1, folder: "Label_1", view: null }]);
    expect(useFolderEdit.getState().editing).toEqual({ kind: "create", accountId: 2, parent: "Jobs" });
  });

  it("a Gmail rename (same key) or another account's leaves where you are alone", () => {
    const before = getApp().settings;
    applyFolderRenames([{ accountId: 1, from: "Label_1", to: "Label_1" }, { accountId: 1, from: "Work", to: "Other" }]);
    expect(getApp().folder).toBe("Work");
    expect(getApp().settings).toBe(before);
  });
});
