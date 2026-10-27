// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { gate } from "./draft-presentation-r1-harness";
import { realSetup } from "./draft-presentation-r2-harness";
for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it.each([undefined, false])(`${adapter}: canonical-only strip reply stays inline (intent ${"%s"})`, async (intent) => {
  const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
  try {
    const [a] = await withAccounts(h.store);
    await ingest(h.store, [msg({ accountId: a!, providerMsgId: "canonical", attachments: [] })]);
    const threadId = await threadOf(h.store, "canonical");
    const saved = (await h.client.call("drafts.save", { accountId: a!, threadId, mode: "reply", ...(intent === undefined ? {} : { showSourceContext: intent }), bodyText: "exact canonical work" }))!;
    expect(saved).toMatchObject({ threadId, mode: "reply", inReplyToMessageId: null, showSourceContext: false }); await h.publish(saved);
    gate.load.mockClear(); h.methods.length = 0;
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click()); for (let i = 0; i < 5; i++) await h.flush();
    expect(gate.load.mock.calls.filter(([, force]) => force)).toEqual([[threadId, true]]);
    expect(h.methods.filter((method) => method === "threads.get")).toHaveLength(1);
    expect(h.methods).not.toContain("drafts.sourceContext");
    expect(h.app.getApp().compose).toBeNull(); expect(h.app.getApp().selectedId).toBe(threadId);
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBe(h.key);
    expect(h.drafts.useDrafts.getState().drafts[h.key]).toMatchObject({ id: saved.id, generation: saved.generation, bodyText: saved.bodyText, mode: saved.mode, threadId });
  } finally { await h.cleanup(); }
});


for (const adapter of ["SQL", "IDB exact", "IDB instant"] as const) it.each(["missing", "foreign", "wrong id"])(`${adapter}: canonical-only strip refuses ${"%s"} destination without changing stored work`, async (kind) => {
  const h = await realSetup(adapter), { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
  try {
    const [a, b] = await withAccounts(h.store);
    await ingest(h.store, [msg({ accountId: a!, providerMsgId: "canonical", attachments: [] }), msg({ accountId: kind === "foreign" ? b! : a!, providerMsgId: "other", subject: "Other", attachments: [] })]);
    const threadId = await threadOf(h.store, "canonical"), otherId = await threadOf(h.store, "other"), original = (await h.store.threads.get(threadId))!;
    const saved = (await h.client.call("drafts.save", { accountId: a!, threadId, mode: "reply", bodyText: "exact canonical fallback", bodyHtml: "<div>exact canonical fallback</div>" }))!;
    await h.publish(saved);
    if (kind === "missing") await h.store.sync.remove(original.messages.map((m) => m.id));
    else {
      const other = (await h.store.threads.get(otherId))!;
      gate.load.mockImplementation(async (id: number) => {
        const detail = kind === "foreign" ? { ...other, thread: { ...other.thread, id } } : other;
        h.useThreads.setState((state) => ({ details: new Map(state.details).set(id, detail) })); return detail;
      });
    }
    gate.load.mockClear(); h.methods.length = 0;
    const before = h.drafts.materialize(h.key)!;
    const button = h.host.querySelector<HTMLButtonElement>('[data-testid="strip-item"]')!; button.focus(); await act(async () => button.click()); for (let i = 0; i < 5; i++) await h.flush();
    expect(gate.load.mock.calls.filter(([, force]) => force)).toEqual([[threadId, true]]); expect(h.methods).not.toContain("drafts.sourceContext");
    expect(h.app.getApp().compose?.key).toBe(h.key);
    expect(h.drafts.materialize(h.key)).toMatchObject({ id: saved.id, generation: saved.generation, revision: before.revision, threadId, mode: "reply", bodyText: before.bodyText, bodyHtml: before.bodyHtml, showSourceContext: false });
    expect(h.drafts.shownDraftKey(h.drafts.useDrafts.getState().drafts, threadId, null)).toBeNull();
    expect(Object.keys(h.drafts.useDrafts.getState().drafts)).toEqual([h.key]);
  } finally { await h.cleanup(); }
});
