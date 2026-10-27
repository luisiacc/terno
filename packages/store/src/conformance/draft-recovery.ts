import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { StoreHarness } from "./store";
import { ingest, msg, withAccounts } from "./fixtures";

export function defineDraftRecoveryConformance(name: string, harness: StoreHarness): void {
  const opened: MailStore[] = [];
  const open = async () => { const s = await harness.open(); opened.push(s); return s; };
  afterEach(async () => { for (const s of opened.splice(0)) if (s.isOpen) await s.close(); });
  describe(`draft recovery: ${name}`, () => {
    it("never reuses deleted highest identity after reopen; stale saves and sends cannot target its copy", async () => {
      let store = await open();
      const [accountId] = await withAccounts(store);
      const input = { accountId: accountId!, to: [], cc: [], subject: "exact", bodyText: "keep", bodyHtml: "<div><b>keep</b></div>", quotedText: "> quote", includeQuote: true };
      const original = (await store.drafts.save(input, 0))!;
      await store.drafts.delete(original.id);
      store = await harness.reopen(store); opened.push(store);
      const copy = (await store.drafts.save(input, 1))!;
      expect(copy.id).not.toBe(original.id);
      expect(copy.generation).toEqual(expect.any(String));
      expect(copy.generation).not.toBe("");
      expect(await store.drafts.save({ ...input, id: original.id, generation: original.generation, baseRevision: 1, bodyText: "late" }, 2)).toBeNull();
      await expect(store.compose.queueSend({ accountId: accountId!, to: [], cc: [], bcc: [], subject: "late", bodyText: "late", draftId: original.id, draftGeneration: original.generation, draftRevision: 1, recordReply: false, now: 2 })).rejects.toMatchObject({ code: "STALE", details: { reason: "draftMissing" } });
      store = await harness.reopen(store); opened.push(store);
      expect((await store.drafts.list())[0]).toMatchObject({ id: copy.id, body_text: "keep", body_html: input.bodyHtml, quoted_text: input.quotedText });
      await store.close();
    });

    it("requires an immutable generation on new targets, including legacy callers, while preserving revision conflict copies", async () => {
      const store = await open(); const [a] = await withAccounts(store);
      const input = { accountId: a!, to: [], cc: [], subject: "s", bodyText: "keep" };
      const d = (await store.drafts.save(input, 0))!;
      expect(await store.drafts.save({ ...input, id: d.id, baseRevision: 1 }, 1)).toBeNull();
      expect(await store.drafts.save({ ...input, id: d.id, generation: "other", baseRevision: 1 }, 1)).toBeNull();
      const next = (await store.drafts.save({ ...input, id: d.id, generation: d.generation, baseRevision: 1 }, 1))!;
      expect(next).toMatchObject({ id: d.id, revision: 2, generation: d.generation });
      const conflict = (await store.drafts.save({ ...input, id: d.id, generation: d.generation, baseRevision: 1, bodyText: "conflict" }, 2))!;
      expect(conflict.id).not.toBe(d.id);
      expect(conflict.generation).not.toBe(d.generation);
      const send = { accountId: a!, to: [], cc: [], bcc: [], subject: "s", bodyText: "keep", draftId: d.id, draftRevision: 1, recordReply: false, now: 3 };
      await expect(store.compose.queueSend(send)).rejects.toMatchObject({ details: { reason: "draftMissing" } });
      await expect(store.compose.queueSend({ ...send, draftGeneration: d.generation })).rejects.toMatchObject({ details: { reason: "draftRevision" } });
      expect((await store.debug.snapshot()).ops.length).toBe(0);
    });

    it("standalone cross-account replies retain valid RFC context through copy and reopen without a foreign provider thread", async () => {
      let store = await open(); const [a, b] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "source", providerThreadId: "foreign-provider-thread", rfcMessageId: "<source@example.test>" })]);
      const source = (await store.debug.snapshot()).messages[0]!;
      const saved = (await store.drafts.save({ accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, to: [], cc: [], subject: "reply", bodyText: "exact", quotedText: "> quote", includeQuote: true }, 0))!;
      expect((await store.drafts.list())[0]).toMatchObject({ mode: "reply", thread_id: null, in_reply_to_message_id: source.id });
      store = await harness.reopen(store); opened.push(store);
      expect((await store.drafts.list())[0]).toMatchObject({ mode: "reply", in_reply_to_message_id: source.id });
      const sent = await store.compose.queueSend({ accountId: b!, to: [], cc: [], bcc: [], subject: "reply", bodyText: "exact\n\n> quote", inReplyToMessageId: source.id, draftId: saved.id, draftGeneration: saved.generation, draftRevision: 1, recordReply: false, now: 1 });
      expect(JSON.parse((await store.ops.get(sent.opId))!.payload_json)).toMatchObject({ inReplyTo: "source@example.test", providerThreadId: null });
    });

    it("normalizes vanished local context atomically, retains authored fields, and classifies account/assets refusal", async () => {
      const store = await open(); const [a] = await withAccounts(store);
      const input = { accountId: a!, to: [{ name: "", email: "bob@" }], cc: [], subject: "keep", bodyText: "text", quotedText: "> quote", includeQuote: true, mode: "reply" as const, threadId: 999999, inReplyToMessageId: 999999 };
      const saved = (await store.drafts.save(input, 0))!;
      expect(saved).toMatchObject({ mode: "new", thread_id: null, in_reply_to_message_id: null, body_text: "text", quoted_text: "> quote", to_json: JSON.stringify(input.to) });
      await expect(store.drafts.save({ ...input, accountId: 999999 }, 1)).rejects.toMatchObject({ details: { reason: "account" } });
      await expect(store.drafts.save({ ...input, attachments: [{ assetId: "gone", filename: "x", mime: "text/plain", size: 0 }] }, 1)).rejects.toMatchObject({ details: { reason: "assets" } });
    });
  });
}
