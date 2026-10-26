import { describe, expect, it } from "vitest";
import { isListFilter, LIST_FILTERS, listFilterOf, matchesFilter, searchWithFilter, withListFilter } from "./list-filter";
import { WAITING_WINDOW_MS } from "./people";

describe("quick filters (plan 15)", () => {
  it("unreadOnly is plan 12's name for the unread filter; an explicit filter wins", () => {
    expect(listFilterOf({})).toBeUndefined();
    expect(listFilterOf({ unreadOnly: true })).toBe("unread");
    expect(listFilterOf({ unreadOnly: false })).toBeUndefined();
    expect(listFilterOf({ unreadOnly: true, filter: "starred" })).toBe("starred");
    expect(LIST_FILTERS.every(isListFilter)).toBe(true);
    expect(isListFilter("people")).toBe(true);
    expect(isListFilter("waiting")).toBe(true);
    expect(isListFilter("friends")).toBe(false);
  });

  it("one predicate for every filter", () => {
    const t = { unread: true, starred: false, hasAttachments: true };
    expect(matchesFilter(undefined, t)).toBe(true);
    expect(matchesFilter("unread", t)).toBe(true);
    expect(matchesFilter("starred", t)).toBe(false);
    expect(matchesFilter("attachments", t)).toBe(true);
  });

  it("people and waiting (plan 17): an older backend's summaries, without facts, match neither; waiting holds inside the window", () => {
    const now = 100 * 86_400_000;
    const t = { unread: false, starred: false, hasAttachments: false };
    expect(matchesFilter("people", t, now)).toBe(false);
    expect(matchesFilter("waiting", t, now)).toBe(false);
    expect(matchesFilter("people", { ...t, person: true }, now)).toBe(true);
    expect(matchesFilter("waiting", { ...t, waitingSince: null }, now)).toBe(false);
    expect(matchesFilter("waiting", { ...t, waitingSince: now - WAITING_WINDOW_MS }, now)).toBe(true);
    expect(matchesFilter("waiting", { ...t, waitingSince: now - WAITING_WINDOW_MS - 1 }, now)).toBe(false);
  });

  it("a filtered search puts the filter's operator first; asking for its opposite matches nothing", () => {
    expect(withListFilter("factura", "unread")).toBe("is:unread factura");
    // per conversation, not per message: the query stays and every engine keeps the threads with attachments
    expect(searchWithFilter("factura", "attachments")).toEqual({ query: "factura", threadFilter: "attachments" });
    expect(searchWithFilter("factura", "people")).toEqual({ query: "factura", threadFilter: "people" });
    expect(searchWithFilter("is:read factura", "waiting")).toEqual({ query: "is:read factura", threadFilter: "waiting" });
    expect(withListFilter("factura", "starred")).toBe("is:starred factura");
    expect(withListFilter("is:read factura", "unread")).toBeNull();
    expect(withListFilter("-has:adjunto", "attachments")).toBeNull();
    expect(withListFilter("-is:starred x", "starred")).toBeNull();
  });
});
