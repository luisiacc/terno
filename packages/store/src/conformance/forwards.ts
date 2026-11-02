import { FORWARD_CAP, FORWARD_DELAY_MS, FORWARD_ELIGIBLE_MS, FORWARD_FILTER_LAG_MS, FORWARD_MAX_AGE_MS, MAX_RECIPIENTS, type FilterRule } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 1, 12);
const ANA = { name: "Ana", email: "ana@books.test" };
const LUIS = { name: "Luis", email: "luis@books.test" };
const OWN = ["me0@example.com", "me1@example.com"];

/**
 * Plan 116: forwarding new mail. Eligibility is marked by a live ingest
 * only; a rule's forwards are made once per (message, rule) for the
 * memberships that count; claiming one is fenced (rule, category, Spam and
 * Trash, the cap) and owns its addresses; each send is queued once.
 */
export function defineForwardsConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("forwards (plan 116)", () => {
    async function setup(o: { trigger?: boolean } = {}) {
      const store = await fresh();
      const [a] = await withAccounts(store, 1);
      const cat = await store.categories.create("Facturas", "amber");
      if (o.trigger !== false) await store.forwards.setCategory(cat.id, { addresses: [ANA], enabled: true }, NOW - 1000);
      /** a live message arriving at `at` (eligible), filed by a filter-less origin later by the test */
      const arrive = async (over: Partial<Parameters<typeof msg>[0]> = {}, at = NOW, live = true) => {
        const m = msg({ accountId: a!, date: at - 60_000, ...over });
        const r = await store.sync.ingest([m], { applyFilters: true, now: at, classifier: null, forwardEligible: live });
        return { id: r.inserted[0]!, thread: await threadOf(store, m.providerMsgId!) };
      };
      const file = (thread: number, addedBy: "user" | "filter" | "auto" | "bulk" | "agent" | "suggestion", at = NOW) => store.categories.add({ categoryId: cat.id, threadIds: [thread], addedBy, now: at });
      const plan = (p: { messageIds?: number[]; threadIds?: number[]; filed?: number[]; agentFiles?: boolean }, at = NOW) => store.forwards.plan({ agentFiles: false, ...p, now: at });
      const claim = (id: number, at = NOW + FORWARD_DELAY_MS) => store.forwards.claim(id, at, { filesMissing: false, own: OWN });
      return { store, a: a!, cat, arrive, file, plan, claim };
    }

    it("lists a category's trigger; no addresses is none; any rule makes it active", async () => {
      const { store, cat } = await setup({ trigger: false });
      expect(await store.forwards.active()).toBe(false);
      expect(await store.forwards.setCategory(cat.id, { addresses: [ANA, { name: "", email: "ANA@books.test" }, { name: "", email: "not an address" }], enabled: true }, NOW)).toEqual({ changed: true });
      expect((await store.categories.list()).find((c) => c.id === cat.id)?.forward).toEqual({ addresses: [ANA], enabled: true });
      expect(await store.forwards.active()).toBe(true);
      await store.forwards.setCategory(cat.id, null, NOW);
      expect((await store.categories.list()).find((c) => c.id === cat.id)?.forward).toBeUndefined();
      expect(await store.forwards.active()).toBe(false);
      expect(await store.forwards.setCategory(999_999, { addresses: [ANA], enabled: true }, NOW)).toBeNull();
    });

    it("forwards live mail filed by a filter, once, due in 10 s; not mail that wasn't live, too old, or mine", async () => {
      const { store, a, arrive, file, plan } = await setup();
      const live = await arrive();
      await file(live.thread, "filter");
      const [row, ...more] = await plan({ messageIds: [live.id] });
      expect(more).toEqual([]);
      expect(row).toMatchObject({ messageId: live.id, threadId: live.thread, accountId: a, ruleKind: "category", state: "waiting", dueAt: NOW + FORWARD_DELAY_MS, to: [ANA], opIds: [] });
      expect(await plan({ messageIds: [live.id] })).toEqual([]);
      expect(await store.forwards.nextDue()).toBe(NOW + FORWARD_DELAY_MS);

      const backfill = await arrive({}, NOW, false);
      const old = await arrive({ date: NOW - FORWARD_MAX_AGE_MS - 1 });
      const mine = await arrive({ from: { name: "Me", email: "ME0@example.com" } });
      for (const m of [backfill, old, mine]) await file(m.thread, "filter");
      expect(await plan({ messageIds: [backfill.id, old.id, mine.id] })).toEqual([]);
    });

    it("counts what Terno filed, a reply in a filed conversation and one filed by hand; never a bulk filing", async () => {
      const { store, arrive, file, plan } = await setup();
      const auto = await arrive(), suggestion = await arrive(), bulk = await arrive(), user = await arrive(), byHand = await arrive(), agent = await arrive();
      await file(auto.thread, "auto");
      await file(suggestion.thread, "suggestion");
      await file(bulk.thread, "bulk");
      await file(user.thread, "user");
      await file(byHand.thread, "user");
      await file(agent.thread, "agent");
      const made = await plan({ threadIds: [auto.thread, suggestion.thread, bulk.thread, user.thread, byHand.thread, agent.thread], filed: [byHand.thread] });
      expect(made.map((r) => r.messageId).sort()).toEqual([auto.id, suggestion.id, byHand.id].sort());
      expect((await plan({ threadIds: [agent.thread], agentFiles: true })).map((r) => r.messageId)).toEqual([agent.id]);

      // filed in bulk before: a reply that arrives later in that conversation is new mail in the category
      const accountId = (await store.accounts.list())[0]!.id;
      const first = msg({ accountId, date: NOW - 9000, providerThreadId: "t-old" });
      await store.sync.ingest([first], { applyFilters: true, now: NOW - 9000, classifier: null });
      await file(await threadOf(store, first.providerMsgId!), "bulk", NOW - 8000);
      const r = await store.sync.ingest([msg({ accountId, date: NOW - 1000, providerThreadId: "t-old" })], { applyFilters: true, now: NOW, classifier: null, forwardEligible: true });
      expect((await plan({ messageIds: r.inserted })).map((x) => x.messageId)).toEqual(r.inserted);
    });

    it("is the rule's from when it was turned on: earlier mail never; a new address list cancels what waited", async () => {
      const { store, cat, arrive, file, plan } = await setup({ trigger: false });
      const before = await arrive({}, NOW - 10);
      await store.forwards.setCategory(cat.id, { addresses: [ANA], enabled: true }, NOW);
      const after = await arrive({}, NOW + 10);
      await file(before.thread, "filter");
      await file(after.thread, "filter");
      const [row] = await plan({ messageIds: [before.id, after.id] }, NOW + 20);
      expect(row?.messageId).toBe(after.id);
      expect(await store.forwards.setCategory(cat.id, { addresses: [ANA], enabled: true }, NOW + 30)).toEqual({ changed: false });
      expect((await store.forwards.get(row!.id))?.state).toBe("waiting");
      expect(await store.forwards.setCategory(cat.id, { addresses: [LUIS], enabled: true }, NOW + 40)).toEqual({ changed: true });
      expect(await store.forwards.get(row!.id)).toMatchObject({ state: "cancelled", reason: "forward.reason.ruleChanged" });
    });

    it("claims a due forward: not before it's due; never to the sender or me; Spam, Trash and leaving the category cancel it", async () => {
      const { store, cat, arrive, file, plan, claim } = await setup();
      await store.forwards.setCategory(cat.id, { addresses: [ANA, LUIS, { name: "", email: "boss@books.test" }, { name: "", email: OWN[0]! }], enabled: true }, NOW - 500);
      const m = await arrive({ from: { name: "Boss", email: "Boss@books.test" } });
      await file(m.thread, "filter");
      const [row] = await plan({ messageIds: [m.id] });
      expect(await claim(row!.id, NOW + FORWARD_DELAY_MS - 1)).toEqual({ kind: "none" });
      const c = await claim(row!.id);
      expect(c).toMatchObject({ kind: "go", chunks: [[ANA, LUIS]], filesMissing: false, row: { state: "sending", to: [ANA, LUIS], opIds: [null] } });
      expect(await claim(row!.id)).toEqual({ kind: "none" });

      const spam = await arrive(), left = await arrive();
      await file(spam.thread, "filter");
      await file(left.thread, "filter");
      const rows = await plan({ messageIds: [spam.id, left.id] });
      await store.threads.act({ threadIds: [spam.thread], action: "spam", signal: null, now: NOW + 1 });
      await store.categories.remove({ categoryId: cat.id, threadIds: [left.thread], reason: "user", now: NOW + 1 });
      expect(await claim(rows.find((r) => r.messageId === spam.id)!.id)).toMatchObject({ kind: "cancelled", row: { state: "cancelled", reason: "forward.reason.trash" } });
      expect(await claim(rows.find((r) => r.messageId === left.id)!.id)).toMatchObject({ kind: "cancelled", row: { reason: "forward.reason.left" } });
      // filed back by hand: it goes again
      await file(left.thread, "user", NOW + 2);
      expect((await plan({ threadIds: [left.thread], filed: [left.thread] }, NOW + 2)).map((r) => r.messageId)).toEqual([left.id]);
    });

    it("sends a message to an address once, whatever rules name it", async () => {
      const { store, arrive, file, plan, claim } = await setup();
      const rule: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "factura" }], actions: [{ type: "forward", to: [ANA, LUIS] }] };
      const f = await store.filters.save({ name: "Facturas", enabled: true, source: "manual", rule }, NOW - 500);
      const m = await arrive({ subject: "Tu factura" });
      await file(m.thread, "filter");
      const rows = await plan({ messageIds: [m.id] });
      expect(rows.map((r) => r.ruleKind).sort()).toEqual(["category", "filter"]);
      const byCategory = rows.find((r) => r.ruleKind === "category")!, byFilter = rows.find((r) => r.ruleKind === "filter")!;
      expect(byFilter.ruleId).toBe(f.id);
      expect(await claim(byCategory.id)).toMatchObject({ kind: "go", chunks: [[ANA]] });
      expect(await claim(byFilter.id)).toMatchObject({ kind: "go", chunks: [[LUIS]] });
      // all of them owned already: nothing to send
      await store.filters.save({ id: f.id, name: "Facturas", enabled: true, source: "manual", rule: { ...rule, actions: [{ type: "forward", to: [ANA] }] } }, NOW);
      const again = await arrive({ subject: "Otra factura" }, NOW + 1);
      await file(again.thread, "filter", NOW + 1);
      const twice = await plan({ messageIds: [again.id] }, NOW + 1);
      expect(twice).toHaveLength(2);
      const first = twice.find((r) => r.ruleKind === "category")!, second = twice.find((r) => r.ruleKind === "filter")!;
      expect((await claim(first.id, NOW + 1 + FORWARD_DELAY_MS)).kind).toBe("go");
      expect(await claim(second.id, NOW + 1 + FORWARD_DELAY_MS)).toMatchObject({ kind: "cancelled", row: { reason: "forward.reason.alreadySent" } });
    });

    it("splits more than MAX_RECIPIENTS addresses into sends; each send is queued once", async () => {
      const { store, a, cat, arrive, file, plan, claim } = await setup();
      const many = Array.from({ length: MAX_RECIPIENTS + 2 }, (_, i) => ({ name: "", email: `p${i}@many.test` }));
      await store.forwards.setCategory(cat.id, { addresses: many, enabled: true }, NOW - 500);
      const m = await arrive();
      await file(m.thread, "filter");
      const [row] = await plan({ messageIds: [m.id] });
      const c = await claim(row!.id);
      if (c.kind !== "go") throw new Error("not claimed");
      expect(c.chunks.map((x) => x.length)).toEqual([MAX_RECIPIENTS, 2]);
      const send = (chunk: number) => store.compose.queueSend({ accountId: a, to: c.chunks[chunk]!, cc: [], bcc: [], subject: "Fwd: x", bodyText: "x", recordReply: false, forward: { id: row!.id, chunk }, now: NOW + FORWARD_DELAY_MS });
      const first = await send(0);
      await expect(send(0)).rejects.toMatchObject({ code: "STALE" });
      expect((await store.forwards.get(row!.id))?.state).toBe("sending");
      const second = await send(1);
      const store2 = await reopen(store);
      expect(await store2.forwards.get(row!.id)).toMatchObject({ state: "queued", opIds: [first.opId, second.opId] });
      await expect(store2.compose.queueSend({ accountId: a, to: [ANA], cc: [], bcc: [], subject: "x", bodyText: "x", recordReply: false, forward: { id: row!.id, chunk: 0 }, now: NOW })).rejects.toMatchObject({ code: "STALE" });
    });

    it("holds forwards past the cap until the user answers: Keep forwarding lets them wait their 10 s, Stop turns the rule off", async () => {
      const { store, cat, arrive, file, plan, claim } = await setup();
      const ids: number[] = [];
      for (let i = 0; i <= FORWARD_CAP; i++) {
        const m = await arrive();
        await file(m.thread, "filter");
        ids.push(...(await plan({ messageIds: [m.id] })).map((r) => r.id));
      }
      for (const id of ids.slice(0, FORWARD_CAP)) expect((await claim(id)).kind).toBe("go");
      expect(await claim(ids[FORWARD_CAP]!)).toMatchObject({ kind: "held", row: { state: "held" } });
      expect(await store.forwards.holds(NOW + FORWARD_DELAY_MS)).toEqual([{ rule: { kind: "category", id: cat.id }, count: FORWARD_CAP, held: 1 }]);
      const at = NOW + FORWARD_DELAY_MS + 5;
      expect(await store.forwards.approve({ kind: "category", id: cat.id }, at)).toBe(1);
      expect(await store.forwards.get(ids[FORWARD_CAP]!)).toMatchObject({ state: "waiting", dueAt: at + FORWARD_DELAY_MS });
      expect((await claim(ids[FORWARD_CAP]!, at + FORWARD_DELAY_MS)).kind).toBe("go");

      const next = await arrive({}, at);
      await file(next.thread, "filter", at);
      const [row] = await plan({ messageIds: [next.id] }, at);
      expect(await store.forwards.stop({ kind: "category", id: cat.id }, at + 1)).toBe(1);
      expect(await store.forwards.get(row!.id)).toMatchObject({ state: "cancelled", reason: "forward.reason.stopped" });
      expect((await store.categories.list()).find((c) => c.id === cat.id)?.forward).toEqual({ addresses: [ANA], enabled: false });
      expect(await store.forwards.active()).toBe(false);
    });

    it("cancels what still waits or is held; a held one nobody answered expires; old eligibility goes", async () => {
      const { store, arrive, file, plan, claim } = await setup();
      const m = await arrive();
      await file(m.thread, "filter");
      const [row] = await plan({ messageIds: [m.id] });
      expect((await store.forwards.cancel([row!.id], NOW + 1)).map((r) => r.state)).toEqual(["cancelled"]);
      expect(await claim(row!.id)).toEqual({ kind: "none" });
      expect(await store.forwards.cancel([row!.id], NOW + 2)).toEqual([]);
      expect(await store.forwards.eligiblePage(NOW, 0, 10)).toEqual([m.id]);
      await store.forwards.prune(NOW + FORWARD_ELIGIBLE_MS + 1);
      expect(await store.forwards.eligiblePage(NOW + FORWARD_ELIGIBLE_MS + 1, 0, 10)).toEqual([]);
      expect(await plan({ messageIds: [m.id] }, NOW + FORWARD_ELIGIBLE_MS + 2)).toEqual([]);
    });

    it("forwards what a filter matched as the mail arrived, never what it was applied to later; a paused filter shows it", async () => {
      const { store, cat, arrive, plan, claim } = await setup();
      await store.forwards.setCategory(cat.id, null, NOW - 900);
      const rule: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "recibo" }], actions: [{ type: "forward", to: [LUIS] }, { type: "markRead" }] };
      const f = await store.filters.save({ name: "Recibos", enabled: true, source: "manual", rule }, NOW - 800);
      const matched = await arrive({ subject: "Recibo 1" });
      const [row] = await plan({ messageIds: [matched.id] });
      expect(row).toMatchObject({ ruleKind: "filter", ruleId: f.id, to: [LUIS] });
      expect((await claim(row!.id)).kind).toBe("go");
      // applied later (the filter dialog's Apply): its application is too late to count
      const later = await arrive({ subject: "nada" });
      await store.filters.applyChunk(f.id, JSON.stringify(rule), [later.id], NOW + FORWARD_FILTER_LAG_MS + 1);
      expect(await plan({ messageIds: [later.id] }, NOW + FORWARD_FILTER_LAG_MS + 2)).toEqual([]);
      await store.forwards.stop({ kind: "filter", id: f.id }, NOW + 1);
      expect((await store.filters.get(f.id))?.forwardPaused).toBe(true);
      // saved again from the builder: on again
      await store.filters.save({ id: f.id, name: "Recibos", enabled: true, source: "manual", rule }, NOW + 2);
      expect((await store.filters.get(f.id))?.forwardPaused).toBeUndefined();
    });

    it("a failed forward (nothing queued) can be retried; it keeps its row across a reopen", async () => {
      const { store, arrive, file, plan, claim } = await setup();
      const m = await arrive();
      await file(m.thread, "filter");
      const [row] = await plan({ messageIds: [m.id] });
      await claim(row!.id);
      await store.forwards.fail(row!.id, "forward.reason.failed", NOW + FORWARD_DELAY_MS + 1);
      const s = await reopen(store);
      expect(await s.forwards.get(row!.id)).toMatchObject({ state: "failed", reason: "forward.reason.failed" });
      expect(await s.forwards.retry(row!.id, NOW + FORWARD_DELAY_MS + 2, [])).toMatchObject({ state: "waiting", dueAt: NOW + FORWARD_DELAY_MS + 2 });
      expect((await s.forwards.claim(row!.id, NOW + FORWARD_DELAY_MS + 2, { filesMissing: true, own: OWN })).kind).toBe("go");
      expect((await s.forwards.get(row!.id))?.filesMissing).toBe(true);
    });
  });
}
