import { CategorizerModel, POLICY } from "@terno/core";
import { describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { IncomingMessage } from "../types";
import { msg, threadOf, withAccounts } from "./fixtures";

const NOW = Date.UTC(2026, 10, 4, 12);
const DAY = 86_400_000;

/**
 * Plan 134: what the AI is told a category holds comes only from the user's own placements; an AI filing re-reads every
 * rule in its transaction, downgrades to a suggestion where a model shouldn't decide, and behaves like the engine's own
 * filing afterwards.
 */
export function defineSmartCategorizationConformance(fresh: () => Promise<MailStore>): void {
  describe("smart categorization (plan 134)", () => {
    async function setup() {
      const store = await fresh();
      const [accountId] = await withAccounts(store, 1);
      let n = 0;
      const thread = async (over: Partial<IncomingMessage> = {}) => {
        const i = ++n;
        const m = msg({ accountId: accountId!, subject: `Subject ${i}`, from: { name: `Sender ${i}`, email: `person${i}@shop${i}.example` }, date: NOW - 60_000, ...over });
        await store.sync.ingest([m], { applyFilters: true, now: NOW, classifier: null });
        return threadOf(store, m.providerMsgId!);
      };
      const filing = (threadId: number, categoryId: number, sender = "ana@studio.example") => ({
        threadId,
        categoryId,
        p: 0.99,
        explain: [{ k: "reason.aiFiled" as const, p: { provider: "JEV", category: "c" } }],
        suggestExplain: [{ k: "reason.aiCloud" as const, p: { provider: "JEV", category: "c" } }],
        sender,
        encoded: new Uint32Array(),
        model: new CategorizerModel({ decayRef: NOW }),
        now: NOW,
      });
      /** a category that may be filed into: enough of the user's examples */
      const trained = async (name = "Invoices") => {
        const category = await store.categories.create(name, "amber");
        for (let i = 0; i < POLICY.autoMinPositives; i++) await store.categories.add({ categoryId: category.id, threadIds: [await thread()], addedBy: "user", now: NOW - DAY });
        return category;
      };
      const detail = async (threadId: number) => (await store.threads.get(threadId))!.categorization;
      return { store, accountId: accountId!, thread, filing, trained, detail };
    }

    describe("categoryEvidence", () => {
      it("samples only what the user placed: an agent's example, a filter's add and the AI's own filing never appear", async () => {
        const { store, thread, filing, trained } = await setup();
        const category = await trained();
        const byHand = await thread({ subject: "By hand", from: { name: "Ana", email: "ana@studio.example" } });
        const accepted = await thread({ subject: "Accepted", from: { name: "Bea", email: "bea@studio.example" } });
        const bulk = await thread({ subject: "Bulk", from: { name: "Cal", email: "cal@studio.example" } });
        const agent = await thread({ subject: "By agent" });
        const filter = await thread({ subject: "By filter" });
        await store.categories.add({ categoryId: category.id, threadIds: [byHand], addedBy: "user", now: NOW + 1 });
        await store.categories.add({ categoryId: category.id, threadIds: [accepted], addedBy: "suggestion", now: NOW + 2 });
        await store.categories.add({ categoryId: category.id, threadIds: [bulk], addedBy: "bulk", now: NOW + 3 });
        await store.categories.add({ categoryId: category.id, threadIds: [agent], addedBy: "agent", now: NOW + 4 });
        await store.categories.add({ categoryId: category.id, threadIds: [filter], addedBy: "filter", now: NOW + 5 });
        const filed = await thread({ subject: "By the AI" });
        expect((await store.categorize.recordAiFiling(filing(filed, category.id))).outcome).toBe("filed");
        const [row] = await store.categorize.categoryEvidence({ perCategory: 3, limit: 100 });
        expect(row).toMatchObject({ id: category.id, name: "Invoices" });
        expect(row!.samples).toEqual([
          { fromName: "Cal", fromDomain: "studio.example", subject: "Bulk" },
          { fromName: "Bea", fromDomain: "studio.example", subject: "Accepted" },
          { fromName: "Ana", fromDomain: "studio.example", subject: "By hand" },
        ]);
        // a domain, never an address
        expect(JSON.stringify(row)).not.toContain("@");
      });

      it("a category with nothing placed is offered by name; a deleted one and a deleted thread are gone; spam says nothing", async () => {
        const { store, thread, accountId } = await setup();
        const empty = await store.categories.create("Empty", "cyan");
        const gone = await store.categories.create("Gone", "rose");
        const kept = await store.categories.create("Kept", "emerald");
        await store.categories.add({ categoryId: gone.id, threadIds: [await thread()], addedBy: "user", now: NOW });
        const spam = await thread({ subject: "Spam now", isSpam: true });
        const vanishing = msg({ accountId, subject: "Vanishes", date: NOW - 60_000 });
        const inserted = (await store.sync.ingest([vanishing], { applyFilters: true, now: NOW, classifier: null })).inserted;
        const vanishingThread = await threadOf(store, vanishing.providerMsgId!);
        await store.categories.add({ categoryId: kept.id, threadIds: [spam, vanishingThread], addedBy: "user", now: NOW });
        await store.categories.delete(gone.id);
        await store.sync.remove(inserted);
        const rows = await store.categorize.categoryEvidence({ perCategory: 3, limit: 100 });
        expect(rows.map((r) => r.name).sort()).toEqual(["Empty", "Kept"]);
        expect(rows.find((r) => r.id === empty.id)).toMatchObject({ positives: 0, samples: [] });
        expect(rows.find((r) => r.id === kept.id)!.samples).toEqual([]);
      });

      it("caps samples per category, and keeps the most recently used categories", async () => {
        const { store, thread } = await setup();
        const old = await store.categories.create("Old", "cyan");
        const recent = await store.categories.create("Recent", "rose");
        const unused = await store.categories.create("Unused", "emerald");
        for (let i = 0; i < 5; i++) await store.categories.add({ categoryId: recent.id, threadIds: [await thread()], addedBy: "user", now: NOW + i });
        await store.categories.add({ categoryId: old.id, threadIds: [await thread()], addedBy: "user", now: NOW - DAY });
        const rows = await store.categorize.categoryEvidence({ perCategory: 2, limit: 2 });
        expect(rows.map((r) => r.id)).toEqual([recent.id, old.id]);
        expect(rows[0]).toMatchObject({ positives: 5 });
        expect(rows[0]!.samples).toHaveLength(2);
        expect(rows.some((r) => r.id === unused.id)).toBe(false);
      });
    });

    describe("recordAiFiling", () => {
      it("files like the engine: auto, with its reason, and never trains", async () => {
        const { store, thread, filing, trained, detail } = await setup();
        const category = await trained();
        const before = (await store.categorize.examples()).length;
        const t = await thread();
        const r = await store.categorize.recordAiFiling(filing(t, category.id));
        expect(r).toEqual({ outcome: "filed", deltas: [{ op: "unbackground", threadId: t }] });
        expect((await detail(t)).auto).toMatchObject([{ categoryId: category.id, reasons: [{ k: "reason.aiFiled" }] }]);
        expect((await store.categorize.examples()).length).toBe(before);
        // once decided, a second answer writes nothing
        expect((await store.categorize.recordAiFiling(filing(t, category.id))).outcome).toBe("none");
      });

      it.each(["autoApply off", "too few examples", "hidden", "forwarding"] as const)("%s, changed while the provider answered, becomes a suggestion", async (change) => {
        const { store, thread, filing, trained, detail } = await setup();
        const category = change === "too few examples" ? await store.categories.create("New", "amber") : await trained();
        const t = await thread();
        if (change === "autoApply off") await store.categories.update(category.id, { autoApply: false });
        if (change === "hidden") await store.categories.update(category.id, { showInInbox: false });
        if (change === "forwarding") await store.forwards.setCategory(category.id, { addresses: [{ name: "", email: "elsewhere@example.com" }], enabled: true }, NOW);
        const r = await store.categorize.recordAiFiling(filing(t, category.id));
        expect(r).toEqual({ outcome: "suggested", deltas: [] });
        const seen = await detail(t);
        expect(seen.auto).toEqual([]);
        expect(seen.suggestions).toMatchObject([{ categoryId: category.id, p: 0.99, reasons: [{ k: "reason.aiCloud" }] }]);
      });

      it("a veto or someone's decision writes nothing", async () => {
        const { store, thread, filing, trained, detail } = await setup();
        const category = await trained();
        // the user took this very thread out of the category
        const hard = await thread();
        await store.categories.add({ categoryId: category.id, threadIds: [hard], addedBy: "user", now: NOW });
        await store.categories.remove({ categoryId: category.id, threadIds: [hard], reason: "user", now: NOW });
        expect((await store.categorize.recordAiFiling(filing(hard, category.id))).outcome).toBe("none");
        // a sender the user keeps taking out of it
        const a = await thread({ from: { name: "S", email: "s@spammy.example" } });
        const b = await thread({ from: { name: "S", email: "s@spammy.example" } });
        for (const id of [a, b]) {
          await store.categories.add({ categoryId: category.id, threadIds: [id], addedBy: "auto", now: NOW });
          await store.categories.remove({ categoryId: category.id, threadIds: [id], reason: "user", now: NOW });
        }
        const sender = await thread({ from: { name: "S", email: "s@spammy.example" } });
        expect((await store.categorize.recordAiFiling(filing(sender, category.id, "s@spammy.example"))).outcome).toBe("none");
        expect((await detail(sender)).suggestions).toEqual([]);
        // the user placed it while the provider answered
        const placed = await thread();
        const other = await store.categories.create("Other", "emerald");
        await store.categories.add({ categoryId: other.id, threadIds: [placed], addedBy: "user", now: NOW });
        expect((await store.categorize.recordAiFiling(filing(placed, category.id))).outcome).toBe("none");
        // gone, while the provider answered
        const t = await thread();
        await store.categories.delete(other.id);
        expect((await store.categorize.recordAiFiling(filing(t, other.id))).outcome).toBe("none");
      });

      it("removal is a revert, and reverts close the safety valve: the next one is a suggestion", async () => {
        const { store, thread, filing, trained, detail } = await setup();
        const category = await trained();
        const filed: number[] = [];
        for (let i = 0; i < POLICY.valveMinMatured; i++) {
          const t = await thread();
          expect((await store.categorize.recordAiFiling(filing(t, category.id))).outcome).toBe("filed");
          filed.push(t);
        }
        const positives = (await store.categorize.examples()).filter((e) => e.categoryId === category.id && e.label > 0).length;
        await store.categories.remove({ categoryId: category.id, threadIds: filed.slice(0, 3), reason: "user", now: NOW + 1 });
        // a filing taken back teaches a removal, never a positive
        expect((await store.categorize.examples()).filter((e) => e.categoryId === category.id && e.label > 0).length).toBe(positives);
        await store.categorize.matureDecisions(NOW + (POLICY.revertWindowDays + 1) * DAY);
        expect((await store.categorize.stats()).find((s) => s.categoryId === category.id)?.paused).toBe(true);
        const next = await thread();
        expect((await store.categorize.recordAiFiling(filing(next, category.id))).outcome).toBe("suggested");
        expect((await detail(next)).auto).toEqual([]);
      });
    });
  });
}
