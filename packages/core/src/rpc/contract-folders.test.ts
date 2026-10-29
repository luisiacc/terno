/**
 * Plan 68 (Codex R9): a folder is its account's, alone: the list and every scope refuse it without its account,
 * with a category, or with a view other than All Mail.
 */
import { describe, expect, it } from "vitest";
import { contract } from "./contract";

describe("folders at the RPC boundary", () => {
  const list = contract["threads.list"].params;
  const scope = contract["threads.scopeCount"].params;

  it("a folder with its account, view all: accepted, in the list and in a scope", () => {
    expect(list.safeParse({ view: "all", accountId: 2, folder: "Label_1" }).success).toBe(true);
    expect(scope.safeParse({ scope: { kind: "view", view: "all", accountId: 2, folder: "Work/Clients" } }).success).toBe(true);
  });

  it("refused without its account, with a category, or in another view", () => {
    for (const bad of [{ view: "all", folder: "Label_1" }, { view: "all", accountId: 2, categoryId: 3, folder: "Label_1" }, { view: "inbox", accountId: 2, folder: "Label_1" }]) {
      expect(list.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(scope.safeParse({ scope: { kind: "view", ...bad } }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("a key is bounded", () => {
    expect(list.safeParse({ view: "all", accountId: 2, folder: "" }).success).toBe(false);
    expect(list.safeParse({ view: "all", accountId: 2, folder: "x".repeat(1001) }).success).toBe(false);
  });
});
