import type { Pin } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 10, 15, 30);
const HOUR = 3_600_000;
const addr = (email: string, name = "") => ({ name, email });
const byThread = (a: Pin, b: Pin) => a.threadId - b.threadId;

/**
 * Plan 179: conversations pinned to the Inbox's top. Added all or nothing
 * under a cap (a pinned one keeps its pin), removed (or only when unchanged),
 * kept through a merge, gone with its thread, and durable.
 */
export function definePinConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("pins (plan 179)", () => {
    async function setup() {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      await ingest(store, [
        msg({ accountId: a!, providerMsgId: "x", rfcMessageId: "x@t", from: addr("ana@friends.com"), date: NOW - 3 * HOUR }),
        msg({ accountId: a!, providerMsgId: "y", rfcMessageId: "y@t", from: addr("bo@friends.com"), date: NOW - 2 * HOUR }),
        msg({ accountId: a!, providerMsgId: "z", rfcMessageId: "z@t", from: addr("cy@friends.com"), date: NOW - HOUR }),
      ]);
      return { store, a: a!, x: await threadOf(store, "x"), y: await threadOf(store, "y"), z: await threadOf(store, "z") };
    }
    const p = (threadId: number, pinnedAt = NOW): Pin => ({ threadId, pinnedAt });

    it("adds, lists and survives a reopen; a missing thread is skipped and a pinned one keeps its pin", async () => {
      const { store: s, x, y } = await setup();
      expect(await s.pins.list()).toEqual([]);
      expect(await s.pins.add([p(x), p(999_999)], 10)).toEqual({ ok: true, added: [p(x)] });
      // x again (later): it stays where it was pinned; y is new
      expect(await s.pins.add([p(x, NOW + HOUR), p(y, NOW + HOUR)], 10)).toEqual({ ok: true, added: [p(y, NOW + HOUR)] });
      const store = await reopen(s);
      expect(await store.pins.list()).toEqual([p(x), p(y, NOW + HOUR)].sort(byThread));
    });

    it("refuses a batch that would pass the cap, all of it; what's pinned already doesn't count twice", async () => {
      const { store, x, y, z } = await setup();
      await store.pins.add([p(x), p(y)], 2);
      expect(await store.pins.add([p(z)], 2)).toEqual({ ok: false });
      expect(await store.pins.add([p(y), p(z)], 2)).toEqual({ ok: false });
      expect((await store.pins.list()).map((m) => m.threadId).sort()).toEqual([x, y].sort());
      expect(await store.pins.add([p(y, NOW + HOUR)], 2)).toEqual({ ok: true, added: [] });
    });

    it("deletes what it's asked to, or only unchanged pins", async () => {
      const { store, x, y, z } = await setup();
      await store.pins.add([p(x), p(y)], 10);
      expect(await store.pins.delete([x, z])).toEqual([p(x)]);
      expect(await store.pins.list()).toEqual([p(y)]);
      // pinned again since: an exact delete of the old pin leaves the new one
      await store.pins.delete([y]);
      await store.pins.add([p(y, NOW + HOUR)], 10);
      expect(await store.pins.deleteExact([p(y)])).toEqual([]);
      expect(await store.pins.deleteExact([p(y, NOW + HOUR)])).toEqual([p(y, NOW + HOUR)]);
      expect(await store.pins.list()).toEqual([]);
    });

    it("a merge keeps one pin (the survivor's first); a thread that goes takes its pin", async () => {
      const { store, a, x, y, z } = await setup();
      await store.pins.add([p(x, NOW + 5), p(y, NOW + 2), p(z, NOW + 1)], 10);
      await ingest(store, [msg({ accountId: a, providerMsgId: "bridge", references: ["x@t", "y@t"], date: NOW })]);
      const merged = await threadOf(store, "bridge");
      const kept = (await store.pins.list()).filter((m) => m.threadId !== z);
      expect(kept).toHaveLength(1);
      expect(kept[0]!.threadId).toBe(merged);
      expect([NOW + 5, NOW + 2]).toContain(kept[0]!.pinnedAt);
      const zMessage = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "z")!;
      await store.sync.remove([zMessage.id]);
      expect((await store.pins.list()).map((m) => m.threadId)).toEqual([merged]);
    });

    it("a merge onto an unpinned survivor brings the pin with it", async () => {
      const { store, a, y } = await setup();
      await store.pins.add([p(y, NOW + 2)], 10);
      await ingest(store, [msg({ accountId: a, providerMsgId: "bridge", references: ["x@t", "y@t"], date: NOW })]);
      const merged = await threadOf(store, "bridge");
      expect(await store.pins.list()).toEqual([p(merged, NOW + 2)]);
    });
  });
}
