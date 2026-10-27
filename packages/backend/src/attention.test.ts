import type { Counts } from "@terno/core";
import { describe, expect, it } from "vitest";
import { Attention } from "./attention";

const counts = (inboxUnread: number): Counts => ({ inboxUnread, inboxUnreadByAccount: {}, categoryUnread: {}, categoryTotal: {}, categorySuggestions: {} });

function setup(o: { settings?: Record<string, unknown>; host?: boolean } = {}) {
  const app: Record<string, unknown> = { ...o.settings };
  const badges: number[] = [];
  let published = 0;
  const attention = new Attention({
    store: { settings: { get: async (key: string, dflt: unknown) => (key === "app" ? app : dflt) }, secrets: {} } as never,
    host: o.host === false ? null : { badge: (n) => badges.push(n) },
    publishCounts: () => void published++,
  });
  return { attention, app, badges, published: () => published };
}

describe("the Dock badge", () => {
  it("asks the sidebar's publisher at start, then shows the Inbox number only when it changes", async () => {
    const t = setup();
    await t.attention.start();
    expect(t.published()).toBe(1);
    t.attention.counts(counts(3));
    t.attention.counts(counts(3));
    t.attention.counts(counts(0));
    expect(t.badges).toEqual([3, 0]);
  });

  it("off: 0 at start and after a change; on again: the current number at once", async () => {
    const t = setup({ settings: { dockBadge: false } });
    await t.attention.start();
    expect(t.badges).toEqual([0]);
    t.attention.counts(counts(7));
    expect(t.badges).toEqual([0]);
    t.app.dockBadge = true;
    await t.attention.refresh();
    expect(t.badges).toEqual([0, 7]);
    t.app.dockBadge = false;
    await t.attention.refresh();
    expect(t.badges).toEqual([0, 7, 0]);
  });

  it("no host (the web): nothing published, nothing shown (the page reads the counts itself)", async () => {
    const t = setup({ host: false });
    await t.attention.start();
    t.attention.counts(counts(4));
    expect(t.published()).toBe(0);
    expect(t.badges).toEqual([]);
  });

  it("stopped: nothing more goes to the host", async () => {
    const t = setup();
    await t.attention.start();
    t.attention.stop();
    t.attention.counts(counts(5));
    expect(t.badges).toEqual([]);
  });
});
