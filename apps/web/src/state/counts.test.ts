import type { Counts } from "@terno/core";
import { describe, expect, it } from "vitest";
import { EMPTY_COUNTS, sameCounts } from "./app";

const full: Counts = {
  inboxUnread: 3,
  inboxUnreadByAccount: { 1: 2, 2: 1 },
  categoryUnread: { 4: 1 },
  categoryTotal: { 4: 9 },
  categorySuggestions: { 4: 2 },
  inboxWaiting: 1,
  inboxWaitingByAccount: { 1: 1 },
  today: 5,
  folderUnread: { "1:Work": 3 },
  tabUnread: { "1:promotions": 7 },
  viewUnread: { "1:spam": 0 },
};

describe("sameCounts (plan 234)", () => {
  it("equal numbers are the same, whatever the objects or the keys' order", () => {
    expect(sameCounts(full, structuredClone(full))).toBe(true);
    expect(sameCounts({ ...full, inboxUnreadByAccount: { 2: 1, 1: 2 } }, full)).toBe(true);
    expect(sameCounts(EMPTY_COUNTS, { ...EMPTY_COUNTS })).toBe(true);
  });

  it("any one field that moves makes them differ", () => {
    for (const key of Object.keys(full) as (keyof Counts)[]) {
      const v = full[key];
      const moved = typeof v === "number" ? v + 1 : { ...(v as Record<string, number>), 99: 1 };
      expect(sameCounts(full, { ...full, [key]: moved }), key).toBe(false);
      expect(sameCounts({ ...full, [key]: moved }, full), key).toBe(false);
    }
  });

  it("a value changed in a record, a key gone, absent against null and null against 0 all differ", () => {
    expect(sameCounts(full, { ...full, categoryUnread: { 4: 2 } })).toBe(false);
    expect(sameCounts(full, { ...full, categoryUnread: {} })).toBe(false);
    expect(sameCounts(full, { ...full, categoryUnread: { 5: 1 } })).toBe(false);
    const { today: _, ...noToday } = full;
    expect(sameCounts(full, noToday)).toBe(false);
    expect(sameCounts({ ...full, today: null }, noToday)).toBe(false);
    expect(sameCounts({ ...full, today: null }, { ...full, today: 0 })).toBe(false);
    expect(sameCounts({ ...full, inboxWaitingByAccount: undefined }, { ...full, inboxWaitingByAccount: {} })).toBe(false);
  });
});
