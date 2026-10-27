import type { FilterRule } from "@terno/core";
import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { StoreHarness } from "./store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

const NOW = 1_800_000_000_000;
const body = (negate = false): FilterRule["conditions"][number] => ({ field: "body", op: "contains", value: "blocked", negate });

export function defineBodyCaptureConformance(name: string, h: StoreHarness): void {
  let store: MailStore;
  afterEach(async () => { if (store?.isOpen) await store.close(); });
  describe(`body capture: ${name}`, () => {
    for (const state of ["none", "partial"] as const) {
      for (const variant of ["positive", "negative", "any"] as const) {
        it(`${state} bodies defer ${variant} body rules through reopen and apply once after repair`, async () => {
          store = await h.open();
          const [accountId] = await withAccounts(store, 1);
          const rule: FilterRule = {
            match: variant === "any" ? "any" : "all",
            conditions: variant === "any" ? [body(), { field: "subject", op: "contains", value: "matching" }] : [body(variant === "negative")],
            actions: [{ type: "archive" }],
          };
          const filter = await store.filters.save({ name: "body policy", enabled: true, source: "manual", rule }, NOW);
          const incoming = msg({ accountId: accountId!, providerMsgId: "incomplete", subject: "matching", bodyState: state, bodyText: state === "none" ? null : variant === "negative" ? "safe prefix" : "blocked prefix" });
          const first = await ingest(store, [incoming], NOW);
          expect(first.opIds).toEqual([]);
          let message = (await store.debug.snapshot()).messages[0]!;
          expect(message.inInbox).toBe(true);
          expect(await store.filters.preview(rule, NOW, 5)).toMatchObject({ count: 0 });
          expect(await store.filters.matchWindow(rule, NOW, { from: message.id, to: message.id })).toEqual([]);
          const headerRule: FilterRule = { match: "all", conditions: [{ field: "subject", op: "contains", value: "matching" }], actions: [{ type: "star" }] };
          expect(await store.filters.matchWindow(headerRule, NOW, { from: message.id, to: message.id })).toEqual([message.id]);
          expect(await store.filters.applyChunk(filter.id, JSON.stringify(rule), [message.id], NOW)).toMatchObject({ applied: 0, opIds: [] });
          store = await h.reopen(store);
          expect(await store.filters.preview(rule, NOW, 5)).toMatchObject({ count: 0 });
          const repaired = await store.sync.setBody(message.id, variant === "negative" ? "safe complete body" : "blocked complete body", null, { now: NOW + 1, classifier: null });
          expect(repaired.opIds).toHaveLength(1);
          message = (await store.debug.snapshot()).messages[0]!;
          expect(message).toMatchObject({ bodyState: "full", inInbox: false });
          const repeated = await store.sync.setBody(message.id, variant === "negative" ? "safe complete body" : "blocked complete body", null, { now: NOW + 2, classifier: null });
          expect(repeated.opIds).toEqual([]);
          expect((await store.debug.snapshot()).ops.filter((o) => o.kind === "archive")).toHaveLength(1);
          expect((await store.filters.list()).find((f) => f.id === filter.id)).toBeDefined();
          await store.debug.verify();
        });
      }
    }
    it("treats a full empty body as eligible for negated rules", async () => {
      store = await h.open(); const [accountId] = await withAccounts(store, 1);
      const rule: FilterRule = { match: "all", conditions: [body(true)], actions: [{ type: "archive" }] };
      await store.filters.save({ name: "body policy", enabled: true, source: "manual", rule }, NOW);
      const result = await ingest(store, [msg({ accountId: accountId!, bodyState: "full", bodyText: null })], NOW);
      expect(result.opIds).toHaveLength(1);
    });
    it("retains complete cached content, search and attachment bytes after an unavailable capture and reopen", async () => {
      store = await h.open(); const [accountId] = await withAccounts(store, 1);
      const initial = msg({ accountId: accountId!, providerMsgId: "cached", bodyText: "cached unique searchable words", bodyHtml: "<p>cached HTML</p>", attachments: [{ filename: "cached.dat", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] });
      await ingest(store, [initial], NOW);
      const threadId = await threadOf(store, "cached");
      const original = (await store.threads.get(threadId))!.messages[0]!;
      const result = await store.sync.setBody(original.id, null, null, { now: NOW + 1, classifier: null, attachments: [], captureUnavailable: "size" });
      expect(result.opIds).toEqual([]);
      store = await h.reopen(store);
      const cached = (await store.threads.get(threadId))!.messages[0]!;
      expect(cached).toMatchObject({ bodyText: initial.bodyText, bodyHtml: initial.bodyHtml, bodyState: "full", attachments: original.attachments });
      const search = await store.threads.searchText({ query: "searchable", limit: 20, now: NOW });
      expect(search.items.map((t) => t.id)).toContain(threadId);
      expect(await store.attachments.read(accountId!, cached.attachments[0]!.assetId!, 0)).toBe("AP+A");
      await store.attachments.retry(accountId!, original.id);
      await store.sync.setBody(original.id, "new repaired content", "<p>new</p>", { now: NOW + 2, classifier: null, attachments: [] });
      store = await h.reopen(store);
      expect((await store.threads.get(threadId))!.messages[0]).toMatchObject({ bodyText: "new repaired content", bodyHtml: "<p>new</p>", bodyState: "full", attachments: [] });
      await store.debug.verify();
    });
  });
}
