import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 2, 12);
const INBOX = { mailbox: "INBOX", uidvalidity: 7, uid: 1, flags: [] };
const ARCHIVE = { mailbox: "Archive", uidvalidity: 9, uid: 40, flags: ["\\Seen"] };

/**
 * Plan 114: a held IMAP message takes the place another mail app moved it to only when that is provably the same
 * mail and nothing of ours can be misdirected; every other case stays held, with nothing written.
 */
export function defineImapAdoptConformance(fresh: () => Promise<MailStore>): void {
  describe("IMAP: a message moved by another app is adopted at its new place only when provably safe", () => {
    /** one message whose only place was lost (the sweep after another app moved it): held */
    async function lost(over: Parameters<typeof msg>[0] extends infer M ? Partial<M> : never = {}) {
      const store = await fresh();
      const [account] = await withAccounts(store);
      const m = msg({ accountId: account!, providerMsgId: "moved", rfcMessageId: "moved@example.test", size: 4242, locations: [INBOX], ...over });
      const { inserted: [id] } = await ingest(store, [m]);
      const locations = store.providerStore(account!).locations!;
      await locations.remove(id!, "INBOX");
      expect(await locations.unresolved([id!])).toEqual([id]);
      const expect_ = { rfcMessageId: "moved@example.test", size: 4242, date: m.date };
      return { store, account: account!, id: id!, locations, expect: expect_ };
    }

    it("the only message with its Message-ID, same size and date, nothing queued: adopted, its hold gone, nothing else changed", async () => {
      const t = await lost();
      expect(await t.locations.adopt(t.id, ARCHIVE, t.expect)).toBe(true);
      expect(await t.locations.unresolved([t.id])).toEqual([]);
      expect((await t.locations.of([t.id])).map((l) => ({ mailbox: l.mailbox, uidvalidity: l.uidvalidity, uid: l.uid, flags: l.flags }))).toEqual([{ ...ARCHIVE, flags: JSON.stringify(ARCHIVE.flags) }]);
      expect(await t.locations.at("Archive", 9, 40)).toBe(t.id);
    });

    it("refuses a different size, date or Message-ID (another mail), with nothing written", async () => {
      const t = await lost();
      for (const wrong of [{ size: 4243 }, { date: t.expect.date + 1 }, { rfcMessageId: "other@example.test" }]) {
        expect(await t.locations.adopt(t.id, ARCHIVE, { ...t.expect, ...wrong })).toBe(false);
      }
      expect(await t.locations.unresolved([t.id])).toEqual([t.id]);
      expect(await t.locations.of([t.id])).toEqual([]);
    });

    it("refuses while another message of the account has the same Message-ID (a duplicate can't be told apart)", async () => {
      const t = await lost();
      await ingest(t.store, [msg({ accountId: t.account, providerMsgId: "twin", rfcMessageId: "moved@example.test", locations: [{ ...INBOX, uid: 2 }] })]);
      expect(await t.locations.adopt(t.id, ARCHIVE, t.expect)).toBe(false);
      expect(await t.locations.unresolved([t.id])).toEqual([t.id]);
    });

    it("refuses one still placed somewhere, one never held, and a place another message has", async () => {
      const store = await fresh();
      const [account] = await withAccounts(store);
      const { inserted: [twoPlaces, placed, other] } = await ingest(store, [
        msg({ accountId: account!, providerMsgId: "two", rfcMessageId: "two@example.test", size: 1, locations: [INBOX, { ...INBOX, mailbox: "Work" }] }),
        msg({ accountId: account!, providerMsgId: "placed", rfcMessageId: "placed@example.test", size: 1, locations: [{ ...INBOX, uid: 2 }] }),
        msg({ accountId: account!, providerMsgId: "other", rfcMessageId: "other@example.test", size: 1, locations: [ARCHIVE] }),
      ]);
      const locations = store.providerStore(account!).locations!;
      const snap = await store.debug.snapshot();
      const date = (id: number) => snap.messages.find((m) => m.id === id)!.date as number;
      await locations.remove(twoPlaces!, "INBOX");
      expect(await locations.adopt(twoPlaces!, { ...ARCHIVE, uid: 41 }, { rfcMessageId: "two@example.test", size: 1, date: date(twoPlaces!) })).toBe(false);
      expect(await locations.adopt(placed!, { ...ARCHIVE, uid: 42 }, { rfcMessageId: "placed@example.test", size: 1, date: date(placed!) })).toBe(false);
      await locations.remove(placed!, "INBOX");
      // Archive 9/40 is the other message's
      expect(await locations.adopt(placed!, ARCHIVE, { rfcMessageId: "placed@example.test", size: 1, date: date(placed!) })).toBe(false);
      expect(await locations.at("Archive", 9, 40)).toBe(other);
      expect(await locations.unresolved([twoPlaces!, placed!])).toEqual([twoPlaces, placed]);
    });

    it("refuses while an action of ours is queued or running for it; once it finished, adopts", async () => {
      const t = await lost();
      const r = await t.store.threads.act({ threadIds: [await threadOf(t.store, "moved")], action: "markRead", signal: null, now: NOW });
      const op = r.opIds[0]!;
      expect((await t.store.ops.get(op))!.state).toBe("queued");
      expect(await t.locations.adopt(t.id, ARCHIVE, t.expect)).toBe(false);
      expect((await t.store.ops.claimReady(NOW + 60_000, 10)).map((o) => o.id)).toContain(op);
      expect((await t.store.ops.get(op))!.state).toBe("running");
      expect(await t.locations.adopt(t.id, ARCHIVE, t.expect)).toBe(false);
      expect(await t.locations.unresolved([t.id])).toEqual([t.id]);
      await t.store.ops.complete(op, undefined, NOW);
      expect((await t.store.ops.get(op))?.state ?? "succeeded").toBe("succeeded");
      expect(await t.locations.adopt(t.id, ARCHIVE, t.expect)).toBe(true);
    });

    it("refuses while an action of ours has an unknown outcome for it (it may have reached the server)", async () => {
      const t = await lost();
      const r = await t.store.threads.act({ threadIds: [await threadOf(t.store, "moved")], action: "markRead", signal: null, now: NOW });
      const op = r.opIds[0]!;
      await t.store.ops.claimReady(NOW + 60_000, 10);
      await t.store.ops.markUnknown(op, "lost answer", NOW);
      expect((await t.store.ops.get(op))!.state).toBe("unknown");
      expect(await t.locations.adopt(t.id, ARCHIVE, t.expect)).toBe(false);
      expect(await t.locations.unresolved([t.id])).toEqual([t.id]);
    });
  });
}
