import { CategorizerModel, encodeFeatures, extractFeatures, PUT_AWAY_MS, type FilterRule } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 86_400_000;
const news = { name: "Xataka", email: "news@xataka.test" };
const javier = { name: "Javier Ortiz", email: "javier@acme.test" };

const from = (email: string, actions: FilterRule["actions"]): FilterRule => ({ match: "all", conditions: [{ field: "from", op: "equals", value: email }], actions });

/**
 * Plan 282: Put away. A placement is written when a rule on new mail or the engine takes a conversation out of the Inbox
 * view, kept while its effect holds and it isn't in Spam, ended by the user's own move; Needs a look first; a week's worth.
 */
export function definePutAwayConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("Put away (plan 282)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let seq = 0;
      const arrive = async (over: Partial<IncomingMessage> = {}, now = NOW) => {
        const id = `pa-${seq++}`;
        await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: id, from: news, date: now - 1000, ...over })], { applyFilters: true, now, classifier: null });
        return threadOf(store, id);
      };
      const rule = (email: string, actions: FilterRule["actions"], name = "Rule") => store.filters.save({ name, enabled: true, source: "manual", rule: from(email, actions) }, NOW - DAY);
      const listed = async (now = NOW) => (await store.putAway.page({ now, limit: 50 })).items.map((i) => i.thread.id);
      return { store, accountId: accountId!, arrive, rule, listed };
    }

    it("a rule that archives new mail puts it away; Back to Inbox hides it, its Undo shows it again, the user's own archive ends it", async () => {
      const { store, arrive, rule, listed } = await setup();
      const f = await rule(news.email, [{ type: "archive" }], "Xataka");
      const t = await arrive();
      const p = await store.putAway.of(t, NOW);
      expect(p).toMatchObject({ threadId: t, at: NOW, needsLook: false, ruleLive: true, detail: { by: "rule", filterId: f.id, name: "Xataka", auto: false, action: "archive", fromName: "Xataka" } });
      expect(await listed()).toEqual([t]);
      // back in the Inbox: no longer put away; its Undo takes it out again, and it's listed again
      const back = await store.threads.act({ threadIds: [t], action: "moveToInbox", signal: null, now: NOW + 1 });
      expect(await store.putAway.of(t, NOW + 1)).toBeNull();
      await store.threads.restore({ messages: back.before, now: NOW + 2 });
      expect(await listed(NOW + 2)).toEqual([t]);
      // back, then archived by the user: theirs now
      await store.threads.act({ threadIds: [t], action: "moveToInbox", signal: null, now: NOW + 3 });
      await store.threads.act({ threadIds: [t], action: "archive", signal: "archive", now: NOW + 4 });
      expect(await store.putAway.of(t, NOW + 4)).toBeNull();
      expect(await listed(NOW + 4)).toEqual([]);
    });

    it("only what took mail out of the Inbox: delete and a hidden filing do; read, star, Spam, a shown category and mail already out don't", async () => {
      const { store, arrive, rule, listed } = await setup();
      const hidden = await store.categories.create("Lecturas", "violet", { showInInbox: false });
      const shown = await store.categories.create("Clientes", "emerald");
      await rule("a@x.test", [{ type: "trash" }]);
      await rule("b@x.test", [{ type: "markRead" }, { type: "star" }]);
      await rule("c@x.test", [{ type: "spam" }]);
      await rule("d@x.test", [{ type: "addCategory", categoryId: shown.id }]);
      await rule("e@x.test", [{ type: "addCategory", categoryId: hidden.id }]);
      await rule("f@x.test", [{ type: "archive" }]);
      const trashed = await arrive({ from: { name: "A", email: "a@x.test" } });
      await arrive({ from: { name: "B", email: "b@x.test" } });
      await arrive({ from: { name: "C", email: "c@x.test" } });
      await arrive({ from: { name: "D", email: "d@x.test" } });
      const filed = await arrive({ from: { name: "E", email: "e@x.test" } });
      // already archived when it came: nothing took it out
      await arrive({ from: { name: "F", email: "f@x.test" }, inInbox: false });
      expect(new Set(await listed())).toEqual(new Set([trashed, filed]));
      expect(await store.putAway.of(trashed, NOW)).toMatchObject({ detail: { action: "trash" } });
      expect(await store.putAway.of(filed, NOW)).toMatchObject({ detail: { action: "addCategory", categoryId: hidden.id } });
      // Back to Inbox's other half: out of the rule's hidden category, no example; Undo files it back
      const released = await store.putAway.release([filed]);
      expect(released).toEqual([{ threadId: filed, categoryId: hidden.id }]);
      expect(await store.putAway.of(filed, NOW)).toBeNull();
      await store.putAway.refile(released, NOW);
      expect(await store.putAway.of(filed, NOW)).not.toBeNull();
      // the category shown again: the filing no longer keeps it out
      await store.categories.update(hidden.id, { showInInbox: true });
      expect(await store.putAway.of(filed, NOW)).toBeNull();
    });

    it("Spam ends it, and nothing in Spam is listed", async () => {
      const { store, arrive, rule, listed } = await setup();
      await rule(news.email, [{ type: "archive" }]);
      const t = await arrive();
      await store.threads.act({ threadIds: [t], action: "spam", signal: null, now: NOW + 1 });
      expect(await store.putAway.of(t, NOW + 1)).toBeNull();
      expect(await listed(NOW + 1)).toEqual([]);
      // ended, not only hidden: out of Spam and archived again, it isn't the rule's any more
      await store.threads.act({ threadIds: [t], action: "notSpam", signal: null, now: NOW + 2 });
      await store.threads.act({ threadIds: [t], action: "archive", signal: null, now: NOW + 3 });
      expect(await listed(NOW + 3)).toEqual([]);
    });

    it("a rule edited since no longer offers what it did; a week later it's gone, and the next placement prunes it", async () => {
      const { store, arrive, rule, listed } = await setup();
      const f = await rule(news.email, [{ type: "archive" }]);
      const t = await arrive();
      await store.filters.save({ id: f.id, name: f.name, enabled: true, source: "manual", rule: { ...f.rule, conditions: [{ field: "from", op: "contains", value: "xataka" }] } }, NOW);
      expect(await store.putAway.of(t, NOW)).toMatchObject({ ruleLive: false, detail: { name: "Rule" } });
      expect(await store.putAway.of(t, NOW + PUT_AWAY_MS - 1)).not.toBeNull();
      expect(await store.putAway.of(t, NOW + PUT_AWAY_MS)).toBeNull();
      const later = await arrive({ subject: "Later" }, NOW + PUT_AWAY_MS + DAY);
      expect(await listed(NOW + PUT_AWAY_MS + DAY)).toEqual([later]);
      // the old row went with the write (a week's worth), not only out of the window
      expect(await store.putAway.of(t, NOW)).toBeNull();
    });

    it("Needs a look: from someone you've written to, first, counted after what was seen; pages only append", async () => {
      const { store, accountId, arrive, rule, listed } = await setup();
      await rule(javier.email, [{ type: "archive" }]);
      await rule(news.email, [{ type: "archive" }]);
      // you wrote to Javier once
      await store.sync.ingest([msg({ accountId, providerMsgId: "sent", from: { name: "Me", email: "me0@example.com" }, to: [javier], isSent: true, inInbox: false, subject: "Hola", date: NOW - DAY })], { applyFilters: false, now: NOW - DAY, classifier: null });
      const a = await arrive({ subject: "a" }, NOW + 1);
      const look = await arrive({ from: javier, subject: "Reunión" }, NOW + 2);
      const b = await arrive({ subject: "b" }, NOW + 3);
      expect(await listed(NOW + 3)).toEqual([look, b, a]);
      expect(await store.putAway.of(look, NOW + 3)).toMatchObject({ needsLook: true, detail: { fromName: "Javier Ortiz" } });
      const seen = await store.putAway.needsLook({ now: NOW + 3, after: 0 });
      expect(seen).toEqual({ count: 1, first: { threadId: look, name: "Javier Ortiz" }, through: NOW + 2 });
      expect(await store.putAway.needsLook({ now: NOW + 3, after: seen.through })).toEqual({ count: 0, first: null, through: seen.through });
      // one at a time, the same order
      const ids: number[] = [];
      let after = null;
      for (;;) {
        const page = await store.putAway.page({ now: NOW + 3, after, limit: 1 });
        ids.push(...page.items.map((i) => i.thread.id));
        if (!page.next) break;
        after = page.next;
      }
      expect(ids).toEqual([look, b, a]);
    });

    it("survives a reopen", async () => {
      const { store, arrive, rule } = await setup();
      await rule(news.email, [{ type: "archive" }]);
      const t = await arrive();
      const again = await reopen(store);
      expect(await again.putAway.of(t, NOW)).toMatchObject({ detail: { by: "rule", action: "archive" } });
    });

    describe("Terno's own filing", () => {
      const sender = "billing@shop.test";
      /** a hidden category the engine files a sender's mail into on its own: the user's examples and a model trained on them */
      async function trained(store: MailStore, accountId: number, arrive: (over?: Partial<IncomingMessage>, now?: number) => Promise<number>) {
        const category = await store.categories.create("Facturas", "amber", { showInInbox: false });
        await store.categories.update(category.id, { autoApply: true });
        const model = new CategorizerModel({ decayRef: NOW });
        const enc = encodeFeatures(extractFeatures({ fromEmail: sender, fromName: "Shop", listId: null, subject: "Tu recibo", bodyText: "Total pagado", replied: false, attachmentNames: [] }, { ownDomains: new Set(["example.com"]) }));
        for (let i = 0; i < 12; i++) {
          const t = await arrive({ from: { name: "Shop", email: sender }, subject: "Tu recibo", bodyText: "Total pagado" }, NOW - DAY - i);
          await store.categories.add({ categoryId: category.id, threadIds: [t], addedBy: "user", now: NOW - DAY });
          model.train({ categoryId: category.id, label: 1, weight: 1, at: NOW, content: true, features: enc });
        }
        for (let i = 0; i < 200; i++) model.addBackground(10_000 + i, encodeFeatures(extractFeatures({ fromEmail: `amigo${i % 20}@gmail.com`, fromName: "Amigo", listId: null, subject: "Comida", bodyText: "Hola amigo", replied: false, attachmentNames: [] }, { ownDomains: new Set(["example.com"]) })));
        void accountId;
        return { category, classifier: { mode: "auto" as const, model } };
      }

      it("filed into a hidden category: put away with its reasons and sender; Don't file … automatically keeps the next one in the Inbox, and its Undo puts all back", async () => {
        const { store, accountId, arrive, listed } = await setup();
        const { category, classifier } = await trained(store, accountId, arrive);
        const ingest = async (id: string, now: number) => {
          await store.sync.ingest([msg({ accountId, providerMsgId: id, from: { name: "Shop", email: sender }, subject: "Tu recibo", bodyText: "Total pagado", date: now - 1000 })], { applyFilters: true, now, classifier });
          return threadOf(store, id);
        };
        const t = await ingest("filed", NOW);
        const p = await store.putAway.of(t, NOW);
        expect(p).toMatchObject({ detail: { by: "terno", categoryId: category.id, sender, fromName: "Shop" } });
        expect(p!.ruleLive).toBeUndefined();
        expect(await listed()).toContain(t);
        const kept = await store.putAway.keep({ categoryId: category.id, sender, threadId: t, now: NOW + 1 });
        expect(kept.added).toBe(true);
        expect(kept.withdrawn).toMatchObject({ threadId: t, categoryId: category.id });
        expect(await store.putAway.of(t, NOW + 1)).toBeNull();
        expect(await store.putAway.kept()).toEqual([{ categoryId: category.id, sender, at: NOW + 1 }]);
        // the next one is asked about, never filed
        const next = await ingest("next", NOW + 2);
        expect((await store.threads.get(next))!.categorization.auto).toEqual([]);
        expect((await store.threads.get(next))!.categorization.suggestions.map((s) => s.categoryId)).toContain(category.id);
        await store.putAway.unkeep({ categoryId: category.id, sender, ...kept });
        expect(await store.putAway.kept()).toEqual([]);
        expect(await store.putAway.of(t, NOW + 3)).toMatchObject({ detail: { by: "terno" } });
        expect((await store.threads.get(t))!.categorization.auto.map((a) => a.categoryId)).toEqual([category.id]);
      });
    });
  });
}
