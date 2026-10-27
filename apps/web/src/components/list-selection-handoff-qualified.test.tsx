// @vitest-environment jsdom
import { act } from "react";
import { expect, it } from "vitest";
import { realSetup } from "./draft-presentation-r2-harness";
import { deferred, gate } from "./draft-presentation-r1-harness";

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`phase deadline: ${label}`)), 15000); })]);
  } finally { if (timer) clearTimeout(timer); }
}

it.each(["passive", "later user"] as const)("preserves draft ownership during a gated first-page completion: %s", async (scenario) => {
  const phase = (name: string) => console.log(`oracle ${scenario}: ${name}`);
  phase("setup start");
  const { useApp } = await import("~/state/app");
  const { useList, listKey } = await import("~/state/list");
  const originalApp = useApp.getState(), originalList = useList.getState();
  const originalHistory = history.state, originalUrl = location.href;
  const h = await realSetup("SQL");
  const { withAccounts, ingest, msg, threadOf } = await import("@terno/store/conformance");
  const { pressRow } = await import("~/lib/select");
  const { openCompose, composeFocusPending } = await import("~/lib/compose");
  const listGate = deferred<void>(), sourceGate = deferred<void>(), listStarted = deferred<void>(), sourceStarted = deferred<void>(), listDelivered = deferred<void>();
  const later = document.createElement("button"); document.body.append(later);
  let armed = false, listCount = 0, sourceCount = 0, firstPage: { items: { id: number }[] } | undefined;
  let requestScope: unknown, requestKey = "", selectedAtStart: number | null = null;
  let opening: Promise<void> | undefined;
  try {
    phase("setup complete");
    const [account, foreign] = await withAccounts(h.store);
    await ingest(h.store, [msg({ accountId: account!, providerMsgId: "oracle-source", attachments: [] }), msg({ accountId: account!, providerMsgId: "oracle-newer", attachments: [] })]);
    const threadId = await threadOf(h.store, "oracle-source"), otherId = await threadOf(h.store, "oracle-newer");
    const detail = (await h.store.threads.get(threadId))!, source = detail.messages[0]!;
    const draft = (await h.client.call("drafts.save", { accountId: foreign!, threadId: null, mode: "reply", inReplyToMessageId: source.id, showSourceContext: true, bodyText: "exact oracle body", bodyHtml: "<div><b>exact oracle body</b></div>" }))!;
    await h.publish(draft);
    await act(async () => { h.app.setApp({ view: "inbox" }); h.useThreads.setState({ details: new Map([[threadId, detail]]) }); h.drafts.expireDraftPresentation(threadId); });
    const before = h.drafts.useDrafts.getState().drafts[h.key]!;
    expect(before.presentationExpired).toBe(true);
    const previousKey = "oracle-prior-list-generation";
    useList.setState({ key: previousKey });
    gate.call.mockImplementation((method: string, params: unknown) => {
      if (armed && method === "threads.list") {
        listCount++; requestScope = params; requestKey = listKey(); selectedAtStart = h.app.getApp().selectedId;
        const actual = h.call("threads.list", params as Parameters<typeof h.client.call<"threads.list">>[1]);
        listStarted.resolve();
        return actual.then(async (page) => { firstPage = page; await listGate.promise; return page; }).finally(() => listDelivered.resolve());
      }
      if (armed && method === "drafts.sourceContext") {
        sourceCount++; const actual = h.call("drafts.sourceContext", params as Parameters<typeof h.client.call<"drafts.sourceContext">>[1]);
        sourceStarted.resolve(); return actual.then(async (context) => { await sourceGate.promise; return context; });
      }
      return h.call(method as keyof typeof h.contract, params as never);
    });
    armed = true;
    phase("arm first page");
    await act(async () => { h.app.setApp({ view: "all", accountId: account!, selectedId: null, readerOpen: false }); await bounded(listStarted.promise, "first page start"); });
    phase("first page started");
    expect(listCount).toBe(1); expect(requestScope).toMatchObject({ view: "all", accountId: account });
    expect(requestKey).not.toBe(previousKey); expect(useList.getState().key).toBe(requestKey); expect(selectedAtStart).toBeNull();
    await act(async () => { pressRow(threadId, { meta: false, ctrl: false, shift: false }); h.app.setApp({ readerOpen: true }); });
    expect(h.app.getApp().selectedId).toBe(threadId);
    await h.store.sync.remove([source.id]);
    h.other.focus();
    await act(async () => { opening = openCompose("forward", threadId); await bounded(sourceStarted.promise, "source lookup start"); });
    phase("source lookup held");
    expect(sourceCount).toBe(1); expect(composeFocusPending(threadId)).toBe(true);
    expect(h.app.getApp().selectedId).toBe(threadId);
    if (scenario === "later user") await act(async () => { pressRow(otherId, { meta: false, ctrl: false, shift: false }); later.focus(); });
    await act(async () => { listGate.resolve(); await Promise.resolve(); await Promise.resolve(); });
    phase("first page released");
    expect(listCount).toBe(1); expect(firstPage?.items[0]?.id).toBe(otherId);
    expect(h.app.getApp().selectedId).toBe(scenario === "passive" ? threadId : otherId);
    await act(async () => { sourceGate.resolve(); await bounded(opening!, "compose completion"); });
    phase("source released");
    for (let i = 0; i < 5; i++) await h.flush();
    const after = h.drafts.useDrafts.getState().drafts[h.key]!;
    expect(after).toMatchObject({ id: before.id, generation: before.generation, revision: before.revision, bodyText: before.bodyText, bodyHtml: before.bodyHtml });
    if (scenario === "passive") expect(h.app.getApp().compose?.key).toBe(h.key);
    else { expect(h.app.getApp().compose).toBeNull(); expect(document.activeElement).toBe(later); expect(composeFocusPending(threadId)).toBe(false); }
  } finally {
    phase("cleanup start");
    listGate.resolve(); sourceGate.resolve(); listStarted.resolve(); sourceStarted.resolve();
    try {
      if (opening) await bounded(opening, "cleanup compose");
    } finally {
      try { if (listCount) await bounded(listDelivered.promise, "cleanup list"); }
      finally {
        later.remove();
        try { await bounded(h.cleanup(), "cleanup fixture"); }
        finally { useApp.setState(originalApp, true); useList.setState(originalList, true); history.replaceState(originalHistory, "", originalUrl); }
        phase("cleanup complete");
      }
    }
  }
});
