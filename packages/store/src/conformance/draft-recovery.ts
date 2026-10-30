import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "../mail-store";
import type { StoreHarness } from "./store";
import { ingest, msg, threadOf, withAccounts } from "./fixtures";

export function defineDraftRecoveryConformance(name: string, harness: StoreHarness): void {
  const opened: MailStore[] = [];
  const open = async () => { const s = await harness.open(); opened.push(s); return s; };
  afterEach(async () => { for (const s of opened.splice(0)) if (s.isOpen) await s.close(); });
  describe(`draft recovery: ${name}`, () => {
    it.each(["Re: Original", " re: Re: Original ", "Different"])("reply baseline survives reopen and controls queue linkage: %s", async (subject) => {
      let store = await open(); const [a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "baseline", providerThreadId: "native-thread", rfcMessageId: "baseline@example.test", subject: "Original" })]);
      const original = (await store.debug.snapshot()).messages[0]!;
      const context = { subject: "Original", sourceId: original.id, sourceAccountId: a!, rfcMessageId: "baseline@example.test" };
      const fields = { accountId: a!, mode: "reply" as const, threadId: original.threadId, inReplyToMessageId: original.id, replyContext: context, to: [], cc: [], subject, bodyText: "authored", quotedText: "> source", includeQuote: true };
      const draft = (await store.drafts.save(fields, 0))!;
      context.subject = "mutated externally";
      store = await harness.reopen(store); opened.push(store);
      expect(JSON.parse((await store.drafts.list())[0]!.reply_context_json!)).toMatchObject({ subject: "Original", sourceId: original.id });
      const sent = await store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject, bodyText: "authored", inReplyToMessageId: original.id, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, recordReply: false, now: 1 });
      const payload = JSON.parse((await store.ops.get(sent.opId))!.payload_json);
      expect(payload).toMatchObject(subject === "Different" ? { subject, inReplyTo: null, references: [], providerThreadId: null } : { subject, inReplyTo: "baseline@example.test", references: ["baseline@example.test"], providerThreadId: "native-thread" });
    });

    it("refuses a removed reply source atomically after reopen, retaining the draft", async () => {
      let store = await open(); const [a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "removed", rfcMessageId: "removed@example.test", subject: "Original" })]);
      const original = (await store.debug.snapshot()).messages[0]!;
      const fields = { accountId: a!, mode: "reply" as const, threadId: original.threadId, inReplyToMessageId: original.id, replyContext: { subject: "Original", sourceId: original.id, sourceAccountId: a! }, to: [], cc: [], subject: "Different", bodyText: "authored", quotedText: "> source", includeQuote: true };
      const attachment = await store.attachments.create({ accountId: a!, filename: "keep.txt", mime: "text/plain", size: 0, now: 0 });
      await store.attachments.seal(a!, attachment.assetId);
      const draft = (await store.drafts.save({ ...fields, attachments: [attachment] }, 0))!;
      await store.sync.remove([original.id]);
      store = await harness.reopen(store); opened.push(store);
      expect((await store.drafts.list())[0]).toMatchObject({ id: draft.id, mode: "reply", in_reply_to_message_id: original.id, body_text: "authored", quoted_text: "> source" });
      await expect(store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject: "Different", bodyText: "authored", inReplyToMessageId: original.id, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, attachments: [attachment], recordReply: false, now: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await store.drafts.list())[0]!.id).toBe(draft.id);
      await expect(store.attachments.info(a!, attachment.assetId)).resolves.toMatchObject({ assetId: attachment.assetId });
      expect((await store.debug.snapshot()).ops).toHaveLength(0);
    });

    it("retains source intent when the original disappears before the first draft save", async () => {
      const store = await open(); const [a] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "gone-before-save", rfcMessageId: "gone-before-save@example.test", subject: "Original" })]);
      const original = (await store.debug.snapshot()).messages[0]!;
      await store.sync.remove([original.id]);
      const draft = (await store.drafts.save({ accountId: a!, mode: "reply", threadId: original.threadId, inReplyToMessageId: original.id, replyContext: { subject: "Original", sourceId: original.id, sourceAccountId: a! }, to: [], cc: [], subject: "Different", bodyText: "authored" }, 0))!;
      expect(draft).toMatchObject({ mode: "reply", in_reply_to_message_id: original.id, body_text: "authored" });
      expect(JSON.parse(draft.reply_context_json!)).toMatchObject({ sourceId: original.id });
      await expect(store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject: "Different", bodyText: "authored", inReplyToMessageId: original.id, draftId: draft.id, draftGeneration: draft.generation, draftRevision: draft.revision, recordReply: false, now: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(await store.drafts.list()).toHaveLength(1);
    });

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
      await expect(store.drafts.delete(d.id, "old-generation")).rejects.toMatchObject({ code: "STALE", details: { reason: "draftMissing" } });
      expect((await store.drafts.list())[0]!.id).toBe(d.id);
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

    it("a clean target removed with its account reports terminal missing before any send is queued", async () => {
      const store = await open(); const [a] = await withAccounts(store);
      const d = (await store.drafts.save({ accountId: a!, to: [], cc: [], subject: "keep", bodyText: "exact" }, 0))!;
      await store.accounts.remove(a!);
      await expect(store.compose.queueSend({ accountId: a!, to: [], cc: [], bcc: [], subject: "keep", bodyText: "exact", draftId: d.id, draftGeneration: d.generation, draftRevision: 1, recordReply: false, now: 1 })).rejects.toMatchObject({ code: "STALE", details: { reason: "draftMissing" } });
      expect(await store.ops.recent(10)).toEqual([]);
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

    it.each([false, true])("retained copies preserve living originals after thread merge (cross-account %s)", async (crossAccount) => {
      let store = await open(); const [a, b] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "x", rfcMessageId: "x@example.test", references: ["ancestor@example.test"] }), msg({ accountId: a!, providerMsgId: "y", rfcMessageId: "y@example.test", references: ["older@example.test"] })]);
      const retained = [];
      for (const providerId of ["x", "y"]) {
        const threadId = await threadOf(store, providerId);
        const original = (await store.threads.get(threadId))!.messages[0]!;
        const fields = { accountId: crossAccount ? b! : a!, threadId, mode: "reply" as const, inReplyToMessageId: original.id, to: [], cc: [], subject: "exact reply", bodyText: "authored", bodyHtml: "<div><b>authored</b></div>", quotedText: "> kept quote", includeQuote: true };
        retained.push({ fields, original, saved: (await store.drafts.save(fields, 0))! });
      }
      await ingest(store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["x@example.test", "y@example.test"] })]);
      const survivor = await threadOf(store, "bridge");
      const lost = retained.find((r) => r.fields.threadId !== survivor)!;
      expect((await store.threads.get(survivor))!.messages.map((m) => m.id)).toContain(lost.original.id);
      await store.drafts.delete(lost.saved.id, lost.saved.generation);
      const copy = (await store.drafts.save(lost.fields, 1))!;
      expect(copy).toMatchObject({ in_reply_to_message_id: lost.original.id, mode: "reply", thread_id: crossAccount ? null : survivor, body_html: lost.fields.bodyHtml, quoted_text: "> kept quote" });
      store = await harness.reopen(store); opened.push(store);
      expect((await store.drafts.list()).find((d) => d.id === copy.id)).toMatchObject({ in_reply_to_message_id: lost.original.id, mode: "reply" });
      const sent = await store.compose.queueSend({ accountId: lost.fields.accountId, to: [], cc: [], bcc: [], subject: "exact reply", bodyText: "authored", inReplyToMessageId: lost.original.id, draftId: copy.id, draftGeneration: copy.generation, draftRevision: copy.revision, recordReply: false, now: 2 });
      const ref = lost.original.id === retained[0]!.original.id ? "x@example.test" : "y@example.test";
      expect(JSON.parse((await store.ops.get(sent.opId))!.payload_json)).toMatchObject({ inReplyTo: ref, references: [ref === "x@example.test" ? "ancestor@example.test" : "older@example.test", ref], ...(crossAccount ? { providerThreadId: null } : {}) });
    });

    it.each([["reply", false], ["reply", true], ["forward", false], ["forward", true]] as const)("a living %s source fences a reused conversation after reopen (cross-account %s)", async (mode, crossAccount) => {
      let store = await open(); const [a, b] = await withAccounts(store);
      await ingest(store, [msg({ accountId: a!, providerMsgId: "first", rfcMessageId: "first@example.test" }), msg({ accountId: a!, providerMsgId: "source", rfcMessageId: "source@example.test" })]);
      const stale = await threadOf(store, "source"), original = (await store.threads.get(stale))!.messages[0]!;
      const fields = { accountId: crossAccount ? b! : a!, threadId: stale, mode, inReplyToMessageId: mode === "reply" ? original.id : null, forwardOfMessageId: mode === "forward" ? original.id : null, to: [{ name: "Pérez, Ana", email: "bob@" }], cc: [], subject: "exact subject", bodyText: "authored", bodyHtml: "<div><b>authored</b></div>", quotedText: "> exact quote", includeQuote: true };
      const old = (await store.drafts.save(fields, 0))!;
      await ingest(store, [msg({ accountId: a!, providerMsgId: "bridge", references: ["first@example.test", "source@example.test"] })]);
      store = await harness.reopen(store); opened.push(store);
      await ingest(store, [msg({ accountId: fields.accountId, providerMsgId: "unrelated", rfcMessageId: "unrelated@example.test" })]);
      const merged = await threadOf(store, "bridge"), unrelated = await threadOf(store, "unrelated");
      expect(unrelated).toBe(stale); expect(merged).not.toBe(stale);
      expect((await store.threads.get(merged))!.messages.map((m) => m.id)).toContain(original.id);
      expect((await store.threads.get(unrelated))!.messages.map((m) => m.id)).not.toContain(original.id);
      await store.drafts.delete(old.id, old.generation);
      const copy = (await store.drafts.save(fields, 1))!;
      const expected = { thread_id: crossAccount ? null : merged, mode, in_reply_to_message_id: fields.inReplyToMessageId, forward_of_message_id: fields.forwardOfMessageId, body_html: fields.bodyHtml, quoted_text: fields.quotedText, to_json: JSON.stringify(fields.to) };
      expect(copy).toMatchObject(expected);
      const standalone = (await store.drafts.save({ ...fields, threadId: null }, 2))!;
      expect(standalone).toMatchObject({ ...expected, thread_id: null });
      const update = (await store.drafts.save({ ...fields, threadId: undefined, id: standalone.id, generation: standalone.generation, baseRevision: standalone.revision }, 3))!;
      expect(update).toMatchObject({ ...expected, id: standalone.id, thread_id: null });
      const implicit = (await store.drafts.save({ ...fields, threadId: undefined }, 4))!;
      expect(implicit).toMatchObject({ ...expected, thread_id: mode === "reply" ? expected.thread_id : null });
      store = await harness.reopen(store); opened.push(store);
      expect((await store.drafts.list()).find((d) => d.id === copy.id)).toMatchObject(expected);
      expect((await store.drafts.list()).find((d) => d.id === standalone.id)).toMatchObject({ ...expected, thread_id: null });
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
