import { findUnsubscribeLink } from "@terno/core";
import { expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import { msg, withAccounts } from "./fixtures";

export function defineExactBodyLifecycle(open: () => Promise<{ store: MailStore; reopen(): Promise<MailStore>; dispose(): Promise<void>; interrupt(work: () => Promise<unknown>): Promise<void> }>): void {
  it("publishes exact replacements only after preparation, retaining cached bytes and effects on failure", async () => {
    const fixture = await open(); let store = fixture.store;
    try {
      const [accountId] = await withAccounts(store, 1);
      const old = "old cached boundary phrase ".repeat(4000), next = "😀e\u0301\r\nnew exact boundary phrase ".repeat(4000);
      const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: old, bodyHtml: `<p>${old}</p>`, bodyState: "full", isStarred: true, attachments: [{ filename: "exact.bin", mime: "application/octet-stream", size: 3, bytes: new Uint8Array([0, 255, 128]) }] })], { now: 1, classifier: null, applyFilters: false });
      const id = result.touched[0]!, initial = (await store.threads.get(id))!.messages[0]!;
      for (let cycle = 0; cycle < 3; cycle++) {
        await fixture.interrupt(() => store.sync.setBody(initial.id, next, `<p>${next}</p>`, { now: 2, classifier: null }));
        const preserved = (await store.threads.get(id))!.messages[0]!;
        expect(preserved.bodyText === old).toBe(true); expect(preserved.isStarred).toBe(true);
        expect(await store.attachments.read(accountId!, preserved.attachments[0]!.assetId!, 0)).toBe("AP+A");
        expect((await store.threads.searchText({ query: '"new exact boundary"', limit: 10, now: 2 })).items).toHaveLength(0);
      }
      await store.sync.setBody(initial.id, next, `<p>${next}</p>`, { now: 3, classifier: null });
      store = await fixture.reopen();
      const complete = (await store.threads.get(id))!.messages[0]!;
      expect(complete.bodyText === next).toBe(true); expect(complete.bodyHtml === `<p>${next}</p>`).toBe(true); expect(complete.isStarred).toBe(true);
      expect(await store.attachments.read(accountId!, complete.attachments[0]!.assetId!, 0)).toBe("AP+A");
      expect((await store.threads.searchText({ query: '"new exact boundary"', limit: 10, now: 3 })).items.map((t) => t.id)).toEqual([id]);
      expect((await store.filters.preview({ match: "all", conditions: [{ field: "body", op: "contains", value: "new exact boundary" }], actions: [{ type: "star" }] }, 3, 10)).count).toBe(1);
      await expect(store.threads.bodyPart!({ accountId: accountId! + 1, messageId: initial.id, version: (await store.threads.get(id, { bodyFormat: "parts" }))!.messages[0]!.bodyReference!.version, field: "text", ordinal: 0 })).rejects.toThrow();
    } finally { await store.close(); await fixture.dispose(); }
  });
  it("keeps direct local-copy body publication compatible with later incoming replacement", async () => {
    const fixture = await open(); let store = fixture.store;
    try {
      const [accountId] = await withAccounts(store, 1), text = "😀 exact local boundary phrase ".repeat(3000), html = `<p>${text}</p>`;
      const sent = await store.compose.queueSend({ accountId: accountId!, to: [{ name: "", email: "synthetic@example.test" }], cc: [], bcc: [], subject: "synthetic", bodyText: text, bodyHtml: html, recordReply: false, now: 1 });
      const reference = (await store.threads.get(sent.threadId, { bodyFormat: "parts" }))!.messages[0]!;
      expect(reference.bodyReference, "a direct caller must not reintroduce a large monolithic stored row").toBeDefined();
      const message = (await store.threads.get(sent.threadId))!.messages[0]!;
      expect(message.bodyText === text).toBe(true); expect(message.bodyHtml === html).toBe(true);
      const [op] = await store.ops.claimReady(1, 10);
      const payload = JSON.parse(op!.payload_json) as { text: string; html: string };
      expect(payload.text === text && payload.html === html).toBe(true);
      await store.sync.ingest([msg({ accountId: accountId!, providerMsgId: "saved-copy", rfcMessageId: message.rfcMessageId, isSent: true, bodyText: text, bodyHtml: html, bodyState: "full" })], { now: 2, classifier: null, applyFilters: false });
      store = await fixture.reopen();
      const adopted = (await store.threads.get(sent.threadId))!.messages[0]!;
      expect(adopted.id).toBe(message.id); expect(adopted.bodyText === text && adopted.bodyHtml === html).toBe(true);
    } finally { await store.close(); await fixture.dispose(); }
  });

  it("preserves same-message, phrase, negative-thread and Unicode semantics across exact parts", async () => {
    const fixture = await open(), store = fixture.store;
    try {
      const [accountId] = await withAccounts(store, 1), text = `${"p ".repeat(16380)}alpha beta e\u0301 😀tail\r\n`;
      const result = await store.sync.ingest([
        msg({ accountId: accountId!, providerThreadId: "shared", from: { name: "", email: "one@example.test" }, bodyText: text, bodyHtml: `<p>${text}</p>`, bodyState: "full" }),
        msg({ accountId: accountId!, providerThreadId: "shared", from: { name: "", email: "two@example.test" }, bodyText: "gamma", bodyState: "full" }),
      ], { now: 1, classifier: null, applyFilters: false });
      const threadId = result.touched[0]!;
      for (const [query, expected] of [['"alpha beta é"', [threadId]], ['alpha be*', [threadId]], ['alpha gamma', []], ['from:one@example.test gamma', []], ['-gamma', []]] as const) expect((await store.threads.searchText({ query, now: 1, limit: 10 })).items.map((thread) => thread.id)).toEqual(expected);
      for (const [op, value, expected] of [["contains", "alpha beta é", 1], ["endsWith", "e tail", 1], ["startsWith", "alpha", 0], ["equals", "alpha beta", 0]] as const) expect((await store.filters.preview({ match: "all", conditions: [{ field: "body", op, value }], actions: [{ type: "star" }] }, 1, 10)).count).toBe(expected);
      const message = (await store.threads.get(threadId))!.messages.find((message) => message.bodyText === text)!;
      expect(await store.filters.matchMessages({ match: "all", conditions: [{ field: "body", op: "contains", value: "alpha beta é" }], actions: [{ type: "star" }] }, 1, [message.id])).toEqual([message.id]);
      expect(message.bodyHtml === `<p>${text}</p>`).toBe(true);
    } finally { await store.close(); await fixture.dispose(); }
  });

  it("preserves existing unsubscribe fallback for exact segmented bodies", async () => {
    const fixture = await open(), store = fixture.store;
    try {
      const [accountId] = await withAccounts(store, 1);
      const text = "complete exact text ".repeat(40000), html = `<p>${text}</p><a href="https://example.test/unsubscribe">Unsubscribe</a>`;
      const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: text, bodyHtml: html, bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
      const source = (await store.threads.unsubscribeSource(result.touched[0]!))!;
      expect(findUnsubscribeLink(source.bodyHtml, source.bodyText)).toBe("https://example.test/unsubscribe");
      expect((await store.threads.get(result.touched[0]!))!.messages[0]!.bodyHtml === html).toBe(true);
    } finally { await store.close(); await fixture.dispose(); }
  });

  it("keeps category preparation independent of short UTF16 part boundaries", async () => {
    const fixture = await open(), store = fixture.store;
    try {
      const [accountId] = await withAccounts(store, 1), parts = ["\ud83d", "\ude00 distinct", "ive marker ".repeat(900)], text = parts.join("");
      const result = await store.sync.ingest([msg({ accountId: accountId!, bodyText: null, bodyParts: { text: parts }, bodyState: "full" })], { now: 1, classifier: null, applyFilters: false });
      const id = result.touched[0]!;
      expect((await store.threads.get(id))!.messages[0]!.bodyText === text).toBe(true);
      const features = (await store.categorize.threadFeatures([id])).get(id)!;
      expect(features.root.source.bodyText === text.slice(0, 4096), "the existing category prefix must span storage boundaries").toBe(true);
    } finally { await store.close(); await fixture.dispose(); }
  });

}
