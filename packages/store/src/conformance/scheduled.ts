import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 9, 31, 15, 30);
const HOUR = 3_600_000;
const CAP = { count: 10, bytes: 1e6 };

/**
 * Plan 89: a draft's scheduled send. Put only on the draft as prepared
 * (generation and revision), under a cap; listed with its draft's
 * recipients and subject, soonest first; rescheduled, deleted, gone with its
 * draft (and its account), and durable.
 */
export function defineScheduledConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("scheduled sends (plan 89)", () => {
    async function setup() {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const draft = async (subject: string) => (await store.drafts.save({ accountId: a!, to: [{ name: "Ana", email: "ana@friends.com" }], cc: [], subject, bodyText: "hola" }, NOW))!;
      return { store, a: a!, draft };
    }
    const row = (d: { id: number; generation?: string; revision: number }, sendAt: number, paramsJson = `{"subject":"x"}`) => ({ draftId: d.id, generation: d.generation ?? "", revision: d.revision, sendAt, setAt: NOW, paramsJson });

    it("puts, lists soonest first with the draft's fields, reads its params, and survives a reopen", async () => {
      const { store: s, a, draft } = await setup();
      expect(await s.scheduled.list()).toEqual([]);
      const one = await draft("One"), two = await draft("Two");
      expect(await s.scheduled.put(row(one, NOW + 2 * HOUR, `{"subject":"One"}`), CAP)).toBe("ok");
      expect(await s.scheduled.put(row(two, NOW + HOUR), CAP)).toBe("ok");
      const store = await reopen(s);
      expect(await store.scheduled.list()).toEqual([
        { draftId: two.id, sendAt: NOW + HOUR, setAt: NOW, accountId: a, threadId: null, mode: "new", to: [{ name: "Ana", email: "ana@friends.com" }], subject: "Two", error: null, retryAt: null },
        { draftId: one.id, sendAt: NOW + 2 * HOUR, setAt: NOW, accountId: a, threadId: null, mode: "new", to: [{ name: "Ana", email: "ana@friends.com" }], subject: "One", error: null, retryAt: null },
      ]);
      expect(await store.scheduled.get(one.id)).toEqual({ draftId: one.id, sendAt: NOW + 2 * HOUR, setAt: NOW, paramsJson: `{"subject":"One"}`, error: null, retryAt: null });
      expect(await store.scheduled.get(999_999)).toBeNull();
    });

    it("is stale for a missing draft or another revision or generation", async () => {
      const { store, a, draft } = await setup();
      const d = await draft("One");
      expect(await store.scheduled.put({ ...row(d, NOW), draftId: 999_999 }, CAP)).toBe("stale");
      expect(await store.scheduled.put({ ...row(d, NOW), revision: d.revision + 1 }, CAP)).toBe("stale");
      expect(await store.scheduled.put({ ...row(d, NOW), generation: "other" }, CAP)).toBe("stale");
      // edited after it was prepared: the prepared revision no longer matches
      const edited = (await store.drafts.save({ id: d.id, generation: d.generation, baseRevision: d.revision, accountId: a, to: [], cc: [], subject: "One!", bodyText: "x" }, NOW + 1))!;
      expect(edited.revision).not.toBe(d.revision);
      expect(await store.scheduled.put(row(d, NOW), CAP)).toBe("stale");
      expect(await store.scheduled.list()).toEqual([]);
    });

    it("refuses past the cap; replacing a draft's own doesn't count twice", async () => {
      const { store, draft } = await setup();
      const one = await draft("One"), two = await draft("Two");
      expect(await store.scheduled.put(row(one, NOW + HOUR), { count: 1, bytes: 1e6 })).toBe("ok");
      expect(await store.scheduled.put(row(two, NOW + HOUR), { count: 1, bytes: 1e6 })).toBe("full");
      expect(await store.scheduled.put(row(one, NOW + 3 * HOUR), { count: 1, bytes: 1e6 })).toBe("ok");
      expect((await store.scheduled.list()).map((s) => [s.draftId, s.sendAt])).toEqual([[one.id, NOW + 3 * HOUR]]);
    });

    it("counts the params' size against the byte cap", async () => {
      const { store, draft } = await setup();
      const one = await draft("One"), two = await draft("Two");
      expect(await store.scheduled.put(row(one, NOW, "x".repeat(60)), { count: 10, bytes: 100 })).toBe("ok");
      expect(await store.scheduled.put(row(two, NOW, "x".repeat(60)), { count: 10, bytes: 100 })).toBe("full");
      expect(await store.scheduled.put(row(one, NOW, "x".repeat(90)), { count: 10, bytes: 100 })).toBe("ok");
    });

    it("counts the budget in UTF-16 units in both stores (an emoji is two)", async () => {
      const { store, draft } = await setup();
      const one = await draft("One"), two = await draft("Two");
      // 30 emoji: 60 units, 30 SQLite characters
      expect(await store.scheduled.put(row(one, NOW, "😀".repeat(30)), { count: 10, bytes: 100 })).toBe("ok");
      expect(await store.scheduled.put(row(two, NOW, "😀".repeat(30)), { count: 10, bytes: 100 })).toBe("full");
    });

    it("notes a failure only on the moment it was for; a reschedule forgets it", async () => {
      const { store, draft } = await setup();
      const d = await draft("One");
      await store.scheduled.put(row(d, NOW), CAP);
      expect(await store.scheduled.fail(d.id, NOW + 1, "nope", NOW + HOUR)).toBe(false);
      expect(await store.scheduled.fail(d.id, NOW, "Sent folder full", NOW + HOUR)).toBe(true);
      expect(await store.scheduled.list()).toMatchObject([{ draftId: d.id, sendAt: NOW, error: "Sent folder full", retryAt: NOW + HOUR }]);
      await store.scheduled.reschedule(d.id, NOW + 2 * HOUR);
      expect(await store.scheduled.list()).toMatchObject([{ draftId: d.id, sendAt: NOW + 2 * HOUR, error: null, retryAt: null }]);
    });

    it("queueSend with scheduledAt sends only a draft still scheduled for that moment, and takes its row with the draft", async () => {
      const { store, a, draft } = await setup();
      const d = await draft("One");
      const send = (scheduledAt: number) => store.compose.queueSend({ accountId: a, to: [{ name: "Ana", email: "ana@friends.com" }], cc: [], bcc: [], subject: "One", bodyText: "hola", draftId: d.id, draftGeneration: d.generation, draftRevision: d.revision, recordReply: true, scheduledAt, now: NOW });
      await expect(send(NOW)).rejects.toMatchObject({ code: "STALE", details: { reason: "unscheduled" } });
      await store.scheduled.put(row(d, NOW + HOUR), CAP);
      await expect(send(NOW)).rejects.toMatchObject({ code: "STALE", details: { reason: "unscheduled" } });
      expect((await store.drafts.list()).map((x) => x.id)).toEqual([d.id]);
      await expect(send(NOW + HOUR)).resolves.toMatchObject({ opId: expect.any(String) });
      expect(await store.drafts.list()).toEqual([]);
      expect(await store.scheduled.list()).toEqual([]);
      expect(await store.scheduled.get(d.id)).toBeNull();
    });

    it("reschedules and deletes; both say whether there was one", async () => {
      const { store, draft } = await setup();
      const d = await draft("One");
      expect(await store.scheduled.reschedule(d.id, NOW)).toBe(false);
      await store.scheduled.put(row(d, NOW + HOUR), CAP);
      expect(await store.scheduled.reschedule(d.id, NOW + 5 * HOUR)).toBe(true);
      expect((await store.scheduled.get(d.id))?.sendAt).toBe(NOW + 5 * HOUR);
      expect(await store.scheduled.delete(d.id)).toBe(true);
      expect(await store.scheduled.delete(d.id)).toBe(false);
      // the draft itself stays
      expect((await store.drafts.list()).map((x) => x.id)).toEqual([d.id]);
    });

    it("goes with its draft, and with its account", async () => {
      const { store: s, a, draft } = await setup();
      const one = await draft("One"), two = await draft("Two");
      await s.scheduled.put(row(one, NOW + HOUR), CAP);
      await s.scheduled.put(row(two, NOW + HOUR), CAP);
      await s.drafts.delete(one.id, one.generation);
      expect((await s.scheduled.list()).map((x) => x.draftId)).toEqual([two.id]);
      await s.accounts.remove(a);
      expect(await s.scheduled.list()).toEqual([]);
      const store = await reopen(s);
      expect(await store.scheduled.list()).toEqual([]);
      expect(await store.scheduled.get(two.id)).toBeNull();
    });
  });
}
