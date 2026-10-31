import type { Reminder } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 9, 31, 15, 30);
const HOUR = 3_600_000;
const addr = (email: string, name = "") => ({ name, email });

/**
 * Plan 87: a thread's reminder. Set all or nothing under a cap, replaced,
 * removed (only when due, or only when unchanged), answered by mail that
 * isn't yours, and kept through a merge, gone with its thread, and durable.
 */
export function defineReminderConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("reminders (plan 87)", () => {
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
    const r = (threadId: number, dueAt: number, kind: Reminder["kind"] = "always", setAt = NOW): Reminder => ({ threadId, dueAt, kind, setAt });

    it("sets, replaces, lists and survives a reopen; a missing thread is skipped", async () => {
      const { store: s, x, y } = await setup();
      expect(await s.reminders.list()).toEqual([]);
      expect(await s.reminders.put([r(x, NOW + HOUR), r(999_999, NOW + HOUR)], 10)).toEqual({ ok: true, put: [x], replaced: [] });
      expect(await s.reminders.put([r(x, NOW + 2 * HOUR, "noReply"), r(y, NOW + HOUR)], 10)).toEqual({ ok: true, put: [x, y], replaced: [r(x, NOW + HOUR)] });
      const store = await reopen(s);
      expect(await store.reminders.list()).toEqual([r(x, NOW + 2 * HOUR, "noReply"), r(y, NOW + HOUR)].sort((p, q) => p.threadId - q.threadId));
    });

    it("refuses a batch that would pass the cap, all of it; replacing doesn't count twice", async () => {
      const { store, x, y, z } = await setup();
      await store.reminders.put([r(x, NOW + HOUR), r(y, NOW + HOUR)], 2);
      expect(await store.reminders.put([r(z, NOW + HOUR)], 2)).toEqual({ ok: false });
      expect(await store.reminders.put([r(y, NOW + 5 * HOUR), r(z, NOW + HOUR)], 2)).toEqual({ ok: false });
      expect((await store.reminders.list()).map((m) => m.threadId).sort()).toEqual([x, y].sort());
      expect(await store.reminders.put([r(y, NOW + 5 * HOUR)], 2)).toMatchObject({ ok: true, put: [y] });
    });

    it("deletes all, only the due ones, or only unchanged ones", async () => {
      const { store, x, y, z } = await setup();
      await store.reminders.put([r(x, NOW - HOUR), r(y, NOW + HOUR), r(z, NOW)], 10);
      expect(await store.reminders.delete([x, y, z], { dueBy: NOW })).toEqual([r(x, NOW - HOUR), r(z, NOW)].sort((p, q) => p.threadId - q.threadId));
      expect(await store.reminders.list()).toEqual([r(y, NOW + HOUR)]);
      // replaced meanwhile: an exact delete of the old one leaves the new one
      await store.reminders.put([r(y, NOW + 2 * HOUR, "always", NOW + 1)], 10);
      expect(await store.reminders.deleteExact([r(y, NOW + HOUR)])).toEqual([]);
      expect(await store.reminders.deleteExact([r(y, NOW + 2 * HOUR, "always", NOW + 1)])).toEqual([r(y, NOW + 2 * HOUR, "always", NOW + 1)]);
      expect(await store.reminders.delete([y])).toEqual([]);
      expect(await store.reminders.list()).toEqual([]);
    });

    it("a noReply reminder is answered only by mail after it that isn't yours, a draft, spam or trash", async () => {
      const { store, a, x, y, z } = await setup();
      await store.reminders.put([r(x, NOW + HOUR, "noReply"), r(y, NOW + HOUR, "noReply"), r(z, NOW + HOUR, "always")], 10);
      const reply = (pid: string, ref: string, over: Partial<Parameters<typeof msg>[0]>) => msg({ accountId: a, providerMsgId: pid, references: [ref], date: NOW + 60_000, ...over });
      // yours (sent, or an alias you sent from, arriving without the Sent flag), a draft, spam, trash, or from before it was set: no answer
      await ingest(store, [msg({ accountId: a, providerMsgId: "mine", from: addr("me.alias@example.com"), isSent: true, date: NOW - 10 * HOUR })]);
      await ingest(store, [
        reply("own", "x@t", { from: addr("me0@example.com") }),
        reply("alias", "x@t", { from: addr("Me.Alias@example.com") }),
        reply("draft", "x@t", { from: addr("ana@friends.com"), isDraft: true }),
        reply("spam", "x@t", { from: addr("ana@friends.com"), isSpam: true, inInbox: false }),
        reply("trash", "x@t", { from: addr("ana@friends.com"), isTrash: true, inInbox: false }),
        reply("early", "x@t", { from: addr("ana@friends.com"), date: NOW - 60_000 }),
      ]);
      const list = await store.reminders.list();
      expect(await store.reminders.answered(list)).toEqual([]);
      // their answer to y; z is "always" (an answer doesn't end it)
      await ingest(store, [reply("answer", "y@t", { from: addr("bo@friends.com") }), reply("answer-z", "z@t", { from: addr("cy@friends.com") })]);
      expect(await store.reminders.answered(await store.reminders.list())).toEqual([y]);
    });

    it("a merge keeps one reminder (the survivor's, or the earlier); a thread that goes takes its reminder", async () => {
      const { store, a, x, y, z } = await setup();
      await store.reminders.put([r(x, NOW + 5 * HOUR), r(y, NOW + 2 * HOUR, "noReply"), r(z, NOW + HOUR)], 10);
      await ingest(store, [msg({ accountId: a, providerMsgId: "bridge", references: ["x@t", "y@t"], date: NOW })]);
      const merged = await threadOf(store, "bridge");
      const list = await store.reminders.list();
      expect(list.filter((m) => m.threadId !== z)).toEqual([r(merged, NOW + 2 * HOUR, "noReply")]);
      const zMessage = (await store.debug.snapshot()).messages.find((m) => m.providerMsgId === "z")!;
      await store.sync.remove([zMessage.id]);
      expect((await store.reminders.list()).map((m) => m.threadId)).toEqual([merged]);
    });
  });
}
