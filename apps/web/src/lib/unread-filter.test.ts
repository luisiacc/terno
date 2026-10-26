import { describe, expect, it } from "vitest";
import { activeFilter, isUnreadOnly, LEGACY_FILTERS, LEGACY_KEY, loadListFilters, mailboxKey, MAX_KEYS, parseLegacy, parseStored, saveListFilters, STORAGE_KEY, supportedFilters, withFilter } from "./unread-filter";

const inbox = { view: "inbox" as const, accountId: null, categoryId: null, reviewCategoryId: null };

describe("the quick filter's state (plan 12's unread filter, generalized in plan 15)", () => {
  it("is per mailbox: view, account and category", () => {
    expect(mailboxKey(inbox)).toBe("inbox||");
    expect(mailboxKey({ ...inbox, accountId: 2 })).toBe("inbox|2|");
    expect(mailboxKey({ ...inbox, view: "all", categoryId: 7 })).toBe("all||7");
    const on = new Map([["inbox||", "unread" as const], ["archive||", "starred" as const]]);
    expect(isUnreadOnly({ ...inbox, listFilters: on })).toBe(true);
    expect(isUnreadOnly({ ...inbox, accountId: 2, listFilters: on })).toBe(false);
    expect(activeFilter({ ...inbox, view: "archive", listFilters: on })).toBe("starred");
    expect(isUnreadOnly({ ...inbox, view: "archive", listFilters: on })).toBe(false);
    // "Revisar" is a fixed list of suggestions: never filtered
    expect(activeFilter({ ...inbox, view: "all", categoryId: 7, reviewCategoryId: 7, listFilters: new Map([["all||7", "unread" as const]]) })).toBeUndefined();
  });

  it("sets or clears a key, newest last, keeping at most MAX_KEYS", () => {
    expect([...withFilter(new Map([["a", "unread"], ["b", "starred"]]), "a", undefined)]).toEqual([["b", "starred"]]);
    expect([...withFilter(new Map([["a", "unread"], ["b", "starred"]]), "a", "attachments")]).toEqual([["b", "starred"], ["a", "attachments"]]);
    const many = new Map(Array.from({ length: MAX_KEYS }, (_, i) => [`k${i}`, "unread" as const]));
    const next = withFilter(many, "new", "starred");
    expect(next.size).toBe(MAX_KEYS);
    expect(next.has("k0")).toBe(false);
    expect(next.get("new")).toBe("starred");
  });

  it("reads only what it wrote: bad JSON, other shapes, unknown filters and failing storage mean nothing is on", () => {
    expect(parseStored(null)).toEqual(new Map());
    expect(parseStored("{")).toEqual(new Map());
    expect(parseStored('{"inbox||":"unread"}')).toEqual(new Map());
    expect(parseStored(JSON.stringify([["inbox||", "unread"], ["x", "friends"], ["", "unread"], ["y".repeat(65), "unread"], ["all||7", "starred"], "z"]))).toEqual(new Map([["inbox||", "unread"], ["all||7", "starred"]]));
    expect(loadListFilters({ getItem: () => { throw new Error("SecurityError"); } })).toEqual(new Map());
    expect(() => saveListFilters(new Map([["a", "unread"]]), { setItem: () => { throw new Error("QuotaExceededError"); } })).not.toThrow();
  });

  it("carries plan 12's unread filters over the first time, then reads its own", () => {
    expect(parseLegacy(JSON.stringify(["inbox||", 3, "all||7"]))).toEqual(new Map([["inbox||", "unread"], ["all||7", "unread"]]));
    const store = new Map<string, string>([[LEGACY_KEY, '["inbox||"]']]);
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(loadListFilters(storage)).toEqual(new Map([["inbox||", "unread"]]));
    saveListFilters(new Map([["inbox||", "attachments"], ["all||7", "starred"]]), storage);
    expect(store.get(STORAGE_KEY)).toBe('[["inbox||","attachments"],["all||7","starred"]]');
    expect(loadListFilters(storage)).toEqual(new Map([["inbox||", "attachments"], ["all||7", "starred"]]));
  });

  it("offers what the backend knows: an older one (no list) knows plan 15's three, and a remembered People reads as none there (Codex R12)", () => {
    expect(supportedFilters(undefined)).toEqual(LEGACY_FILTERS);
    expect(supportedFilters(["starred", "people", "unread", "waiting", "attachments", "future"])).toEqual(["unread", "people", "waiting", "attachments", "starred"]);
    const people = new Map([["inbox||", "people" as const]]);
    expect(activeFilter({ ...inbox, listFilters: people, supportedFilters: supportedFilters(undefined) })).toBeUndefined();
    expect(activeFilter({ ...inbox, listFilters: people, supportedFilters: supportedFilters(["unread", "people"]) })).toBe("people");
  });
});
