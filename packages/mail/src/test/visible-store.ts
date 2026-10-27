import { afterEach, describe, expect, it } from "vitest";
import type { FilterRule } from "@terno/core";
import type { MailStore } from "@terno/store";
import { ingest, msg, withAccounts } from "../../../store/src/conformance/fixtures";
import { parseRaw } from "../mime";

export const visibleSource = (html: string) => `From: Sender <sender@example.test>\r\nSubject: Normalization\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;

export function defineVisibleStore(name: string, harness: { open(): Promise<MailStore>; reopen(store: MailStore): Promise<MailStore> }): void {
  let store: MailStore;
  afterEach(async () => { if (store?.isOpen) await store.close(); });
  describe(`HTML-only body rules and search: ${name}`, () => {
    it("does not archive/star for invisible text, while visible phrase rules/search survive reopen", async () => {
      store = await harness.open();
      const [accountId] = await withAccounts(store, 1);
      const rule = (value: string): FilterRule => ({ match: "all", conditions: [{ field: "body", op: "contains", value }], actions: [{ type: "archive" }, { type: "star" }] });
      await store.filters.save({ name: "hidden marker", enabled: true, source: "manual", rule: rule("phantomneedle") }, 0);
      await store.filters.save({ name: "visible phrase", enabled: true, source: "manual", rule: rule("visible phrase & café") }, 0);
      const bodies = [
        '<div hidden>phantomneedle</div><div style="display:none"><b>phantomneedle</b></div><span style="visibility:hidden">phantomneedle</span><p>Ordinary useful body</p>',
        '<p>VISible&nbsp; phrase &amp; caf&#233;</p><p>remaining body</p>',
      ];
      const incoming = await Promise.all(bodies.map(async (html, i) => {
        const parsed = await parseRaw(visibleSource(html));
        return msg({ accountId: accountId!, providerMsgId: `visible-${i}`, subject: parsed.subject, from: parsed.from, to: parsed.to, bodyText: parsed.text, bodyHtml: parsed.html });
      }));
      const result = await ingest(store, incoming);
      expect.soft(result.opIds).toHaveLength(2);
      for (let pass = 0; pass < 2; pass++) {
        const messages = (await store.debug.snapshot()).messages;
        const hidden = messages.find((m) => m.providerMsgId === "visible-0")!;
        const visible = messages.find((m) => m.providerMsgId === "visible-1")!;
        expect.soft((await store.threads.get(hidden.threadId))!).toMatchObject({ thread: { inInbox: true }, messages: [{ isStarred: false, bodyText: "Ordinary useful body" }] });
        expect.soft((await store.threads.get(visible.threadId))!).toMatchObject({ thread: { inInbox: false }, messages: [{ isStarred: true }] });
        expect.soft((await store.threads.searchText({ query: "phantomneedle", now: 0, limit: 10 })).items).toEqual([]);
        expect.soft((await store.threads.searchText({ query: '"visible phrase"', now: 0, limit: 10 })).items.map((t) => t.id)).toEqual([visible.threadId]);
        expect.soft((await store.threads.searchText({ query: "ordinary", now: 0, limit: 10 })).items.map((t) => t.id)).toEqual([hidden.threadId]);
        expect.soft(await store.filters.preview(rule("phantomneedle"), 0, 5)).toMatchObject({ count: 0 });
        expect.soft(await store.filters.preview(rule("visible phrase & café"), 0, 5)).toMatchObject({ count: 1 });
        if (!pass) store = await harness.reopen(store);
      }
      const ops = (await store.debug.snapshot()).ops;
      const visibleId = result.inserted[1]!;
      expect(ops.map((op) => ({ kind: op.kind, messageIds: op.messageIds })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([{ kind: "archive", messageIds: [visibleId] }, { kind: "star", messageIds: [visibleId] }]);
      await store.debug.verify();
    });
    it("uses parsed visible text for partial-body completion, claims actions once and replaces stale search after reopen", async () => {
      store = await harness.open();
      const [accountId] = await withAccounts(store, 1);
      const rule: FilterRule = { match: "all", conditions: [{ field: "body", op: "contains", value: "phantomneedle" }], actions: [{ type: "archive" }, { type: "star" }] };
      await store.filters.save({ name: "body policy", enabled: true, source: "manual", rule }, 0);
      const result = await ingest(store, [msg({ accountId: accountId!, providerMsgId: "partial", bodyState: "partial", bodyText: null })]);
      const id = result.inserted[0]!;
      const hidden = await parseRaw(visibleSource('<p style="display:none">phantomneedle</p><p>Useful body</p>'));
      expect((await store.sync.setBody(id, hidden.text, hidden.html, { now: 1, classifier: null })).opIds).toEqual([]);
      store = await harness.reopen(store);
      expect((await store.threads.searchText({ query: "phantomneedle", now: 1, limit: 5 })).items).toEqual([]);
      const visible = await parseRaw(visibleSource('<p>PHANTOM&#110;eedle visible body</p>'));
      expect((await store.sync.setBody(id, visible.text, visible.html, { now: 2, classifier: null })).opIds).toHaveLength(2);
      store = await harness.reopen(store);
      expect((await store.sync.setBody(id, visible.text, visible.html, { now: 3, classifier: null })).opIds).toEqual([]);
      const found = (await store.threads.searchText({ query: "phantomneedle", now: 3, limit: 5 })).items;
      expect(found).toHaveLength(1);
      expect((await store.threads.get(found[0]!.id))!).toMatchObject({ thread: { inInbox: false }, messages: [{ isStarred: true }] });
      const ops = (await store.debug.snapshot()).ops;
      expect(ops.filter((op) => op.kind === "archive")).toHaveLength(1);
      expect(ops.filter((op) => op.kind === "star")).toHaveLength(1);
      // Old cached fallback text is not migrated; an explicit body replacement removes it.
      expect((await store.sync.setBody(id, hidden.text, hidden.html, { now: 4, classifier: null })).opIds).toEqual([]);
      store = await harness.reopen(store);
      expect((await store.threads.searchText({ query: "phantomneedle", now: 4, limit: 5 })).items).toEqual([]);
      expect((await store.threads.searchText({ query: "useful", now: 4, limit: 5 })).items).toHaveLength(1);
      expect((await store.debug.snapshot()).ops).toHaveLength(2);
      await store.debug.verify();
    });
  });
}
