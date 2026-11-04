import { setLocale } from "@terno/i18n";
import en from "@terno/i18n/locales/en";
import { describe, expect, it } from "vitest";
import { factsOf, keptNote, leavesList, parseFolderRef, refusesFolder, sourceFolder, staysInInbox } from "./folder-rules";

setLocale("en", en);

const CATEGORIES = [
  { id: 1, name: "Facturas", showInInbox: true },
  { id: 2, name: "LinkedIn", showInInbox: false },
];
const row = (categoryIds: number[], inInbox = true) => ({ inInbox, categoryIds });

describe("plan 127: what a drop on a folder does to the rows on screen", () => {
  it("a key may hold a colon", () => {
    expect(parseFolderRef("3:Work:2026/Q1")).toEqual({ accountId: 3, key: "Work:2026/Q1" });
  });

  it("stays in the Inbox: in a shown category, in none hidden (hidden wins)", () => {
    expect(staysInInbox(row([1]), CATEGORIES)).toBe(true);
    expect(staysInInbox(row([]), CATEGORIES)).toBe(false);
    expect(staysInInbox(row([2]), CATEGORIES)).toBe(false);
    expect(staysInInbox(row([1, 2]), CATEGORIES)).toBe(false);
    expect(staysInInbox(row([1], false), CATEGORIES)).toBe(false);
  });

  it("which rows leave the list, by what's on screen", () => {
    const list = (s: Partial<{ query: string; folder: string | null; view: string }>, r = row([])) => leavesList({ query: "", folder: null, view: "inbox", ...s }, r, CATEGORIES, "B");
    expect(list({})).toBe(true);
    expect(list({}, row([1]))).toBe(false);
    expect(list({ query: "uber" })).toBe(false);
    expect(list({ folder: "A", view: "all" })).toBe(true);
    // in a folder, the thread leaves it even if a category keeps it in the Inbox
    expect(list({ folder: "A", view: "all" }, row([1]))).toBe(true);
    expect(list({ folder: "B", view: "all" })).toBe(false);
    for (const view of ["all", "archive", "sent", "starred"]) expect(list({ view })).toBe(false);
  });

  it("the folder you're in is what it leaves, only if it's this account's and not the target", () => {
    expect(sourceFolder({ accountId: 3, folder: "A" }, { accountId: 3, key: "B" })).toBe("A");
    expect(sourceFolder({ accountId: 3, folder: "B" }, { accountId: 3, key: "B" })).toBe(null);
    expect(sourceFolder({ accountId: 4, folder: "A" }, { accountId: 3, key: "B" })).toBe(null);
    expect(sourceFolder({ accountId: 3, folder: null }, { accountId: 3, key: "B" })).toBe(null);
  });

  it("refuses rows of another account, of several, and anything in Trash or Spam", () => {
    const r = (accountId: number, o: { inTrash?: boolean; inSpam?: boolean } = {}) => ({ accountId, inTrash: false, inSpam: false, ...o });
    expect(refusesFolder(factsOf([r(3), r(3)]), 3)).toBe(false);
    expect(refusesFolder(factsOf([r(3)]), 4)).toBe(true);
    expect(refusesFolder(factsOf([r(3), r(4)]), 3)).toBe(true);
    expect(refusesFolder(factsOf([r(3, { inTrash: true })]), 3)).toBe(true);
    expect(refusesFolder(factsOf([r(3, { inSpam: true })]), 3)).toBe(true);
    expect(refusesFolder(factsOf([]), 3)).toBe(true);
  });

  it("the note names the category when one thread stayed", () => {
    expect(keptNote(0, [row([1])], CATEGORIES)).toBeUndefined();
    expect(keptNote(1, [row([]), row([1])], CATEGORIES)).toContain("Facturas");
    expect(keptNote(2, [row([1]), row([1])], CATEGORIES)).not.toContain("Facturas");
  });
});
