// @vitest-environment jsdom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { realSetup } from "./draft-presentation-r2-harness";
for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: source-loss acknowledgement keeps departed work discoverable as standalone`, async () => {
  const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance"), { openThread, closePage } = await import("~/lib/page");
  try {
    const [a, b] = await withAccounts(h.store);
    await ingest(h.store, [msg({ accountId: a!, providerMsgId: "original", rfcMessageId: "original@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "survives", references: ["original@example.test"], attachments: [] })]);
    const threadId = await threadOf(h.store, "original"), source = (await h.store.threads.get(threadId))!.messages.find((m) => m.rfcMessageId === "original@example.test")!;
    const ref = await h.store.attachments.create({ accountId: b!, filename: "authored-empty.txt", mime: "text/plain", size: 0, now: 0 }); await h.store.attachments.seal(b!, ref.assetId);
    const saved = (await h.client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, bodyText: "authored before deletion", attachments: [ref], to: [{ name: "Recipient", email: "recipient@example.test" }, { name: "", email: "bob@" }] }))!;
    await h.publish(saved);
    await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
    await h.store.sync.remove([source.id]);
    await act(async () => { h.drafts.editDraft(h.key, { bodyText: "exact latest retained work", bodyHtml: "<div>exact latest retained work</div>" }); await h.drafts.flushDraft(h.key); });
    const normalized = h.drafts.materialize(h.key)!;
    expect(normalized).toMatchObject({ mode: "new", inReplyToMessageId: null, forwardOfMessageId: null, showSourceContext: false, id: saved.id, generation: saved.generation, presentationThreadId: threadId, attachments: [ref] });
    await act(async () => closePage());
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBeNull();
    await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
    h.other.focus();
    const compose = await import("~/lib/compose"), originalOpen = compose.openCompose;
    let opening: Promise<void> | undefined;
    const observe = vi.spyOn(compose, "openCompose").mockImplementation((...args) => { opening = originalOpen(...args); return opening; });
    try {
      await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })));
      expect(opening).toBeDefined(); await act(async () => opening); for (let i = 0; i < 5; i++) await h.flush();
    } finally { observe.mockRestore(); }
    expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
    expect(h.app.getApp().compose?.key).toBe(h.key);
    expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: normalized.revision, mode: "new", inReplyToMessageId: null, forwardOfMessageId: null, showSourceContext: false, bodyText: normalized.bodyText, bodyHtml: normalized.bodyHtml, toText: normalized.toText, attachments: [ref] });
  } finally { await h.cleanup(); }
});
