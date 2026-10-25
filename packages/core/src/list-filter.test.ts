import { describe, expect, it } from "vitest";
import { isListFilter, LIST_FILTERS, listFilterOf, matchesFilter, searchWithFilter, withListFilter } from "./list-filter";

describe("quick filters (plan 15)", () => {
  it("unreadOnly is plan 12's name for the unread filter; an explicit filter wins", () => {
    expect(listFilterOf({})).toBeUndefined();
    expect(listFilterOf({ unreadOnly: true })).toBe("unread");
    expect(listFilterOf({ unreadOnly: false })).toBeUndefined();
    expect(listFilterOf({ unreadOnly: true, filter: "starred" })).toBe("starred");
    expect(LIST_FILTERS.every(isListFilter)).toBe(true);
    expect(isListFilter("people")).toBe(false);
  });

  it("one predicate for every filter", () => {
    const t = { unread: true, starred: false, hasAttachments: true };
    expect(matchesFilter(undefined, t)).toBe(true);
    expect(matchesFilter("unread", t)).toBe(true);
    expect(matchesFilter("starred", t)).toBe(false);
    expect(matchesFilter("attachments", t)).toBe(true);
  });

  it("a filtered search puts the filter's operator first; asking for its opposite matches nothing", () => {
    expect(withListFilter("factura", "unread")).toBe("is:unread factura");
    // per conversation, not per message: the query stays and the caller keeps the threads with attachments
    expect(searchWithFilter("factura", "attachments")).toEqual({ query: "factura", threadLevel: true });
    expect(withListFilter("factura", "starred")).toBe("is:starred factura");
    expect(withListFilter("is:read factura", "unread")).toBeNull();
    expect(withListFilter("-has:adjunto", "attachments")).toBeNull();
    expect(withListFilter("-is:starred x", "starred")).toBeNull();
  });
});
