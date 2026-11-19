import { describe, expect, it } from "vitest";
import { badgeCount } from "./attention";
import { leadScreen } from "./first-screen";

describe("plan 207: the first screen", () => {
  it("What matters leads only when chosen and shown; never asked is the Inbox", () => {
    expect(leadScreen("whatMatters", true)).toBe("whatMatters");
    expect(leadScreen("whatMatters", false)).toBe("inbox");
    expect(leadScreen("inbox", true)).toBe("inbox");
    expect(leadScreen(null, true)).toBe("inbox");
    expect(leadScreen(undefined, true)).toBe("inbox");
  });
});

describe("plan 207: the badge's one number", () => {
  const counts = (today?: number | null) => ({ inboxUnread: 12, ...(today !== undefined && { today }) });
  it("the Inbox's unread, unless What matters opens first", () => {
    expect(badgeCount(true, "inbox", counts(3), 0)).toBe(12);
    expect(badgeCount(true, null, counts(3), 0)).toBe(12);
    expect(badgeCount(true, "whatMatters", counts(3), 0)).toBe(3);
    expect(badgeCount(true, "whatMatters", counts(0), 5)).toBe(0);
  });
  it("What matters not shown (no `today`): the Inbox's", () => {
    expect(badgeCount(true, "whatMatters", counts(), 3)).toBe(12);
  });
  it("its number still coming (backfill): the last one stays, never the Inbox's", () => {
    expect(badgeCount(true, "whatMatters", counts(null), 4)).toBe(4);
  });
  it("off: nothing", () => {
    expect(badgeCount(false, "whatMatters", counts(3), 4)).toBe(0);
    expect(badgeCount(false, "inbox", counts(3), 4)).toBe(0);
  });
});
