import { PERSON_RULES_MAX, type Address } from "@terno/core";
import { generateDataset } from "@terno/mock-data";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { oracleFacts } from "./facts";
import { backfillFacts, ingest, msg, seedThroughCommands, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 86_400_000;
const addr = (email: string, name = ""): Address => ({ name, email });
const me = addr("me0@example.com", "Me");
const SES = (n: number) => `0100${n}-abc-000000@email.amazonses.com`;

/**
 * Plan 278: who is a person, corrected. Mail a sending service sent is never a person's, even from an address you wrote to;
 * your word on a sender (`facts.rules`) outranks every guess but Spam's, one command with their threads' facts and an exact
 * Undo (`restore`); a mailbox whose facts were computed with older rules is checked again once, facts alone.
 */
export function definePersonRulesConformance(fresh: () => Promise<MailStore>, reopen: (store: MailStore) => Promise<MailStore>): void {
  describe("who is a person, corrected (plan 278)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let seq = 0;
      const put = async (from: Address, over: Partial<Parameters<typeof msg>[0]> = {}) => {
        const id = `p-${seq++}`;
        await ingest(store, [msg({ accountId: accountId!, providerMsgId: id, from, to: [me], date: NOW - DAY + seq, ...over })], NOW);
        return threadOf(store, id);
      };
      const person = async (thread: number) => (await store.threads.summaries([thread]))[0]!.person;
      const waiting = async (thread: number) => (await store.threads.summaries([thread]))[0]!.waitingSince != null;
      const people = async () => (await store.threads.list({ view: "inbox", filter: "people", now: NOW, limit: 50 })).items.map((t) => t.id);
      return { store, accountId: accountId!, put, person, waiting, people };
    }

    it("an app's mail through a sending service isn't a person's, even from an address you wrote to; Always makes it one, Never takes a person out", async () => {
      const { store, accountId, put, person, waiting, people } = await setup();
      // you wrote to the app's support address once
      await ingest(store, [msg({ accountId, providerMsgId: "wrote", from: me, to: [addr("sac@tilopay.test")], isSent: true, inInbox: false, date: NOW - 2 * DAY })], NOW);
      const receipt = await put(addr("sac@tilopay.test", "Tilopay"), { rfcMessageId: "xb0ge6g@geopod-ismtpd-54" });
      const support = await put(addr("sac@tilopay.test", "Tilopay"), { rfcMessageId: "a1@mail.tilopay.test", providerThreadId: "support" });
      const ana = await put(addr("ana@friends.test", "Ana"));
      expect([await person(receipt), await person(support), await person(ana)]).toEqual([false, true, true]);
      expect(await waiting(receipt)).toBe(false);
      expect(new Set(await people())).toEqual(new Set([support, ana]));

      const always = await store.facts.rules.set({ id: "r1", email: "SAC+x@Tilopay.test", name: "Tilopay", person: true, at: NOW });
      expect(always).toMatchObject({ set: { id: "r1", key: "sac@tilopay.test", person: true }, prior: null });
      expect(new Set(always !== "full" ? always.threadIds : [])).toEqual(new Set([receipt, support]));
      expect([await person(receipt), await waiting(receipt)]).toEqual([true, true]);

      const never = await store.facts.rules.set({ id: "r2", email: "ana@friends.test", name: "Ana", person: false, at: NOW + 1 });
      expect(never).toMatchObject({ set: { id: "r2", person: false }, prior: null });
      expect([await person(ana), await waiting(ana)]).toEqual([false, false]);
      expect(new Set(await people())).toEqual(new Set([receipt, support]));
      // the "to reply to" count follows
      expect((await store.threads.counts(NOW)).inboxWaiting).toBe(2);
      // new mail from them is judged by the rule as it comes
      expect(await person(await put(addr("ana@friends.test"), { subject: "again" }))).toBe(false);
    });

    it("the same rule again changes nothing; the other replaces it (prior, for the Undo); remove takes only its own entry", async () => {
      const { store, put, person } = await setup();
      const t = await put(addr("carlos@acme.test"));
      await store.facts.rules.set({ id: "a", email: "carlos@acme.test", name: "Carlos", person: false, at: NOW });
      expect(await store.facts.rules.set({ id: "b", email: "carlos@acme.test", name: "Carlos", person: false, at: NOW + 1 })).toEqual({ set: null, prior: null, threadIds: [] });
      const flip = await store.facts.rules.set({ id: "c", email: "carlos@acme.test", name: "Carlos", person: true, at: NOW + 2 });
      expect(flip).toMatchObject({ set: { id: "c", person: true }, prior: { id: "a", person: false, at: NOW } });
      expect(await person(t)).toBe(true);
      expect(await store.facts.rules.remove("carlos@acme.test", "a")).toEqual({ removed: null, threadIds: [] });
      const gone = await store.facts.rules.remove("carlos@acme.test", "c");
      expect(gone.removed).toMatchObject({ id: "c" });
      expect(gone.threadIds).toEqual([t]);
      expect(await store.facts.rules.list()).toEqual([]);
    });

    it("restore is an exact Undo: only while the rule is still the one it expects, never over a later change", async () => {
      const { store, put, person } = await setup();
      const t = await put(addr("carlos@acme.test"));
      const set = await store.facts.rules.set({ id: "a", email: "carlos@acme.test", name: "Carlos", person: false, at: NOW });
      const a = set !== "full" ? set.set! : null;
      // Undo of a first rule: none again
      expect(await store.facts.rules.restore("carlos@acme.test", "a", null)).toEqual({ restored: true, threadIds: [t] });
      expect(await person(t)).toBe(true);
      // Undo of a removal: the same entry back, only while none is there
      await store.facts.rules.set({ id: "b", email: "carlos@acme.test", name: "Carlos", person: false, at: NOW + 1 });
      expect(await store.facts.rules.restore("carlos@acme.test", null, a)).toEqual({ restored: false, threadIds: [] });
      expect((await store.facts.rules.list()).map((r) => r.id)).toEqual(["b"]);
      await store.facts.rules.remove("carlos@acme.test");
      expect((await store.facts.rules.restore("carlos@acme.test", null, a)).restored).toBe(true);
      expect(await store.facts.rules.list()).toEqual([a]);
      expect(await person(t)).toBe(false);
      // Undo of a replacement: the prior back only over the rule that replaced it
      const flip = await store.facts.rules.set({ id: "c", email: "carlos@acme.test", name: "Carlos", person: true, at: NOW + 2 });
      const prior = flip !== "full" ? flip.prior : null;
      expect((await store.facts.rules.restore("carlos@acme.test", "zzz", prior)).restored).toBe(false);
      expect((await store.facts.rules.restore("carlos@acme.test", "c", prior)).restored).toBe(true);
      expect(await store.facts.rules.list()).toEqual([a]);
    });

    it("kept newest first through a reopen; at the cap a new sender is refused, a change to one there and an Undo are not", async () => {
      const { store: s } = await setup();
      await s.facts.rules.set({ id: "x", email: "x@a.test", name: "X", person: false, at: NOW - 2 });
      await s.facts.rules.set({ id: "y", email: "y@a.test", name: "Y".repeat(300), person: true, at: NOW - 1 });
      const store = await reopen(s);
      const kept = await store.facts.rules.list();
      expect(kept.map((r) => [r.id, r.person, r.name.length])).toEqual([["y", true, 200], ["x", false, 1]]);
      for (let i = 2; i < PERSON_RULES_MAX; i++) await store.facts.rules.set({ id: `n${i}`, email: `n${i}@a.test`, name: "", person: false, at: NOW + i });
      expect(await store.facts.rules.set({ id: "over", email: "over@a.test", name: "", person: false, at: NOW })).toBe("full");
      expect(await store.facts.rules.set({ id: "x2", email: "x@a.test", name: "X", person: true, at: NOW })).toMatchObject({ prior: { id: "x" } });
      await store.facts.rules.remove("n2@a.test");
      await store.facts.rules.set({ id: "fill", email: "fill@a.test", name: "", person: false, at: NOW });
      expect((await store.facts.rules.restore("n2@a.test", null, { id: "n2", key: "n2@a.test", email: "n2@a.test", name: "", person: false, at: NOW + 2 })).restored).toBe(true);
      expect((await store.facts.rules.list()).length).toBe(PERSON_RULES_MAX + 1);
    });

    it("a sender with more threads than a command recomputes: the facts' job flips them, the rule already kept", async () => {
      const { store, accountId, person } = await setup();
      await ingest(store, Array.from({ length: 205 }, (_, i) => msg({ accountId, providerMsgId: `many-${i}`, providerThreadId: `many-${i}`, from: addr("carlos@acme.test"), to: [me], date: NOW - DAY + i })), NOW);
      const first = await threadOf(store, "many-0");
      const r = await store.facts.rules.set({ id: "a", email: "carlos@acme.test", name: "Carlos", person: false, at: NOW });
      expect(r).toMatchObject({ threadIds: [] });
      expect(await store.facts.idle()).toBe(false);
      await backfillFacts(store, 37);
      expect(await store.facts.idle()).toBe(true);
      expect(await person(first)).toBe(false);
      expect((await store.threads.list({ view: "inbox", filter: "people", now: NOW, limit: 10 })).items).toEqual([]);
    });

    it("facts computed with older rules are checked again once, in slices: not ready meanwhile, equal to the definition after, the tabs untouched", async () => {
      const store = await fresh();
      await seedThroughCommands(store, generateDataset({ threads: 300, accounts: 2, seed: 7, now: NOW }), NOW);
      const [accountId] = (await store.debug.snapshot()).accounts.map((a) => a.id);
      await ingest(store, [msg({ accountId: accountId!, providerMsgId: "ses", from: addr("hello@app.test"), to: [me], rfcMessageId: SES(1), date: NOW - DAY })], NOW);
      await backfillFacts(store);
      expect(await store.tabs.idle()).toBe(true);
      await store.debug.stampRules(1);
      expect(await store.facts.idle()).toBe(false);
      expect((await store.threads.counts(NOW)).inboxWaiting).toBeNull();
      const slices = await backfillFacts(store, 29);
      expect(slices).toBeGreaterThan(5);
      expect(await store.facts.idle()).toBe(true);
      expect(await store.tabs.idle()).toBe(true);
      const snap = await store.debug.snapshot();
      const oracle = oracleFacts(snap);
      for (const t of snap.threads) expect({ person: t.person ? 1 : 0, waitingSince: t.waitingSince }, `thread ${t.id}`).toEqual(oracle.get(t.id));
      expect(snap.threads.find((t) => t.id === snap.messages.find((m) => m.providerMsgId === "ses")!.threadId)!.person).toBe(false);
      // once: a reopened store has nothing left to do
      expect(await (await reopen(store)).facts.idle()).toBe(true);
    });
  });
}
