import { describe, expect, it } from "vitest";
import { CAT_PERSONAL, CAT_PROMOTIONS, CAT_SOCIAL, threadTabState, type TabMessage } from "./tabs";

let next = 1;
const msg = (o: Partial<TabMessage> & { from?: string } = {}): TabMessage & { from: string } => ({
  id: next++, date: next, category: CAT_PROMOTIONS, in_inbox: 1, is_trash: 0, is_spam: 0, is_sent: 0, is_draft: 0, from: "shop@example.com", ...o,
});
const own = (m: TabMessage) => (m as TabMessage & { from: string }).from === "me@example.com";

describe("threadTabState (plans 86, 256)", () => {
  it("a conversation of only your own mail is in no tab and only yours", () => {
    // a note to yourself: sent, and received in the Inbox (Gmail gives the copy SENT and INBOX)
    expect(threadTabState([msg({ is_sent: 1, category: 0 }), msg({ is_sent: 1, category: 0 })], own)).toEqual({ tab: 0, onlyYours: true });
    expect(threadTabState([msg({ is_draft: 1 })], own)).toEqual({ tab: 0, onlyYours: true });
    // from an address of yours, though not marked sent
    expect(threadTabState([msg({ from: "me@example.com", category: CAT_PROMOTIONS })], own)).toEqual({ tab: 0, onlyYours: true });
  });

  it("someone else's Inbox mail makes it not only yours, in Primary or in a tab", () => {
    expect(threadTabState([msg({ is_sent: 1 }), msg({ category: CAT_PERSONAL })], own)).toEqual({ tab: 0, onlyYours: false });
    expect(threadTabState([msg({ is_sent: 1 }), msg({ category: CAT_SOCIAL })], own)).toEqual({ tab: 2, onlyYours: false });
    expect(threadTabState([msg({ category: CAT_PROMOTIONS })], own)).toEqual({ tab: 1, onlyYours: false });
  });

  it("someone else's mail out of the Inbox (archived, trashed, spam) doesn't count", () => {
    const mine = msg({ is_sent: 1, category: 0 });
    for (const other of [msg({ in_inbox: 0 }), msg({ is_trash: 1 }), msg({ is_spam: 1 })]) expect(threadTabState([mine, other], own)).toEqual({ tab: 0, onlyYours: true });
  });
});
