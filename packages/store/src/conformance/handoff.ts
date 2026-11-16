import { HANDED, parseHandoff, type Handoff } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { DatedWrite } from "../dated";
import { AWAITING_ITEM, type FollowupWrite } from "../followups";
import type { MailStore } from "../mail-store";
import { ANSWERED_WITH_PROMISE } from "../today";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 13, 12);
const DAY = 86_400_000;
const me = { name: "Me", email: "me0@example.com" };
const school = { name: "School", email: "office@school.test" };
const jess = { name: "Jess Okafor", email: "jess@home.test" };

/**
 * Plan 210 (iteration 4, Hand to…): a forward's hand-off is kept with its draft, copied onto its send op when queued, and
 * closes its items as handed, to whom it was sent, only in the commit that records the provider's confirmation; a change
 * since, a failure or an uncertain delivery claims nothing. The forward gets its own wait. Both stores alike.
 */
export function defineHandoffConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Hand to… (plan 210, iteration 4)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      const m = msg({ accountId: accountId!, from: school, to: [me], subject: "Field trip", date: NOW - DAY });
      const r = await store.sync.ingest([m], { applyFilters: false, now: NOW - DAY, classifier: null, datedMail: { since: null } });
      const source = { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      const item = (over: Partial<DatedWrite> = {}): DatedWrite => ({ kind: "respond", item: 0, text: "Sign the field trip form", quote: "sign it by Friday", dueDay: "2026-11-20", dueAt: NOW + 7 * DAY, timed: false, dated: true, actAt: NOW, ...over });
      await store.dated.finish({ messageId: source.id, threadId: source.thread, fromScan: false, rows: [item(), item({ item: 1, kind: "pay", text: "Pay $12 for the bus" })], settled: [], now: NOW, model: "m", provider: "p", promptVersion: 1, clearGeneration: store.dated.clearGeneration() });
      const [form, bus] = await store.dated.ofThread(source.thread);
      const forward = async (handoff: Handoff | null | undefined, over: Record<string, unknown> = {}) =>
        (await store.drafts.save({ accountId: accountId!, mode: "forward", threadId: source.thread, forwardOfMessageId: source.id, to: [jess], cc: [], subject: "Fwd: Field trip", bodyText: "Could you take care of this?", ...(handoff !== undefined && { handoff }), ...over }, NOW))!;
      const send = async (draftId: number, generation: string, revision: number) => {
        const q = await store.compose.queueSend({ accountId: accountId!, to: [jess], cc: [], bcc: [], subject: "Fwd: Field trip", bodyText: "Could you take care of this?", draftId, draftGeneration: generation, draftRevision: revision, recordReply: false, now: NOW });
        await store.ops.claimReady(NOW, 20);
        return q;
      };
      return { store, accountId: accountId!, source, form: form!, bus: bus!, forward, send };
    }
    const handing = (...items: Handoff["items"]): Handoff => ({ items });

    it("a draft keeps a hand-off only while it's a forward: kept across saves, cleared by null, dropped by a reply or one that names no item", async () => {
      const { store, accountId, source, form, forward } = await setup();
      const h = handing({ source: "dated", id: form.id, revision: form.revision, named: true });
      const d = await forward(h);
      expect(parseHandoff(d.handoff_json)).toEqual(h);
      // a save that says nothing of it (the typing that follows) keeps it
      const kept = (await store.drafts.save({ id: d.id, generation: d.generation, baseRevision: d.revision, accountId, mode: "forward", threadId: source.thread, forwardOfMessageId: source.id, to: [jess], cc: [], subject: "Fwd: Field trip", bodyText: "more" }, NOW))!;
      expect(parseHandoff(kept.handoff_json)).toEqual(h);
      expect(parseHandoff((await store.drafts.list()).find((x) => x.id === d.id)!.handoff_json)).toEqual(h);
      const cleared = (await store.drafts.save({ id: d.id, generation: d.generation, baseRevision: kept.revision, accountId, mode: "forward", threadId: source.thread, forwardOfMessageId: source.id, to: [jess], cc: [], subject: "Fwd", bodyText: "x", handoff: null }, NOW))!;
      expect(cleared.handoff_json ?? null).toBeNull();
      // turned into a reply: a reply hands nothing on
      const reply = (await store.drafts.save({ accountId, mode: "reply", threadId: source.thread, inReplyToMessageId: source.id, to: [school], cc: [], subject: "Re", bodyText: "x", handoff: h }, NOW))!;
      expect(reply.handoff_json ?? null).toBeNull();
      // a hand-off that names no item of the row could claim nothing as the user saw it
      expect((await forward({ items: [{ source: "dated", id: form.id, revision: form.revision }] })).handoff_json ?? null).toBeNull();
    });

    it("queued and held, nothing closes; the provider's confirmation closes the items as handed to whom it went, with its own wait", async () => {
      const { store, source, form, bus, forward, send } = await setup();
      const d = await forward(handing({ source: "dated", id: form.id, revision: form.revision, named: true }, { source: "dated", id: bus.id, revision: bus.revision }));
      const q = await send(d.id, d.generation!, d.revision);
      // the op carries it: queueing (what `scheduledSent` means) claims nothing
      expect(parseHandoff((JSON.parse((await store.ops.get(q.opId))!.target_json) as { handoff?: unknown }).handoff)).toMatchObject({ items: [{ id: form.id, named: true }, { id: bus.id }] });
      expect(await store.dated.get(form.id)).toMatchObject({ state: "open", revision: form.revision });
      const done = await store.ops.complete(q.opId, { providerMsgId: "fwd-1" }, NOW + 1000, { followup: true, nudgeAfterDays: 5 });
      expect(done.handed).toBe(true);
      for (const r of [form, bus]) expect(await store.dated.get(r.id)).toMatchObject({ state: "done", closedReason: HANDED, closedAt: NOW + 1000, revision: r.revision + 1, handedTo: { name: jess.name, email: jess.email } });
      // Earlier reads it by its closing
      expect((await store.dated.closedPage({ since: 0, after: null, limit: 10 })).map((r) => [r.id, r.handedTo?.email])).toEqual([[bus.id, jess.email], [form.id, jess.email]]);
      // the forward waits on Jess, seeded rather than left to the model
      const waits = await store.followups.ofThread(q.threadId);
      expect(waits).toEqual([expect.objectContaining({ kind: "awaiting", item: AWAITING_ITEM, messageId: q.messageId, personEmail: jess.email, personName: jess.name, state: "open" })]);
      expect(waits[0]!.dueAt).toBeGreaterThan(NOW + 4 * DAY);
      expect(q.threadId).not.toBe(source.thread);
      // kept across a restart
      const again = await reopen(store);
      expect((await again.dated.get(form.id))!.handedTo).toEqual({ name: jess.name, email: jess.email });
    });

    it("follow-ups off: the items close, no wait is seeded", async () => {
      const { store, form, forward, send } = await setup();
      const d = await forward(handing({ source: "dated", id: form.id, revision: form.revision, named: true }));
      const q = await send(d.id, d.generation!, d.revision);
      expect((await store.ops.complete(q.opId, { providerMsgId: "fwd-2" }, NOW, { followup: false, nudgeAfterDays: 5 })).handed).toBe(true);
      expect((await store.dated.get(form.id))!.closedReason).toBe(HANDED);
      expect(await store.followups.ofThread(q.threadId)).toEqual([]);
    });

    it("a change since wins: the row's item put off, done or settled meanwhile is never claimed, nor its members; the forward still waits on its person (Codex's code review, iteration 4)", async () => {
      const { store, form, bus, forward, send } = await setup();
      const d = await forward(handing({ source: "dated", id: form.id, revision: form.revision, named: true }, { source: "dated", id: bus.id, revision: bus.revision }));
      const q = await send(d.id, d.generation!, d.revision);
      await store.dated.update(form.id, form.revision, { deferredUntil: NOW + DAY });
      const done = await store.ops.complete(q.opId, { providerMsgId: "fwd-3" }, NOW, { followup: true, nudgeAfterDays: 5 });
      expect(done.handed).toBeUndefined();
      expect(await store.dated.get(form.id)).toMatchObject({ state: "open", deferredUntil: NOW + DAY, handedTo: null });
      expect(await store.dated.get(bus.id)).toMatchObject({ state: "open", revision: bus.revision });
      expect(await store.followups.ofThread(q.threadId)).toEqual([expect.objectContaining({ kind: "awaiting", item: AWAITING_ITEM, messageId: q.messageId, personEmail: jess.email, state: "open" })]);
    });

    it("a member changed since stays as it is; the row's own item closes", async () => {
      const { store, form, bus, forward, send } = await setup();
      const d = await forward(handing({ source: "dated", id: form.id, revision: form.revision, named: true }, { source: "dated", id: bus.id, revision: bus.revision }));
      const q = await send(d.id, d.generation!, d.revision);
      await store.dated.update(bus.id, bus.revision, { state: "done", closedReason: null, closedAt: NOW });
      await store.ops.complete(q.opId, { providerMsgId: "fwd-4" }, NOW, {});
      expect(await store.dated.get(form.id)).toMatchObject({ state: "done", closedReason: HANDED });
      expect(await store.dated.get(bus.id)).toMatchObject({ state: "done", closedReason: null, handedTo: null });
    });

    it("a forward that hands on two rows closes each by its own item: one put off since stays, the other closes (Codex's code review, iteration 4)", async () => {
      const { store, form, bus, forward, send } = await setup();
      const h = handing({ source: "dated", id: form.id, revision: form.revision, named: true }, { source: "dated", id: bus.id, revision: bus.revision, named: true, row: 1 });
      const d = await forward(h);
      // the rows kept with the draft and carried by the send
      expect(parseHandoff(d.handoff_json)).toEqual(h);
      const q = await send(d.id, d.generation!, d.revision);
      await store.dated.update(bus.id, bus.revision, { deferredUntil: NOW + DAY });
      expect((await store.ops.complete(q.opId, { providerMsgId: "fwd-rows" }, NOW, {})).handed).toBe(true);
      expect(await store.dated.get(form.id)).toMatchObject({ state: "done", closedReason: HANDED });
      expect(await store.dated.get(bus.id)).toMatchObject({ state: "open", deferredUntil: NOW + DAY, handedTo: null });
      // a row that names no item of its own is no hand-off
      expect((await forward(handing({ source: "dated", id: form.id, revision: form.revision, named: true }, { source: "dated", id: bus.id, revision: bus.revision, row: 1 }))).handoff_json ?? null).toBeNull();
    });

    it("a failed send or one of uncertain delivery claims nothing", async () => {
      const { store, form, forward, send } = await setup();
      const h = handing({ source: "dated", id: form.id, revision: form.revision, named: true });
      const failed = await forward(h);
      const a = await send(failed.id, failed.generation!, failed.revision);
      await store.ops.fail(a.opId, "refused", false, NOW);
      const unsure = await forward(h);
      const b = await send(unsure.id, unsure.generation!, unsure.revision);
      await store.ops.markUnknown(b.opId, "timed out", NOW);
      expect(await store.dated.get(form.id)).toMatchObject({ state: "open", revision: form.revision, handedTo: null });
    });

    it("a handed promise of yours closes with the request it answers settled beside it, as Done on it would", async () => {
      const { store, accountId, source, form, forward, send } = await setup();
      const sent = msg({ accountId, from: me, to: [school], isSent: true, inInbox: false, gmailLabels: ["SENT"], subject: "Re: Field trip", date: NOW - 1000 });
      const s = await store.sync.ingest([sent], { applyFilters: false, now: NOW, classifier: null, liveSent: { wanted: true } });
      const sentId = s.inserted[0]!;
      const thread = await threadOf(store, sent.providerMsgId!);
      const promise: FollowupWrite = { kind: "promise", item: 0, text: "sign the form", quote: "I'll sign it", personName: "School", personEmail: school.email, dueAt: NOW + DAY, dated: true };
      await store.followups.finish({ messageId: sentId, threadId: thread, fromScan: false, rows: [promise], kept: [], now: NOW, model: "m", provider: "p", promptVersion: 11, clearGeneration: store.followups.clearGeneration() });
      const p = (await store.followups.ofThread(thread)).find((x) => x.kind === "promise")!;
      const d = await forward(handing({ source: "promise", id: p.id, revision: p.revision, named: true }, { source: "dated", id: form.id, revision: form.revision, answered: true }));
      const q = await send(d.id, d.generation!, d.revision);
      expect(source.thread).toBe(form.threadId);
      await store.ops.complete(q.opId, { providerMsgId: "fwd-5" }, NOW, {});
      expect(await store.followups.get(p.id)).toMatchObject({ state: "done", closedReason: HANDED, inboxState: "none", handedTo: { email: jess.email } });
      expect(await store.dated.get(form.id)).toMatchObject({ state: "settled", closedReason: ANSWERED_WITH_PROMISE, handedTo: null });
      expect((await store.followups.closedPage({ since: 0, after: null, limit: 5 })).map((r) => r.id)).toEqual([p.id]);
    });
  });
}
