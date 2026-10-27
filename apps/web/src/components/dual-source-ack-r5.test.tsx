// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { realSetup } from "./draft-presentation-r2-harness";

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) for (const action of ["reply", "forward"] as const) it(`${adapter}: departed dual-reference source loss opens original work for ${action}`, async () => {
  const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance"), { openThread, closePage } = await import("~/lib/page"), { openCompose, composeFocusPending } = await import("~/lib/compose");
  try {
    const [a, b] = await withAccounts(h.store);
    await ingest(h.store, [msg({ accountId: a!, providerMsgId: "original", rfcMessageId: "original@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "survives", references: ["original@example.test"], attachments: [] })]);
    const threadId = await threadOf(h.store, "original"), messages = (await h.store.threads.get(threadId))!.messages;
    const source = messages.find((m) => m.rfcMessageId === "original@example.test")!, opposite = messages.find((m) => m.rfcMessageId !== "original@example.test")!;
    const ref = await h.store.attachments.create({ accountId: b!, filename: "authored-empty.txt", mime: "text/plain", size: 0, now: 0 }); await h.store.attachments.seal(b!, ref.assetId);
    const saved = (await h.client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: source.id, forwardOfMessageId: opposite.id, showSourceContext: true, bodyText: "authored before deletion", attachments: [ref], to: [{ name: "Recipient", email: "recipient@example.test" }, { name: "", email: "bob@" }] }))!;
    expect(saved).toMatchObject({ mode: "reply", inReplyToMessageId: source.id, forwardOfMessageId: opposite.id, showSourceContext: true });
    await h.publish(saved);
    await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
    await h.store.sync.remove([source.id]);
    await act(async () => { h.drafts.editDraft(h.key, { bodyText: "exact latest retained work", bodyHtml: "<div>exact latest retained work</div>" }); await h.drafts.flushDraft(h.key); });
    const ack = h.drafts.materialize(h.key)!;
    expect(ack).toMatchObject({ mode: "reply", inReplyToMessageId: null, forwardOfMessageId: opposite.id, showSourceContext: false, id: saved.id, generation: saved.generation, presentationThreadId: threadId, attachments: [ref] });
    await act(async () => closePage());
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBeNull();
    await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
    h.other.focus();
    await act(async () => { await openCompose(action, threadId); });
    for (let i = 0; i < 10; i++) await h.flush();
    expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
    expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: ack.revision, mode: "reply", inReplyToMessageId: null, forwardOfMessageId: opposite.id, showSourceContext: false, bodyText: ack.bodyText, bodyHtml: ack.bodyHtml, toText: ack.toText, attachments: [ref], recovery: ack.recovery });
    expect(h.app.getApp().compose?.key).toBe(h.key);
    expect(composeFocusPending(threadId)).toBe(false);
    expect(h.app.getApp().draftFocus).toBeNull();
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-to"]'));
  } finally { await h.cleanup(); }
});

for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it(`${adapter}: losing only the inactive reference keeps active Reply placement`, async () => {
  const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance"), { openThread, closePage } = await import("~/lib/page"), { openCompose } = await import("~/lib/compose");
  try {
    const [a, b] = await withAccounts(h.store);
    await ingest(h.store, [msg({ accountId: a!, providerMsgId: "active", rfcMessageId: "active@example.test", attachments: [] }), msg({ accountId: a!, providerMsgId: "inactive", references: ["active@example.test"], attachments: [] })]);
    const threadId = await threadOf(h.store, "active"), messages = (await h.store.threads.get(threadId))!.messages;
    const active = messages.find((m) => m.rfcMessageId === "active@example.test")!, inactive = messages.find((m) => m.id !== active.id)!;
    const saved = (await h.client.call("drafts.save", { accountId: b!, threadId: null, mode: "reply", inReplyToMessageId: active.id, forwardOfMessageId: inactive.id, showSourceContext: true, bodyText: "work retains active source", to: [{ name: "", email: "bob@" }] }))!;
    await h.publish(saved);
    await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
    await h.store.sync.remove([inactive.id]);
    await act(async () => { h.drafts.editDraft(h.key, { bodyText: "new exact active work", bodyHtml: "<p>new exact active work</p>" }); await h.drafts.flushDraft(h.key); });
    const ack = h.drafts.materialize(h.key)!;
    expect(ack).toMatchObject({ id: saved.id, generation: saved.generation, mode: "reply", inReplyToMessageId: active.id, forwardOfMessageId: null, showSourceContext: true });
    await act(async () => closePage());
    await act(async () => { h.useThreads.setState({ details: new Map([[threadId, (await h.store.threads.get(threadId))!]]) }); openThread(threadId); });
    h.other.focus(); await act(async () => { await openCompose("reply", threadId); });
    for (let i = 0; i < 10; i++) await h.flush();
    expect(h.app.getApp().compose).toBeNull();
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, h.app.getApp().draftShown)).toBe(h.key);
    expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: ack.revision, inReplyToMessageId: active.id, forwardOfMessageId: null, bodyText: ack.bodyText, bodyHtml: ack.bodyHtml, toText: ack.toText });
    expect(document.activeElement).toBe(h.host.querySelector('[data-testid="compose-body"]') ?? h.host.querySelector('[data-testid="compose-body-loading"]'));
  } finally { await h.cleanup(); }
});
