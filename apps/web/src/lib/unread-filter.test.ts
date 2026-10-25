import { describe, expect, it } from "vitest";
import { flipped, isUnreadOnly, loadUnreadFilters, mailboxKey, MAX_KEYS, parseStored, saveUnreadFilters, STORAGE_KEY } from "./unread-filter";

const inbox = { view: "inbox" as const, accountId: null, categoryId: null, reviewCategoryId: null };

describe("the unread filter's state", () => {
  it("is per mailbox: view, account and category", () => {
    expect(mailboxKey(inbox)).toBe("inbox||");
    expect(mailboxKey({ ...inbox, accountId: 2 })).toBe("inbox|2|");
    expect(mailboxKey({ ...inbox, view: "all", categoryId: 7 })).toBe("all||7");
    const on = new Set(["inbox||"]);
    expect(isUnreadOnly({ ...inbox, unreadFilters: on })).toBe(true);
    expect(isUnreadOnly({ ...inbox, accountId: 2, unreadFilters: on })).toBe(false);
    expect(isUnreadOnly({ ...inbox, view: "archive", unreadFilters: on })).toBe(false);
    // "Revisar" is a fixed list of suggestions: never filtered
    expect(isUnreadOnly({ ...inbox, view: "all", categoryId: 7, reviewCategoryId: 7, unreadFilters: new Set(["all||7"]) })).toBe(false);
  });

  it("flips a key, newest last, keeping at most MAX_KEYS", () => {
    expect([...flipped(new Set(["a", "b"]), "a")]).toEqual(["b"]);
    expect([...flipped(new Set(["a"]), "b")]).toEqual(["a", "b"]);
    const many = new Set(Array.from({ length: MAX_KEYS }, (_, i) => `k${i}`));
    const next = flipped(many, "new");
    expect(next.size).toBe(MAX_KEYS);
    expect(next.has("k0")).toBe(false);
    expect(next.has("new")).toBe(true);
  });

  it("reads only what it wrote: bad JSON, other shapes and failing storage mean nothing is on", () => {
    expect(parseStored(null)).toEqual(new Set());
    expect(parseStored("{")).toEqual(new Set());
    expect(parseStored('{"inbox||":true}')).toEqual(new Set());
    expect(parseStored(JSON.stringify(["inbox||", 3, null, "", "x".repeat(65), "all||7"]))).toEqual(new Set(["inbox||", "all||7"]));
    expect(loadUnreadFilters({ getItem: () => { throw new Error("SecurityError"); } })).toEqual(new Set());
    expect(() => saveUnreadFilters(new Set(["a"]), { setItem: () => { throw new Error("QuotaExceededError"); } })).not.toThrow();
  });

  it("round-trips through storage", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveUnreadFilters(new Set(["inbox||", "all||7"]), storage);
    expect(store.get(STORAGE_KEY)).toBe('["inbox||","all||7"]');
    expect(loadUnreadFilters(storage)).toEqual(new Set(["inbox||", "all||7"]));
  });
});
